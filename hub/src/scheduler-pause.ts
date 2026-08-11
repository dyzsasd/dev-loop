// Scheduler pause state — is the loop paused, by whom, why, and until when?
// LOOP-401 Child 1: zod-free leaf, read-time expiry, pure readers.
import type { DatabaseSync } from "node:sqlite";

export interface PauseState {
  pausedAt: string;        // ISO — the ORIGINAL pause instant
  actor: string;
  reason: string;
  until: string | null;    // ISO or null
}

/** The live pause, or null when not paused / already expired. PURE — never writes. */
export function readPause(db: DatabaseSync, nowMs?: number): PauseState | null {
  const row = db.prepare("SELECT paused_at, actor, reason, until FROM scheduler_pause WHERE id = 1").get() as
    { paused_at: string; actor: string; reason: string; until: string | null } | undefined;

  if (!row) return null;

  const now = nowMs ?? Date.now();
  if (row.until) {
    const untilMs = new Date(row.until).getTime();
    if (now >= untilMs) return null; // expired
  }

  return {
    pausedAt: row.paused_at,
    actor: row.actor,
    reason: row.reason,
    until: row.until
  };
}

/** Idempotent. A second pause updates actor/reason/until and PRESERVES the original pausedAt. */
export function writePause(
  db: DatabaseSync,
  actor: string,
  reason: string,
  until: string | null,
  nowMs?: number
): PauseState {
  const now = new Date(nowMs ?? Date.now()).toISOString();
  const existing = db.prepare("SELECT paused_at FROM scheduler_pause WHERE id = 1").get() as
    { paused_at: string } | undefined;

  const pausedAt = existing?.paused_at ?? now;

  db.prepare(
    "INSERT OR REPLACE INTO scheduler_pause (id, paused_at, actor, reason, until) VALUES (1, ?, ?, ?, ?)"
  ).run(pausedAt, actor, reason, until);

  return { pausedAt, actor, reason, until };
}

/** Idempotent. Returns false when nothing was paused. */
export function clearPause(db: DatabaseSync): boolean {
  const result = db.prepare("DELETE FROM scheduler_pause WHERE id = 1").run();
  return result.changes > 0;
}

/** The ONE human rendering — doctor, the UI banner and the fire context all call this. */
export function formatPause(p: PauseState, nowMs?: number): string {
  const now = nowMs ?? Date.now();
  const pausedAtMs = new Date(p.pausedAt).getTime();
  const ageMs = now - pausedAtMs;

  // Age string: hours + minutes
  const hours = Math.floor(ageMs / (1000 * 60 * 60));
  const minutes = Math.floor((ageMs % (1000 * 60 * 60)) / (1000 * 60));
  const ageStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  let result = `paused ${ageStr} ago by ${p.actor}: ${p.reason}`;

  if (p.until) {
    const untilMs = new Date(p.until).getTime();
    const untilHours = Math.floor((untilMs - now) / (1000 * 60 * 60));
    const untilMinutes = Math.floor(((untilMs - now) % (1000 * 60 * 60)) / (1000 * 60));

    if (untilHours > 0 || untilMinutes > 0) {
      const untilStr = untilHours > 0 ? `${untilHours}h ${untilMinutes}m` : `${untilMinutes}m`;
      result += ` (until ${untilStr} from now)`;
    }
  }

  return result;
}
