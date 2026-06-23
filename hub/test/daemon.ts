// DL-1 — the read-only localhost daemon over the hub SoR. Seeds a project with tickets + a published
// roadmap through the REAL MCP write path (distinct actors), then starts the daemon in-process against
// the same WAL db and asserts every read endpoint, the 404s, the read-only 405, and the 127.0.0.1 bind.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";

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
const feat = await call(pm, "save_issue", { title: "Daemon foundation", type: "Feature", labels: ["dev-loop", "Feature", "pm"], priority: 2 });
const bug = await call(pm, "save_issue", { title: "A defect to fix", type: "Bug", labels: ["dev-loop", "Bug", "qa"], priority: 1 });
await call(pm, "save_comment", { issueId: feat.id, body: "kicking this off" });
await call(pm, "save_issue", { id: bug.id, state: "In Review", relatedTo: [feat.id] }); // give the board >1 state + a relation (DL-8)
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

// GET /api — the JSON API index (moved off / when DL-2 took the root for the UI)
const root = await get("/api");
ok(root.status === 200 && root.body.project === "dmn" && root.body.endpoints.includes("/api/tickets") && root.body.ui === "/", "GET /api → 200 JSON index naming the project, endpoints, and the UI root");

// GET /api/health
const health = await get("/api/health");
ok(health.status === 200 && health.body.ok === true && health.body.project === "dmn", "GET /api/health → ok:true for the project");

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
async function startWritable(actor: string): Promise<{ base: string; close: () => void }> {
  const wdb = openDb(DB);                                   // writable — backs ONLY the /roadmap/* routes
  const rdb = openDb(DB); rdb.exec("PRAGMA query_only=ON");
  const srv = createDaemon({ db: rdb, projectId, projectKey: "dmn", writeDb: wdb, actor });
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
const stale = await postForm(opd.base, "/roadmap/save", { baseVersion: "1", body: "STALE OVERWRITE", summary: "racing" });
ok(stale.status === 409 && /CONFLICT/.test(stale.text), "stale baseVersion → 409 CONFLICT (no last-write-wins)");
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

await verifier.close();
opd.close();
devd.close();
server.close();
ddb.close();

console.log(fails === 0 ? "\nDAEMON_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
