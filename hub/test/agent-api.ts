// DL-43 — the opt-in daemon agent op-API (/api/op/*). Seeds a project through the REAL stdio MCP write
// path, starts a WRITABLE daemon in-process, and asserts: the mount is DORMANT (404) until the project opts
// in via settings_json.hub.transport==="daemon"; the 5 core ops mirror the stdio server; a write lands
// ATTRIBUTED to the X-Devloop-Actor header (confirmed via list_events on the stdio path — cross-path
// consistency); the full endpoint pipeline (CSRF/foreign-Host → unknown/missing actor → dry-run mode gate)
// refuses correctly; and the existing read/roadmap surfaces stay byte-for-byte unchanged through every toggle.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";

const DB = "/tmp/hub-agent-api/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// seed the project + actors (ensureActors runs inside seed.ts → dev/qa/pm/operator all exist; "ghost" does not)
execFileSync("node", ["src/seed.ts", "agp", "AgentAPI Project", "AGP", DB], { encoding: "utf8" });

// ─── seed one ticket through the real stdio MCP write path (the daemon must read what agents wrote) ───
async function as(actor: string): Promise<Client> {
  const c = new Client({ name: `aaptest-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "agp", DEVLOOP_HUB_DB: DB },
  }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}
const pm = await as("pm");
const feat = await call(pm, "save_issue", { title: "Seed feature", type: "Feature", labels: ["dev-loop", "Feature", "pm"], priority: 2 });
const verifier = await as("dev"); // an MCP client on the stdio path → list_events / get_issue for cross-path checks

// ─── start a WRITABLE daemon in-process (read conn query_only; write conn for the op-API writes) ───
const rdb = openDb(DB); rdb.exec("PRAGMA query_only=ON");
const wdb = openDb(DB);
const projectId = findProject(rdb, "agp")!;
const server = createDaemon({ db: rdb, projectId, projectKey: "agp", writeDb: wdb, actor: "operator" });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// op-API call over node:http so we can forge X-Devloop-Actor / Origin / Host (fetch forbids the latter two).
function op(name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const body = JSON.stringify(args ?? {});
  return new Promise((resolve, reject) => {
    const r = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path: `/api/op/${name}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } },
      (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => { let b: any; try { b = JSON.parse(d); } catch { b = null; } resolve({ status: res.statusCode ?? 0, body: b }); }); });
    r.on("error", reject); r.end(body);
  });
}
const DEV = { "x-devloop-actor": "dev" }, QA = { "x-devloop-actor": "qa" };
async function getJson(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path); let b: any; try { b = await r.json(); } catch { b = null; } return { status: r.status, body: b };
}
const eventsBy = async (actor: string, kind: string, ticketId: string): Promise<boolean> =>
  (await call(verifier, "list_events", { limit: 200 })).some((e: any) => e.actor === actor && e.kind === kind && e.ticket_id === ticketId);

// ═══ DORMANT by default — settings_json.hub.transport unset ⇒ every /api/op/* path 404s ═══════════════
ok((await op("save_issue", { title: "x" }, DEV)).status === 404, "flag-off: POST /api/op/save_issue → 404 (mount dormant, no hub.transport)");
ok((await op("list_issues", {}, DEV)).status === 404, "flag-off: POST /api/op/list_issues → 404 (reads dormant too)");
// DL-62: the widened doc/event ops are dormant too while the flag is off (default-off, zero new surface)
ok((await op("doc.list", {}, DEV)).status === 404, "flag-off: POST /api/op/doc.list → 404 (doc reads dormant too)");
ok((await op("doc.save", { slug: "x", kind: "strategy", body: "y", baseVersion: 0 }, { "x-devloop-actor": "pm" })).status === 404, "flag-off: POST /api/op/doc.save → 404 (doc writes dormant too)");
ok((await op("list_events", {}, DEV)).status === 404, "flag-off: POST /api/op/list_events → 404 (events dormant too)");
// the existing read + roadmap surfaces are byte-for-byte unchanged while the op-API is dormant
const tBefore = await getJson("/api/tickets");
ok(tBefore.status === 200 && tBefore.body.length === 1 && tBefore.body[0].id === feat.id, "flag-off: GET /api/tickets unchanged (the read surface still serves)");
ok((await fetch(base + "/")).status === 200, "flag-off: GET / (board) unchanged");
ok((await fetch(base + "/roadmap")).status === 200, "flag-off: GET /roadmap unchanged");

