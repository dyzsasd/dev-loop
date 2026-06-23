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
export async function pollVia(
  provider: Provider, creds: Creds, channelRef: string, cursor: string | null, fetchImpl: FetchImpl,
): Promise<{ messages: InboundMsg[]; cursor: string | null }> {
  if (provider === "slack") {
    if (!creds.token) throw new Error("slack token unset");
    const oldest = cursor ?? "0";
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channelRef)}&oldest=${encodeURIComponent(oldest)}&limit=50`;
    const { status, body } = await httpJson(fetchImpl, url, { headers: { Authorization: `Bearer ${creds.token}` } });
    if (status !== 200 || body.ok !== true) throw new Error(`slack history failed: ${body.error ?? status}`);
    const raw = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
    return normalize(raw.filter((m) => !m.bot_id && m.subtype !== "bot_message" && String(m.ts) !== oldest).map((m) => ({
      providerMsgId: String(m.ts), authorRef: String(m.user ?? "unknown"), text: String(m.text ?? ""), providerTs: String(m.ts),
    })), cursor);
  }
  // lark
  if (!creds.appId || !creds.appSecret) throw new Error("lark app_id/app_secret unset");
  const token = await larkToken(fetchImpl, creds.appId, creds.appSecret);
  const start = cursor ? `&start_time=${encodeURIComponent(cursor)}` : "";
  const url = `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(channelRef)}&page_size=50${start}`;
  const { status, body } = await httpJson(fetchImpl, url, { headers: { Authorization: `Bearer ${token}` } });
  if (status !== 200 || body.code !== 0) throw new Error(`lark history failed: ${body.code ?? status}`);
  const items = Array.isArray((body.data as Record<string, unknown>)?.items) ? ((body.data as Record<string, unknown>).items as Record<string, unknown>[]) : [];
  return normalize(items
    .filter((m) => (m.sender as Record<string, unknown>)?.sender_type !== "app" && String(m.create_time) !== cursor)
    .map((m) => ({
      providerMsgId: String(m.message_id),
      authorRef: String((m.sender as Record<string, unknown>)?.id ?? "unknown"),
      text: larkText(m.body),
      providerTs: String(m.create_time),
    })), cursor);
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
