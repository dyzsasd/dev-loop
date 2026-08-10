// Test runner — discovers every hub/test/*.ts suite, runs each in a subprocess,
// collects pass/fail/crash, and exits non-zero when any suite did not pass.
// Adding a new test file is automatically picked up; no manifest to edit.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const here = dirname(fileURLToPath(import.meta.url));

// Per-suite env additions inherited from the original &&-chain.
const SUITE_ENV: Record<string, Record<string, string>> = {
  "agent-api.ts": {
    DEVLOOP_CHANNEL_DRYRUN: "1",
    DEVLOOP_CHANNEL_TOKEN: "xoxb-DRYRUNSECRET",
    DEVLOOP_MIRROR_DRYRUN: "1",
  },
  "shim.ts": {
    DEVLOOP_CHANNEL_DRYRUN: "1",
    DEVLOOP_CHANNEL_TOKEN: "xoxb-DRYRUNSECRET",
    DEVLOOP_MIRROR_DRYRUN: "1",
  },
};

// Files matching hub/test/*.ts that are NOT standalone suites (shared helpers imported by real
// suites). Without this, glob-discovery runs them as phantom "passing" tests. Each entry carries a
// one-line reason, so "this file is not a suite" is a visible, reviewable decision — not a silent
// glob miss. LOOP-139 introduced the constant + the filter/--list mechanism below; entries are added
// as helpers are identified (e.g. daemon-harness.ts under LOOP-138).
const NON_SUITES: Record<string, string> = {
  "daemon-harness.ts": "shared helper — exports startTestDaemon/registerDaemonPid/runDaemonCli/launchDaemonCli; no assertions, not a standalone suite (LOOP-138)",
  "env-scrub.ts": "shared helper — exports FIRE_MARKER_VARS/scrubFireEnv, the ONE fire-marker union (LOOP-156); no assertions, not a standalone suite. Its BEHAVIOUR is asserted by env-scrub-guard.ts, which is a real suite and stays discovered.",
};

const suites = readdirSync(here)
  .filter((f) => f.endsWith(".ts") && f !== "run-all.ts" && !Object.hasOwn(NON_SUITES, f))
  .sort();

// `--list`: print the discovered suites + the NON_SUITES exclusions as JSON and exit WITHOUT running
// anything — the machine-readable discovery surface run-all-runner.ts (LOOP-139) asserts against
// `git ls-files 'hub/test/*.ts'`, so a future filter/extension change can't silently drop a suite
// from the ship gate.
if (process.argv.includes("--list")) {
  console.log(JSON.stringify({ discovered: suites, nonSuites: NON_SUITES }));
  process.exit(0);
}

// A per-suite wall-clock bound. Overridable for a slow machine, but never unbounded.
const SUITE_TIMEOUT_MS = Number(process.env.DEVLOOP_SUITE_TIMEOUT_MS) || 300_000;

type Status = "pass" | "fail" | "crash";
const results: { file: string; status: Status }[] = [];

for (const file of suites) {
  const env = { ...scrubFireEnv(), ...(SUITE_ENV[file] ?? {}) };
  const res = spawnSync("node", [join(here, file)], {
    env,
    // stdout: inherit so test output streams in real-time
    // stderr: pipe so we can detect uncaught-exception crashes
    stdio: ["inherit", "inherit", "pipe"],
    // A HANGING suite must fail, not stall the run. Without this the loop waits forever: one suite
    // that never returns burned an 80-minute CI job with no output past its last assertion and no
    // indication of which suite was at fault, until the 6h GitHub ceiling or a human cancelled it.
    // The cause there was `mkdirSync(recursive)` under /proc on Linux — a platform difference no
    // amount of local macOS testing would have surfaced, which is precisely why the runner needs a
    // bound rather than trusting every suite to terminate.
    // 5 min is ~10x the slowest suite (the daemon lifecycle ones run ~30s); it catches a hang
    // without ever firing on a merely slow machine.
    timeout: SUITE_TIMEOUT_MS,
    killSignal: "SIGKILL",  // SIGTERM is catchable, and a wedged suite may not be handling signals
  });

  const stderr = res.stderr?.toString() ?? "";
  if (stderr) process.stderr.write(stderr);

  let status: Status;
  // spawnSync reports a timeout as error.code ETIMEDOUT (and/or the kill signal). Name it, so the
  // summary says which suite hung instead of leaving a bare "crash" for a human to bisect.
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    process.stderr.write(`\n⏱  ${file} exceeded ${SUITE_TIMEOUT_MS / 1000}s and was killed — treat this as a HANG, not a slow test.\n`);
    status = "crash";
  } else if (res.error || res.signal != null) {
    status = "crash";
  } else if (res.status === 0) {
    status = "pass";
  } else if (/^(Uncaught |Error: |node:internal)/m.test(stderr)) {
    status = "crash";
  } else {
    status = "fail";
  }

  results.push({ file, status });
}

const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;
const crashed = results.filter((r) => r.status === "crash").length;
const total = results.length;

const nonPassing = results.filter((r) => r.status !== "pass");
if (nonPassing.length) {
  console.log("\nNon-passing suites:");
  for (const r of nonPassing)
    console.log(`  [${r.status.toUpperCase()}] ${r.file}`);
}

console.log(`\nSUITES: ${passed} passed, ${failed} failed, ${crashed} crashed (${total} total)`);
process.exit(nonPassing.length > 0 ? 1 : 0);