// ═══ opt in: settings_json.hub.transport = "daemon" (read FRESH per request — no restart) ═════════════
const setTransport = (on: boolean) => { const s = openDb(DB); s.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify(on ? { hub: { transport: "daemon" } } : {}), projectId); s.close(); };
const setMode = (mode: string) => { const s = openDb(DB); s.prepare("UPDATE projects SET mode=? WHERE id=?").run(mode, projectId); s.close(); };
setTransport(true);

// ── reads via the op-API mirror the stdio server ──
const li = await op("list_issues", {}, DEV);
ok(li.status === 200 && Array.isArray(li.body) && li.body.length === 1 && li.body[0].id === feat.id, "flag-on: op list_issues → the seeded ticket (mirrors stdio list_issues)");
const liFilt = await op("list_issues", { type: "Bug" }, DEV);
ok(liFilt.status === 200 && liFilt.body.length === 0, "flag-on: op list_issues?type=Bug → filtered (no bugs yet)");
const gi = await op("get_issue", { id: feat.id }, DEV);
ok(gi.status === 200 && gi.body.id === feat.id && Array.isArray(gi.body.comments), "flag-on: op get_issue → the ticket + its comments");

// ── save_comment lands ATTRIBUTED to X-Devloop-Actor (the headline win) ──
const sc = await op("save_comment", { issueId: feat.id, body: "via the op-API as dev" }, DEV);
ok(sc.status === 200 && sc.body.author === "dev" && sc.body.ticket_id === feat.id, "op save_comment (X-Devloop-Actor: dev) → 200, authored by dev");
const giAfter = await call(verifier, "get_issue", { id: feat.id }); // confirm on the STDIO path (cross-path consistency)
ok(giAfter.comments.some((c: any) => c.author === "dev" && c.body === "via the op-API as dev"), "the op-API comment is visible on the stdio path, attributed to dev");
ok(await eventsBy("dev", "comment.add", feat.id), "list_events confirms a comment.add attributed to dev (the X-Devloop-Actor actor)");

// ── save_issue CREATE attributed to a DIFFERENT actor (qa) — multiplexing N agents over one writer ──
const created = await op("save_issue", { title: "Op-filed bug", type: "Bug", labels: ["dev-loop", "Bug", "qa"], priority: 1 }, QA);
ok(created.status === 200 && created.body.created_by === "qa" && created.body.type === "Bug" && created.body.state === "Todo", "op save_issue create (X-Devloop-Actor: qa) → 200, created_by qa, Todo");
const bugId = created.body.id;
ok(await eventsBy("qa", "issue.create", bugId), "list_events confirms issue.create attributed to qa");

// ── save_issue UPDATE: assignee "me" resolves to the HEADER actor; a real transition is attributed ──
const upd = await op("save_issue", { id: feat.id, assignee: "me", state: "In Progress" }, DEV);
ok(upd.status === 200 && upd.body.assignee === "dev" && upd.body.state === "In Progress", `op save_issue update assignee:"me" → resolves to the header actor (dev); state moved (got assignee=${upd.body.assignee})`);
ok(await eventsBy("dev", "issue.transition", feat.id), "list_events confirms issue.transition attributed to dev");
// REPLACE-style labels + APPEND-only relatedTo parity with the stdio server
await op("save_issue", { id: feat.id, labels: ["dev-loop", "Feature", "pm", "x1"], relatedTo: [bugId] }, DEV);
const rel1 = await call(verifier, "get_issue", { id: feat.id });
ok(rel1.labels.includes("x1") && !rel1.labels.includes("env:dev") && rel1.relatedTo.includes(bugId), "op save_issue: labels REPLACE (x1 added) + relatedTo APPEND (bug linked)");
await op("save_issue", { id: feat.id, relatedTo: ["AGP-zzz"] }, DEV); // append a 2nd, the 1st must survive (union)
const rel2 = await call(verifier, "get_issue", { id: feat.id });
ok(rel2.relatedTo.includes(bugId) && rel2.relatedTo.includes("AGP-zzz"), "op save_issue: relatedTo is APPEND-only (the prior link survives a 2nd add)");

// ── list_comments via the op-API ──
const lc = await op("list_comments", { issueId: feat.id }, DEV);
ok(lc.status === 200 && Array.isArray(lc.body) && lc.body.some((c: any) => c.author === "dev"), "op list_comments → the dev-authored comment");

