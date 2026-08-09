// LOOP-444 regression: the guard's verdict is the PRECONDITION of the squash, in one call.
//
// The gap this pins: `merge-guard --strict --apply` and `gh pr merge --squash` were two commands an
// agent ran in sequence, and nothing machine-side refused the second when the first was skipped.
// Measured 2026-08-06 — `62178e6` merged with NO required check in its rollup (direct `gh pr merge`
// from a fire, `autoMergeRequest: None`), 9 minutes after correct hold comments had been posted on
// sibling PRs; `c3454b7` landed the same way and broke `main`'s typecheck (LOOP-423).
//
// So every arm below asserts on the RECORDED ARGV of the injected exec — the seam
// hub/test/merge-guard.ts already uses. "No merge was issued" is a checkable fact here, not an
// inference from a return value: the fake refuses any argv it was not written to answer, so an arm
// cannot pass because the double was accommodating.
//
// This file does NOT re-assert merge-guard's own verdicts (LOOP-407 and LOOP-242 own those); it pins
// the verb's contract: what it issues, what it refuses to issue, and how a refusal reads.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { acquireLock } from "../src/locks.ts";
import { EXIT_UNEVALUATED, skipClass } from "../src/merge-guard.ts";
import { prMerge, prMergeExit, mergeArgvFor, resolvePrMergeTarget, prMergeLockPath, PR_MERGE_EXIT, type PrMergeResult } from "../src/pr-merge.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-pr-merge-"));
try {
  const GHREPO = "owner/repo444";
  const PR = 101;
  const dbPath = join(ROOT, "hub.db");
  const conn = openDb(dbPath);
  conn.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const tk = (id: string, state: string, assignee: string | null = "senior-dev"): void => {
    conn.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,0,'[\"dev-loop\"]','[]','pm','t','t')")
      .run(id, "p", "t-" + id, state, assignee);
  };
  tk("PM-1", "In Progress");   // merge-eligible
  tk("PM-2", "In Review");     // board axis trips
  tk("PM-3", "In Progress");   // co-occurring holds
  tk("PM-4", "In Progress");   // red checks
  tk("PM-5", "In Progress");   // stale
  tk("PM-6", "In Progress");   // merge itself fails
  tk("PM-7", "In Progress");   // already merged
  conn.close();

  const repoDir = join(ROOT, "repo");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, ".git"), ""); // stub: dbPath and ghRepo are passed explicitly

  const CHECKS = ["Test (Node 23.6.0)", "Test (Node 24)"];
  const greenRollup = CHECKS.map((name) => ({ name, conclusion: "SUCCESS" }));

  type Call = string[];
  type Scenario = {
    ticket: string;
    state?: string;                                          // PR state (default OPEN)
    isDraft?: boolean;
    mergeable?: string;                                      // MERGEABLE | CONFLICTING | UNKNOWN
    rollup?: Array<{ name: string; conclusion: string | null }>;
    behindBy?: number;
    changesRequestedBy?: string;
    mergeOk?: boolean;
    mergeStderr?: string;
    // The head SHA each read reports. Two knobs, not one, because the whole point of the
    // --match-head-commit pin is the window in which they DIFFER: the checks ran on one revision and
    // the merge would land another.
    prHeadSha?: string;       // what `pr view` (readiness) reports
    ciHeadSha?: string;       // what the check-rollup read reports — the SHA the checks ran on
    compareOk?: boolean;      // false ⇒ the compare call fails ⇒ readCiFreshness degrades to `unknown`
    files?: string[];         // the compare delta's filenames — an EMPTY list is fail-closed, never exempt
  };

  // A STRICT double: it answers exactly the seven gh calls this flow makes and refuses anything
  // else. A double that answered any argv could not tell a merge from a non-merge, which is the one
  // thing every arm here depends on (LOOP-352's lesson, applied to the mock instead of the test).
  const mkExec = (s: Scenario): { exec: (a: Call) => { stdout: string; stderr: string; ok: boolean }; calls: Call[]; refused: Call[] } => {
    const calls: Call[] = [];
    const refused: Call[] = [];
    const json = (o: unknown) => ({ ok: true, stdout: JSON.stringify(o), stderr: "" });
    const exec = (args: Call) => {
      calls.push(args);
      const fields = args[0] === "pr" && args[1] === "view" ? args[args.indexOf("--json") + 1] : null;
      if (args[0] === "pr" && args[1] === "merge") {
        return s.mergeOk === false
          ? { ok: false, stdout: "", stderr: s.mergeStderr ?? "gh: merge failed" }
          : { ok: true, stdout: "", stderr: "" };
      }
      if (fields === "state,isDraft,mergeable,headRefOid") {
        return json({
          state: s.state ?? "OPEN", isDraft: s.isDraft ?? false, mergeable: s.mergeable ?? "MERGEABLE",
          headRefOid: s.prHeadSha ?? "head000",
        });
      }
      // The guard's --apply path re-reads `state` on its own (LOOP-216: never post an objection on a
      // PR that already landed). Two calls, one field — left as-is rather than threading a cached
      // state into the shared module, which AC5 says not to disturb. Answered here because the
      // double refuses what it was not written for, which is how this coupling became visible.
      if (fields === "state") return json({ state: s.state ?? "OPEN" });
      if (fields === "headRefName,commits,title,body") {
        return json({ headRefName: `dev-loop/${s.ticket}`, commits: [], title: `x (${s.ticket})`, body: "" });
      }
      if (fields === "number,reviewDecision,url,latestReviews") {
        return json({
          number: PR,
          reviewDecision: s.changesRequestedBy ? "CHANGES_REQUESTED" : "APPROVED",
          url: `https://github.com/${GHREPO}/pull/${PR}`,
          latestReviews: s.changesRequestedBy ? [{ author: { login: s.changesRequestedBy }, state: "CHANGES_REQUESTED" }] : [],
        });
      }
      if (fields === "headRefOid,statusCheckRollup") {
        return json({ headRefOid: s.ciHeadSha ?? "head000", statusCheckRollup: s.rollup ?? greenRollup });
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      }
      if (args[0] === "api" && args[1]?.startsWith(`/repos/${GHREPO}/compare/`)) {
        // A failing compare is the real degrade path readCiFreshness has: the rollup read fine, so
        // the axis is EVALUATED, but freshness against the tip could not be computed ⇒ `unknown`.
        if (s.compareOk === false) return { ok: false, stdout: "", stderr: "gh: 502 Bad Gateway" };
        return json({
          behind_by: s.behindBy ?? 0, base_commit: { sha: "tip999" },
          files: (s.files ?? []).map((filename) => ({ filename })),
          total_commits: 1, commits: [{}],
        });
      }
      refused.push(args);
      return { ok: false, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    };
    return { exec, calls, refused };
  };

  const run = async (s: Scenario, opts: { apply?: boolean } = {}): Promise<{ r: PrMergeResult; calls: Call[]; refused: Call[]; exit: number }> => {
    const { exec, calls, refused } = mkExec(s);
    const r = await prMerge(repoDir, {
      pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [],
      mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true,
      // Hermetic: an explicit lock path keeps these arms out of whatever workspace the runner
      // happens to sit in. LOOP-418 is the reason it is passed rather than resolved — a per-file
      // test run inside a fire resolves the LIVE workspace, so a default-resolved lock would put
      // this suite's lock files in the operator's workspace.
      lockPath: join(ROOT, "locks", "arm.lock"),
      ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
    });
    return { r, calls, refused, exit: prMergeExit(r) };
  };
  const mergeCalls = (calls: Call[]): Call[] => calls.filter((c) => c[0] === "pr" && c[1] === "merge");

  // ── AC2: all axes clean → it squashes, with the argv pinned ────────────────────────────────────
  {
    const { r, calls, refused, exit } = await run({ ticket: "PM-1" }, { apply: false });
    ok(r.merged, "AC2: every evaluated axis clean → merged");
    ok(exit === PR_MERGE_EXIT.merged && exit === 0, `AC2: exit 0 (got ${exit})`);
    const m = mergeCalls(calls);
    ok(m.length === 1, `AC2: exactly ONE merge subprocess issued (got ${m.length})`);
    // The pinned argv. `--repo` is explicit because this verb inherits merge-guard's
    // cwd-independence (LOOP-300 AC3) and a bare `gh pr merge` only works inside the repo — it
    // would gate correctly from the workspace root and then fail to land.
    const want = ["pr", "merge", "101", "--repo", GHREPO, "--squash", "--delete-branch", "--match-head-commit", "head000"];
    ok(JSON.stringify(m[0]) === JSON.stringify(want),
      `AC2: the argv is the Step 0.5 squash, pinned to the judged head — ${JSON.stringify(want)} (got ${JSON.stringify(m[0])})`);
    ok(JSON.stringify(r.mergeArgv) === JSON.stringify(want), "AC2: the result reports the argv it issued");
    ok(JSON.stringify(mergeArgvFor(PR, GHREPO, "head000")) === JSON.stringify(want), "AC2: mergeArgvFor is that same one definition, not a second spelling");
    ok(refused.length === 0, `AC2: the double was asked nothing it was not written for — it refuses unknown argv, so an arm cannot pass on an accommodating mock (refused: ${refused.map((c) => c.join(" ")).join("; ") || "none"})`);
  }

  // ── AC1 + AC4: each axis holds, names itself, and issues NO merge ──────────────────────────────
  // One arm per axis. `axisHold` is the shared shape check: non-zero exit, no merge subprocess, and
  // a hold whose token identifies the cause — never one undifferentiated "refused".
  const axisHold = async (label: string, s: Scenario, token: string, detailProbe: RegExp): Promise<PrMergeResult> => {
    const { r, calls, exit } = await run(s, { apply: false });
    ok(!r.merged, `AC1 ${label}: NOT merged`);
    ok(exit === PR_MERGE_EXIT.held, `AC1 ${label}: exit 1 (held) — non-zero, so §12c's "non-zero HOLDS that merge" already does the right thing (got ${exit})`);
    ok(mergeCalls(calls).length === 0, `AC1 ${label}: NO \`gh pr merge\` subprocess was issued`);
    ok(r.mergeArgv === null, `AC1 ${label}: …and the result reports no argv`);
    ok(r.holds.length === 1, `AC4 ${label}: exactly one axis objected (got ${r.holds.map((h) => h.token).join("+") || "none"})`);
    ok(r.holds[0]?.token === token, `AC4 ${label}: token is '${token}' (got '${r.holds[0]?.token}')`);
    ok(detailProbe.test(r.holds[0]?.detail ?? ""), `AC4 ${label}: the line names the cause (got: ${r.holds[0]?.detail})`);
    return r;
  };

  await axisHold("boardState", { ticket: "PM-2" }, "board-not-merge-eligible", /PM-2 is In Review/);
  await axisHold("forgeReview", { ticket: "PM-1", changesRequestedBy: "bob" }, "unresolved-review", /@bob/);
  await axisHold("ciFreshness/check-never-reported",
    { ticket: "PM-1", rollup: [{ name: "GitGuardian Security Checks", conclusion: "SUCCESS" }] },
    "check-never-reported", /never reported: Test \(Node 23\.6\.0\), Test \(Node 24\)/);
  await axisHold("ciFreshness/red",
    { ticket: "PM-4", rollup: [{ name: CHECKS[0]!, conclusion: "FAILURE" }, { name: CHECKS[1]!, conclusion: "SUCCESS" }] },
    "red", /verdict=red/);
  await axisHold("ciFreshness/stale", { ticket: "PM-5", behindBy: 3 }, "stale", /3 commit\(s\) behind/);

  // AC4, the part a single exit code cannot express: two axes holding the SAME PR stay two lines
  // with two tokens. `check-never-reported` (re-dispatch the workflow) and a board-state hold (fix
  // the ticket) are different next actions, and collapsing co-occurring causes into one sentence is
  // the mistake LOOP-433 records on the doctor side.
  {
    const { r, calls, exit } = await run({ ticket: "PM-2", rollup: [] }, { apply: false });
    ok(exit === PR_MERGE_EXIT.held, "AC4 co-occurring: still exit 1");
    ok(mergeCalls(calls).length === 0, "AC4 co-occurring: no merge issued");
    ok(r.holds.length === 2, `AC4 co-occurring: BOTH axes are reported (got ${r.holds.length})`);
    const tokens = r.holds.map((h) => h.token).sort();
    ok(JSON.stringify(tokens) === JSON.stringify(["board-not-merge-eligible", "check-never-reported"]),
      `AC4 co-occurring: each cause keeps its own token (got ${JSON.stringify(tokens)})`);
    ok(new Set(r.holds.map((h) => h.axis)).size === 2, "AC4 co-occurring: …and its own axis");
  }

  // ── The readiness filter: what Step 0.5 checked BEFORE it ran the guard ────────────────────────
  // Folding guard+squash into one call while dropping the agent's own "green AND mergeable" filter
  // would make the verb WORSE than the two-step it replaces: pending checks do not trip the guard
  // (LOOP-407 — tripping would objection-spam every slow PR), so nothing else would stand between a
  // still-running CI and a squash. These arms are that filter.
  {
    const pend = await run({ ticket: "PM-1", rollup: CHECKS.map((name) => ({ name, conclusion: null })) }, { apply: false });
    ok(pend.r.guard?.ciFreshness.trip === false, "readiness: pending checks still do NOT trip the guard (LOOP-407 unchanged)");
    ok(pend.exit === PR_MERGE_EXIT.held, `readiness: …but the VERB holds — a pending PR is not merged (got exit ${pend.exit})`);
    ok(mergeCalls(pend.calls).length === 0, "readiness: no merge subprocess while CI is still running");
    ok(pend.r.holds.length === 1 && pend.r.holds[0]?.token === "pending",
      `readiness: token 'pending' — "leave it for the next fire", not an objection (got ${pend.r.holds.map((h) => h.token).join("+")})`);

    const dirty = await run({ ticket: "PM-1", mergeable: "CONFLICTING" }, { apply: false });
    ok(dirty.exit === PR_MERGE_EXIT.held && mergeCalls(dirty.calls).length === 0, "readiness: a CONFLICTING PR is held, not merged");
    ok(dirty.r.holds.some((h) => h.axis === "readiness" && h.token === "not-mergeable"),
      `readiness: token 'not-mergeable' (got ${dirty.r.holds.map((h) => h.token).join("+")})`);

    const unknown = await run({ ticket: "PM-1", mergeable: "UNKNOWN" }, { apply: false });
    ok(unknown.r.holds.some((h) => h.token === "mergeability-unknown") && mergeCalls(unknown.calls).length === 0,
      "readiness: mergeability UNKNOWN fails closed — §12c merges only what IS mergeable");

    const draft = await run({ ticket: "PM-1", isDraft: true }, { apply: false });
    ok(draft.r.holds.some((h) => h.token === "pr-draft") && mergeCalls(draft.calls).length === 0,
      "readiness: a DRAFT PR is held");

    const closed = await run({ ticket: "PM-1", state: "CLOSED" }, { apply: false });
    ok(closed.r.holds.some((h) => h.token === "pr-not-open") && mergeCalls(closed.calls).length === 0,
      "readiness: a CLOSED PR is held — there is nothing to land");

    // Readiness and a guard axis can hold the same PR, and both are reported: the guard still runs,
    // so the board objection reaches the ticket on the FIRST run rather than after the rebase.
    const both = await run({ ticket: "PM-2", mergeable: "CONFLICTING" }, { apply: false });
    ok(both.r.holds.length === 2 && new Set(both.r.holds.map((h) => h.axis)).size === 2,
      `readiness: a conflicting PR on a non-eligible ticket reports BOTH causes (got ${both.r.holds.map((h) => `${h.axis}:${h.token}`).join("+")})`);
  }

  // ── The hold is recorded on the board (the --apply half of what Step 0.5 did) ──────────────────
  {
    const readComments = (id: string): string[] => {
      const db = openDb(dbPath);
      try { return (db.prepare("SELECT body FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as { body: string }[]).map((r) => r.body); }
      finally { db.close(); }
    };
    ok(readComments("PM-2").length === 0, "apply: the arms above ran with apply:false and wrote nothing (setup check)");
    const { r, calls } = await run({ ticket: "PM-2" });            // apply defaults ON — this verb replaces `--strict --apply`
    ok(r.guard?.applied?.action === "wrote", `apply: a hold posts the guard's objection (got ${r.guard?.applied?.action})`);
    const posted = readComments("PM-2");
    ok(posted.length === 1 && posted[0]!.includes("⛔ merge-guard:"), `apply: exactly one objection comment on the ticket (got ${posted.length})`);
    ok(mergeCalls(calls).length === 0, "apply: …and still no merge");
    const again = await run({ ticket: "PM-2" });
    ok(again.r.guard?.applied?.action === "already_present", `apply: idempotent on re-run (got ${again.r.guard?.applied?.action})`);
    ok(readComments("PM-2").length === 1, "apply: …no duplicate comment");

    // Review round 3, finding 2: report a board write only when one HAPPENED.
    //
    // `applyTrip` runs when the GUARD trips. A readiness hold (draft / conflict / unknown
    // mergeability) and a non-tripping CI state (pending, unknown, an untargeted skip) hold the
    // squash with no axis objecting — so no comment is written and no ticket is routed. The CLI
    // nonetheless printed "The objection is recorded on the ticket" whenever --apply was requested,
    // which invites an operator to look for an audit trail and a routing action that do not exist.
    // The message is now keyed on the recorded action; this pins the fact it keys on.
    //
    // PM-3 is In Progress, so the board axis does NOT trip: the DRAFT is the only thing holding.
    const draft = await run({ ticket: "PM-3", isDraft: true });     // apply ON
    ok(draft.r.holds.length > 0 && draft.r.holds.every((h) => h.axis === "readiness"),
      `apply: a draft PR holds on readiness alone (got ${JSON.stringify(draft.r.holds.map((h) => h.axis))})`);
    ok(draft.r.guard?.applied === undefined,
      `apply: …and NOTHING was recorded on the board, so the CLI must not claim it was (got ${JSON.stringify(draft.r.guard?.applied)})`);
    ok(readComments("PM-3").length === 0,
      `apply: …confirmed against the ticket itself — zero comments (got ${readComments("PM-3").length})`);
  }

  // ── Idempotent re-run: an already-merged PR is a no-op, not a hold ─────────────────────────────
  // Post-merge the ticket is normally In Review, so gating first would report a board hold on work
  // that already landed (the LOOP-216 shape). The merged check therefore runs BEFORE the guard, and
  // that ordering is what this arm pins.
  {
    const { r, calls, exit } = await run({ ticket: "PM-7", state: "MERGED" });
    ok(r.alreadyMerged && !r.merged, "idempotent: an already-MERGED PR reports alreadyMerged");
    ok(exit === PR_MERGE_EXIT.merged, `idempotent: exit 0 — a landed PR is not a failure (got ${exit})`);
    ok(mergeCalls(calls).length === 0, "idempotent: no second merge attempt");
    ok(r.guard === null, "idempotent: the guard did not run, so no objection was posted on landed work");
  }
  {
    // Same PR state, but the ticket is In Review — the exact combination a second fire meets. It must
    // still be exit 0, or every landed ticket would collect a spurious objection.
    const { r, exit } = await run({ ticket: "PM-2", state: "MERGED" });
    ok(exit === PR_MERGE_EXIT.merged && r.guard === null,
      `idempotent: MERGED + In Review ticket is still a clean no-op (got exit ${exit})`);
  }

  // ── A forge error after a clear gate is NOT an objection ───────────────────────────────────────
  {
    const { r, calls, exit } = await run({ ticket: "PM-6", mergeOk: false, mergeStderr: "GraphQL: Base branch was modified" }, { apply: false });
    ok(!r.merged && r.holds.length === 0, "mergeFailed: no axis objected");
    ok(mergeCalls(calls).length === 1, "mergeFailed: the merge WAS attempted (the gate had cleared)");
    ok(exit === PR_MERGE_EXIT.mergeFailed && exit === 4, `mergeFailed: its own exit code 4, distinct from a hold (got ${exit})`);
    ok((r.mergeError ?? "").includes("Base branch was modified"), `mergeFailed: the forge's message survives (got: ${r.mergeError})`);
  }

  // ── No repo resolved → usage, and still no merge ───────────────────────────────────────────────
  {
    const { exec, calls } = mkExec({ ticket: "PM-1" });
    const r = await prMerge(join(ROOT, "not-a-repo"), { pr: PR, dbPath, exec });   // no ghRepo, nothing to resolve from
    ok(r.ghRepo === null && !r.merged, "usage: an unresolvable repo does not merge");
    ok(prMergeExit(r) === PR_MERGE_EXIT.usage, `usage: exit 2 (got ${prMergeExit(r)})`);
    ok(calls.length === 0, "usage: not a single gh call — it cannot address a PR without owner/repo");
  }

  // ── The CI config is resolved for the SELECTED repo, not the invocation dir ────────────────────
  //
  // Review of this ticket's own PR found the verb could still squash with the CI axis never run.
  // `resolveGhRepo` answers from the workspace repo registry when the cwd is not a git repo
  // (LOOP-300 AC3) — the mode --help advertises — while the config lookup matched a REGISTERED PATH
  // only. Run from the workspace ROOT the pair resolved a repo and then no config for it:
  // mergeChecks empty ⇒ ciFreshness skipped as `no-merge-checks` ⇒ no hold ⇒ squash. A gate that
  // skipped CI because it could not find its own config had not passed anything, and this is the
  // LOOP-423 merge re-created inside the verb built to refuse it.
  //
  // FAIL-BEFORE (keyed on the invocation dir): ciConfig is null here, so the missing-check arm
  // passes no mergeChecks and MERGES — `merges=1`, the incident itself. PASS-AFTER: `merges=0`.
  {
    const wsRoot = join(ROOT, "ws444");
    mkdirSync(join(wsRoot, "the-repo"), { recursive: true });
    writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "t444", backend: "service", git: { defaultBranch: "main" } },
      repos: {
        "the-repo": {
          path: "the-repo", remote: `git@github.com:${GHREPO}.git`,
          landing: "pr", autoMerge: true, mergeChecks: CHECKS,
        },
      },
      projects: {},
    }, null, 2) + "\n");

    // DEVLOOP_WORKSPACE / DEVLOOP_HUB_DB OUTRANK the directory argument (LOOP-418), so under a fire's
    // env this arm would resolve the LIVE workspace and measure the wrong repo's config entirely.
    const saved: Record<string, string | undefined> = {
      DEVLOOP_WORKSPACE: process.env.DEVLOOP_WORKSPACE, DEVLOOP_HUB_DB: process.env.DEVLOOP_HUB_DB,
    };
    delete process.env.DEVLOOP_WORKSPACE; delete process.env.DEVLOOP_HUB_DB;
    try {
      const target = resolvePrMergeTarget(wsRoot);
      ok(target.ghRepo === GHREPO,
        `selected-repo config: the repo resolves from the registry at the workspace ROOT (got ${target.ghRepo})`);
      ok(target.ciConfig.kind === "resolved",
        `selected-repo config: …and so does ITS CI config — one resolution, so the two cannot disagree (got '${target.ciConfig.kind}')`);
      const sel = target.ciConfig.kind === "resolved" ? target.ciConfig.config : null;
      ok(JSON.stringify(sel?.mergeChecks) === JSON.stringify(CHECKS),
        `selected-repo config: the required checks are the registry entry's (got ${JSON.stringify(sel?.mergeChecks)})`);
      ok(sel?.repoEligible === true,
        "selected-repo config: landing:\"pr\" + autoMerge ⇒ the axis applies to this repo");

      // The consequence, on the argv — driven exactly as the CLI drives it: the config comes from the
      // resolution and NOTHING is hand-passed, so a null config reproduces the pre-fix squash rather
      // than throwing.
      const drive = async (rollup: Array<{ name: string; conclusion: string | null }>): Promise<{ r: PrMergeResult; merges: number; exit: number }> => {
        const { exec, calls } = mkExec({ ticket: "PM-1", rollup });
        const cfg = sel;
        const r = await prMerge(wsRoot, {
          pr: PR, dbPath, exec, agentReviewers: [], apply: false,
          ...(target.ghRepo ? { ghRepo: target.ghRepo } : {}),
          ...(cfg ? { mergeChecks: cfg.mergeChecks, defaultBranch: cfg.defaultBranch, repoEligible: cfg.repoEligible, ciIrrelevantPaths: cfg.ciIrrelevantPaths } : {}),
        });
        return { r, merges: mergeCalls(calls).length, exit: prMergeExit(r) };
      };

      const missing = await drive([{ name: "GitGuardian Security Checks", conclusion: "SUCCESS" }]);
      ok(missing.merges === 0 && missing.exit === PR_MERGE_EXIT.held,
        `selected-repo config: a required check that never reported HOLDS the squash from the workspace root (merges=${missing.merges}, exit=${missing.exit})`);
      ok(missing.r.holds[0]?.token === "check-never-reported",
        `selected-repo config: …and the hold names the cause (got '${missing.r.holds[0]?.token}')`);

      // Control, same fixture and same double: a GREEN rollup still merges. Without it the arm above
      // would pass just as well if resolving the config had broken merging altogether.
      const green = await drive(greenRollup);
      ok(green.merges === 1 && green.exit === PR_MERGE_EXIT.merged,
        `selected-repo config control: a green rollup still merges, so the hold above is the CHECKS talking (merges=${green.merges}, exit=${green.exit})`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  // ── Review round 3, finding 1: AMBIGUOUS CI config must hold, not read as "no config" ──────────
  //
  // The residual left by the selected-repo fix above. A workspace may hold two repo entries with
  // DISTINCT paths and the SAME GitHub remote — the config validator permits it. `registryGhRepos`
  // dedupes remotes into a Set, so `resolveGhRepo` succeeds and picks the repo; the by-remote
  // fallback then found two candidates and returned `null`, the same value that means "there is no
  // entry". The caller omitted every CI option, the axis skipped as `no-merge-checks`, and the
  // squash issued: the config-resolution failure of the previous finding, wearing a different mask.
  //
  // "I could not choose" and "there is nothing to choose" are different facts, so they are now
  // different values, and the skip is classified `untargeted` — the caller can fix it with --repo.
  //
  // FAIL-BEFORE / PASS-AFTER: `node hub/test/pr-merge.ts`. Against the pre-fix tree ciConfig is
  // `null` for this fixture, no mergeChecks reach the guard, and the missing-check arm MERGES
  // (merges=1) with a red-adjacent rollup nothing ever validated.
  {
    const ambRoot = join(ROOT, "ws444amb");
    mkdirSync(join(ambRoot, "repo-a"), { recursive: true });
    mkdirSync(join(ambRoot, "repo-b"), { recursive: true });
    writeFileSync(join(ambRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "t444amb", backend: "service", git: { defaultBranch: "main" } },
      repos: {
        // Same remote, two checkouts, DIFFERENT required checks — so guessing an entry is not a
        // harmless tie-break: it would gate one checkout's PR against the other's check names.
        "repo-a": { path: "repo-a", remote: `git@github.com:${GHREPO}.git`, landing: "pr", autoMerge: true, mergeChecks: CHECKS },
        "repo-b": { path: "repo-b", remote: `https://github.com/${GHREPO}.git`, landing: "pr", autoMerge: true, mergeChecks: ["Other"] },
      },
      projects: {},
    }, null, 2) + "\n");

    const saved: Record<string, string | undefined> = {
      DEVLOOP_WORKSPACE: process.env.DEVLOOP_WORKSPACE, DEVLOOP_HUB_DB: process.env.DEVLOOP_HUB_DB,
    };
    delete process.env.DEVLOOP_WORKSPACE; delete process.env.DEVLOOP_HUB_DB;
    try {
      const target = resolvePrMergeTarget(ambRoot);
      ok(target.ghRepo === GHREPO,
        `ambiguous config: the repo still RESOLVES (the remotes dedupe) — which is what hid this (got ${target.ghRepo})`);
      ok(target.ciConfig.kind === "ambiguous",
        `ambiguous config: …but its CI config reports AMBIGUOUS, not 'none' (got '${target.ciConfig.kind}')`);
      ok(target.ciConfig.kind === "ambiguous" && JSON.stringify(target.ciConfig.paths) === JSON.stringify(["repo-a", "repo-b"]),
        `ambiguous config: and it names the candidates the operator must pick between (got ${JSON.stringify(target.ciConfig.kind === "ambiguous" ? target.ciConfig.paths : null)})`);

      // Driven exactly as the CLI drives it — nothing hand-passed — so a pre-fix `null` reproduces
      // the squash instead of throwing.
      const { exec, calls } = mkExec({ ticket: "PM-1", rollup: greenRollup });
      const cfg = target.ciConfig.kind === "resolved" ? target.ciConfig.config : null;
      const r = await prMerge(ambRoot, {
        pr: PR, dbPath, exec, agentReviewers: [], apply: false,
        ...(target.ghRepo ? { ghRepo: target.ghRepo } : {}),
        ...(target.ciConfig.kind === "ambiguous" ? { ciConfigAmbiguous: true } : {}),
        ...(cfg ? { mergeChecks: cfg.mergeChecks, defaultBranch: cfg.defaultBranch, repoEligible: cfg.repoEligible, ciIrrelevantPaths: cfg.ciIrrelevantPaths } : {}),
      });
      const merges = mergeCalls(calls).length;
      ok(merges === 0 && prMergeExit(r) === PR_MERGE_EXIT.held,
        `ambiguous config: NO merge is issued (merges=${merges}, exit=${prMergeExit(r)})`);
      ok(r.holds.some((h) => h.axis === "ciFreshness" && h.token === "ci-config-ambiguous"),
        `ambiguous config: the hold names the axis and the cause (got ${JSON.stringify(r.holds.map((h) => h.token))})`);
      ok(r.guard?.ciFreshness.skipReason === "ci-config-ambiguous",
        `ambiguous config: the axis records WHY it did not run, not that it had nothing to check (got '${r.guard?.ciFreshness.skipReason}')`);

      // The classification is what does the work, and it is asserted directly: `untargeted` is the
      // class `holdsFrom` keys on, so any future untargeted skip fails closed without a new arm.
      ok(skipClass("ci-config-ambiguous") === "untargeted",
        `ambiguous config: the skip is 'untargeted' — the caller can fix it (got '${skipClass("ci-config-ambiguous")}')`);

      // Control: the SAME fixture with the ambiguity removed merges. Without it these arms would
      // pass equally well if the fix had frozen this workspace shape outright.
      writeFileSync(join(ambRoot, "dev-loop.json"), JSON.stringify({
        schemaVersion: 2,
        team: { key: "t444amb", backend: "service", git: { defaultBranch: "main" } },
        repos: { "repo-a": { path: "repo-a", remote: `git@github.com:${GHREPO}.git`, landing: "pr", autoMerge: true, mergeChecks: CHECKS } },
        projects: {},
      }, null, 2) + "\n");
      const t2 = resolvePrMergeTarget(ambRoot);
      ok(t2.ciConfig.kind === "resolved",
        `ambiguous config control: one entry ⇒ 'resolved' (got '${t2.ciConfig.kind}')`);
      const c2 = t2.ciConfig.kind === "resolved" ? t2.ciConfig.config : null;
      const { exec: e2, calls: k2 } = mkExec({ ticket: "PM-1", rollup: greenRollup });
      const r2 = await prMerge(ambRoot, {
        pr: PR, dbPath, exec: e2, agentReviewers: [], apply: false,
        ...(t2.ghRepo ? { ghRepo: t2.ghRepo } : {}),
        ...(c2 ? { mergeChecks: c2.mergeChecks, defaultBranch: c2.defaultBranch, repoEligible: c2.repoEligible } : {}),
      });
      ok(mergeCalls(k2).length === 1 && r2.merged,
        `ambiguous config control: …and it MERGES on green — the hold above is the ambiguity talking, not a freeze (merges=${mergeCalls(k2).length})`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  // ── Review of this PR, finding 1: an EVALUATED-but-uncertified CI axis must hold ───────────────
  //
  // `readCiFreshness` degrades to verdict `unknown` whenever the rollup read or the compare call
  // fails (hub/src/landing.ts) — and `unknown` does not TRIP the guard, deliberately: §3.4 says a
  // forge outage must not become a merge freeze for an advisory gate. But the axis is not SKIPPED
  // either, so `unevaluatedHold` sees an evaluated run and, before the fix, the verb went straight
  // on to squash. The forge that failed the compare call can still answer the merge endpoint, so an
  // unverified head lands — the exact merge this verb exists to refuse.
  //
  // The fix is an allowlist (`fresh-green` / `stale-exempt`) rather than a blocklist of bad
  // verdicts, so a verdict added to CiFreshnessVerdict later fails CLOSED instead of silently
  // re-opening this hole. These arms pin both halves of that.
  //
  // FAIL-BEFORE / PASS-AFTER: `node hub/test/pr-merge.ts`. Reverting holdsFrom's ciFreshness branch
  // to the old `else if (cf.verdict === "pending")` shape gives `merges=1, exit=0` here — the
  // unverified squash itself — and these checks fail; with the allowlist, `merges=0, exit=1`.
  {
    const unk = await run({ ticket: "PM-1", compareOk: false }, { apply: false });
    ok(unk.r.guard?.ciFreshness.skipped === false,
      "ci-unknown: the axis RAN — this is not the skipped/degraded case, which has its own rule");
    ok(unk.r.guard?.ciFreshness.verdict === "unknown",
      `ci-unknown: a failed compare degrades the verdict to 'unknown' (got '${unk.r.guard?.ciFreshness.verdict}')`);
    ok(unk.r.guard?.ciFreshness.trip === false,
      "ci-unknown: …and it still does NOT trip the guard — §3.4's fail-open for an outage is unchanged");
    ok(unk.exit === PR_MERGE_EXIT.held,
      `ci-unknown: but the VERB holds — 'not an objection' is not 'may be merged' (got exit ${unk.exit})`);
    ok(mergeCalls(unk.calls).length === 0, "ci-unknown: NO merge subprocess was issued");
    ok(unk.r.holds.length === 1 && unk.r.holds[0]?.token === "unknown",
      `ci-unknown: the hold names the verdict, so the remedy is readable (got ${unk.r.holds.map((h) => h.token).join("+") || "none"})`);
    ok(/never certified green/.test(unk.r.holds[0]?.detail ?? ""),
      `ci-unknown: …and says what is missing rather than asserting a failure (got: ${unk.r.holds[0]?.detail})`);

    // The allowlist is the gate: `stale-exempt` — behind the tip, but every file in the delta is
    // configured CI-irrelevant — is a POSITIVE certification and still merges. Without this control
    // the arms above would pass equally well if the fix had simply frozen every merge.
    const exempt = await (async () => {
      const { exec, calls } = mkExec({ ticket: "PM-1", behindBy: 2, files: ["docs/STRATEGY.md"] });
      const r = await prMerge(repoDir, {
        pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [], apply: false,
        mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true, ciIrrelevantPaths: ["docs/"],
        lockPath: join(ROOT, "locks", "exempt.lock"),
      });
      return { r, merges: mergeCalls(calls).length, exit: prMergeExit(r) };
    })();
    ok(exempt.r.guard?.ciFreshness.verdict === "stale-exempt",
      `ci-unknown control: a CI-irrelevant delta reads 'stale-exempt' (got '${exempt.r.guard?.ciFreshness.verdict}')`);
    ok(exempt.merges === 1 && exempt.exit === PR_MERGE_EXIT.merged,
      `ci-unknown control: …and STILL merges — the allowlist admits it, so the holds above are the verdict talking, not a freeze (merges=${exempt.merges}, exit=${exempt.exit})`);
  }

  // ── Review of this PR, finding 2: the squash is pinned to the head the gate judged ─────────────
  //
  // The axes read a head SHA and its checks; the squash is a separate forge call seconds later. A
  // push landing in that window merges a head no axis ever saw, and this project has NO forge-side
  // required-check protection by design (§12c: it deadlocks the release pipeline's deploy/* PRs), so
  // nothing else would catch it. `--match-head-commit` makes the FORGE refuse that.
  //
  // FAIL-BEFORE / PASS-AFTER: `node hub/test/pr-merge.ts`. Dropping the flag from mergeArgvFor gives
  // an argv with no SHA precondition and these checks fail.
  {
    const { r, calls } = await run({ ticket: "PM-1", prHeadSha: "head000", ciHeadSha: "head000" }, { apply: false });
    const argv = mergeCalls(calls)[0] ?? [];
    const i = argv.indexOf("--match-head-commit");
    ok(i > -1 && argv[i + 1] === "head000",
      `head-pin: the squash carries --match-head-commit <judged SHA> (got ${JSON.stringify(argv)})`);
    ok(r.merged, "head-pin: …and a matching head still merges normally");

    // Which SHA, when the two reads disagree: the one the CHECKS ran on. `testedHead` is the
    // revision the CI axis certified; the readiness read is a different call and can already be
    // looking at a newer head. Pinning to the readiness SHA would authorise a revision no check
    // covered — the same hole, one call later.
    const moved = await run({ ticket: "PM-1", prHeadSha: "newerHead", ciHeadSha: "checkedHead" }, { apply: false });
    const margv = mergeCalls(moved.calls)[0] ?? [];
    ok(margv[margv.indexOf("--match-head-commit") + 1] === "checkedHead",
      `head-pin: the pin is the CHECKED head, not whatever the readiness read saw (got ${JSON.stringify(margv)})`);

    // Fallback: with the CI axis skipped there is no certified SHA, but a mid-flight push is still
    // not something to land silently — the readiness head pins it.
    const { exec, calls: c2 } = mkExec({ ticket: "PM-1", prHeadSha: "readinessHead" });
    await prMerge(repoDir, {
      pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [], apply: false,
      mergeChecks: CHECKS, defaultBranch: "main", repoEligible: false,   // ⇒ ciFreshness skipped, testedHead null
    });
    const fargv = mergeCalls(c2)[0] ?? [];
    ok(fargv[fargv.indexOf("--match-head-commit") + 1] === "readinessHead",
      `head-pin: a skipped CI axis falls back to the readiness head rather than dropping the pin (got ${JSON.stringify(fargv)})`);

    // And with no SHA at all the flag is omitted rather than emitted empty — an empty
    // --match-head-commit would be a usage error against the real gh, turning every such merge into
    // a spurious exit 4.
    ok(!mergeArgvFor(PR, GHREPO, null).includes("--match-head-commit"),
      `head-pin: no known SHA ⇒ no flag, never an empty one (got ${JSON.stringify(mergeArgvFor(PR, GHREPO, null))})`);
  }

  // ── LOOP-455: the axes and the squash are ONE critical section, per repo ───────────────────────
  //
  // FAIL-BEFORE / PASS-AFTER: `node hub/test/pr-merge.ts`. Against the pre-fix tree (a synchronous
  // `prMerge` that takes no lock) the first arm below reports
  //   ❌ LOOP-455/AC1: the axes do not run until the lock is free (0 gh calls while held) — got 7
  //   ❌ LOOP-455/AC2: the second call re-read freshness against the MOVED base and held as stale
  // because the call reads its axes immediately, sees behind_by=0, and squashes on a verdict
  // computed against a base that fire 1 has already superseded. After the fix it waits, re-reads,
  // and holds. Both arms pass.
  {
    const held = join(ROOT, "locks", "contended.lock");

    // AC1 + AC2 — the interleaving the ticket describes, driven through the injected exec seam.
    // Fire 1 is modelled by HOLDING the lock (it is mid-landing); the base moving under fire 2 is
    // modelled by flipping `behindBy` while fire 2 is blocked. What is asserted is not "it waited"
    // but the consequence that matters: fire 2's freshness verdict is computed AFTER the base moved.
    {
      const scenario: Scenario = { ticket: "PM-1", behindBy: 0 };   // mutated below, mid-flight
      const { exec, calls } = mkExec(scenario);
      const release = await acquireLock(held, { totalMs: 5_000, staleMs: 60_000 });

      const inflight = prMerge(repoDir, {
        pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [], apply: false,
        mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true,
        lockPath: held, lockWaitMs: 5_000,
      });

      await new Promise((r) => setTimeout(r, 300));
      // The load-bearing assertion for AC1: with the lock held, the gate has not read ANYTHING.
      // If the axes ran here they would be reading the pre-squash world, which is the whole defect.
      ok(calls.length === 0,
        `LOOP-455/AC1: the axes do not run until the lock is free (0 gh calls while held) — got ${calls.length}`);

      scenario.behindBy = 5;    // fire 1's squash landed: main is now T+1 and this PR is behind it
      release();

      const r = await inflight;
      ok(mergeCalls(calls).length === 0, `LOOP-455/AC2: the second call issues NO squash (got ${mergeCalls(calls).length})`);
      ok(prMergeExit(r) === PR_MERGE_EXIT.held && r.holds[0]?.token === "stale",
        `LOOP-455/AC2: the second call re-read freshness against the MOVED base and held as stale (exit ${prMergeExit(r)}, token '${r.holds[0]?.token}')`);
    }

    // AC3 — contention that outlasts the wait has ONE defined outcome: exit 5, nothing merged, and
    // nothing read. Never a silent pass, and never exit 1: no axis objected, so there is no
    // objection on the ticket for a caller to go and read.
    {
      const { exec, calls } = mkExec({ ticket: "PM-1" });
      const release = await acquireLock(held, { totalMs: 5_000, staleMs: 60_000 });
      const r = await prMerge(repoDir, {
        pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [], apply: false,
        mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true,
        lockPath: held, lockWaitMs: 150,
      });
      release();
      ok(prMergeExit(r) === PR_MERGE_EXIT.lockUnavailable && PR_MERGE_EXIT.lockUnavailable === 5,
        `LOOP-455/AC3: contention past --lock-wait exits 5 (got ${prMergeExit(r)})`);
      ok(r.lockUnavailable !== null && !r.merged && r.mergeArgv === null,
        "LOOP-455/AC3: …reported as a lock failure, with no merge attempted");
      ok(r.holds.length === 0, `LOOP-455/AC3: …and NOT as a hold — a hold names an objection somebody must answer (got ${r.holds.length})`);
      ok(calls.length === 0, `LOOP-455/AC3: the gate never ran at all (got ${calls.length} gh calls)`);
    }

    // AC4 — the uncontended path is untouched: same argv, and the lock is RELEASED afterwards, so a
    // second landing in the same repo is not blocked by the first having finished.
    {
      const { r, calls } = await run({ ticket: "PM-1" }, { apply: false });
      const want = ["pr", "merge", "101", "--repo", GHREPO, "--squash", "--delete-branch", "--match-head-commit", "head000"];
      ok(r.merged && JSON.stringify(mergeCalls(calls)[0]) === JSON.stringify(want),
        "LOOP-455/AC4: an uncontended call issues the same argv it did before the lock existed");
      ok(!existsSync(join(ROOT, "locks", "arm.lock")),
        "LOOP-455/AC4: …and the lock is released, so it does not leak into the next landing");
    }

    // AC5a — a lock left by a CRASHED fire is broken, not waited out. Without this a budget-killed
    // fire (routine here) would freeze every later merge in the repo until a human deleted a file.
    {
      const dead = join(ROOT, "locks", "dead.lock");
      mkdirSync(join(ROOT, "locks"), { recursive: true });
      writeFileSync(dead, JSON.stringify({ pid: 999_999, at: new Date().toISOString() }));  // no such process
      const { exec, calls } = mkExec({ ticket: "PM-1" });
      const r = await prMerge(repoDir, {
        pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [], apply: false,
        mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true,
        lockPath: dead, lockWaitMs: 1_000,
      });
      ok(r.merged && mergeCalls(calls).length === 1,
        `LOOP-455/AC5: a dead holder's lock is broken on liveness, so a killed fire cannot freeze the queue (merged=${r.merged})`);
    }

    // AC5b — an INFRASTRUCTURAL lock failure fails CLOSED. This is the classification the ticket
    // asks to be made deliberately: §3.4 fails OPEN for a forge outage because an outage must not
    // become a merge freeze, but a lock that cannot be taken is evidence about another WRITER, not
    // about the forge — so it holds. `.git` is a file in this fixture, so the lock's parent
    // directory cannot be created (ENOTDIR).
    {
      const { exec, calls } = mkExec({ ticket: "PM-1" });
      const r = await prMerge(repoDir, {
        pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [], apply: false,
        mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true,
        lockPath: join(repoDir, ".git", "nope", "x.lock"), lockWaitMs: 200,
      });
      ok(prMergeExit(r) === PR_MERGE_EXIT.lockUnavailable && mergeCalls(calls).length === 0,
        `LOOP-455/AC5: a lock that cannot be created fails CLOSED — no squash (exit ${prMergeExit(r)}, merges ${mergeCalls(calls).length})`);
    }

    // AC1 — the lock a registered repo resolves to is BYTE-IDENTICAL to the one
    // `dev-loop with-repo-lock <ref>` takes, so a squash and a merge-back push cannot both move
    // `defaultBranch` at once. The env scrub is LOOP-418: a per-file run inside a fire resolves the
    // LIVE workspace from DEVLOOP_HUB_DB and would answer for the wrong tree.
    {
      const saved: Record<string, string | undefined> = {};
      for (const k of ["DEVLOOP_HUB_DB", "DEVLOOP_RUN_DIR", "DEVLOOP_WORKSPACE", "DEVLOOP_DATA_DIR", "DEVLOOP_PROJECTS_JSON"]) {
        saved[k] = process.env[k]; delete process.env[k];
      }
      try {
        const wsr = join(ROOT, "ws455");
        const wrepo = join(wsr, "checkout");
        mkdirSync(wrepo, { recursive: true });
        writeFileSync(join(wsr, "dev-loop.json"), JSON.stringify({
          schemaVersion: 2, team: { key: "t455", backend: "service" },
          repos: { mine: { path: "checkout", remote: `git@github.com:${GHREPO}.git` } },
          projects: {},
        }));
        const viaPath = prMergeLockPath(wrepo, GHREPO);
        ok(viaPath.endsWith(join(".dev-loop", "locks", "repo-mine.lock")),
          `LOOP-455/AC1: a registered repo locks on with-repo-lock's own name repo-<ref> (got ${viaPath})`);
        // From the workspace root — the cwd-independent invocation --help advertises — the ref is
        // matched by REMOTE, so both invocations serialize on one lock rather than two.
        const viaRemote = prMergeLockPath(wsr, GHREPO);
        ok(viaRemote === viaPath,
          `LOOP-455/AC1: the same repo resolves to the SAME lock from the workspace root (got ${viaRemote} vs ${viaPath})`);

        // …and from the TICKET WORKTREE, with the registry entry's OPTIONAL `remote` absent. Those
        // are the two conditions under which the ref match used to fall through — the worktree path
        // equals no registered `path`, and with no `remote` there is nothing left to match on — so
        // the name became `repo-gh-<owner-repo>` while `with-repo-lock <ref>` kept taking
        // `repo-<ref>`. Two names is not serialization, and §7 makes the worktree the NORMAL place a
        // dev tier lands from, so this is the common invocation rather than an exotic one.
        const wsw = join(ROOT, "ws455w");
        const clone = join(wsw, "checkout");
        const gitdir = join(clone, ".git", "worktrees", "LOOP-455");
        const wt = join(wsw, "wt", "LOOP-455");
        mkdirSync(gitdir, { recursive: true });
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wsw, "dev-loop.json"), JSON.stringify({
          schemaVersion: 2, team: { key: "t455w", backend: "service" },
          repos: { mine: { path: "checkout" } },   // no `remote` — the field is optional
          projects: {},
        }));
        writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
        const viaWorktree = prMergeLockPath(wt, GHREPO);
        ok(viaWorktree === prMergeLockPath(clone, GHREPO) &&
           viaWorktree.endsWith(join(".dev-loop", "locks", "repo-mine.lock")),
          `LOOP-455/AC1: landing from a ticket worktree of a remote-less registry entry takes the ref's own lock, not a second name (got ${viaWorktree})`);
        // …and from a SUBDIRECTORY of that worktree. `pr merge` runs from wherever the fire happens
        // to be, so a name that only answers at the worktree root is a name that changes with the
        // cwd — and a lock whose name changes with the cwd is not a lock.
        const inner = join(wt, "hub", "src");
        mkdirSync(inner, { recursive: true });
        ok(prMergeLockPath(inner, GHREPO) === viaWorktree,
          `LOOP-455/AC1: a subdirectory of the worktree resolves to the same lock as its root (got ${prMergeLockPath(inner, GHREPO)})`);
        // Same for a package subdirectory of the base clone itself — `hub/` is where this repo's
        // commands are actually run from.
        const pkg = join(clone, "hub");
        mkdirSync(pkg, { recursive: true });
        ok(prMergeLockPath(pkg, GHREPO) === viaWorktree,
          `LOOP-455/AC1: a package subdirectory of the clone resolves to the same lock (got ${prMergeLockPath(pkg, GHREPO)})`);
        // The structural match is on `.git/worktrees/`, so a SUBMODULE does not borrow its
        // superproject's lock — it is a different repo that happens to nest.
        const sub = join(wsw, "checkout", "vendor", "sub");
        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, ".git"), `gitdir: ${join(clone, ".git", "modules", "sub")}\n`);
        ok(prMergeLockPath(sub, GHREPO).endsWith(join(".dev-loop", "locks", `repo-gh-${GHREPO.replace("/", "-")}.lock`)),
          `LOOP-455/AC1: a submodule is not a worktree — it does not resolve to the superproject's ref lock (got ${prMergeLockPath(sub, GHREPO)})`);
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      }
    }
  }

  // ── AC5: merge-guard's exit contract is not renumbered ─────────────────────────────────────────
  // The direct-caller contract itself is owned by hub/test/merge-guard.ts, which this ticket does not
  // touch (its only edit to the module is an `export` keyword on resolveGhRepo). What is asserted
  // here is that the new caller reuses the numbers with their EXISTING meanings.
  ok(PR_MERGE_EXIT.held === 1 && PR_MERGE_EXIT.usage === 2, "AC5: 1 = objection and 2 = usage, as merge-guard has them");
  ok(PR_MERGE_EXIT.unevaluated === EXIT_UNEVALUATED && EXIT_UNEVALUATED === 3,
    `AC5: 3 keeps merge-guard's meaning — could not evaluate (got ${PR_MERGE_EXIT.unevaluated} vs ${EXIT_UNEVALUATED})`);
  ok(PR_MERGE_EXIT.mergeFailed === 4, "AC5: the ONE new number is 4 (gate clear, squash failed) — nothing was renumbered");
  // The unevaluated branch is a forward guard, not a live path: prMerge always supplies --pr and a
  // resolved ghRepo, so the two `untargeted` skip reasons (no-ticket-input, no-repo-resolved) cannot
  // arise inside it today. It exists so that if the classifier ever gains an untargeted reason that
  // CAN, this verb holds instead of squashing on a gate that checked nothing. Its mapping is pinned
  // directly, since the exec seam cannot reach it.
  const synthetic: PrMergeResult = {
    merged: false, alreadyMerged: false, holds: [], unevaluated: "no-ticket-input",
    ghRepo: GHREPO, guard: null, mergeArgv: null, mergeError: null, lockUnavailable: null,
  };
  ok(prMergeExit(synthetic) === PR_MERGE_EXIT.unevaluated,
    "AC5: a run that evaluated nothing it could have maps to exit 3, never to 0");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "pr-merge: all checks passed");
process.exit(fails ? 1 : 0);
