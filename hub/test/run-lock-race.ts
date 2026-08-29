// Breaking a stale run lock is SERIALIZED, and a scheduler only releases a lock it still owns.
//
// `wx` (O_CREAT|O_EXCL) makes exactly one creator win, and that is the entire guarantee the run lock
// offers. The takeover path threw it away: unlink-then-create with nothing between the two steps, so two
// racers that both observed the dead holder both unlinked and both created — the second unlink removing
// the lock the first had just won — and two schedulers ran for one project. The exit hooks then unlinked
// unconditionally, so a process that had LOST its lock deleted the winner's on the way out.
//
// A note on what this test does and does not show. Driving the first failure with real concurrent
// processes does NOT reproduce it: node's start-up jitter is tens to hundreds of milliseconds while the
// unlink→create window is microseconds, so eight racers against one stale lock produce a single winner on
// the unfixed build too. That experiment was run and is reported here rather than dressed up — the fix
// rests on the code path, not on a reproduction. What IS deterministic is the mechanism the fix
// introduces, and the arms below split into two kinds, labelled so a later reader does not mistake one
// for the other:
//   DISCRIMINATING (fails on the unfixed build, verified): arm 2, the break under a live racer's mutex,
//   and arm 4, the ownership check on release.
//   GUARD (passes on both builds, present to catch over-correction): arm 1, the ordinary uncontended
//   takeover, and arm 3, the dead-breaker cleanup — the unfixed build passes arm 3 only because it never
//   consults a break file at all, so passing there means nothing about the fix.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-lockrace-")));
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "race-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
mkdirSync(join(ws, "ra"), { recursive: true });
team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);

const bin = join(tmp, "fast.sh");
writeFileSync(bin, "#!/bin/sh\necho ok\nexit 0\n");
chmodSync(bin, 0o755);

const lockPath = join(ws, ".dev-loop", "locks", "run.lock");
const breakPath = `${lockPath}.break`;
mkdirSync(dirname(lockPath), { recursive: true });

// A pid that is certainly gone, and one that is certainly alive and NOT our child (a child would become a
// zombie when reaped, and a zero-signal probe succeeds on a zombie).
const deadPid = 999_999;
const livePidFile = join(tmp, "live.pid");
spawnSync("sh", ["-c", `sleep 90 >/dev/null 2>&1 & echo $! > ${livePidFile}`]);
await sleep(200);
const livePid = Number(readFileSync(livePidFile, "utf8").trim());

const stale = () => writeFileSync(lockPath, JSON.stringify({ pid: deadPid, team: "race-team", startedAt: new Date().toISOString() }));
// The scheduler LOOP is required: `--once` returns before the run lock is taken (a single manual fire is
// deliberately not gated on the scheduler's lock), so it cannot exercise this path at all.
//
// Three flags keep it quick, and the first draft was killed by the runner's 300 s per-suite ceiling
// without them. `--no-assemble-boot` skips a 72 KB corpus read per racer and `--stagger 0` starts the
// lane at once, but the one that mattered was `--interval pm=1s`: once an earlier arm has fired, the
// lane's cadence gate makes the NEXT scheduler wait out pm's due time — arm 3 alone sat for 300.7 s,
// while every other arm finished in under a second, because `--max-fires 1` will not exit before it has
// fired once.
const runScheduler = async (): Promise<string> => {
  const c = spawn("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--interval", "pm=1s", "--max-fires", "1", "--stagger", "0", "--no-assemble-boot", "--no-daemon"],
    { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: bin }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
  return new Promise<string>((res) => c.on("exit", () => res(out)));
};

// 1. GUARD — uncontended stale lock ⇒ still taken over. The fix must not wedge the ordinary restart path.
stale(); rmSync(breakPath, { force: true });
const uncontended = await runScheduler();
ok(/taking over stale (team )?run lock/.test(uncontended), "an uncontended stale lock is still taken over — the ordinary restart path is unchanged");

// 2. DISCRIMINATING — stale lock + a break-mutex held by a LIVE process ⇒ the break is NOT performed. This is the
//    serialization itself: that other racer is mid-break, and breaking underneath it is what produced two
//    schedulers. Before the fix no break-mutex was consulted at all and this scheduler took the lock.
stale();
writeFileSync(breakPath, JSON.stringify({ pid: livePid, at: new Date().toISOString() }));
const contended = await runScheduler();
ok(!/taking over stale (team )?run lock/.test(contended),
  `a stale lock is NOT broken while another racer holds the break-mutex (out: ${contended.trim().split("\n").pop() ?? ""})`);
ok(/taking over the stale lock right now/.test(contended),
  "…and the refusal names the LIVE racer that holds the mutex, not the dead pid in the lock file");
ok(new RegExp(`pid ${livePid}\\b`).test(contended), `…by pid (${livePid})`);
ok(existsSync(breakPath), "…and it leaves the other racer's break-mutex alone");

// 3. GUARD — a break-mutex whose owner is DEAD must not wedge the loop forever — a crashed breaker would
//    otherwise make every future start refuse.
stale();
writeFileSync(breakPath, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }));
const deadBreaker = await runScheduler();
ok(/taking over stale (team )?run lock/.test(deadBreaker), "a break-mutex left behind by a DEAD racer is cleared, not obeyed forever");

// 4. DISCRIMINATING — release is ownership-checked: a scheduler whose lock has been replaced by another pid must not
//    delete it on the way out. Unconditional unlink re-opened the two-scheduler window from the far end.
rmSync(breakPath, { force: true });
rmSync(lockPath, { force: true });
// This arm needs the lock HELD while the file is rewritten underneath it, so its fire is a slow one.
const slowBin = join(tmp, "slow.sh");
writeFileSync(slowBin, "#!/bin/sh\nexec sleep 5\n");
chmodSync(slowBin, 0o755);
const holder = spawn("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--interval", "pm=1s", "--max-fires", "1", "--stagger", "0", "--no-assemble-boot", "--no-daemon"],
  { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: slowBin }), stdio: ["ignore", "pipe", "pipe"] });
for (let i = 0; i < 60 && !existsSync(lockPath); i++) await sleep(100);
ok(existsSync(lockPath), "fixture: the scheduler took the lock");
// Simulate the state after a takeover: the file now names somebody else.
writeFileSync(lockPath, JSON.stringify({ pid: livePid, team: "race-team", startedAt: new Date().toISOString() }));
holder.kill("SIGTERM");
await new Promise<void>((res) => holder.on("exit", () => res()));
await sleep(300);
ok(existsSync(lockPath), "a scheduler does not delete a run lock that names another pid when it exits");
const survivor = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
ok(survivor.pid === livePid, `…the surviving lock is still the other holder's (${survivor.pid})`);

try { process.kill(livePid, "SIGKILL"); } catch { /* already gone */ }
console.log(fails === 0 ? "\nRUN_LOCK_RACE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
