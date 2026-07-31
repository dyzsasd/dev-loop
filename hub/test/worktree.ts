// LOOP-54 regression: dev-loop worktree add <id> must base the new branch on origin/<defaultBranch>,
// never on local HEAD. A branch cut off a local main that is ahead of origin carries the operator's
// unpushed doc commits as passengers in every dev PR (LOOP-48 / PR #28 field incident).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

const ROOT = mkdtempSync(join(tmpdir(), "dl-worktree-"));
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

} finally {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}

if (fails > 0) { console.error(`\n${fails} test(s) failed`); process.exit(1); }
console.log("\nAll worktree tests passed ✓");
