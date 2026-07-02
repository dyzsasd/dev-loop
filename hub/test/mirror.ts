// P7 one-way Linear mirror. Two layers:
//  (1) adapter UNIT tests with an injected fetchImpl — the REAL createIssue/updateIssue/findByMarker/
//      gql-error/timeout branches of linear.ts (no live Linear), incl. the §16 token-never-thrown property.
//  (2) tool DRYRUN tests over the stdio server — create-then-update idempotency via mirror_map, the
//      incremental hash-skip, the split-brain banner + [hub:id] marker in the body, NO delete path,
//      secret-never-returned, ONE-WAY (no pull/import tool), stateMap fallback, per-project isolation.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
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
  const id = await createIssue(f, "lin_api_SECRET", "team_1", "proj_1", { title: "T [hub:CH-1]", description: "body", priority: 1 });
  ok(id === "lin_1" && seen.headers!.Authorization === "lin_api_SECRET" && JSON.parse(seen.body!).variables.i.teamId === "team_1", "createIssue → id returned, token in Authorization, teamId in input");
  ok(JSON.parse(seen.body!).variables.i.priority === 1, "L2: createIssue sends native Linear priority (0-4), not just body text");
}
// priority omitted ⇒ the field is not sent (no accidental priority:0/None on an unset ticket)
{
  let seen: { body?: string } = {};
  const f = mockFetch((_u, init) => { seen = init; return { status: 200, body: { data: { issueCreate: { success: true, issue: { id: "lin_2" } } } } }; });
  await createIssue(f, "tok", "team_1", null, { title: "no prio", description: "b" });
  ok(!("priority" in JSON.parse(seen.body!).variables.i), "L2: createIssue omits priority when unset (no forced None)");
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

// ── Layer 2: tool tests over the stdio server, against a MOCK Linear endpoint ────────────────
// A DRYRUN push must be write-free (DL-11), so it can no longer be used to exercise the persistence
// path. Instead we stand up a mock Linear GraphQL endpoint (the server's endpoint is env-overridable,
// DEVLOOP_LINEAR_API_URL) and run REAL pushes against it — restoring create/update/skip coverage on
// actual mirror_map persistence — plus dedicated DL-11 dry-run assertions.
const DB = "/tmp/hub-mirror/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

// The mock records every mutation it receives (so we can assert the wire payload) and returns success;
// findByMarker always returns no match → the create path runs for a new ticket.
let linCounter = 0;
let linSent: { kind: "find" | "create" | "update"; vars: any }[] = [];
const mockLinear = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let data: Record<string, unknown> = {};
    try {
      const { query, variables } = JSON.parse(raw);
      const q = String(query ?? "");
      if (q.includes("issues(")) { linSent.push({ kind: "find", vars: variables }); data = { issues: { nodes: [] } }; }
      else if (q.includes("issueCreate")) { linSent.push({ kind: "create", vars: variables }); data = { issueCreate: { success: true, issue: { id: `lin_${++linCounter}` } } }; }
      else if (q.includes("issueUpdate")) { linSent.push({ kind: "update", vars: variables }); data = { issueUpdate: { success: true } }; }
    } catch { /* malformed → {} */ }
    const out = JSON.stringify({ data });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) }); res.end(out);
  });
});
await new Promise<void>((r) => mockLinear.listen(0, "127.0.0.1", () => r()));
const MOCK_URL = `http://127.0.0.1:${(mockLinear.address() as { port: number }).port}/graphql`;

