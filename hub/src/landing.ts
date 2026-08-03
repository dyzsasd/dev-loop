// landing.ts — forge landing reader (LOOP-40, Child A of design landing-observability §6).
// Exports LandingState type + readLandingState(ws, { exec, now, windowMs }).
// Pure detector: never throws, never mutates the forge; all forge failures collapse to explicit
// unknown/na (degradation contract §4). Injectable exec seam for unit testing.
import { spawnSync } from "node:child_process";
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
// Mirrors push-guard.ts's TICKET_RE — kept local to avoid a cross-module dep until a shared
// constants module is warranted (design merge-review-guard §5.2, LOOP-66).
const TICKET_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/;

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

// Look up the PR for a given ticket id in a GitHub repo.
// Primary: gh pr list --head dev-loop/<id> (the branch convention).
// Fallback: gh pr list --search <id> filtered through prToTicket for a TICKET_RE match.
// Returns null on any forge failure or when no PR exists — never throws.
export function ticketToPr(
  ghRepo: string,
  ticketId: string,
  opts?: { exec?: ExecFn },
): { pr: number; url: string; state: string } | null {
  const exec = opts?.exec ?? defaultGhExec;
  try {
    const primary = exec(["pr", "list", "--repo", ghRepo, "--state", "all", "--head", `dev-loop/${ticketId}`, "--json", "number,url,state"]);
    if (primary.ok) {
      const prs = JSON.parse(primary.stdout) as Array<{ number: number; url: string; state: string }>;
      if (prs.length > 0) return { pr: prs[0]!.number, url: prs[0]!.url, state: prs[0]!.state };
    }
    // Fallback: search by ticket id text (covers fix/<id>-… and other non-convention branches)
    const search = exec(["pr", "list", "--repo", ghRepo, "--state", "all", "--search", ticketId, "--json", "number,url,state,headRefName,title,body"]);
    if (search.ok) {
      const candidates = JSON.parse(search.stdout) as Array<{ number: number; url: string; state: string; headRefName: string; title: string; body: string }>;
      const match = candidates.find((p) => prToTicket(p.headRefName, { title: p.title, body: p.body }) === ticketId);
      if (match) return { pr: match.number, url: match.url, state: match.state };
    }
    return null;
  } catch {
    return null;
  }
}

export type ExecFn = (args: string[]) => { stdout: string; stderr: string; ok: boolean };

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

// Annotate a single ticket's PR landing state: find its PR via ticketToPr, then probe CI + mergeability.
// Never throws; all forge failures degrade to "unknown". "no-pr" means no PR was found at all.
export function annotateTicketLanding(ticketId: string, ghRepo: string, exec: ExecFn): LandingAnnotation {
  try {
    const pr = ticketToPr(ghRepo, ticketId, { exec });
    if (!pr) return "no-pr";
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

    // 2. Unresolved threads — best-effort GraphQL; failure degrades to empty (still honours reviewDecision)
    const [owner, repo] = ghRepo.split("/");
    const prNumber = prData.number;
    const unresolvedThreadAuthors: string[] = [];
    try {
      const query = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved,comments(first:1){nodes{author{login}}}}}}}}";
      const gqlResult = exec(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${prNumber}`]);
      if (gqlResult.ok) {
        const gqlData = JSON.parse(gqlResult.stdout) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ author: { login: string } }> } }> } } } } };
        const threads = gqlData?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
        for (const t of threads) {
          if (!t.isResolved) {
            const login = t.comments.nodes[0]?.author?.login;
            if (login && !unresolvedThreadAuthors.includes(login)) unresolvedThreadAuthors.push(login);
          }
        }
      }
    } catch { /* graphql failure → empty unresolvedThreadAuthors */ }

    return {
      pr: prData.number,
      reviewDecision: (prData.reviewDecision ?? "") as PrReviewState["reviewDecision"],
      changeRequesters,
      unresolvedThreadAuthors,
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
        "--json", "number,headRefName,createdAt,mergeable,url",
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

    type PRItem = { number: number; headRefName: string; createdAt: string; mergeable: string; url: string };
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

    // 4. Classify per §3: stalled (day-0 red-base, or age threshold), else healthy
    const hasDayZeroStall = baseChecks === "red" && openLoopPRs > 0;
    const hasThresholdStall = loopOpen.some((p) => {
      const ageDays = (now - Date.parse(p.createdAt)) / (24 * 60 * 60 * 1000);
      // stalled at threshold: old enough AND not fully unblocked (MERGEABLE + green base)
      return ageDays > LANDING_STALL_DAYS && !(p.mergeable === "MERGEABLE" && baseChecks === "green");
    });

    if (hasDayZeroStall || hasThresholdStall) {
      const reason = hasDayZeroStall
        ? `base '${defaultBranch}' required checks red — autoMerge structurally blocked`
        : `${openLoopPRs} PR(s) open >${LANDING_STALL_DAYS}d without MERGEABLE+green status`;
      results.push({ repo: ref, state: "stalled", openLoopPRs, oldestAgeDays, baseChecks, mergedInWindow, prs, reason });
    } else {
      results.push({ repo: ref, state: "healthy", openLoopPRs, oldestAgeDays, baseChecks, mergedInWindow, prs });
    }
  }

  return results;
}
