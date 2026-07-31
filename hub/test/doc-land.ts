// LOOP-57 regression: dev-loop doc-land must land PM's doc-only progress commits to
// origin/<defaultBranch> ff-only, refuse on non-doc paths, rebase when diverged, and
// downgrade push-guard reference findings (Canceled/Duplicate refs in prose) to WARN
// while hard-stopping on actual non-doc content. Bare-origin + clone harness (§15).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";

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
    env: { ...process.env, ...extra },
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

} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "doc-land: all checks passed");
process.exit(fails ? 1 : 0);
