#!/usr/bin/env node
// dev-loop merge-guard — pre-merge guard: refuse merge when a human objects or the PR's ticket is
// not merge-eligible. Design: hubDoc:design/merge-review-guard.
// Child 1 (LOOP-64): human review-objection axis (§3.1/§3.2/§3.4) via the LOOP-40 landing.ts seam.
// Child 2 (LOOP-65): --apply path — board-visible objection + deliberate routing (§5.1).
// Child 4 (LOOP-67): board-state axis (§3.3) — hub-only, no forge access required.
//
// ── WHY A SKIP CARRIES A REASON, AND WHY ONE KIND OF SKIP EXITS NON-ZERO (LOOP-300) ──────────────
// §12c makes this command's EXIT CODE the machine gate on every feature-PR squash ("a non-zero exit
// HOLDS that merge"). Before LOOP-300 a run that evaluated BOTH axes and found them clean, and a run
// that evaluated NEITHER, both exited 0 — the difference lived only in prose on stdout. Run from the
// workspace root instead of the repo, the guard reported two "axis skipped" lines and exit 0, and the
// caller merged. Both protections it exists to provide — never merge over a human's objection, never
// merge a Canceled/Duplicate ticket's work — vanished silently from the wrong directory.
//
// §3.4's fail-open is deliberate and is PRESERVED: when the evidence is genuinely unreachable (no gh,
// forge down, no hub db) the guard degrades to a pass, so an outage never becomes a merge freeze. But
// "unreachable" and "you pointed me at nothing" are different facts and were collapsed into one
// `skipped: true` boolean. So every skip now carries a REASON, and reasons are classified:
//
//   unreachable  — the evidence exists but we could not reach it (outage)      ⇒ fail-open, exit 0
//   untargeted   — the invocation did not identify what to check (caller can fix) ⇒ EXIT_UNEVALUATED
//   inapplicable — reached the evidence; this axis has nothing to say about it ⇒ exit 0
//
// Under --strict, exit 3 (EXIT_UNEVALUATED) when NO axis was evaluated AND at least one skip is
// `untargeted`. Of AC1's two options — a distinct exit code, or "--strict requires ≥1 axis to have
// run" — this is the first, because the second cannot express the difference above: it would hold on
// a real forge outage too, converting §3.4's deliberate fail-open into a fail-closed. A distinct code
// also keeps `1 = tripped` meaning what it has always meant, so a caller can tell "a human objected"
// from "I could not check" without parsing prose. Existing callers that treat any non-zero as HOLD get
// the correct behaviour for free: a gate that evaluated nothing must not read as clean.
//
// The cwd dependency that produced the incident is removed at the source: --pr no longer needs the
// caller to stand in the repo (resolveGhRepo falls back to the workspace repo registry, which already
// records each repo's remote). EXIT_UNEVALUATED is the backstop for what that fallback cannot resolve
// — an unregistered repo, or an ambiguous multi-repo workspace, where guessing would be worse.
import { execFileSync } from "node:child_process";
import { isMainEntry } from "./is-entry.ts";
import { ticketIdScanRe } from "./ticket-id.ts";
import { existsSync } from "node:fs";
import { openDb } from "./db.ts";
import { resolveHubDbPath, tryResolveWorkspace } from "./workspace.ts";
import { readPrReviewState, defaultGhExec, type ExecFn } from "./landing.ts";
import { addComment, updateTicketRow, type TicketUpdateFields } from "./ticketwrite.ts";


// Board states that are NOT merge-eligible (design §3.3).
// In Review = PR's verify gate is still open; Canceled/Duplicate = terminal reject.
// Todo/In Progress are merge-eligible on this axis (no trip).
const NOT_MERGE_ELIGIBLE = new Set(["In Review", "Canceled", "Duplicate"]);

// Why an axis did not evaluate (LOOP-300). `null` ⇒ it DID evaluate. The set is closed so the
// classifier below is total: a new reason must be classified, it cannot default into fail-open.
export type SkipReason =
  | "no-ticket-input"       // nothing to resolve a ticket from: no --ticket, no --pr, HEAD is not dev-loop/<id>
  | "no-repo-resolved"      // could not resolve owner/repo from cwd OR the workspace repo registry
  | "pr-not-a-loop-branch"  // the PR was read; its head branch is not dev-loop/<id>, so there is no ticket
  | "no-pr-arg"             // the caller did not request the forge axis
  | "no-hub-db"             // hub db absent (linear/local backend)
  | "hub-db-unreadable"     // hub db present but would not open
  | "forge-unreachable";    // gh missing/unauth/offline/timeout, or the PR could not be read

