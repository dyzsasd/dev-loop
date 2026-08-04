// landing.ts — regression test for the forge landing reader (LOOP-40, design landing-observability §6-ChildA).
// Uses injected exec stubs so no real gh/network calls are made. Tests every degradation path from §4.
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLandingState, ticketToPr, probeTicketPr, prToTicket, annotateTicketLanding, GH_PR_LIST_FIELDS, type ExecFn, type LandingState } from "../src/landing.ts";
import { loadWorkspace } from "../src/team-config.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

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
    if ((args[0] === "pr" && args[1] === "list") || (args[0] === "pr" && args[1] === "view")) {
      const jsonIdx = args.indexOf("--json");
      if (jsonIdx !== -1) {
        const fields = (args[jsonIdx + 1] ?? "").split(",").filter(Boolean);
        for (const field of fields) {
          if (!GH_PR_LIST_FIELDS.has(field)) {
            throw new Error(`test-double: unknown gh pr ${args[1]} --json field "${field}" (not in GH_PR_LIST_FIELDS)`);
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

function prJson(prs: Array<{ headRefName: string; createdAt?: string; mergeable?: string; number?: number; mergedAt?: string; url?: string; state?: string; title?: string; body?: string }>): string {
  return JSON.stringify(prs.map((p) => ({
    number: p.number ?? 1,
    headRefName: p.headRefName,
    createdAt: p.createdAt ?? new Date(NOW - 1 * DAY_MS).toISOString(),
    mergeable: p.mergeable ?? "MERGEABLE",
    mergedAt: p.mergedAt,
    url: p.url ?? `https://github.com/test-org/test-repo/pull/${p.number ?? 1}`,
    state: p.state ?? "OPEN",
    title: p.title ?? `PR for ${p.headRefName}`,
    body: p.body ?? "",
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
    goodExec(["pr", "list", "--repo", "test/repo", "--state", "open", "--json", "number,headRefName,createdAt,mergeable,url"]);
  } catch {
    acceptsValid = false;
  }
  ok(acceptsValid, "makeExec double accepts all valid --json fields used by readLandingState (incl. url)");
}

// ── LOOP-66: prToTicket / ticketToPr + prs field in LandingState ──────────────

// Case 15: prToTicket — primary dev-loop/<id> branch convention
{
  ok(prToTicket("dev-loop/LOOP-66") === "LOOP-66", "prToTicket: dev-loop/<id> → ticket id");
  ok(prToTicket("dev-loop/LOOP-1") === "LOOP-1", "prToTicket: dev-loop/LOOP-1 → LOOP-1");
}

// Case 16: prToTicket — fix/<id>-... branch convention (the explicit non-dev-loop-slash-id path)
{
  ok(prToTicket("fix/LOOP-45-description") === "LOOP-45", "prToTicket: fix/<id>-… → ticket id");
}

// Case 17: prToTicket — non-standard branch, fallback to TICKET_RE over title/body
{
  ok(prToTicket("feature/some-work", { title: "Implements LOOP-99: new feature", body: "" }) === "LOOP-99",
    "prToTicket: non-standard branch, title fallback → LOOP-99");
  ok(prToTicket("feature/some-work") === null,
    "prToTicket: non-standard branch, no title/body → null");
}

// Case 18: ticketToPr — found via primary head-branch lookup
{
  const exec: ExecFn = (args) => {
    const joined = args.join(" ");
    if (/--head dev-loop\/LOOP-66/.test(joined))
      return { stdout: JSON.stringify([{ number: 77, url: "https://github.com/test/repo/pull/77", state: "OPEN" }]), stderr: "", ok: true };
    return { stdout: "[]", stderr: "", ok: true };
  };
  const result = ticketToPr("test/repo", "LOOP-66", { exec });
  ok(result !== null, "ticketToPr: primary lookup finds PR");
  ok(result?.pr === 77, "ticketToPr: primary lookup returns correct PR number");
  ok(result?.url === "https://github.com/test/repo/pull/77", "ticketToPr: primary lookup returns correct URL");
  ok(result?.state === "OPEN", "ticketToPr: primary lookup returns state");
}

// Case 19: ticketToPr — primary returns empty, fallback search finds PR via TICKET_RE on title
{
  const exec: ExecFn = (args) => {
    const joined = args.join(" ");
    if (/--head dev-loop\/LOOP-45/.test(joined)) return { stdout: "[]", stderr: "", ok: true };
    if (/--search LOOP-45/.test(joined))
      return {
        stdout: JSON.stringify([{
          number: 55,
          url: "https://github.com/test/repo/pull/55",
          state: "MERGED",
          headRefName: "fix/LOOP-45-fix-typo",
          title: "Fix typo in LOOP-45",
          body: "",
        }]),
        stderr: "",
        ok: true,
      };
    return { stdout: "[]", stderr: "", ok: true };
  };
  const result = ticketToPr("test/repo", "LOOP-45", { exec });
  ok(result !== null, "ticketToPr: search fallback finds PR when primary empty");
  ok(result?.pr === 55, "ticketToPr: search fallback returns correct PR number");
  ok(result?.state === "MERGED", "ticketToPr: search fallback returns MERGED state");
}

// Case 20: ticketToPr — no PR exists → null (no throw)
{
  const exec: ExecFn = () => ({ stdout: "[]", stderr: "", ok: true });
  const result = ticketToPr("test/repo", "LOOP-999", { exec });
  ok(result === null, "ticketToPr: no PR for ticket → null (no throw)");
}

// Case 21: ticketToPr — forge unreadable → null (never throws)
{
  const exec: ExecFn = () => { throw new Error("ENOENT"); };
  let threw = false;
  let result: ReturnType<typeof ticketToPr> = null;
  try { result = ticketToPr("test/repo", "LOOP-66", { exec }); }
  catch { threw = true; }
  ok(!threw, "ticketToPr: forge throw → returns null, never propagates");
  ok(result === null, "ticketToPr: forge throw → null result");
}

// Case 22: readLandingState populates prs[] from open loop PRs (design §5.2 / LOOP-66)
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: prJson([
      { headRefName: "dev-loop/LOOP-10", number: 10, url: "https://github.com/test-org/test-repo/pull/10" },
      { headRefName: "dev-loop/LOOP-11", number: 11, url: "https://github.com/test-org/test-repo/pull/11" },
      { headRefName: "other-branch", number: 12 }, // no ticket id → filtered out of prs
    ]) }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "success" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(result!.prs !== null, "prs field is non-null when open loop PRs exist");
  ok(result!.prs!.length === 2, `prs: only dev-loop/<id> branches included (got ${result!.prs!.length})`);
  ok(result!.prs![0]!.ticket === "LOOP-10", "prs[0].ticket = LOOP-10");
  ok(result!.prs![0]!.pr === 10, "prs[0].pr = 10");
  ok(result!.prs![0]!.url === "https://github.com/test-org/test-repo/pull/10", "prs[0].url correct");
  ok(result!.prs![0]!.state === "OPEN", "prs[0].state = OPEN");
  ok(result!.prs![1]!.ticket === "LOOP-11", "prs[1].ticket = LOOP-11");
}

// Case 23: readLandingState with no open loop PRs → prs is [] (empty, not null)
{
  const ws = makeWorkspace(qualifyingRepo({ mergeChecks: ["CI / test"] }));
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: "[]" }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI / test", conclusion: "success" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(Array.isArray(result!.prs), "prs is an array (not null) when forge readable with no loop PRs");
  ok(result!.prs!.length === 0, "prs is empty when no open loop PRs");
}

// Case 24: readLandingState prs=null when state=unknown (forge failure)
{
  const ws = makeWorkspace(qualifyingRepo());
  const execFail: ExecFn = () => ({ stdout: "", stderr: "not logged in", ok: false });
  const [result] = await readLandingState(ws, { exec: execFail, now: NOW });
  ok(result!.state === "unknown", "forge failure → state=unknown");
  ok(result!.prs === null, "forge failure → prs=null (not empty array)");
}

// ── annotateTicketLanding (LOOP-111, LOOP-89 Child B) ─────────────────────────

// Helper: build a statusCheckRollup JSON string for pr view stub
function viewJson(opts: { state?: string; mergeable?: string; checks?: Array<{ conclusion: string }> }): string {
  return JSON.stringify({
    state: opts.state ?? "OPEN",
    mergeable: opts.mergeable ?? "MERGEABLE",
    statusCheckRollup: opts.checks ?? [],
  });
}

const REPO = "test-org/test-repo";
const PR_LIST_MERGED = JSON.stringify([{ number: 5, url: "https://github.com/test-org/test-repo/pull/5", state: "MERGED" }]);
const PR_LIST_OPEN = JSON.stringify([{ number: 7, url: "https://github.com/test-org/test-repo/pull/7", state: "OPEN" }]);

// Case 25: MERGED PR → "merged"
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-25/, { stdout: PR_LIST_MERGED }],
  ]);
  ok(annotateTicketLanding("LOOP-25", REPO, exec) === "merged", "annotateTicketLanding: MERGED PR → 'merged'");
}

