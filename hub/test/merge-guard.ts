// LOOP-67 regression: merge-guard board-state axis must trip when the PR's ticket is In Review,
// Canceled, or Duplicate; pass on Todo/In Progress; and skip (no false trip) when no hub DB is present.
// Design: merge-review-guard §3.3 + §8-Child4.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { mergeGuard } from "../src/merge-guard.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-merge-guard-"));
try {
  // ── Fixture: hub.db with tickets in each board state ──────────────────────────
  const dbPath = join(ROOT, "hub.db");
  const conn = openDb(dbPath);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const tk = (id: string, state: string): void => {
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id, state);
  };
  tk("MG-1", "Todo");
  tk("MG-2", "In Progress");
  tk("MG-3", "In Review");
  tk("MG-4", "Canceled");
  tk("MG-5", "Duplicate");
  conn.close();

  // A fake repo dir so resolveHubDbPath has something to look at (we pass dbPath explicitly)
  const repoDir = join(ROOT, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, ".git"), "");  // stub — not a real git repo, but we pass dbPath explicitly

  // ── AC: Todo/In Progress → no trip ───────────────────────────────────────────
  const rTodo = mergeGuard(repoDir, { ticketId: "MG-1", dbPath });
  ok(!rTodo.trip, "Todo ticket → no trip");
  ok(rTodo.boardState.ticketState === "Todo", "Todo: state reported correctly");
  ok(!rTodo.boardState.skipped, "Todo: axis was evaluated (not skipped)");

  const rInProgress = mergeGuard(repoDir, { ticketId: "MG-2", dbPath });
  ok(!rInProgress.trip, "In Progress ticket → no trip");
  ok(rInProgress.boardState.ticketState === "In Progress", "In Progress: state reported correctly");

  // ── AC: In Review → trip ─────────────────────────────────────────────────────
  const rInReview = mergeGuard(repoDir, { ticketId: "MG-3", dbPath });
  ok(rInReview.trip, "In Review ticket → trip");
  ok(rInReview.boardState.trip === rInReview.trip, "boardState.trip consistent with result.trip");
  ok(rInReview.boardState.ticketState === "In Review", "In Review: state reported correctly");

  // ── AC: Canceled → trip ───────────────────────────────────────────────────────
  const rCanceled = mergeGuard(repoDir, { ticketId: "MG-4", dbPath });
  ok(rCanceled.trip, "Canceled ticket → trip");
  ok(rCanceled.boardState.ticketState === "Canceled", "Canceled: state reported correctly");

  // ── AC: Duplicate → trip ──────────────────────────────────────────────────────
  const rDuplicate = mergeGuard(repoDir, { ticketId: "MG-5", dbPath });
  ok(rDuplicate.trip, "Duplicate ticket → trip");
  ok(rDuplicate.boardState.ticketState === "Duplicate", "Duplicate: state reported correctly");

  // ── AC: no hub DB → axis skipped (no false trip) ─────────────────────────────
  const rNoDb = mergeGuard(repoDir, { ticketId: "MG-3", dbPath: join(ROOT, "nonexistent.db") });
  ok(!rNoDb.trip, "no hub DB → no trip (axis skipped, no false positive)");
  ok(rNoDb.boardState.skipped, "no hub DB → skipped=true");

  // ── AC: unknown ticket (not in hub) → no trip ────────────────────────────────
  const rUnknown = mergeGuard(repoDir, { ticketId: "MG-999", dbPath });
  ok(!rUnknown.trip, "unknown ticket → no trip (fail-open for unknown)");
  ok(!rUnknown.boardState.skipped, "unknown ticket: axis evaluated");
  ok(rUnknown.boardState.ticketState === null, "unknown ticket: state is null");

  // ── AC: no ticketId provided → no trip ───────────────────────────────────────
  const rNoTicket = mergeGuard(repoDir, { dbPath });
  ok(!rNoTicket.trip, "no ticketId, no inferrable branch → no trip");
  ok(!rNoTicket.boardState.trip, "no ticketId: boardState.trip=false");

  // ── CLI tests ─────────────────────────────────────────────────────────────────
  const cli = (args: string[], env?: Record<string, string>): { status: number; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, [join(hubRoot, "src", "merge-guard.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  // CLI advisory (no --strict): exit 0 even when tripped
  const cliInReview = cli(["--repo", repoDir, "--ticket", "MG-3"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliInReview.status === 0, "CLI advisory: In Review → exit 0 (no --strict)");
  ok(/TRIP|In Review/.test(cliInReview.stderr), `CLI: trip message on stderr for In Review (got: ${cliInReview.stderr.trim().slice(0, 100)})`);

  // CLI --strict: exit 1 on trip
  const cliStrict = cli(["--repo", repoDir, "--ticket", "MG-3", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliStrict.status === 1, "CLI --strict: In Review → exit 1");

  // CLI --strict: exit 0 on Todo
  const cliStrictClean = cli(["--repo", repoDir, "--ticket", "MG-1", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliStrictClean.status === 0, "CLI --strict: Todo → exit 0 (merge-eligible)");
  ok(/merge-eligible/.test(cliStrictClean.stdout), `CLI: merge-eligible message for Todo (got: ${cliStrictClean.stdout.trim()})`);

  // CLI: no hub DB → exits 0 (skipped, no false trip)
  const cliNoDb = cli(["--repo", repoDir, "--ticket", "MG-3", "--strict"], { DEVLOOP_HUB_DB: join(ROOT, "no.db") });
  ok(cliNoDb.status === 0, "CLI: no hub DB + --strict → exit 0 (skipped, never a false trip)");
  ok(/skipped/.test(cliNoDb.stdout), "CLI: no hub DB mentions 'skipped'");

  // CLI --json: valid JSON output
  const cliJson = cli(["--repo", repoDir, "--ticket", "MG-3", "--json"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliJson.status === 0, "CLI --json: exits 0 (advisory)");
  let parsed: { trip?: boolean; boardState?: { ticketState?: string } } = {};
  try { parsed = JSON.parse(cliJson.stdout); } catch { ok(false, "CLI --json: output is valid JSON"); }
  ok(parsed.trip === true, `CLI --json: trip=true for In Review (got: ${JSON.stringify(parsed)})`);
  ok(parsed.boardState?.ticketState === "In Review", "CLI --json: boardState.ticketState='In Review'");

  // CLI Canceled --strict
  const cliCanceled = cli(["--repo", repoDir, "--ticket", "MG-4", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliCanceled.status === 1, "CLI --strict: Canceled → exit 1");

  // CLI Duplicate --strict
  const cliDuplicate = cli(["--repo", repoDir, "--ticket", "MG-5", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliDuplicate.status === 1, "CLI --strict: Duplicate → exit 1");

  // CLI In Progress --strict → exit 0 (merge-eligible)
  const cliInProgress = cli(["--repo", repoDir, "--ticket", "MG-2", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliInProgress.status === 0, "CLI --strict: In Progress → exit 0");

  // ── Forge review axis (Child 1 / LOOP-64) — unit tests with injected exec ──
  // All tests use a fixed ghRepo and injected exec returning canned gh JSON.
  // No real gh calls are made; no network access.

  type ExecFn = (args: string[]) => { stdout: string; stderr: string; ok: boolean };

  const PR_URL = "https://github.com/owner/repo/pull/42";
  const GHREPO = "owner/repo";

  // Build a canned exec that returns different responses for pr view vs graphql
  const makePrExec = (prData: object, gqlData?: object | "fail"): ExecFn => {
    return (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        return { ok: true, stdout: JSON.stringify(prData), stderr: "" };
      }
      if (args[0] === "api" && args[1] === "graphql") {
        if (gqlData === "fail" || !gqlData) return { ok: false, stdout: "", stderr: "graphql failed" };
        return { ok: true, stdout: JSON.stringify(gqlData), stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected gh call" };
    };
  };

  const prChangesRequested = { number: 42, reviewDecision: "CHANGES_REQUESTED", url: PR_URL, latestReviews: [{ author: { login: "alice" }, state: "CHANGES_REQUESTED" }] };
  const prApproved = { number: 42, reviewDecision: "APPROVED", url: PR_URL, latestReviews: [{ author: { login: "alice" }, state: "APPROVED" }] };
  const prEmpty = { number: 42, reviewDecision: "", url: PR_URL, latestReviews: [] };

  const gqlUnresolvedThread = (login: string) => ({
    data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { isResolved: false, comments: { nodes: [{ author: { login } }] } },
    ] } } } },
  });
  const gqlNoThreads = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } };

  // AC1: non-agent CHANGES_REQUESTED → trip
  const rCR = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prChangesRequested, gqlNoThreads) });
  ok(rCR.forgeReview.trip, "forge: CHANGES_REQUESTED from non-agent → trip");
  ok(rCR.forgeReview.changeRequesters.includes("alice"), "forge: changeRequesters includes alice");
  ok(!rCR.forgeReview.skipped, "forge: CHANGES_REQUESTED — axis was evaluated");
  ok(rCR.trip, "forge: overall trip=true when forgeReview trips");

  // AC1: APPROVED → no trip
  const rApproved = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prApproved, gqlNoThreads) });
  ok(!rApproved.forgeReview.trip, "forge: APPROVED → no trip");
  ok(!rApproved.trip, "forge: APPROVED → overall trip=false");

  // AC1: empty reviewDecision, no threads → no trip
  const rEmpty = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prEmpty, gqlNoThreads) });
  ok(!rEmpty.forgeReview.trip, "forge: empty reviewDecision + no threads → no trip");
  ok(!rEmpty.forgeReview.skipped, "forge: empty reviewDecision — axis evaluated");

  // AC1: unresolved thread from non-agent → trip even when reviewDecision is ""
  const rThread = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prEmpty, gqlUnresolvedThread("bob")) });
  ok(rThread.forgeReview.trip, "forge: unresolved thread from non-agent → trip");
  ok(rThread.forgeReview.unresolvedThreadAuthors.includes("bob"), "forge: unresolvedThreadAuthors includes bob");

  // AC2: agent-login review → no trip (agent reviews are excluded)
  const rAgentCR = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: ["alice"], exec: makePrExec(prChangesRequested, gqlNoThreads) });
  ok(!rAgentCR.forgeReview.trip, "forge: CHANGES_REQUESTED by agent login → no trip (AC2)");
  ok(!rAgentCR.trip, "forge: agent review → overall trip=false");

  // AC2: agent thread author → no trip
  const rAgentThread = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: ["bob"], exec: makePrExec(prEmpty, gqlUnresolvedThread("bob")) });
  ok(!rAgentThread.forgeReview.trip, "forge: unresolved thread by agent login → no trip (AC2)");

  // AC5: gh exec throws (ENOENT — gh not on PATH) → skip, no trip
  const rEnoent = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } });
  ok(!rEnoent.forgeReview.trip, "forge: exec throws ENOENT → no trip (degrade, AC5)");
  ok(rEnoent.forgeReview.skipped, "forge: exec throws → skipped=true");

  // AC5: exec returns ok:false (unauth/offline) → skip, no trip
  const rUnauth = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: () => ({ ok: false, stdout: "", stderr: "gh: not logged in" }) });
  ok(!rUnauth.forgeReview.trip, "forge: gh returns ok:false → no trip (degrade, AC5)");
  ok(rUnauth.forgeReview.skipped, "forge: gh not-ok → skipped=true");

  // AC5: graphql failure degrades thread sub-signal but still honours reviewDecision
  const rGqlFail = mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prChangesRequested, "fail") });
  ok(rGqlFail.forgeReview.trip, "forge: graphql fails but CHANGES_REQUESTED still trips (§3.4 partial degrade)");
  ok(rGqlFail.forgeReview.unresolvedThreadAuthors.length === 0, "forge: graphql fail → empty unresolvedThreadAuthors");

  // AC5: no PR provided → forge axis skipped (not a false trip)
  const rNoPr = mergeGuard(repoDir, { ghRepo: GHREPO, agentReviewers: [] });
  ok(!rNoPr.forgeReview.trip, "forge: no --pr → no trip");
  ok(rNoPr.forgeReview.skipped, "forge: no --pr → skipped=true");

  // AC5: non-GitHub remote → forge axis skipped
  const rNonGh = mergeGuard(repoDir, { pr: 42, ghRepo: undefined, agentReviewers: [], exec: makePrExec(prChangesRequested) });
  // repoDir has no real git remote → resolveGhRepo returns null → skipped
  ok(rNonGh.forgeReview.skipped, "forge: no resolvable ghRepo → skipped (non-GitHub remote, AC5)");

  // Assert no path throws (all paths return, never throw)
  const noThrowPaths = [
    () => mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prChangesRequested) }),
    () => mergeGuard(repoDir, { pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: () => { throw new Error("forced"); } }),
    () => mergeGuard(repoDir, { pr: "branch-name", ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prApproved) }),
    () => mergeGuard(repoDir, {}),
  ];
  let noThrowOk = true;
  for (const fn of noThrowPaths) {
    try { fn(); } catch { noThrowOk = false; }
  }
  ok(noThrowOk, "forge: no path throws (all failures return, AC5)");

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "merge-guard: all checks passed");
process.exit(fails ? 1 : 0);