// unreachable  ⇒ §3.4 fail-open: an outage must never become a merge freeze.
// untargeted   ⇒ the caller pointed the guard at nothing it could identify; must NOT read as clean.
// inapplicable ⇒ the evidence was reached and this axis simply has nothing to say (or was not asked).
export type SkipClass = "unreachable" | "untargeted" | "inapplicable";

export function skipClass(reason: SkipReason): SkipClass {
  switch (reason) {
    case "no-ticket-input":
    case "no-repo-resolved":
      return "untargeted";
    case "no-hub-db":
    case "hub-db-unreadable":
    case "forge-unreachable":
      return "unreachable";
    case "pr-not-a-loop-branch":
    case "no-pr-arg":
      return "inapplicable";
  }
}

export interface MergeGuardBoardStateResult {
  ticketId: string | null;
  ticketState: string | null;
  trip: boolean;
  skipped: boolean; // true when no hub DB or no ticket resolved — axis not evaluated (no false trip)
  // WHY it was skipped (LOOP-300). null ⇔ !skipped — the two are kept in lock-step so a caller can
  // key on either; `skipped` stays for the existing --json consumers.
  skipReason: SkipReason | null;
}

export interface ForgeReviewResult {
  trip: boolean;
  skipped: boolean; // true when no PR provided or forge failed → no false trip
  skipReason: SkipReason | null; // LOOP-300 — null ⇔ !skipped
  changeRequesters: string[];        // non-agent logins that CHANGES_REQUESTED
  unresolvedThreadAuthors: string[]; // non-agent logins with ≥1 unresolved thread
}

// Result of --apply when the guard trips (§5.1 / LOOP-65).
export interface MergeGuardApplyResult {
  // "wrote": comment posted + ticket routed (forge axis) or comment-only (board axis);
  // "already_present": marker existed, no dup posted;
  // "skipped_no_db": no hub DB available (degrade); "skipped_no_ticket": ticket not in hub;
  // "skipped_merged": PR is already merged — no board write (AC1 / LOOP-216).
  action: "wrote" | "already_present" | "skipped_no_db" | "skipped_no_ticket" | "skipped_merged";
  commentBody?: string; // the comment that was (or would have been) posted
}

export interface MergeGuardResult {
  trip: boolean;
  boardState: MergeGuardBoardStateResult;
  forgeReview: ForgeReviewResult;
  applied?: MergeGuardApplyResult; // present when --apply was set and the guard tripped
}

// Stable marker prefix used for idempotency detection across re-runs.
const APPLY_MARKER = "⛔ merge-guard:";

// Build the comment body describing the objection.
function buildCommentBody(
  pr: number | string | undefined,
  forgeReview: ForgeReviewResult,
  boardState: MergeGuardBoardStateResult,
): string {
  const prRef = pr !== undefined ? ` PR #${pr}` : "";
  if (forgeReview.trip) {
    const cr = forgeReview.changeRequesters;
    const ut = forgeReview.unresolvedThreadAuthors;
    if (cr.length > 0) {
      return `${APPLY_MARKER}${prRef} carries CHANGES_REQUESTED from ${cr.map((l) => `@${l}`).join(", ")} (unresolved). Not merged.`;
    }
    return `${APPLY_MARKER}${prRef} has unresolved review threads from ${ut.map((l) => `@${l}`).join(", ")}. Not merged.`;
  }
  const state = boardState.ticketState ?? "non-merge-eligible state";
  return `${APPLY_MARKER} ticket is ${state} (not merge-eligible). Not merged.`;
}

