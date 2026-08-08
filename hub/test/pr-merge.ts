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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { EXIT_UNEVALUATED } from "../src/merge-guard.ts";
import { prMerge, prMergeExit, mergeArgvFor, PR_MERGE_EXIT, type PrMergeResult } from "../src/pr-merge.ts";

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
      if (fields === "state,isDraft,mergeable") {
        return json({ state: s.state ?? "OPEN", isDraft: s.isDraft ?? false, mergeable: s.mergeable ?? "MERGEABLE" });
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
        return json({ headRefOid: "head000", statusCheckRollup: s.rollup ?? greenRollup });
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
      }
      if (args[0] === "api" && args[1]?.startsWith(`/repos/${GHREPO}/compare/`)) {
        return json({ behind_by: s.behindBy ?? 0, base_commit: { sha: "tip999" }, files: [] });
      }
      refused.push(args);
      return { ok: false, stdout: "", stderr: `unexpected gh call: ${args.join(" ")}` };
    };
    return { exec, calls, refused };
  };

  const run = (s: Scenario, opts: { apply?: boolean } = {}): { r: PrMergeResult; calls: Call[]; refused: Call[]; exit: number } => {
    const { exec, calls, refused } = mkExec(s);
    const r = prMerge(repoDir, {
      pr: PR, ghRepo: GHREPO, dbPath, exec, agentReviewers: [],
      mergeChecks: CHECKS, defaultBranch: "main", repoEligible: true,
      ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
    });
    return { r, calls, refused, exit: prMergeExit(r) };
  };
  const mergeCalls = (calls: Call[]): Call[] => calls.filter((c) => c[0] === "pr" && c[1] === "merge");

  // ── AC2: all axes clean → it squashes, with the argv pinned ────────────────────────────────────
  {
    const { r, calls, refused, exit } = run({ ticket: "PM-1" }, { apply: false });
    ok(r.merged, "AC2: every evaluated axis clean → merged");
    ok(exit === PR_MERGE_EXIT.merged && exit === 0, `AC2: exit 0 (got ${exit})`);
    const m = mergeCalls(calls);
    ok(m.length === 1, `AC2: exactly ONE merge subprocess issued (got ${m.length})`);
    // The pinned argv. `--repo` is explicit because this verb inherits merge-guard's
    // cwd-independence (LOOP-300 AC3) and a bare `gh pr merge` only works inside the repo — it
    // would gate correctly from the workspace root and then fail to land.
    const want = ["pr", "merge", "101", "--repo", GHREPO, "--squash", "--delete-branch"];
    ok(JSON.stringify(m[0]) === JSON.stringify(want),
      `AC2: the argv is the Step 0.5 squash — ${JSON.stringify(want)} (got ${JSON.stringify(m[0])})`);
    ok(JSON.stringify(r.mergeArgv) === JSON.stringify(want), "AC2: the result reports the argv it issued");
    ok(JSON.stringify(mergeArgvFor(PR, GHREPO)) === JSON.stringify(want), "AC2: mergeArgvFor is that same one definition, not a second spelling");
    ok(refused.length === 0, `AC2: the double was asked nothing it was not written for — it refuses unknown argv, so an arm cannot pass on an accommodating mock (refused: ${refused.map((c) => c.join(" ")).join("; ") || "none"})`);
  }

  // ── AC1 + AC4: each axis holds, names itself, and issues NO merge ──────────────────────────────
  // One arm per axis. `axisHold` is the shared shape check: non-zero exit, no merge subprocess, and
  // a hold whose token identifies the cause — never one undifferentiated "refused".
  const axisHold = (label: string, s: Scenario, token: string, detailProbe: RegExp): PrMergeResult => {
    const { r, calls, exit } = run(s, { apply: false });
    ok(!r.merged, `AC1 ${label}: NOT merged`);
    ok(exit === PR_MERGE_EXIT.held, `AC1 ${label}: exit 1 (held) — non-zero, so §12c's "non-zero HOLDS that merge" already does the right thing (got ${exit})`);
    ok(mergeCalls(calls).length === 0, `AC1 ${label}: NO \`gh pr merge\` subprocess was issued`);
    ok(r.mergeArgv === null, `AC1 ${label}: …and the result reports no argv`);
    ok(r.holds.length === 1, `AC4 ${label}: exactly one axis objected (got ${r.holds.map((h) => h.token).join("+") || "none"})`);
    ok(r.holds[0]?.token === token, `AC4 ${label}: token is '${token}' (got '${r.holds[0]?.token}')`);
    ok(detailProbe.test(r.holds[0]?.detail ?? ""), `AC4 ${label}: the line names the cause (got: ${r.holds[0]?.detail})`);
    return r;
  };

  axisHold("boardState", { ticket: "PM-2" }, "board-not-merge-eligible", /PM-2 is In Review/);
  axisHold("forgeReview", { ticket: "PM-1", changesRequestedBy: "bob" }, "unresolved-review", /@bob/);
  axisHold("ciFreshness/check-never-reported",
    { ticket: "PM-1", rollup: [{ name: "GitGuardian Security Checks", conclusion: "SUCCESS" }] },
    "check-never-reported", /never reported: Test \(Node 23\.6\.0\), Test \(Node 24\)/);
  axisHold("ciFreshness/red",
    { ticket: "PM-4", rollup: [{ name: CHECKS[0]!, conclusion: "FAILURE" }, { name: CHECKS[1]!, conclusion: "SUCCESS" }] },
    "red", /verdict=red/);
  axisHold("ciFreshness/stale", { ticket: "PM-5", behindBy: 3 }, "stale", /3 commit\(s\) behind/);

  // AC4, the part a single exit code cannot express: two axes holding the SAME PR stay two lines
  // with two tokens. `check-never-reported` (re-dispatch the workflow) and a board-state hold (fix
  // the ticket) are different next actions, and collapsing co-occurring causes into one sentence is
  // the mistake LOOP-433 records on the doctor side.
  {
    const { r, calls, exit } = run({ ticket: "PM-2", rollup: [] }, { apply: false });
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
    const pend = run({ ticket: "PM-1", rollup: CHECKS.map((name) => ({ name, conclusion: null })) }, { apply: false });
    ok(pend.r.guard?.ciFreshness.trip === false, "readiness: pending checks still do NOT trip the guard (LOOP-407 unchanged)");
    ok(pend.exit === PR_MERGE_EXIT.held, `readiness: …but the VERB holds — a pending PR is not merged (got exit ${pend.exit})`);
    ok(mergeCalls(pend.calls).length === 0, "readiness: no merge subprocess while CI is still running");
    ok(pend.r.holds.length === 1 && pend.r.holds[0]?.token === "pending",
      `readiness: token 'pending' — "leave it for the next fire", not an objection (got ${pend.r.holds.map((h) => h.token).join("+")})`);

    const dirty = run({ ticket: "PM-1", mergeable: "CONFLICTING" }, { apply: false });
    ok(dirty.exit === PR_MERGE_EXIT.held && mergeCalls(dirty.calls).length === 0, "readiness: a CONFLICTING PR is held, not merged");
    ok(dirty.r.holds.some((h) => h.axis === "readiness" && h.token === "not-mergeable"),
      `readiness: token 'not-mergeable' (got ${dirty.r.holds.map((h) => h.token).join("+")})`);

    const unknown = run({ ticket: "PM-1", mergeable: "UNKNOWN" }, { apply: false });
    ok(unknown.r.holds.some((h) => h.token === "mergeability-unknown") && mergeCalls(unknown.calls).length === 0,
      "readiness: mergeability UNKNOWN fails closed — §12c merges only what IS mergeable");

    const draft = run({ ticket: "PM-1", isDraft: true }, { apply: false });
    ok(draft.r.holds.some((h) => h.token === "pr-draft") && mergeCalls(draft.calls).length === 0,
      "readiness: a DRAFT PR is held");

    const closed = run({ ticket: "PM-1", state: "CLOSED" }, { apply: false });
    ok(closed.r.holds.some((h) => h.token === "pr-not-open") && mergeCalls(closed.calls).length === 0,
      "readiness: a CLOSED PR is held — there is nothing to land");

    // Readiness and a guard axis can hold the same PR, and both are reported: the guard still runs,
    // so the board objection reaches the ticket on the FIRST run rather than after the rebase.
    const both = run({ ticket: "PM-2", mergeable: "CONFLICTING" }, { apply: false });
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
    const { r, calls } = run({ ticket: "PM-2" });            // apply defaults ON — this verb replaces `--strict --apply`
    ok(r.guard?.applied?.action === "wrote", `apply: a hold posts the guard's objection (got ${r.guard?.applied?.action})`);
    const posted = readComments("PM-2");
    ok(posted.length === 1 && posted[0]!.includes("⛔ merge-guard:"), `apply: exactly one objection comment on the ticket (got ${posted.length})`);
    ok(mergeCalls(calls).length === 0, "apply: …and still no merge");
    const again = run({ ticket: "PM-2" });
    ok(again.r.guard?.applied?.action === "already_present", `apply: idempotent on re-run (got ${again.r.guard?.applied?.action})`);
    ok(readComments("PM-2").length === 1, "apply: …no duplicate comment");
  }

  // ── Idempotent re-run: an already-merged PR is a no-op, not a hold ─────────────────────────────
  // Post-merge the ticket is normally In Review, so gating first would report a board hold on work
  // that already landed (the LOOP-216 shape). The merged check therefore runs BEFORE the guard, and
  // that ordering is what this arm pins.
  {
    const { r, calls, exit } = run({ ticket: "PM-7", state: "MERGED" });
    ok(r.alreadyMerged && !r.merged, "idempotent: an already-MERGED PR reports alreadyMerged");
    ok(exit === PR_MERGE_EXIT.merged, `idempotent: exit 0 — a landed PR is not a failure (got ${exit})`);
    ok(mergeCalls(calls).length === 0, "idempotent: no second merge attempt");
    ok(r.guard === null, "idempotent: the guard did not run, so no objection was posted on landed work");
  }
  {
    // Same PR state, but the ticket is In Review — the exact combination a second fire meets. It must
    // still be exit 0, or every landed ticket would collect a spurious objection.
    const { r, exit } = run({ ticket: "PM-2", state: "MERGED" });
    ok(exit === PR_MERGE_EXIT.merged && r.guard === null,
      `idempotent: MERGED + In Review ticket is still a clean no-op (got exit ${exit})`);
  }

  // ── A forge error after a clear gate is NOT an objection ───────────────────────────────────────
  {
    const { r, calls, exit } = run({ ticket: "PM-6", mergeOk: false, mergeStderr: "GraphQL: Base branch was modified" }, { apply: false });
    ok(!r.merged && r.holds.length === 0, "mergeFailed: no axis objected");
    ok(mergeCalls(calls).length === 1, "mergeFailed: the merge WAS attempted (the gate had cleared)");
    ok(exit === PR_MERGE_EXIT.mergeFailed && exit === 4, `mergeFailed: its own exit code 4, distinct from a hold (got ${exit})`);
    ok((r.mergeError ?? "").includes("Base branch was modified"), `mergeFailed: the forge's message survives (got: ${r.mergeError})`);
  }

  // ── No repo resolved → usage, and still no merge ───────────────────────────────────────────────
  {
    const { exec, calls } = mkExec({ ticket: "PM-1" });
    const r = prMerge(join(ROOT, "not-a-repo"), { pr: PR, dbPath, exec });   // no ghRepo, nothing to resolve from
    ok(r.ghRepo === null && !r.merged, "usage: an unresolvable repo does not merge");
    ok(prMergeExit(r) === PR_MERGE_EXIT.usage, `usage: exit 2 (got ${prMergeExit(r)})`);
    ok(calls.length === 0, "usage: not a single gh call — it cannot address a PR without owner/repo");
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
    ghRepo: GHREPO, guard: null, mergeArgv: null, mergeError: null,
  };
  ok(prMergeExit(synthetic) === PR_MERGE_EXIT.unevaluated,
    "AC5: a run that evaluated nothing it could have maps to exit 3, never to 0");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "pr-merge: all checks passed");
process.exit(fails ? 1 : 0);