// Case 26: open PR with all-SUCCESS checks → "open-green"
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-26/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: viewJson({ checks: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }] }) }],
  ]);
  ok(annotateTicketLanding("LOOP-26", REPO, exec) === "open-green", "annotateTicketLanding: all-SUCCESS checks → 'open-green'");
}

// Case 27: open PR with a FAILURE check → "open-red"
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-27/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: viewJson({ checks: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }] }) }],
  ]);
  ok(annotateTicketLanding("LOOP-27", REPO, exec) === "open-red", "annotateTicketLanding: FAILURE check → 'open-red'");
}

// Case 28: CONFLICTING PR → "conflicting"
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-28/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: viewJson({ mergeable: "CONFLICTING" }) }],
  ]);
  ok(annotateTicketLanding("LOOP-28", REPO, exec) === "conflicting", "annotateTicketLanding: CONFLICTING → 'conflicting'");
}

// Case 29 (LOOP-274): the GENUINE no-pr — the forge ANSWERED (ok:true) and holds no PR for this
// ticket. This is the only shape that may yield "no-pr"; cases 30/30b/30c/30d pin the negatives it
// must NOT be confused with.
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-29/, { stdout: "[]" }],
    [/pr list.*--search LOOP-29/, { stdout: "[]" }],
  ]);
  ok(annotateTicketLanding("LOOP-29", REPO, exec) === "no-pr", "annotateTicketLanding: forge reachable + empty result → 'no-pr'");
}

