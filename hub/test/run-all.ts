// Test runner — discovers every hub/test/*.ts suite, runs each in a subprocess,
// collects pass/fail/crash, and exits non-zero when any suite did not pass.
// Adding a new test file is automatically picked up; no manifest to edit.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runningDaemonPids, DAEMON_ENTRY_PATTERN } from "./daemon-pids.ts"; // the ONE daemon-pid listing
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture
import { tmpRoot } from "./tmp-root.ts"; // the runner takes its own temp root through the same helper it enforces

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
  "daemon-pids.ts": "shared helper — exports runningDaemonPids/DAEMON_ENTRY_PATTERN, the ONE daemon-process listing this runner's leaked-daemon gate reads; no assertions, not a standalone suite.",
  "code-only.ts": "shared helper — exports codeOnly, the ONE source-to-executable-text reduction (LOOP-396, extracted from destructive-guard.ts); no assertions, not a standalone suite. Its BEHAVIOUR is asserted by destructive-guard.ts's probe arms, which are a real suite and stay discovered.",
  "tmp-root.ts": "shared helper - exports tmpRoot, the ONE temp-root factory; each tree it hands out is registered for removal at process exit. No assertions, not a standalone suite. Its BEHAVIOUR is asserted by tmp-root-sweep.ts, which is a real suite and stays discovered.",
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

// ── Leaked-daemon gate ────────────────────────────────────────────────────────────────────────────
// A `daemon up` (directly, or through `dev-loop up`'s board ensure) forks a DETACHED, unref'd child
// that outlives the CLI that started it. A suite that starts one and does not stop it leaves a live
// process holding a port in the production band — measured as nine of them at once, each with its cwd
// in a fixture directory that had been deleted, and as EADDRINUSE in an unrelated repo that binds
// 8790. Nothing failed; the run went green and the operator found the processes by hand.
//
// The gate compares the pid SET before and after: a daemon that was already running (the operator's
// own board) is not this run's business, and a new one is, whatever suite produced it. pgrep only —
// no cwd probing, so it costs nothing and reads the same on macOS and Linux. A machine without pgrep
// prints that the gate did not run rather than passing silently.
const daemonsBefore = runningDaemonPids();

// Where a suite reports the temp roots it took, so this runner can remove them even when the suite is
// killed before its own exit hook runs. tmp-root.ts deliberately installs no signal handler (several
// suites assert on signal delivery), which leaves the SIGKILL path — this ceiling's own kill signal —
// with no in-suite cleanup at all.
const manifestDir = tmpRoot("dl-runner-manifest-");

for (const file of suites) {
  const manifest = join(manifestDir, `${file}.roots`);
  writeFileSync(manifest, "");
  const env = { ...scrubFireEnv(), DEVLOOP_TEST_TMP_MANIFEST: manifest, ...(SUITE_ENV[file] ?? {}) };
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

  // Drain the manifest. After a normal exit the suite already swept, so every path is gone and this is a
  // no-op; what survives is what the suite could not remove. Report it — the residue is the symptom, and
  // silently accumulating it is how 3264 directories and 1.3 GB went unnoticed for four days.
  const stranded = readFileSync(manifest, "utf8").split("\n").filter((d) => d && existsSync(d));
  for (const dir of stranded) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort — cleanup never fails a run */ }
  }
  if (stranded.length > 0) {
    process.stderr.write(`\n🧹 ${file} ended without sweeping ${stranded.length} temp root(s); the runner removed them.\n`);
  }

  results.push({ file, status });
}
rmSync(manifestDir, { recursive: true, force: true }); // tmpRoot sweeps it at exit too; this keeps the run tidy meanwhile

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

let leakedDaemons = 0;
if (daemonsBefore === null) {
  console.log("DAEMON LEAK GATE: skipped — `pgrep` is not available on this machine.");
} else {
  const after = runningDaemonPids() ?? new Set<number>();
  const leaked = [...after].filter((pid) => !daemonsBefore.has(pid));
  leakedDaemons = leaked.length;
  if (leaked.length) {
    console.log(`\nLEAKED DAEMONS: ${leaked.length} process(es) matching '${DAEMON_ENTRY_PATTERN}' outlived this run: ${leaked.join(", ")}.`);
    console.log("  A suite that starts a daemon must stop it (daemon-harness.ts registerDaemonPid covers the detached case).");
    console.log("  Inspect one with: ps -o lstart=,command= -p <pid> ; lsof -p <pid> | awk '$4==\"cwd\"'");
  }
}

process.exit(nonPassing.length > 0 || leakedDaemons > 0 ? 1 : 0);
