// DL-41 — idempotent per-project daemon lifecycle (`dev-loop-hub daemon up|down|status`).
// Spawns the REAL `node src/daemon.ts <sub>` against an ISOLATED temp DB + run dir (never the operator's
// ~/.dev-loop), and asserts: cold `up` starts a detached, healthy, 127.0.0.1-bound daemon + writes a
// runfile; a second `up` no-ops (single process); `status` reports RUNNING; a stale (dead-pid) runfile
// does NOT read as running and `up` cleanly restarts on the SAME recorded port; `down` stops + clears;
// and a non-service / unknown / unresolved project is a clean no-op + exit 0 (never an error).
import { spawnSync, execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/hub-lifecycle";
const DB = join(ROOT, "hub.db");
const RUN = join(ROOT, "run");
const PROJ = "lcyc";
const NODE = process.env.DEVLOOP_NODE || process.execPath;
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = (key = PROJ): string => join(RUN, `daemon-${key}.json`);
const readRun = (key = PROJ): { project: string; pid: number; port: number; host: string; url: string } => JSON.parse(readFileSync(runfile(key), "utf8"));
async function untilDead(pid: number): Promise<void> { for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(100); }

// seed a service project into the ISOLATED temp DB (ensureActors seeds the `operator` actor the daemon needs)
execFileSync(NODE, ["src/seed.ts", PROJ, "Lifecycle Project", "LC", DB], { encoding: "utf8" });

function lc(sub: string, extra: Record<string, string> = {}) {
  return spawnSync(NODE, ["src/daemon.ts", sub], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator", ...extra },
  });
}