// Case 30 (LOOP-274, was asserting the defect): exec ok:false → "unknown", NOT "no-pr".
// "no-pr" is what tells a verifier the increment never landed; an auth failure must never say that.
{
  const failExec: ExecFn = () => ({ stdout: "", stderr: "auth error", ok: false });
  let threw = false;
  let result: string = "threw";
  try { result = annotateTicketLanding("LOOP-30", REPO, failExec); } catch { threw = true; }
  ok(!threw, "annotateTicketLanding: exec ok:false never throws");
  ok(result === "unknown", `annotateTicketLanding: exec ok:false → 'unknown' (could not ask ≠ no PR, got '${result}')`);
}

// Case 30b (LOOP-274, was asserting the defect): exec throws (gh absent) → "unknown", NOT "no-pr".
{
  const throwExec: ExecFn = () => { throw new Error("ENOENT: spawn gh"); };
  let threw = false;
  let result: string = "threw";
  try { result = annotateTicketLanding("LOOP-30b", REPO, throwExec); } catch { threw = true; }
  ok(!threw, "annotateTicketLanding: exec throw never propagates");
  ok(result === "unknown", `annotateTicketLanding: exec throws → 'unknown' (could not ask ≠ no PR, got '${result}')`);
}

// Case 30c (LOOP-274): the MIXED probe — the branch-convention lookup FAILED, the text search
// answered and found nothing. Not a confident negative: the two probes cover different ground, so a
// PR named dev-loop/<id> whose text omits the id was never checked. Must be "unknown".
{
  const exec: ExecFn = (args) => args.includes("--head")
    ? { stdout: "", stderr: "server error", ok: false }
    : { stdout: "[]", stderr: "", ok: true };
  ok(annotateTicketLanding("LOOP-30c", REPO, exec) === "unknown",
    "annotateTicketLanding: primary probe failed + search empty → 'unknown' (not a confident negative)");
}

// Case 30d (LOOP-274): the forge exits 0 with unparseable JSON — we could not read the answer,
// so it is "unknown", not a negative.
{
  const exec: ExecFn = () => ({ stdout: "not json", stderr: "", ok: true });
  let threw = false;
  let result: string = "threw";
  try { result = annotateTicketLanding("LOOP-30d", REPO, exec); } catch { threw = true; }
  ok(!threw, "annotateTicketLanding: unparseable forge JSON never throws");
  ok(result === "unknown", `annotateTicketLanding: unparseable forge JSON → 'unknown' (got '${result}')`);
}

