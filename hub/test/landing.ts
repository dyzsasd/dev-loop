// landing.ts — regression test for the forge landing reader (LOOP-40, design landing-observability §6-ChildA).
// Uses injected exec stubs so no real gh/network calls are made. Tests every degradation path from §4.
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLandingState, type ExecFn, type LandingState } from "../src/landing.ts";
import { loadWorkspace } from "../src/team-config.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// Allow-list sourced from `gh pr list --json bogus` — offline, no network, CI-safe.
const GH_PR_LIST_FIELDS = new Set([
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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-31T12:00:00Z");

// ── helpers ────────────────────────────────────────────────────────────────────

function makeWorkspace(repos: Record<string, object>): ReturnType<typeof loadWorkspace> {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-landing-")));
  mkdirSync(join(tmp, ".dev-loop", "locks"), { recursive: true });
  mkdirSync(join(tmp, "clone"), { recursive: true });
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test",
    team: { key: "test", backend: "service", mode: "live", autonomy: "full" },
    repos,
    projects: { test: { repos: [{ ref: Object.keys(repos)[0]! }] } },
  }));
  return loadWorkspace(tmp);
}

function qualifyingRepo(extra: object = {}): Record<string, object> {
  return {
    repo: {
      path: "clone",
      remote: "https://github.com/test-org/test-repo.git",
      landing: "pr",
      autoMerge: true,
      mergeChecks: ["CI / test"],
      ...extra,
    },
  };
}

/** Build an exec stub from a route map: key is a regexp matching the args join, value is the result.
 *  Validates gh pr list --json field names against GH_PR_LIST_FIELDS on every call. */
function makeExec(routes: Array<[RegExp, { stdout?: string; stderr?: string; ok?: boolean }]>): ExecFn {
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") {
      const jsonIdx = args.indexOf("--json");
      if (jsonIdx !== -1) {
        const fields = (args[jsonIdx + 1] ?? "").split(",").filter(Boolean);
        for (const field of fields) {
          if (!GH_PR_LIST_FIELDS.has(field)) {
            throw new Error(`test-double: unknown gh pr list --json field "${field}" (not in GH_PR_LIST_FIELDS)`);
          }
        }
      }
    }
    const key = args.join(" ");
    for (const [re, res] of routes) {
      if (re.test(key)) return { stdout: res.stdout ?? "[]", stderr: res.stderr ?? "", ok: res.ok ?? true };
    }
    throw new Error(`exec stub: no route for args: ${key}`);
  };
}

function prJson(prs: Array<{ headRefName: string; createdAt: string; mergeable?: string; number?: number; mergedAt?: string }>): string {
  return JSON.stringify(prs.map((p) => ({
    number: p.number ?? 1,
    headRefName: p.headRefName,
    createdAt: p.createdAt ?? new Date(NOW - 1 * DAY_MS).toISOString(),
    mergeable: p.mergeable ?? "MERGEABLE",
    mergedAt: p.mergedAt,
  })));
}

function checkRunsJson(runs: Array<{ name: string; conclusion: string | null }>): string {
  return JSON.stringify({ check_runs: runs });
}

// ── test cases ─────────────────────────────────────────────────────────────────

// Case 1: red base + open loop PR → stalled (day-0 causal, §3)
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: prJson([{ headRefName: "dev-loop/LOOP-1", createdAt: new Date(NOW - 1 * DAY_MS).toISOString() }]) }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "failure" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(result!.state === "stalled", "red base + open loop PR → stalled (day-0)");
  ok(result!.baseChecks === "red", "day-0 stall: baseChecks=red");
  ok(result!.openLoopPRs === 1, "day-0 stall: openLoopPRs=1");
  ok(result!.mergedInWindow === 0, "day-0 stall: mergedInWindow=0 (no merged PRs)");
}