try {
  // ── cold `up` → starts a detached, healthy, localhost-bound daemon + runfile ──
  const up1 = lc("up");
  ok(up1.status === 0, `up (cold) → exit 0 (got ${up1.status})${up1.stderr ? "\n   stderr: " + up1.stderr : ""}`);
  ok(existsSync(runfile()), "up writes the per-project runfile");
  const r1 = readRun();
  ok(r1.project === PROJ && r1.pid > 0 && r1.port >= 8787, "runfile records project + pid + the fixed-default/probed port");
  ok(r1.host === "127.0.0.1" && r1.url.startsWith("http://127.0.0.1:"), "daemon binds 127.0.0.1 ONLY — never 0.0.0.0 (§16)");
  ok(isAlive(r1.pid), "the spawned daemon process is alive (detached, survives the `up` command)");
  const h1 = await fetch(`${r1.url}/api/health`).then((x) => x.json()).catch(() => null) as { ok?: boolean; project?: string } | null;
  ok(!!h1 && h1.ok === true && h1.project === PROJ, "the live daemon serves /api/health for this project");
  const board = await fetch(r1.url + "/").then((x) => x.text()).catch(() => "");
  ok(board.includes("<!doctype html") && board.includes('class="board"'), "GET / renders the web-UI board (the surface the auto-start delivers)");

  // ── a second `up` no-ops: same single process, no EADDRINUSE ──
  const up2 = lc("up");
  ok(up2.status === 0, `up (second) → exit 0 (got ${up2.status})`);
  ok(up2.stdout.includes("already running"), "second up reports 'already running' (never double-starts)");
  ok(readRun().pid === r1.pid, "second up did NOT spawn a new process — same pid (one daemon per project)");

  // ── `ensure` is an accepted alias for `up` (the design's `daemon ensure`) ──
  const ens = lc("ensure");
  ok(ens.status === 0 && ens.stdout.includes("already running") && readRun().pid === r1.pid, "`ensure` aliases `up` (idempotent no-op when already running)");

  // ── `status` reports RUNNING + the URL ──
  const st1 = lc("status");
  ok(st1.status === 0 && /RUNNING/.test(st1.stdout) && st1.stdout.includes(r1.url), "status → RUNNING + the URL");

  // ── a stale (dead-pid) runfile must NOT read as running; `up` cleanly restarts on the SAME port ──
  process.kill(r1.pid, "SIGKILL");
  await untilDead(r1.pid);
  ok(!isAlive(r1.pid), "simulated a crash (killed the daemon) — the runfile pid is now stale");
  const up3 = lc("up");
  ok(up3.status === 0 && !up3.stdout.includes("already running"), "up on a stale dead-pid runfile does NOT falsely no-op — it restarts");
  const r3 = readRun();
  ok(r3.pid !== r1.pid && isAlive(r3.pid), "up restarted a fresh, live daemon (new pid) over the stale runfile");
  ok(r3.port === r1.port, "the recorded port is stable across restarts");
  ok(!!(await fetch(`${r3.url}/api/health`).then((x) => x.json()).catch(() => null)), "the restarted daemon is healthy");

  // ── `status` on a dead-pid runfile → 'stopped' (not a false RUNNING) and clears the stale runfile ──
  process.kill(r3.pid, "SIGKILL");
  await untilDead(r3.pid);
  const st2 = lc("status");
  ok(st2.status === 0 && /stopped/.test(st2.stdout) && /dev-loop daemon up/.test(st2.stdout),
    "status on a dead-pid runfile → 'stopped' + the `dev-loop daemon up` recovery hint (DL-87)");
  ok(!existsSync(runfile()), "status cleared the stale (dead-pid) runfile");

  // ── `down` stops the process + clears the runfile; a second `down` is a clean no-op ──
  const up4 = lc("up");
  ok(up4.status === 0, "re-up (for the down test) → exit 0");
  const r4 = readRun();
  const dn = lc("down");
  ok(dn.status === 0, "down → exit 0");
  await untilDead(r4.pid);
  ok(!isAlive(r4.pid), "down stopped the daemon process");
  ok(!existsSync(runfile()), "down cleared the runfile");
  const dn2 = lc("down");
  ok(dn2.status === 0 && /no daemon recorded/.test(dn2.stdout), "down again → clean no-op (exit 0)");
  ok(lc("status").stdout.includes("stopped"), "status after down → stopped");

  // ── the `dev-loop-hub daemon <sub>` form (via server.ts, the bin) delegates to the SAME lifecycle ──
  const via = (args: string[]) => spawnSync(NODE, ["src/server.ts", ...args], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator" },
  });
  const viaUp = via(["daemon", "up"]);
  ok(viaUp.status === 0 && existsSync(runfile()), "`server.ts daemon up` (the bin form) delegates to the lifecycle → starts");
  ok(via(["daemon", "status"]).stdout.includes("RUNNING"), "`server.ts daemon status` → RUNNING (shared runfile)");
  ok(via(["daemon", "down"]).status === 0 && !existsSync(runfile()), "`server.ts daemon down` → stops + clears");
  ok(via(["daemon", "frobnicate"]).status === 2, "`server.ts daemon <bogus>` → usage error exit 2 (never falls through to the MCP boot)");

  // ── machine-level autostart target: `up-all` starts configured service projects without DEVLOOP_PROJECT ──
  const serviceCfg = join(ROOT, "service-projects.json");
  writeFileSync(serviceCfg, JSON.stringify({ projects: { [PROJ]: { backend: "service", repoPath: ROOT }, other: { backend: "linear", repoPath: ROOT } } }));
  const upAll = spawnSync(NODE, ["src/daemon.ts", "up-all"], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: serviceCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" },
  });
  ok(upAll.status === 0 && existsSync(runfile()) && /started|already running/.test(upAll.stdout),
    "`daemon up-all` starts configured backend:\"service\" projects without DEVLOOP_PROJECT");
  ok(lc("down").status === 0 && !existsSync(runfile()), "`daemon down` stops the daemon started by up-all");

  // ── a non-service / UNKNOWN project (not seeded in the hub) → no-op + exit 0, no daemon ──
  const ghost = lc("up", { DEVLOOP_PROJECT: "ghostproj" });
  ok(ghost.status === 0, "up for an unknown/non-service project → exit 0 (never an error)");
  ok(/nothing to start/.test(ghost.stdout), "up for an unknown project no-ops ('nothing to start')");
  ok(!existsSync(runfile("ghostproj")), "no runfile / no daemon created for the unknown project");

  // ── no DEVLOOP_PROJECT + an UNRESOLVABLE cwd (empty projects.json) → no-op + exit 0 ──
  const emptyCfg = join(ROOT, "empty-projects.json");
  writeFileSync(emptyCfg, JSON.stringify({ projects: {} }));
  const unresolved = spawnSync(NODE, ["src/daemon.ts", "up"], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: emptyCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" },
  });
  ok(unresolved.status === 0 && /no project resolved/.test(unresolved.stdout), "up with no DEVLOOP_PROJECT and an unresolvable cwd → no-op exit 0");

  // ── DL-87: `status` with no resolvable project → exit 0 + the no-project line carries a fix hint ──
  const statusUnresolved = spawnSync(NODE, ["src/daemon.ts", "status"], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: emptyCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" },
  });
  ok(statusUnresolved.status === 0 && /no project resolved/.test(statusUnresolved.stdout) && /DEVLOOP_PROJECT|inside a configured repo/.test(statusUnresolved.stdout),
    "status with no resolvable project → exit 0 + a fix hint (set DEVLOOP_PROJECT / run from a repo) (DL-87)");
} finally {
  // never leak a detached daemon: kill anything still recorded, then drop the temp tree
  for (const key of [PROJ, "ghostproj"]) { try { if (existsSync(runfile(key))) { const p = readRun(key).pid; if (isAlive(p)) process.kill(p, "SIGKILL"); } } catch { /* best-effort */ } }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nLIFECYCLE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
