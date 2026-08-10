// landing.ts — forge landing reader (LOOP-40, Child A of design landing-observability §6).
// Exports LandingState type + readLandingState(ws, { exec, now, windowMs }).
// Pure detector: never throws, never mutates the forge; all forge failures collapse to explicit
// unknown/na (degradation contract §4). Injectable exec seam for unit testing.
import { spawnSync } from "node:child_process";
import { ticketIdScanRe } from "./ticket-id.ts";
import { effectiveRepo, type Workspace } from "./team-config.ts";

export interface LandingState {
  repo: string;
  state: "stalled" | "healthy" | "unknown" | "na";
  openLoopPRs: number | null;
  oldestAgeDays: number | null;
  baseChecks: "green" | "red" | "unknown" | null;
  mergedInWindow: number | null;
  prs: Array<{ ticket: string; pr: number; url: string; state: string }> | null;
  reason?: string;
}

// Regex matching a ticket id in any string (e.g. branch names, PR titles/bodies).
// The ONE canonical <PREFIX>-<n> id shape (ticket-id.ts, LOOP-264) — this comment used to say "kept
// local ... until a shared module exists"; it exists now, so this reader stopped hand-copying it.
const TICKET_RE = ticketIdScanRe();

// Parse the ticket id from a PR head-branch name (primary: dev-loop/<id> or fix/<id>-... convention)
// or fall back to the TICKET_RE scan over the PR title + body.
// Returns null when no recognisable id is found.
export function prToTicket(headRefName: string, opts?: { title?: string; body?: string }): string | null {
  const m = headRefName.match(/(?:dev-loop\/|fix\/)([^/\s]+)/);
  if (m) {
    const hit = m[1]!.match(TICKET_RE);
    if (hit) return hit[0]!;
  }
  const text = (opts?.title ?? "") + " " + (opts?.body ?? "");
  const fallback = text.match(TICKET_RE);
  return fallback ? fallback[0]! : null;
}

// The ticket→PR lookup, with the fact `ticketToPr` throws away: whether the forge ANSWERED.
// `pr:null` alone is two different facts — "the forge said this ticket has no PR" and "I could not
// ask the forge" — and collapsing them let a `gh` outage report every ticket as `no-pr`, i.e. as
// positive evidence its increment never landed (LOOP-274; LOOP-111 AC3). `reachable` separates them:
//   reachable:true , pr:X    → the forge answered: this is the PR
//   reachable:true , pr:null → the forge answered: no PR exists (a confident negative)
//   reachable:false, pr:null → could not ask (exec threw, exited non-zero, or returned unparseable JSON)
// This is the single authority for the lookup; `ticketToPr` is its pr-only projection, so the two can
// never drift into disagreeing about what a null means.
export interface TicketPrProbe {
  pr: { pr: number; url: string; state: string } | null;
  reachable: boolean;
}

export function probeTicketPr(
  ghRepo: string,
  ticketId: string,
  opts?: { exec?: ExecFn },
): TicketPrProbe {
  const exec = opts?.exec ?? defaultGhExec;
  try {
    const primary = exec(["pr", "list", "--repo", ghRepo, "--state", "all", "--head", `dev-loop/${ticketId}`, "--json", "number,url,state"]);
    if (primary.ok) {
      const prs = JSON.parse(primary.stdout) as Array<{ number: number; url: string; state: string }>;
      if (prs.length > 0) return { pr: { pr: prs[0]!.number, url: prs[0]!.url, state: prs[0]!.state }, reachable: true };
    }
    // Fallback: search by ticket id text (covers fix/<id>-… and other non-convention branches)
    const search = exec(["pr", "list", "--repo", ghRepo, "--state", "all", "--search", ticketId, "--json", "number,url,state,headRefName,title,body"]);
    if (search.ok) {
      const candidates = JSON.parse(search.stdout) as Array<{ number: number; url: string; state: string; headRefName: string; title: string; body: string }>;
      const match = candidates.find((p) => prToTicket(p.headRefName, { title: p.title, body: p.body }) === ticketId);
      if (match) return { pr: { pr: match.number, url: match.url, state: match.state }, reachable: true };
    }
    // Nothing found. That is only a confident negative when BOTH probes answered: they cover
    // different ground — primary matches the BRANCH convention, search matches ticket-id TEXT — so a
    // failed primary leaves branch-named PRs unchecked even when the search came back clean.
    return { pr: null, reachable: primary.ok && search.ok };
  } catch {
    return { pr: null, reachable: false };
  }
}

