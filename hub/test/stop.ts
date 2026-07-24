// `dev-loop stop` + the teamMain config-integrity guard — the two 1.6.0 surfaces the 1.7.0
// quality self-audit caught at 0% coverage (stop.ts on the N/A list; the persistent tick's
// PAUSING/resume path never exercised because every scheduler test runs --once).
// One persistent scheduler serves both: Part B corrupts dev-loop.json mid-run (expect PAUSE),
// restores it (expect resume), then Part C stops that live scheduler through the real verb.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "dl-stop-"));
const ws = join(tmp, "workspace");
const lockPath = join(ws, ".dev-loop", "locks", "run.lock");
// Box, not a bare let: every assignment happens inside a closure, and TS's narrowing would
// otherwise pin the outer reads to `null`. Property mutation dodges that cleanly.
const box: { sched: ChildProcess | null } = { sched: null };

// ASYNC on purpose: Part C stops a scheduler that is THIS process's child. A spawnSync here
// blocks the event loop, the exited child can't be reaped, and `kill(pid, 0)` stays true for
// the zombie forever — stop would "fail". Real deployments never have that parent/child tie.
const runStop = (cwd: string): Promise<{ code: number; out: string }> => new Promise((res) => {
  const c = spawn("node", [join(hubRoot, "src", "stop.ts")], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d.toString(); });
  c.stderr.on("data", (d) => { out += d.toString(); });
  c.on("close", (code) => res({ code: code ?? -1, out }));
});

try {
  // Minimal valid v2 workspace: backend "linear" with linearTeam filled (E09) — the one backend
  // whose teamMain needs neither a hub seed nor an ensureHub daemon, so the persistent scheduler
  // in Part B runs pure. The opencode stub answers `models` (preflight) and `run`.
  mkdirSync(join(ws, "repo"), { recursive: true });
  mkdirSync(join(ws, ".dev-loop"), { recursive: true });
  writeFileSync(join(ws, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "stop-team", backend: "linear", linearTeam: "Stop Team" },
    repos: { r: { path: "repo" } },
    projects: { p: { repos: [{ ref: "r", role: "primary" }] } },
  }, null, 2));
  const good = readFileSync(join(ws, "dev-loop.json"), "utf8");
  const stub = join(tmp, "stub-opencode");
  writeFileSync(stub, `#!/bin/sh
[ "$1" = "models" ] && { echo "stub/m"; exit 0; }
echo "stub fire ok"
exit 0
`);
  chmodSync(stub, 0o755);

  // ── A. stop with nothing to stop ──────────────────────────────────────────────────────────────
  const bare = await runStop(tmp);
  ok(bare.code === 2 && /no workspace/.test(bare.out), `A1 no workspace → exit 2 (got ${bare.code}: ${bare.out.trim().slice(0, 60)})`);
  const idle = await runStop(ws);
  ok(idle.code === 0 && /no scheduler running/.test(idle.out), `A2 workspace without a run lock → exit 0 'no scheduler running' (got ${idle.code})`);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, startedAt: "2026-01-01T00:00:00Z" }));
  const stale = await runStop(ws);
  ok(stale.code === 0 && /stale run lock/.test(stale.out) && !existsSync(lockPath),
    `A3 stale lock (dead pid) → removed, exit 0 (got ${stale.code}, lock ${existsSync(lockPath) ? "STILL THERE" : "gone"})`);

  // ── B. persistent scheduler + the config-integrity guard ──────────────────────────────────────
  let captured = "";
  await (async () => {
    box.sched = spawn("node", [join(hubRoot, "src", "run-agents.ts"), "--cli", "opencode", "--agents", "pm",
      "--interval", "pm=2s", "--stagger", "0"], {
      cwd: ws, env: { ...process.env, DEVLOOP_OPENCODE_BIN: stub }, stdio: ["ignore", "pipe", "pipe"] });
    box.sched.stdout!.on("data", (d) => { captured += d.toString(); });
    box.sched.stderr!.on("data", (d) => { captured += d.toString(); });
    const waitFor = async (re: RegExp, ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      while (Date.now() < until) { if (re.test(captured)) return true; await sleep(200); }
      return false;
    };
    ok(await waitFor(/pm: start \(opencode\)/, 20_000), "B1 persistent scheduler fires the stub (workspace/team mode)");
    ok(existsSync(lockPath), "B2 the team run lock exists while running");

    writeFileSync(join(ws, "dev-loop.json"), good.slice(0, good.length - 20)); // truncate = invalid JSON
    ok(await waitFor(/INVALID JSON .* PAUSING all fires/s, 15_000), "B3 corrupt dev-loop.json → the tick guard PAUSES spawning, loudly");
    const pausedAt = captured.length;
    await sleep(4_500); // two pm intervals while broken
    ok(!/pm: start \(opencode\)/.test(captured.slice(pausedAt)), "B4 no new fire spawns while the config is broken");

    writeFileSync(join(ws, "dev-loop.json"), good);
    ok(await waitFor(/parses again — resuming fires/, 15_000), "B5 restored config → the guard resumes by itself");
    const resumedAt = captured.length;
    const resumedFire = await (async () => {
      const until = Date.now() + 12_000;
      while (Date.now() < until) { if (/pm: start \(opencode\)/.test(captured.slice(resumedAt))) return true; await sleep(200); }
      return false;
    })();
    ok(resumedFire, "B6 fires actually resume after restore");
  })();

  // ── C. stop the LIVE scheduler through the real verb ──────────────────────────────────────────
  const live = await runStop(ws);
  ok(live.code === 0 && /scheduler stopped/.test(live.out), `C1 stop SIGTERMs the live scheduler and reports success (got ${live.code}: ${live.out.trim().slice(0, 80)})`);
  await sleep(500);
  const schedAfter = box.sched;
  ok(schedAfter !== null && schedAfter.exitCode !== null, `C2 the scheduler process is gone (exitCode ${schedAfter?.exitCode})`);
  ok(!existsSync(lockPath), "C3 the run lock is cleaned up");

  console.log(fails === 0 ? "\nSTOP_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { if (box.sched && box.sched.exitCode === null) box.sched.kill("SIGKILL"); } catch { /* gone */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
