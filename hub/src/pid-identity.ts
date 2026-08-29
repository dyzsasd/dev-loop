// Does a pid still belong to the process a record claims it does?
//
// A zero-signal probe (`process.kill(pid, 0)`) answers "some process holds this pid", which is all a
// read-only report needs — scheduler-build.ts's schedulerAlive() says so explicitly, and for a report a
// recycled pid can only mean showing a stale record as live. A verb that SIGNALS is different: stop.ts
// exists because a field operator mis-killed processes during a provider switch (2026-07-23), and
// SIGTERM/SIGKILL to a recycled pid recreates exactly that. The lock already carries the evidence needed
// to tell the two apart — it records `startedAt` — but nothing compared it.
//
// Two independent signals, both read from one `ps` call:
//   - command: a recycled pid is running some other program, so the recorded hint is absent from argv.
//   - birth order: the record is written BY the process it names, so that process cannot have started
//     after the record did. Only the "started later" direction is treated as a mismatch, which keeps a
//     clock skew or a slow write from producing a false refusal.
import { spawnSync } from "node:child_process";

/** A process's start time and full command, or null when the pid is gone or ps is unavailable. */
export function pidInfo(pid: number): { startedAtMs: number | null; command: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const r = spawnSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const line = (r.stdout ?? "").trim();
  if (!line) return null;
  // `lstart` is a fixed 24-char ctime string ("Sat Aug 29 19:18:15 2026"); the command is the remainder.
  const m = /^(\w{3} \w{3} ?\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/s.exec(line);
  if (!m) return { startedAtMs: null, command: line };
  const parsed = Date.parse(m[1]!);
  return { startedAtMs: Number.isFinite(parsed) ? parsed : null, command: m[2] ?? "" };
}

export interface PidIdentity { ok: boolean; why: string }

/**
 * Confirm `pid` is still the process `record` describes, before signalling it.
 *
 * `commandHint` is matched as a substring of the process's argv (e.g. "run-agents" matches both the
 * source and the built entry point). `recordedStartedAt` is the ISO timestamp the record carries.
 * Tolerance covers the gap between spawn and the record's own write.
 */
export function pidMatchesRecord(
  pid: number,
  recordedStartedAt: string | undefined,
  commandHint: string,
  toleranceMs = 60_000,
): PidIdentity {
  const info = pidInfo(pid);
  if (!info) return { ok: false, why: `pid ${pid} is gone` };
  if (commandHint && !info.command.includes(commandHint)) {
    return { ok: false, why: `pid ${pid} is running something else (${info.command.slice(0, 120)}), not ${commandHint}` };
  }
  const recorded = recordedStartedAt ? Date.parse(recordedStartedAt) : NaN;
  if (Number.isFinite(recorded) && info.startedAtMs !== null && info.startedAtMs > recorded + toleranceMs) {
    return {
      ok: false,
      why: `pid ${pid} started ${new Date(info.startedAtMs).toISOString()}, after the record was written ${recordedStartedAt} — the pid was recycled`,
    };
  }
  return { ok: true, why: `pid ${pid} matches the record` };
}
