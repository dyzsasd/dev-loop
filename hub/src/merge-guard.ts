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
import { prTicketIds, ticketFromBranch } from "./pr-tickets.ts"; // LOOP-150: every ticket a PR claims, not just its branch
import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { openDb } from "./db.ts";
import { resolveHubDbPath, tryResolveWorkspace } from "./workspace.ts";
import { readPrReviewState, defaultGhExec, type ExecFn, readCiFreshness, type CiFreshness } from "./landing.ts";
import { addComment, updateTicketRow, type TicketUpdateFields } from "./ticketwrite.ts";


// Board states and their merge-eligibility, ENUMERATED (LOOP-113).
//
// This used to be a 3-member deny-set against db.ts's EIGHT declared states, so the other five were
// merge-eligible BY OMISSION — never enumerated, never reasoned about. One of them is
// `Human-Blocked`, which is the loop's only explicit "a human must rule on this before anything
// else happens" state: the board form of the §9 park and the entire content of the operator's
// decision queue. A guard whose stated purpose is to stop a human's most deliberate act of steering
// from being discarded silently treated a ticket parked FOR that ruling as fine to merge. It was not
// a considered trade-off — `Human-Blocked` appears zero times in the design, which reasoned only
// about "In Review" and "terminal reject", and it is neither.
//
// A total map, not a set: adding a ninth state to db.ts now fails the exhaustiveness test in
// hub/test/merge-guard.ts rather than silently defaulting to merge-eligible.
const MERGE_ELIGIBILITY: Record<string, { eligible: boolean; why: string }> = {
  "Backlog":       { eligible: true,  why: "not started — a PR against it is early, not wrong" },
  "Todo":          { eligible: true,  why: "queued for a dev tier" },
  "In Progress":   { eligible: true,  why: "claimed and being built — this is the normal merge path" },
  "In Review":     { eligible: false, why: "the PR's verify gate is still open — merging pre-empts the owner's verdict" },
  "Human-Blocked": { eligible: false, why: "parked for the operator's ruling — this is the decision queue itself; merging discards the steering the park exists to wait for" },
  "Done":          { eligible: true,  why: "already accepted — a follow-up PR against it is legitimate" },
  "Canceled":      { eligible: false, why: "terminal reject — the work was refused" },
  "Duplicate":     { eligible: false, why: "terminal reject — superseded by another ticket" },
};
// An UNKNOWN state fails open (eligible), consistent with §3.4: "you pointed me at something I do
// not understand" must never become a merge freeze. The exhaustiveness test is what keeps the map
// honest, not a runtime refusal.
export function isMergeEligible(state: string): { eligible: boolean; why: string } {
  return MERGE_ELIGIBILITY[state] ?? { eligible: true, why: `unknown state '${state}' — failing open (§3.4)` };
}
export const MERGE_ELIGIBILITY_STATES = Object.keys(MERGE_ELIGIBILITY);

// Why an axis did not evaluate (LOOP-300). `null` ⇒ it DID evaluate. The set is closed so the
// classifier below is total: a new reason must be classified, it cannot default into fail-open.
export type SkipReason =
  | "no-ticket-input"       // nothing to resolve a ticket from: no --ticket, no --pr, HEAD is not dev-loop/<id>
  | "no-repo-resolved"      // could not resolve owner/repo from cwd OR the workspace repo registry
  | "pr-not-a-loop-branch"  // the PR was read; its head branch is not dev-loop/<id>, so there is no ticket
  | "no-pr-arg"             // the caller did not request the forge axis
  | "no-hub-db"             // hub db absent (linear/local backend)
  | "hub-db-unreadable"     // hub db present but would not open
  | "forge-unreachable"     // gh missing/unauth/offline/timeout, or the PR could not be read
  | "no-merge-checks"       // CI-freshness axis not configured: mergeChecks empty (inapplicable)
  | "ci-config-ambiguous"   // CI-freshness config could not be SELECTED: ≥2 registry entries share the selected remote
  | "repo-not-automerge";   // CI-freshness axis inapplicable: repo is not landing:"pr" + autoMerge (LOOP-323 AC2)

// unreachable  ⇒ §3.4 fail-open: an outage must never become a merge freeze.
// untargeted   ⇒ the caller pointed the guard at nothing it could identify; must NOT read as clean.
// inapplicable ⇒ the evidence was reached and this axis simply has nothing to say (or was not asked).
export type SkipClass = "unreachable" | "untargeted" | "inapplicable";

