// LOOP-67 regression: merge-guard board-state axis must trip when the PR's ticket is In Review,
// Canceled, or Duplicate; pass on Todo/In Progress; and skip (no false trip) when no hub DB is present.
// Design: merge-review-guard §3.3 + §8-Child4.
// LOOP-65 regression: merge-guard --apply path writes objection comment + routes ticket on trip;
// read path (no --apply) writes nothing; no-DB degrades silently; idempotent on re-run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb, isToolWriteEventData } from "../src/db.ts";
// LOOP-300 regression: a --strict run that evaluated NEITHER axis must not report a clean pass,
// while a genuine outage still degrades to one (§3.4). skipClass/unevaluatedHold are the classifier
// the distinction rests on; registryGhRepos is the cwd-independent repo resolution (AC3).
import { mergeGuard, skipClass, unevaluatedHold, registryGhRepos, buildCommentBody } from "../src/merge-guard.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
      env: { ...scrubFireEnv(), ...env },
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
      { cwd: wsDir, encoding: "utf8", env: { ...scrubFireEnv() } });
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
      "--key", "mg-team", "--backend", "service"], { encoding: "utf8", env: { ...scrubFireEnv(), ...noWs, DEVLOOP_HUB_DB: "" } });
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
  // ══ LOOP-242: CI-freshness axis (design merge-guard-ci-freshness §4 / Child A) ════════════
  {
    // All tests use the injected exec seam — no real gh calls.
    const GHREPO = "owner/repo";
    const repoDir = join(ROOT, "gh-repo");
    const MERGE_CHECKS = ["Test Check"];
    const DEFAULT_BRANCH = "main";
    // Helper: create an exec that returns canned responses for pr view and compare API
    const makeFreshExec = (behindBy: number, checkPass: boolean): ExecFn => {
      let callCount = 0;
      return (args: string[]) => {
        callCount++;
        if (args[0] === "pr" && args[1] === "view") {
          return {
            ok: true,
            stdout: JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [{ name: "Test Check", conclusion: checkPass ? "SUCCESS" : "FAILURE" }] }),
            stderr: "",
          };
        }
        if (args[0] === "api" && args[1].startsWith("/repos/")) {
          return {
            ok: true,
            stdout: JSON.stringify({ behind_by: behindBy, base_commit: { sha: "tip789" } }),
            stderr: "",
          };
        }
        return { ok: false, stdout: "", stderr: "unexpected gh call" };
      };
    };

    // AC2/AC4(i): two-PR scenario — B is stale after A merges
    // behindBy > 0 after merge, despite green checks → stale → trip
    const rStaleTwoPr = mergeGuard(repoDir, {
      pr: 101, ghRepo: GHREPO, mergeChecks: MERGE_CHECKS, defaultBranch: DEFAULT_BRANCH,
      exec: makeFreshExec(2, true), // behind_by = 2 → stale
    });
    ok(rStaleTwoPr.ciFreshness.trip, "LOOP-242 AC2: B stale after A merges → trip");
    ok(rStaleTwoPr.ciFreshness.verdict === "stale", `LOOP-242 AC2: verdict is stale (got: ${rStaleTwoPr.ciFreshness.verdict})`);
    ok(rStaleTwoPr.ciFreshness.behindBy === 2, "LOOP-242 AC2: behindBy reported correctly");
    ok(rStaleTwoPr.trip, "LOOP-242 AC2: overall trip=true");

    // AC2/AC4(ii): single PR whose base moved (behind_by > 0) → stale → trip
    const rStaleSingle = mergeGuard(repoDir, {
      pr: 102, ghRepo: GHREPO, mergeChecks: MERGE_CHECKS, defaultBranch: DEFAULT_BRANCH,
      exec: makeFreshExec(1, true), // behind_by = 1 → stale
    });
    ok(rStaleSingle.ciFreshness.trip, "LOOP-242 AC2: single PR behind base → stale → trip");
    ok(rStaleSingle.ciFreshness.verdict === "stale", `LOOP-242 AC2: single stale verdict (got: ${rStaleSingle.ciFreshness.verdict})`);

    // AC3: --json output must show ciFreshness.verdict === "stale"
    ok(rStaleTwoPr.ciFreshness.verdict === "stale", "LOOP-242 AC3: JSON ciFreshness.verdict is 'stale'");

    // AC5: fresh-green PR (behind_by === 0) → no trip
    const rFresh = mergeGuard(repoDir, {
      pr: 103, ghRepo: GHREPO, mergeChecks: MERGE_CHECKS, defaultBranch: DEFAULT_BRANCH,
      exec: makeFreshExec(0, true), // behind_by = 0 → fresh-green
    });
    ok(!rFresh.ciFreshness.trip, "LOOP-242 AC5: fresh-green PR → no trip");
    ok(rFresh.ciFreshness.verdict === "fresh-green", `LOOP-242 AC5: verdict is fresh-green (got: ${rFresh.ciFreshness.verdict})`);
    ok(!rFresh.trip, "LOOP-242 AC5: overall trip=false");

    // AC5: red check → trip (verdict=red)
    const rRed = mergeGuard(repoDir, {
      pr: 104, ghRepo: GHREPO, mergeChecks: MERGE_CHECKS, defaultBranch: DEFAULT_BRANCH,
      exec: makeFreshExec(0, false), // check fails → red
    });
    ok(rRed.ciFreshness.trip, "LOOP-242: red check → trip");
    ok(rRed.ciFreshness.verdict === "red", `LOOP-242: verdict is red (got: ${rRed.ciFreshness.verdict})`);

    // Degrade: gh unavailable → ciFreshness eval'd, verdict=unknown (no false trip)
    const rDegrade = mergeGuard(repoDir, {
      pr: 105, ghRepo: GHREPO, mergeChecks: MERGE_CHECKS, defaultBranch: DEFAULT_BRANCH,
      exec: () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); },
    });
    ok(!rDegrade.ciFreshness.trip, "LOOP-242: gh unavailable → degrade, no trip");
    ok(!rDegrade.ciFreshness.skipped, "LOOP-242: gh unavailable → axis evaluated (degraded to unknown)");
    ok(rDegrade.ciFreshness.verdict === "unknown", `LOOP-242: degraded verdict is 'unknown' (got: ${rDegrade.ciFreshness.verdict})`);

    // No mergeChecks → ciFreshness skipped (no trip)
    const rNoChecks = mergeGuard(repoDir, {
      pr: 106, ghRepo: GHREPO, dbPath: join(ROOT, "hub.db"),
    });
    ok(!rNoChecks.ciFreshness.trip, "LOOP-242: no mergeChecks → skip, no trip");
    ok(rNoChecks.ciFreshness.skipped, "LOOP-242: no mergeChecks → ciFreshness skipped");

    // No --pr → ciFreshness skipped (no trip)
    const rNoPr = mergeGuard(repoDir, { ghRepo: GHREPO, mergeChecks: MERGE_CHECKS });
    ok(!rNoPr.ciFreshness.trip, "LOOP-242: no --pr → skip, no trip");
    ok(rNoPr.ciFreshness.skipped, "LOOP-242: no --pr → ciFreshness skipped");
  }

  // ══ LOOP-323: the axis runs from the CLI, and a red required check HOLDS the merge ═══════════
  {
    // AC2 — the three distinct skipReasons, asserted at the function seam.
    const GHREPO = "owner/r323";
    const repoDir = join(ROOT, "gh-repo");
    const rNoPr323 = mergeGuard(repoDir, { ghRepo: GHREPO, mergeChecks: ["c"], repoEligible: true });
    ok(rNoPr323.ciFreshness.skipReason === "no-pr-arg", "LOOP-323 AC2: no --pr → skipReason no-pr-arg");
    const rNotAm = mergeGuard(repoDir, { pr: 9, ghRepo: GHREPO, mergeChecks: ["c"], repoEligible: false });
    ok(rNotAm.ciFreshness.skipReason === "repo-not-automerge", `LOOP-323 AC2: repoEligible:false → skipReason repo-not-automerge (got: ${rNotAm.ciFreshness.skipReason})`);
    ok(!rNotAm.ciFreshness.trip, "LOOP-323 AC2: repo-not-automerge never trips");
    const rNoChecks323 = mergeGuard(repoDir, { pr: 9, ghRepo: GHREPO, mergeChecks: [], repoEligible: true });
    ok(rNoChecks323.ciFreshness.skipReason === "no-merge-checks", "LOOP-323 AC2: empty mergeChecks → skipReason no-merge-checks");

    // AC5 (Amendment 2) — the reason names the delta's file composition from the REVERSED compare.
    // The forward compare's files[] is deliberately DIFFERENT from the reversed one so the assertion
    // discriminates direction: reporting pr-own-diff.ts would be the LOOP-149 trap.
    const composeExec: ExecFn = (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") {
        return { ok: true, stdout: JSON.stringify({ headRefOid: "aaa111", statusCheckRollup: [{ name: "c", conclusion: "SUCCESS" }] }), stderr: "" };
      }
      if (args[0] === "api" && String(args[1]).includes("/compare/main...aaa111")) {
        return { ok: true, stdout: JSON.stringify({ behind_by: 3, base_commit: { sha: "tip42" }, files: [{ filename: "pr-own-diff.ts" }] }), stderr: "" };
      }
      if (args[0] === "api" && String(args[1]).includes("/compare/aaa111...main")) {
        return { ok: true, stdout: JSON.stringify({ ahead_by: 3, files: [{ filename: "tip-delta-1.ts" }, { filename: "tip-delta-2.md" }] }), stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected gh call" };
    };
    const rCompose = mergeGuard(repoDir, { pr: 11, ghRepo: GHREPO, mergeChecks: ["c"], defaultBranch: "main", repoEligible: true, exec: composeExec });
    ok(rCompose.ciFreshness.verdict === "stale", `LOOP-323 AC5: stale verdict (got: ${rCompose.ciFreshness.verdict})`);
    ok(/tip-delta-1\.ts/.test(rCompose.ciFreshness.reason ?? ""), `LOOP-323 AC5: reason names the tip delta's files (got: ${rCompose.ciFreshness.reason})`);
    ok(!/pr-own-diff\.ts/.test(rCompose.ciFreshness.reason ?? ""), "LOOP-323 AC5: reason does NOT report the PR's own diff (the LOOP-149 trap)");
    ok(/delta touches 2 file/.test(rCompose.ciFreshness.reason ?? ""), "LOOP-323 AC5: reason carries the file count");

    // AC6 — stale trips under the named constant (LOOP-277's remedy is live, so the trip ships ON);
    // red always trips regardless of the constant.
    ok(rCompose.ciFreshness.trip && rCompose.trip, "LOOP-323 AC6: stale trips (CI_FRESHNESS_STALE_TRIPS is on; LOOP-277 remedy live)");

    // AC4 (Amendment 1) — the stale objection comment names the remedy in the ratified wording.
    const staleBody = buildCommentBody(11, rCompose.forgeReview, rCompose.boardState, rCompose.ciFreshness);
    ok(/Step 0\.5/.test(staleBody) && /--force-with-lease/.test(staleBody), "LOOP-323 AC4: stale objection names Step 0.5 (authoritative) + the manual rebase fallback");
    ok(/already actioned/.test(staleBody), "LOOP-323 AC4: stale objection names the already-actioned discriminator");

    // AC1 + AC3 — the CLI resolves mergeChecks/defaultBranch from the workspace repo registry, and a
    // red required check (PR #182's real shape) HOLDS the merge end to end: exit 1 under --strict.
    // Driven through the CLI with a PATH-shimmed `gh`, NOT mergeGuard() — the exact seam LOOP-242
    // missed. This test FAILS against the unwired tree (skipped:"no-merge-checks", exit 0).
    const ws323 = join(ROOT, "ws323");
    const repo323 = join(ws323, "repo323");
    mkdirSync(repo323, { recursive: true });
    writeFileSync(join(ws323, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "w323", backend: "service" },
      repos: { r323: { path: "repo323", landing: "pr", autoMerge: true, remote: "https://github.com/o/r323", mergeChecks: ["Test (Node 23.6.0)", "Test (Node 24)"] } },
      projects: {},
    }));
    const shimDir = join(ROOT, "gh-shim");
    mkdirSync(shimDir, { recursive: true });
    // The shim answers exactly the calls the guard makes; PR #182's real check shape (both FAILURE).
    writeFileSync(join(shimDir, "gh"), `#!/bin/sh
case "$*" in
  *"--json headRefName"*) echo '{"headRefName":"dev-loop/LOOP-999"}';;
  *"--json headRefOid,statusCheckRollup"*) echo '{"headRefOid":"deadbeef","statusCheckRollup":[{"name":"Test (Node 23.6.0)","conclusion":"FAILURE"},{"name":"Test (Node 24)","conclusion":"FAILURE"}]}';;
  *"--json state"*) echo '{"state":"OPEN"}';;
  *"--json number,reviewDecision"*) echo '{"number":182,"reviewDecision":"","latestReviews":[]}';;
  *"api graphql"*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}';;
  *) echo '{}' ;;
esac
exit 0
`);
    chmodSync(join(shimDir, "gh"), 0o755);
    const cliRed = spawnSync("node", [join(hubRoot, "src", "merge-guard.ts"), "--repo", repo323, "--pr", "182", "--strict", "--json"], {
      encoding: "utf8",
      env: { ...scrubFireEnv(), PATH: `${shimDir}:${process.env.PATH}`, DEVLOOP_HUB_DB: join(ROOT, "absent-hub.db") },
    });
    let cliRedJson: { ciFreshness?: { skipped?: boolean; verdict?: string | null; skipReason?: string | null } } = {};
    try { cliRedJson = JSON.parse(cliRed.stdout || "{}"); } catch { /* leave empty — assertions below fail with detail */ }
    ok(cliRedJson.ciFreshness?.skipped === false, `LOOP-323 AC1: CLI resolves mergeChecks from the registry — axis evaluated (skipped:${cliRedJson.ciFreshness?.skipped}, skipReason:${cliRedJson.ciFreshness?.skipReason})`);
    ok(cliRedJson.ciFreshness?.verdict === "red", `LOOP-323 AC3: CLI sees PR #182's FAILURE checks as verdict red (got: ${cliRedJson.ciFreshness?.verdict})`);
    ok(cliRed.status === 1, `LOOP-323 AC3: red required checks HOLD the merge — exit 1 under --strict (got: ${cliRed.status})`);

    // AC2 (CLI face) — a registered repo with landing:"direct" gets repo-not-automerge from the CLI.
    const wsDirect = join(ROOT, "ws323d");
    const repoDirect = join(wsDirect, "repod");
    mkdirSync(repoDirect, { recursive: true });
    writeFileSync(join(wsDirect, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "w323d", backend: "service" },
      repos: { rd: { path: "repod", landing: "direct", remote: "https://github.com/o/rd", mergeChecks: ["Test (Node 23.6.0)"] } },
      projects: {},
    }));
    const cliDirect = spawnSync("node", [join(hubRoot, "src", "merge-guard.ts"), "--repo", repoDirect, "--pr", "7", "--json"], {
      encoding: "utf8",
      env: { ...scrubFireEnv(), PATH: `${shimDir}:${process.env.PATH}`, DEVLOOP_HUB_DB: join(ROOT, "absent-hub.db") },
    });
    let cliDirectJson: { ciFreshness?: { skipReason?: string | null } } = {};
    try { cliDirectJson = JSON.parse(cliDirect.stdout || "{}"); } catch { /* assertions carry detail */ }
    ok(cliDirectJson.ciFreshness?.skipReason === "repo-not-automerge", `LOOP-323 AC2: CLI on a landing:"direct" repo → repo-not-automerge (got: ${cliDirectJson.ciFreshness?.skipReason})`);
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

