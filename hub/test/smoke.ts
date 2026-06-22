// End-to-end smoke: pm files → dev claims+ships → qa verifies, each a DISTINCT actor
// (its own server process) sharing ONE WAL hub.db. Proves attribution + multi-process concurrency.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";

const DB = "/tmp/hub-smoke/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

async function as(actor: string): Promise<Client> {
  const c = new Client({ name: `test-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "monpick", DEVLOOP_HUB_DB: DB },
  }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error("❌ " + msg); process.exit(1); } console.log("✅ " + msg); };

const pm = await as("pm"), dev = await as("dev"), qa = await as("qa"), op = await as("operator");

assert((await call(pm, "whoami")).actor === "pm", "pm session identifies as pm");

const issue = await call(pm, "save_issue", { title: "Add Lark digest", type: "Feature", labels: ["dev-loop", "Feature", "pm"] });
assert(issue.id.startsWith("DL-") && issue.created_by === "pm" && issue.state === "Todo", `pm filed ${issue.id} (created_by=pm, Todo)`);

const todo = await call(dev, "list_issues", { state: "Todo" });
assert(todo.some((t: any) => t.id === issue.id), "dev sees the ticket in Todo (shared db across processes)");

const claimed = await call(dev, "save_issue", { id: issue.id, state: "In Progress", assignee: "me" });
assert(claimed.assignee === "dev" && claimed.state === "In Progress", "dev claimed it (assignee=dev, In Progress)");
await call(dev, "save_comment", { issueId: issue.id, body: "shipped in commit abc1234" });
await call(dev, "save_issue", { id: issue.id, state: "In Review" });

const seen = await call(qa, "get_issue", { id: issue.id });
assert(seen.state === "In Review" && seen.comments.some((c: any) => c.author === "dev"), "qa sees In Review + dev's comment (attributed to dev)");
await call(qa, "save_comment", { issueId: issue.id, body: "verified ✅ digest lands in Lark" });
const done = await call(qa, "save_issue", { id: issue.id, state: "Done" });
assert(done.state === "Done", "qa verified → Done");

const events = await call(op, "list_events", {});
const actors = new Set(events.map((e: any) => e.actor));
assert(actors.has("pm") && actors.has("dev") && actors.has("qa"), `attribution log shows distinct actors: ${[...actors].join(", ")}`);
console.log("\nattribution trail:");
for (const e of [...events].reverse()) console.log(`  ${e.actor.padEnd(9)} ${e.kind.padEnd(18)} ${e.ticket_id ?? ""}`);

for (const c of [pm, dev, qa, op]) await c.close();
console.log("\nHUB_SMOKE_OK");