export function skipClass(reason: SkipReason): SkipClass {
  switch (reason) {
    case "no-ticket-input":
    case "no-repo-resolved":
    // Ambiguity is a property of the INVOCATION, not of the world: two registry entries share the
    // selected remote, so `--repo <dir>` resolves it and no outage is involved. Classifying it
    // `inapplicable` (which is what returning null used to buy) is the bug — it says "this axis has
    // nothing to check" when the truth is "this axis could not find out what to check".
    case "ci-config-ambiguous":
      return "untargeted";
    case "no-hub-db":
    case "hub-db-unreadable":
    case "forge-unreachable":
      return "unreachable";
    case "pr-not-a-loop-branch":
    case "no-pr-arg":
    case "no-merge-checks":
    case "repo-not-automerge":
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
  // LOOP-150 — EVERY ticket this PR claims (branch + commits + title/body), branch-derived first.
  // Reported so a consumer can see that a PR carries a second ticket's fix; `ticketId` stays the
  // primary and remains what the board axis gates on.
  claimedTicketIds?: string[];
}

export interface ForgeReviewResult {
  trip: boolean;
  skipped: boolean; // true when no PR provided or forge failed → no false trip
  skipReason: SkipReason | null; // LOOP-300 — null ⇔ !skipped
  changeRequesters: string[];        // non-agent logins that CHANGES_REQUESTED
  unresolvedThreadAuthors: string[]; // non-agent logins with ≥1 unresolved thread
}

export interface CiFreshnessResult {
  trip: boolean;
  skipped: boolean; // true when no --pr, no mergeChecks, or exec degraded — axis not evaluated
  skipReason: SkipReason | null; // LOOP-300 — null ⇔ !skipped
  verdict: CiFreshness["verdict"] | null;
  behindBy: number | null;
  testedHead: string | null;
  currentTip: string | null;
  reason: string | null;
}

// Result of --apply when the guard trips (§5.1 / LOOP-65).
export interface MergeGuardApplyResult {
  // "wrote": comment posted + ticket routed (forge axis) or comment-only (board/ciFreshness axis);
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
  ciFreshness: CiFreshnessResult;
  applied?: MergeGuardApplyResult;
}

// Stable marker prefix used for idempotency detection across re-runs.
const APPLY_MARKER = "⛔ merge-guard:";

// LOOP-241 — carried by every forge-review objection. Spells out the step devs get wrong, because
// this string is what a dev reads at the MOMENT of the failure; the SKILL's Step 0.5 already says
// green is not sufficient, but nobody re-reads a SKILL when a guard just spoke to them.
const REVIEW_REMEDY = [
  "   Pushing a fix does NOT resolve a review thread, and CI going green does not either — thread",
  "   resolution is a separate action a human or the reviewer must take on the PR.",
  "   Do both: push the fix, THEN resolve each thread (GitHub: 'Resolve conversation' on each, or",
  "   `gh api -X PATCH /repos/{owner}/{repo}/pulls/comments/{id}` per thread). The guard re-checks on",
  "   the next run; it will keep holding until the thread count reaches zero.",
].join("\n");

// LOOP-323 AC6: whether a "stale" verdict (green computed against a base behind the tip) HOLDS the
// merge under --strict, or reports advisory-only. "red" always trips regardless of this constant.
// AC6 was written 2026-08-04 while its precondition — LOOP-277's Step 0.5 re-freshen remedy — was
// still an unapplied proposal, and prescribed advisory-only to avoid holding green PRs with no
// exit. That precondition has since landed: the remedy merged in 42fdbc6 (PR #186, 2026-08-04),
// so the harmful order AC6 guards against cannot occur and the trip ships ON. This constant stays
// as the deliberate one-line rollback the AC asked for; the deviation is recorded on LOOP-323.
const CI_FRESHNESS_STALE_TRIPS = true;

// Build the comment body describing the objection.
export function buildCommentBody(
  pr: number | string | undefined,
  forgeReview: ForgeReviewResult,
  boardState: MergeGuardBoardStateResult,
  ciFreshness?: CiFreshnessResult,
): string {
  const prRef = pr !== undefined ? ` PR #${pr}` : "";
  if (forgeReview.trip) {
    const cr = forgeReview.changeRequesters;
    const ut = forgeReview.unresolvedThreadAuthors;
    // LOOP-241 — the objection said THAT the merge was held and not WHAT to do, and the omitted step
    // is the one devs actually get wrong: PUSHING A FIX DOES NOT RESOLVE A THREAD. Measured across
    // three simultaneously-stranded PRs, two devs had pushed a correct fix (with tests) and left
    // every thread open; one handoff comment stated the misconception verbatim — "CI re-triggered;
    // merge-guard will clear on green." It will not: green is orthogonal to thread resolution.
    //
    // The verdict logic is correct and unchanged. This is the message only.
    if (cr.length > 0) {
      return `${APPLY_MARKER}${prRef} carries CHANGES_REQUESTED from ${cr.map((l) => `@${l}`).join(", ")} (unresolved). Not merged.\n${REVIEW_REMEDY}`;
    }
    return `${APPLY_MARKER}${prRef} has unresolved review threads from ${ut.map((l) => `@${l}`).join(", ")}. Not merged.\n${REVIEW_REMEDY}`;
  }
  if (boardState.trip) {
    const state = boardState.ticketState ?? "non-merge-eligible state";
    return `${APPLY_MARKER} ticket is ${state} (not merge-eligible). Not merged.`;
  }
  if (ciFreshness?.trip) {
    // Amendment 1 (binding, LOOP-149 → LOOP-323 AC4): a "stale" objection must name its remedy,
    // in the softened wording ratified in LOOP-277 §"Amendment 1 interaction" — Step 0.5's
    // re-freshen is authoritative; the manual rebase is the fallback; an already-current tip means
    // the hold is already actioned. "red" has a different remedy (fix the failing checks).
    const remedy = ciFreshness.verdict === "stale"
      ? " Remedy: Step 0.5's re-freshen rebases this PR automatically at the next fire start (authoritative). Manually: rebase onto `origin/<defaultBranch>` and push with `--force-with-lease`; a pushed rebase clears this hold. If the PR tip is no longer behind `origin/<defaultBranch>`, treat this hold as already actioned."
      : ciFreshness.verdict === "red"
        ? " Remedy: read the failing check's log, fix in the worktree, re-push (Step 0.5's FAILED-check branch; cap ~2 cycles)."
        // LOOP-407: an absent check has no log to read and no rebase to clear it — the workflow has to
        // be made to run. Re-pushing the branch is what re-dispatches it once the forge is healthy.
        : ciFreshness.verdict === "check-never-reported"
          ? " Remedy: the check was never dispatched — this is NOT a wait. Confirm the forge is healthy (`gh run list --branch <head>`; check the forge's status page for an Actions incident), then re-dispatch by pushing to the branch (an empty commit or a rebase with `--force-with-lease`). Do not merge on `mergeStateStatus:CLEAN`: with no branch protection, CLEAN means nothing was measured."
          : "";
    return `${APPLY_MARKER}${prRef} ciFreshness: ${ciFreshness.reason ?? "stale/red"}. Not merged.${remedy}`;
  }
  return `${APPLY_MARKER}${prRef} objection (no axis details). Not merged.`;
}

// Post objection comment and, for forge-review trips, route the ticket.
// tripAxis determines the routing behaviour (LOOP-216):
//   "board": comment only — state/assignee/labels are left untouched (AC2).
//   "forge": comment + route to Todo with existing assignee, without adding "blocked" (AC3).
//   "ciFreshness": comment only — staleness is transient (a rebase clears it).
// Degrades silently when the hub DB is absent (no throw, returns skipped_no_db).
// Idempotent on the comment: if the exact body already exists, skips re-posting (LOOP-65).
// Routing still re-enforces on every call regardless of comment dedup (LOOP-130).
function applyTrip(
  ticketId: string,
  dbPath: string | undefined | null,
  pr: number | string | undefined,
  forgeReview: ForgeReviewResult,
  boardState: MergeGuardBoardStateResult,
  tripAxis: "forge" | "board" | "ciFreshness",
  ciFreshness?: CiFreshnessResult,
): MergeGuardApplyResult {
  if (!dbPath || !existsSync(dbPath)) return { action: "skipped_no_db" };
  let db;
  try { db = openDb(dbPath); }
  catch { return { action: "skipped_no_db" }; }
  try {
    const trow = db.prepare("SELECT project_id FROM tickets WHERE id=?").get(ticketId) as { project_id: string } | undefined;
    if (!trow) return { action: "skipped_no_ticket" };
    const projectId = trow.project_id;
    const commentBody = buildCommentBody(pr, forgeReview, boardState, ciFreshness);
    // Comment dedup: skip re-posting only if the exact objection text already exists (LOOP-65).
    const dup = db.prepare("SELECT id FROM comments WHERE ticket_id=? AND body=?").get(ticketId, commentBody);
    // LOOP-218: attribute the write to the invoking actor (DEVLOOP_ACTOR when set), falling back to
    // "operator" ONLY when it is absent (a hand-run from the operator console, where operator is the
    // truthful actor). AC1 — both invocation modes must become honest.
    const actor = process.env.DEVLOOP_ACTOR || "operator";
    if (!dup) {
      addComment(db, projectId, actor, ticketId, commentBody);
    }
    if (tripAxis === "board" || tripAxis === "ciFreshness") {
      // AC2 (LOOP-216): board-state/ciFreshness trip — comment only, no mutation of state/assignee/labels.
      // The ticket is already in the state the guard is objecting about; moving it reduces reachability.
      // For ciFreshness: staleness is transient (a rebase clears it), so the ticket stays where it is.
      return { action: dup ? "already_present" : "wrote", commentBody };
    }
    // AC3 (LOOP-216): forge-review trip — route to Todo with existing assignee, without "blocked".
    // LOOP-518 AC1: but NOT if the ticket is already In Progress — it stays In Progress (comment-only).
    // Routing re-enforces on every call, regardless of comment dedup (LOOP-130).
    const cur = db.prepare("SELECT title,description,type,state,assignee,priority,labels,duplicate_of,related_to FROM tickets WHERE id=? AND project_id=?")
      .get(ticketId, projectId) as TicketUpdateFields | undefined;
    if (cur && cur.state !== "In Progress") {
      // Only demote from In Review (or other states); stay in In Progress (LOOP-518 AC1)
      updateTicketRow(db, projectId, actor, ticketId, cur.state, {
        ...cur, state: "Todo", assignee: cur.assignee, labels: cur.labels,
      });
    }
    return { action: dup ? "already_present" : "wrote", commentBody };
  } finally {
    db.close();
  }
}

// LOOP-150: the branch parse now lives beside the full PR→ticket resolver, so the two cannot drift
// on what a "ticket id in a branch" is.
const TICKET_RE = ticketIdScanRe(); // the ONE canonical <PREFIX>-<n> id shape (ticket-id.ts, LOOP-264)

// Best-effort: extract owner/repo from the git remote URL of the repo dir.
// Returns null when the repo has no GitHub remote or git is not available.
const GH_REMOTE_RE = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/;

// owner/repo from a git remote URL (ssh or https); null when it is not a GitHub remote.
export function ghRepoFromRemote(remote: string): string | null {
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
// Exported for `pr merge` (LOOP-444): that verb must address the SAME owner/repo the axes gated,
// and re-deriving it there would let the gate and the squash disagree about which PR #n they meant.
export function resolveGhRepo(repoDir: string): string | null {
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
// LOOP-323 AC1: the CI-freshness config for the repo the CLI is gating, from the workspace repo
// registry. Matches repoDir against each registered entry's absolute path (realpath-normalized on
// both sides so a symlinked cwd still matches). Returns null when no workspace resolves or the dir
// is not a registered repo — the axis then skips exactly as before this wiring existed.
// LOOP-444 follow-up: `ghRepo` is the SELECTED repo — the owner/repo the axes are actually gating,
// as resolveGhRepo returned it. It exists because the two resolvers disagreed: resolveGhRepo falls
// back to the registry when the cwd is not a git repo (LOOP-300 AC3), while this lookup matched by
// PATH only. From the workspace root that combination resolved a repo and then found no config for
// it, so mergeChecks came back empty and the CI axis skipped as `no-merge-checks` — a *resolution*
// failure wearing the label of inapplicability. `merge-guard` only mis-reported it; `pr merge`
// squashes on it, which is the very thing that verb exists to refuse. So when no registered path
// matches, fall back to the entry whose remote IS the selected repo. Path match still wins, so every
// existing caller keeps its answer; ambiguity (two entries, same remote) is refused, not guessed.
export interface CiFreshnessConfig { mergeChecks: string[]; defaultBranch: string; repoEligible: boolean; repoRef?: string; ciIrrelevantPaths?: string[] }

// The THREE distinguishable answers. They used to be two, because `ambiguous` was returned as
// `null` — and a caller reading `null` omits mergeChecks, which makes the axis skip as
// `no-merge-checks`: "I could not choose between two configs" arriving as "there is no config to
// apply". For `merge-guard` that is a mis-report; for `pr merge` it is a squash with the CI axis
// never run, which is the exact failure that verb exists to refuse. So the ambiguity is named here,
// once, and each caller decides what to do with it.
export type CiFreshnessConfigResolution =
  | { kind: "resolved"; config: CiFreshnessConfig }
  | { kind: "ambiguous"; ghRepo: string; paths: string[] }   // ≥2 registry entries share `ghRepo`
  | { kind: "none" };                                        // no workspace, or no entry matches

export function resolveRegistryCiFreshnessConfig(
  repoDir: string,
  ghRepo?: string | null,
): CiFreshnessConfigResolution {
  type CfEntry = { path?: string; remote?: string; landing?: string; autoMerge?: boolean; mergeChecks?: string[]; defaultBranch?: string; ciIrrelevantPaths?: string[] };
  try {
    const ws = tryResolveWorkspace(repoDir);
    if (!ws) return { kind: "none" };
    let real: string;
    try { real = realpathSync(repoDir); } catch { real = resolvePath(repoDir); }
    // §19 defaultBranch chain: repo entry → team.git.defaultBranch → "main" (LOOP-188 pattern).
    const teamBranch = (ws.file.team as { git?: { defaultBranch?: string } }).git?.defaultBranch;
    const configOf = (ref: string, e: CfEntry): CiFreshnessConfig => ({
      // LOOP-365: the registry KEY, carried so the stale-reason remedy can name the real knob path.
      repoRef: ref,
      mergeChecks: e.mergeChecks ?? [],
      defaultBranch: e.defaultBranch ?? teamBranch ?? "main",
      // AC2: the axis applies only where Step 0.5 merges — landing:"pr" + autoMerge (design §3).
      repoEligible: e.landing === "pr" && e.autoMerge === true,
      ciIrrelevantPaths: Array.isArray(e.ciIrrelevantPaths) ? e.ciIrrelevantPaths : undefined, // LOOP-335
    });
    const entries = (Object.entries(ws.file.repos ?? {}) as [string, CfEntry | null][])
      .filter((kv): kv is [string, CfEntry] => !!kv[1]);
    for (const [ref, e] of entries) {
      if (!e.path) continue;
      const abs = resolvePath(ws.root, e.path);
      let absReal = abs;
      try { absReal = realpathSync(abs); } catch { /* keep abs */ }
      if (absReal !== real && abs !== real) continue;
      return { kind: "resolved", config: configOf(ref, e) };
    }
    if (ghRepo) {
      const byRemote = entries.filter(([, e]) => e.remote && ghRepoFromRemote(e.remote) === ghRepo);
      if (byRemote.length === 1) return { kind: "resolved", config: configOf(byRemote[0]![0], byRemote[0]![1]) };
      // Two entries, distinct paths, SAME remote — a shape the config validator permits, and one
      // `registryGhRepos` hides from `resolveGhRepo` because it dedupes remotes into a Set. So the
      // repo resolves and its config does not. Report the ambiguity with its candidates; the remedy
      // (`--repo <dir>`) is the caller's to take, and guessing an entry would gate one repo's config
      // against another's checks.
      if (byRemote.length > 1) {
        return { kind: "ambiguous", ghRepo, paths: byRemote.map(([, e]) => e.path ?? "<no path>").sort() };
      }
    }
    return { kind: "none" };
  } catch { return { kind: "none" }; }
}

// Back-compat read for callers that only need the happy path: `null` for BOTH "none" and
// "ambiguous". Anything that gates a merge must use the resolution above instead — collapsing the
// two here is exactly the conflation this pair was split to end.
export function registryCiFreshnessConfig(
  repoDir: string,
  ghRepo?: string | null,
): CiFreshnessConfig | null {
  const r = resolveRegistryCiFreshnessConfig(repoDir, ghRepo);
  return r.kind === "resolved" ? r.config : null;
}

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
    // CI-freshness axis (Child A / LOOP-242, wired by LOOP-323):
    mergeChecks?: string[];    // check names to validate; absent/empty → axis skipped
    ciIrrelevantPaths?: string[]; // LOOP-335: paths whose change cannot alter a check result
    repoRef?: string;          // LOOP-365: registry key, so the stale hint can name a runnable knob path
    defaultBranch?: string;    // default branch name (default: "main")
    // LOOP-323 AC2: the CLI resolves this from the workspace repo registry — false when the repo
    // is not landing:"pr" + autoMerge, making the axis inapplicable with its own skipReason.
    // undefined (direct function callers, tests) ⇒ treated as eligible (back-compat).
    repoEligible?: boolean;
    // LOOP-444 round 3: the caller COULD NOT SELECT a CI config (≥2 registry entries share the
    // selected remote — resolveRegistryCiFreshnessConfig's `ambiguous`). Distinct from "mergeChecks
    // is empty", which means the axis genuinely has nothing to check. Passed rather than re-derived
    // so the axis reports why it did not run in the caller's own terms.
    ciConfigAmbiguous?: boolean;
  } = {},
): MergeGuardResult {
  // ── Board-state axis (§3.3) ────────────────────────────────────────────────
  // Hub-only: reads tickets table, no forge access needed.
  // Degrades silently (skipped) when the hub DB is absent (linear/local backend).
  let ticketId = opts.ticketId ?? null;
  // LOOP-150: every ticket this PR claims, not just the branch-derived one. Reported, not gated on —
  // see the primary-id note at the resolution site.
  let claimedTicketIds: string[] = [];
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
        // LOOP-150: read the commits and the title/body too, not just the head ref. A PR carrying a
        // second ticket's fix used to make that ticket read as having NO PR AT ALL — PR #97 shipped
        // LOOP-148's fix on `dev-loop/LOOP-142` and LOOP-148 read as unlanded while its code was on
        // main. One `gh` call, the same call, with more fields.
        const r = exec(["pr", "view", String(opts.pr), "--repo", ghRepo, "--json", "headRefName,commits,title,body"]);
        if (!r.ok) {
          prLookupFailure = "forge-unreachable";
        } else {
          const parsed = JSON.parse(r.stdout) as { headRefName?: string; commits?: { messageHeadline?: string; messageBody?: string }[]; title?: string; body?: string };
          claimedTicketIds = prTicketIds({
            branch: parsed.headRefName ?? null,
            commitMessages: (parsed.commits ?? []).flatMap((c) => [c.messageHeadline ?? "", c.messageBody ?? ""]),
            title: parsed.title ?? null,
            body: parsed.body ?? null,
          });
          // The BRANCH-derived id stays the primary — it is the id the PR was cut for, and the board
          // axis has always gated on it. Re-pointing that at a passenger would change what
          // merge-guard blocks on, which this ticket does not ask for.
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
    boardState = { claimedTicketIds, ticketId: null, ticketState: null, trip: false, skipped: true, skipReason: prLookupFailure ?? "no-ticket-input" };
  } else {
    // Resolve dbPath: explicit > DEVLOOP_HUB_DB env > workspace-inferred
    const dbPath = opts.dbPath ?? process.env.DEVLOOP_HUB_DB ?? resolveHubDbPath(repoDir);
    if (!dbPath || !existsSync(dbPath)) {
      boardState = { claimedTicketIds, ticketId, ticketState: null, trip: false, skipped: true, skipReason: "no-hub-db" };
    } else {
      let conn;
      try { conn = openDb(dbPath); }
      catch { conn = null; }
      if (!conn) {
        boardState = { claimedTicketIds, ticketId, ticketState: null, trip: false, skipped: true, skipReason: "hub-db-unreadable" };
      } else {
        try {
          const row = conn.prepare("SELECT state FROM tickets WHERE id=?").get(ticketId) as { state: string } | undefined;
          if (!row) {
            boardState = { claimedTicketIds, ticketId, ticketState: null, trip: false, skipped: false, skipReason: null };
          } else {
            const trip = !isMergeEligible(row.state).eligible;
            boardState = { claimedTicketIds, ticketId, ticketState: row.state, trip, skipped: false, skipReason: null };
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
        // Agent-reviewer exclusion (§3.2): ignore any reviewer that is not a person.
        // TWO sources, unioned — never one replacing the other (LOOP-491 AC1/AC2):
        //   · `team.agentReviewers` — the operator's login list. Still required for a bot that
        //     posts through a User-shaped account (a PAT-driven bot), which no forge field betrays.
        //   · `prState.botLogins` — actors GitHub itself types as `Bot`. Config alone made the
        //     exclusion depend on the operator having hand-typed a login they may never have seen:
        //     an app reviewer nobody enumerated read as a person and held every PR, which is the
        //     inverse of what this axis is for (§12c — the loop may not merge over a PERSON's
        //     objection). An empty botLogins (GraphQL down) degrades to the old, holding behaviour.
        const agentSet = new Set([
          ...(opts.agentReviewers ?? resolveAgentReviewers(repoDir)),
          ...prState.botLogins,
        ]);
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

  // ── CI-freshness axis (design merge-guard-ci-freshness §4 / LOOP-242 Child A, wired LOOP-323) ──
  // Runs readCiFreshness() when --pr is given AND the repo is eligible AND mergeChecks is non-empty.
  let ciFreshness: CiFreshnessResult;
  const mergeChecks = opts.mergeChecks;
  if (opts.pr === undefined || opts.pr === null) {
    ciFreshness = { trip: false, skipped: true, skipReason: "no-pr-arg", verdict: null, behindBy: null, testedHead: null, currentTip: null, reason: null };
  } else if (opts.ciConfigAmbiguous) {
    // Checked BEFORE the two inapplicability branches: under ambiguity the caller has no config to
    // pass, so `mergeChecks` is empty and `repoEligible` undefined for a reason that is neither
    // "empty" nor "ineligible". Reporting either of those would be the conflation again, one layer
    // down — and `untargeted` is what makes `pr merge` refuse instead of squashing (skipClass).
    ciFreshness = { trip: false, skipped: true, skipReason: "ci-config-ambiguous", verdict: null, behindBy: null, testedHead: null, currentTip: null, reason: null };
  } else if (opts.repoEligible === false) {
    ciFreshness = { trip: false, skipped: true, skipReason: "repo-not-automerge", verdict: null, behindBy: null, testedHead: null, currentTip: null, reason: null };
  } else if (!mergeChecks || mergeChecks.length === 0) {
    ciFreshness = { trip: false, skipped: true, skipReason: "no-merge-checks", verdict: null, behindBy: null, testedHead: null, currentTip: null, reason: null };
  } else {
    const ghRepo = opts.ghRepo ?? resolveGhRepo(repoDir);
    if (!ghRepo) {
      ciFreshness = { trip: false, skipped: true, skipReason: "no-repo-resolved", verdict: null, behindBy: null, testedHead: null, currentTip: null, reason: null };
    } else {
      const exec = opts.exec ?? defaultGhExec;
      const defaultBranch = opts.defaultBranch ?? "main";
      const prNumber = typeof opts.pr === "number" ? opts.pr : parseInt(String(opts.pr), 10);
      if (isNaN(prNumber)) {
        ciFreshness = { trip: false, skipped: true, skipReason: "forge-unreachable", verdict: null, behindBy: null, testedHead: null, currentTip: null, reason: null };
      } else {
        const fr = readCiFreshness(exec, ghRepo, prNumber, mergeChecks, defaultBranch, opts.ciIrrelevantPaths, opts.repoRef);
        // LOOP-407 — `check-never-reported` trips UNCONDITIONALLY, like "red" and unlike "stale"
        // (which is behind the rollback constant above). There is no advisory reading of it: the
        // guard is the only machine gate on the Step 0.5 squash, `main` carries no branch
        // protection, and the configured checks are absent, so a non-trip here IS the unverified
        // merge. `pending` still does not trip — a check that exists and is running is §12c's
        // "leave it for the next fire", and holding on it would objection-spam every open PR.
        const trip = fr.verdict === "red"
          || fr.verdict === "check-never-reported"
          || (fr.verdict === "stale" && CI_FRESHNESS_STALE_TRIPS);
        ciFreshness = {
          trip,
          skipped: false,
          skipReason: null,
          verdict: fr.verdict,
          behindBy: fr.behindBy,
          testedHead: fr.testedHead,
          currentTip: fr.currentTip,
          reason: fr.reason,
        };
      }
    }
  }

  const trip = boardState.trip || forgeReview.trip || ciFreshness.trip;
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
        return { trip, boardState, forgeReview, ciFreshness, applied: { action: "skipped_merged" } };
      }
    }

    const tripAxis: "forge" | "board" | "ciFreshness" = forgeReview.trip ? "forge" : boardState.trip ? "board" : "ciFreshness";
    const applied = applyTrip(applyTicketId, dbPath, opts.pr, forgeReview, boardState, tripAxis, ciFreshness);
    return { trip, boardState, forgeReview, ciFreshness, applied };
  }
  return { trip, boardState, forgeReview, ciFreshness };
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
  if (!r.boardState.skipped || !r.forgeReview.skipped || !r.ciFreshness.skipped) return null; // ≥1 axis actually ran
  for (const reason of [r.boardState.skipReason, r.forgeReview.skipReason, r.ciFreshness.skipReason]) {
    if (reason && skipClass(reason) === "untargeted") return reason;
  }
  return null;
}

// CLI: dev-loop merge-guard [--repo <dir>] [--pr <n>] [--ticket <id>] [--strict] [--apply] [--json]
// Exit codes (the write-layer contract): 0 clean/advisory/degraded · 1 trip under --strict ·
// 2 usage · 3 --strict could not evaluate any axis (LOOP-300).
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
  --strict        exit 1 when any axis trips (the merge-pass gate)
  --apply         on a trip: post objection comment + route ticket to blocked/Todo/unassigned (§5.1)
  --json          emit result as JSON

Forge review axis (--pr): trips when a non-agent reviewer has CHANGES_REQUESTED or an unresolved
  review thread. Degrades silently (exit 0) when gh is unavailable, unauth, offline, or no PR found.
Board-state axis: trips when the ticket is In Review / Canceled / Duplicate.
  Degrades silently (exit 0) when no hub DB is available (linear/local backend).
CI-freshness axis (--pr): trips when a PR's green checks were computed against a base behind the
  current tip (stale), or checks are red. Requires mergeChecks to be configured.
--apply: board writes degrade silently when no hub DB; idempotent (no duplicate comments).

--repo defaults to the cwd, but --pr no longer NEEDS it: when the cwd is not the target repo the
  GitHub owner/repo is read from the workspace repo registry. A registry with two or more GitHub
  repos is ambiguous and is refused (exit 3), never guessed — pass --repo <dir>.

Exit codes: 0 clean/advisory/degraded · 1 trip under --strict · 2 usage ·
  3 --strict could not evaluate ANY axis and the cause was the invocation, not an outage.
  A genuine outage (no gh / forge down / no hub db) still degrades to 0 — a merge gate must not
  become a merge freeze.`);
      process.exit(0);
    } else { console.error(`merge-guard: unknown option '${a}'`); process.exit(2); }
  }

  // LOOP-323 AC1: resolve the CI-freshness config from the workspace repo registry so the axis
  // actually runs on the one path that invokes it (Step 0.5 / operators). Before this wiring,
  // opts.mergeChecks was always undefined from the CLI and the axis short-circuited to
  // skipped:"no-merge-checks" on every real invocation — measured on PR #182, which merged with
  // both required checks FAILURE while the axis reported itself not configured.
  // The config is looked up for the repo the axes will actually gate — resolveGhRepo may answer from
  // the registry when the cwd is not the repo, and a path-only lookup then found nothing for it.
  const cfRes = resolveRegistryCiFreshnessConfig(repo, resolveGhRepo(repo));
  const cfCfg = cfRes.kind === "resolved" ? cfRes.config : null;
  let result: MergeGuardResult;
  try {
    result = mergeGuard(repo, {
      ticketId, pr, apply,
      ...(cfRes.kind === "ambiguous" ? { ciConfigAmbiguous: true } : {}),
      ...(cfCfg ? { mergeChecks: cfCfg.mergeChecks, defaultBranch: cfCfg.defaultBranch, repoEligible: cfCfg.repoEligible, ciIrrelevantPaths: cfCfg.ciIrrelevantPaths, repoRef: cfCfg.repoRef } : {}),
    });
  }
  catch (e) { console.error(`merge-guard: ${(e as Error).message.split("\n")[0]}`); process.exit(2); }

  const bs = result.boardState;
  const fr = result.forgeReview;
  const cf = result.ciFreshness;
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
    // CI-freshness axis output
    if (cf.skipped && pr !== undefined) {
      const why = cf.skipReason === "no-merge-checks"
        ? "no mergeChecks configured — axis not applicable"
        : cf.skipReason === "ci-config-ambiguous"
          ? `${cfRes.kind === "ambiguous" ? `${cfRes.paths.length} repo entries share the remote ${cfRes.ghRepo} (${cfRes.paths.join(", ")})` : "the CI config could not be selected"} — pass --repo <dir> to say which one. This axis did NOT run; it is not "nothing to check"`
        : cf.skipReason === "no-repo-resolved"
          ? `could not resolve the GitHub repo from this directory or the workspace repo registry${candidates.length > 1 ? ` (registry has ${candidates.length}: ${candidates.join(", ")} — pass --repo <dir> to disambiguate)` : ""}`
          : "gh unavailable, forge unreachable, or no PR found";
      console.log(`merge-guard: CI-freshness axis skipped — ${why}`);
    } else if (!cf.skipped && cf.trip) {
      const verdict = cf.verdict ?? "unknown";
      console.error(`merge-guard: ⛔ TRIP — PR ciFreshness verdict=${verdict}${cf.reason ? ` (${cf.reason})` : ""}; do not merge until the gate clears`);
    } else if (!cf.skipped && !cf.trip) {
      console.log(`merge-guard: CI-freshness axis clean — ${cf.reason ?? "fresh-green"}`);
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
      console.error(`merge-guard: ⛔ COULD NOT EVALUATE — no axis ran (${hold}); --strict will not report a clean pass for a gate that checked nothing. Fix the invocation (--repo <dir> / --ticket <id> / --pr <n>) and re-run; this is NOT a degrade-to-pass case (the evidence was reachable).`);
      process.exit(EXIT_UNEVALUATED);
    }
  }
  process.exit(0);
}