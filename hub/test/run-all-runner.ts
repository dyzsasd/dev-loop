// LOOP-139 — the ship gate's own gate. hub/test/run-all.ts is the sole guarantee that every
// hub/test/*.ts suite actually runs (LOOP-86 replaced the 78-link `&&` chain + deleted the
// `expected_test_paths` scanner that used to hold "every tracked test runs"). This suite makes that
// invariant durable: it drives run-all.ts against SYNTHETIC suites in a throwaway temp dir — never
// the real hub/test/ tree, never a daemon — and asserts its classification, non-halting behaviour,
// and exit code; then (AC4) it asserts run-all.ts's REAL discovery is complete against
// `git ls-files 'hub/test/*.ts'`, the check that replaces the deleted scanner.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(here, "run-all.ts");        // the real runner under test
const repoRoot = join(here, "..", "..");         // hub/test → hub → repo root (worktree root)
const NODE = process.env.DEVLOOP_NODE || process.execPath;

let fails = 0;
const ok = (cond: boolean, m: string): void => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// Run a COPY of the real run-all.ts against a temp dir of synthetic suites and capture its output.
// run-all.ts is dependency-free (node builtins only), so the copy runs standalone; it globs its own
// dir, so it discovers exactly the synthetic files we write. The env strips the SUITE_ENV carve-out
// vars so AC5 observes only what run-all.ts itself injects, never an ambient value.
function runSynthetic(files: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "run-all-runner-"));
  try {
    copyFileSync(RUNNER, join(dir, "run-all.ts"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const env = { ...process.env };
    delete env.DEVLOOP_CHANNEL_DRYRUN; delete env.DEVLOOP_CHANNEL_TOKEN; delete env.DEVLOOP_MIRROR_DRYRUN;
    const r = spawnSync(NODE, [join(dir, "run-all.ts")], { encoding: "utf8", timeout: 30_000, env });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── AC1 — a non-zero suite: every suite still runs, exit non-zero, non-passing names it, summary counts ──
{
  const r = runSynthetic({
    "a-ok.ts": "process.exit(0);\n",
    "b-fail.ts": "process.exit(1);\n",
  });
  ok(r.status === 1, `AC1: a failing suite → runner exits non-zero (got ${r.status})`);
  ok(/\[FAIL\] b-fail\.ts/.test(r.stdout), "AC1: the non-passing list names the failing file ([FAIL] b-fail.ts)");
  ok(/SUITES: 1 passed, 1 failed, 0 crashed \(2 total\)/.test(r.stdout), "AC1: summary = 1 passed, 1 failed, 0 crashed (2 total)");
}

// ── AC2 — an uncaught throw is classified `crashed` (not failed), and a suite ordered AFTER it still runs ──
{
  const r = runSynthetic({
    "a-throw.ts": "throw new Error('boom');\n",                      // sorts before b-after.ts
    "b-after.ts": "console.log('B_AFTER_RAN'); process.exit(0);\n",
  });
  ok(/\[CRASH\] a-throw\.ts/.test(r.stdout), "AC2: an uncaught throw is classified [CRASH]");
  ok(!/\[FAIL\] a-throw\.ts/.test(r.stdout), "AC2: the throwing suite is NOT misclassified as [FAIL]");
  ok(/B_AFTER_RAN/.test(r.stdout), "AC2: a suite ordered after the crash still runs (non-halting)");
  ok(/SUITES: 1 passed, 0 failed, 1 crashed \(2 total\)/.test(r.stdout), "AC2: summary counts the crash (1 passed, 0 failed, 1 crashed, 2 total)");
}

// ── AC3 — an all-green set exits 0 and passed === total ──
{
  const r = runSynthetic({
    "a-ok.ts": "process.exit(0);\n",
    "b-ok.ts": "process.exit(0);\n",
  });
  ok(r.status === 0, `AC3: all-green → exit 0 (got ${r.status})`);
  ok(/SUITES: 2 passed, 0 failed, 0 crashed \(2 total\)/.test(r.stdout), "AC3: all-green summary = 2 passed, 0 failed, 0 crashed (passed === total)");
}

// ── AC-LOOP138 — a file listed in NON_SUITES is excluded from discovery and not counted in the total ──
{
  const r = runSynthetic({
    "a-ok.ts": "process.exit(0);\n",
    "daemon-harness.ts": "export function startTestDaemon() {};\n",  // NON_SUITES entry
  });
  ok(r.status === 0, `AC-LOOP138: NON_SUITES helper excluded → runner exits 0 (got ${r.status})`);
  ok(/SUITES: 1 passed, 0 failed, 0 crashed \(1 total\)/.test(r.stdout),
    "AC-LOOP138: daemon-harness.ts excluded from suite count by NON_SUITES (1 total, not 2)");
  ok(!/daemon-harness\.ts/.test(r.stdout),
    "AC-LOOP138: daemon-harness.ts does not appear in any output line (not run, not listed)");
}

// ── AC5 — the SUITE_ENV carve-outs survive: agent-api.ts + shim.ts receive the 3 env vars; others do not ──
{
  const probe = "const n = import.meta.url.split('/').pop();"
    + " console.log(`SUITE ${n} DRYRUN=${process.env.DEVLOOP_CHANNEL_DRYRUN ?? 'unset'}"
    + " TOKEN=${process.env.DEVLOOP_CHANNEL_TOKEN ? 'set' : 'unset'} MIRROR=${process.env.DEVLOOP_MIRROR_DRYRUN ?? 'unset'}`);"
    + " process.exit(0);\n";
  const r = runSynthetic({ "agent-api.ts": probe, "shim.ts": probe, "other.ts": probe });
  ok(/SUITE agent-api\.ts DRYRUN=1 TOKEN=set MIRROR=1/.test(r.stdout), "AC5: agent-api.ts receives DEVLOOP_CHANNEL_DRYRUN + _TOKEN + MIRROR_DRYRUN");
  ok(/SUITE shim\.ts DRYRUN=1 TOKEN=set MIRROR=1/.test(r.stdout), "AC5: shim.ts receives the same carve-out env");
  ok(/SUITE other\.ts DRYRUN=unset TOKEN=unset MIRROR=unset/.test(r.stdout), "AC5: an unlisted suite receives NONE of the carve-out env");
}

// ── AC4 — REAL discovery is complete (the check that replaces the deleted expected_test_paths scanner) ──
// Every tracked hub/test/*.ts (except run-all.ts itself) must be either discovered by run-all.ts or
// named on the in-repo NON_SUITES exclusion list; and the discovered set must contain nothing
// untracked. Derived from `git ls-files`, never a hardcoded list — so it fails if a future filter
// change, extension change, or a silent glob miss drops a suite from the ship gate.
{
  const listRaw = spawnSync(NODE, [RUNNER, "--list"], { encoding: "utf8", timeout: 30_000 }).stdout;
  const list = JSON.parse(listRaw) as { discovered: string[]; nonSuites: Record<string, string> };
  const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "hub/test"], { encoding: "utf8" })
    .split("\n").filter((l) => /^hub\/test\/[^/]+\.ts$/.test(l)).map((l) => l.slice("hub/test/".length));
  const discoveredSet = new Set(list.discovered);
  const excluded = new Set(Object.keys(list.nonSuites));

  ok(tracked.length > 0, `AC4: git ls-files resolved the tracked hub/test suites (${tracked.length} found)`);
  const missing = tracked.filter((f) => f !== "run-all.ts" && !discoveredSet.has(f) && !excluded.has(f));
  ok(missing.length === 0, `AC4: every tracked suite is discovered or NON_SUITES-excluded (missing: ${missing.join(", ") || "none"})`);
  const untracked = list.discovered.filter((f) => !tracked.includes(f));
  ok(untracked.length === 0, `AC4: the discovered set contains nothing untracked (untracked: ${untracked.join(", ") || "none"})`);

  // ── AC6 — the new suite is itself discovered by run-all.ts (the property under test) ──
  ok(discoveredSet.has("run-all-runner.ts"), "AC6: run-all-runner.ts is discovered by run-all.ts's own glob");
}

console.log(fails === 0 ? "\nRUN_ALL_RUNNER_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
