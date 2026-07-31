#!/usr/bin/env node
// dev-loop merge-guard — pre-merge guard: refuse merge when the PR's ticket is not merge-eligible.
// Design: hubDoc:design/merge-review-guard §3.3 + §8-Child4 (LOOP-67).
// Child 4 (board-state axis, hub-only) ships first — NOT blocked by LOOP-40.
// Child 1 (human review-objection axis, forge-read) awaits LOOP-40 (landing.ts).
import { execFileSync } from "node:child_process";
import { isMainEntry } from "./is-entry.ts";
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { resolveHubDbPath } from "./workspace.ts";

// Board states that are NOT merge-eligible (design §3.3).
// In Review = PR's verify gate is still open; Canceled/Duplicate = terminal reject.
// Todo/In Progress are merge-eligible on this axis (no trip).
const NOT_MERGE_ELIGIBLE = new Set(["In Review", "Canceled", "Duplicate"]);

export interface MergeGuardBoardStateResult {
  ticketId: string | null;
  ticketState: string | null;
  trip: boolean;
  skipped: boolean; // true when no hub DB — axis not evaluated (no false trip)
}

export interface MergeGuardResult {
  trip: boolean;
  boardState: MergeGuardBoardStateResult;
}

// Parse a ticket id from a dev-loop/<id> branch name or a fix/<id>-… branch name.
// Returns null when the branch shape doesn't carry a recognisable ticket id.
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;
function ticketFromBranch(branch: string): string | null {
  const m = branch.match(/(?:dev-loop\/|fix\/)([^/\s]+)/);
  if (!m) return null;
  const hit = m[1].match(TICKET_RE);
  return hit ? hit[0] : null;
}

export function mergeGuard(
  repoDir: string,
  opts: { ticketId?: string; dbPath?: string } = {},
): MergeGuardResult {
  // ── Board-state axis (§3.3) ────────────────────────────────────────────────
  // Hub-only: reads tickets table, no forge access needed.
  // Degrades silently (skipped) when the hub DB is absent (linear/local backend).
  let ticketId = opts.ticketId ?? null;

  // If no explicit ticket, try to infer from the HEAD branch of the repo.
  // This allows `merge-guard --repo .` to work on a dev-loop/<id> branch without --ticket.
  if (!ticketId) {
    try {
      const br = execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      ticketId = ticketFromBranch(br);
    } catch { /* no git repo — skip branch inference */ }
  }

  if (!ticketId) {
    return {
      trip: false,
      boardState: { ticketId: null, ticketState: null, trip: false, skipped: false },
    };
  }

  // Resolve dbPath: explicit > DEVLOOP_HUB_DB env > workspace-inferred
  const dbPath = opts.dbPath ?? process.env.DEVLOOP_HUB_DB ?? resolveHubDbPath(repoDir);

  if (!dbPath || !existsSync(dbPath)) {
    return {
      trip: false,
      boardState: { ticketId, ticketState: null, trip: false, skipped: true },
    };
  }

  let conn;
  try { conn = openDb(dbPath); }
  catch { return { trip: false, boardState: { ticketId, ticketState: null, trip: false, skipped: true } }; }

  try {
    const row = conn.prepare("SELECT state FROM tickets WHERE id=?").get(ticketId) as { state: string } | undefined;
    if (!row) {
      // Ticket not in hub — unknown state, treat as merge-eligible (no false trip)
      return {
        trip: false,
        boardState: { ticketId, ticketState: null, trip: false, skipped: false },
      };
    }
    const trip = NOT_MERGE_ELIGIBLE.has(row.state);
    return {
      trip,
      boardState: { ticketId, ticketState: row.state, trip, skipped: false },
    };
  } finally {
    conn.close();
  }
}

// CLI: dev-loop merge-guard [--repo <dir>] [--ticket <id>] [--strict] [--json]
// Exit codes (the write-layer contract): 0 clean/advisory/degraded · 1 trip under --strict · 2 usage.
if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  let ticketId: string | undefined;
  let strict = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--ticket") ticketId = argv[++i];
    else if (a === "--strict") strict = true;
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(`dev-loop merge-guard — refuse merge when the PR's ticket is not merge-eligible.
Trips when the PR's ticket is In Review / Canceled / Duplicate (design merge-review-guard §3.3).
Hub-only axis (Child 4, LOOP-67) — no forge access required; degrades silently if no hub DB.

Usage: dev-loop merge-guard [--repo <dir>] [--ticket <id>] [--strict] [--json]
  --ticket <id>   explicit ticket id (default: inferred from HEAD branch dev-loop/<id>)
  --strict        exit 1 when the board-state axis trips (the merge-pass gate)
  --json          emit result as JSON

Exit codes: 0 clean/advisory/degraded · 1 trip under --strict · 2 usage.
Design: hubDoc:design/merge-review-guard §3.3 + §8-Child4 (LOOP-67).`);
      process.exit(0);
    } else { console.error(`merge-guard: unknown option '${a}'`); process.exit(2); }
  }

  let result: MergeGuardResult;
  try { result = mergeGuard(repo, { ticketId }); }
  catch (e) { console.error(`merge-guard: ${(e as Error).message.split("\n")[0]}`); process.exit(2); }

  const bs = result.boardState;
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (bs.skipped) {
      console.log(`merge-guard: board-state axis skipped — no hub DB available (linear/local backend)`);
    } else if (!bs.ticketId) {
      console.log(`merge-guard: no ticket resolved — pass --ticket <id> or run from a dev-loop/<id> branch`);
    } else if (bs.trip) {
      console.error(`merge-guard: ⛔ TRIP — ticket ${bs.ticketId} is ${bs.ticketState} (not merge-eligible); do not merge until the gate clears`);
    } else {
      console.log(`merge-guard: ticket ${bs.ticketId} is ${bs.ticketState ?? "unknown"} — merge-eligible on the board-state axis`);
    }
  }

  process.exit(strict && result.trip ? 1 : 0);
}