// Look up the PR for a given ticket id in a GitHub repo.
// Primary: gh pr list --head dev-loop/<id> (the branch convention).
// Fallback: gh pr list --search <id> filtered through prToTicket for a TICKET_RE match.
// Returns null on any forge failure or when no PR exists — never throws. Callers that must tell
// those two apart use `probeTicketPr` instead; this projection is unchanged by LOOP-274.
export function ticketToPr(
  ghRepo: string,
  ticketId: string,
  opts?: { exec?: ExecFn },
): { pr: number; url: string; state: string } | null {
  return probeTicketPr(ghRepo, ticketId, opts).pr;
}

export type ExecFn = (args: string[]) => { stdout: string; stderr: string; ok: boolean };
// ── CI-freshness reader (design merge-guard-ci-freshness §3 / LOOP-242 Child A) ──────

// LOOP-335: `stale-exempt` — genuinely behind, but the delta cannot change any check result.
// NOT folded into "fresh-green": the head really IS behind, and the dev-agent SKILL keys its
// re-freshen trigger on verdict:"stale". A new name keeps that trigger correct with no §17 edit.
//
// LOOP-407: `check-never-reported` — a check named in `mergeChecks` is ABSENT from the rollup, so it
// was never dispatched and never will report on its own. Split out of `pending` because the two need
// opposite handling: `pending` is a check that exists and is still running (wait for it), while an
// absent check is a hole in the evidence that waiting cannot fill. Measured 2026-08-06: during a
// GitHub Actions `major_outage` PR #246 merged having run NEITHER configured check — a PR with zero
// queued checks presents `mergeStateStatus: CLEAN`, and with no branch protection on `main` there was
// no forge-side gate to withhold it. The four PRs whose checks HAD queued read `UNSTABLE` and
// correctly did not merge: the safer a PR looked, the less had been measured.
export type CiFreshnessVerdict = "fresh-green" | "stale" | "stale-exempt" | "red" | "check-never-reported" | "pending" | "unknown";

/**
 * Is every file in the delta CI-irrelevant? (LOOP-335)
 *
 * `every`, not `some` — one relevant file makes the whole delta relevant, and a PR that has not been
 * tested against it must stale. That distinction is the entire ticket, and its mutation (`every` →
 * `some`) is the specified acceptance bar.
 *
 * Prefix match on a trailing-slash entry (a directory), exact match otherwise. No globs, per the
 * design: a glob language is a second thing to get wrong, and every case this exists for is a file
 * or a directory.
 *
 * An EMPTY delta is never exempt. `files[]` empty while behindBy > 0 means the compare told us
 * nothing about composition, and "we could not see it" must not read as "it was harmless".
 */
