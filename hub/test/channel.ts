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

const director = await as("director", "chanp", "CH");
const beta = await as("director", "betap", "CB"); // second project for isolation

// status before register
ok((await call(director, "channel.status")).data.configured === false, "channel.status before register → configured:false");

// register (env-var NAME only, never a secret)
const reg = (await call(director, "channel.register", { provider: "slack", configRef: "DEVLOOP_CHANNEL_TOKEN", channelRef: "C777" })).data;
ok(reg.provider === "slack" && reg.channelRef === "C777", "channel.register → stored provider + room id");

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
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: "director", DEVLOOP_PROJECT: "chanp", DEVLOOP_HUB_DB: DB, DEVLOOP_CREATE_PROJECT: "1", DEVLOOP_CHANNEL_DRYRUN: "1", DEVLOOP_CHANNEL_TOKEN: "xoxb-DRYRUNSECRET", DEVLOOP_CHANNEL_FIXTURE: FIX };
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

for (const c of [director, beta, directorF]) await c.close();
console.log(fails === 0 ? "\nCHANNEL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
