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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-runlog-")));
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
const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--background", "--max-fires", "1"],
  { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: fakeBin }), encoding: "utf8", timeout: 60_000 });
ok((r.status ?? 1) === 0, `the background scheduler starts (${r.status}) ${r.status === 0 ? "" : `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-200)}`);

ok(existsSync(`${logPath}.1`), "the oversized run.log was rotated to run.log.1");
ok(existsSync(logPath) && statSync(logPath).size < big, `the live run.log starts fresh below the ceiling (${existsSync(logPath) ? statSync(logPath).size : "missing"} bytes)`);
// §16: the rotated-then-recreated log holds the full unredacted fire stream and must be owner-only.
const mode = existsSync(logPath) ? (statSync(logPath).mode & 0o077) : 0o077;
ok(mode === 0, `the freshly rotated run.log is owner-only, not created at the default umask (group/other bits ${mode.toString(8)})`);

// Stop whatever the background start left running, so the suite leaks nothing.
spawnSync("node", [join(hubRoot, "src", "cli.ts"), "stop"], { cwd: ws, env: env(), encoding: "utf8" });

console.log(fails === 0 ? "\nRUN_LOG_ROTATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