async function as(actor: string, project: string, opts: { dryrun?: boolean; prefix?: string } = {}): Promise<Client> {
  const env: Record<string, string> = {
    ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB,
    DEVLOOP_CREATE_PROJECT: "1", DEVLOOP_LINEAR_TOKEN: "lin_api_SECRET", DEVLOOP_LINEAR_API_URL: MOCK_URL,
  };
  if (opts.dryrun) env.DEVLOOP_MIRROR_DRYRUN = "1";
  if (opts.prefix) env.DEVLOOP_TICKET_PREFIX = opts.prefix;
  const c = new Client({ name: `mir-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const r = await c.callTool({ name, arguments: args }) as { isError?: boolean; content?: { text?: string }[] };
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}
const PUSH = { teamId: "team_1", tokenEnv: "DEVLOOP_LINEAR_TOKEN", stateMap: { "In Review": "lin_state_review" } };

// ── DL-11: a DRYRUN push is WRITE-FREE — it previews ops but persists NOTHING and hits no network ──
const dry = await as("sweep", "dryp", { dryrun: true, prefix: "DRY" });
const dt = (await call(dry, "save_issue", { title: "Dry ticket", type: "Feature" })).data;
const dp1 = (await call(dry, "mirror.push", PUSH)).data;
ok(dp1.created === 1 && dp1.dryrun === true && dp1.ops?.length === 1, "DRYRUN push → previews 1 create op (dryrun:true)");
ok(dp1.ops[0].title.includes(`[hub:${dt.id}]`) && dp1.ops[0].body.includes("Mirrored from the dev-loop hub"), "DRYRUN op carries the [hub:id] marker + split-brain banner");
const dstat = (await call(dry, "mirror.status")).data;
ok(dstat.mapped === 0 && dstat.lastPush === null, "DL-11: after a DRYRUN push, mirror_map is EMPTY (mapped:0, lastPush:null)");
ok((await call(dry, "mirror.push", PUSH)).data.created === 1, "DL-11: a 2nd DRYRUN still reports 1 create — it is stateless (no persisted dry-run row to skip on)");
ok(linSent.length === 0, "DL-11: a DRYRUN makes NO network call to Linear (the mock received nothing)");

// ── DL-11 AC(b): a real (live) push AFTER a dry-run still CREATES — the dry-run left no poisoned map ──
const dryLive = await as("sweep", "dryp", { prefix: "DRY" }); // same project, LIVE now
const dlp = (await call(dryLive, "mirror.push", PUSH)).data;
ok(dlp.created === 1 && dlp.skipped === 0 && !dlp.dryrun, "DL-11: a live push after a dry-run CREATES (not skipped on a poisoned hash, not pointed at a dry-<id>)");
ok((await call(dryLive, "mirror.status")).data.mapped === 1, "DL-11: the live push actually mapped the ticket (dryp now mapped:1)");

// ── LIVE pushes against the mock — the real mirror_map persistence path (create/update/skip) ──
linSent = [];
const sweep = await as("sweep", "mirp", { prefix: "MR" });
const beta = await as("sweep", "betap", { prefix: "MB" }); // second project for isolation
const t1 = (await call(sweep, "save_issue", { title: "First ticket", type: "Feature" })).data;
const t2 = (await call(sweep, "save_issue", { title: "Second ticket", type: "Bug" })).data;

// first live push → both created + persisted; the create sent to Linear carries the banner + [hub:id] marker
const p1 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p1.created === 2 && p1.updated === 0 && !p1.dryrun, "live mirror.push → 2 created (persisted)");
ok((await call(sweep, "mirror.status")).data.mapped === 2, "mirror.status → 2 mapped (live push persisted)");
const c1 = linSent.find((s) => s.kind === "create" && s.vars.i.title.includes(`[hub:${t1.id}]`));
ok(!!c1 && c1.vars.i.description.includes("Mirrored from the dev-loop hub"), "the create sent to Linear carries the [hub:id] marker + split-brain banner");

// second push, no change → all skipped (incremental hash-skip over the PERSISTED map)
const p2 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p2.created === 0 && p2.skipped === 2, "re-push with no change → 2 skipped (incremental hash-skip)");

// change one ticket → only it is re-pushed as an UPDATE to its persisted linear_id, with the mapped stateId
await call(sweep, "save_issue", { id: t1.id, state: "In Review" });
linSent = [];
const p3 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p3.updated === 1 && p3.skipped === 1, "after editing one ticket → 1 updated, 1 skipped");
const u3 = linSent.find((s) => s.kind === "update");
ok(!!u3 && u3.vars.i.stateId === "lin_state_review", "the changed ticket → issueUpdate sent with the mapped stateId");

// stateMap fallback — a state with no mapping pushes with NO stateId, never fails
await call(sweep, "save_issue", { id: t2.id, state: "Done" }); // 'Done' not in stateMap
linSent = [];
const p4 = (await call(sweep, "mirror.push", PUSH)).data;
const u4 = linSent.find((s) => s.kind === "update");
ok(p4.failed === 0 && !!u4 && u4.vars.i.stateId == null, "unmapped state → no stateId in the update, push does NOT fail (fallback)");

// cancel → still mirrored as an update, NEVER deleted (no delete op exists at all)
await call(sweep, "save_issue", { id: t2.id, state: "Canceled" });
const p5 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p5.failed === 0 && p5.updated >= 1, "a Canceled ticket → update op, NEVER a delete (no data-loss)");

// §16 — the token never appears in any result
ok(!JSON.stringify(p1).includes("SECRET") && !JSON.stringify(await call(sweep, "mirror.status")).includes("SECRET"), "the Linear token never appears in a tool result (§16)");

// ONE-WAY — there is NO pull/import/sync-from-Linear tool (the hub never reads Linear as truth)
const tools = (await sweep.listTools()).tools.map((t: any) => t.name);
ok(tools.includes("mirror.push") && tools.includes("mirror.status") && !tools.some((n: string) => /mirror\.(pull|import|sync|fetch)/.test(n)), "ONE-WAY: only mirror.push/status exist — no pull/import tool");

// isolation — pushing project A maps nothing in project B
ok((await call(beta, "mirror.status")).data.mapped === 0, "a different project's mirror_map is empty (isolation)");

for (const c of [dry, dryLive, sweep, beta]) await c.close();
mockLinear.close();
console.log(fails === 0 ? "\nMIRROR_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
