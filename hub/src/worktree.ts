#!/usr/bin/env node
// dev-loop worktree — dev worktree lifecycle management (LOOP-54, LOOP-37).
//   add  <id> [--repo <ref>]            create a dev worktree off origin/<defaultBranch>
//   path <id> [--repo <ref>]            print the canonical wsWorktree() path (LOOP-37: single path-builder)
//   reap [--repo <ref>] [--dry-run]     remove worktrees for terminal-state tickets + delete their branches
// Importable: exports worktreeReap() so team-repair.ts can call it as part of its pass (isMainEntry guard).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveWorkspace, wsWorktree, wsLockPath, wsHubDb } from "./workspace.ts";
import { effectiveRepo, type Workspace } from "./team-config.ts";
import { withLock } from "./locks.ts";
import { openDb } from "./db.ts";
import { isMainEntry } from "./is-entry.ts";

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

// ─── worktree path ────────────────────────────────────────────────────────────
function worktreePath(argv: string[]): number {
  const ticketIdx = argv.findIndex((a) => !a.startsWith("-"));
  if (ticketIdx === -1) { console.error("dev-loop worktree path: missing <ticket-id>"); return 2; }
  const ticket = argv[ticketIdx]!;

  const repoFlagIdx = argv.indexOf("--repo");
  let repoRef: string | null = repoFlagIdx >= 0 ? (argv[repoFlagIdx + 1] ?? null) : null;
  if (repoFlagIdx >= 0 && !repoRef) { console.error("dev-loop worktree path: --repo requires a value"); return 2; }

  const ws = resolveWorkspace();
  if (!repoRef) {
    const refs = Object.keys(ws.file.repos);
    if (refs.length === 1) repoRef = refs[0]!;
    else { console.error("dev-loop worktree path: multiple repos exist — pass --repo <ref>"); return 2; }
  }
  if (!ws.file.repos[repoRef]) { console.error(`dev-loop worktree path: unknown repo ref '${repoRef}'`); return 1; }
  console.log(wsWorktree(ws, ticket, repoRef));
  return 0;
}

// ─── worktree reap ────────────────────────────────────────────────────────────

const TERMINAL_STATES = new Set(["Done", "Canceled", "Duplicate"]);

interface ReapEntry { path: string; branch: string; ticketId: string; state: string }

function parsePorcelain(out: string): Array<{ path: string; branch: string | null }> {
  return out.split("\n\n").filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    return {
      path: pathLine?.slice("worktree ".length) ?? "",
      branch: branchLine ? branchLine.replace("branch refs/heads/", "") : null,
    };
  }).filter((e) => e.path !== "");
}

function isMergedIntoOrigin(repoDir: string, branch: string, defaultBranch: string): boolean {
  const r = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", branch, `origin/${defaultBranch}`], { stdio: "ignore" });
  return (r.status ?? 1) === 0;
}

