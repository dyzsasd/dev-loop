// A fire's process group is reaped when the fire ends.
//
// The group was only ever killed by a watchdog (timeout, stall, budget). A fire that ended NORMALLY
// reaped nothing, so any background process the agent started and never waited for was reparented to
// init and ran forever. Observed live in the jinko-browser-use workspace: a fire's
// `npm exec tsx src/api/server.ts` held 127.0.0.1:8899 for two days after that fire had exited 0, with
// the scheduler stopped the whole time — invisible to `status`, to `doctor`, and to the fire ledger,
// which recorded the fire as a clean success.
//
// The contract this pins down: being in the fire's process group when the leader exits is the definition
// of a leak, not of a daemon. Anything meant to outlive its fire has to LEAVE the group — spawn it into
// a new session (detached/setsid) or hand it to a supervisor. Both halves are asserted below.
import { spawnSync } from "node:child_process";
import { chmodSync, realpathSync, readFileSync, existsSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-group-reap-"));
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const cli = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "cli.ts"), ...args], { cwd, env: env({ DEVLOOP_PROJECT: "alpha" }), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "reap-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
spawnSync("mkdir", ["-p", join(ws, "ra")]);
team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);
cli(["seed", "alpha", "Alpha", "ALPHA"], ws);

// `alive` must not read a zombie as alive: a signalled process whose parent has not reaped it still
// answers kill(pid, 0). Both stand-ins below are orphaned into init, which reaps them, but the check
// goes through `ps` state anyway so the assertion cannot pass on a corpse.
const alive = (pid: string) => {
  const st = spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" }).stdout.trim();
  return st !== "" && !st.startsWith("Z");
};
const settle = (pid: string, wantAlive: boolean, budgetMs = 5000) => {
  const until = Date.now() + budgetMs;
  while (Date.now() < until && alive(pid) !== wantAlive) spawnSync("sleep", ["0.1"]);
  return alive(pid);
};

const leakFile = join(tmp, "leaked.pid");
const daemonFile = join(tmp, "daemon.pid");
const stubbornFile = join(tmp, "stubborn.pid");

// The fire exits 0 — no watchdog, no signal, nothing that used to reap the group. It leaves two
// background processes behind:
//   * `sleep &` — stays in the fire's process group (a non-interactive shell puts background jobs in
//     its own group), i.e. the leak shape.
//   * a Node spawn with detached:true — setsid(2), a NEW session and group, i.e. the documented way to
//     start something that is meant to outlive the fire.
const bin = join(tmp, "leaky-fire.sh");
writeFileSync(bin, `#!/bin/sh
sh -c 'sleep 120 >/dev/null 2>&1 & echo $! > "${leakFile}"'
node -e 'const c=require("child_process").spawn("sleep",["120"],{detached:true,stdio:"ignore"});require("fs").writeFileSync("${daemonFile}",String(c.pid));c.unref()'
node -e 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)' >/dev/null 2>&1 &
echo $! > "${stubbornFile}"
echo "fire body done"
exit 0
`);
chmodSync(bin, 0o755);

const run = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--once"],
  { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: bin }), encoding: "utf8", timeout: 120_000 });
const runOut = `${run.stdout ?? ""}${run.stderr ?? ""}`;

ok(existsSync(leakFile), `fixture: the fire recorded the pid of the process it left in its group${existsSync(leakFile) ? "" : `\n${runOut.slice(-600)}`}`);
ok(existsSync(daemonFile), "fixture: the fire recorded the pid of the process it detached into a new session");
const leaked = existsSync(leakFile) ? readFileSync(leakFile, "utf8").trim() : "";
const daemon = existsSync(daemonFile) ? readFileSync(daemonFile, "utf8").trim() : "";

// DISCRIMINATING — this is the whole bug. Before the fix the stand-in outlives the scheduler run.
ok(leaked !== "" && !settle(leaked, false), `AC1: a process left in the fire's group does NOT outlive the fire (pid ${leaked})`);

// DISCRIMINATING — a silent reap is a different failure: the operator has to be able to see that a lane
// is leaking, and which lane, or the leak is only ever found by reading `lsof` two days later.
ok(/reaping processes left in the fire's group/.test(runOut) && /\bpm\b/.test(runOut),
  `AC2: the reap is announced on the run log, naming the lane${/reaping/.test(runOut) ? "" : `\n${runOut.slice(-600)}`}`);

// GUARD (passes before and after any change here) — it covers the ESCALATION, which had no coverage at
// all: the original stand-in was a plain `sleep`, which dies on reapGroup's first SIGTERM, so AC1 never
// exercised the SIGKILL that follows. This stand-in installs a no-op SIGTERM handler, so only the
// escalation can end it.
//
// It was written expecting to FAIL first. A review argued that the 2 s SIGKILL timer is unref'd and
// `--once` calls process.exit() as soon as the fire resolves, so the escalation could never be reached in
// that mode. Measured instead of assumed: this arm passes on the unmodified code, i.e. the scheduler does
// outlive the timer here and the escalation does fire. The gap is real in the code path and did not
// reproduce in behaviour, so nothing was changed for it — the arm stays as the coverage that would catch
// it if a faster exit path ever did.
const stubborn = existsSync(stubbornFile) ? readFileSync(stubbornFile, "utf8").trim() : "";
ok(stubborn !== "", "fixture: the fire recorded the pid of a group member that IGNORES SIGTERM");
ok(stubborn !== "" && !settle(stubborn, false), `AC6: the escalation ends a group member that IGNORES SIGTERM — only SIGKILL can (pid ${stubborn})`);

// CONTRACT — passes before and after; it pins the escape hatch, so the fix cannot be "kill everything
// the fire ever started". A supervised service must survive its fire.
const daemonLived = daemon !== "" && alive(daemon);
ok(daemonLived, `AC3: a process that LEFT the group (detached/setsid) survives the reap (pid ${daemon})`);
if (daemon) spawnSync("kill", ["-9", daemon]); // this suite does not leak what it just proved survives

ok(run.status === 0, `AC4: the fire itself is still a clean success — reaping is not a failure (exit ${run.status})`);
const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
const rows = existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const last = rows[rows.length - 1];
ok(!!last && last.exitCode === 0, `AC5: …and it is ledgered as exit 0, not as a kill (${last ? last.exitCode : "no row"})`);

console.log(fails === 0 ? "\nfire-group-reap: OK" : `\nfire-group-reap: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