// ═══ DL-62: the doc/event family via the op-API (mirrors server.ts list_events + doc.*) ════════════════
// list_events — the attribution feed (Reflect's window) already holds the attributed writes above; byte-parity with stdio
const ev = await op("list_events", { limit: 200 }, DEV);
const evStdio = await call(verifier, "list_events", { limit: 200 });
ok(ev.status === 200 && Array.isArray(ev.body) && ev.body.some((e: any) => e.actor === "qa" && e.kind === "issue.create"), "op list_events → the attributed feed (qa issue.create present)");
ok(JSON.stringify(ev.body) === JSON.stringify(evStdio), "parity: op list_events ≡ stdio list_events (byte-identical)");

// doc.save (CREATE) attributed to X-Devloop-Actor (pm), a DRAFT via the CAS — never auto-published
const ds = await op("doc.save", { slug: "strat", kind: "strategy", title: "Strategy", body: "v1 body", baseVersion: 0 }, { "x-devloop-actor": "pm" });
ok(ds.status === 200 && ds.body.version === 1 && ds.body.status === "draft", `op doc.save (new) → draft v1 (got ${JSON.stringify(ds.body)})`);
ok((await call(verifier, "doc.history", { slug: "strat" }))[0].author === "pm", "doc.save landed attributed to pm (doc.history on the stdio path — cross-path attribution)");
ok((await call(verifier, "list_events", { limit: 50 })).some((e: any) => e.actor === "pm" && e.kind === "doc.save"), "list_events confirms a doc.save attributed to pm");

// reads mirror the stdio server byte-for-byte
const dg = await op("doc.get", { slug: "strat" }, DEV);
ok(dg.status === 200 && JSON.stringify(dg.body) === JSON.stringify(await call(verifier, "doc.get", { slug: "strat" })) && dg.body.unpublished === true, "parity: op doc.get ≡ stdio doc.get (unpublished draft)");
const dlOp = await op("doc.list", {}, DEV);
ok(dlOp.status === 200 && JSON.stringify(dlOp.body) === JSON.stringify(await call(verifier, "doc.list", {})), "parity: op doc.list ≡ stdio doc.list");
ok(JSON.stringify((await op("doc.history", { slug: "strat" }, DEV)).body) === JSON.stringify(await call(verifier, "doc.history", { slug: "strat" })), "parity: op doc.history ≡ stdio doc.history");

// CAS: a stale baseVersion → 409 CONFLICT (never last-write-wins); a kind-clash at an existing slug → 409 (kind immutable)
const stale = await op("doc.save", { slug: "strat", kind: "strategy", body: "racey", baseVersion: 0 }, { "x-devloop-actor": "pm" });
ok(stale.status === 409 && /CONFLICT/.test(stale.body.error), `op doc.save stale base → 409 CONFLICT (got ${stale.status} ${JSON.stringify(stale.body)})`);
ok((await op("doc.save", { slug: "strat", kind: "notes", body: "x", baseVersion: 1 }, { "x-devloop-actor": "pm" })).status === 409, "op doc.save with a mismatched kind at an existing slug → 409 (a doc's kind is immutable)");

// append a real v2, then doc.diff parity (unified diff over the version bodies)
await op("doc.save", { slug: "strat", kind: "strategy", body: "v2 body", baseVersion: 1 }, { "x-devloop-actor": "pm" });
const diff = await op("doc.diff", { slug: "strat", from: 1, to: 2 }, DEV);
ok(diff.status === 200 && JSON.stringify(diff.body) === JSON.stringify(await call(verifier, "doc.diff", { slug: "strat", from: 1, to: 2 })) && /v1 body/.test(diff.body.fromBody) && /v2 body/.test(diff.body.toBody), "parity: op doc.diff ≡ stdio doc.diff (unified diff over version bodies)");

// operator-publish gate (cooperative role-attribution, §18): a non-operator → 403; the operator → 200 current
const pubByPm = await op("doc.publish", { slug: "strat", version: 2 }, { "x-devloop-actor": "pm" });
ok(pubByPm.status === 403 && /only the operator/.test(pubByPm.body.error), `op doc.publish as pm → 403 (cooperative operator gate; got ${pubByPm.status})`);
const pub = await op("doc.publish", { slug: "strat", version: 2 }, { "x-devloop-actor": "operator" });
ok(pub.status === 200 && pub.body.status === "current" && pub.body.current_version === 2, `op doc.publish as operator → v2 current (got ${JSON.stringify(pub.body)})`);