// Post objection comment and, for forge-review trips, route the ticket.
// tripAxis determines the routing behaviour (LOOP-216):
//   "board": comment only — state/assignee/labels are left untouched (AC2).
//   "forge": comment + route to Todo with existing assignee, without adding "blocked" (AC3).
// Degrades silently when the hub DB is absent (no throw, returns skipped_no_db).
// Idempotent on the comment: if the exact body already exists, skips re-posting (LOOP-65).
// Routing still re-enforces on every call regardless of comment dedup (LOOP-130).
function applyTrip(
  ticketId: string,
  dbPath: string | undefined | null,
  pr: number | string | undefined,
  forgeReview: ForgeReviewResult,
  boardState: MergeGuardBoardStateResult,
  tripAxis: "forge" | "board",
): MergeGuardApplyResult {
  if (!dbPath || !existsSync(dbPath)) return { action: "skipped_no_db" };
  let db;
  try { db = openDb(dbPath); }
  catch { return { action: "skipped_no_db" }; }
  try {
    const trow = db.prepare("SELECT project_id FROM tickets WHERE id=?").get(ticketId) as { project_id: string } | undefined;
    if (!trow) return { action: "skipped_no_ticket" };
    const projectId = trow.project_id;
    const commentBody = buildCommentBody(pr, forgeReview, boardState);
    // Comment dedup: skip re-posting only if the exact objection text already exists (LOOP-65).
    const dup = db.prepare("SELECT id FROM comments WHERE ticket_id=? AND body=?").get(ticketId, commentBody);
    // LOOP-218: attribute the write to the invoking actor (DEVLOOP_ACTOR when set), falling back to
    // "operator" ONLY when it is absent (a hand-run from the operator console, where operator is the
    // truthful actor). AC1 — both invocation modes must become honest.
    const actor = process.env.DEVLOOP_ACTOR || "operator";
    if (!dup) {
      addComment(db, projectId, actor, ticketId, commentBody);
    }
    if (tripAxis === "board") {
      // AC2 (LOOP-216): board-state trip — comment only, no mutation of state/assignee/labels.
      // The ticket is already in the state the guard is objecting about; moving it reduces reachability.
      return { action: dup ? "already_present" : "wrote", commentBody };
    }
    // AC3 (LOOP-216): forge-review trip — route to Todo with existing assignee, without "blocked".
    // Routing re-enforces on every call, regardless of comment dedup (LOOP-130).
    const cur = db.prepare("SELECT title,description,type,state,assignee,priority,labels,duplicate_of,related_to FROM tickets WHERE id=? AND project_id=?")
      .get(ticketId, projectId) as TicketUpdateFields | undefined;
    if (cur) {
      updateTicketRow(db, projectId, actor, ticketId, cur.state, {
        ...cur, state: "Todo", assignee: cur.assignee, labels: cur.labels,
      });
    }
    return { action: dup ? "already_present" : "wrote", commentBody };
  } finally {
    db.close();
  }
}

// Parse a ticket id from a dev-loop/<id> branch name or a fix/<id>-… branch name.
// Returns null when the branch shape doesn't carry a recognisable ticket id.
const TICKET_RE = ticketIdScanRe(); // the ONE canonical <PREFIX>-<n> id shape (ticket-id.ts, LOOP-264)
function ticketFromBranch(branch: string): string | null {
  const m = branch.match(/(?:dev-loop\/|fix\/)([^/\s]+)/);
  if (!m) return null;
  const hit = m[1].match(TICKET_RE);
  return hit ? hit[0] : null;
}

// Best-effort: extract owner/repo from the git remote URL of the repo dir.
// Returns null when the repo has no GitHub remote or git is not available.
const GH_REMOTE_RE = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/;

// owner/repo from a git remote URL (ssh or https); null when it is not a GitHub remote.
function ghRepoFromRemote(remote: string): string | null {
  const m = remote.trim().match(GH_REMOTE_RE);
  return m ? m[1]! : null;
}

// owner/repo for the forge axis. Tries the caller's directory first, then the WORKSPACE REPO
// REGISTRY (LOOP-300 AC3).
//
// The cwd probe is `git -C <repoDir> config --get remote.origin.url`, so standing anywhere that is
// not the target repo yielded null — and null took BOTH axes down at once, because --pr resolves its
// ticket through this same lookup. That is not a forge outage and must not be reported as one: the
// registry already records every repo's `remote`, so the answer was on disk the whole time.
//
// Ambiguity is refused, not guessed. Two registered GitHub repos and a bare `--pr 174` do not
// identify a PR — picking one would let the guard check a DIFFERENT repo's PR #174 and report it
// clean. The caller passes --repo; the CLI names the candidates so that is a two-second fix.
function resolveGhRepo(repoDir: string): string | null {
  try {
    const remote = execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const fromCwd = ghRepoFromRemote(remote);
    if (fromCwd) return fromCwd;
  } catch { /* not a git repo / no remote — fall through to the registry */ }
  // Resolved ONCE: two calls would re-read the workspace and could, in principle, disagree.
  const registry = registryGhRepos(repoDir);
  return registry.length === 1 ? registry[0]! : null;
}

