// LOOP-52: regression tests for board identity affordance + stale-version warning + hub status port.
//
// Test A — stale daemon: a createDaemon with daemonVersion:"0.0.1" must render the stale warning
//           on every board page; a default daemon (no override) must NOT render it.
// Test B — hub status port: daemonStatusAll() output must include the non-default port the daemon
//           is listening on (regresses the "hub status always reports _team" gap).
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";
import { daemonStatusAll } from "../src/daemon-lifecycle.ts";

const BASE_DIR = "/tmp/hub-identity-test";
const DB = `${BASE_DIR}/hub.db`;
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }
mkdirSync(BASE_DIR, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

execFileSync("node", ["src/seed.ts", "idp", "Identity Project", "IDP", DB], { encoding: "utf8" });
const db = openDb(DB);
db.exec("PRAGMA query_only=ON");
const projectId = findProject(db, "idp")!;

async function getHtml(base: string, path: string): Promise<{ status: number; text: string }> {
  const r = await fetch(base + path);
  return { status: r.status, text: await r.text() };
}

// ─── Test A1: stale daemon → ws-bar-warn + "OLD code" on board page ─────────────
const staleSrv = createDaemon({ db, projectId, projectKey: "idp", daemonVersion: "0.0.1" });
staleSrv.listen(0, "127.0.0.1");
await once(staleSrv, "listening");
const stalePort = (staleSrv.address() as { port: number }).port;
const staleBase = `http://127.0.0.1:${stalePort}`;

const stalePage = await getHtml(staleBase, "/p/idp/");
ok(stalePage.status === 200, "stale daemon: GET /p/idp/ returns 200");
ok(stalePage.text.includes("OLD code"), "stale daemon: board page contains stale marker 'OLD code'");
ok(stalePage.text.includes("0.0.1"), "stale daemon: board page shows old daemon version 0.0.1");
ok(stalePage.text.includes('class="ws-bar ws-bar-warn"'), "stale daemon: ws-bar element carries the warning CSS class");
staleSrv.close();

// ─── Test A2: current daemon → ws-bar present, NO stale warning ─────────────────
const freshSrv = createDaemon({ db, projectId, projectKey: "idp" });
freshSrv.listen(0, "127.0.0.1");
await once(freshSrv, "listening");
const freshPort = (freshSrv.address() as { port: number }).port;
const freshBase = `http://127.0.0.1:${freshPort}`;

const freshPage = await getHtml(freshBase, "/p/idp/");
ok(freshPage.status === 200, "fresh daemon: GET /p/idp/ returns 200");
ok(!freshPage.text.includes("OLD code"), "fresh daemon: board page does NOT show stale 'OLD code' warning");
ok(freshPage.text.includes('class="ws-bar"') && !freshPage.text.includes('class="ws-bar ws-bar-warn"'),
  "fresh daemon: ws-bar uses normal (non-warn) CSS class");

// ─── Test B: daemonStatusAll() output includes the non-default port ──────────────
const RUN_DIR = join(BASE_DIR, "run");
mkdirSync(RUN_DIR, { recursive: true });

// Write a runfile pointing at freshSrv — the in-process daemon is alive and will answer /api/health
writeFileSync(join(RUN_DIR, "daemon-idp.json"), JSON.stringify({
  project: "idp", pid: process.pid, port: freshPort, host: "127.0.0.1",
  url: `http://127.0.0.1:${freshPort}`, startedAt: new Date().toISOString(),
  version: "1.11.0", actor: "operator",
}));

const origRunDir = process.env.DEVLOOP_RUN_DIR;
process.env.DEVLOOP_RUN_DIR = RUN_DIR;

const captured: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
await daemonStatusAll();
console.log = origLog;
if (origRunDir === undefined) delete process.env.DEVLOOP_RUN_DIR;
else process.env.DEVLOOP_RUN_DIR = origRunDir;

const statusOut = captured.join("\n");
ok(statusOut.includes(String(freshPort)), `hub status: output includes the non-default port ${freshPort}`);
ok(statusOut.includes("RUNNING"), "hub status: output reports daemon as RUNNING");
ok(statusOut.includes("idp"), "hub status: output names the project key 'idp'");

freshSrv.close();
db.close();

console.log(fails === 0 ? "\nIDENTITY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
