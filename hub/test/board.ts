// P5 discussion board: topic open/list/get, invited-only + once-per-round post.add,
// chair-only synthesize/close, round-bump, closed-topic CONFLICT, attribution, per-project
// isolation, and the §17 DELIBERATE-INVARIANT (a decision is DATA — no board tool touches the fs).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";

const DB = "/tmp/hub-board/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

async function as(actor: string, project: string, prefix?: string): Promise<Client> {
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB, DEVLOOP_CREATE_PROJECT: "1" };
  if (prefix) env.DEVLOOP_TICKET_PREFIX = prefix;
  const c = new Client({ name: `board-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}
let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

const director = await as("director", "boardp", "BP");
const pm = await as("pm", "boardp");
const qa = await as("qa", "boardp");
const dev = await as("dev", "boardp");
const sweep = await as("sweep", "boardp");
const beta = await as("director", "betap", "BE"); // second project for isolation

// 1. open — chair = opened_by, round 1
const opened = (await call(director, "topic.open", { question: "Q1 sequencing?", invited: ["pm", "qa", "dev"] })).data;
const tid = opened.id;
ok(opened.status === "open" && opened.round === 1 && opened.opened_by === "director" && opened.invited.length === 3, "topic.open → open, round 1, opened_by director, invited echoed");

// 2. open with an unknown invited handle → err (actorExists guard)
ok((await call(director, "topic.open", { question: "bad", invited: ["pm", "ghost"] })).isError, "topic.open with unknown invited → err");

// 3. list → pending = full invited set; carries the round_opened_at termination clock
const l0 = (await call(director, "topic.list", { status: "open" })).data.find((t: any) => t.id === tid);
ok(l0 && l0.pending.length === 3 && typeof l0.round_opened_at === "string", "topic.list pending = full invited set + round_opened_at present");

// 4. post.add as pm (invited) → round 1, perspective, attributed to pm
const p1 = (await call(pm, "post.add", { topicId: tid, body: "pm view" })).data;
ok(p1.round === 1 && p1.author === "pm" && p1.kind === "perspective", "post.add as pm → round 1 perspective, author pm");

// 5. post.add as pm AGAIN same round → err (once-per-round)
ok((await call(pm, "post.add", { topicId: tid, body: "pm again" })).isError, "post.add same round twice → err already posted");

// 6. post.add as sweep (NOT invited) → FORBIDDEN
ok((await call(sweep, "post.add", { topicId: tid, body: "uninvited" })).isError, "post.add by uninvited actor → FORBIDDEN");

// 7. qa + dev post → pending shrinks to empty
await call(qa, "post.add", { topicId: tid, body: "qa view" });
await call(dev, "post.add", { topicId: tid, body: "dev view" });
ok((await call(director, "topic.list", { status: "open" })).data.find((t: any) => t.id === tid).pending.length === 0, "after all invited post → pending empty (round ripe)");

// 8. synthesize as PM (not the chair) → FORBIDDEN
ok((await call(pm, "topic.synthesize", { topicId: tid, body: "pm synth" })).isError, "topic.synthesize by non-chair → FORBIDDEN");

// 9. synthesize as director with nextRound → synthesis post at round 1 + round bumps to 2
const syn = (await call(director, "topic.synthesize", { topicId: tid, body: "round-1 synthesis", nextRound: true })).data;
ok(syn.synthesizedRound === 1 && syn.round === 2 && syn.status === "open", "topic.synthesize(nextRound) → synth at r1, round→2, still open");
const got = (await call(director, "topic.get", { id: tid })).data;
ok(got.posts.some((p: any) => p.kind === "synthesis" && p.round === 1 && p.author === "director") && got.round === 2, "topic.get shows the chair's r1 synthesis + round=2");

// 10. pm posts again at the NEW round → succeeds (per-round UNIQUE is per round)
ok((await call(pm, "post.add", { topicId: tid, body: "pm round 2" })).data.round === 2, "post.add at the bumped round → succeeds");

// 11. close as director with a decision → closed, decision + closed_at set
const closed = (await call(director, "topic.close", { topicId: tid, decision: "Ship A before B" })).data;
ok(closed.status === "closed" && closed.decision === "Ship A before B" && typeof closed.closed_at === "string", "topic.close → closed, decision + closed_at set");

// 12. post.add to a CLOSED topic → CONFLICT
ok((await call(qa, "post.add", { topicId: tid, body: "late" })).isError, "post.add to closed topic → CONFLICT");

// 13. synthesize / close on the closed topic → err
ok((await call(director, "topic.synthesize", { topicId: tid, body: "x" })).isError, "synthesize on closed topic → err");
ok((await call(director, "topic.close", { topicId: tid, decision: "y" })).isError, "close an already-closed topic → err");

// isolation — a second project cannot read this project's topic
ok((await call(beta, "topic.get", { id: tid })).isError, "a different project CANNOT read this topic (isolation)");
ok((await call(beta, "topic.list", {})).data.length === 0, "the second project's board is empty (isolation)");

// §17 DELIBERATE-INVARIANT — no board tool can write a file: none takes a path/file/fs arg,
// and the decision is re-readable as DATA only (it never auto-applies a structural change).
const tools = (await director.listTools()).tools;
const boardTools = tools.filter((t: any) => t.name.startsWith("topic.") || t.name.startsWith("post."));
const anyFsArg = boardTools.some((t: any) => Object.keys(t.inputSchema?.properties ?? {}).some((k) => /path|file|fs|exec|cmd/i.test(k)));
ok(boardTools.length === 6 && !anyFsArg, "§17: all 6 board tools are DB-only — none accepts a path/file/exec arg");
ok((await call(director, "topic.get", { id: tid })).data.decision === "Ship A before B", "the decision persists as re-readable DATA (a recorded conclusion, not an action)");

for (const c of [director, pm, qa, dev, sweep, beta]) await c.close();
console.log(fails === 0 ? "\nBOARD_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
