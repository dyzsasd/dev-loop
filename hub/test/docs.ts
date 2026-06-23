// P4 documents: versioning, diff, optimistic-CAS CONFLICT, operator-publish gate,
// unpublished-draft fallback, per-project isolation — across distinct actor processes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";

const DB = "/tmp/hub-docs/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

async function as(actor: string, project: string, prefix?: string): Promise<Client> {
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB };
  if (prefix) { env.DEVLOOP_CREATE_PROJECT = "1"; env.DEVLOOP_TICKET_PREFIX = prefix; }
  else env.DEVLOOP_CREATE_PROJECT = "1";
  const c = new Client({ name: `doc-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}
let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

const pm = await as("pm", "docp", "DP");
const reflect = await as("reflect", "docp");
const operator = await as("operator", "docp");
const beta = await as("pm", "betap", "BP"); // a second project for isolation

// create → version → history
ok((await call(pm, "doc.save", { slug: "strategy", kind: "strategy", title: "North Star", body: "goal one\ngoal two", baseVersion: 0 })).data.version === 1, "doc.save creates v1 (draft)");
ok((await call(pm, "doc.save", { slug: "strategy", kind: "strategy", body: "goal one\ngoal two\ngoal three", baseVersion: 1 })).data.version === 2, "doc.save appends v2 from baseVersion 1");
const hist = (await call(pm, "doc.history", { kind: "strategy" })).data;
ok(hist.length === 2 && hist[0].version === 2 && hist.every((v: any) => v.author === "pm"), "doc.history → 2 versions, newest-first, author=pm");

// diff
const diff = (await call(pm, "doc.diff", { kind: "strategy", from: 1, to: 2 })).data;
ok(diff.unified.includes("+ goal three") && diff.fromBody === "goal one\ngoal two", "doc.diff shows the added line");

// optimistic CAS — stale baseVersion is rejected, no silent loss
ok((await call(reflect, "doc.save", { slug: "strategy", kind: "strategy", body: "reflect clobber", baseVersion: 1 })).isError, "stale baseVersion → CONFLICT (no last-write-wins)");
ok((await call(pm, "doc.history", { kind: "strategy" })).data.length === 2, "still exactly 2 versions after the rejected concurrent save");

// operator-publish gate
const pre = (await call(pm, "doc.get", { kind: "strategy" })).data;
ok(pre.unpublished === true && pre.body.includes("goal three"), "doc.get before publish → latest DRAFT + unpublished:true");
ok((await call(pm, "doc.publish", { kind: "strategy", version: 2 })).isError, "non-operator doc.publish → FORBIDDEN");
ok((await call(operator, "doc.publish", { kind: "strategy", version: 2 })).data.current_version === 2, "operator doc.publish → current_version=2");
const post = (await call(pm, "doc.get", { kind: "strategy" })).data;
ok(post.version === 2 && !post.unpublished, "doc.get after publish → the published v2, no unpublished flag");
ok((await call(pm, "doc.get", { kind: "strategy", version: 1 })).data.body === "goal one\ngoal two", "doc.get version=1 → the historical v1");
ok((await call(operator, "doc.publish", { kind: "strategy", version: 99 })).isError, "publish a non-existent version → err");

// per-project isolation
ok((await call(beta, "doc.get", { kind: "strategy" })).isError, "a different project CANNOT read this project's doc (isolation)");

// single-current invariant (Codex review): re-publishing v1 after v2 leaves EXACTLY one version 'current'
await call(operator, "doc.publish", { kind: "strategy", version: 1 });
const histAfter = (await call(pm, "doc.history", { kind: "strategy" })).data;
const currents = histAfter.filter((v: any) => v.status === "current");
ok(currents.length === 1 && currents[0].version === 1, "publish v1 after v2 → exactly ONE version row is 'current' (the ledger never holds two)");
ok((await call(pm, "doc.get", { kind: "strategy" })).data.version === 1, "doc.get tracks the re-published current_version=1");

for (const c of [pm, reflect, operator, beta]) await c.close();
console.log(fails === 0 ? "\nHUB_DOCS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
