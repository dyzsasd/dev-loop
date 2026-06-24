// dev-loop hub — P6 IM channel provider adapters (Slack + Lark), provider-agnostic.
// §16: secrets arrive as function ARGS (the caller reads them from process.env); this module
// NEVER logs/returns a token/secret. Every network call has a HARD timeout (a hung provider must
// not wedge a Director fire). A failure is a thrown Error carrying only a provider error CODE/HTTP
// status — never a response body that could echo a credential.
import type { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
export type Provider = "slack" | "lark";
// DL-52: how a channel sends. 'bot' = the provider bot API (chat.postMessage / im.messages, needs a token /
// tenant_access_token) — the default, every existing channel. 'webhook' = a one-way incoming-webhook URL
// (no bot app); the provider still picks the payload shape (Slack {text} / Lark {msg_type,content}).
export type Transport = "bot" | "webhook";

// ── Shared channel helpers (DL-26): extracted so the MCP server (server.ts) and the daemon
// (daemon.ts) drive ONE implementation of channel selection / cred resolution / gating and cannot
// drift. All are pure (db/projectId passed in); resolveCreds reads ONLY env-var NAMES (§16). ──
export const CHANNEL_DRYRUN = process.env.DEVLOOP_CHANNEL_DRYRUN === "1"; // test/offline: build, no network
export const CHANNEL_SEND_CAP = 60;                                      // per-process loop-safety throttle
export interface ChannelRow {
  id: string; project_id: string; provider: string; config_ref: string; secret_ref: string | null;
  channel_ref: string; inbound_cursor: string | null; last_poll_at: string | null; enabled: number;
  transport?: string; // DL-52: 'bot' (default; absent ⇒ 'bot' for any pre-migration read) | 'webhook'
}
export const getEnabledChannel = (db: DatabaseSync, projectId: string): ChannelRow | undefined =>
  db.prepare("SELECT * FROM channels WHERE project_id=? AND enabled=1 ORDER BY created_at LIMIT 1").get(projectId) as ChannelRow | undefined;
// Resolve creds from env-var NAMES (§16). DL-52: a 'webhook' channel reads its incoming-webhook URL from
// process.env[config_ref] and the optional Lark sign-secret from process.env[secret_ref] — still NAMES, the
// DB never holds the URL/secret. A 'bot' channel (default / absent) is byte-for-byte the prior behavior.
export const resolveCreds = (c: ChannelRow): Creds =>
  c.transport === "webhook"
    ? { webhookUrl: process.env[c.config_ref], signSecret: c.secret_ref ? process.env[c.secret_ref] : undefined }
    : c.provider === "slack"
      ? { token: process.env[c.config_ref] }
      : { appId: process.env[c.config_ref], appSecret: c.secret_ref ? process.env[c.secret_ref] : undefined };
// DL-59: the §9 one-way `notify` webhook (from projects.json) as a send TARGET the daemon's Human-Blocked
// notifier can fire over the DL-52 'webhook' transport — closing the L2 leak where the daemon resolved ONLY
// the DB `channels` table, so a `service` project configured with ONLY a §9 notify webhook (no registered bot
// channel) got NO human-park alert. §16: the URL (+ the optional Lark sign-secret) are read HERE, server-side,
// from the notify block — a literal (machine-local config, e.g. MonPick's) OR an env-var NAME (`webhookEnv`/
// `secretEnv`, the §16-preferred form) — and NEVER touch the DB / a log / a returned value. A `webhookEnv`
// whose env is unset resolves to `undefined`, so the send fails closed (sendWebhook throws "webhook url unset")
// — exactly the §9 fail-closed-and-retry. Only slack/lark providers; the notify webhook is one-way.
export interface NotifyTarget { provider: Provider; creds: Creds; }
export function resolveNotifyWebhook(notify: unknown): NotifyTarget | null {
  if (!notify || typeof notify !== "object") return null;
  const n = notify as { type?: unknown; webhook?: unknown; webhookEnv?: unknown; secret?: unknown; secretEnv?: unknown; events?: unknown };
  const provider: Provider | null = n.type === "slack" ? "slack" : n.type === "lark" ? "lark" : null;
  if (!provider) return null;                                                       // only slack/lark webhooks
  if (Array.isArray(n.events) && !n.events.includes("human-parked")) return null;   // operator scoped this event out (§9 events)
  if (typeof n.webhook !== "string" && typeof n.webhookEnv !== "string") return null; // no webhook configured ⇒ not a target
  const webhookUrl = typeof n.webhook === "string" ? n.webhook
    : typeof n.webhookEnv === "string" ? process.env[n.webhookEnv] : undefined;     // env unset ⇒ undefined ⇒ fail closed at send
  const signSecret = typeof n.secret === "string" ? n.secret
    : typeof n.secretEnv === "string" ? process.env[n.secretEnv] : undefined;
  return { provider, creds: { webhookUrl, signSecret } };
}
// redact anything token-shaped + bound the length before any provider error is persisted/returned/logged.
export const scrubErr = (m: string): string =>
  m.replace(/\b(xox[abp]-[\w-]+|lin_(?:api|oauth)_[\w-]+|sk-[\w-]+|ghp_[\w-]+|eyJ[\w.-]{20,})\b/g, "***").slice(0, 120);
// strip control chars + truncate — outbound text never carries raw bytes that could break a payload (§16/§9).
export const cleanLine = (s: string, max: number): string => s.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, max);

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
// DL-52 webhook transport: { webhookUrl } (the incoming-webhook URL) + lark's optional { signSecret }.
export interface Creds { token?: string; appId?: string; appSecret?: string; webhookUrl?: string; signSecret?: string; }

