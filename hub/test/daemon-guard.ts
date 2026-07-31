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
const EXEMPT = new Set(["daemon-harness.ts", "daemon-guard.ts"]);

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
    if (spawnsDaemonTs || startsViaArgv || startsViaCmd) {
      violations.push(`${file}:${i + 1}: ${trimmed}`);
    }
  }
}

ok(violations.length === 0,
  violations.length === 0
    ? "daemon-guard: no direct daemon spawns in test files (every daemon start goes through daemon-harness.ts)"
    : `daemon-guard: ${violations.length} direct daemon spawn(s) in test files — route daemon starts through daemon-harness.ts:\n  ${violations.join("\n  ")}`);

console.log(fails ? `${fails} CHECK(S) FAILED` : "daemon-guard: all checks passed");
process.exit(fails ? 1 : 0);
