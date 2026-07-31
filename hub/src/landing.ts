// landing.ts — forge landing reader (LOOP-40, Child A of design landing-observability §6).
// Exports LandingState type + readLandingState(ws, { exec, now, windowMs }).
// Pure detector: never throws, never mutates the forge; all forge failures collapse to explicit
// unknown/na (degradation contract §4). Injectable exec seam for unit testing.
import { spawnSync } from "node:child_process";
import { type Workspace } from "./team-config.ts";

export interface LandingState {
  repo: string;
  state: "stalled" | "healthy" | "unknown" | "na";
  openLoopPRs: number | null;
  oldestAgeDays: number | null;
  baseChecks: "green" | "red" | "unknown" | null;
  mergedInWindow: number | null;
  reason?: string;
}

export type ExecFn = (args: string[]) => { stdout: string; stderr: string; ok: boolean };

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
const GH_TIMEOUT_MS = 5_000;

export function defaultGhExec(args: string[]): { stdout: string; stderr: string; ok: boolean } {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_TIMEOUT_MS,
  });
  if (r.error) throw r.error; // ENOENT → gh not on PATH; thrown → caller returns unknown
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", ok: (r.status ?? 1) === 0 };
}

function extractGitHubRepo(remote: string): string | null {
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

function isAuthError(stderr: string): boolean {
  return /not logged in|gh auth|authentication token|must be authenticated|403 Forbidden/i.test(stderr);
}

function mkUnknown(repo: string, reason: string): LandingState {
  return { repo, state: "unknown", openLoopPRs: null, oldestAgeDays: null, baseChecks: null, mergedInWindow: null, reason };
}

function mkNa(repo: string, reason: string): LandingState {
  return { repo, state: "na", openLoopPRs: null, oldestAgeDays: null, baseChecks: null, mergedInWindow: null, reason };
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

    const defaultBranch = "main"; // RepoEntry has no defaultBranch field; "main" is the universal default
    const mergeChecks = repoEntry.mergeChecks ?? [];

    // 1. Open loop PRs — the primary forge call; its success/failure gates the state
    let openResult: { stdout: string; stderr: string; ok: boolean };
    try {
      openResult = exec([
        "pr", "list",
        "--repo", ghRepo,
        "--state", "open",
        "--limit", "100",
        "--json", "number,headRefName,createdAt,mergeable",
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

    type PRItem = { number: number; headRefName: string; createdAt: string; mergeable: string };
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
      results.push({ repo: ref, state: "stalled", openLoopPRs, oldestAgeDays, baseChecks, mergedInWindow, reason });
    } else {
      results.push({ repo: ref, state: "healthy", openLoopPRs, oldestAgeDays, baseChecks, mergedInWindow });
    }
  }

  return results;
}
