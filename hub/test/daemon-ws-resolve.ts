// LOOP-185 regression: bare daemon up/down/status verbs resolve the workspace run dir so a daemon
// that `hub status` lists is reachable in a shell without ambient DEVLOOP_RUN_DIR. Before the fix,
// `daemon down` returned "no daemon recorded" for a live runfile, and `daemon status` showed "stopped".
import { spawnSync } from "node:child_process";
import { createServer as netCreateServer } from "node:net";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDaemonPid, runDaemonCli } from "./daemon-harness.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.env.DEVLOOP_NODE || process.execPath;
const ROOT = `/tmp/dl-ws-resolve-${process.pid}`;
const WS_KEY = "wsr";
const PROJ = "wsrproj";
const WS_DB = join(ROOT, ".dev-loop", "hub.db");
const WS_RUN = join(ROOT, ".dev-loop");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = () => join(WS_RUN, `daemon-${PROJ}.json`);
const readPid = () => (JSON.parse(readFileSync(runfile(), "utf8")) as { pid: number }).pid;

// Acquire an ephemeral port outside the 8787-band so the test daemon never collides with a live workspace daemon.
const TEST_PORT = await new Promise<number>((res, rej) => {
  const s = netCreateServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address() as import("node:net").AddressInfo;
    s.close(() => res(port));
  });
});

