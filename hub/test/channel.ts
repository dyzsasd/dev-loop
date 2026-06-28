// P6 IM channel. Two layers:
//  (1) adapter UNIT tests with an injected fetchImpl — exercise the REAL send/poll/timeout/parse
//      branches of channel.ts with mock Responses (no live Slack/Lark), incl. the §16 property that
//      a thrown error never carries the token.
//  (2) tool DRYRUN tests over the stdio server — allow-list build, payload shape, the no-daemon
//      cursor advance + dedup, secret-never-returned, ack, status, per-project isolation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { sendVia, pollVia, type FetchImpl } from "../src/channel.ts";

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// ── Layer 1: adapter units with a mock fetchImpl ─────────────────────────────
function mockFetch(handler: (url: string, init: { body?: string; headers?: Record<string, string> }) => { status: number; body: unknown } | "hang"): FetchImpl {
  return (async (url: string, init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const r = handler(String(url), init ?? {});
    if (r === "hang") {
      // honor the abort signal exactly as real fetch does → the AbortController in httpJson rejects it
      return await new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return { status: r.status, json: async () => r.body } as unknown as Response;
  }) as FetchImpl;
}

// slack send success — Bearer + channel + chat.postMessage
{
  let seen: { url: string; init: { body?: string; headers?: Record<string, string> } } | null = null;
  const f = mockFetch((url, init) => { seen = { url, init }; return { status: 200, body: { ok: true } }; });
  await sendVia("slack", { token: "xoxb-SECRET" }, "C123", { kind: "notify", lines: ["hi"] }, f);
  ok(!!seen && seen!.url.includes("chat.postMessage") && JSON.parse(seen!.init.body!).channel === "C123" && seen!.init.headers!.Authorization === "Bearer xoxb-SECRET",
    "slack sendVia → chat.postMessage with Bearer token + channel");
}

// slack ok:false → throws the provider CODE, never the token
{
  const f = mockFetch(() => ({ status: 200, body: { ok: false, error: "invalid_auth" } }));
  let msg = "";
  try { await sendVia("slack", { token: "xoxb-SECRET" }, "C1", { kind: "notify", lines: ["x"] }, f); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("invalid_auth") && !msg.includes("xoxb-SECRET"), "slack ok:false → throws the code, never the token (§16)");
}

// timeout — a hung provider aborts fast (DEVLOOP_CHANNEL_TIMEOUT_MS set below) and never wedges the fire
{
  process.env.DEVLOOP_CHANNEL_TIMEOUT_MS = "250";
  const f = mockFetch(() => "hang");
  let msg = "";
  const t0 = Date.now();
  try { await sendVia("slack", { token: "t" }, "C1", { kind: "notify", lines: ["x"] }, f); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("timeout") && Date.now() - t0 < 2000, "a hung provider → fast timeout error (never wedges the fire)");
  delete process.env.DEVLOOP_CHANNEL_TIMEOUT_MS;
}

// slack history — human messages normalized, bot/self messages filtered, cursor = max ts
{
  const f = mockFetch(() => ({ status: 200, body: { ok: true, messages: [
    { ts: "100.1", user: "U1", text: "first" },
    { ts: "100.2", user: "U2", text: "second" },
    { ts: "100.3", bot_id: "B9", text: "my own digest" },     // dropped: a bot message (self-echo guard)
    { ts: "100.4", subtype: "bot_message", text: "also bot" }, // dropped
  ] } }));
  const r = await pollVia("slack", { token: "t" }, "C1", null, f);
  ok(r.messages.length === 2 && r.messages[0].text === "first" && r.cursor === "100.2", "slack pollVia → human msgs only (bot filtered), cursor = max ts");
}

// slack history PAGINATION — a >1-page backlog is fully drained, nothing skipped (Codex review fix)
{
  let n = 0;
  const f = mockFetch(() => {
    n++;
    if (n === 1) return { status: 200, body: { ok: true, has_more: true, response_metadata: { next_cursor: "PAGE2" }, messages: [{ ts: "10", user: "U1", text: "p1a" }, { ts: "11", user: "U1", text: "p1b" }] } };
    return { status: 200, body: { ok: true, messages: [{ ts: "12", user: "U2", text: "p2a" }] } };
  });
  const r = await pollVia("slack", { token: "t" }, "C1", null, f);
  ok(n === 2 && r.messages.length === 3 && r.cursor === "12", "slack pollVia pages through has_more → all 3 msgs collected, cursor = global max (no skip)");
}

// lark — token exchange THEN send; the exchange + send both routed via the mock
{
  const calls: string[] = [];
  const f = mockFetch((url) => {
    calls.push(url);
    if (url.includes("tenant_access_token")) return { status: 200, body: { code: 0, tenant_access_token: "t-LARKSECRET", expire: 7200 } };
    return { status: 200, body: { code: 0 } };
  });
  await sendVia("lark", { appId: "cli_app", appSecret: "appsec" }, "oc_room", { kind: "reply", lines: ["yo"] }, f);
  ok(calls.some((u) => u.includes("tenant_access_token")) && calls.some((u) => u.includes("im/v1/messages")), "lark sendVia → exchanges tenant_access_token then posts im/v1/messages");
}

// lark history parse + cursor (create_time), app-sender filtered
{
  const f = mockFetch((url) => {
    if (url.includes("tenant_access_token")) return { status: 200, body: { code: 0, tenant_access_token: "t2", expire: 7200 } };
    return { status: 200, body: { code: 0, data: { items: [
      { message_id: "om_1", sender: { id: "ou_user", sender_type: "user" }, body: { content: JSON.stringify({ text: "hey" }) }, create_time: "1700000001" },
      { message_id: "om_2", sender: { id: "cli_self", sender_type: "app" }, body: { content: JSON.stringify({ text: "bot" }) }, create_time: "1700000002" }, // dropped
    ] } } };
  });
  const r = await pollVia("lark", { appId: "a", appSecret: "s" }, "oc_room", null, f);
  ok(r.messages.length === 1 && r.messages[0].text === "hey" && r.cursor === "1700000001", "lark pollVia → user msgs only (app filtered), cursor = max create_time");
}

// ── DL-52: one-way incoming-webhook transport (the 6th sendVia arg) ──────────
// slack webhook → POST {text} to the webhook URL; success on HTTP 2xx (the hook returns "ok" text, not JSON)
{
  let seen: { url: string; init: { body?: string } } | null = null;
  const f = mockFetch((url, init) => { seen = { url, init }; return { status: 200, body: {} }; });
  await sendVia("slack", { webhookUrl: "https://hooks.example/SLACK" }, "ignored", { kind: "notify", lines: ["alert here"] }, f, "webhook");
  ok(!!seen && seen!.url === "https://hooks.example/SLACK" && JSON.parse(seen!.init.body!).text === "alert here", "DL-52: slack webhook → POST {text} to the incoming-webhook URL");
}
// slack webhook non-2xx → throws the status, never the URL (§16)
{
  const f = mockFetch(() => ({ status: 404, body: {} }));
  let msg = "";
  try { await sendVia("slack", { webhookUrl: "https://hooks.example/SECRETPATH" }, "x", { kind: "notify", lines: ["x"] }, f, "webhook"); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("404") && !msg.includes("SECRETPATH") && !msg.includes("hooks.example"), "DL-52/§16: a failed slack webhook throws the status, never the URL");
}
// lark webhook, NO sign secret → POST {msg_type,content}; success on 2xx AND code:0
{
  let seen: { url: string; init: { body?: string } } | null = null;
  const f = mockFetch((url, init) => { seen = { url, init }; return { status: 200, body: { code: 0 } }; });
  await sendVia("lark", { webhookUrl: "https://open.larksuite.com/hook/LARK" }, "x", { kind: "notify", lines: ["lark alert"] }, f, "webhook");
  const payload = JSON.parse(seen!.init.body!);
  ok(seen!.url.includes("/hook/LARK") && payload.msg_type === "text" && payload.content.text === "lark alert" && !("sign" in payload), "DL-52: lark webhook (no secret) → {msg_type:text,content:{text}}, no sign");
}
// lark webhook WITH a sign secret → adds {timestamp, sign} (base64 HMAC); the raw secret never appears
{
  let seen: { init: { body?: string } } | null = null;
  const f = mockFetch((_u, init) => { seen = { init }; return { status: 200, body: { code: 0 } }; });
  await sendVia("lark", { webhookUrl: "https://open.larksuite.com/hook/LARK", signSecret: "S3CR3T" }, "x", { kind: "notify", lines: ["signed"] }, f, "webhook");
  const payload = JSON.parse(seen!.init.body!);
  ok(typeof payload.timestamp === "string" && typeof payload.sign === "string" && /^[A-Za-z0-9+/]+=*$/.test(payload.sign), "DL-52: lark webhook + sign-secret → adds {timestamp, sign} (base64 HMAC-SHA256)");
  ok(!JSON.stringify(payload).includes("S3CR3T"), "DL-52/§16: the lark sign-secret never appears in the payload (only its HMAC)");
}
// lark webhook returns 200 but code!=0 → failure (success requires 2xx AND code==0)
{
  const f = mockFetch(() => ({ status: 200, body: { code: 19021 } }));
  let msg = "";
  try { await sendVia("lark", { webhookUrl: "https://x/y" }, "x", { kind: "notify", lines: ["x"] }, f, "webhook"); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("19021"), "DL-52: lark webhook 200-but-code!=0 → failure (2xx AND code==0 required)");
}
// webhook url unset (the env NAME resolved to nothing) → fails closed, never a silent no-op
{
  const f = mockFetch(() => ({ status: 200, body: {} }));
  let msg = "";
  try { await sendVia("slack", { webhookUrl: undefined }, "x", { kind: "notify", lines: ["x"] }, f, "webhook"); } catch (e) { msg = (e as Error).message; }
  ok(/webhook url unset/.test(msg), "DL-52: a webhook with an unset URL env → throws 'webhook url unset' (fails closed)");
}
// bot transport is the DEFAULT — omitting the 6th arg routes to the provider API (back-compat unchanged)
{
  let url = "";
  const f = mockFetch((u) => { url = u; return { status: 200, body: { ok: true } }; });
  await sendVia("slack", { token: "xoxb-t" }, "C1", { kind: "notify", lines: ["x"] }, f); // no transport arg
  ok(url.includes("chat.postMessage"), "DL-52: omitting transport ⇒ 'bot' (provider API) — existing callers unchanged");
}

// ── Layer 2: tool DRYRUN tests over the stdio server ─────────────────────────
const DB = "/tmp/hub-channel/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }
async function as(actor: string, project: string, prefix?: string): Promise<Client> {
  const env: Record<string, string> = {
    ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB,
    DEVLOOP_CREATE_PROJECT: "1", DEVLOOP_CHANNEL_DRYRUN: "1",
    DEVLOOP_CHANNEL_TOKEN: "xoxb-DRYRUNSECRET",
  };
  if (prefix) env.DEVLOOP_TICKET_PREFIX = prefix;
  const c = new Client({ name: `chan-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content?: { text?: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}

const director = await as("ops", "chanp", "CH");
const beta = await as("ops", "betap", "CB"); // second project for isolation

// status before register
ok((await call(director, "channel.status")).data.configured === false, "channel.status before register → configured:false");

// register (env-var NAME only, never a secret)
const reg = (await call(director, "channel.register", { provider: "slack", configRef: "DEVLOOP_CHANNEL_TOKEN", channelRef: "C777" })).data;
ok(reg.provider === "slack" && reg.channelRef === "C777", "channel.register → stored provider + room id");

// §16 — channel.register REJECTS a literal token passed where an env-var NAME belongs (Codex review)
ok((await call(director, "channel.register", { provider: "slack", configRef: "xoxb-LITERAL-SECRET", channelRef: "C9" })).isError, "channel.register rejects a literal token in configRef (names only — no secret reaches the DB)");

// send notify — DRYRUN returns the BUILT allow-listed lines (title resolved server-side, no free-form path)
const tk = (await call(director, "save_issue", { title: "A very long ticket title that should be truncated to eighty characters for the channel notify line", type: "Bug" })).data;
const sent = (await call(director, "channel.send", { kind: "notify", ticketId: tk.id, bailShape: "decision-needed" })).data;
ok(sent.dryrun === true && sent.lines.join(" ").includes(tk.id) && sent.lines.join(" ").includes("decision-needed"), "channel.send notify → built line carries ticket id + bail-shape (allow-list, no free-form)");
ok(sent.lines.join(" ").length < 140 && !JSON.stringify(sent).includes("xoxb-"), "notify line is bounded + the token never appears in the result (§16)");

// digest — only structured fields render
const dig = (await call(director, "channel.send", { kind: "digest", digest: { topicsChaired: 2, decisionsClosed: 1, roadmapDraftVersion: 3, throughput: { done: 5, inReview: 2, todo: 7 }, headline: "shipped P5" } })).data;
ok(dig.lines.some((l: string) => l.includes("topics chaired 2")) && dig.lines.some((l: string) => l.includes("shipped P5")), "channel.send digest → structured counts + headline only");

// reply — bounded text
const rep = (await call(director, "channel.send", { kind: "reply", replyTo: "x", text: "on it" })).data;
ok(rep.lines[0] === "on it", "channel.send reply → bounded text");

// poll with an injected fixture (no network in DRYRUN) → ingest + return pending, advance the cursor
const FIX = JSON.stringify([
  { providerMsgId: "200.1", authorRef: "U1", text: "ship A first", providerTs: "200.1" },
  { providerMsgId: "200.2", authorRef: "U1", text: "and review B", providerTs: "200.2" },
]);
async function asFixture(c: Client, fixture: string): Promise<Client> { return c; } // (fixture rides env per-process)
// re-connect director with the fixture env so poll sees it
const directorF = await (async () => {
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: "ops", DEVLOOP_PROJECT: "chanp", DEVLOOP_HUB_DB: DB, DEVLOOP_CREATE_PROJECT: "1", DEVLOOP_CHANNEL_DRYRUN: "1", DEVLOOP_CHANNEL_TOKEN: "xoxb-DRYRUNSECRET", DEVLOOP_CHANNEL_FIXTURE: FIX };
  const c = new Client({ name: "chan-director-fix", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
})();
const poll1 = (await call(directorF, "channel.poll")).data;
ok(poll1.new === 2 && poll1.pending.length === 2 && poll1.cursor === "200.2", "channel.poll → ingests 2 fixture msgs, pending=2, cursor advanced to max ts");
const poll2 = (await call(directorF, "channel.poll")).data;
ok(poll2.new === 0, "second channel.poll over the same window → 0 new (cursor + dedup; no re-read)");

// ack one → it leaves the pending set
const mid = poll1.pending[0].messageId;
ok((await call(directorF, "channel.ack", { messageId: mid, actedInto: "CH-9" })).data.acted === true, "channel.ack → marks the message consumed");
ok((await call(directorF, "channel.status")).data.inboxPending === 1, "after ack → inboxPending drops to 1");

// §16 — status returns the NAME + a set-flag, never the token value
const st = (await call(directorF, "channel.status")).data;
ok(st.configRefSet === true && !JSON.stringify(st).includes("xoxb-"), "channel.status → configRefSet boolean, never the token value");

// isolation — the second project has no channel
ok((await call(beta, "channel.status")).data.configured === false, "a different project sees no channel (isolation)");
ok((await call(beta, "channel.poll")).isError, "channel.poll in a project with no channel → err (isolation)");

// ── DL-4: roadmap-over-chat bridge — channel.poll auto-handles a summary request + an edit→DRAFT ──
const rmSetup = await as("operator", "rmp", "RM"); // operator: seed + publish the roadmap doc, register the channel
await call(rmSetup, "doc.save", { slug: "roadmap", kind: "roadmap", title: "Product Roadmap", body: "# Roadmap\n- ship the bridge\n", baseVersion: 0 });
await call(rmSetup, "doc.publish", { kind: "roadmap", version: 1 });
await call(rmSetup, "channel.register", { provider: "slack", configRef: "DEVLOOP_CHANNEL_TOKEN", channelRef: "C-RM" });

// a director polls with a fixture of inbound chat: a summary request, an edit (with a secret+email to scrub), and a normal message
const RM_FIX = JSON.stringify([
  { providerMsgId: "300.1", authorRef: "U7", text: "roadmap", providerTs: "300.1" },
  { providerMsgId: "300.2", authorRef: "U7", text: "roadmap edit # Roadmap v2\n- ship the bridge\n- then DL-13\nsecret xoxb-LEAKED key AKIAIOSFODNN7EXAMPLE ping me@evil.com 415-555-0142", providerTs: "300.2" },
  { providerMsgId: "300.3", authorRef: "U7", text: "what about the mobile app?", providerTs: "300.3" },
  { providerMsgId: "300.4", authorRef: "U7", text: "roadmap: maybe we discuss mobile next quarter", providerTs: "300.4" },
]);
const rmDir = await (async () => {
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: "ops", DEVLOOP_PROJECT: "rmp", DEVLOOP_HUB_DB: DB, DEVLOOP_CREATE_PROJECT: "1", DEVLOOP_CHANNEL_DRYRUN: "1", DEVLOOP_CHANNEL_TOKEN: "xoxb-DRYRUNSECRET", DEVLOOP_CHANNEL_FIXTURE: RM_FIX };
  const c = new Client({ name: "chan-rm-dir", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
})();
const rmPoll = (await call(rmDir, "channel.poll")).data;

// AC1 — a `roadmap` request → a §16-safe summary (handled in poll, not left pending)
const summ = rmPoll.roadmapHandled.find((h: any) => h.type === "summary");
ok(!!summ && summ.lines.join(" ").includes("published v1"), "DL-4: a `roadmap` msg → a summary reply showing the version/status");
ok(summ.lines.join("\n").includes("ship the bridge"), "DL-4: the summary carries the roadmap excerpt");

// AC2 — a `roadmap: <text>` edit → a DRAFT via doc.save, NOT published
const edit = rmPoll.roadmapHandled.find((h: any) => h.type === "edit");
ok(!!edit && /draft v2/.test(edit.result), "DL-4: a `roadmap: <text>` msg → a roadmap DRAFT v2 (doc.save)");
ok((await call(rmSetup, "doc.get", { kind: "roadmap" })).data.current_version === 1, "DL-4: the chat edit did NOT publish — published current stays v1");
ok((await call(rmSetup, "doc.history", { kind: "roadmap" })).data.length === 2, "DL-4: the chat edit appended exactly one new draft (v2)");

// AC4/§16 — the persisted draft keeps the content but scrubs secrets (incl. third-party shapes) + PII
const v2 = (await call(rmSetup, "doc.get", { kind: "roadmap", version: 2 })).data;
ok(v2.body.includes("then DL-13") && !v2.body.includes("xoxb-LEAKED") && !v2.body.includes("AKIAIOSFODNN7EXAMPLE") && !v2.body.includes("me@evil.com") && !v2.body.includes("415-555-0142") && v2.body.includes("***"), "DL-4/§16: the chat-edit draft is persisted but secrets (Slack+AWS), email, and phone are scrubbed (***)");

// only the explicit `roadmap` / `roadmap edit` commands are auto-handled; everything else — INCLUDING a
// casual `roadmap:` musing — still flows to the Director's pending inbox (false-positive hardening)
ok(rmPoll.roadmapHandled.length === 2, "DL-4: exactly 2 commands auto-handled (summary + edit) — the `roadmap:` musing is NOT captured as an edit");
ok(rmPoll.pending.some((p: any) => p.text.includes("mobile app")) && rmPoll.pending.some((p: any) => p.text.includes("maybe we discuss mobile")), "DL-4: a non-command msg AND a `roadmap:` musing both stay pending for the Director");

// §16 — the token never appears in the poll result
ok(!JSON.stringify(rmPoll).includes("xoxb-") && !JSON.stringify(rmPoll).includes("DRYRUNSECRET"), "DL-4/§16: the channel token never appears in the poll result");

for (const c of [director, beta, directorF, rmSetup, rmDir]) await c.close();
console.log(fails === 0 ? "\nCHANNEL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