// Case 30e (LOOP-274): probeTicketPr's own contract — the fact ticketToPr projects away.
// Both callers must agree on the PR itself while only the probe carries reachability.
{
  const okEmpty: ExecFn = () => ({ stdout: "[]", stderr: "", ok: true });
  const p1 = probeTicketPr(REPO, "LOOP-30e", { exec: okEmpty });
  ok(p1.pr === null && p1.reachable === true, "probeTicketPr: forge answered, no PR → {pr:null, reachable:true}");

  const failExec: ExecFn = () => ({ stdout: "", stderr: "auth error", ok: false });
  const p2 = probeTicketPr(REPO, "LOOP-30e", { exec: failExec });
  ok(p2.pr === null && p2.reachable === false, "probeTicketPr: exec ok:false → {pr:null, reachable:false}");

  const throwExec: ExecFn = () => { throw new Error("ENOENT"); };
  const p3 = probeTicketPr(REPO, "LOOP-30e", { exec: throwExec });
  ok(p3.pr === null && p3.reachable === false, "probeTicketPr: exec throws → {pr:null, reachable:false}");

  const found = makeExec([[/pr list.*dev-loop\/LOOP-30e/, { stdout: PR_LIST_OPEN }]]);
  const p4 = probeTicketPr(REPO, "LOOP-30e", { exec: found });
  ok(p4.pr?.pr === 7 && p4.reachable === true, "probeTicketPr: PR found → {pr:7, reachable:true}");
  ok(ticketToPr(REPO, "LOOP-30e", { exec: found })?.pr === 7, "ticketToPr: unchanged projection of probeTicketPr.pr");
}

// Case 31: pr view fails → "unknown"
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-31/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: "", stderr: "not found", ok: false }],
  ]);
  ok(annotateTicketLanding("LOOP-31", REPO, exec) === "unknown", "annotateTicketLanding: pr view failure → 'unknown'");
}

// Case 32: pending (empty) checks → "open-red" (conservative)
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-32/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: viewJson({ checks: [] }) }],
  ]);
  ok(annotateTicketLanding("LOOP-32", REPO, exec) === "open-red", "annotateTicketLanding: no checks → 'open-red' (conservative)");
}

// Case 33: argv validation — makeExec rejects unknown gh pr view --json field
{
  let caughtUnknown = false;
  const badExec = makeExec([[/.*/, {}]]);
  try { badExec(["pr", "view", "1", "--repo", "x/y", "--json", "bogusViewField"]); } catch (e) {
    caughtUnknown = /unknown gh pr view --json field/.test((e as Error).message);
  }
  ok(caughtUnknown, "makeExec double rejects unknown gh pr view --json field (parallel to LOOP-121 AC3)");
}

// Case 34: STARTUP_FAILURE check → "open-red" (P2 — startup-failed checks treated as red)
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-34/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: viewJson({ checks: [{ conclusion: "STARTUP_FAILURE" }] }) }],
  ]);
  ok(annotateTicketLanding("LOOP-34", REPO, exec) === "open-red", "annotateTicketLanding: STARTUP_FAILURE check → 'open-red'");
}

// Case 35: UNKNOWN mergeable → "unknown" (P2 — don't report open-green on transient UNKNOWN)
{
  const exec = makeExec([
    [/pr list.*dev-loop\/LOOP-35/, { stdout: PR_LIST_OPEN }],
    [/pr view 7/, { stdout: viewJson({ mergeable: "UNKNOWN", checks: [{ conclusion: "SUCCESS" }] }) }],
  ]);
  ok(annotateTicketLanding("LOOP-35", REPO, exec) === "unknown", "annotateTicketLanding: mergeable=UNKNOWN → 'unknown' (not open-green)");
}

// Case 36: dotted repository name — "service.api" must not be parsed as non-GitHub (P2 thread fix)
{
  const ws = makeWorkspace({
    repo: {
      path: "clone",
      remote: "https://github.com/test-org/service.api.git",
      landing: "pr",
      autoMerge: true,
      mergeChecks: ["CI"],
    },
  });
  const exec = makeExec([
    [/pr list.*--state open/, { stdout: "[]" }],
    [/api.*check-runs/, { stdout: checkRunsJson([{ name: "CI", conclusion: "success" }]) }],
    [/pr list.*--state merged/, { stdout: "[]" }],
  ]);
  const [result] = await readLandingState(ws, { exec, now: NOW });
  ok(result!.state !== "na", "dotted repo name 'service.api' is not rejected as non-GitHub remote");
  ok(result!.state === "healthy", "dotted repo name 'service.api' resolves to healthy state");
}

console.log(fails === 0 ? "\nLANDING_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
