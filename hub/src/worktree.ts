#!/usr/bin/env node
// dev-loop worktree — dev worktree lifecycle management (LOOP-54, LOOP-37).
//   add  <id> [--repo <ref>]            create a dev worktree off origin/<defaultBranch>
//   path <id> [--repo <ref>]            print the canonical wsWorktree() path (LOOP-37: single path-builder)
//   reap [--repo <ref>] [--dry-run]     remove terminal-state worktrees + delete each RECOVERABLE branch
//                                       (merged into the base — origin/<defaultBranch>, or the local
//                                       <defaultBranch> on a repo with no remote — or pushed to origin).
//                                       A dirty worktree or an
//                                       unrecoverable Canceled branch is KEPT with a printed reason — never a
//                                       silent `remove --force` / `branch -D` of the only copy (LOOP-106).
// Importable: exports worktreeReap() so team-repair.ts can call it as part of its pass (isMainEntry guard).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { resolveWorkspace, wsWorktree, wsLockPath, wsHubDb } from "./workspace.ts";
import { effectiveRepo, type Workspace } from "./team-config.ts";
import { withRepoLockPath } from "./locks.ts";
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
  const resolved = effectiveRepo(ws, resolvedRef);
  const repoDir = resolved.absPath;
  const defaultBranch = resolved.defaultBranch;
  const branchName = `dev-loop/${id}`;
  const worktreePath = wsWorktree(ws, id, resolvedRef);
  const lockPath = wsLockPath(ws, `repo-${resolvedRef}`);

  await withRepoLockPath(lockPath, {}, async () => {
    let base: string;
    if (repoHasRemote(repoDir, repo.remote)) {
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

/**
 * The ref reap measures merged-ness against — the same judgement `worktreeAdd` makes when it picks
 * what to branch off: `origin/<defaultBranch>` when the repo has a remote, the LOCAL
 * `<defaultBranch>` when it does not. In a repository with no remote `origin/<defaultBranch>` does
 * not resolve at all, so a comparison against it can only ever fail.
 */
// Does THIS REPOSITORY have the remote — not "does the registry declare one". push-guard states the
// reason where it does the same thing: the registry can be stale in either direction. Both worktree
// verbs read the registry field instead, and a workspace whose registry claimed a remote the repo does
// not have measured every terminal branch against an `origin/<base>` that cannot resolve, so
// isMergedIntoBase was always false and reap kept every branch it was written to remove. Measured on a
// fixture: with the field present the branch is "UNRECOVERABLE — its only copy is local"; with the field
// removed the same branch is deleted as merged.
//
// The registry remains the FALLBACK, for the case git cannot answer at all — a missing binary or an
// unreadable repo should not silently turn a remote-backed repo into a local-only one.
function repoHasRemote(repoDir: string, registryRemote: unknown): boolean {
  const probe = spawnSync("git", ["-C", repoDir, "remote", "get-url", "origin"], { stdio: "ignore" });
  if (probe.error) return !!registryRemote;   // git unavailable — the registry is all there is
  return probe.status === 0;
}

function reapBaseRef(defaultBranch: string, hasRemote: boolean): string {
  return hasRemote ? `origin/${defaultBranch}` : defaultBranch;
}

function isMergedIntoBase(repoDir: string, branch: string, baseRef: string): boolean {
  const r = spawnSync("git", ["-C", repoDir, "merge-base", "--is-ancestor", branch, baseRef], { stdio: "ignore" });
  return (r.status ?? 1) === 0;
}

// A terminal-ticket branch is safe to delete ONLY when its work survives somewhere other than the
// local branch: (a) merged into the base ref, or (b) pushed to origin with no local-only commits
// ahead of that remote ref. Otherwise the branch is the ONLY copy and must be KEPT — the
// pre-LOOP-106 reaper force-deleted (-D) every Canceled branch on ticket state alone, unrecoverably.
//
// With NO remote, (a) is measured against the local default branch and (b) does not exist: there is
// no second copy to push to, so merged-into-the-base is the whole test. Measuring both halves
// against `origin/…` in a remote-less repository made every branch read as the only copy, so reap
// reclaimed nothing and worktrees accumulated without bound (the `landing: "direct"` shape).
function branchRecoverable(repoDir: string, branch: string, defaultBranch: string, hasRemote: boolean): boolean {
  if (isMergedIntoBase(repoDir, branch, reapBaseRef(defaultBranch, hasRemote))) return true;
  if (!hasRemote) return false; // no origin to have pushed to — merged-into-the-local-base was the only recovery
  const remoteRef = `refs/remotes/origin/${branch}`;
  const hasRemoteBranch = spawnSync("git", ["-C", repoDir, "show-ref", "--verify", "--quiet", remoteRef], { stdio: "ignore" }).status === 0;
  if (!hasRemoteBranch) return false;
  const ahead = git(repoDir, ["rev-list", "--count", `origin/${branch}..${branch}`]);
  return ahead.ok && ahead.out === "0"; // no local commits beyond what origin already holds
}

// Exported so team-repair can call it as part of its pass.
export async function worktreeReap(
  ws: Workspace,
  repoRef: string,
  opts: { dryRun?: boolean; print?: (m: string) => void } = {}
): Promise<{ reaped: ReapEntry[]; kept: ReapEntry[] }> {
  const print = opts.print ?? ((m: string) => console.log(m));
  const dryRun = opts.dryRun ?? false;
  const resolvedReap = effectiveRepo(ws, repoRef);
  const repoDir = resolvedReap.absPath;
  const defaultBranch = resolvedReap.defaultBranch;
  // The SAME judgement `worktree add` uses — one predicate, one reading of it. It asks the repository
  // rather than the registry; see repoHasRemote.
  const hasRemote = repoHasRemote(repoDir, resolvedReap.remote);
  const baseRef = reapBaseRef(defaultBranch, hasRemote);
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

  const reaped: ReapEntry[] = [];
  await withRepoLockPath(lockPath, {}, async () => {
    for (const e of toReap) {
      // 1. Remove the worktree checkout — NEVER `--force` by default. A terminal-ticket worktree may
      //    still hold uncommitted work, and a silent `remove --force` is exactly what makes that loss
      //    unrecoverable (LOOP-106, AC3). Plain `git worktree remove` refuses a dirty or locked tree;
      //    we KEEP it (and its branch — the only home of that uncommitted work) with a loud line.
      if (!existsSync(e.path)) {
        git(repoDir, ["worktree", "prune"]); // registration for a directory the OS already removed
        print(`[reap] pruned stale worktree registration '${e.path}' (already gone; ${e.ticketId} is ${e.state})`);
      } else {
        const rm = git(repoDir, ["worktree", "remove", e.path]); // no --force — safe by construction
        if (!rm.ok) {
          print(`[reap] KEPT worktree '${e.path}' — ${e.ticketId} is ${e.state} but the tree is not safe to remove` +
            ` (uncommitted changes, or locked): ${rm.err.split("\n")[0] || "git worktree remove refused"}.` +
            ` Not force-removing; if the work is truly disposable run: git -C ${repoDir} worktree remove --force ${e.path}`);
          toKeep.push(e); // reclassify — this entry was NOT reaped
          continue;       // keep the branch too: its worktree still holds the only copy
        }
        print(`[reap] removed worktree '${e.path}' (${e.ticketId} is ${e.state})`);
      }
      // The worktree path is <state>/wt/<ticket>/<ref>, so removing the leaf leaves the per-ticket
      // parent behind. One empty directory per reaped ticket accumulated in the state dir forever
      // (10 of them in one workspace inside a day). Removed only when it is EMPTY — a ticket with a
      // worktree per repo keeps its other refs — and only when it really is the `wt/<ticket>` level,
      // so a path shape change cannot turn this into a wider delete.
      const ticketDir = dirname(e.path);
      if (basename(dirname(ticketDir)) === "wt") {
        try { if (readdirSync(ticketDir).length === 0) rmdirSync(ticketDir); } catch { /* raced, or not ours to remove */ }
      }

      // 2. Delete the local branch ONLY when the work is recoverable elsewhere — merged into the base,
      //    or fully pushed to origin. A Canceled branch that exists nowhere else is KEPT with a reason
      //    (LOOP-106, AC2); the pre-LOOP-106 reaper force-deleted every Canceled branch on state alone.
      if (branchRecoverable(repoDir, e.branch, defaultBranch, hasRemote)) {
        const del = git(repoDir, ["branch", "-D", e.branch]);
        if (del.ok) print(`[reap] deleted branch '${e.branch}' (${e.state}; recoverable — merged into ${baseRef}${hasRemote ? " or pushed to origin" : ""})`);
        else print(`[reap] kept branch '${e.branch}' (delete failed: ${del.err.split("\n")[0] || "git branch -D refused"})`);
      } else {
        print(`[reap] kept branch '${e.branch}' (${e.state} but UNRECOVERABLE — ${hasRemote ? "no origin upstream and " : ""}not merged into ${baseRef}; its only copy is local)`);
      }
      reaped.push(e);
    }
  });

  return { reaped, kept: toKeep };
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
      DESTRUCTIVE. Remove worktrees whose ticket is in a terminal state (Done / Canceled / Duplicate)
      and delete each branch that is RECOVERABLE (merged into the base — origin/<defaultBranch>, or
      the LOCAL <defaultBranch> when the repo has no remote — or fully pushed to origin). A
      dirty or locked worktree, or an unrecoverable Canceled branch (its only copy is local), is KEPT
      with a printed reason — never a silent \`remove --force\` / \`branch -D\` of the only copy (LOOP-106).
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