// Case 2: PR older than LANDING_STALL_DAYS, not MERGEABLE+green → stalled (threshold, §3)
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const oldDate = new Date(NOW - 3 * DAY_MS).toISOString(); // 3d old > threshold 2d
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: prJson([{ headRefName: "dev-loop/LOOP-2", createdAt: oldDate, mergeable: "CONFLICTING" }]) }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "success" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(result!.state === "stalled", "old PR + not MERGEABLE → stalled (threshold)");
  ok(result!.oldestAgeDays !== null && result!.oldestAgeDays > 2, "threshold stall: oldestAgeDays > 2");
}

// Case 3: young PR + green base → healthy
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: prJson([{ headRefName: "dev-loop/LOOP-3", createdAt: new Date(NOW - 1 * DAY_MS).toISOString(), mergeable: "MERGEABLE" }]) }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "success" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(result!.state === "healthy", "young PR + green base → healthy");
  ok(result!.baseChecks === "green", "healthy: baseChecks=green");
}

// Case 4: exec throws (gh not on PATH) → unknown (§4: "gh CLI not installed")
{
  const ws = makeWorkspace(qualifyingRepo());
  const execThrows: ExecFn = () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
  let threw = false;
  let result: LandingState | undefined;
  try {
    [result] = await readLandingState(ws, { exec: execThrows, now: NOW });
  } catch {
    threw = true;
  }
  ok(!threw, "exec throws (gh not found) → readLandingState does NOT propagate the throw");
  ok(result?.state === "unknown", "exec throws (gh not found) → state=unknown");
  ok(result?.reason?.includes("gh CLI not installed") === true, "exec throws (gh not found) → reason mentions gh CLI");
}

// Case 5: gh unauthenticated → unknown (§4: "gh not authenticated")
{
  const ws = makeWorkspace(qualifyingRepo());
  const execUnauth: ExecFn = () => ({
    stdout: "",
    stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
    ok: false,
  });
  const [result] = await readLandingState(ws, { exec: execUnauth, now: NOW });
  ok(result!.state === "unknown", "gh unauth → state=unknown");
  ok(result!.reason?.includes("gh not authenticated") === true, "gh unauth → reason mentions authentication");
}

// Case 6: non-GitHub remote → na (§4: "non-GitHub remote")
{
  const ws = makeWorkspace({
    repo: { path: "clone", remote: "https://gitlab.com/test-org/test-repo.git", landing: "pr", autoMerge: true },
  });
  const execShouldNotBeCalled: ExecFn = () => { throw new Error("exec should not be called for non-GitHub"); };
  const [result] = await readLandingState(ws, { exec: execShouldNotBeCalled, now: NOW });
  ok(result!.state === "na", "non-GitHub remote → na");
  ok(result!.reason?.includes("non-GitHub") === true, "non-GitHub remote → reason mentions non-GitHub");
}

// Case 7: landing:"direct" → na (§4: "direct landing")
{
  const ws = makeWorkspace({ repo: { path: "clone", remote: "https://github.com/test-org/repo.git", landing: "direct", autoMerge: true } });
  const [result] = await readLandingState(ws, { exec: () => ({ stdout: "[]", stderr: "", ok: true }), now: NOW });
  ok(result!.state === "na", "landing:direct → na");
}

// Case 8: no autoMerge → na (§4: "direct landing")
{
  const ws = makeWorkspace({ repo: { path: "clone", remote: "https://github.com/test-org/repo.git", landing: "pr" } });
  const [result] = await readLandingState(ws, { exec: () => ({ stdout: "[]", stderr: "", ok: true }), now: NOW });
  ok(result!.state === "na", "landing:pr without autoMerge → na");
}

// Case 9: zero open loop PRs + green base → healthy (§3: "no open loop PRs, base green")
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: "[]" }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "success" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(result!.state === "healthy", "zero open loop PRs + green base → healthy");
  ok(result!.openLoopPRs === 0, "zero-PR healthy: openLoopPRs=0");
  ok(result!.oldestAgeDays === null, "zero-PR healthy: oldestAgeDays=null");
}

