// run.log is bounded like every other log the loop writes.
//
// The per-agent runner logs rotate at 50 MB with a single .1 generation, and the fire ledger is pruned at
// 90 days. run.log had no bound at all — and it is the UNION of every agent's stdout+stderr in an
// unattended run, so it grows faster than either. A long-lived loop appended to it forever.
//
// Rotation must also happen BEFORE the `existed` check that drives the §16 permission hardening: a
// freshly rotated log is a NEW file, and if it is treated as pre-existing it is created at the default
// umask while holding the full unredacted fire stream.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-runlog-"));
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "runlog-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
spawnSync("mkdir", ["-p", join(ws, "ra")]);
team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);

const logPath = join(ws, ".dev-loop", "run.log");
mkdirSync(dirname(logPath), { recursive: true });
// One byte over the 50 MB ceiling, written sparsely so the fixture costs no real disk time.
const big = 50 * 1024 * 1024 + 1;
const fh = spawnSync("sh", ["-c", `dd if=/dev/zero of=${JSON.stringify(logPath)} bs=1 count=0 seek=${big} 2>/dev/null`]);
ok(fh.status === 0 && statSync(logPath).size === big, `fixture: run.log starts over the ceiling (${statSync(logPath).size} bytes)`);

const fakeBin = join(tmp, "fake.sh");
writeFileSync(fakeBin, "#!/bin/sh\necho ok\nexit 0\n");
spawnSync("chmod", ["+x", fakeBin]);

// --background is the path that opens run.log. It re-spawns detached and returns at once.
const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--background"],
  { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: fakeBin }), encoding: "utf8", timeout: 60_000 });
ok((r.status ?? 1) === 0, `the background scheduler starts (${r.status}) ${r.status === 0 ? "" : `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-200)}`);

ok(existsSync(`${logPath}.1`), "the oversized run.log was rotated to run.log.1");
ok(existsSync(logPath) && statSync(logPath).size < big, `the live run.log starts fresh below the ceiling (${existsSync(logPath) ? statSync(logPath).size : "missing"} bytes)`);
// §16: the rotated-then-recreated log holds the full unredacted fire stream and must be owner-only.
const mode = existsSync(logPath) ? (statSync(logPath).mode & 0o077) : 0o077;
ok(mode === 0, `the freshly rotated run.log is owner-only, not created at the default umask (group/other bits ${mode.toString(8)})`);

// Stop what the background start left running — and ASSERT it stopped.
//
// `stop` reads the run lock, and `--background` returns as soon as it has forked: the detached scheduler
// had usually not written its lock yet, so `stop` found no holder, did nothing, and said nothing. The
// scheduler then outlived the suite, kept its workspace alive, and recreated the temp tree AFTER the
// suite's own cleanup had removed it. Observed as a running `run-agents.ts --agents pm` with ppid 1 and a
// 452 KB workspace under $TMPDIR, once per full-suite run. Waiting for the lock is what makes `stop`
// meaningful here; asserting afterwards is what stops the leak from going quiet again.
//
// Two things this arm gets wrong if written the obvious way:
//
//   `--max-fires 1` is not a safety belt, it is the race. A lane with no recorded fire fires ON BOOT
//   (run-agents-seed.ts: `fireOnBoot: true`), bypassing the cadence gate, and the fake claude returns at
//   once — so the scheduler completed its one fire and exited in roughly 300 ms. This poll grid is 100 ms
//   of `sleep` plus a process spawn per tick; macOS landed inside that window and Linux did not, which is
//   what made the arm pass here and fail deterministically on both CI runners. The scheduler under test
//   must outlive the poll, so it starts with no fire ceiling and `stop` is what ends it.
//
//   The post-stop assertion cannot read the lock. `holderPid()` answers 0 for a MISSING lock file, so a
//   scheduler that released its lock and kept running — the exact ppid-1 leak this arm exists to catch —
//   scored live=false and passed. It passed vacuously in the red CI run too, having never observed any
//   process at all. The subject is therefore the pid the parent printed, probed directly.
const lockPath = join(ws, ".dev-loop", "locks", "run.lock");
const holderPid = (): number => {
  try { return (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number }).pid ?? 0; } catch { return 0; }
};
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childPid = Number(/scheduler started in background \(pid (\d+)\)/.exec(r.stdout ?? "")?.[1] ?? 0);
ok(childPid > 0, `the background start names the detached pid, so the leak has a subject (${childPid || "no pid in stdout"})`);

const until = Date.now() + 15_000;
let started = 0;
while (started === 0 && Date.now() < until) {
  const pid = holderPid();
  if (pid > 0 && alive(pid)) { started = pid; break; }
  spawnSync("sleep", ["0.1"]);
}
ok(started > 0, `the detached scheduler took the run lock, so \`stop\` has something to address (pid ${started || "none — lock never appeared"})`);
spawnSync("node", [join(hubRoot, "src", "cli.ts"), "stop"], { cwd: ws, env: env(), encoding: "utf8" });

const gone = Date.now() + 15_000;
while (childPid > 0 && alive(childPid) && Date.now() < gone) spawnSync("sleep", ["0.1"]);
const stillUp = childPid > 0 && alive(childPid) ? childPid : 0;
ok(stillUp === 0, `…and it is gone once \`stop\` returns — the suite leaks no scheduler (pid ${stillUp} still running)`);
if (stillUp > 0) spawnSync("kill", ["-9", String(stillUp)]); // never leave one behind, even when asserting that we did

console.log(fails === 0 ? "\nRUN_LOG_ROTATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