// Distinct GitHub owner/repo values in the workspace repo registry, sorted for a stable message.
// Exported so the CLI can NAME the candidates when it refuses an ambiguous resolve.
export function registryGhRepos(startDir: string): string[] {
  try {
    const ws = tryResolveWorkspace(startDir);
    if (!ws) return [];
    const out = new Set<string>();
    for (const entry of Object.values(ws.file.repos ?? {})) {
      const remote = (entry as { remote?: string } | null)?.remote;
      if (!remote) continue;
      const gh = ghRepoFromRemote(remote);
      if (gh) out.add(gh);
    }
    return [...out].sort();
  } catch { return []; }
}

// Best-effort: read team.agentReviewers from workspace config (absent ⇒ []).
function resolveAgentReviewers(repoDir: string): string[] {
  try {
    const ws = tryResolveWorkspace(repoDir);
    if (!ws) return [];
    return ws.file.team.agentReviewers ?? [];
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
    // Board-visible objection path (Child 2 / LOOP-65):
    apply?: boolean;           // when true + trip: post comment + route ticket (§5.1)
  } = {},
): MergeGuardResult {
  // ── Board-state axis (§3.3) ────────────────────────────────────────────────
  // Hub-only: reads tickets table, no forge access needed.
  // Degrades silently (skipped) when the hub DB is absent (linear/local backend).
  let ticketId = opts.ticketId ?? null;
  // Why the --pr lookup failed to yield a ticket, when it was attempted (LOOP-300). This is the
  // discriminator PM's note names: "no ticket resolved" from a wrong cwd and "no ticket resolved"
  // from a dead forge look identical in the output but are opposite verdicts — one the caller can
  // fix, one must fail open. Counting axes cannot tell them apart; only the cause can.
  let prLookupFailure: SkipReason | null = null;

  // If --pr given and no explicit ticket, resolve from the PR's head branch first.
  // This must run before local HEAD inference so the PR's ticket takes priority over
  // whatever branch happens to be checked out in the invoking worktree (LOOP-142).
  if (!ticketId && opts.pr !== undefined) {
    try {
      const exec = opts.exec ?? defaultGhExec;
      const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
      if (!ghRepo) {
        prLookupFailure = "no-repo-resolved";
      } else {
        const r = exec(["pr", "view", String(opts.pr), "--repo", ghRepo, "--json", "headRefName"]);
        if (!r.ok) {
          prLookupFailure = "forge-unreachable";
        } else {
          const parsed = JSON.parse(r.stdout) as { headRefName?: string };
          if (parsed.headRefName) ticketId = ticketFromBranch(parsed.headRefName);
          // Reached the PR and read its head: if that head is not dev-loop/<id> there IS no ticket
          // for this PR. The board axis is inapplicable, not un-evaluated — a human's PR is a
          // legitimate thing to run the forge axis over, and it must not hold on a missing ticket.
          if (!ticketId) prLookupFailure = "pr-not-a-loop-branch";
        }
      }
    } catch { prLookupFailure = "forge-unreachable"; /* gh threw — degrade to local branch inference */ }
  }

  // If still no ticket, try to infer from the HEAD branch of the repo.
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
    // No ticket resolved — axis not evaluated; report as skipped so callers can
    // distinguish "no input" from "checked and clean" (LOOP-142, AC5). The REASON carries whether
    // the caller can fix it (LOOP-300): a failed --pr lookup already knows why it failed, and
    // without --pr at all the caller simply gave nothing to resolve from.
    boardState = { ticketId: null, ticketState: null, trip: false, skipped: true, skipReason: prLookupFailure ?? "no-ticket-input" };
  } else {
    // Resolve dbPath: explicit > DEVLOOP_HUB_DB env > workspace-inferred
    const dbPath = opts.dbPath ?? process.env.DEVLOOP_HUB_DB ?? resolveHubDbPath(repoDir);
    if (!dbPath || !existsSync(dbPath)) {
      boardState = { ticketId, ticketState: null, trip: false, skipped: true, skipReason: "no-hub-db" };
    } else {
      let conn;
      try { conn = openDb(dbPath); }
      catch { conn = null; }
      if (!conn) {
        boardState = { ticketId, ticketState: null, trip: false, skipped: true, skipReason: "hub-db-unreadable" };
      } else {
        try {
          const row = conn.prepare("SELECT state FROM tickets WHERE id=?").get(ticketId) as { state: string } | undefined;
          if (!row) {
            boardState = { ticketId, ticketState: null, trip: false, skipped: false, skipReason: null };
          } else {
            const trip = NOT_MERGE_ELIGIBLE.has(row.state);
            boardState = { ticketId, ticketState: row.state, trip, skipped: false, skipReason: null };
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
    forgeReview = { trip: false, skipped: true, skipReason: "no-pr-arg", changeRequesters: [], unresolvedThreadAuthors: [] };
  } else {
    const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
    if (!ghRepo) {
      // Neither the cwd nor the workspace registry identified ONE GitHub repo. This is NOT the §3.4
      // outage case — nothing was unreachable, the invocation just did not say what to check — so it
      // is `untargeted` and a --strict run with no other evaluated axis exits EXIT_UNEVALUATED.
      forgeReview = { trip: false, skipped: true, skipReason: "no-repo-resolved", changeRequesters: [], unresolvedThreadAuthors: [] };
    } else {
      const exec = opts.exec ?? defaultGhExec;
      const prState = readPrReviewState(ghRepo, opts.pr, { exec });
      if (!prState) {
        // Forge failure (gh missing/unauth/offline/timeout/no-PR) → degrade (§3.4)
        forgeReview = { trip: false, skipped: true, skipReason: "forge-unreachable", changeRequesters: [], unresolvedThreadAuthors: [] };
      } else {
        // Agent-reviewer exclusion (§3.2): ignore any reviewer whose login is in the agent set.
        const agentSet = new Set(opts.agentReviewers ?? resolveAgentReviewers(repoDir));
        const humanChangeRequesters = prState.changeRequesters.filter((l) => !agentSet.has(l));
        const humanThreadAuthors = prState.unresolvedThreadAuthors.filter((l) => !agentSet.has(l));
        const forgeTrip = humanChangeRequesters.length > 0 || humanThreadAuthors.length > 0;
        forgeReview = {
          trip: forgeTrip,
          skipped: false,
          skipReason: null,
          changeRequesters: humanChangeRequesters,
          unresolvedThreadAuthors: humanThreadAuthors,
        };
      }
    }
  }

  const trip = boardState.trip || forgeReview.trip;
  if (trip && opts.apply && (boardState.ticketId ?? ticketId)) {
    const applyTicketId = boardState.ticketId ?? ticketId!;
    const dbPath = opts.dbPath ?? process.env.DEVLOOP_HUB_DB ?? resolveHubDbPath(repoDir);

    // AC1/AC4 (LOOP-216): when a PR is provided, check whether it is already merged before any board write.
    // If merged → moot objection, skip all writes (AC1).
    // If the merged state cannot be determined (gh unavailable/non-GitHub remote) → also skip (AC4).
    if (opts.pr !== undefined) {
      const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
      let prMerged: boolean | null = null; // null = unknown
      if (ghRepo) {
        try {
          const exec = opts.exec ?? defaultGhExec;
          const r = exec(["pr", "view", String(opts.pr), "--repo", ghRepo, "--json", "state"]);
          if (r.ok) {
            const parsed = JSON.parse(r.stdout) as { state?: string };
            prMerged = parsed.state === "MERGED";
          }
        } catch { /* gh unavailable → prMerged stays null */ }
      }
      if (prMerged !== false) {
        // merged (true) or unknown (null) → skip apply; report moot
        return { trip, boardState, forgeReview, applied: { action: "skipped_merged" } };
      }
    }

    const tripAxis: "forge" | "board" = forgeReview.trip ? "forge" : "board";
    const applied = applyTrip(applyTicketId, dbPath, opts.pr, forgeReview, boardState, tripAxis);
    return { trip, boardState, forgeReview, applied };
  }
  return { trip, boardState, forgeReview };
}

// Exit code for "--strict was asked to gate a merge and could not evaluate anything" (LOOP-300).
// Distinct from 1 (a real objection) and 2 (usage) so a caller can tell "a human objected" from
// "I could not check" without parsing prose; both are non-zero, so §12c's "non-zero HOLDS that
// merge" rule already does the right thing with it at every existing call site.
export const EXIT_UNEVALUATED = 3;

// Did this run gate anything? Returns the reason to hold when --strict must NOT report a clean pass:
// no axis evaluated AND at least one skip was `untargeted`. All-unreachable stays a pass — that is
// §3.4's fail-open and turning it into a hold would make an outage a merge freeze (LOOP-300 AC2).
export function unevaluatedHold(r: MergeGuardResult): SkipReason | null {
  if (!r.boardState.skipped || !r.forgeReview.skipped) return null; // ≥1 axis actually ran
  for (const reason of [r.boardState.skipReason, r.forgeReview.skipReason]) {
    if (reason && skipClass(reason) === "untargeted") return reason;
  }
  return null;
}

// CLI: dev-loop merge-guard [--repo <dir>] [--pr <n>] [--ticket <id>] [--strict] [--apply] [--json]
// Exit codes (the write-layer contract): 0 clean/advisory/degraded · 1 trip under --strict ·
// 2 usage · 3 --strict could not evaluate either axis (LOOP-300).
if (isMainEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  let repo = process.cwd();
  let ticketId: string | undefined;
  let pr: number | string | undefined;
  let strict = false;
  let apply = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") repo = argv[++i] ?? "";
    else if (a === "--ticket") ticketId = argv[++i];
    else if (a === "--pr") pr = argv[++i];
    else if (a === "--strict") strict = true;
    else if (a === "--apply") apply = true;
    else if (a === "--json") asJson = true;
    else if (a === "--help" || a === "-h") {
      console.log(`dev-loop merge-guard — refuse merge on a human CHANGES_REQUESTED or a non-merge-eligible ticket.
Design: hubDoc:design/merge-review-guard §3.1/§3.2/§3.3/§3.4/§5.1 (LOOP-64 Child 1 + LOOP-65 Child 2 + LOOP-67 Child 4).

Usage: dev-loop merge-guard [--repo <dir>] [--pr <n>] [--ticket <id>] [--strict] [--apply] [--json]
  --pr <n>        PR number (enables forge review axis — §3.1: CHANGES_REQUESTED / unresolved threads)
  --ticket <id>   explicit ticket id (default: inferred from HEAD branch dev-loop/<id>)
  --strict        exit 1 when either axis trips (the merge-pass gate)
  --apply         on a trip: post objection comment + route ticket to blocked/Todo/unassigned (§5.1)
  --json          emit result as JSON

Forge review axis (--pr): trips when a non-agent reviewer has CHANGES_REQUESTED or an unresolved
  review thread. Degrades silently (exit 0) when gh is unavailable, unauth, offline, or no PR found.
Board-state axis: trips when the ticket is In Review / Canceled / Duplicate.
  Degrades silently (exit 0) when no hub DB is available (linear/local backend).
--apply: board writes degrade silently when no hub DB; idempotent (no duplicate comments).

--repo defaults to the cwd, but --pr no longer NEEDS it: when the cwd is not the target repo the
  GitHub owner/repo is read from the workspace repo registry. A registry with two or more GitHub
  repos is ambiguous and is refused (exit 3), never guessed — pass --repo <dir>.

Exit codes: 0 clean/advisory/degraded · 1 trip under --strict · 2 usage ·
  3 --strict could not evaluate EITHER axis and the cause was the invocation, not an outage.
  A genuine outage (no gh / forge down / no hub db) still degrades to 0 — a merge gate must not
  become a merge freeze.`);
      process.exit(0);
    } else { console.error(`merge-guard: unknown option '${a}'`); process.exit(2); }
  }

  let result: MergeGuardResult;
  try { result = mergeGuard(repo, { ticketId, pr, apply }); }
  catch (e) { console.error(`merge-guard: ${(e as Error).message.split("\n")[0]}`); process.exit(2); }

  const bs = result.boardState;
  const fr = result.forgeReview;
  // Only consulted when a repo could NOT be resolved, so the refusal can name what it found instead
  // of leaving the operator to guess whether the registry was empty or ambiguous.
  const candidates = bs.skipReason === "no-repo-resolved" || fr.skipReason === "no-repo-resolved"
    ? registryGhRepos(repo) : [];
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Board-state axis output
    if (bs.skipped && !bs.ticketId) {
      // Name the CAUSE, not just the symptom (LOOP-300): "no ticket resolved" was printed for a
      // wrong cwd, a dead forge, and a human's non-loop PR alike — three different next actions.
      const why = bs.skipReason === "no-repo-resolved"
        ? `could not resolve the GitHub repo for --pr from this directory or the workspace repo registry${candidates.length > 1 ? ` (registry has ${candidates.length}: ${candidates.join(", ")} — pass --repo <dir> to disambiguate)` : ""}`
        : bs.skipReason === "forge-unreachable"
          ? "the PR could not be read (gh unavailable, unauth, offline, or no such PR)"
          : bs.skipReason === "pr-not-a-loop-branch"
            ? "the PR's head branch is not dev-loop/<id>, so it has no ticket"
            : "no ticket resolved; pass --ticket <id>, use --pr with a dev-loop/<id> head, or run from a dev-loop/<id> branch";
      console.log(`merge-guard: board-state axis skipped — ${why}`);
    } else if (bs.skipped) {
      console.log(`merge-guard: board-state axis skipped — no hub DB available (linear/local backend)`);
    } else if (bs.trip) {
      console.error(`merge-guard: ⛔ TRIP — ticket ${bs.ticketId} is ${bs.ticketState} (not merge-eligible); do not merge until the gate clears`);
    } else {
      console.log(`merge-guard: ticket ${bs.ticketId} is ${bs.ticketState ?? "unknown"} — merge-eligible on the board-state axis`);
    }
    // Forge review axis output
    if (fr.skipped && pr !== undefined) {
      const why = fr.skipReason === "no-repo-resolved"
        ? `could not resolve the GitHub repo from this directory or the workspace repo registry${candidates.length > 1 ? ` (registry has ${candidates.length}: ${candidates.join(", ")} — pass --repo <dir> to disambiguate)` : ""}`
        : "gh unavailable, forge unreachable, or no PR found";
      console.log(`merge-guard: forge review axis skipped — ${why}`);
    } else if (!fr.skipped && fr.trip) {
      const who = [...fr.changeRequesters, ...fr.unresolvedThreadAuthors].filter((v, i, a) => a.indexOf(v) === i);
      console.error(`merge-guard: ⛔ TRIP — PR has unresolved objection from ${who.map((l) => `@${l}`).join(", ")} (CHANGES_REQUESTED or unresolved thread); must be addressed before merging`);
    } else if (!fr.skipped && !fr.trip) {
      console.log(`merge-guard: forge review axis clean — no non-agent CHANGES_REQUESTED or unresolved threads`);
    }
    // --apply output
    if (result.applied) {
      const ap = result.applied;
      if (ap.action === "wrote") console.log(`merge-guard: --apply wrote: ${ap.commentBody}`);
      else if (ap.action === "already_present") console.log(`merge-guard: --apply skipped (objection already recorded on ticket)`);
      else if (ap.action === "skipped_no_db") console.log(`merge-guard: --apply skipped — no hub DB (degrade)`);
    }
  }

  // A real objection outranks "could not evaluate": if an axis DID run and tripped, that is the
  // verdict to report. Otherwise, under --strict, refuse to answer "clean" for a run that gated
  // nothing it could have gated (LOOP-300 AC1).
  if (strict && result.trip) process.exit(1);
  if (strict) {
    const hold = unevaluatedHold(result);
    if (hold) {
      console.error(`merge-guard: ⛔ COULD NOT EVALUATE — neither axis ran (${hold}); --strict will not report a clean pass for a gate that checked nothing. Fix the invocation (--repo <dir> / --ticket <id> / --pr <n>) and re-run; this is NOT a degrade-to-pass case (the evidence was reachable).`);
      process.exit(EXIT_UNEVALUATED);
    }
  }
  process.exit(0);
}
