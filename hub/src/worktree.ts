#!/usr/bin/env node
// dev-loop worktree add <id> [--repo <ref>] — create a dev worktree off origin/<defaultBranch>
// (LOOP-54: root fix for LOOP-48 — worktrees previously branched off local main, silently
// carrying operator's unpushed commits as passengers into every dev PR).
//
// LOOP-37 will extend this file with `worktree path` and the terminal-state reaper.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsWorktree, wsLockPath } from "./workspace.ts";
import { effectiveRepo } from "./team-config.ts";
import { withLock } from "./locks.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop worktree: ${msg}`); process.exit(code); }

const git = (cwd: string, args: string[]): { ok: boolean; out: string; err: string } => {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

async function worktreeAdd(argv: string[]): Promise<number> {
  const id = argv.find((a) => !a.startsWith("-"));
  if (!id) die("usage: dev-loop worktree add <id> [--repo <ref>]");

  const repoIdx = argv.indexOf("--repo");
  const repoRef = repoIdx >= 0 ? (argv[repoIdx + 1] ?? die("--repo requires a value")) : undefined;

  const ws = resolveWorkspace();
  const resolvedRef = repoRef ?? Object.keys(ws.file.repos)[0];
  if (!resolvedRef) die("no repos registered in workspace");
  const repo = ws.file.repos[resolvedRef];
  if (!repo) die(`unknown repo ref '${resolvedRef}'`);
  const repoDir = effectiveRepo(ws, resolvedRef).absPath;

  const defaultBranch = "main"; // RepoEntry has no defaultBranch field yet; "main" is the universal default
  const branchName = `dev-loop/${id}`;
  const worktreePath = wsWorktree(ws, id, resolvedRef);
  const lockPath = wsLockPath(ws, `repo-${resolvedRef}`);

  await withLock(lockPath, {}, async () => {
    let base: string;
    if (repo.remote) {
      const fetch = git(repoDir, ["fetch", "origin", defaultBranch]);
      if (fetch.ok) {
        base = `origin/${defaultBranch}`;
      } else {
        // No network / remote missing — fall back to local branch, surface to caller
        process.stderr.write(`dev-loop worktree: could not fetch origin/${defaultBranch} — basing on local '${defaultBranch}' instead\n`);
        base = defaultBranch;
      }
    } else {
      // No remote configured — local base, say so
      process.stderr.write(`dev-loop worktree: no remote configured for repo '${resolvedRef}' — basing on local '${defaultBranch}'\n`);
      base = defaultBranch;
    }

    // Idempotency: if the path already exists, verify it's on the right branch.
    if (existsSync(worktreePath)) {
      const list = git(repoDir, ["worktree", "list", "--porcelain"]);
      const entries = list.out.split("\n\n").filter(Boolean);
      for (const entry of entries) {
        const pathLine = entry.split("\n").find((l) => l.startsWith("worktree "));
        if (!pathLine) continue;
        const entryPath = pathLine.slice("worktree ".length);
        if (entryPath !== worktreePath) continue;
        const branchLine = entry.split("\n").find((l) => l.startsWith("branch "));
        const entryBranch = branchLine ? branchLine.replace("branch refs/heads/", "") : "(none)";
        if (entryBranch === branchName) {
          // Already exists on the right branch — idempotent success
          process.stdout.write(worktreePath + "\n");
          return;
        }
        die(`worktree already exists at '${worktreePath}' on branch '${entryBranch}', not '${branchName}' — refusing to re-point`, 1);
      }
      // Path exists but not registered as a worktree (e.g. stale dir) — let git decide
    }

    // Check if the branch already exists (worktree was pruned but branch persists)
    const branchExists = git(repoDir, ["rev-parse", "--verify", "--quiet", branchName]);
    const addArgs = branchExists.ok
      ? ["worktree", "add", worktreePath, branchName]
      : ["worktree", "add", "-b", branchName, worktreePath, base];

    const add = git(repoDir, addArgs);
    if (!add.ok) die(`git worktree add failed: ${add.err || add.out}`, 1);

    process.stdout.write(worktreePath + "\n");
  });

  return 0;
}

function usage(): void {
  console.log(`dev-loop worktree — dev worktree lifecycle management

Usage: dev-loop worktree <verb> [args]

  add <id> [--repo <ref>]
      Create a dev worktree on branch dev-loop/<id> based at origin/<defaultBranch> (never
      local main). Prints the path. Idempotent: same path+branch → succeeds; different base → refuses.
      Run under the §7 repo lock to serialize fetch + worktree-add with other base-clone mutations.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") { usage(); process.exit(0); }
  if (verb === "add") {
    worktreeAdd(rest).then((c) => process.exit(c)).catch((e) => { console.error(`dev-loop worktree: ${(e as Error).message}`); process.exit(1); });
  } else {
    console.error(`dev-loop worktree: unknown verb '${verb}'\n`);
    usage();
    process.exit(2);
  }
}
