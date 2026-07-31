// AC-A4 regression guard: no hub/test/*.ts file (other than daemon-harness.ts) may directly
// spawn src/daemon.ts. All daemon-spawning tests must go through daemon-harness.ts so the
// ONE process.on("exit") SIGKILL sweep in that file covers every termination path.
//
// Rule: a line that contains BOTH "daemon.ts" and ("spawn" or "spawnSync") in a non-harness
// test file is a violation. daemon-harness.ts is the sole sanctioned entry point.
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
    if (trimmed.startsWith("//")) continue; // comment-only lines are not spawn calls
    if (/daemon\.ts/.test(trimmed) && /\bspawn(Sync)?\b/.test(trimmed)) {
      violations.push(`${file}:${i + 1}: ${trimmed}`);
    }
  }
}

ok(violations.length === 0,
  violations.length === 0
    ? "daemon-guard: no direct src/daemon.ts spawns in test files (all go through daemon-harness.ts)"
    : `daemon-guard: ${violations.length} direct spawn(s) of src/daemon.ts in test files — route through daemon-harness.ts:\n  ${violations.join("\n  ")}`);

console.log(fails ? `${fails} CHECK(S) FAILED` : "daemon-guard: all checks passed");
process.exit(fails ? 1 : 0);
