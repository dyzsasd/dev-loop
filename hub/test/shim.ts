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

// seed the project + the 8 agents + operator (ensureActors in seed.ts → dev/qa/pm/operator all exist)
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

  // ═══ (DL-64) the discussion-board family through the shim — proxied to the widened op-API ═════════════════
  // topic.open as the chair (pm), attributed; an invited actor (dev) posts; differential parity + the §25 gates.
  const topOpen = await call(pmShim, "topic.open", { question: "Ship X now?", invited: ["dev"] });
  ok(topOpen.opened_by === "pm" && topOpen.status === "open" && topOpen.round === 1 && (topOpen.invited as string[]).includes("dev"), `shim topic.open (DEVLOOP_ACTOR=pm) → chair pm, open, round 1 (got ${JSON.stringify(topOpen)})`);
  const topId = topOpen.id;
  ok((await call(pm, "list_events", { limit: 50 })).some((e: any) => e.actor === "pm" && e.kind === "topic.open"), "list_events (stdio) confirms the shim's topic.open attributed to pm");
  const post = await call(devShim, "post.add", { topicId: topId, body: "dev's take" });
  ok(post.author === "dev" && post.kind === "perspective" && post.round === 1, `shim post.add (DEVLOOP_ACTOR=dev, invited) → attributed to dev, round 1 (got ${JSON.stringify(post)})`);
  ok((await call(pm, "list_events", { limit: 50 })).some((e: any) => e.actor === "dev" && e.kind === "post.add"), "list_events (stdio) confirms the shim's post.add attributed to dev (Director board now works on the shim)");
  // differential parity: topic.get/topic.list via the shim ≡ the direct-db server (byte-identical)
  ok(JSON.stringify(await call(devShim, "topic.get", { id: topId })) === JSON.stringify(await call(pm, "topic.get", { id: topId })), "differential parity: shim topic.get ≡ stdio topic.get (the topic + its posts)");
  ok(JSON.stringify(await call(pmShim, "topic.list", {})) === JSON.stringify(await call(pm, "topic.list", {})), "differential parity: shim topic.list ≡ stdio topic.list");
  // the §25 cooperative gates over the shim: a non-invited actor can't post; a non-chair can't close; the chair can
  const postQa = await callRaw(qaShim, "post.add", { topicId: topId, body: "qa intrudes" });
  ok(postQa.isError && /not invited/.test(postQa.text), `shim post.add by a non-invited actor (qa) → rejected (got ${postQa.text})`);
  const closeQa = await callRaw(qaShim, "topic.close", { topicId: topId, decision: "qa decides" });
  ok(closeQa.isError && /only the chair/.test(closeQa.text), `shim topic.close by a non-chair (qa) → rejected (cooperative chair gate; got ${closeQa.text})`);
  const closed = await call(pmShim, "topic.close", { topicId: topId, decision: "Ship it." });
  ok(closed.status === "closed" && closed.decision === "Ship it.", `shim topic.close by the chair (pm) → closed with the decision (got ${JSON.stringify(closed)})`);
  const postClosed = await callRaw(devShim, "post.add", { topicId: topId, body: "too late" });
  ok(postClosed.isError && /closed/.test(postClosed.text), "shim post.add into a closed topic → rejected (CONFLICT)");

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
  const dormantTopic = await callRaw(pmShim, "topic.list", {}); // DL-64: the board family gets the SAME clear dormant hint
  ok(dormantTopic.isError && /dormant/i.test(dormantTopic.text) && /hub\.transport/.test(dormantTopic.text), "dormant op-API → the board family gets the same clear hint (topic.list)");
  const dormantChan = await callRaw(devShim, "channel.status", {}); // DL-67: the channel family gets the SAME clear dormant hint
  ok(dormantChan.isError && /dormant/i.test(dormantChan.text) && /hub\.transport/.test(dormantChan.text), "dormant op-API → the channel family gets the same clear hint (channel.status)");
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
  const topicDown = await callRaw(downShim, "topic.get", { id: "nope" }); // DL-64: the board ops share proxy() → the same clear error
  ok(topicDown.isError && /not reachable/i.test(topicDown.text), "daemon-down → the board ops get the same clear 'not reachable' error (shared proxy())");
  const chanDown = await callRaw(downShim, "channel.status", {}); // DL-67: the channel ops share proxy() → the same clear error
  ok(chanDown.isError && /not reachable/i.test(chanDown.text), "daemon-down → the channel ops get the same clear 'not reachable' error (shared proxy())");

  // ═══ back-compat: the stdio server path is byte-for-byte unaffected (server.ts untouched by DL-55) ═══════
  const stdioComment = await call(pm, "save_comment", { issueId: feat.id, body: "stdio still works" });
  ok(stdioComment.author === "pm", "back-compat: the direct-db stdio save_comment still works (server.ts untouched)");
} catch (e) {
  ok(false, `unexpected throw mid-suite: ${(e as Error).message}`); // record it, then fall through to guaranteed cleanup
} finally {
  for (const c of clients) { try { await c.close(); } catch {} } // tear down EVERY spawned MCP subprocess
  try { server?.close(); } catch {}
  try { rdb?.close(); } catch {}
  try { wdb?.close(); } catch {}
}

console.log(fails === 0 ? "\nSHIM_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