// ── LOOP-241: the objection carries its own remedy ─────────────────────────────────────────────
// The comment said THAT the merge was held and not WHAT to do, and the omitted step is the one devs
// actually get wrong. Measured across three simultaneously-stranded PRs: two devs had pushed a
// correct fix WITH tests and left every thread open, and one handoff comment stated the
// misconception verbatim — "CI re-triggered; merge-guard will clear on green." It will not.
{
  const src = readFileSync(join(hubRoot, "src", "merge-guard.ts"), "utf8");
  ok(/Pushing a fix does NOT resolve a review thread/.test(src),
    "LOOP-241: the forge-review objection states that pushing a fix does not resolve a thread");
  ok(/CI going green does not either/.test(src),
    "LOOP-241: …and that green is orthogonal — the exact misconception a stranded dev wrote down");
  ok(/Resolve conversation/.test(src),
    "LOOP-241: …and names the concrete action, not just the fact of the hold");
  // The remedy rides BOTH forge-review branches (CHANGES_REQUESTED and unresolved-threads), because
  // a dev hitting either one has the same next step.
  const remedyUses = (src.match(/\$\{REVIEW_REMEDY\}/g) ?? []).length;
  ok(remedyUses === 2, `LOOP-241: both forge-review objections carry it (got ${remedyUses})`);
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "merge-guard: all checks passed");
process.exit(fails ? 1 : 0);