// doc guards: a ghost slug → 404; a missing version to publish → 404; invalid kind → 400; the CSRF/rebind wall covers doc writes
ok((await op("doc.get", { slug: "nope" }, DEV)).status === 404, "guard: doc.get of a ghost slug → 404");
ok((await op("doc.publish", { slug: "strat", version: 99 }, { "x-devloop-actor": "operator" })).status === 404, "guard: doc.publish of a missing version → 404");
ok((await op("doc.save", { slug: "bad", kind: "bogus", body: "y", baseVersion: 0 }, { "x-devloop-actor": "pm" })).status === 400, "guard: doc.save invalid kind → 400 (mirrors the zod DOC_KINDS enum)");
// the op-API parses raw JSON (no zod) → numeric/string inputs are re-validated by hand to mirror server.ts's schema (a clean 400, never a node:sqlite bind-throw 500 or a synthetic success)
ok((await op("list_events", { limit: "all" }, DEV)).status === 400, "guard: list_events non-integer limit → 400 (not a 500 from a bad LIMIT bind)");
ok((await op("list_events", { limit: 10000 }, DEV)).status === 400, "guard: list_events limit over the cap → 400 (mirrors zod .max(500))");
ok((await op("doc.get", { slug: "strat", version: 0 }, DEV)).status === 400, "guard: doc.get version:0 → 400 (mirrors zod .positive(), not a synthetic empty-doc 200)");
ok((await op("doc.save", { slug: "strat", kind: "strategy", body: "z", baseVersion: 2, title: {} }, { "x-devloop-actor": "pm" })).status === 400, "guard: doc.save non-string title → 400 (not a 500 from an object bound into the INSERT)");
// DL-63: the doc READ handlers re-check slug/kind as strings too (the write path + server.ts zod already do).
// A non-string slug/kind would otherwise bind into resolveDoc and node:sqlite throws → an HTTP 500 echoing the
// raw driver string; each read selector must return a clean 400 (the parity gap DL-62 left on the read path).
ok((await op("doc.get", { slug: {} }, DEV)).status === 400, "guard: doc.get non-string slug → 400 (not a 500 from a node:sqlite bind-throw)");
ok((await op("doc.get", { kind: {} }, DEV)).status === 400, "guard: doc.get non-string kind → 400");
ok((await op("doc.history", { slug: [1] }, DEV)).status === 400, "guard: doc.history non-string slug → 400");
ok((await op("doc.diff", { slug: {}, from: 1, to: 2 }, DEV)).status === 400, "guard: doc.diff non-string slug → 400 (not a bind-throw 500)");
ok((await op("doc.list", { kind: {} }, DEV)).status === 400, "guard: doc.list non-string kind → 400");
// AC #2: the 400 body is a clean message, never the raw node:sqlite "Provided value cannot be bound…" string
const dgBadSlug = await op("doc.get", { slug: {} }, DEV);
ok(dgBadSlug.status === 400 && !/cannot be bound/i.test(JSON.stringify(dgBadSlug.body)), "doc.get non-string slug: a clean 400 body, not the raw 'Provided value cannot be bound' driver string");
ok((await op("doc.save", { slug: "strat", kind: "strategy", body: "csrf", baseVersion: 2 }, { "x-devloop-actor": "pm", origin: "http://evil.example" })).status === 403, "guard: cross-origin doc.save → 403 (CSRF wall covers the doc write)");
ok((await op("doc.publish", { slug: "strat", version: 1 }, { "x-devloop-actor": "operator", host: "evil.example" })).status === 403, "guard: foreign Host doc.publish → 403 (DNS-rebinding wall)");