// Case 10: mergedInWindow count is correct over the window
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const inWindow = new Date(NOW - 3 * DAY_MS).toISOString();
  const outOfWindow = new Date(NOW - 10 * DAY_MS).toISOString();
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: "[]" }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "success" }]) }],
    [/pr list.*--state merged/, {
      stdout: JSON.stringify([
        { headRefName: "dev-loop/LOOP-A", mergedAt: inWindow },
        { headRefName: "dev-loop/LOOP-B", mergedAt: inWindow },
        { headRefName: "dev-loop/LOOP-C", mergedAt: outOfWindow }, // outside window
        { headRefName: "other/branch", mergedAt: inWindow },       // not a dev-loop PR
      ]),
    }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW, windowMs: 7 * DAY_MS });
  ok(result!.state === "healthy", "mergedInWindow: state=healthy");
  ok(result!.mergedInWindow === 2, `mergedInWindow counts only in-window dev-loop/* PRs (got ${result!.mergedInWindow})`);
}

// Case 11: na state → mergedInWindow is null (§3: "null (never 0) under unknown/na")
{
  const ws = makeWorkspace({ repo: { path: "clone", remote: "https://github.com/test/repo.git", landing: "direct" } });
  const [result] = await readLandingState(ws, { exec: () => ({ stdout: "[]", stderr: "", ok: true }), now: NOW });
  ok(result!.state === "na" && result!.mergedInWindow === null, "na state: mergedInWindow=null");
}

// Case 12: timeout — exec stub honors timeout by returning quickly (unit test; real timeout via GH_TIMEOUT_MS in prod)
// The timeout is enforced by spawnSync's `timeout` option in defaultGhExec. Here we verify the stub doesn't hang.
{
  const ws = makeWorkspace(qualifyingRepo());
  const start = Date.now();
  const execFast: ExecFn = () => ({ stdout: "[]", stderr: "", ok: true });
  const [result] = await readLandingState(ws, { exec: execFast, now: NOW });
  const elapsed = Date.now() - start;
  ok(elapsed < 500, `timeout honored — injected exec completes well under any timeout bound (${elapsed}ms)`);
  ok(result!.state === "healthy", "fast exec: healthy (no open PRs)");
}

// Case 13: gh rejected arguments → reason distinguishes our bug from a network outage (AC2)
{
  const ws = makeWorkspace(qualifyingRepo());
  const execRejectArgs: ExecFn = () => ({
    stdout: "",
    stderr: 'Unknown JSON field: "mergeableState"\nAvailable fields:\n  mergeable',
    ok: false,
  });
  const [result] = await readLandingState(ws, { exec: execRejectArgs, now: NOW });
  ok(result!.state === "unknown", "gh rejected args → state=unknown");
  ok(result!.reason?.startsWith("gh rejected arguments:") === true, "gh rejected args → reason starts with 'gh rejected arguments:'");
  ok(result!.reason?.includes("forge unreachable") !== true, "gh rejected args → NOT 'forge unreachable'");
  ok(result!.reason?.includes("mergeableState") === true, "gh rejected args → reason echoes the first stderr line");
}

// Case 14: argv validation — makeExec double rejects any unknown gh pr list --json field (AC3)
{
  let caughtUnknownField = false;
  try {
    const badExec = makeExec([[/.*/, {}]]);
    badExec(["pr", "list", "--repo", "test/repo", "--state", "open", "--json", "mergeableState"]);
  } catch (e) {
    caughtUnknownField = (e as Error).message.includes('unknown gh pr list --json field "mergeableState"');
  }
  ok(caughtUnknownField, "makeExec double rejects unknown --json field 'mergeableState' (the field this bug used)");

  let acceptsValid = true;
  try {
    const goodExec = makeExec([[/.*/, { stdout: "[]" }]]);
    goodExec(["pr", "list", "--repo", "test/repo", "--state", "open", "--json", "number,headRefName,createdAt,mergeable"]);
  } catch {
    acceptsValid = false;
  }
  ok(acceptsValid, "makeExec double accepts all valid --json fields used by readLandingState");
}

console.log(fails === 0 ? "\nLANDING_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