// Exported so team-repair can call it as part of its pass.
export async function worktreeReap(
  ws: Workspace,
  repoRef: string,
  opts: { dryRun?: boolean; print?: (m: string) => void } = {}
): Promise<{ reaped: ReapEntry[]; kept: ReapEntry[] }> {
  const print = opts.print ?? ((m: string) => console.log(m));
  const dryRun = opts.dryRun ?? false;
  const repoDir = effectiveRepo(ws, repoRef).absPath;
  const lockPath = wsLockPath(ws, `repo-${repoRef}`);

  // Query terminal-state tickets from hub DB (service backend only).
  const dbPath = ws.file.team.backend === "service" ? wsHubDb(ws) : null;
  if (!dbPath || !existsSync(dbPath)) {
    print(`[reap] skipped: no hub.db available for repo '${repoRef}' (backend: ${ws.file.team.backend})`);
    return { reaped: [], kept: [] };
  }

  const db = openDb(dbPath);
  const queryState = db.prepare("SELECT state FROM tickets WHERE id = ?");
  const getTicketState = (id: string): string | null => {
    const row = queryState.get(id) as { state: string } | undefined;
    return row?.state ?? null;
  };

  // Enumerate all worktrees from the registered repo (covers all roots, incl. legacy /tmp paths).
  const list = git(repoDir, ["worktree", "list", "--porcelain"]);
  if (!list.ok && !list.out) { db.close(); return { reaped: [], kept: [] }; }

  const entries = parsePorcelain(list.out);
  const [, ...nonPrimary] = entries; // skip the main worktree (first entry)

  const toReap: ReapEntry[] = [];
  const toKeep: ReapEntry[] = [];

  for (const entry of nonPrimary) {
    const { path, branch } = entry;
    const m = branch?.match(/^dev-loop\/(.+)$/);
    if (!m) continue; // not a dev-loop ticket branch — leave it alone

    const ticketId = m[1]!;
    const state = getTicketState(ticketId);
    if (!state) continue; // no hub row (ghost ref or different project) — leave it alone
    if (!TERMINAL_STATES.has(state)) { toKeep.push({ path, branch: branch!, ticketId, state }); continue; }

    toReap.push({ path, branch: branch!, ticketId, state });
  }
  db.close();

  if (dryRun) {
    for (const e of toReap) print(`[reap] would remove worktree '${e.path}' (${e.ticketId} is ${e.state})`);
    if (toReap.length === 0) print("[reap] nothing to reap");
    return { reaped: toReap, kept: toKeep };
  }

  await withLock(lockPath, {}, async () => {
    const defaultBranch = "main";
    for (const e of toReap) {
      // Remove the worktree (--force handles uncommitted or missing-on-disk directories).
      if (existsSync(e.path)) {
        const rm = git(repoDir, ["worktree", "remove", "--force", e.path]);
        if (!rm.ok) {
          // Fall back to prune if remove fails (already gone or can't lock)
          git(repoDir, ["worktree", "prune"]);
        }
      } else {
        git(repoDir, ["worktree", "prune"]);
      }
      print(`[reap] removed worktree '${e.path}' (${e.ticketId} is ${e.state})`);

      // Delete the local branch: always for Canceled; only if merged for Done/Duplicate.
      const deleteBranch = e.state === "Canceled" || isMergedIntoOrigin(repoDir, e.branch, defaultBranch);
      if (deleteBranch) {
        const flag = e.state === "Canceled" ? "-D" : "-d";
        const del = git(repoDir, ["branch", flag, e.branch]);
        if (del.ok) print(`[reap] deleted branch '${e.branch}'`);
      } else {
        print(`[reap] kept branch '${e.branch}' (unmerged; non-Canceled ticket)`);
      }
    }
  });

  return { reaped: toReap, kept: toKeep };
}

async function worktreeReapCli(argv: string[]): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const repoFlagIdx = argv.indexOf("--repo");
  const repoRef = repoFlagIdx >= 0 ? (argv[repoFlagIdx + 1] ?? null) : null;

  const ws = resolveWorkspace();
  const refs = repoRef ? [repoRef] : Object.keys(ws.file.repos);
  for (const ref of refs) {
    if (!ws.file.repos[ref]) { console.error(`dev-loop worktree reap: unknown repo ref '${ref}'`); return 1; }
    await worktreeReap(ws, ref, { dryRun });
  }
  return 0;
}

function usage(): void {
  console.log(`dev-loop worktree — dev worktree lifecycle management

Usage: dev-loop worktree <verb> [args]

  add <id> [--repo <ref>]
      Create a dev worktree on branch dev-loop/<id> based at origin/<defaultBranch> (never
      local main). Prints the path. Idempotent: same path+branch → succeeds; different base → refuses.
      Run under the §7 repo lock to serialize fetch + worktree-add with other base-clone mutations.

  path <id> [--repo <ref>]
      Print the canonical wsWorktree() path for <id>+<ref> — the single source of truth for
      worktree paths. Agent fires should call this instead of constructing the path themselves.

  reap [--repo <ref>] [--dry-run]
      Remove worktrees whose ticket is in a terminal state (Done / Canceled / Duplicate) and
      delete their local branches (force-delete for Canceled; safe-delete for merged Done/Duplicate).
      Enumerates via \`git worktree list\` so it covers all roots, including legacy paths.
      --dry-run: print what would be reaped without removing anything.`);
}

if (isMainEntry(import.meta.url)) {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb || verb === "--help" || verb === "-h" || verb === "help") { usage(); process.exit(0); }
  if (verb === "add") {
    worktreeAdd(rest).then((c) => process.exit(c)).catch((e) => { console.error(`dev-loop worktree: ${(e as Error).message}`); process.exit(1); });
  } else if (verb === "path") {
    process.exit(worktreePath(rest));
  } else if (verb === "reap") {
    worktreeReapCli(rest).then((c) => process.exit(c)).catch((e) => { console.error(`dev-loop worktree reap: ${(e as Error).message}`); process.exit(1); });
  } else {
    console.error(`dev-loop worktree: unknown verb '${verb}'\n`);
    usage();
    process.exit(2);
  }
}