// ── OUTBOUND ─────────────────────────────────────────────────────────────────
// `transport` (DL-52) defaults to 'bot' so every existing caller (server.ts channel.send) is byte-for-byte
// unchanged; the DL-26 daemon notifier passes the channel's transport so a 'webhook' channel pings a pasted
// incoming-webhook URL (no bot app). The webhook send is one-way (no inbound poll over a webhook).
export async function sendVia(
  provider: Provider, creds: Creds, channelRef: string, msg: OutboundMsg, fetchImpl: FetchImpl, transport: Transport = "bot",
): Promise<void> {
  const text = msg.lines.join("\n");
  if (transport === "webhook") return sendWebhook(provider, creds, text, fetchImpl);
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

// ── DL-52: one-way incoming-webhook send (no bot app, no token exchange) ─────
// Slack: POST {text} → success = HTTP 2xx (the classic incoming webhook returns the literal text "ok", not
// JSON — httpJson's res.json() fails → body {}, so we gate on STATUS only). Lark custom-bot: POST
// {msg_type,content} (+ a {timestamp,sign} when a sign-secret is set) → success = HTTP 2xx AND body code==0.
// §16: webhookUrl + signSecret are creds (resolved from env NAMES by resolveCreds, never in the DB); a thrown
// error carries ONLY the status/code, never the URL/secret. The message is JSON-encoded — never shell-spliced.
const ok2xx = (s: number): boolean => s >= 200 && s < 300; // incoming-webhook success gate (shared by both branches)
async function sendWebhook(provider: Provider, creds: Creds, text: string, fetchImpl: FetchImpl): Promise<void> {
  if (!creds.webhookUrl) throw new Error(`${provider} webhook url unset`); // env NAME resolved to nothing ⇒ fail closed
  if (provider === "slack") {
    const { status } = await httpJson(fetchImpl, creds.webhookUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
    });
    if (!ok2xx(status)) throw new Error(`slack webhook failed: ${status}`);
    return;
  }
  // lark custom-bot incoming webhook
  const payload: Record<string, unknown> = { msg_type: "text", content: { text } };
  if (creds.signSecret) {
    const ts = Math.floor(Date.now() / 1000);
    payload.timestamp = String(ts);
    payload.sign = larkSign(ts, creds.signSecret);
  }
  const { status, body } = await httpJson(fetchImpl, creds.webhookUrl, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!ok2xx(status) || body.code !== 0) throw new Error(`lark webhook failed: ${body.code ?? status}`);
}

// Lark custom-bot signature: base64(HMAC-SHA256(key="<ts>\n<secret>", data="")) — the "<ts>\n<secret>" is the
// HMAC KEY and the signed message is EMPTY (Lark's scheme; mirrors conventions §9's notify sign helper).
function larkSign(timestamp: number, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
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
