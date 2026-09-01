// LOOP-54 regression: dev-loop worktree add <id> must base the new branch on origin/<defaultBranch>,
// never on local HEAD. A branch cut off a local main that is ahead of origin carries the operator's
// unpushed doc commits as passengers in every dev PR (LOOP-48 / PR #28 field incident).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// Run the worktree CLI from a given cwd (so resolveWorkspace() finds the right dev-loop.json)
const run = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [join(hubRoot, "src", "worktree.ts"), ...args], {
    encoding: "utf8",
    cwd,
  });

const git = (dir: string, args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const ROOT = tmpRoot("dl-worktree-");
try {
  // ── Setup: bare origin + clone where local main is AHEAD of origin ───────────────
  const origin = join(ROOT, "origin.git");
  const wsRoot = join(ROOT, "ws");
  const cloneDir = join(wsRoot, "dev-loop");
  mkdirSync(origin, { recursive: true });
  mkdirSync(wsRoot, { recursive: true });

  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, cloneDir]);
  git(cloneDir, ["commit", "--allow-empty", "-qm", "baseline"]);
  git(cloneDir, ["push", "-qu", "origin", "main"]);

  // One LOCAL-ONLY commit — simulates operator's unpushed strategy/doc commit
  git(cloneDir, ["commit", "--allow-empty", "-qm", "docs(strategy): local-only PM commit"]);
  const localOnlySha = git(cloneDir, ["rev-parse", "HEAD"]);

  // Minimal dev-loop.json so resolveWorkspace() succeeds
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-workspace",
    team: { key: "test", backend: "service", mode: "live", autonomy: "ask" },
    repos: { "dev-loop": { path: "dev-loop", remote: origin, landing: "pr" } },
    projects: { test: { repos: [{ ref: "dev-loop" }] } },
  }, null, 2));
  mkdirSync(join(wsRoot, ".dev-loop", "locks"), { recursive: true });

  // ── AC1: worktree add exits 0 and prints the expected path ──────────────────────
  const id = "LOOP-TEST1";
  // wsWorktree() uses ws.root from resolveWorkspace() which canonicalizes via realpathSync.
  // On macOS /var is a symlink to /private/var, so we must canonicalize to match.
  const canonWsRoot = realpathSync(wsRoot);
  const expectedPath = join(canonWsRoot, ".dev-loop", "wt", id, "dev-loop");
  const result = run(["add", id, "--repo", "dev-loop"], wsRoot);
  ok(result.status === 0, `worktree add exits 0 (stderr: ${result.stderr.trim()})`);
  const printedPath = result.stdout.trim();
  ok(printedPath === expectedPath, `printed path matches wsWorktree() formula (got '${printedPath}')`);

  // ── AC2: the created branch contains NONE of the local-only commits ──────────────
  const ahead = git(cloneDir, ["log", "--oneline", `origin/main..dev-loop/${id}`]);
  ok(ahead === "", `no passenger commits: origin/main..dev-loop/${id} is empty`);

  const branchInWorktree = git(printedPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  ok(branchInWorktree === `dev-loop/${id}`, `branch name in worktree is dev-loop/${id}`);

  const contained = spawnSync("git", ["-C", cloneDir, "branch", "--contains", localOnlySha], { encoding: "utf8" });
  const branchList = (contained.stdout ?? "").split("\n").map((l) => l.trim().replace(/^\* /, "")).filter(Boolean);
  ok(!branchList.includes(`dev-loop/${id}`), "local-only commit is NOT in dev-loop/<id>");

  // ── Demonstrate the LOOP-48 bug: hand-built worktree off local HEAD carries the passenger ──
  const manualPath = join(ROOT, "manual-worktree");
  git(cloneDir, ["worktree", "add", "-b", "dev-loop/MANUAL", manualPath, "HEAD"]);
  const manualAhead = git(cloneDir, ["log", "--oneline", `origin/main..dev-loop/MANUAL`]);
  ok(manualAhead !== "", "a hand-built branch off local HEAD DOES carry the local-only commit (LOOP-48 bug shape)");
  git(cloneDir, ["worktree", "remove", "--force", manualPath]);
  git(cloneDir, ["branch", "-D", "dev-loop/MANUAL"]);

  // ── AC3: idempotent — second run with same id exits 0 and prints the same path ──
  const r2 = run(["add", id, "--repo", "dev-loop"], wsRoot);
  ok(r2.status === 0, "second run (idempotent) exits 0");
  ok(r2.stdout.trim() === printedPath, "second run prints the same path");

  // ── AC4: same-path/different-base → refuses ──────────────────────────────────────
  // Manufacture the scenario: create a worktree at expectedPath on a DIFFERENT branch
  // so the idempotency check sees a mismatch. We first remove the existing LOOP-TEST1 worktree,
  // then add a new one on a branch with a different name at the same path.
  git(cloneDir, ["worktree", "remove", "--force", printedPath]);
  git(cloneDir, ["branch", "-D", `dev-loop/${id}`]);
  // Now add a worktree on a DIFFERENT branch at the same path
  git(cloneDir, ["worktree", "add", "-b", "dev-loop/OTHER", printedPath, "origin/main"]);
  const rConflict = run(["add", id, "--repo", "dev-loop"], wsRoot);
  ok(rConflict.status === 1, "same-path/different-branch → exit 1 (refuses to re-point)");
  ok(/refusing to re-point/.test(rConflict.stderr), "refuses with a clear message");
  // Cleanup
  git(cloneDir, ["worktree", "remove", "--force", printedPath]);
  git(cloneDir, ["branch", "-D", "dev-loop/OTHER"]);

  // ── AC3: master-default repo — worktree add bases on origin/master, not origin/main ──
  {
    const masterOrigin = join(ROOT, "master-origin.git");
    const masterWsRoot = join(ROOT, "master-ws");
    const masterCloneDir = join(masterWsRoot, "dev-loop");
    mkdirSync(masterOrigin, { recursive: true });
    mkdirSync(masterWsRoot, { recursive: true });

    execFileSync("git", ["init", "--bare", "-q", "-b", "master", masterOrigin]);
    execFileSync("git", ["clone", "-q", masterOrigin, masterCloneDir]);
    git(masterCloneDir, ["commit", "--allow-empty", "-qm", "initial on master"]);
    git(masterCloneDir, ["push", "-qu", "origin", "master"]);

    writeFileSync(join(masterWsRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: "master-ws",
      team: { key: "testm", backend: "service", mode: "live", autonomy: "ask" },
      repos: { "dev-loop": { path: "dev-loop", remote: masterOrigin, landing: "pr", defaultBranch: "master" } },
      projects: { testm: { repos: [{ ref: "dev-loop" }] } },
    }, null, 2));
    mkdirSync(join(masterWsRoot, ".dev-loop", "locks"), { recursive: true });

    const masterId = "LOOP-MASTER1";
    const masterResult = run(["add", masterId, "--repo", "dev-loop"], masterWsRoot);
    ok(masterResult.status === 0, `AC3: master-default worktree add exits 0 (stderr: ${masterResult.stderr.trim()})`);

    const masterAhead = git(masterCloneDir, ["log", "--oneline", `origin/master..dev-loop/${masterId}`]);
    ok(masterAhead === "", `AC3: no passenger commits on master-default repo (origin/master..dev-loop/${masterId} empty)`);

    const masterBranchExists = git(masterCloneDir, ["branch", "--list", `dev-loop/${masterId}`]);
    ok(masterBranchExists.trim() !== "", `AC3: dev-loop/${masterId} branch exists on master-default repo`);

    const masterMasterExists = git(masterCloneDir, ["rev-parse", "--verify", "--quiet", "origin/master"]).trim();
    ok(masterMasterExists !== "", "AC3: origin/master resolves — worktree based on real origin branch");

    // Existing main-default tests still pass (backward compat AC7 — verified implicitly by the main test block above)
  }

  // ── AC5: no remote configured → bases on local defaultBranch, says so ────────────
  const wsNoRemote = join(ROOT, "ws-no-remote");
  const cloneNoRemote = join(wsNoRemote, "dev-loop");
  mkdirSync(cloneNoRemote, { recursive: true });
  execFileSync("git", ["clone", "-q", "--local", cloneDir, cloneNoRemote]);
  git(cloneNoRemote, ["remote", "remove", "origin"]);
  writeFileSync(join(wsNoRemote, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "no-remote-ws",
    team: { key: "test2", backend: "service", mode: "live", autonomy: "ask" },
    repos: { "dev-loop": { path: "dev-loop" } },
    projects: { test2: { repos: [{ ref: "dev-loop" }] } },
  }, null, 2));
  mkdirSync(join(wsNoRemote, ".dev-loop", "locks"), { recursive: true });

  const rNoRemote = run(["add", "LOOP-NOREMOTE", "--repo", "dev-loop"], wsNoRemote);
  ok(rNoRemote.status === 0, "no-remote: exits 0 (falls back to local branch)");
  ok(/no remote/.test(rNoRemote.stderr), "no-remote: stderr mentions 'no remote'");

  // ── D4: `worktree reap` in a repository with NO REMOTE ──────────────────────────
  // `worktree add` has always had a no-remote fallback to the local default branch (AC5 above); reap
  // did not. It judged merged-ness against `origin/<defaultBranch>` and recoverability against
  // `refs/remotes/origin/<branch>`, neither of which can resolve without a remote — so every branch
  // read as the only copy and was kept forever, and worktrees accumulated without bound. That is the
  // exact shape of a `landing: "direct"` workspace with no remote.
  const NOW = "2026-08-01T00:00:00.000Z";
  /** A service workspace with a hub.db carrying the given <id, state> ticket rows. */
  const seedBoard = (wsDir: string, key: string, prefix: string, rows: Array<[string, string]>) => {
    const db = openDb(join(realpathSync(wsDir), ".dev-loop", "hub.db"));
    ensureSeed(db, key, key, prefix);
    const pid = findProject(db, key)!;
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const [id, state] of rows) ins.run(id, pid, id, "", "Feature", state, 2, "[]", "[]", "dev", NOW, NOW, null);
    db.close();
  };
  const branchExists = (dir: string, branch: string) => git(dir, ["branch", "--list", branch]).trim() !== "";

  {
    // A repository with no remote at all — `git init`, never cloned, landing:"direct".
    const lws = join(ROOT, "ws-reap-local");
    const lrepo = join(lws, "repo");
    mkdirSync(lrepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", lrepo]);
    git(lrepo, ["commit", "--allow-empty", "-qm", "baseline"]);
    writeFileSync(join(lws, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: "reap-local-ws",
      team: { key: "reaplocal", backend: "service", mode: "live", autonomy: "ask" },
      repos: { repo: { path: "repo", landing: "direct" } },   // NO remote field
      projects: { reaplocal: { repos: [{ ref: "repo" }] } },
    }, null, 2));
    mkdirSync(join(lws, ".dev-loop", "locks"), { recursive: true });
    seedBoard(lws, "reaplocal", "RL", [["RL-1", "Done"], ["RL-2", "Canceled"]]);

    // RL-1: terminal, and its work is merged into the LOCAL default branch ⇒ recoverable.
    const wtMerged = run(["add", "RL-1", "--repo", "repo"], lws).stdout.trim();
    git(wtMerged, ["commit", "--allow-empty", "-qm", "work for RL-1"]);
    git(lrepo, ["merge", "--no-ff", "-q", "-m", "merge RL-1", "dev-loop/RL-1"]);
    // RL-2: terminal, but its commit exists nowhere else ⇒ the only copy, must be KEPT.
    const wtUnmerged = run(["add", "RL-2", "--repo", "repo"], lws).stdout.trim();
    git(wtUnmerged, ["commit", "--allow-empty", "-qm", "work for RL-2"]);

    // A ticket can hold one worktree per repo, so reaping one ref must not remove a parent that still
    // has siblings. Planting an entry beside RL-2's ref reproduces that shape without a second repo.
    mkdirSync(join(lws, ".dev-loop", "wt", "RL-2", "other-repo"), { recursive: true });

    const reap = run(["reap", "--repo", "repo"], lws);
    const out = `${reap.stdout}${reap.stderr}`;
    ok(reap.status === 0, `D4: reap on a no-remote repo exits 0 (out: ${out.trim()})`);
    ok(/removed worktree '[^']*RL-1[^']*'/.test(out) && !branchExists(lrepo, "dev-loop/RL-1"),
      `D4: no remote + terminal + merged into LOCAL main ⇒ the worktree is removed and the branch deleted (out: ${out.trim()})`);
    ok(/kept branch 'dev-loop\/RL-2'/.test(out) && branchExists(lrepo, "dev-loop/RL-2"),
      `D4: no remote + terminal but NOT merged ⇒ the branch is kept, its only copy is local (out: ${out.trim()})`);
    ok(/UNRECOVERABLE/.test(out) && /not merged into main/.test(out),
      `D4: the kept-branch reason names the base it was compared against (out: ${out.trim()})`);
    // The worktree path is <state>/wt/<ticket>/<ref>: removing the leaf used to leave the per-ticket
    // parent behind, one empty directory per reaped ticket, forever (10 in one workspace inside a day).
    // The KEPT ticket's parent must survive — its worktree is still there and still holds the only copy.
    ok(!existsSync(join(lws, ".dev-loop", "wt", "RL-1")),
      "D4: the reaped ticket's now-empty wt/<ticket> parent is removed, not left as litter");
    ok(existsSync(join(lws, ".dev-loop", "wt", "RL-2", "other-repo")),
      "D4: …while a ticket dir that still holds a sibling ref is left alone — the removal is empty-only");
  }

  {
    // The control: WITH a remote, reap's judgement is unchanged — merged into origin/main is
    // recoverable, a branch that exists only locally is not.
    const rOrigin = join(ROOT, "reap-origin.git");
    const rws = join(ROOT, "ws-reap-remote");
    const rrepo = join(rws, "repo");
    mkdirSync(rOrigin, { recursive: true });
    mkdirSync(rws, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", rOrigin]);
    execFileSync("git", ["clone", "-q", rOrigin, rrepo]);
    git(rrepo, ["commit", "--allow-empty", "-qm", "baseline"]);
    git(rrepo, ["push", "-qu", "origin", "main"]);
    writeFileSync(join(rws, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: "reap-remote-ws",
      team: { key: "reapremote", backend: "service", mode: "live", autonomy: "ask" },
      repos: { repo: { path: "repo", remote: rOrigin, landing: "pr" } },
      projects: { reapremote: { repos: [{ ref: "repo" }] } },
    }, null, 2));
    mkdirSync(join(rws, ".dev-loop", "locks"), { recursive: true });
    seedBoard(rws, "reapremote", "RR", [["RR-1", "Done"], ["RR-2", "Canceled"]]);

    const wtR1 = run(["add", "RR-1", "--repo", "repo"], rws).stdout.trim();
    git(wtR1, ["commit", "--allow-empty", "-qm", "work for RR-1"]);
    git(rrepo, ["merge", "--no-ff", "-q", "-m", "merge RR-1", "dev-loop/RR-1"]);
    git(rrepo, ["push", "-q", "origin", "main"]);
    const wtR2 = run(["add", "RR-2", "--repo", "repo"], rws).stdout.trim();
    git(wtR2, ["commit", "--allow-empty", "-qm", "work for RR-2"]);

    const reap = run(["reap", "--repo", "repo"], rws);
    const out = `${reap.stdout}${reap.stderr}`;
    ok(reap.status === 0, `D4 control: reap on a repo WITH a remote exits 0 (out: ${out.trim()})`);
    ok(!branchExists(rrepo, "dev-loop/RR-1"),
      `D4 control: merged into origin/main ⇒ still reaped (out: ${out.trim()})`);
    // The registry's `remote` field is not the predicate. push-guard states why where it asks git for the
    // same fact: the registry can be stale in either direction. Both worktree verbs read the field, so a
    // workspace whose registry claims a remote the repo does not have measured every terminal branch
    // against an `origin/<base>` that cannot resolve — isMergedIntoBase was always false and reap kept
    // every branch it exists to remove. Here the field says `origin` and the repo has none.
    {
      const sws = tmpRoot("dl-wt-staleremote-");
      const srepo = join(sws, "repo");
      mkdirSync(srepo, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main", srepo]);
      git(srepo, ["commit", "--allow-empty", "-qm", "baseline"]);
      writeFileSync(join(sws, "dev-loop.json"), JSON.stringify({
        schemaVersion: 2,
        workspaceId: "stale-remote-ws",
        team: { key: "staleremote", backend: "service", mode: "live", autonomy: "ask" },
        repos: { repo: { path: "repo", remote: "origin", landing: "pr" } },   // …and the repo has no origin
        projects: { staleremote: { repos: [{ ref: "repo" }] } },
      }, null, 2));
      mkdirSync(join(sws, ".dev-loop", "locks"), { recursive: true });
      seedBoard(sws, "staleremote", "SR", [["SR-1", "Done"]]);
      const wtS1 = run(["add", "SR-1", "--repo", "repo"], sws).stdout.trim();
      git(wtS1, ["commit", "--allow-empty", "-qm", "work for SR-1"]);
      git(srepo, ["merge", "--no-ff", "-q", "-m", "merge SR-1", "dev-loop/SR-1"]);
      const sreap = run(["reap", "--repo", "repo"], sws);
      const sout = `${sreap.stdout}${sreap.stderr}`;
      ok(!branchExists(srepo, "dev-loop/SR-1"),
        `a stale registry remote does not make a merged terminal branch UNRECOVERABLE — the repo is asked, not the field (out: ${sout.trim()})`);
      ok(!/UNRECOVERABLE/.test(sout), `…and reap does not claim the only copy is local when it is merged into the local base (out: ${sout.trim()})`);
    }

    ok(/kept branch 'dev-loop\/RR-2'/.test(out) && branchExists(rrepo, "dev-loop/RR-2"),
      `D4 control: neither merged nor pushed ⇒ still kept (out: ${out.trim()})`);
  }

} finally {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}

if (fails > 0) { console.error(`\n${fails} test(s) failed`); process.exit(1); }
console.log("\nAll worktree tests passed ✓");
