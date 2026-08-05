// How a scheduler slot's FIRST fire is scheduled (LOOP-273).
//
// `dev-loop run` seeded every slot from PROCESS START, so a runner restart was a cadence reset:
// every selected slot fired on cold boot regardless of when it last ran. For a slow slot that is a
// full cadence per restart — reflect, on a 1d cadence, fired 5× in 13h (~$18) across five restarts.
//
// `scheduler-gate.json` records `firedAt` only for the four gated slots (pm/qa/senior/junior), so
// sweep and reflect had nothing to schedule from at all. The per-fire LEDGER records every fire of
// every agent, and that is the right anchor.
//
// Its own module because run-agents.ts calls main() unconditionally at import (LOOP-58), so nothing
// can import it to test this. A lean leaf: node builtins plus the ledger reader.
import { readFireRows } from "./metrics.ts";

/**
 * The newest fire timestamp per AGENT, in epoch ms.
 *
 * Matched by agent across ALL projects, because slots are per-agent: the target project is chosen
 * when the slot fires, so the cadence anchors to the agent rather than to any one project.
 *
 * Returns an empty map on ANY failure — missing, unreadable or garbled. A scheduler that refuses to
 * start because it cannot read a history file is worse than one that fires early, and "no anchor"
 * already means "fire on boot", which is the behaviour this replaces.
 */
export function lastFirePerAgent(ledgerPath: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!ledgerPath) return out;
  try {
    for (const r of readFireRows(ledgerPath)) {
      const agent = String((r as { agent?: unknown }).agent ?? "");
      const ms = Date.parse(String((r as { ts?: unknown }).ts ?? ""));
      if (!agent || !Number.isFinite(ms)) continue;
      if (!out.has(agent) || ms > (out.get(agent) as number)) out.set(agent, ms);
    }
  } catch { return new Map(); }
  return out;
}

export interface SeedDecision { nextAt: number; fireOnBoot: boolean; log: string }

/** Human-readable duration, matching the scheduler's own formatting for these log lines. */
function dur(ms: number): string {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * When should this slot first fire?
 *
 *   • an anchor exists AND anchor + cadence is still in the future ⇒ DEFER to that instant;
 *   • otherwise (no anchor, or due/overdue) ⇒ fire on boot, staggered by index — today's behaviour.
 *
 * A zero/absent cadence fires on boot: `due` would equal the anchor and defer the slot into the
 * past, which is a meaningless decision drawn from a meaningless cadence.
 *
 * Exactly-due fires. Deferring it would add a full extra cadence on every restart — the same class
 * of bug this function exists to remove.
 *
 * Only the INITIAL seed changes. The `.finally` re-seed, the change-gate and the breaker are
 * untouched, so steady-state cadence is completion-relative exactly as before.
 */
export function seedSlotNextAt(
  agent: string, index: number, lastFireAt: Map<string, number>,
  cadenceMs: number, nowMs: number, staggerMs: number,
): SeedDecision {
  const last = lastFireAt.get(agent);
  const due = last !== undefined && cadenceMs > 0 ? last + cadenceMs : 0;
  if (due > nowMs) {
    return { nextAt: due, fireOnBoot: false, log: `[${agent}] boot: next due in ${dur(due - nowMs)} (last fire ${new Date(last as number).toISOString()}) — deferred` };
  }
  const why = last === undefined ? "no recorded fire" : `last fire ${new Date(last).toISOString()}, overdue`;
  return { nextAt: nowMs + index * staggerMs, fireOnBoot: true, log: `[${agent}] boot: ${why} — firing on boot` };
}
