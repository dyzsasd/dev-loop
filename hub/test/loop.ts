// Comprehensive op-contract validation: drives the hub through the real loop flows the SKILLs
// require — dedupe (duplicateOf + body-scan query), coverage/split (append-only relatedTo),
// blocked (labels + Bail-shape comment), sweep orphan-reset, Reflect via list_events — each
// step as a DISTINCT actor process sharing one WAL db. Proves P2 SKILL-portability end-to-end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DL-21: a UNIQUE temp dir per invocation (mkdtempSync), not a fixed `/tmp/hub-loop/hub.db`. The old
// fixed path was rm'd at start and reopened by 5 concurrent server connections — but a still-terminating
// server from the PREVIOUS `npm test` run (clients are closed but child exit isn't awaited before
// process.exit) could collide with that rm/recreate, splitting the WAL/-shm/inode across this run's
// connections so some writes/reads hit a different db state → intermittent events/dedupe failures. A
// fresh unique dir can't be held by any prior-run process, so the SoR is isolated regardless of run/suite
// order. Cleaned up at the end.
const DIR = mkdtempSync(join(tmpdir(), "hub-loop-"));
const DB = join(DIR, "hub.db");

async function as(actor: string): Promise<Client> {
  const c = new Client({ name: `t-${actor}`, version: "0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "monpick", DEVLOOP_HUB_DB: DB, DEVLOOP_CREATE_PROJECT: "1" },
  }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "✅ " : "❌ ") + msg); if (!cond) fails++; };

const pm = await as("pm"), dev = await as("dev"), qa = await as("qa"), sweep = await as("sweep"), reflect = await as("reflect");
const FULL = (extra: string[] = []) => ["dev-loop", "Feature", "pm", ...extra];

// 1. PM files two near-dupes; F1's distinguishing noun lives ONLY in the description (GAP 2 body-scan).
const f1 = await call(pm, "save_issue", { title: "Creator payout dashboard", description: "Show the zephyrwidget breakdown per creator.", type: "Feature", labels: FULL() });
const f2 = await call(pm, "save_issue", { title: "Payout view for creators", description: "Per-creator earnings table.", type: "Feature", labels: FULL() });
ok(f1.id !== f2.id && f1.relatedTo.length === 0 && f1.duplicateOf === null, "PM filed F1, F2 (relations empty by default)");

// 2. Dev dedupe: body-only-noun query finds F1, then mark F2 Duplicate→F1 (GAP 2 + GAP 1a).
const hits = await call(dev, "list_issues", { query: "zephyrwidget" });
ok(hits.length === 1 && hits[0].id === f1.id, "dedupe query scans DESCRIPTION not just title (GAP 2 closed)");
await call(dev, "save_issue", { id: f2.id, state: "Duplicate", duplicateOf: f1.id });
ok((await call(dev, "get_issue", { id: f2.id })).duplicateOf === f1.id, "duplicateOf scalar set + surfaced (GAP 1a closed)");

// 3. Dev claims F1, ships, files a [coverage] follow-up linked via relatedTo (relatedTo on create).
const claimed = await call(dev, "save_issue", { id: f1.id, state: "In Progress", assignee: "me" });
ok(claimed.assignee === "dev" && claimed.state === "In Progress", "dev claimed F1 (assignee=dev)");
const cov = await call(dev, "save_issue", { title: "[coverage] regression test for payout dashboard", type: "Improvement", labels: ["dev-loop", "Improvement", "qa", "coverage"], relatedTo: [f1.id] });
ok(cov.relatedTo[0] === f1.id, "coverage ticket created with relatedTo (§15)");
await call(dev, "save_comment", { issueId: f1.id, body: "shipped in abc1234" });
await call(dev, "save_issue", { id: f1.id, state: "In Review", relatedTo: [cov.id] });
// 4. APPEND-ONLY: link F1 to a sibling too; both links must survive (union, not replace) (GAP 1b).
const f1b = await call(dev, "save_issue", { id: f1.id, relatedTo: ["DL-sibling"] });
ok(f1b.relatedTo.includes(cov.id) && f1b.relatedTo.includes("DL-sibling") && f1b.relatedTo.length === 2,
   "relatedTo is APPEND-ONLY union — both links survive (GAP 1b closed)");

// 5. Blocked flow: PM files F3, dev blocks it with a Bail-shape comment; PM finds it via the blocked label.
const f3 = await call(pm, "save_issue", { title: "Stripe payout transfers", type: "Feature", labels: FULL() });
await call(dev, "save_issue", { id: f3.id, state: "Todo", assignee: null, labels: ["dev-loop", "Feature", "pm", "blocked", "needs-pm"] });
await call(dev, "save_comment", { issueId: f3.id, body: "Bail-shape: external-prereq\nNeed live Stripe keys to implement transfers." });
const blocked = await call(pm, "list_issues", { label: "blocked" });
ok(blocked.some((t: any) => t.id === f3.id), "PM finds the blocked ticket via the blocked label (§9)");
const f3seen = await call(pm, "get_issue", { id: f3.id });
ok(f3seen.comments.at(-1).body.startsWith("Bail-shape: external-prereq"), "PM reads Dev's Bail-shape from the latest comment (§9)");

// 6. QA verifies F1 → Done.
await call(qa, "save_comment", { issueId: f1.id, body: "verified ✅" });
ok((await call(qa, "save_issue", { id: f1.id, state: "Done" })).state === "Done", "QA verified F1 → Done");

// 7. Sweep orphan-reset: a ticket stuck In Progress gets reset; partial-merge preserves title.
const g1 = await call(pm, "save_issue", { title: "Orphan candidate", state: "In Progress", assignee: "dev", labels: FULL() });
const orphans = await call(sweep, "list_issues", { state: "In Progress" });
ok(orphans.some((t: any) => t.id === g1.id), "Sweep finds the orphaned In Progress ticket");
const reset = await call(sweep, "save_issue", { id: g1.id, state: "Todo", assignee: null, labels: FULL() });
ok(reset.state === "Todo" && reset.assignee === null && reset.title === "Orphan candidate", "Sweep reset orphan (title preserved via partial-merge)");

// 8. Reflect reconstructs the window from list_events (service-backend activity feed; the §18-local-comment-log replacement).
const events = await call(reflect, "list_events", { limit: 200 });
const actors = new Set(events.map((e: any) => e.actor));
const kinds = new Set(events.map((e: any) => e.kind));
ok(actors.has("pm") && actors.has("dev") && actors.has("qa") && actors.has("sweep"), `events attribute distinct actors: ${[...actors].sort().join(", ")}`);
ok(kinds.has("issue.create") && kinds.has("issue.transition") && kinds.has("comment.add"), "events carry issue.create/transition/comment.add (Reflect window source)");

for (const c of [pm, dev, qa, sweep, reflect]) await c.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ } // DL-21: remove this run's unique db dir
console.log(fails === 0 ? "\nHUB_LOOP_OK — every P2 op-contract flow verified" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
