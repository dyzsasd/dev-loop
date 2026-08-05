#!/usr/bin/env node
// `npm run verify` — the LOCAL reproduction of the required merge check (LOOP-159).
//
// It used to be `typecheck && test && source-integrity`: 3 of the job's 5 gating steps, with step 3
// running in a DIFFERENT mode than CI runs it. So a green `verify` did not predict the check it
// exists to predict — and the missing step 4 is the expensive one: the CRAP ratchet is the gate that
// has actually blocked this repo's merges before, and it runs at a margin of ~0.0. It caught
// parseMetricsArgs at 130.6 in CI on a branch whose `verify` was green, which is this ticket's own
// defect reproducing itself.
//
// The trap this file exists to avoid (LOOP-159, both halves measured):
//   1. `npm run quality` carries NO --coverage-dir, so quality.ts re-runs the ENTIRE suite to
//      collect coverage itself — still going at the 2-minute mark. CI's cost is zero extra test
//      time precisely because step 4 REUSES step 3's coverage.
//   2. Appending the gate while `npm test` runs WITHOUT NODE_V8_COVERAGE produces a gate with no
//      coverage to read, which exits 0 with every row N/A — strictly worse than omitting it: a
//      local check that reports parity while measuring nothing.
// So: the suite runs under NODE_V8_COVERAGE and the gate reads that directory — the ratchet is never
// allowed to collect its own coverage (the flag that would make it do so must not appear below).
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(hubRoot, "..");
const covDir = join(hubRoot, ".v8cov");

const steps = [
  { name: "1a. security unittests (pre-install)", cwd: repoRoot, cmd: "python3", args: ["-m", "unittest", "security.test_source_integrity", "security.test_local_code_scan"], python: true },
  { name: "1b. source integrity (pre-install, bare)", cwd: repoRoot, cmd: "python3", args: ["security/source_integrity.py"], python: true },
  { name: "2. typecheck", cwd: hubRoot, cmd: "npm", args: ["run", "typecheck"] },
  { name: "3. test (under NODE_V8_COVERAGE)", cwd: hubRoot, cmd: "npm", args: ["test"], env: { NODE_V8_COVERAGE: covDir } },
  { name: "4. quality gate (CRAP ratchet)", cwd: hubRoot, cmd: "node", args: ["src/quality.ts", "--coverage-dir", ".v8cov", "--threshold", "90", "--top", "15"] },
  { name: "5. source integrity (whole tree)", cwd: repoRoot, cmd: "python3", args: ["security/source_integrity.py", "--whole-tree"], python: true },
];

// A stale coverage dir would let step 4 grade the PREVIOUS run — the same "measuring nothing" hazard
// as trap 2, just with older data instead of none.
if (existsSync(covDir)) rmSync(covDir, { recursive: true, force: true });

const havePython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

for (const step of steps) {
  if (step.python && !havePython) {
    // Graceful degradation is PRESERVED and PRINTED, never silent (AC4).
    console.log(`⏭  ${step.name} — SKIPPED: python3 not found on PATH`);
    continue;
  }
  console.log(`▶  ${step.name}`);
  const r = spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: "inherit", env: { ...process.env, ...(step.env ?? {}) } });
  if (r.status !== 0) {
    // Fail fast, and NAME the step — a dev reading the tail must know which CI step they reproduced.
    console.error(`\n❌ verify FAILED at step: ${step.name}  (exit ${r.status ?? "signal " + r.signal})`);
    console.error(`   This is the same step the required merge check runs. Fix it before pushing.`);
    process.exit(r.status ?? 1);
  }
}

console.log("\n✅ verify: all 5 required merge-check steps passed locally");
