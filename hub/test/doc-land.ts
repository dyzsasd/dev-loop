// LOOP-57 regression: dev-loop doc-land must land PM's doc-only progress commits to
// origin/<defaultBranch> ff-only, refuse on non-doc paths, rebase when diverged, and
// downgrade push-guard reference findings (Canceled/Duplicate refs in prose) to WARN
// while hard-stopping on actual non-doc content. Bare-origin + clone harness (§15).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { parseDirtyPaths } from "../src/doc-land.ts";
import { pushApprovalKey } from "../src/push-guard.ts";
import { requestApproval } from "../src/approvals.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const git = (dir: string, args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// True iff <ref>:<path> exists (used to prove a rebased-past commit's file survived on origin).
const pathOnRef = (dir: string, ref: string, path: string): boolean => {
  try { execFileSync("git", ["-C", dir, "cat-file", "-e", `${ref}:${path}`], { stdio: "ignore" }); return true; }
  catch { return false; }
};

const run = (args: string[], wsRoot: string, extra?: Record<string, string>): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "doc-land.ts"), ...args], {
    encoding: "utf8",
    cwd: wsRoot,
    env: { ...scrubFireEnv(), ...extra },
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const ROOT = mkdtempSync(join(tmpdir(), "dl-doc-land-"));
try {
  // ── Fixture: bare origin + clone with a proper workspace ─────────────────────────
  const origin = join(ROOT, "origin.git");
  const wsRoot = join(ROOT, "ws");
  const repoDir = join(wsRoot, "dev-loop");
  mkdirSync(origin, { recursive: true });
  mkdirSync(wsRoot, { recursive: true });

  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repoDir]);

  // Initial baseline commit
  git(repoDir, ["commit", "--allow-empty", "-qm", "baseline"]);
  git(repoDir, ["push", "-qu", "origin", "main"]);

  // Workspace config with strategyDoc pointing to docs/STRATEGY.md
  const STRATEGY_PATH = "docs/STRATEGY.md";
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-doc-land",
    team: { key: "test", backend: "service", mode: "live", autonomy: "ask" },
    repos: { "dev-loop": { path: "dev-loop", remote: origin, landing: "pr" } },
    projects: { test: { repos: [{ ref: "dev-loop" }], strategyDoc: { path: STRATEGY_PATH } } },
  }, null, 2));
  mkdirSync(join(wsRoot, ".dev-loop", "locks"), { recursive: true });

  // Hub DB for push-guard reference findings
  const dbPath = join(wsRoot, ".dev-loop", "hub.db");
  const db = openDb(dbPath);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','test','Test','t')").run();
  const tk = (id: string, state: string): void => {
    db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,0,'[]','[]','pm','t','t')").run(id, "p", "t-" + id, state);
  };
  tk("TEST-1", "Canceled");
  db.close();

  // ── (a) Clean doc-only ahead → pushes ff-only; origin/main gains the commit ──────
  mkdirSync(join(repoDir, "docs"), { recursive: true });
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nInitial content.\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): initial LOOP-57 progress entry"]);
  const beforeSha = git(repoDir, ["rev-parse", "HEAD"]);

  const resA = run(["--repo", "dev-loop"], wsRoot);
  ok(resA.status === 0, `(a) clean doc-only → exits 0 (stderr: ${resA.stderr.trim().slice(0, 120)})`);
  const afterOriginSha = git(repoDir, ["rev-parse", "origin/main"]);
  ok(afterOriginSha === beforeSha, `(a) origin/main now contains the commit (${afterOriginSha.slice(0, 7)} === ${beforeSha.slice(0, 7)})`);
  ok(/landed/.test(resA.stdout), `(a) output says 'landed' (got: ${resA.stdout.trim()})`);

  // ── (b) A non-doc (code) file in the range → refuses; origin/main unchanged ──────
  const originShaBeforeB = git(repoDir, ["rev-parse", "origin/main"]);
  writeFileSync(join(repoDir, "non-doc-code.ts"), "// not a doc file\n");
  git(repoDir, ["add", "non-doc-code.ts"]);
  git(repoDir, ["commit", "-qm", "feat: some code change (NOT doc-only)"]);

  const resB = run(["--repo", "dev-loop"], wsRoot);
  ok(resB.status !== 0, `(b) non-doc path in range → exits non-zero (got ${resB.status})`);
  ok(/REFUSED|non-doc/.test(resB.stderr), `(b) output mentions REFUSED or non-doc (got: ${resB.stderr.trim().slice(0, 120)})`);
  ok(/non-doc-code\.ts/.test(resB.stderr), `(b) names the offending path (got: ${resB.stderr.trim().slice(0, 200)})`);
  const originShaAfterB = git(repoDir, ["rev-parse", "origin/main"]);
  ok(originShaAfterB === originShaBeforeB, `(b) origin/main is unchanged after refusal`);

  // Reset: drop the code commit, keep the doc state clean
  git(repoDir, ["reset", "--hard", "origin/main"]);

  // ── (c) origin/main advances under us → rebases doc commit + pushes ─────────────
  // Add a doc commit locally (a new archive file — no conflict with clone2's STRATEGY.md change)
  mkdirSync(join(repoDir, "docs", "strategy-archive"), { recursive: true });
  writeFileSync(join(repoDir, "docs", "strategy-archive", "2026-07.md"), "# Archive 2026-07\n");
  git(repoDir, ["add", "docs/strategy-archive/2026-07.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): archive entry — current state progress"]);

  // Simulate origin advancing: push from a separate clone (changing only STRATEGY.md, no conflict)
  const clone2 = join(ROOT, "clone2");
  execFileSync("git", ["clone", "-q", origin, clone2]);
  writeFileSync(join(clone2, "docs", "STRATEGY.md"), "# Strategy\n\nUpdated by another agent.\n");
  git(clone2, ["add", "docs/STRATEGY.md"]);
  git(clone2, ["commit", "-qm", "docs(strategy): other agent's progress entry"]);
  git(clone2, ["push", "-qu", "origin", "main"]);
  const originAdvancedSha = git(clone2, ["rev-parse", "HEAD"]);

  // Now local main has doc commit BEHIND origin (diverged — rebases required)
  const resC = run(["--repo", "dev-loop"], wsRoot);
  ok(resC.status === 0, `(c) diverged base → rebases + pushes (exits 0; stderr: ${resC.stderr.trim().slice(0, 120)})`);
  const originAfterC = git(repoDir, ["rev-parse", "origin/main"]);
  ok(originAfterC !== originAdvancedSha, `(c) origin/main advanced past the other agent's commit (new tip is the rebased archive entry)`);
  // The archive file from our doc commit should be on origin/main
  const archiveOnOrigin = (() => {
    try { return execFileSync("git", ["-C", repoDir, "ls-tree", "--name-only", "origin/main:docs/strategy-archive/"], { encoding: "utf8" }).trim(); }
    catch { return ""; }
  })();
  ok(/2026-07\.md/.test(archiveOnOrigin), `(c) rebased doc commit is on origin/main (archive file present)`);

  // Sync local to origin
  git(repoDir, ["fetch", "origin", "main"]);
  git(repoDir, ["reset", "--hard", "origin/main"]);

  // ── (d) Push rejected even after retry → blocked, NEVER a force-push ─────────────
  // Set a pre-receive hook on the bare repo that always rejects
  const hookDir = join(origin, "hooks");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(join(hookDir, "pre-receive"), "#!/bin/sh\necho 'hooks: reject all pushes for test (d)' >&2\nexit 1\n");
  execFileSync("chmod", ["+x", join(hookDir, "pre-receive")]);

  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nAnother update.\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): update for retry test"]);
  const originBeforeD = git(repoDir, ["rev-parse", "origin/main"]);

  const resD = run(["--repo", "dev-loop"], wsRoot);
  ok(resD.status !== 0, `(d) push rejected after retry → exits non-zero (got ${resD.status})`);
  ok(/BLOCKED|blocked/.test(resD.stderr), `(d) output mentions BLOCKED (got: ${resD.stderr.trim().slice(0, 200)})`);
  // Verify no force-push happened (origin/main is unchanged)
  const originAfterD = git(repoDir, ["rev-parse", "origin/main"]);
  ok(originAfterD === originBeforeD, `(d) origin/main unchanged after blocked retry — no force-push`);

  // Remove the hook for subsequent tests; abandon the blocked commit (it was never pushed)
  execFileSync("rm", [join(hookDir, "pre-receive")]);
  git(repoDir, ["reset", "--hard", "origin/main"]); // discard the blocked doc commit

  // ── (e) Doc-only commit whose SUBJECT cites a Canceled ticket → lands + warns ────
  // This is the e1177cd case: PM's running-log names CANCELED tickets (they're reportage)
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"),
    "# Strategy\n\nDecisions: TEST-1 (Canceled) — verify-fail noted in this lens entry.\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): trust-safety lens — TEST-1 verify-fail (TEST-1 Canceled)"]);
  const beforeE = git(repoDir, ["rev-parse", "HEAD"]);

  const resE = run(["--repo", "dev-loop"], wsRoot, { DEVLOOP_HUB_DB: dbPath });
  ok(resE.status === 0, `(e) canceled-ref commit lands (exits 0; stderr: ${resE.stderr.trim().slice(0, 120)})`);
  ok(/WARN|⚠️|downgraded|annotation/.test(resE.stdout), `(e) output mentions WARN/downgraded/annotation (got: ${resE.stdout.trim().slice(0, 200)})`);
  ok(/TEST-1/.test(resE.stdout), `(e) names the canceled ref in the annotation (got: ${resE.stdout.trim().slice(0, 200)})`);
  const afterOriginE = git(repoDir, ["rev-parse", "origin/main"]);
  ok(afterOriginE === beforeE, `(e) origin/main has the commit after landing`);
  ok(!/blocked|BLOCKED/.test(resE.stderr.toLowerCase()), `(e) not blocked — reference findings don't hard-stop`);

  // ── (f) Non-doc (passenger-class) commit in range → hard stop via step-1 assertion
  // A doc commit followed by a non-doc commit: step-1 catches the non-doc file, refuses.
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nFinal update.\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): final update"]);
  // Now add a non-doc (passenger-class) file to the same local branch
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nFinal update.\n");
  writeFileSync(join(repoDir, "some-code.ts"), "// passenger non-doc content\n");
  git(repoDir, ["add", "some-code.ts"]);
  git(repoDir, ["commit", "-qm", "chore: non-doc passenger commit sneaks in"]);
  const originBeforeF = git(repoDir, ["rev-parse", "origin/main"]);

  const resF = run(["--repo", "dev-loop"], wsRoot);
  ok(resF.status !== 0, `(f) non-doc passenger commit → hard stop (exits non-zero; got ${resF.status})`);
  ok(/REFUSED/.test(resF.stderr), `(f) output says REFUSED (step-1 catches it)`);
  ok(/some-code\.ts/.test(resF.stderr), `(f) names the offending path`);
  const originAfterF = git(repoDir, ["rev-parse", "origin/main"]);
  ok(originAfterF === originBeforeF, `(f) origin/main unchanged — nothing pushed`);

  // ── --dry-run: no mutations ────────────────────────────────────────────────────────
  // Reset to a clean doc-only state (some-code.ts was only committed locally, not on origin/main)
  git(repoDir, ["reset", "--hard", "origin/main"]);
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nDry-run test entry.\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): dry-run test"]);
  const originBeforeDry = git(repoDir, ["rev-parse", "origin/main"]);

  const resDry = run(["--repo", "dev-loop", "--dry-run"], wsRoot);
  ok(resDry.status === 0, `--dry-run exits 0 (stderr: ${resDry.stderr.trim()})`);
  ok(/dry-run/.test(resDry.stdout), `--dry-run output mentions 'dry-run'`);
  const originAfterDry = git(repoDir, ["rev-parse", "origin/main"]);
  ok(originAfterDry === originBeforeDry, `--dry-run: origin/main unchanged (nothing pushed)`);

  // ── --dry-run under the approvals gate: refuses, and writes NOTHING (LOOP-394 R10) ──────────────
  //
  // `--dry-run` is documented as "print what would push without mutating anything", but the approvals
  // consult inside push-guard ledgers an `approval.attempt` row by default — so the one command that
  // promises to write nothing appended to the audit trail on every inspection.
  //
  // The non-dry run is the CONTROL and it is what makes this discriminating: deleting the consult, or
  // passing `record:false` everywhere, would satisfy the dry-run arm alone. Both arms must ALSO still
  // refuse — suppressing the ledger row must not weaken the gate, which is the other way this fix
  // could go wrong.
  {
    const wsFile = join(wsRoot, "dev-loop.json");
    const wsBefore = readFileSync(wsFile, "utf8");
    const cfg = JSON.parse(wsBefore);
    cfg.team.approvals = { enforce: ["push"] };
    writeFileSync(wsFile, JSON.stringify(cfg, null, 2));

    git(repoDir, ["reset", "--hard", "origin/main"]);
    writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nAwaiting approval.\n");
    git(repoDir, ["add", "docs/STRATEGY.md"]);
    git(repoDir, ["commit", "-qm", "docs(strategy): a landing that awaits the operator (TEST-2)"]);
    const gatedSha = git(repoDir, ["rev-parse", "HEAD"]);

    const d2 = openDb(dbPath);
    d2.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('TEST-2','p','t-TEST-2','Todo',0,'[]','[]','pm','t','t')").run();
    requestApproval(d2, { projectId: "p", actionKey: pushApprovalKey("main", gatedSha), requestedBy: "pm", ticketId: "TEST-2" });
    d2.close();

    const attempts = (): number => {
      const d = openDb(dbPath);
      try { return (d.prepare("SELECT count(*) c FROM events WHERE kind='approval.attempt'").get() as { c: number }).c; }
      finally { d.close(); }
    };

    const before = attempts();
    const resDryGated = run(["--repo", "dev-loop", "--dry-run"], wsRoot, { DEVLOOP_HUB_DB: dbPath });
    const afterDry = attempts();
    ok(resDryGated.status !== 0, `--dry-run under the gate still REFUSES an ungranted push (got ${resDryGated.status})`);
    ok(/approvals gate refused|awaits human approval/.test(resDryGated.stderr),
      `--dry-run names the approvals refusal (got: ${resDryGated.stderr.trim().slice(0, 160)})`);
    ok(afterDry === before,
      `--dry-run appends NO approval.attempt row — it mutates nothing, as documented (${before} → ${afterDry})`);

    const resRealGated = run(["--repo", "dev-loop"], wsRoot, { DEVLOOP_HUB_DB: dbPath });
    const afterReal = attempts();
    ok(resRealGated.status !== 0, `control: the REAL run refuses the same push (got ${resRealGated.status})`);
    ok(afterReal === before + 1,
      `control: the real run DOES ledger the attempt — the audit line is suppressed only for an inspection (${before} → ${afterReal})`);
    const originAfterGated = git(repoDir, ["rev-parse", "origin/main"]);
    ok(originAfterGated === originBeforeDry, `neither run pushed — the gate held on both`);

    // Restore: later blocks are written against an unenforced workspace.
    writeFileSync(wsFile, wsBefore);
    git(repoDir, ["reset", "--hard", "origin/main"]);
  }

  // ── (g) origin advances with a CODE commit while local has a doc-only commit → LANDS ─────────
  //   LOOP-119, the whole ticket: step-1's two-dot diff saw origin's own code file and named it
  //   PM's offender, refusing before the rebase. Three-dot (merge-base..HEAD) sees only OUR doc
  //   commit. Every prior origin-advance case (c) advanced origin with a DOC file, so the shipped
  //   suite never exercised a CODE divergence — the bug was invisible.
  git(repoDir, ["fetch", "origin", "main"]);
  git(repoDir, ["reset", "--hard", "origin/main"]);
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nPM progress while origin lands code.\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): PM progress entry (g)"]);
  // origin advances with a CODE commit pushed by another agent (clone2)
  git(clone2, ["fetch", "-q", "origin", "main"]);
  git(clone2, ["reset", "--hard", "origin/main"]);
  writeFileSync(join(clone2, "agent-code.ts"), "// another agent's CODE landing on origin/main\n");
  git(clone2, ["add", "agent-code.ts"]);
  git(clone2, ["commit", "-qm", "feat: another agent's code change (g)"]);
  git(clone2, ["push", "-qu", "origin", "main"]);
  // repoDir LEARNS about the code commit before doc-land runs — the real "behind 1 (code)" state
  // the two-dot diff mis-blames. Without this fetch the origin ref is stale and the bug is invisible.
  git(repoDir, ["fetch", "origin", "main"]);

  const resG = run(["--repo", "dev-loop"], wsRoot);
  ok(resG.status === 0, `(g) origin ahead with CODE + local doc-only → LANDS (exit 0; stderr: ${resG.stderr.trim().slice(0, 160)})`);
  ok(!/REFUSED|non-doc/.test(resG.stderr), `(g) does NOT refuse — no non-doc offender named (stderr: ${resG.stderr.trim().slice(0, 160)})`);
  ok(!/agent-code\.ts/.test(resG.stderr), `(g) the other agent's code path is never named as PM's offender`);
  git(repoDir, ["fetch", "origin", "main"]);
  ok(/PM progress while origin lands code/.test(git(repoDir, ["show", "origin/main:docs/STRATEGY.md"])),
    `(g) the doc commit is on origin/main (rebased + pushed)`);
  ok(pathOnRef(repoDir, "origin/main", "agent-code.ts"),
    `(g) the other agent's code commit is preserved on origin/main (rebased onto, not clobbered)`);

  // ── (h) same shape but the non-doc commit is LOCALLY authored → still REFUSED ─────────────────
  //   proves the three-dot change did NOT widen the fence: a locally-authored code commit is inside
  //   merge-base..HEAD and is still caught (LOOP-119 AC — the fence must survive the range change).
  git(repoDir, ["fetch", "origin", "main"]);
  git(repoDir, ["reset", "--hard", "origin/main"]);
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nPM progress (h).\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): PM progress entry (h)"]);
  writeFileSync(join(repoDir, "local-code.ts"), "// locally authored, never pushed to origin\n");
  git(repoDir, ["add", "local-code.ts"]);
  git(repoDir, ["commit", "-qm", "feat: locally authored code (h)"]);
  const originBeforeH = git(repoDir, ["rev-parse", "origin/main"]);

  const resH = run(["--repo", "dev-loop"], wsRoot);
  ok(resH.status !== 0, `(h) locally-authored code commit in range → still REFUSED (exit non-zero; got ${resH.status})`);
  ok(/REFUSED|non-doc/.test(resH.stderr), `(h) refusal message present (fence intact)`);
  ok(/local-code\.ts/.test(resH.stderr), `(h) names the locally-authored offending path (got: ${resH.stderr.trim().slice(0, 160)})`);
  ok(git(repoDir, ["rev-parse", "origin/main"]) === originBeforeH, `(h) origin/main unchanged after refusal`);

  // ── (j) LOOP-118: a REAL prose conflict on the same strategyDoc line → the rebase fails, doc-land
  //   ABORTS it, and leaves the SHARED checkout clean (not wedged mid-rebase) for every other agent.
  git(repoDir, ["fetch", "origin", "main"]);
  git(repoDir, ["reset", "--hard", "origin/main"]);
  // a shared baseline both sides diverge from
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nintro\nSHARED-LINE-base\nouttro\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): conflict baseline (j)"]);
  git(repoDir, ["push", "-qu", "origin", "main"]);
  // local edits the shared line one way (unpushed)
  writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nintro\nSHARED-LINE-local\nouttro\n");
  git(repoDir, ["add", "docs/STRATEGY.md"]);
  git(repoDir, ["commit", "-qm", "docs(strategy): local edit to shared line (j)"]);
  // clone2 edits the SAME line differently and pushes FIRST
  git(clone2, ["fetch", "-q", "origin", "main"]);
  git(clone2, ["reset", "--hard", "origin/main"]);
  writeFileSync(join(clone2, "docs", "STRATEGY.md"), "# Strategy\n\nintro\nSHARED-LINE-remote\nouttro\n");
  git(clone2, ["add", "docs/STRATEGY.md"]);
  git(clone2, ["commit", "-qm", "docs(strategy): other agent edit to shared line (j)"]);
  git(clone2, ["push", "-qu", "origin", "main"]);
  git(repoDir, ["fetch", "origin", "main"]);

  const resJ = run(["--repo", "dev-loop"], wsRoot);
  ok(resJ.status !== 0, `(j) genuine prose conflict → exits non-zero (got ${resJ.status})`);
  ok(/conflict|reconcile/i.test(resJ.stderr), `(j) BLOCKED message explains the conflict + manual reconcile (got: ${resJ.stderr.trim().slice(0, 200)})`);
  ok(!existsSync(join(repoDir, ".git", "rebase-merge")) && !existsSync(join(repoDir, ".git", "rebase-apply")),
    `(j) no .git/rebase-merge or rebase-apply left behind — the shared checkout is NOT wedged`);
  const branchJ = (() => { try { return git(repoDir, ["branch", "--show-current"]); } catch { return "(detached)"; } })();
  ok(branchJ === "main", `(j) checkout restored to 'main', not left detached mid-rebase (got: '${branchJ}')`);
  // a SECOND invocation must handle it cleanly too — not fail from an already-wedged state
  const resJ2 = run(["--repo", "dev-loop"], wsRoot);
  ok(!existsSync(join(repoDir, ".git", "rebase-merge")) && !existsSync(join(repoDir, ".git", "rebase-apply")),
    `(j) a second doc-land also leaves NO rebase state — not wedged from the first (LOOP-118 outage gone)`);
  ok(resJ2.status !== 0 && /conflict|reconcile/i.test(resJ2.stderr),
    `(j) the second run reports the same conflict from a CLEAN state, not "rebase failed" from a broken one`);
  git(repoDir, ["fetch", "origin", "main"]);
  git(repoDir, ["reset", "--hard", "origin/main"]);

  // ── (k) LOOP-217 AC1/AC2/AC3: unmerged index entry on a non-doc path → names the real blocker ──
  // State: both repoDir and origin at same commit (after j's cleanup).
  // Setup: local doc commit + origin moves ahead via clone2 (so behind>0 → preflight runs).
  {
    writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nProgress k (LOOP-217).\n");
    git(repoDir, ["add", "docs/STRATEGY.md"]);
    git(repoDir, ["commit", "-qm", "docs(strategy): progress k (LOOP-217)"]);

    // Advance origin via clone2 with a code commit (makes behind=1 in repoDir → preflight runs)
    git(clone2, ["fetch", "-q", "origin", "main"]);
    git(clone2, ["reset", "--hard", "origin/main"]);
    mkdirSync(join(clone2, "hub", "src"), { recursive: true });
    writeFileSync(join(clone2, "hub", "src", "code-k.ts"), "// code k\n");
    git(clone2, ["add", "hub/src/code-k.ts"]);
    git(clone2, ["commit", "-qm", "fix: code k (LOOP-217 test)"]);
    git(clone2, ["push", "-qu", "origin", "main"]);
    git(repoDir, ["fetch", "-q", "origin", "main"]);

    // Create an unmerged index entry for a non-doc path (simulates a prior failed merge/rebase)
    const mkBlob = (content: string): string =>
      spawnSync("git", ["-C", repoDir, "hash-object", "-w", "--stdin"],
        { input: content, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).stdout.trim();
    const blob1 = mkBlob("// base\n");
    const blob2 = mkBlob("// ours\n");
    const blob3 = mkBlob("// theirs\n");
    mkdirSync(join(repoDir, "hub", "src"), { recursive: true });
    spawnSync("git", ["-C", repoDir, "update-index", "--index-info"],
      { input: `100644 ${blob1} 1\thub/src/doctor.ts\n100644 ${blob2} 2\thub/src/doctor.ts\n100644 ${blob3} 3\thub/src/doctor.ts\n`,
        encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });

    const resK = run(["--repo", "dev-loop"], wsRoot);
    ok(resK.status !== 0, `(k) unmerged index entry → exits non-zero (LOOP-217)`);
    ok(/hub\/src\/doctor\.ts/.test(resK.stderr), `(k) names the unmerged non-doc path (LOOP-217)`);
    ok(!/prose merge|reconcile.*hand|must be reconciled/i.test(resK.stderr),
      `(k) does NOT blame a prose conflict on a non-doc unmerged path (LOOP-217)`);
  }
  git(repoDir, ["reset", "--hard", "origin/main"]);

  // ── (l) LOOP-217 AC6: dirty working tree (staged uncommitted changes) waits then blocks ──
  // Uses DEVLOOP_DOCLAND_DIRTY_TIMEOUT_MS=2000 so the test completes in ~2s, not 30s.
  {
    writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nProgress l (LOOP-217).\n");
    git(repoDir, ["add", "docs/STRATEGY.md"]);
    git(repoDir, ["commit", "-qm", "docs(strategy): progress l (LOOP-217)"]);

    // Advance origin via clone2 again (so behind=1 → preflight runs)
    git(clone2, ["fetch", "-q", "origin", "main"]);
    git(clone2, ["reset", "--hard", "origin/main"]);
    mkdirSync(join(clone2, "hub", "src"), { recursive: true });
    writeFileSync(join(clone2, "hub", "src", "code-l.ts"), "// code l\n");
    git(clone2, ["add", "hub/src/code-l.ts"]);
    git(clone2, ["commit", "-qm", "fix: code l (LOOP-217 test)"]);
    git(clone2, ["push", "-qu", "origin", "main"]);
    git(repoDir, ["fetch", "-q", "origin", "main"]);

    // Create staged (uncommitted) change on a non-doc path — won't self-clear, simulates a wedge
    mkdirSync(join(repoDir, "hub", "src"), { recursive: true });
    writeFileSync(join(repoDir, "hub", "src", "dirty-l.ts"), "// dirty\n");
    git(repoDir, ["add", "hub/src/dirty-l.ts"]);  // staged but not committed

    // LOOP-325 SUPERSEDES LOOP-217's dirty-tree BLOCK for this population. LOOP-217 was right that a
    // dirty tree must not be mislabelled as a prose conflict; it was wrong to make an unrelated path
    // block the land at all. PM's strategy-doc commit sat unlandable for two fires while the doc
    // itself was clean and the shared checkout cycled 7–9 unrelated dirty files — a tree that is
    // dirty by design is a wait that never ends.
    //
    // The rebase now happens in an ISOLATED WORKTREE, so the land completes and those edits survive.
    // LOOP-217 AC1 (unmerged index blocks immediately) is unchanged and asserted at (k).
    const dirtyBefore = readFileSync(join(repoDir, "hub", "src", "dirty-l.ts"), "utf8");
    const t0 = Date.now();
    const resL = run(["--repo", "dev-loop"], wsRoot, { DEVLOOP_DOCLAND_DIRTY_TIMEOUT_MS: "2000" });
    const elapsed = Date.now() - t0;
    ok(resL.status === 0, `(l) LOOP-325 AC1: an unrelated dirty path no longer blocks the land (status ${resL.status}: ${resL.stderr.slice(0, 160)})`);
    ok(elapsed < 2000, `(l) LOOP-325: …and it does not WAIT on a tree that is dirty by design (${elapsed}ms)`);
    ok(readFileSync(join(repoDir, "hub", "src", "dirty-l.ts"), "utf8") === dirtyBefore,
      "(l) LOOP-325 AC2: the unrelated modification survives BYTE-IDENTICAL — no stash, no checkout, no add");
    ok(git(repoDir, ["status", "--porcelain", "--untracked-files=no"]).includes("dirty-l.ts"),
      "(l) LOOP-325 AC2: …and is still uncommitted, exactly as the fire left it");
    ok(git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]) === "main",
      "(l) LOOP-325 AC3: the shared checkout is left on its normal branch, never detached");
    ok(!existsSync(join(repoDir, ".git", "rebase-merge")) && !existsSync(join(repoDir, ".git", "rebase-apply")),
      "(l) LOOP-325 AC3: …with no rebase in progress");
    ok(git(repoDir, ["rev-parse", "main"]) === git(repoDir, ["rev-parse", "origin/main"]),
      "(l) LOOP-325 AC3: …and local main is NOT diverged from origin/main after the land");
    ok(!git(repoDir, ["worktree", "list"]).includes("docland"),
      "(l) LOOP-325: the isolated worktree is removed — leaving one behind is the LOOP-132 defect");

    // AC4 — the DOC itself dirty must STILL refuse. That is an unlanded edit, and landing around it
    // would silently drop someone's work. Distinct message from the unmerged-index wedge (k).
    {
      // Start from a clean base: (l)'"'"'s assertions have all run, and its leftover code files would
      // otherwise trip Step 1'"'"'s docs-only path assertion before this check is ever reached.
      git(repoDir, ["reset", "--hard", "origin/main"]);
      const docAbs = join(repoDir, "docs", "STRATEGY.md");
      const before = readFileSync(docAbs, "utf8");
      // A LOCAL doc commit to land …
      writeFileSync(docAbs, before + "\ncommitted l2 edit\n");
      git(repoDir, ["add", "docs/STRATEGY.md"]);
      git(repoDir, ["commit", "-qm", "docs(strategy): l2 (LOOP-325 test)"]);
      // … and origin moving ahead, so the rebase preflight actually runs.
      git(clone2, ["fetch", "-q", "origin", "main"]);
      git(clone2, ["reset", "--hard", "origin/main"]);
      writeFileSync(join(clone2, "hub", "src", "code-l2.ts"), "// code l2\n");
      git(clone2, ["add", "hub/src/code-l2.ts"]);
      git(clone2, ["commit", "-qm", "fix: code l2 (LOOP-325 test)"]);
      git(clone2, ["push", "-qu", "origin", "main"]);
      git(repoDir, ["fetch", "-q", "origin", "main"]);
      // …then an UNCOMMITTED edit on top of the doc: the unlanded work AC4 protects.
      const committed = readFileSync(docAbs, "utf8");
      writeFileSync(docAbs, committed + "\nAN UNCOMMITTED DOC EDIT\n");
      const resDoc = run(["--repo", "dev-loop"], wsRoot, { DEVLOOP_DOCLAND_DIRTY_TIMEOUT_MS: "2000" });
      ok(resDoc.status !== 0, `(l2) LOOP-325 AC4: a dirty strategyDoc still REFUSES (status ${resDoc.status})`);
      ok(/unlanded doc edit|uncommitted changes/.test(resDoc.stderr),
        `(l2) LOOP-325 AC4: …naming it as an unlanded edit (${resDoc.stderr.slice(-180)})`);
      ok(!/unmerged index/.test(resDoc.stderr),
        "(l2) LOOP-325 AC4: …with a message DISTINCT from the LOOP-217 unmerged-index refusal");
      ok(readFileSync(docAbs, "utf8").includes("AN UNCOMMITTED DOC EDIT"),
        "(l2) LOOP-325 AC4: …and the edit is untouched — refusing must not discard it either");
      git(repoDir, ["checkout", "-q", "--", "docs/STRATEGY.md"]);
      git(repoDir, ["reset", "--hard", "origin/main"]);
    }
  }
  git(repoDir, ["reset", "--hard", "origin/main"]);

  // ── (j2) LOOP-217 AC2: genuine doc prose conflict still emits the prose-merge message ──
  // (Regression guard: the AC1/AC6 preflight must not suppress the genuine doc message.)
  // Reuses the conflict state already set up in (j) by re-running the same fixture.
  {
    // Reset both sides to a new shared baseline
    const j2Base = "# Strategy\n\nintro\nSHARED-BASE-j2\nouttro\n";
    writeFileSync(join(repoDir, "docs", "STRATEGY.md"), j2Base);
    git(repoDir, ["add", "docs/STRATEGY.md"]);
    git(repoDir, ["commit", "-qm", "docs(strategy): j2 baseline"]);
    git(repoDir, ["push", "-qu", "origin", "main"]);

    // Local diverges on the shared line
    writeFileSync(join(repoDir, "docs", "STRATEGY.md"), "# Strategy\n\nintro\nSHARED-BASE-j2-local\nouttro\n");
    git(repoDir, ["add", "docs/STRATEGY.md"]);
    git(repoDir, ["commit", "-qm", "docs(strategy): j2 local edit"]);

    // clone2 diverges on the same line and pushes first
    git(clone2, ["fetch", "-q", "origin", "main"]);
    git(clone2, ["reset", "--hard", "origin/main"]);
    writeFileSync(join(clone2, "docs", "STRATEGY.md"), "# Strategy\n\nintro\nSHARED-BASE-j2-remote\nouttro\n");
    git(clone2, ["add", "docs/STRATEGY.md"]);
    git(clone2, ["commit", "-qm", "docs(strategy): j2 remote edit"]);
    git(clone2, ["push", "-qu", "origin", "main"]);
    git(repoDir, ["fetch", "origin", "main"]);

    const resJ2 = run(["--repo", "dev-loop"], wsRoot);
    ok(resJ2.status !== 0, `(j2) genuine doc conflict → exits non-zero (LOOP-217 AC2/AC4 guard)`);
    ok(/conflict|reconcile/i.test(resJ2.stderr),
      `(j2) genuine doc conflict still emits prose-merge wording (AC2 guard — LOOP-217)`);
  }
  git(repoDir, ["fetch", "origin", "main"]);
  git(repoDir, ["reset", "--hard", "origin/main"]);

  // ── (i) LOOP-119 Fix 2: a non-'main' defaultBranch (trunk) resolves via effectiveRepo + lands ──
  //   proves the hardcoded "main" is gone — doc-land reads repo.defaultBranch (§19 fallback chain).
  {
    const originT = join(ROOT, "origin-trunk.git");
    const wsT = join(ROOT, "ws-trunk");
    const repoT = join(wsT, "dev-loop");
    mkdirSync(originT, { recursive: true });
    mkdirSync(wsT, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "trunk", originT]);
    execFileSync("git", ["clone", "-q", originT, repoT]);
    git(repoT, ["commit", "--allow-empty", "-qm", "baseline"]);
    git(repoT, ["push", "-qu", "origin", "trunk"]);
    writeFileSync(join(wsT, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, workspaceId: "test-doc-land-trunk",
      team: { key: "test", backend: "service", mode: "live", autonomy: "ask", git: { defaultBranch: "trunk" } },
      repos: { "dev-loop": { path: "dev-loop", remote: originT, landing: "pr" } },
      projects: { test: { repos: [{ ref: "dev-loop" }], strategyDoc: { path: "docs/STRATEGY.md" } } },
    }, null, 2));
    mkdirSync(join(wsT, ".dev-loop", "locks"), { recursive: true });
    // push-guard opens the hub DB; create it (empty) so its ticket query has a schema to read.
    const dbT = openDb(join(wsT, ".dev-loop", "hub.db"));
    dbT.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','test','Test','t')").run();
    dbT.close();
    mkdirSync(join(repoT, "docs"), { recursive: true });
    writeFileSync(join(repoT, "docs", "STRATEGY.md"), "# Strategy (trunk)\n\nprogress on a non-main default branch\n");
    git(repoT, ["add", "docs/STRATEGY.md"]);
    git(repoT, ["commit", "-qm", "docs(strategy): progress on trunk (i)"]);
    const beforeI = git(repoT, ["rev-parse", "HEAD"]);

    const resI = run(["--repo", "dev-loop"], wsT);
    ok(resI.status === 0, `(i) non-main defaultBranch (trunk) → lands (exit 0; stderr: ${resI.stderr.trim().slice(0, 160)})`);
    ok(git(repoT, ["rev-parse", "origin/trunk"]) === beforeI, `(i) origin/trunk has the commit — defaultBranch honoured, no hardcoded 'main'`);
  }

  // ── LOOP-326: the dirty-tree refusal must name paths that EXIST ─────────────────────────────
  // Reproduced against real `git status --porcelain` output, then asserted through the parser the
  // refusal message is built from. The defect was conditional on the FIRST entry being
  // unstaged-only (` M`), which is why the fixture stages the second file and not the first.
  {
    const lp = join(ROOT, "loop326");
    mkdirSync(lp, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", lp]);
    writeFileSync(join(lp, "a-first.txt"), "one\n");
    writeFileSync(join(lp, "b-second.txt"), "two\n");
    git(lp, ["add", "-A"]);
    git(lp, ["commit", "-qm", "base"]);
    writeFileSync(join(lp, "a-first.txt"), "one changed\n");   // ` M` — unstaged only, sorts FIRST
    writeFileSync(join(lp, "b-second.txt"), "two changed\n");
    git(lp, ["add", "b-second.txt"]);                          // `M ` — staged

    const porcelain = execFileSync("git", ["-C", lp, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
    ok(/^ M a-first\.txt/m.test(porcelain), "LOOP-326 fixture: the first porcelain entry really is unstaged-only (' M')");

    const parsed = parseDirtyPaths(porcelain);
    ok(parsed.includes("a-first.txt"), `LOOP-326: the FIRST path survives intact (got ${JSON.stringify(parsed)})`);
    ok(!parsed.some((p) => p === "-first.txt" || p === "a-first.tx"), "LOOP-326: no character is eaten off the first entry");
    ok(parsed.every((p) => existsSync(join(lp, p))), `LOOP-326: every path the refusal would name EXISTS on disk (${JSON.stringify(parsed)})`);

    // The trimmed-buffer shape the bug produced, asserted directly so a future refactor that
    // reintroduces a buffer-level trim() fails here rather than in a rebase refusal months later.
    ok(!parseDirtyPaths(porcelain.trim()).includes("a-first.txt") || porcelain[0] !== " ",
      "LOOP-326: a buffer-level trim() is exactly what breaks it — the parser must receive raw output");
  }

  // ══ LOOP-369: the shared checkout's HEAD is NOT the branch being landed ═══════════════════════
  // Every fixture above holds the checkout on `main`, so `HEAD == <defaultBranch>` is the one
  // variable this suite held constant — and the only one that mattered. isolatedRebase() built its
  // worktree from HEAD while every check around it read origin/main...main, so with the checkout on
  // a feature branch the verb rebased THAT branch and wrote the result over refs/heads/main,
  // destroying the doc commit it was invoked to land, then reported "landed".
  {
    const o3 = join(ROOT, "origin3.git");
    const ws3 = join(ROOT, "ws3");
    const r3 = join(ws3, "dev-loop");
    mkdirSync(o3, { recursive: true });
    mkdirSync(ws3, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", o3]);
    execFileSync("git", ["clone", "-q", o3, r3]);
    writeFileSync(join(ws3, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: "test-doc-land-369",
      team: { key: "test", backend: "service", mode: "live", autonomy: "ask" },
      repos: { "dev-loop": { path: "dev-loop", remote: o3, landing: "pr" } },
      projects: { test: { repos: [{ ref: "dev-loop" }], strategyDoc: { path: STRATEGY_PATH } } },
    }, null, 2));
    mkdirSync(join(ws3, ".dev-loop", "locks"), { recursive: true });
    openDb(join(ws3, ".dev-loop", "hub.db")).close();

    mkdirSync(join(r3, "docs"), { recursive: true });
    writeFileSync(join(r3, "docs", "STRATEGY.md"), "# Strategy\n\nbase\n");
    git(r3, ["add", "docs/STRATEGY.md"]);
    git(r3, ["commit", "-qm", "docs(strategy): base"]);
    git(r3, ["push", "-qu", "origin", "main"]);

    // main gains the doc commit that must land …
    writeFileSync(join(r3, "docs", "STRATEGY.md"), "# Strategy\n\nbase\n\nPM's fire-53 journal entry.\n");
    git(r3, ["add", "docs/STRATEGY.md"]);
    git(r3, ["commit", "-qm", "docs(strategy): fire 53 journal (LOOP-369 fixture)"]);
    const mainDocSubject = "docs(strategy): fire 53 journal (LOOP-369 fixture)";

    // … origin advances underneath, so the rebase path is actually taken …
    const c3 = join(ROOT, "clone3");
    execFileSync("git", ["clone", "-q", o3, c3]);
    mkdirSync(join(c3, "docs", "strategy-archive"), { recursive: true });
    writeFileSync(join(c3, "docs", "strategy-archive", "2026-08.md"), "# archive\n");
    git(c3, ["add", "docs/strategy-archive/2026-08.md"]);
    git(c3, ["commit", "-qm", "docs(strategy): another agent's archive"]);
    git(c3, ["push", "-q", "origin", "main"]);

    // … and the shared checkout sits on a FEATURE branch, exactly as a dev fire leaves it.
    // Cut from origin/main, NOT from main: the feature branch must NOT contain the doc commit, or
    // rebasing HEAD would happen to carry it along and the clobber would be survivable. In the real
    // incident the branch was `dev-loop/LOOP-367-…`, cut earlier, and rebasing it produced a tree
    // with no trace of `915496c` — which is what `update-ref` then wrote over refs/heads/main.
    git(r3, ["fetch", "-q", "origin", "main"]);
    git(r3, ["checkout", "-q", "-b", "dev-loop/LOOP-999", "origin/main"]);
    writeFileSync(join(r3, "feature.ts"), "// a dev fire's work\n");
    git(r3, ["add", "feature.ts"]);
    git(r3, ["commit", "-qm", "feat: unrelated dev work (LOOP-999)"]);
    const featureSha = git(r3, ["rev-parse", "HEAD"]);

    const res369 = run(["--repo", "dev-loop"], ws3);

    ok(res369.status === 0,
      `(369-a) AC1: the land succeeds with the checkout on a feature branch (status ${res369.status}: ${res369.stderr.slice(0, 200)})`);
    ok(pathOnRef(r3, "origin/main", "docs/STRATEGY.md")
      && git(r3, ["show", "origin/main:docs/STRATEGY.md"]).includes("fire-53 journal"),
      "(369-a) AC1: the doc commit actually REACHED origin/main — the content is there, not merely a clean exit");
    ok(git(r3, ["log", "origin/main", "--format=%s"]).split("\n").includes(mainDocSubject),
      "(369-a) AC2: main's pre-existing commit SURVIVES, reachable from origin/main — it was the clobber's victim");
    ok(git(r3, ["rev-parse", "HEAD"]) === featureSha,
      "(369-a) AC1: the feature branch is UNMOVED — the verb rebased the ref, not the checkout's HEAD");
    ok(git(r3, ["rev-parse", "--abbrev-ref", "HEAD"]) === "dev-loop/LOOP-999",
      "(369-a) AC1: …and the shared checkout is still on it (LOOP-325's property holds)");
    ok(/landed 1 commit\(s\) to origin\/main/.test(res369.stdout),
      `(369-a) AC5: the success line states WHAT WAS PUSHED, not that the range ended up empty (got: ${res369.stdout.trim().slice(0, 200)})`);
    ok(!/is up to date/.test(res369.stdout),
      "(369-a) AC5: …and never the old post-state phrasing, which the clobber satisfied by destroying the work");
    ok(!git(r3, ["worktree", "list"]).includes("docland"),
      "(369-a) the isolated worktree is removed (LOOP-132)");

    // ── AC2: a rebase that would DROP a commit must refuse and leave the ref untouched ──────────
    // Constructed without an injected fault: main's commit adds an archive file whose exact content
    // arrives upstream inside a DIFFERENT commit. The rebase empties it, but `git cherry` cannot
    // mark it patch-equivalent (the upstream patch is not the same patch), so it is a genuine
    // "went missing" as far as the verb can tell — and the honest answer is to refuse and name it.
    {
      git(r3, ["checkout", "-q", "main"]);
      git(r3, ["reset", "--hard", "-q", "origin/main"]);
      mkdirSync(join(r3, "docs", "strategy-archive"), { recursive: true });
      writeFileSync(join(r3, "docs", "strategy-archive", "2026-09.md"), "# september\n");
      git(r3, ["add", "docs/strategy-archive/2026-09.md"]);
      git(r3, ["commit", "-qm", "docs(strategy): september archive"]);

      // the SAME content upstream, carried by a different (larger) commit ⇒ different patch-id
      git(c3, ["fetch", "-q", "origin", "main"]);
      git(c3, ["reset", "--hard", "-q", "origin/main"]);
      writeFileSync(join(c3, "docs", "strategy-archive", "2026-09.md"), "# september\n");
      writeFileSync(join(c3, "docs", "strategy-archive", "2026-10.md"), "# october\n");
      git(c3, ["add", "docs/strategy-archive"]);
      git(c3, ["commit", "-qm", "docs(strategy): september + october archives"]);
      git(c3, ["push", "-q", "origin", "main"]);

      git(r3, ["checkout", "-q", "dev-loop/LOOP-999"]);   // back on the feature branch
      const mainBefore = git(r3, ["rev-parse", "refs/heads/main"]);
      const res2 = run(["--repo", "dev-loop"], ws3);

      ok(res2.status !== 0,
        `(369-b) AC2: a rebase that would drop a commit REFUSES (status ${res2.status})`);
      ok(git(r3, ["rev-parse", "refs/heads/main"]) === mainBefore,
        "(369-b) AC2: refs/heads/main is left EXACTLY as it was — the ref never moved");
      ok(/september archive/.test(res2.stderr),
        `(369-b) AC2: the refusal NAMES the commit that would have gone missing (got: ${res2.stderr.slice(0, 300)})`);
      ok(/drop|missing/i.test(res2.stderr) && !/already upstream/.test(res2.stderr),
        "(369-b) AC4: the refusal is distinguishable from the already-upstream case, which is not an error");
      ok(!/landed/.test(res2.stdout),
        "(369-b) AC5: a run that pushed nothing prints no success line");
    }

    // ── AC3: a writer that moves the branch between the read and the write must lose the race ──
    // Simulated with a real `post-checkout` hook rather than a wall-clock race: `git worktree add`
    // fires it, so the branch genuinely moves after isolatedRebase() has read its value and before
    // it writes one back — exactly the window the compare-and-swap exists to close.
    {
      git(r3, ["checkout", "-q", "main"]);
      git(r3, ["reset", "--hard", "-q", "origin/main"]);
      writeFileSync(join(r3, "docs", "strategy-archive", "2026-12.md"), "# december\n");
      git(r3, ["add", "docs/strategy-archive/2026-12.md"]);
      git(r3, ["commit", "-qm", "docs(strategy): december archive"]);

      git(c3, ["fetch", "-q", "origin", "main"]);
      git(c3, ["reset", "--hard", "-q", "origin/main"]);
      writeFileSync(join(c3, "docs", "STRATEGY.md"), "# Strategy\n\nbase\n\nmoved on\n");
      git(c3, ["add", "docs/STRATEGY.md"]);
      git(c3, ["commit", "-qm", "docs(strategy): origin moves so the rebase path is taken"]);
      git(c3, ["push", "-q", "origin", "main"]);

      git(r3, ["checkout", "-q", "dev-loop/LOOP-999"]);
      // the interloper: one commit appended to refs/heads/main from OUTSIDE this verb
      const interloper = git(r3, ["commit-tree", `${git(r3, ["rev-parse", "refs/heads/main^{tree}"])}`,
        "-p", git(r3, ["rev-parse", "refs/heads/main"]), "-m", "docs(strategy): a concurrent writer's commit"]);
      const hookDir = join(r3, ".git", "hooks");
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(join(hookDir, "post-checkout"),
        `#!/bin/sh\ngit --git-dir="${join(r3, ".git")}" update-ref refs/heads/main ${interloper}\nrm -f "${join(hookDir, "post-checkout")}"\nexit 0\n`);
      execFileSync("chmod", ["+x", join(hookDir, "post-checkout")]);

      const res4 = run(["--repo", "dev-loop"], ws3);
      ok(res4.status !== 0,
        `(369-d) AC3: a branch that moved under us makes the ref write REFUSE (status ${res4.status})`);
      ok(git(r3, ["rev-parse", "refs/heads/main"]) === interloper,
        "(369-d) AC3: the concurrent writer's commit SURVIVES — a lost update is what the CAS prevents");
      ok(/moved underneath us|re-run/.test(res4.stderr),
        `(369-d) AC3: …and the refusal explains the race rather than reporting a land (got: ${res4.stderr.replace(/\(node:.*/g, "").slice(0, 240)})`);
      ok(!/landed \d+ commit/.test(res4.stdout),
        "(369-d) AC3/AC5: a lost race never prints a success line");
      rmSync(join(hookDir, "post-checkout"), { force: true });
    }

    // ── AC4: a genuinely patch-equivalent commit reports THAT, and is not a land ────────────────
    {
      git(r3, ["checkout", "-q", "main"]);
      git(r3, ["reset", "--hard", "-q", "origin/main"]);
      writeFileSync(join(r3, "docs", "strategy-archive", "2026-11.md"), "# november\n");
      git(r3, ["add", "docs/strategy-archive/2026-11.md"]);
      git(r3, ["commit", "-qm", "docs(strategy): november archive"]);


      // the identical patch lands upstream on its own ⇒ git cherry marks it '-'
      git(c3, ["fetch", "-q", "origin", "main"]);
      git(c3, ["reset", "--hard", "-q", "origin/main"]);
      writeFileSync(join(c3, "docs", "strategy-archive", "2026-11.md"), "# november\n");
      git(c3, ["add", "docs/strategy-archive/2026-11.md"]);
      git(c3, ["commit", "-qm", "docs(strategy): november archive (landed by another agent)"]);
      git(c3, ["push", "-q", "origin", "main"]);

      git(r3, ["checkout", "-q", "dev-loop/LOOP-999"]);
      const res3 = run(["--repo", "dev-loop"], ws3);

      ok(res3.status === 0,
        `(369-c) AC4: an already-upstream commit is not an error (status ${res3.status}: ${res3.stderr.slice(0, 200)})`);
      ok(/already upstream/.test(res3.stdout),
        `(369-c) AC4: …it says so in its own words (got: ${res3.stdout.trim().slice(0, 200)})`);
      ok(!/landed \d+ commit/.test(res3.stdout),
        "(369-c) AC4/AC5: …and does NOT claim to have landed anything");
    }
  }

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "doc-land: all checks passed");
process.exit(fails ? 1 : 0);
