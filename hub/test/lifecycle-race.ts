// DL-46 — concurrent `daemon up` must be race-free. Without a cold-start lock, two near-simultaneous `up`s
// both spawn a daemon; the loser crashes on EADDRINUSE but its health probe is answered by the WINNER on the
// SAME url, so both believe they started and both write the runfile (last-writer-wins records the loser's
// now-dead pid → the live winner is ORPHANED, and `down` can never stop it). This reproduced ~4/8 trials.
//
// The fix (a per-project O_EXCL lock in daemonUp, §18) serializes cold start: the second `up` waits, finds the
// winner already healthy, and no-ops. This test fires overlapping `up`s and asserts, every trial: the runfile
// points at a LIVE daemon actually serving health, and after `down` NOTHING still listens (0 untracked leak).
// HALF the trials pre-seed a STALE lock (a crashed `up`'s leftover) so the concurrent stale-break path is
// exercised too — DL-51 serializes that break under a dedicated O_EXCL break-mutex and re-confirms staleness
// while holding it, so two racers can't both "break" a stale lock and clobber each other's fresh re-take (the
// DL-46 TOCTOU the rename-aside break re-admitted).
//
// NOT "deterministic-pass post-fix" (LOOP-317). CI run 30920347062, job Test (Node 24), 2026-08-04:
// trial 5 failed — the runfile pid was not the live listener and `down` left :8787 serving for the
// full 4s waitGone deadline. Node 23.6.0 passed all 8 trials on the SAME commit and run. Whether the
// Node version is causal or incidental is NOT established: one observation cannot separate a
// version-specific behaviour from a load-dependent race.
//
// Reproduction attempt, 2026-08-06, recorded so the next one starts from evidence rather than from
// this comment: 120 trials (600 assertions) on Node 23.6.0 with the CPU oversubscribed — 12 spinners
// on 10 cores — 0 failures. CI's 1/8 does not reproduce on this hardware, so the rate here is below
// what 120 trials can see, and the ROOT CAUSE IS NOT ESTABLISHED. No fix is proposed on that basis:
// this seam has already taken two landed fixes, and a third guess would be the same mistake again.
//
// (An earlier attempt of mine reported "96 trials, 0 failures" and was worthless — it ran the suite
// from the repo root, where it cannot resolve src/seed.ts, so every run CRASHED and the failure grep
// counted zero. A crash and a pass look identical to `grep -c "^❌"`. Run it from hub/.)
//
// This loop is a SAMPLER, not a proof: a race that shows at 1/8 was equally present, unobserved, in
// every run that passed. DEVLOOP_LIFECYCLE_TRIALS raises the count for a targeted hunt.
//
// Runs against an ISOLATED temp DB + DEVLOOP_RUN_DIR (never the operator's ~/.dev-loop). cwd = hub/ (npm).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync, spawnSync } from "node:child_process";
import { registerDaemonPid, launchDaemonCli, runDaemonCli } from "./daemon-harness.ts";
import { foreignListener } from "../src/daemon-lifecycle.ts"; // LOOP-317: the decision the fix turns on
import { rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { scrubFireEnv } from "./env-scrub.ts";
import { join } from "node:path";

const ROOT = "/tmp/hub-lifecycle-race";
const DB = join(ROOT, "hub.db");
const RUN = join(ROOT, "run");
const PROJ = "lcrace";
const NODE = process.env.DEVLOOP_NODE || process.execPath;
const lockfile = join(RUN, `daemon-${PROJ}.lock`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = join(RUN, `daemon-${PROJ}.json`);
const readRun = (): { project: string; pid: number; port: number; host: string; url: string } | null => {
  if (!existsSync(runfile)) return null;
  return JSON.parse(readFileSync(runfile, "utf8"));
};
const health = (url: string) => fetch(`${url}/api/health`).then((x) => x.ok).catch(() => false);
const touchedPorts = new Set<number>();

// seed the isolated service project (ensureActors seeds the `operator` actor the daemon needs)
execFileSync(NODE, ["src/seed.ts", PROJ, "Race Project", "RC", DB], { encoding: "utf8" });

// run `src/daemon.ts <sub>` ASYNC (through the sanctioned harness spawn site) so two `up`s can overlap
// (lifecycle.ts drives the same daemon.ts dispatcher with the blocking runDaemonCli).
function lcAsync(sub: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = launchDaemonCli("daemon", sub, { DEVLOOP_NODE: NODE, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator" });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => res({ status: status ?? -1, stdout, stderr }));
  });
}
// poll until a url stops answering health (or a generous timeout) — avoids a fixed-sleep flake on a loaded host
async function waitGone(url: string, totalMs = 4000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) { if (!(await health(url))) return true; await sleep(100); }
  return false;
}

// ── readRun regression (LOOP-145): a missing runfile must return null, never crash ──
// No daemon has started yet so the runfile doesn't exist — confirms the null-safe path.
ok(readRun() === null, "readRun returns null for a missing runfile (LOOP-145: no uncaught ENOENT)");

// LOOP-317: overridable, so a hunt for a low-rate race does not need a code edit. 8 is the shipped
// count (the CI budget); a reproduction attempt should use hundreds.
const TRIALS = Math.max(1, Number(process.env.DEVLOOP_LIFECYCLE_TRIALS) || 8);
try {
  for (let i = 0; i < TRIALS; i++) {
    const seedStale = i % 2 === 0; // half the trials start from a crashed `up`'s leftover lock (a dead pid)
    if (seedStale) writeFileSync(lockfile, JSON.stringify({ pid: 999_999_999, at: "2000-01-01T00:00:00.000Z" }));

    // fire two `up`s as concurrently as the runtime allows
    const [a, b] = await Promise.all([lcAsync("up"), lcAsync("up")]);
    const tag = `trial ${i}${seedStale ? " (stale-lock seeded)" : ""}`;
    ok(a.status === 0 && b.status === 0, `${tag}: both \`up\` exit 0 (got ${a.status},${b.status})`);
    ok(existsSync(runfile), `${tag}: a runfile exists`);
    const r = readRun();
    if (r != null) {
      registerDaemonPid(r.pid);
      touchedPorts.add(r.port);
      // the recorded pid must be a LIVE daemon that actually answers health — not an orphaned-loser dead pid
      const trackedHealthy = await health(r.url);
      ok(isAlive(r.pid) && trackedHealthy, `${tag}: runfile pid ${r.pid} is alive AND serving ${r.url}/api/health (no orphan)`);

      // `down` must stop the REAL daemon → nothing still listens (0 untracked leak)
      const down = await lcAsync("down");
      ok(down.status === 0, `${tag}: down exit 0`);
      const gone = await waitGone(r.url);
      ok(gone && !isAlive(r.pid), `${tag}: after down, no daemon answers on ${r.url} — down stopped the live one, 0 leak`);
    } else {
      ok(false, `${tag}: runfile missing after up — daemon failed to start; trial aborted`);
    }
  }
  ok(fails === 0, `all ${TRIALS} concurrent-up trials race-free (single tracked live daemon, down-stoppable, 0 untracked)`);
} finally {
  // best-effort cleanup: stop the tracked daemon, then sweep any untracked listener on ports this test recorded
  // (a PRE-fix run leaks orphaned winners `down` can't reach — keep the test a good citizen even on failure).
  await lcAsync("down").catch(() => {});
  for (const p of touchedPorts) {
    try { for (const pid of execFileSync("lsof", ["-ti", `tcp:${p}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } } } catch { /* lsof absent / nothing listening */ }
  }
  rmSync(ROOT, { recursive: true, force: true });
}

// ── LOOP-317: the orphan, made DETERMINISTIC ─────────────────────────────────────────────────────
// The 8-trial loop above is a SAMPLER — it caught this at 1/8 on CI and 0/120 here. Sampling a race
// cannot establish its cause. This reproduces the OUTCOME of the race directly, with no timing:
//
//   ROOT CAUSE. `lcTryBind` and the child's real bind are not atomic (the TOCTOU already named in
//   daemon-lifecycle.ts). Another cold start — or a survivor of a previous `down` — can hold the
//   port. Our child then dies with EADDRINUSE while `lcProbe(url)` answers HEALTHY *from the other
//   process*, and the project key MATCHES because it is the same project. `up` then wrote OUR
//   (dying) pid into the runfile while the live listener was someone else's process: the runfile
//   records a pid that is not the listener, `down` kills the wrong thing, the real daemon is
//   orphaned. That is exactly CI run 30920347062 trial 5 — runfile pid not the live listener, and
//   `down` leaving :8787 serving for the full 4s waitGone deadline.
//
// A foreign listener answering /api/health for the same project IS the state that race produces, so
// standing one up reproduces the defect every time instead of 1 run in 8.
{
  const port = 8931 + Math.floor(Math.random() * 40);
  const key = PROJ;
  const FOREIGN_PID = 424242; // not this process, not any child `up` will spawn
  const srv = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "dev-loop-hub", pid: FOREIGN_PID, project: key, version: "9.9.9", buildCommit: null, actor: "operator", dbPresent: true }));
      return;
    }
    res.writeHead(404); res.end();
  });
  // Listen on ALL interfaces: `up` builds its probe URL from the daemon host, and a stub bound only
  // to 127.0.0.1 is unreachable when that resolves to ::1 — which made this fixture time out instead
  // of exercising the fix, and the assertion passed for the wrong reason.
  srv.on("error", (e) => { throw new Error(`LOOP-317 fixture: the foreign listener could not bind :${port} — ${(e as Error).message}`); });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  // Dual-stack: `up` probes via the daemon host, which can resolve to ::1, while the child binds
  // 127.0.0.1. The stub must answer on BOTH or the probe misses it and the fixture times out
  // instead of exercising the fix — which is how this assertion first passed for the wrong reason.
  const srv6 = createServer((req, res) => { if ((req.url ?? "").startsWith("/api/health")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "dev-loop-hub", pid: FOREIGN_PID, project: key, version: "9.9.9", buildCommit: null, actor: "operator", dbPresent: true })); return; } res.writeHead(404); res.end(); });
  srv6.on("error", () => { /* no IPv6 on this host — the v4 listener is enough */ });
  await new Promise<void>((r) => { srv6.listen(port, "::1", () => r()); setTimeout(r, 500); });
  try {
    const runDir = mkdtempSync(join(tmpdir(), "lc317-"));
    // A seeded service-backend project of its own: `up` refuses to start an unseeded project, and the
    // trial loop above may have torn its DB down by now.
    const db317 = join(runDir, "hub.db");
    execFileSync(NODE, ["src/seed.ts", key, "Race 317", "R317", db317], { cwd: process.cwd(), encoding: "utf8" });
    const up = runDaemonCli("daemon", "up", {
      DEVLOOP_NODE: NODE, DEVLOOP_PROJECT: key, DEVLOOP_HUB_DB: db317,
      DEVLOOP_RUN_DIR: runDir, DEVLOOP_DAEMON_PORT: String(port), DEVLOOP_ACTOR: "operator",
    }, { timeout: 60_000 });
    const runfile = join(runDir, `daemon-${key}.json`);
    let recorded: { pid?: number; port?: number } | null = null;
    try { recorded = JSON.parse(readFileSync(runfile, "utf8")) as { pid?: number; port?: number }; } catch { recorded = null; }

    // POST-FIX: `up` must refuse rather than record a runfile pointing at a process it did not spawn.
    // PRE-FIX it exits 0 and writes a runfile whose pid is its own dead child — the orphan.
    ok(up.status !== 0,
      `LOOP-317: with a FOREIGN daemon already serving the port, up refuses instead of adopting it (exit ${up.status}; out=${(up.stdout??"").slice(0,150)})`);
    ok(recorded === null || recorded.pid === undefined,
      `LOOP-317: …and writes NO runfile — recording a pid that is not the listener is what orphans the live daemon (got ${JSON.stringify(recorded)})`);
    // Either refusal path is correct — what must never happen is a runfile pointing at a process
    // `up` did not spawn. Which path fires depends on whether the probe reaches the foreign listener
    // before the wait deadline, and that IS the timing this suite cannot pin down; the DECISION the
    // fix turns on is asserted directly below instead.
    ok(/not the one just spawned|another daemon|did not become healthy/.test(`${up.stdout ?? ""}${up.stderr ?? ""}`),
      `LOOP-317: …naming the cause, so the reader is not sent to the wrong process (${`${up.stdout ?? ""}${up.stderr ?? ""}`.split("\n").filter((l) => /daemon] up:/.test(l))[0] ?? "no line"})`);

    // The control: the foreign listener is genuinely answering as this project, so the pre-fix path
    // would have accepted it. Without this the assertions above could pass for the wrong reason.
    const probe = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json() as Promise<{ project?: string; pid?: number }>).catch(() => null);
    ok(probe?.project === key && probe?.pid === FOREIGN_PID,
      "LOOP-317 control: the foreign listener really does answer /api/health for THIS project — which is why the old key-only check accepted it");

    // THE FIX ITSELF, asserted directly. The `up` path above needs a real spawn, port and bind race
    // to reach this comparison, so proving it there means reproducing the race — the thing this
    // ticket could not do. The comparison is the whole fix, so test the comparison.
    ok(foreignListener(FOREIGN_PID, 4242) === true,
      "LOOP-317 FIX: a health response from a pid we did not spawn is FOREIGN — the runfile must not record our pid for it");
    ok(foreignListener(4242, 4242) === false, "LOOP-317 FIX: …our own child is not foreign");
    ok(foreignListener(undefined, 4242) === false,
      "LOOP-317 FIX: …and an ABSENT pid accepts — a daemon predating the field must not read as foreign, or every upgrade wedges");
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    try { srv6.close(); } catch { /* may never have bound */ }
  }
}

console.log(fails === 0 ? "\nLIFECYCLE_RACE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
