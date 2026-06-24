// DL-46 — concurrent `daemon up` must be race-free. Without a cold-start lock, two near-simultaneous `up`s
// both spawn a daemon; the loser crashes on EADDRINUSE but its health probe is answered by the WINNER on the
// SAME url, so both believe they started and both write the runfile (last-writer-wins records the loser's
// now-dead pid → the live winner is ORPHANED, and `down` can never stop it). This reproduced ~4/8 trials.
//
// The fix (a per-project O_EXCL lock in daemonUp, §18) serializes cold start: the second `up` waits, finds the
// winner already healthy, and no-ops. This test fires overlapping `up`s and asserts, every trial: the runfile
// points at a LIVE daemon actually serving health, and after `down` NOTHING still listens (0 untracked leak).
// HALF the trials pre-seed a STALE lock (a crashed `up`'s leftover) so the concurrent ATOMIC stale-break path
// (rename-aside, not unlink-then-create — two racers must not both "break" and both acquire) is exercised too.
// Deterministic-pass post-fix; ~99.6% to catch a regression across the trials.
//
// Runs against an ISOLATED temp DB + DEVLOOP_RUN_DIR (never the operator's ~/.dev-loop). cwd = hub/ (npm).
import { spawn, execFileSync } from "node:child_process";
import { rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/hub-lifecycle-race";
const DB = join(ROOT, "hub.db");
const RUN = join(ROOT, "run");
const PROJ = "lcrace";
const lockfile = join(RUN, `daemon-${PROJ}.lock`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = join(RUN, `daemon-${PROJ}.json`);
const readRun = () => JSON.parse(readFileSync(runfile, "utf8")) as { project: string; pid: number; port: number; host: string; url: string };
const health = (url: string) => fetch(`${url}/api/health`).then((x) => x.ok).catch(() => false);
// replicate lcPortFor(key) (daemon.ts) so cleanup can target the deterministic port even if no trial succeeded
const portFor = (key: string) => { let h = 2166136261 >>> 0; for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return 20000 + (h % 20000); };
const STABLE_PORT = portFor(PROJ);

// seed the isolated service project (ensureActors seeds the `operator` actor the daemon needs)
execFileSync("node", ["src/seed.ts", PROJ, "Race Project", "RC", DB], { encoding: "utf8" });

// run `node src/daemon.ts <sub>` ASYNC so two `up`s can overlap (the existing lifecycle.ts uses blocking spawnSync)
function lcAsync(sub: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn("node", ["src/daemon.ts", sub], { env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator" } });
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

const TRIALS = 8;
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
    // the recorded pid must be a LIVE daemon that actually answers health — not an orphaned-loser dead pid
    const trackedHealthy = await health(r.url);
    ok(isAlive(r.pid) && trackedHealthy, `${tag}: runfile pid ${r.pid} is alive AND serving ${r.url}/api/health (no orphan)`);

    // `down` must stop the REAL daemon → nothing still listens (0 untracked leak)
    const down = await lcAsync("down");
    ok(down.status === 0, `${tag}: down exit 0`);
    const gone = await waitGone(r.url);
    ok(gone && !isAlive(r.pid), `${tag}: after down, no daemon answers on ${r.url} — down stopped the live one, 0 leak`);
  }
  ok(fails === 0, `all ${TRIALS} concurrent-up trials race-free (single tracked live daemon, down-stoppable, 0 untracked)`);
} finally {
  // best-effort cleanup: stop the tracked daemon, then sweep any untracked listener left near the stable port
  // (a PRE-fix run leaks orphaned winners `down` can't reach — keep the test a good citizen even on failure).
  await lcAsync("down").catch(() => {});
  for (let p = STABLE_PORT; p <= STABLE_PORT + 8; p++) {
    try { for (const pid of execFileSync("lsof", ["-ti", `tcp:${p}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } } } catch { /* lsof absent / nothing listening */ }
  }
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nLIFECYCLE_RACE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
