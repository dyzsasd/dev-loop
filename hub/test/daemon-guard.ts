// AC-A4 regression guard: no hub/test/*.ts file (other than daemon-harness.ts) may directly
// spawn a daemon. All daemon-starting tests must go through daemon-harness.ts's runDaemonCli /
// launchDaemonCli so the ONE process.on("exit") SIGKILL sweep there covers every termination path.
//
// Rule (LOOP-136): a non-harness line is a violation when it makes a spawn CALL *and* names a
// daemon start — matched by the PROPERTY "this line starts a daemon", not a single literal, so
// no spawn idiom can hide by relocating out of the guard's field of view:
//   • the daemon.ts entry file (`src/daemon.ts`), OR
//   • a quoted "daemon" argv token together with a "up" / "up-all" / "ensure" token
//     (the `server.ts daemon up` and `<cli> daemon up` argv forms), OR
//   • a bare `daemon up` / `daemon up-all` / `daemon ensure` command string.
// daemon-harness.ts is the sole sanctioned spawn site (it + daemon-guard.ts are exempt).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = join(dirname(fileURLToPath(import.meta.url)));
// hub-lifecycle.ts is EXEMPT and registered instead of rewritten (LOOP-146): its whole subject IS
// `dev-loop hub start|stop|status|ensure`, so routing it through the harness would test something
// other than the verb it exists to test. What it must NOT do is leave its daemons outside the ONE
// exit sweep — it now calls registerDaemonPid for each, which is asserted below.
const EXEMPT = new Set(["daemon-harness.ts", "daemon-guard.ts", "hub-lifecycle.ts"]);

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const violations: string[] = [];

for (const file of readdirSync(testDir).filter((f) => f.endsWith(".ts") && !EXEMPT.has(f))) {
  const src = readFileSync(join(testDir, file), "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue; // comment lines are not spawn calls
    if (!/\bspawn(Sync)?\s*\(/.test(trimmed)) continue;                 // a real spawn call — not "spawn" in prose
    const spawnsDaemonTs = /daemon\.ts/.test(trimmed);
    const startsViaArgv = /["'`]daemon["'`]/.test(trimmed) && /["'`](up|up-all|ensure)["'`]/.test(trimmed);
    const startsViaCmd = /\bdaemon\s+(up|up-all|ensure)\b/.test(trimmed);
    // LOOP-146 — a FOURTH live idiom the three predicates above all miss: `node src/hub.ts <sub>`
    // where `sub` is a VARIABLE. hub.ts's `start` and `ensure` cases are `daemonLifecycleCode("up"|
    // "ensure")` — the same daemonLifecycle() this guard exists to protect — reached through a third
    // entry file, so there is no `daemon.ts` in the line, no quoted "daemon" token, and no
    // `daemon up` string. hub-lifecycle.ts starts three REAL daemons this way (its own assertions
    // count runfiles and assert RUNNING) and the guard printed "no direct daemon spawns".
    //
    // The predicate is the ENTRY FILE, not the subcommand: the sub is not knowable from the line, and
    // hub.ts has no read-only subcommand that is worth spawning in a test anyway — `status` is the
    // one exception and it is cheap to route through the harness too. Being unable to see the value
    // is exactly why the narrow predicates missed it.
    // …but a hub.ts spawn whose sub is a LITERAL non-starting verb starts nothing, and flagging it
    // would be a false positive. Widening the guard surfaced exactly one: team-scheduler.ts's
    // `hub.ts "stop"` cleanup. When the sub is a literal, believe it; when it is a variable (the
    // LOOP-146 shape), the line is a potential start and must route through the harness.
    const NON_STARTING = /["'`](stop|down|status)["'`]/;
    const spawnsHubTs = /\bhub\.ts\b/.test(trimmed) && !NON_STARTING.test(trimmed);
    if (spawnsDaemonTs || startsViaArgv || startsViaCmd || spawnsHubTs) {
      violations.push(`${file}:${i + 1}: ${trimmed}`);
    }
  }
}

ok(violations.length === 0,
  violations.length === 0
    ? "daemon-guard: no direct daemon spawns in test files (every daemon start goes through daemon-harness.ts)"
    : `daemon-guard: ${violations.length} direct daemon spawn(s) in test files — route daemon starts through daemon-harness.ts:\n  ${violations.join("\n  ")}`);

// LOOP-146 — the exemption is only safe if the exempted file registers its pids with the ONE
// process.on("exit") sweep. hub-lifecycle.ts imported NOTHING from daemon-harness.ts, so its three
// real daemons were outside every termination path; its own cleanup `finally` is dead code on the
// normal path too, because process.exit() sits inside the try.
{
  const hl = readFileSync(join(testDir, "hub-lifecycle.ts"), "utf8");
  ok(/registerDaemonPid/.test(hl),
    "LOOP-146: hub-lifecycle.ts (exempt from the spawn predicate) registers its daemons with the harness sweep");
}

// ── Every lifecycle `up` registers what it may have started ──────────────────────────────────────
// The spawn predicate above covers DIRECT daemon spawns. It cannot see the other way a suite starts
// one: asking the lifecycle CLI through daemon-harness's runDaemonCli/launchDaemonCli, which forks a
// DETACHED daemon the CLI process then outlives. Those callers must registerDaemonPid whatever the
// runfile names, or the ONE exit sweep does not cover it.
//
// Measured: test/daemon.ts's port-band block killed its daemon only when `up` exited 0 AND the
// runfile parsed, so an `up` that spawned and then failed its own health probe left a live process —
// found by run-all.ts's leaked-daemon gate as a daemon with cwd=hub/ outliving a full `npm test`,
// after nine targeted re-runs failed to reproduce it in isolation. A conditional cleanup is not a
// sweep; the registry is.
//
// "Expected to refuse" is not an exemption: a suite asserting that an `up` REFUSES is exactly the
// one where a regression starts a daemon nobody is watching for.
{
  const LIFECYCLE_UP = /\b(runDaemonCli|launchDaemonCli)\s*\(\s*["'`](daemon|server)["'`]\s*,\s*["'`](up|up-all|ensure)["'`]/;
  const unregistered: string[] = [];
  for (const file of readdirSync(testDir).filter((f) => f.endsWith(".ts") && !EXEMPT.has(f))) {
    const src = readFileSync(join(testDir, file), "utf8");
    if (!LIFECYCLE_UP.test(src)) continue;
    if (!/registerDaemonPid\s*\(/.test(src)) unregistered.push(file);
  }
  ok(unregistered.length === 0,
    `every suite that asks the lifecycle CLI to start a daemon also registers it for the exit sweep${unregistered.length ? ` — missing: ${unregistered.join(", ")}` : ""}`);
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "daemon-guard: all checks passed");
process.exit(fails ? 1 : 0);
