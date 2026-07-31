#!/usr/bin/env node
// dev-loop merge-guard — pre-merge guard: refuse merge when a human objects or the PR's ticket is
// not merge-eligible. Design: hubDoc:design/merge-review-guard.
// Child 1 (LOOP-64): human review-objection axis (§3.1/§3.2/§3.4) via the LOOP-40 landing.ts seam.
// Child 4 (LOOP-67): board-state axis (§3.3) — hub-only, no forge access required.
import { execFileSync } from "node:child_process";
import { isMainEntry } from "./is-entry.ts";
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { resolveHubDbPath, tryResolveWorkspace } from "./workspace.ts";
import { readPrReviewState, defaultGhExec, type ExecFn } from "./landing.ts";

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

export interface ForgeReviewResult {
  trip: boolean;
  skipped: boolean; // true when no PR provided or forge failed → no false trip
  changeRequesters: string[];        // non-agent logins that CHANGES_REQUESTED
  unresolvedThreadAuthors: string[]; // non-agent logins with ≥1 unresolved thread
}

export interface MergeGuardResult {
  trip: boolean;
  boardState: MergeGuardBoardStateResult;
  forgeReview: ForgeReviewResult;
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

// Best-effort: extract owner/repo from the git remote URL of the repo dir.
// Returns null when the repo has no GitHub remote or git is not available.
function resolveGhRepo(repoDir: string): string | null {
  try {
    const remote = execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return m ? m[1]! : null;
  } catch { return null; }
}

// Best-effort: read team.agentReviewers from workspace config (absent ⇒ []).
function resolveAgentReviewers(repoDir: string): string[] {
  try {
    const ws = tryResolveWorkspace(repoDir);
    if (!ws) return [];
    return (ws.file.team as unknown as { agentReviewers?: string[] }).agentReviewers ?? [];
  } catch { return []; }
}

export function mergeGuard(
  repoDir: string,
  opts: {
    ticketId?: string;
    dbPath?: string;
    // Forge review axis (Child 1 / LOOP-64):
    pr?: number | string;      // PR number or branch name; absent → forge axis skipped
    ghRepo?: string;           // owner/repo (inferred from git remote when absent)
    agentReviewers?: string[]; // agent logins to ignore (read from workspace when absent)
    exec?: ExecFn;             // injectable gh exec for tests (defaults to defaultGhExec)
  } = {},
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

  let boardState: MergeGuardBoardStateResult;
  if (!ticketId) {
    boardState = { ticketId: null, ticketState: null, trip: false, skipped: false };
  } else {
    // Resolve dbPath: explicit > DEVLOOP_HUB_DB env > workspace-inferred
    const dbPath = opts.dbPath ?? process.env.DEVLOOP_HUB_DB ?? resolveHubDbPath(repoDir);
    if (!dbPath || !existsSync(dbPath)) {
      boardState = { ticketId, ticketState: null, trip: false, skipped: true };
    } else {
      let conn;
      try { conn = openDb(dbPath); }
      catch { conn = null; }
      if (!conn) {
        boardState = { ticketId, ticketState: null, trip: false, skipped: true };
      } else {
        try {
          const row = conn.prepare("SELECT state FROM tickets WHERE id=?").get(ticketId) as { state: string } | undefined;
          if (!row) {
            boardState = { ticketId, ticketState: null, trip: false, skipped: false };
          } else {
            const trip = NOT_MERGE_ELIGIBLE.has(row.state);
            boardState = { ticketId, ticketState: row.state, trip, skipped: false };
          }
        } finally {
          conn.close();
        }
      }
    }
  }

  // ── Forge review axis (§3.1/§3.2/§3.4 — Child 1 / LOOP-64) ──────────────
  // Read PR review state via the landing.ts seam. Degrades to skip on any failure.
  // No PR ⇒ skipped (can't check without a PR reference).
  let forgeReview: ForgeReviewResult;
  if (opts.pr === undefined || opts.pr === null) {
    forgeReview = { trip: false, skipped: true, changeRequesters: [], unresolvedThreadAuthors: [] };
  } else {
    const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
    if (!ghRepo) {
      // Non-GitHub remote or can't resolve → degrade silently (§3.4)
      forgeReview = { trip: false, skipped: true, changeRequesters: [], unresolvedThreadAuthors: [] };
    } else {
      const exec = opts.exec ?? defaultGhExec;
      const prState = readPrReviewState(ghRepo, opts.pr, { exec });
      if (!prState) {
        // Forge failure (gh missing/unauth/offline/timeout/no-PR) → degrade (§3.4)
        forgeReview = { trip: false, skipped: true, changeRequesters: [], unresolvedThreadAuthors: [] };
      } else {
        // Agent-reviewer exclusion (§3.2): ignore any reviewer whose login is in the agent set.
        const agentSet = new Set(opts.agentReviewers ?? resolveAgentReviewers(repoDir));
        const humanChangeRequesters = prState.changeRequesters.filter((l) => !agentSet.has(l));
        const humanThreadAuthors = prState.unresolvedThreadAuthors.filter((l) => !agentSet.has(l));
        const forgeTrip = humanChangeRequesters.length > 0 || humanThreadAuthors.length > 0;
        forgeReview = {
          trip: forgeTrip,
          skipped: false,
          changeRequesters: humanChangeRequesters,
          unresolvedThreadAuthors: humanThreadAuthors,
        };
      }
    }
  }

  const trip = boardState.trip || forgeReview.trip;
  return { trip, boardState, forgeReview };
}

// CLI: dev-loop merge-guard [--repo <dir>] [--pr <n>] [--ticket <id>] [--strict] [--json]
// Exit codes (the write-layer contract): 0 clean/advisory/degraded · 1 trip under --strict · 2 usage.
if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  let ticketId: string | undefined;
  let pr: number | string | undefined;
  let strict = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--ticket") ticketId = argv[++i];
    else if (a === "--pr") pr = argv[++i];
    else if (a === "--strict") strict = true;
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(`dev-loop merge-guard — refuse merge on a human CHANGES_REQUESTED or a non-merge-eligible ticket.
Design: hubDoc:design/merge-review-guard §3.1/§3.2/§3.3/§3.4 (LOOP-64 Child 1 + LOOP-67 Child 4).

Usage: dev-loop merge-guard [--repo <dir>] [--pr <n>] [--ticket <id>] [--strict] [--json]
  --pr <n>        PR number (enables forge review axis — §3.1: CHANGES_REQUESTED / unresolved threads)
  --ticket <id>   explicit ticket id (default: inferred from HEAD branch dev-loop/<id>)
  --strict        exit 1 when either axis trips (the merge-pass gate)
  --json          emit result as JSON

Forge review axis (--pr): trips when a non-agent reviewer has CHANGES_REQUESTED or an unresolved
  review thread. Degrades silently (exit 0) when gh is unavailable, unauth, offline, or no PR found.
Board-state axis: trips when the ticket is In Review / Canceled / Duplicate.
  Degrades silently (exit 0) when no hub DB is available (linear/local backend).

Exit codes: 0 clean/advisory/degraded · 1 trip under --strict · 2 usage.`);
      process.exit(0);
    } else { console.error(`merge-guard: unknown option '${a}'`); process.exit(2); }
  }

  let result: MergeGuardResult;
  try { result = mergeGuard(repo, { ticketId, pr }); }
  catch (e) { console.error(`merge-guard: ${(e as Error).message.split("\n")[0]}`); process.exit(2); }

  const bs = result.boardState;
  const fr = result.forgeReview;
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Board-state axis output
    if (bs.skipped) {
      console.log(`merge-guard: board-state axis skipped — no hub DB available (linear/local backend)`);
    } else if (!bs.ticketId) {
      console.log(`merge-guard: no ticket resolved — pass --ticket <id> or run from a dev-loop/<id> branch`);
    } else if (bs.trip) {
      console.error(`merge-guard: ⛔ TRIP — ticket ${bs.ticketId} is ${bs.ticketState} (not merge-eligible); do not merge until the gate clears`);
    } else {
      console.log(`merge-guard: ticket ${bs.ticketId} is ${bs.ticketState ?? "unknown"} — merge-eligible on the board-state axis`);
    }
    // Forge review axis output
    if (fr.skipped && pr !== undefined) {
      console.log(`merge-guard: forge review axis skipped — gh unavailable, forge unreachable, or no PR found`);
    } else if (!fr.skipped && fr.trip) {
      const who = [...fr.changeRequesters, ...fr.unresolvedThreadAuthors].filter((v, i, a) => a.indexOf(v) === i);
      console.error(`merge-guard: ⛔ TRIP — PR has unresolved objection from ${who.map((l) => `@${l}`).join(", ")} (CHANGES_REQUESTED or unresolved thread); must be addressed before merging`);
    } else if (!fr.skipped && !fr.trip) {
      console.log(`merge-guard: forge review axis clean — no non-agent CHANGES_REQUESTED or unresolved threads`);
    }
  }

  process.exit(strict && result.trip ? 1 : 0);
}