// lc(): invoke `node src/daemon.ts <sub>` with a fire-marker-scrubbed env + caller-supplied overrides.
// Caller controls exactly which DEVLOOP_* vars are present — no ambient leakage.
// rawEnv:true prevents runDaemonCli from re-merging process.env (which would reintroduce fire markers).
function lc(sub: string, extra: Record<string, string | undefined> = {}) {
  const env = { ...scrubFireEnv(), DEVLOOP_ACTOR: "operator", ...extra };
  return runDaemonCli("daemon", sub, env, { timeout: 30_000, rawEnv: true });
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

try {
  // ── Setup: create workspace + project (seeds WS_DB) ─────────────────────────
  // team init and add-project run from a clean env so the workspace CLI writes to the right DB.
  const cli = (...args: string[]) => spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 30_000,
    env: { ...scrubFireEnv() } as NodeJS.ProcessEnv,
  });
  const init = spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "team", "init",
    "--dir", ROOT, "--key", WS_KEY, "--backend", "service", "--yes"],
    { cwd: "/tmp", encoding: "utf8", timeout: 30_000, env: { ...scrubFireEnv() } as NodeJS.ProcessEnv });
  ok(init.status === 0, `setup: team init exits 0 (got ${init.status}: ${(init.stderr ?? "").split("\n")[0]})`);

  const addProj = cli("team", "add-project", PROJ, "--prefix", "WSR");
  ok(addProj.status === 0, `setup: add-project exits 0 (got ${addProj.status}: ${(addProj.stderr ?? "").split("\n")[0]})`);
  ok(existsSync(WS_DB), "setup: workspace hub.db exists");

  // ── Setup: start daemon with explicit env (runfile lands in WS_RUN) ──────────
  // With both DEVLOOP_RUN_DIR and DEVLOOP_HUB_DB set, resolveDaemonContext() returns early — so
  // the explicit values are honored and the runfile goes exactly where we intend.
  const up1 = lc("up", { DEVLOOP_HUB_DB: WS_DB, DEVLOOP_RUN_DIR: WS_RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_DAEMON_PORT: String(TEST_PORT) });
  ok(up1.status === 0, `setup: daemon up with explicit env → exit 0 (got ${up1.status}${up1.stderr ? ": " + up1.stderr.trim() : ""})`);
  ok(existsSync(runfile()), "setup: runfile written to workspace .dev-loop");
  if (existsSync(runfile())) registerDaemonPid(readPid());

  // ── AC2: daemon status WITHOUT DEVLOOP_RUN_DIR reports RUNNING (LOOP-152 repro) ──
  // DEVLOOP_WORKSPACE=ROOT → resolveDaemonContext resolves the workspace run dir;
  // DEVLOOP_RUN_DIR is absent → the fill-in fires.
  const status1 = lc("status", { DEVLOOP_WORKSPACE: ROOT, DEVLOOP_PROJECT: PROJ });
  ok(status1.status === 0, "status without DEVLOOP_RUN_DIR → exit 0");
  ok(/RUNNING/.test(status1.stdout),
    `AC2: daemon status resolves workspace run dir → RUNNING (was: stopped before fix); got: ${status1.stdout.trim()}`);

  // ── AC1: daemon down WITHOUT DEVLOOP_RUN_DIR stops the daemon (LOOP-152 repro) ──
  const down1 = lc("down", { DEVLOOP_WORKSPACE: ROOT, DEVLOOP_PROJECT: PROJ });
  ok(down1.status === 0, "down without DEVLOOP_RUN_DIR → exit 0");
  ok(!/no daemon recorded/.test(down1.stdout),
    `AC1: daemon down finds the workspace daemon (was: 'no daemon recorded' before fix); got: ${down1.stdout.trim()}`);
  ok(!existsSync(runfile()), "down cleared the runfile");

  const status2 = lc("status", { DEVLOOP_WORKSPACE: ROOT, DEVLOOP_PROJECT: PROJ });
  ok(/stopped/.test(status2.stdout), "status after down → stopped");

  // ── AC3: daemon up via workspace resolution succeeds (reads the workspace hub.db) ───
  // With DEVLOOP_WORKSPACE set and no explicit DEVLOOP_HUB_DB, resolveDaemonContext fills in the
  // workspace hub.db → the seeded project is found → daemon starts (not "nothing to start").
  const up2 = lc("up", { DEVLOOP_WORKSPACE: ROOT, DEVLOOP_PROJECT: PROJ, DEVLOOP_DAEMON_PORT: String(TEST_PORT) });
  ok(up2.status === 0, `AC3: daemon up with only DEVLOOP_WORKSPACE → exit 0 (got ${up2.status}${up2.stderr ? ": " + up2.stderr.trim() : ""})`);
  ok(!/nothing to start/.test(up2.stdout), "AC3: project found in workspace hub.db (not 'nothing to start' — seeded correctly)");
  ok(existsSync(runfile()), "AC3: runfile written via workspace-resolved run dir");
  if (existsSync(runfile())) registerDaemonPid(readPid());
  // Tear down
  lc("down", { DEVLOOP_WORKSPACE: ROOT, DEVLOOP_PROJECT: PROJ });

  // ── AC6 (Precedence): explicit DEVLOOP_RUN_DIR beats workspace resolution ─────
  // Start a daemon in the workspace run dir, then query with a DIFFERENT explicit run dir.
  // resolveDaemonContext must NOT overwrite DEVLOOP_RUN_DIR when it is already set.
  const up3 = lc("up", { DEVLOOP_HUB_DB: WS_DB, DEVLOOP_RUN_DIR: WS_RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_DAEMON_PORT: String(TEST_PORT) });
  ok(up3.status === 0, "setup (precedence): daemon up with explicit dirs → exit 0");
  if (existsSync(runfile())) registerDaemonPid(readPid());

  const altRunDir = join(ROOT, "alt-run");
  mkdirSync(altRunDir, { recursive: true });
  // Query with BOTH DEVLOOP_WORKSPACE and an explicit DEVLOOP_RUN_DIR pointing elsewhere.
  // The explicit DEVLOOP_RUN_DIR must win: daemon is NOT in altRunDir → reports stopped/not-found.
  const explicitStatus = lc("status", {
    DEVLOOP_WORKSPACE: ROOT, DEVLOOP_RUN_DIR: altRunDir,
    DEVLOOP_PROJECT: PROJ,
  });
  ok(/stopped/.test(explicitStatus.stdout) || /not recorded/.test(explicitStatus.stdout),
    "AC6: explicit DEVLOOP_RUN_DIR takes precedence over workspace (daemon not found in alt-run dir)");

  // Tear down the up3 daemon (use explicit dirs since altRunDir doesn't hold the runfile)
  lc("down", { DEVLOOP_HUB_DB: WS_DB, DEVLOOP_RUN_DIR: WS_RUN, DEVLOOP_PROJECT: PROJ });

  // ── AC4: no workspace resolves → fallback to ambient behavior, no throw ───────
  // cwd is /tmp (no dev-loop.json), no DEVLOOP_WORKSPACE → tryResolveWorkspace returns null →
  // resolveDaemonContext returns cleanly → ambient env used (daemon not found → 'stopped').
  // cwd:/tmp avoids resolving the loop workspace when running inside the checkout locally.
  const noWsFallback = runDaemonCli("daemon", "status",
    { ...scrubFireEnv(), DEVLOOP_ACTOR: "operator", DEVLOOP_PROJECT: PROJ },
    { timeout: 10_000, cwd: "/tmp", rawEnv: true },
  );
  ok(noWsFallback.status === 0, "AC4: no workspace → daemon status exits 0 (no crash, today's behavior)");
  ok(/stopped|no project/.test(noWsFallback.stdout), "AC4: daemon not found in machine-default run dir → 'stopped' (graceful fallback)");

} finally {
  try {
    if (existsSync(runfile())) {
      const pid = readPid();
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  } catch { /* best-effort */ }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nDAEMON_WS_RESOLVE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
