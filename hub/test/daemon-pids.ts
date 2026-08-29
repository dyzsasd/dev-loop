// daemon-pids.ts — the ONE listing of daemon processes running on this machine.
//
// NOT a suite (run-all.ts lists it under NON_SUITES): a leaf helper with no assertions. It exists as
// its own module rather than inside daemon-harness.ts because run-all.ts imports it, and run-all.ts
// is COPIED into a throwaway directory by run-all-runner.ts along with its leaf imports — while that
// suite also writes a stub `daemon-harness.ts` fixture to prove NON_SUITES exclusion. Keeping the
// listing in a separate leaf lets both hold: one definition, and a fixture that still fixtures.
//
// Used for leak detection: run-all.ts compares the set before and after a whole run, up-dry-launch.ts
// across a single command. A daemon is DETACHED and unref'd by design, so nothing reaps it when the
// process that started it exits — comparing pid sets is how a caller finds the ones it left behind.
import { spawnSync } from "node:child_process";

/** The argv fragment every source-checkout daemon process carries. */
export const DAEMON_ENTRY_PATTERN = "hub/src/daemon.ts";

/**
 * Every pid whose command line matches the daemon entry, or null when this machine has no `pgrep`.
 *
 * null and the empty set are different answers: null means the question was not asked, and a caller
 * that reports "no leaks" for it would be claiming a check it never ran.
 */
export function runningDaemonPids(): Set<number> | null {
  const r = spawnSync("pgrep", ["-f", DAEMON_ENTRY_PATTERN], { encoding: "utf8" });
  if (r.error) return null;
  // pgrep exits 1 with no output when nothing matches — that is an empty set, not a failure.
  return new Set((r.stdout ?? "").split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0));
}
