// hook.log is bounded, like every other log the loop keeps.
//
// The runner logs and run.log rotate at 50 MB with a single .1 generation and the fire ledger is pruned
// at 90 days; hook.log appended forever. It grows one line per SESSION rather than per fire, which is
// why nothing noticed — and why an unattended machine is where it would eventually matter.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-hooklog-"));
const runDir = join(tmp, "run");
mkdirSync(runDir, { recursive: true });
const logPath = join(runDir, "hook.log");

// One byte over the ceiling, written sparsely so the fixture costs no real disk time.
const big = 50 * 1024 * 1024 + 1;
spawnSync("sh", ["-c", `dd if=/dev/zero of=${JSON.stringify(logPath)} bs=1 count=0 seek=${big} 2>/dev/null`]);
ok(statSync(logPath).size === big, `fixture: hook.log starts over the ceiling (${statSync(logPath).size} bytes)`);

const run = () => spawnSync("node", [join(hubRoot, "src", "hook-session-start.ts")],
  { cwd: tmp, // The hook is OPT-IN (WS-B): without DEVLOOP_SESSION_HOOK it does nothing at all, log included.
    env: { ...scrubFireEnv(), DEVLOOP_SESSION_HOOK: "1", DEVLOOP_RUN_DIR: runDir, DEVLOOP_HOME: join(tmp, "home") }, encoding: "utf8" });

const r = run();
ok((r.status ?? 1) === 0, `the hook still exits 0 — it must never fail a session (${r.status})`);
ok(existsSync(`${logPath}.1`), "the oversized hook.log was rotated to hook.log.1");
ok(statSync(logPath).size < big, `the live hook.log starts fresh below the ceiling (${statSync(logPath).size} bytes)`);
ok(/session-start/.test(readFileSync(logPath, "utf8")), "…and this session's line was written to the fresh log, not lost in the rotation");

// A log under the ceiling is left alone — rotation must not throw away a perfectly good log every run.
const sizeBefore = statSync(logPath).size;
run();
ok(!existsSync(`${logPath}.2`) && statSync(logPath).size > sizeBefore,
  "a log under the ceiling is appended to, not rotated again");

console.log(fails === 0 ? "\nHOOK_LOG_ROTATION_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
