// dev-loop hub — P6 IM channel provider adapters (Slack + Lark), provider-agnostic.
// §16: secrets arrive as function ARGS (the caller reads them from process.env); this module
// NEVER logs/returns a token/secret. Every network call has a HARD timeout (a hung provider must
// not wedge a Director fire). A failure is a thrown Error carrying only a provider error CODE/HTTP
// status — never a response body that could echo a credential.
export type Provider = "slack" | "lark";

// The provider-agnostic internal shapes. The server BUILDS `lines` from a §16 allow-list (so this
// module never sees free-form unbounded prose); the adapter only renders + sends them.
export interface OutboundMsg { kind: "notify" | "digest" | "reply"; lines: string[]; }
export interface InboundMsg { providerMsgId: string; authorRef: string; text: string; providerTs: string; }

export type FetchImpl = typeof fetch;
// mirror §9 notify's `curl --max-time 10`; overridable for tests (the timeout path must be fast to assert)
const timeoutMs = (): number => Number(process.env.DEVLOOP_CHANNEL_TIMEOUT_MS) || 10_000;

// ── timeout-wrapped JSON fetch ───────────────────────────────────────────────
async function httpJson(
  fetchImpl: FetchImpl, url: string, init: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs());
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch (e) {
    // AbortError (timeout) / network error → a clean, secret-free message
    throw new Error(`network error: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).name}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Lark tenant_access_token (internal app): exchange app_id+app_secret, cache in-memory only ──
// §16: the token is held ONLY in this process map, never persisted/logged/returned. ~2h expiry.
const larkTokenCache = new Map<string, { token: string; expiresAt: number }>();
async function larkToken(fetchImpl: FetchImpl, appId: string, appSecret: string): Promise<string> {
  const cached = larkTokenCache.get(appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const { status, body } = await httpJson(fetchImpl, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (status !== 200 || body.code !== 0 || typeof body.tenant_access_token !== "string") {
    throw new Error(`lark auth failed: code ${body.code ?? status}`); // code is Lark's error number, not the secret
  }
  const expire = typeof body.expire === "number" ? body.expire : 7200;
  larkTokenCache.set(appId, { token: body.tenant_access_token, expiresAt: Date.now() + (expire - 120) * 1000 });
  return body.tenant_access_token;
}

// ── Credentials (already resolved from env by the caller) ────────────────────
// slack: { token } (xoxb- bot token, used as Bearer). lark: { appId, appSecret } (internal-app exchange).
export interface Creds { token?: string; appId?: string; appSecret?: string; }

// ── OUTBOUND ─────────────────────────────────────────────────────────────────
export async function sendVia(
  provider: Provider, creds: Creds, channelRef: string, msg: OutboundMsg, fetchImpl: FetchImpl,
): Promise<void> {
  const text = msg.lines.join("\n");
  if (provider === "slack") {
    if (!creds.token) throw new Error("slack token unset");
    const { status, body } = await httpJson(fetchImpl, "https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify({ channel: channelRef, text }),
    });
    if (status !== 200 || body.ok !== true) throw new Error(`slack send failed: ${body.error ?? status}`);
    return;
  }
  // lark
  if (!creds.appId || !creds.appSecret) throw new Error("lark app_id/app_secret unset");
  const token = await larkToken(fetchImpl, creds.appId, creds.appSecret);
  const { status, body } = await httpJson(fetchImpl, "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ receive_id: channelRef, msg_type: "text", content: JSON.stringify({ text }) }),
  });
  if (status !== 200 || body.code !== 0) throw new Error(`lark send failed: ${body.code ?? status}`);
}

// ── INBOUND (history read; cursor = provider monotonic marker) ───────────────
// Returns normalized human-operator messages strictly AFTER `cursor`, plus the new cursor. The
// bot's OWN messages are dropped (SECURITY: never ingest our own digest/reply as "operator
// direction" — a self-echo/injection loop vector). authorRef is the OPAQUE provider sender id —
// it is NEVER equated with operator authority (the instruction-source boundary, §16).
// PAGINATED (Codex review): a single 50-item page would SKIP older messages when >1 page arrived
// since the cursor (advancing to the page max past unfetched older ones). We page until the provider
// reports no more, with a runaway guard that THROWS (cursor unadvanced, surfaced) rather than silently
// skip. normalize()'s strictly-after-cursor filter + the UNIQUE dedup make over-fetch harmless.
const MAX_POLL_PAGES = 40; // a regular loop poll exits after 1 page; this only bites a huge backlog
export async function pollVia(
  provider: Provider, creds: Creds, channelRef: string, cursor: string | null, fetchImpl: FetchImpl,
): Promise<{ messages: InboundMsg[]; cursor: string | null }> {
  const collected: InboundMsg[] = [];
  if (provider === "slack") {
    if (!creds.token) throw new Error("slack token unset");
    let pageCursor: string | undefined; let pages = 0;
    for (;;) {
      const p = new URLSearchParams({ channel: channelRef, limit: "100" });
      if (cursor) p.set("oldest", cursor);
      if (pageCursor) p.set("cursor", pageCursor);
      const { status, body } = await httpJson(fetchImpl, `https://slack.com/api/conversations.history?${p}`, { headers: { Authorization: `Bearer ${creds.token}` } });
      if (status !== 200 || body.ok !== true) throw new Error(`slack history failed: ${body.error ?? status}`);
      for (const m of (Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [])) {
        if (m.bot_id || m.subtype === "bot_message") continue; // self/bot echo guard (security)
        collected.push({ providerMsgId: String(m.ts), authorRef: String(m.user ?? "unknown"), text: String(m.text ?? ""), providerTs: String(m.ts) });
      }
      const meta = body.response_metadata as Record<string, unknown> | undefined;
      pageCursor = body.has_more && meta?.next_cursor ? String(meta.next_cursor) : undefined;
      if (!pageCursor) break;
      if (++pages >= MAX_POLL_PAGES) throw new Error("slack history exceeded max pages (backlog too large for one poll; widen cadence)");
    }
    return normalize(collected, cursor);
  }
  // lark
  if (!creds.appId || !creds.appSecret) throw new Error("lark app_id/app_secret unset");
  const token = await larkToken(fetchImpl, creds.appId, creds.appSecret);
  let pageToken: string | undefined; let pages = 0;
  for (;;) {
    const p = new URLSearchParams({ container_id_type: "chat", container_id: channelRef, page_size: "50" });
    if (cursor) p.set("start_time", cursor);
    if (pageToken) p.set("page_token", pageToken);
    const { status, body } = await httpJson(fetchImpl, `https://open.feishu.cn/open-apis/im/v1/messages?${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (status !== 200 || body.code !== 0) throw new Error(`lark history failed: ${body.code ?? status}`);
    const data = body.data as Record<string, unknown> | undefined;
    for (const m of (Array.isArray(data?.items) ? (data!.items as Record<string, unknown>[]) : [])) {
      if ((m.sender as Record<string, unknown>)?.sender_type === "app") continue; // self/app echo guard
      collected.push({ providerMsgId: String(m.message_id), authorRef: String((m.sender as Record<string, unknown>)?.id ?? "unknown"), text: larkText(m.body), providerTs: String(m.create_time) });
    }
    pageToken = data?.has_more && data?.page_token ? String(data.page_token) : undefined;
    if (!pageToken) break;
    if (++pages >= MAX_POLL_PAGES) throw new Error("lark history exceeded max pages (backlog too large for one poll; widen cadence)");
  }
  return normalize(collected, cursor);
}

function larkText(body: unknown): string {
  try { const c = JSON.parse(String((body as Record<string, unknown>)?.content ?? "{}")); return String(c.text ?? ""); }
  catch { return ""; }
}

// strictly-after-cursor + advance the cursor to the max provider_ts ACTUALLY returned (never the
// window end) — so a message can never be skipped by an over-eager cursor advance.
function normalize(msgs: InboundMsg[], cursor: string | null): { messages: InboundMsg[]; cursor: string | null } {
  const fresh = msgs.filter((m) => cursor === null || m.providerTs > cursor);
  const next = fresh.reduce<string | null>((acc, m) => (acc === null || m.providerTs > acc ? m.providerTs : acc), cursor);
  return { messages: fresh, cursor: next };
}