export function deltaIsCiIrrelevant(files: string[], irrelevant: string[] | undefined): boolean {
  if (!irrelevant?.length || !files.length) return false;
  return files.every((f) => irrelevant.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}

export interface CiFreshness {
  verdict: CiFreshnessVerdict;
  behindBy: number | null;      // commits origin/<defaultBranch> has that the PR head lacks; null when unknown
  testedHead: string | null;    // the PR head SHA the checks ran on
  currentTip: string | null;    // origin/<defaultBranch> tip SHA at read time
  reason: string;               // human line for the log / --json
}

// Read CI freshness for a single PR. Returns a verdict based on check conclusions and
// whether the tested head is behind the current default branch tip.
// Never throws; all forge failures degrade to `unknown`.
export function readCiFreshness(
  exec: ExecFn,
  ghRepo: string,
  prNumber: number,
  mergeChecks: string[],
  defaultBranch: string,
  ciIrrelevantPaths?: string[], // LOOP-335: paths whose change cannot alter any check result
): CiFreshness {
  try {
    // 1. PR view — get headRefOid + statusCheckRollup
    const prResult = exec(["pr", "view", String(prNumber), "--repo", ghRepo, "--json", "headRefOid,statusCheckRollup"]);
    if (!prResult.ok) {
      return { verdict: "unknown", behindBy: null, testedHead: null, currentTip: null, reason: `gh pr view failed: ${prResult.stderr}` };
    }
    const prData = JSON.parse(prResult.stdout) as { headRefOid?: string; statusCheckRollup?: Array<{ name: string; conclusion: string | null }> };
    const testedHead = prData.headRefOid ?? null;
    const checks = prData.statusCheckRollup ?? [];

    // 2. Evaluate mergeChecks conclusions
    if (mergeChecks.length > 0) {
      const relevant = checks.filter((c) => mergeChecks.includes(c.name));
      if (relevant.some((c) => c.conclusion === "FAILURE")) {
        return { verdict: "red", behindBy: null, testedHead, currentTip: null, reason: "required check(s) have FAILURE conclusion" };
      }
      // LOOP-407 — absence is evaluated BEFORE pending, and after FAILURE so an existing red keeps
      // its own (already-tripping) verdict and remedy. A required check with no entry in the rollup
      // at all was never dispatched: waiting cannot produce it, so it must not share `pending`'s
      // "come back next fire" reading. Named by name — the operator has to know WHICH check is
      // missing to re-run it.
      const missing = mergeChecks.filter((need) => !checks.some((c) => c.name === need));
      if (missing.length > 0) {
        return {
          verdict: "check-never-reported",
          behindBy: null,
          testedHead,
          currentTip: null,
          reason: `required check(s) never reported: ${missing.join(", ")} — absent from the PR's check rollup, so they were never dispatched (a PR with no queued checks reads mergeStateStatus:CLEAN and would merge unverified)`,
        };
      }
      const allSuccess = mergeChecks.every((need) => relevant.some((c) => c.name === need && c.conclusion === "SUCCESS"));
      if (!allSuccess) {
        return { verdict: "pending", behindBy: null, testedHead, currentTip: null, reason: "not all required checks have SUCCESS conclusion yet" };
      }
    }

    // 3. Compare the tested head against the default branch tip
    const compareResult = exec(["api", `/repos/${ghRepo}/compare/${defaultBranch}...${testedHead}`]);
    if (!compareResult.ok) {
      return { verdict: "unknown", behindBy: null, testedHead, currentTip: null, reason: `gh api compare failed: ${compareResult.stderr}` };
    }
    const compareData = JSON.parse(compareResult.stdout) as { behind_by?: number; base_commit?: { sha: string } };
    const behindBy = compareData.behind_by ?? null;
    const currentTip = compareData.base_commit?.sha ?? null;

    if (behindBy !== null && behindBy > 0) {
      // Amendment 2 (LOOP-323 AC5, binding per LOOP-149): the reason must name the delta's FILE
      // COMPOSITION, and the direction matters. The forward compare above
      // (`compare/<defaultBranch>...<testedHead>`) yields the correct `behind_by` but its `files[]`
      // is the PR's OWN diff — the trap LOOP-149 measured on PR #135. The REVERSED compare
      // (`compare/<testedHead>...<defaultBranch>`) yields `ahead_by` = the same number AND the true
      // delta the PR has not been tested against. Degrades to count-only when the second call fails.
      let composition = "file composition unavailable";
      // LOOP-335 — the delta file list is ALREADY in hand here; it was used only to build the reason
      // string while the verdict was decided one branch earlier from `behindBy` alone. So a `main`
      // commit that cannot change any check result staled every open PR. Measured: 10 of the last 25
      // commits on main were docs(strategy), and the union of every file those 10 touch is exactly
      // docs/STRATEGY.md + docs/strategy-archive/2026-08.md — read by no test against the real tree.
      //
      // FAIL-CLOSED on every uncertainty. The compare not running, not parsing, reporting no files,
      // or being TRUNCATED all mean the composition is unknown, and unknown must stale. Truncation
      // beats the exempt rule specifically: a truncated list of exempt files says nothing about the
      // files that were cut.
      let exempt = false;
      const revResult = exec(["api", `/repos/${ghRepo}/compare/${testedHead}...${defaultBranch}`]);
      if (revResult.ok) {
        try {
          const revData = JSON.parse(revResult.stdout) as { files?: Array<{ filename?: string }>; total_commits?: number; commits?: unknown[] };
          const names = (revData.files ?? []).map((f) => f.filename).filter((n): n is string => !!n);
          // GitHub's compare API caps files[] at 300 and commits[] at 250. Either cap means we are
          // looking at a PREFIX of the delta, not the delta.
          const truncated = names.length >= 300
            || (typeof revData.total_commits === "number" && Array.isArray(revData.commits) && revData.total_commits > revData.commits.length);
          if (names.length > 0) {
            const shown = names.slice(0, 5).join(", ");
            composition = `delta touches ${names.length} file(s): ${shown}${names.length > 5 ? ` (+${names.length - 5} more)` : ""}`;
            if (!truncated && deltaIsCiIrrelevant(names, ciIrrelevantPaths)) {
              exempt = true;
              composition = `delta touches ${names.length} CI-irrelevant file(s): ${shown}${names.length > 5 ? ` (+${names.length - 5} more)` : ""}`;
            }
          } else {
            composition = "delta touches 0 files (empty commits)";
          }
        } catch { /* keep the degraded composition string — and stay non-exempt */ }
      }
      if (exempt) {
        return { verdict: "stale-exempt", behindBy, testedHead, currentTip, reason: `head is ${behindBy} commit(s) behind ${defaultBranch} tip ${currentTip ?? "unknown"}, but every file in the delta is configured CI-irrelevant (repos.<ref>.ciIrrelevantPaths) — re-verifying could not change a check result; ${composition}` };
      }
      return { verdict: "stale", behindBy, testedHead, currentTip, reason: `checks green but head is ${behindBy} commit(s) behind ${defaultBranch} tip ${currentTip ?? "unknown"} — not re-verified against the current tip; ${composition}` };
    }
    return { verdict: "fresh-green", behindBy: behindBy ?? 0, testedHead, currentTip, reason: "checks green and head is up to date with current tip" };
  } catch (e) {
    return { verdict: "unknown", behindBy: null, testedHead: null, currentTip: null, reason: `unexpected error: ${(e as Error).message}` };
  }
}

// ── Allow-lists (sourced from `gh pr list --json bogus` and `gh pr view --json bogus` — offline, no network) ──
// Exported so test doubles and callers share one validated field set (LOOP-121 AC3).
export const GH_PR_LIST_FIELDS = new Set([
  "additions", "assignees", "author", "autoMergeRequest", "baseRefName",
  "baseRefOid", "body", "changedFiles", "closed", "closedAt",
  "closingIssuesReferences", "comments", "commits", "createdAt", "deletions",
  "files", "fullDatabaseId", "headRefName", "headRefOid", "headRepository",
  "headRepositoryOwner", "id", "isCrossRepository", "isDraft", "labels",
  "latestReviews", "maintainerCanModify", "mergeCommit", "mergeStateStatus",
  "mergeable", "mergedAt", "mergedBy", "milestone", "number",
  "potentialMergeCommit", "projectCards", "projectItems", "reactionGroups",
  "reviewDecision", "reviewRequests", "reviews", "state", "statusCheckRollup",
  "title", "updatedAt", "url",
]);
// Fields used in the per-ticket annotation probe (pr view); a subset of the same field space.
export const GH_PR_VIEW_ANNOTATION_FIELDS = "state,statusCheckRollup,mergeable";

// ── Per-ticket landing annotation (LOOP-111, LOOP-89 Child B) ──────────────────
export type LandingAnnotation = "merged" | "open-green" | "open-red" | "conflicting" | "no-pr" | "unknown";

// Annotate a single ticket's PR landing state: find its PR via probeTicketPr, then probe CI + mergeability.
// Never throws; all forge failures degrade to "unknown". "no-pr" is a CONFIDENT negative — the forge
// answered and holds no PR for this ticket — and is never returned for a forge that could not be
// asked, because a verifier reads "no-pr" as "this increment never landed" (LOOP-274 / LOOP-111 AC3).
export function annotateTicketLanding(ticketId: string, ghRepo: string, exec: ExecFn): LandingAnnotation {
  try {
    const probe = probeTicketPr(ghRepo, ticketId, { exec });
    const pr = probe.pr;
    if (!pr) return probe.reachable ? "no-pr" : "unknown";
    if (pr.state === "MERGED") return "merged";
    const r = exec(["pr", "view", String(pr.pr), "--repo", ghRepo, "--json", GH_PR_VIEW_ANNOTATION_FIELDS]);
    if (!r.ok) return "unknown";
    const data = JSON.parse(r.stdout) as { mergeable: string; statusCheckRollup: Array<{ conclusion: string | null }> };
    if (data.mergeable === "CONFLICTING") return "conflicting";
    if (data.mergeable === "UNKNOWN") return "unknown";
    const BAD = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
    const checks = (data.statusCheckRollup ?? []).filter((c) => c.conclusion && c.conclusion !== "");
    if (checks.some((c) => BAD.has(c.conclusion!))) return "open-red";
    if (checks.length > 0 && checks.every((c) => !BAD.has(c.conclusion!))) return "open-green";
    return "open-red";
  } catch {
    return "unknown";
  }
}

// ── Per-PR review state (design merge-review-guard §4 / LOOP-64 Child 1) ──────

export interface PrReviewState {
  pr: number;
  reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  changeRequesters: string[];        // logins with an active CHANGES_REQUESTED in latestReviews
  unresolvedThreadAuthors: string[]; // logins with ≥1 unresolved review thread (best-effort GraphQL)
  // LOOP-491: logins GitHub itself reports as a `Bot` actor on this PR (GraphQL `author.__typename`),
  // across both arms. The forge-review axis excludes these WITHOUT the operator having to enumerate
  // them, because "is this reviewer a person" is a fact the forge knows and a config list only
  // guesses. Best-effort like `unresolvedThreadAuthors`: a GraphQL failure leaves it empty, which
  // degrades to "everyone is a person" — the safe direction (§3.4: hold, never merge).
  botLogins: string[];
  url: string;
}

// Returns null on any unreadable/na case — never throws.
export function readPrReviewState(
  ghRepo: string,
  prOrBranch: number | string,
  opts?: { exec?: ExecFn },
): PrReviewState | null {
  const exec = opts?.exec ?? defaultGhExec;
  try {
    // 1. PR view — reviewDecision + latestReviews
    let prResult: { stdout: string; stderr: string; ok: boolean };
    try {
      prResult = exec(["pr", "view", String(prOrBranch), "--repo", ghRepo, "--json", "number,reviewDecision,url,latestReviews"]);
    } catch {
      return null; // gh not on PATH, ENOENT, or network failure
    }
    if (!prResult.ok) return null;

    let prData: { number: number; reviewDecision: string; url: string; latestReviews: Array<{ author: { login: string }; state: string }> };
    try { prData = JSON.parse(prResult.stdout); } catch { return null; }

    const changeRequesters = (prData.latestReviews ?? [])
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => r.author?.login)
      .filter(Boolean) as string[];

    // 2. Unresolved threads + actor types — best-effort GraphQL; failure degrades to empty
    //    (still honours reviewDecision). `__typename` is selected on BOTH author positions: the
    //    thread arm reads it here, and the `reviews` selection exists only to type the authors the
    //    CHANGES_REQUESTED arm found via `latestReviews` — which carries no type field of its own.
    //    Deliberately additive: `latestReviews` keeps deciding WHO requested changes (latest review
    //    per author), and this query only answers WHAT each of them is (LOOP-491 AC5).
    const [owner, repo] = ghRepo.split("/");
    const prNumber = prData.number;
    const unresolvedThreadAuthors: string[] = [];
    const botLogins: string[] = [];
    const noteActor = (a?: { login?: string; __typename?: string }): string | undefined => {
      const login = a?.login;
      if (login && a?.__typename === "Bot" && !botLogins.includes(login)) botLogins.push(login);
      return login;
    };
    try {
      const query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviews(last:100){nodes{author{login,__typename}}},reviewThreads(first:100){nodes{isResolved,comments(first:1){nodes{author{login,__typename}}}}}}}}";
      const gqlResult = exec(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${prNumber}`]);
      if (gqlResult.ok) {
        type Actor = { login: string; __typename?: string } | null;
        const gqlData = JSON.parse(gqlResult.stdout) as { data?: { repository?: { pullRequest?: {
          reviews?: { nodes: Array<{ author: Actor }> };
          reviewThreads?: { nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ author: Actor }> } }> };
        } } } };
        const pr = gqlData?.data?.repository?.pullRequest;
        for (const r of pr?.reviews?.nodes ?? []) noteActor(r?.author ?? undefined);
        for (const t of pr?.reviewThreads?.nodes ?? []) {
          const login = noteActor(t.comments?.nodes?.[0]?.author ?? undefined);
          if (!t.isResolved && login && !unresolvedThreadAuthors.includes(login)) unresolvedThreadAuthors.push(login);
        }
      }
    } catch { /* graphql failure → empty unresolvedThreadAuthors + empty botLogins */ }

    return {
      pr: prData.number,
      reviewDecision: (prData.reviewDecision ?? "") as PrReviewState["reviewDecision"],
      changeRequesters,
      unresolvedThreadAuthors,
      botLogins,
      url: prData.url ?? "",
    };
  } catch {
    return null;
  }
}

const LANDING_STALL_DAYS = 2;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const GH_EXEC_TIMEOUT_MS = 5_000; // per-call spawnSync cap; exported for the enrich deadline

export function makeGhExec(opts?: { timeoutMs?: number }): ExecFn {
  const timeout = opts?.timeoutMs ?? GH_EXEC_TIMEOUT_MS;
  return (args) => {
    const r = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
    if (r.error) throw r.error;
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", ok: (r.status ?? 1) === 0 };
  };
}

export const defaultGhExec: ExecFn = makeGhExec();

function extractGitHubRepo(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

function isAuthError(stderr: string): boolean {
  return /not logged in|gh auth|authentication token|must be authenticated|403 Forbidden/i.test(stderr);
}

function mkUnknown(repo: string, reason: string): LandingState {
  return { repo, state: "unknown", openLoopPRs: null, oldestAgeDays: null, baseChecks: null, mergedInWindow: null, prs: null, reason };
}

function mkNa(repo: string, reason: string): LandingState {
  return { repo, state: "na", openLoopPRs: null, oldestAgeDays: null, baseChecks: null, mergedInWindow: null, prs: null, reason };
}

function readBaseChecks(
  exec: ExecFn,
  ghRepo: string,
  mergeChecks: string[],
  defaultBranch: string,
): "green" | "red" | "unknown" {
  if (mergeChecks.length === 0) return "unknown";
  try {
    const r = exec(["api", `/repos/${ghRepo}/commits/${defaultBranch}/check-runs`]);
    if (!r.ok) return "unknown";
    const parsed = JSON.parse(r.stdout) as { check_runs?: Array<{ name: string; conclusion: string | null }> };
    const runs = parsed.check_runs ?? [];
    const relevant = runs.filter((run) => mergeChecks.includes(run.name));
    if (relevant.length === 0) return "unknown";
    if (relevant.some((run) => run.conclusion === "failure")) return "red";
    if (relevant.every((run) => run.conclusion === "success")) return "green";
    return "unknown"; // some still pending/skipped
  } catch {
    return "unknown";
  }
}

function readMergedInWindow(
  exec: ExecFn,
  ghRepo: string,
  now: number,
  windowMs: number,
): number | null {
  try {
    const r = exec(["pr", "list", "--repo", ghRepo, "--state", "merged", "--limit", "500", "--json", "headRefName,mergedAt"]);
    if (!r.ok) return null;
    const prs = JSON.parse(r.stdout) as Array<{ headRefName: string; mergedAt: string }>;
    return prs.filter(
      (p) => p.headRefName.startsWith("dev-loop/") && now - Date.parse(p.mergedAt) <= windowMs,
    ).length;
  } catch {
    return null;
  }
}

export async function readLandingState(
  ws: Workspace,
  opts: { exec?: ExecFn; now?: number; windowMs?: number } = {},
): Promise<LandingState[]> {
  const exec = opts.exec ?? defaultGhExec;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const results: LandingState[] = [];

  for (const [ref, repoEntry] of Object.entries(ws.file.repos)) {
    // n/a: not qualifying — landing must be "pr" AND autoMerge must be true
    if (repoEntry.landing !== "pr" || !repoEntry.autoMerge) {
      results.push(mkNa(ref, "direct landing"));
      continue;
    }

    // n/a: non-GitHub remote (design §4: "non-GitHub remote → n/a")
    const remote = repoEntry.remote;
    if (!remote) {
      results.push(mkNa(ref, "no remote configured"));
      continue;
    }
    const ghRepo = extractGitHubRepo(remote);
    if (!ghRepo) {
      results.push(mkNa(ref, "non-GitHub remote"));
      continue;
    }

    const defaultBranch = effectiveRepo(ws, ref).defaultBranch;
    const mergeChecks = repoEntry.mergeChecks ?? [];

    // 1. Open loop PRs — the primary forge call; its success/failure gates the state
    let openResult: { stdout: string; stderr: string; ok: boolean };
    try {
      openResult = exec([
        "pr", "list",
        "--repo", ghRepo,
        "--state", "open",
        "--limit", "100",
        "--json", "number,headRefName,createdAt,mergeable,url,statusCheckRollup",
      ]);
    } catch (e) {
      const code = (e as { code?: string }).code;
      const reason = code === "ENOENT" ? "gh CLI not installed" : `forge unreachable: ${(e as Error).message}`;
      results.push(mkUnknown(ref, reason));
      continue;
    }

    if (!openResult.ok) {
      let reason: string;
      if (isAuthError(openResult.stderr)) {
        reason = "gh not authenticated";
      } else if (/Unknown JSON field|unknown flag|accepts at most/i.test(openResult.stderr)) {
        reason = `gh rejected arguments: ${openResult.stderr.split("\n")[0]!}`;
      } else {
        reason = "forge unreachable";
      }
      results.push(mkUnknown(ref, reason));
      continue;
    }

    type PRItem = { number: number; headRefName: string; createdAt: string; mergeable: string; url: string; statusCheckRollup?: Array<{ name: string; conclusion: string | null }> };
    let allOpen: PRItem[];
    try {
      allOpen = JSON.parse(openResult.stdout) as PRItem[];
    } catch {
      results.push(mkUnknown(ref, "forge unreachable: invalid JSON in pr list response"));
      continue;
    }

    const loopOpen = allOpen.filter((p) => p.headRefName.startsWith("dev-loop/"));
    const openLoopPRs = loopOpen.length;
    const oldestAgeDays =
      openLoopPRs > 0
        ? Math.max(...loopOpen.map((p) => (now - Date.parse(p.createdAt)) / (24 * 60 * 60 * 1000)))
        : null;

    // Derive ticket↔PR links from the already-read open loop PRs (design §5.2 / LOOP-66).
    // Null entries (unrecognised branch names) are filtered out; no extra forge call.
    const prs = loopOpen
      .map((p) => {
        const ticket = prToTicket(p.headRefName);
        if (!ticket) return null;
        return { ticket, pr: p.number, url: p.url ?? "", state: "OPEN" };
      })
      .filter((p): p is { ticket: string; pr: number; url: string; state: string } => p !== null);

    // 2. Base checks (best-effort; never blocks classification)
    const baseChecks = readBaseChecks(exec, ghRepo, mergeChecks, defaultBranch);

    // 3. Merged in window (best-effort)
    const mergedInWindow = readMergedInWindow(exec, ghRepo, now, windowMs);

    // 4. Classify per §3: stalled (day-0 red-base, age threshold, or PRs missing required checks), else healthy
    const hasDayZeroStall = baseChecks === "red" && openLoopPRs > 0;
    const hasThresholdStall = loopOpen.some((p) => {
      const ageDays = (now - Date.parse(p.createdAt)) / (24 * 60 * 60 * 1000);
      // LOOP-131 — `gh pr list --json mergeable` returns UNKNOWN on a COLD read: mergeability is
      // computed lazily and the first request only TRIGGERS the computation. UNKNOWN had no branch
      // here, so it collapsed into "not MERGEABLE" — a stall verdict. Measured: three PRs read
      // UNKNOWN at 06:24Z while `gh pr view` returned MERGEABLE/CLEAN for the same PRs, untouched,
      // one minute earlier; minutes later the same list call returned the truth. So the exemption
      // for a healthy old PR was unreachable for exactly the PRs it selects — an old PR is precisely
      // the one whose mergeability has aged out of the cache.
      //
      // UNKNOWN is "not yet computed", not "not mergeable". It is treated as NOT-a-stall so the
      // guard does not manufacture a stall out of a cold cache; a genuinely CONFLICTING PR still
      // reports its true value and still stalls. The direction is deliberate: a missed stall is
      // re-detected on the next poll (this runs on a cadence), while a false stall wakes the
      // operator for nothing and trains them to ignore the signal.
      const mergeUnblocked = p.mergeable === "MERGEABLE" || p.mergeable === "UNKNOWN" || p.mergeable == null;
      return ageDays > LANDING_STALL_DAYS && !(mergeUnblocked && baseChecks === "green");
    });
    // LOOP-424 AC1: stalled when any open dev-loop/* PR's statusCheckRollup omits a required check
    const hasPrMissingChecks = mergeChecks.length > 0 && loopOpen.some((p) => {
      // AC5: a MISSING statusCheckRollup field (forge didn't return it) is not evidence of absence
      const rollup = p.statusCheckRollup;
      if (!rollup) return false;
      const names = new Set(rollup.map((c) => c.name));
      return mergeChecks.some((need) => !names.has(need));
    });

    if (hasDayZeroStall || hasThresholdStall || hasPrMissingChecks) {
      const reason = hasDayZeroStall
        ? `base '${defaultBranch}' required checks red — autoMerge structurally blocked`
        : hasPrMissingChecks
          ? (() => {
            const missing = new Set<string>();
            for (const p of loopOpen) {
              const rollup = p.statusCheckRollup;
              if (rollup) {
                const names = new Set(rollup.map((c) => c.name));
                for (const need of mergeChecks) {
                  if (!names.has(need)) missing.add(need);
                }
              }
            }
            return `${openLoopPRs} PR(s) open missing required checks: ${[...missing].join(", ")} — autoMerge cannot fire`;
          })()
        : `${openLoopPRs} PR(s) open >${LANDING_STALL_DAYS}d without MERGEABLE+green status`;
      results.push({ repo: ref, state: "stalled", openLoopPRs, oldestAgeDays, baseChecks, mergedInWindow, prs, reason });
    } else {
      results.push({ repo: ref, state: "healthy", openLoopPRs, oldestAgeDays, baseChecks, mergedInWindow, prs });
    }
  }

  return results;
}