// ═══ endpoint pipeline guards ═════════════════════════════════════════════════════════════════════════
ok((await op("save_comment", { issueId: feat.id, body: "no actor" }, {})).status === 400, "guard: missing X-Devloop-Actor → 400");
ok((await op("save_comment", { issueId: feat.id, body: "ghost" }, { "x-devloop-actor": "ghost" })).status === 400, "guard: unknown actor 'ghost' → 400 (G1 phantom-actor guard)");
ok((await op("save_comment", { issueId: feat.id, body: "csrf" }, { ...DEV, origin: "http://evil.example" })).status === 403, "guard: cross-origin Origin → 403 (CSRF wall)");
ok((await op("save_comment", { issueId: feat.id, body: "rebind" }, { ...DEV, host: "evil.example" })).status === 403, "guard: foreign Host → 403 (DNS-rebinding wall)");
ok((await op("get_issue", { id: "AGP-999" }, DEV)).status === 404, "guard: get_issue of a ghost → 404");
ok((await op("save_issue", { id: "AGP-999", state: "Done" }, DEV)).status === 404, "guard: update of a missing ticket → 404");
ok((await op("save_issue", { id: feat.id, state: "Bogus" }, DEV)).status === 400, "guard: invalid state → 400 (mirrors the STATES CHECK)");
ok((await op("save_issue", { id: feat.id, assignee: "ghost" }, DEV)).status === 400, "guard: unknown assignee → 400");
ok((await op("save_issue", {}, DEV)).status === 400, "guard: create with no title → 400");
// input-shape guards (the stdio path gets these from zod; the op-API re-checks by hand). A non-array
// labels would otherwise be stored non-array and crash a later list_issues label filter (500 poison-pill).
ok((await op("save_issue", { id: feat.id, labels: "Bug" }, DEV)).status === 400, "guard: non-array labels → 400 (poison-pill prevented)");
ok((await op("save_issue", { id: feat.id, relatedTo: "AGP-1" }, DEV)).status === 400, "guard: non-array relatedTo → 400");
ok((await op("save_issue", { title: "p", priority: 9 }, DEV)).status === 400, "guard: out-of-range priority → 400 (mirrors zod int 0..4)");
// reads still serve after the rejected poison-pill writes (no corrupt labels landed → no 500)
ok((await op("list_issues", { label: "pm" }, DEV)).status === 200, "post-guard: list_issues?label=pm still 200 (no corrupt labels row poisoned the filter)");
ok((await op("bogus_op", {}, DEV)).status === 404, "guard: unknown op name → 404");

// ── the CSRF/rebinding refusals + the bad writes created NO comment/ticket (no mutation slipped through) ──
const cntAfterGuards = (await getJson("/api/tickets")).body.length;
ok(cntAfterGuards === 2, "no refused/invalid write mutated state (still exactly the seed Feature + the qa Bug)");

// ═══ honor `mode` server-side: a WRITE under dry-run is refused; reads are NOT gated (design Decision #4) ═══
setMode("dry-run");
const commentsBeforeDry = (await op("list_comments", { issueId: feat.id }, DEV)).body.length;
ok((await op("save_comment", { issueId: feat.id, body: "should be refused" }, DEV)).status === 403, "mode: a WRITE op under dry-run → 403 (mode honored server-side)");
ok((await op("list_issues", {}, DEV)).status === 200, "mode: a READ op under dry-run still serves (reads are never mode-gated)");
ok((await op("list_comments", { issueId: feat.id }, DEV)).body.length === commentsBeforeDry, "mode: the refused dry-run write wrote NOTHING (comment count unchanged)");
// DL-62: a doc WRITE is mode-gated server-side too (doc.save ∈ AGENT_WRITE_OPS); the refused write appends nothing
const docHistBeforeDry = (await call(verifier, "doc.history", { slug: "strat" })).length;
ok((await op("doc.save", { slug: "strat", kind: "strategy", body: "dry-run draft", baseVersion: 2 }, { "x-devloop-actor": "pm" })).status === 403, "mode: a doc.save under dry-run → 403 (doc write mode-gated server-side too)");
ok((await call(verifier, "doc.history", { slug: "strat" })).length === docHistBeforeDry, "mode: the refused dry-run doc.save appended NO new version");
setMode("live");
ok((await op("save_comment", { issueId: feat.id, body: "live again" }, DEV)).status === 200, "mode: flipping back to live → the write succeeds again (read fresh per request)");

// ═══ back-compat: the stdio path is byte-for-byte unaffected — a stdio save_comment still lands ═══════════
const stdioComment = await call(pm, "save_comment", { issueId: feat.id, body: "stdio still works" });
ok(stdioComment.author === "pm", "back-compat: the stdio MCP save_comment still works (server.ts untouched)");

// ═══ live toggle OFF → the mount goes dormant again (404); read surfaces stay up ═════════════════════════
setTransport(false);
ok((await op("list_issues", {}, DEV)).status === 404, "flag-off (live toggle): op list_issues → 404 again (dormant)");
ok((await op("save_comment", { issueId: feat.id, body: "nope" }, DEV)).status === 404, "flag-off (live toggle): op save_comment → 404 again");
ok((await op("doc.list", {}, DEV)).status === 404, "flag-off (live toggle): op doc.list → 404 again (the doc family goes dormant with the flag)");
ok((await getJson("/api/tickets")).status === 200, "flag-off (live toggle): GET /api/tickets still serves (read surface unchanged)");

await pm.close();
await verifier.close();
server.close(); rdb.close(); wdb.close();

console.log(fails === 0 ? "\nAGENT_API_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
