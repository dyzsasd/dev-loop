// Render a duration for a human reader.
//
// Its own module because run-agents.ts runs main() unconditionally on import (LOOP-58, stated there:
// the entry guard was deleted because a percent-encoded import.meta.url made it fail silently), so
// nothing can import a helper out of it to assert on.
//
// The clean-divisor branches render an exact unit. What sent this here is the fall-through: it is only
// reachable with a NON-INTEGER millisecond count, which no configured cadence produces and every DERIVED
// duration can — perFireDeadline divides a dollar ceiling by a measured rate, and the budget watchdog
// printed `× 537322.2253925443ms` into the live run.log. Thirteen fractional digits of a millisecond is
// not a reading an operator can act on, and the value is a wall-clock deadline they are meant to judge.

/** A duration as an exact unit when it divides evenly, else the largest unit that reads cleanly. */
export function formatDuration(ms: number): string {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
