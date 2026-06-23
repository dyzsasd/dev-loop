// P7 one-way Linear mirror. Two layers:
//  (1) adapter UNIT tests with an injected fetchImpl — the REAL createIssue/updateIssue/findByMarker/
//      gql-error/timeout branches of linear.ts (no live Linear), incl. the §16 token-never-thrown property.
//  (2) tool DRYRUN tests over the stdio server — create-then-update idempotency via mirror_map, the
//      incremental hash-skip, the split-brain banner + [hub:id] marker in the body, NO delete path,
//      secret-never-returned, ONE-WAY (no pull/import tool), stateMap fallback, per-project isolation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { createIssue, updateIssue, findByMarker, type FetchImpl } from "../src/linear.ts";

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// ── Layer 1: adapter units with a mock fetchImpl ─────────────────────────────
function mockFetch(handler: (url: string, init: { body?: string; headers?: Record<string, string> }) => { status: number; body: unknown } | "hang"): FetchImpl {
  return (async (url: string, init: { body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
    const r = handler(String(url), init ?? {});
    if (r === "hang") return await new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return { status: r.status, json: async () => r.body } as unknown as Response;
  }) as FetchImpl;
}

// createIssue → Authorization carries the token, input carries teamId+title, returns the id
{
  let seen: { headers?: Record<string, string>; body?: string } = {};
  const f = mockFetch((_u, init) => { seen = init; return { status: 200, body: { data: { issueCreate: { success: true, issue: { id: "lin_1" } } } } }; });
  const id = await createIssue(f, "lin_api_SECRET", "team_1", "proj_1", { title: "T [hub:CH-1]", description: "body" });
  ok(id === "lin_1" && seen.headers!.Authorization === "lin_api_SECRET" && JSON.parse(seen.body!).variables.i.teamId === "team_1", "createIssue → id returned, token in Authorization, teamId in input");
}

// gql error → throws the Linear message, never the token
{
  const f = mockFetch(() => ({ status: 200, body: { errors: [{ message: "Authentication required" }] } }));
  let msg = "";
  try { await createIssue(f, "lin_api_SECRET", "t", null, { title: "x", description: "y" }); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("Authentication required") && !msg.includes("SECRET"), "gql error → throws the Linear message, never the token (§16)");
}

// non-200 → throws status only
{
  const f = mockFetch(() => ({ status: 429, body: {} }));
  let msg = "";
  try { await updateIssue(f, "lin_api_SECRET", "lin_1", { title: "x", description: "y" }); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("429") && !msg.includes("SECRET"), "non-200 → throws the http status, never the token");
}

// findByMarker → returns the matching id, else null
{
  const f = mockFetch(() => ({ status: 200, body: { data: { issues: { nodes: [{ id: "lin_existing" }] } } } }));
  ok((await findByMarker(f, "tok", "[hub:CH-1]")) === "lin_existing", "findByMarker → returns the reconciled id");
  const f0 = mockFetch(() => ({ status: 200, body: { data: { issues: { nodes: [] } } } }));
  ok((await findByMarker(f0, "tok", "[hub:CH-9]")) === null, "findByMarker → null when no match");
}

// timeout — a hung Linear aborts fast and never wedges the fire
{
  process.env.DEVLOOP_MIRROR_TIMEOUT_MS = "250";
  const f = mockFetch(() => "hang");
  let msg = ""; const t0 = Date.now();
  try { await createIssue(f, "tok", "t", null, { title: "x", description: "y" }); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("timeout") && Date.now() - t0 < 2000, "a hung Linear → fast timeout error (never wedges the fire)");
  delete process.env.DEVLOOP_MIRROR_TIMEOUT_MS;
}

// ── Layer 2: tool DRYRUN tests over the stdio server ─────────────────────────
const DB = "/tmp/hub-mirror/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }
async function as(actor: string, project: string, prefix?: string): Promise<Client> {
  const env: Record<string, string> = {
    ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB,
    DEVLOOP_CREATE_PROJECT: "1", DEVLOOP_MIRROR_DRYRUN: "1", DEVLOOP_LINEAR_TOKEN: "lin_api_DRYRUNSECRET",
  };
  if (prefix) env.DEVLOOP_TICKET_PREFIX = prefix;
  const c = new Client({ name: `mir-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content?: { text?: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}
const PUSH = { teamId: "team_1", tokenEnv: "DEVLOOP_LINEAR_TOKEN", stateMap: { "In Review": "lin_state_review" } };

const sweep = await as("sweep", "mirp", "MR");
const beta = await as("sweep", "betap", "MB"); // second project for isolation

const t1 = (await call(sweep, "save_issue", { title: "First ticket", type: "Feature" })).data;
const t2 = (await call(sweep, "save_issue", { title: "Second ticket", type: "Bug" })).data;

// first push → both created; ops carry the banner + [hub:id] marker
const p1 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p1.created === 2 && p1.updated === 0 && p1.dryrun === true, "mirror.push → 2 created (dryrun)");
const op1 = p1.ops.find((o: any) => o.hubId === t1.id);
ok(op1.body.includes("Mirrored from the dev-loop hub") && op1.title.includes(`[hub:${t1.id}]`), "pushed op carries the split-brain banner + [hub:id] marker");
ok((await call(sweep, "mirror.status")).data.mapped === 2, "mirror.status → 2 mapped");

// second push, no change → all skipped (incremental hash-skip)
const p2 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p2.created === 0 && p2.skipped === 2, "re-push with no change → 2 skipped (incremental hash-skip)");

// change one ticket → only it is re-pushed (update); the other skips
await call(sweep, "save_issue", { id: t1.id, state: "In Review" });
const p3 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p3.updated === 1 && p3.skipped === 1, "after editing one ticket → 1 updated, 1 skipped");
const op3 = p3.ops.find((o: any) => o.hubId === t1.id);
ok(op3.op === "update" && op3.stateId === "lin_state_review", "the changed ticket → update op with the mapped stateId");

// stateMap fallback — a state with no mapping pushes with NO stateId, never fails
await call(sweep, "save_issue", { id: t2.id, state: "Done" }); // 'Done' not in stateMap
const p4 = (await call(sweep, "mirror.push", PUSH)).data;
const op4 = p4.ops.find((o: any) => o.hubId === t2.id);
ok(p4.failed === 0 && op4.op === "update" && op4.stateId === null, "unmapped state → stateId null, push does NOT fail (fallback)");

// cancel → still mirrored, NEVER deleted (no delete op exists at all)
await call(sweep, "save_issue", { id: t2.id, state: "Canceled" });
const p5 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p5.ops.every((o: any) => o.op === "create" || o.op === "update"), "a Canceled ticket → update op, NEVER a delete (no data-loss)");

// §16 — the token never appears in any result
ok(!JSON.stringify(p1).includes("DRYRUNSECRET") && !JSON.stringify(await call(sweep, "mirror.status")).includes("DRYRUNSECRET"), "the Linear token never appears in a tool result (§16)");

// ONE-WAY — there is NO pull/import/sync-from-Linear tool (the hub never reads Linear as truth)
const tools = (await sweep.listTools()).tools.map((t: any) => t.name);
ok(tools.includes("mirror.push") && tools.includes("mirror.status") && !tools.some((n: string) => /mirror\.(pull|import|sync|fetch)/.test(n)), "ONE-WAY: only mirror.push/status exist — no pull/import tool");

// isolation — pushing project A maps nothing in project B
ok((await call(beta, "mirror.status")).data.mapped === 0, "a different project's mirror_map is empty (isolation)");

for (const c of [sweep, beta]) await c.close();
console.log(fails === 0 ? "\nMIRROR_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
