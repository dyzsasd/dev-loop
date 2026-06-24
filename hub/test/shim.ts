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

  // ═══ port discovery via a DEVLOOP_HUB_PORT OVERRIDE (no runfile present) — proves 8787 is not hardcoded ════
  const overrideShim = await shim({ DEVLOOP_ACTOR: "dev", DEVLOOP_RUN_DIR: EMPTY_RUN, DEVLOOP_HUB_PORT: String(port) });
  const ovli = await call(overrideShim, "list_issues", {});
  ok(Array.isArray(ovli) && ovli.length >= 1, "DEVLOOP_HUB_PORT override (no runfile) → discovers the live daemon (port not hardcoded)");

  // ═══ FAILURE MODE 1 — the op-API is dormant (hub.transport off → 404) → a clear, actionable MCP error ═════
  setTransport(false);
  const dormant = await callRaw(devShim, "list_issues", {});
  ok(dormant.isError && /dormant/i.test(dormant.text) && /hub\.transport/.test(dormant.text), `dormant op-API → clear MCP error naming hub.transport (got ${JSON.stringify(dormant.text)})`);
  ok(!/not found:/.test(dormant.text), "dormant error is the actionable hint, not a raw 'not found' passthrough");
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
