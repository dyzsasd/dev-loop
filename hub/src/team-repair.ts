#!/usr/bin/env node
// `dev-loop team repair` — the MUTATING workspace fixups doctor must NOT do (doctor stays read-only, R2).
// Idempotent: repairs git worktrees whose absolute gitdir moved (the machine-migration case, §10.3),
// prunes stale worktrees, re-registers the convenience index, and (service) truncates the hub WAL.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsHubDb, upsertWorkspaceIndex } from "./workspace.ts";
import { effectiveRepo } from "./team-config.ts";
import { openDb } from "./db.ts";

function usage(): void {
  console.log(`dev-loop team repair — fix a workspace after a move/migration (mutating; doctor is read-only)

Usage (from inside the workspace):
  dev-loop team repair

Does: git worktree repair + prune for every registered repo, re-register the workspace index,
and (service backend) checkpoint+truncate the hub WAL. Safe to run repeatedly.`);
}

const git = (repo: string, args: string[]): string | null => {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const isGitRepo = (dir: string): boolean => git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";

export function teamRepair(argv = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) { usage(); return 0; }
  const ws = resolveWorkspace();
  const pass = (m: string) => console.log("✅ " + m);
  const info = (m: string) => console.log("•  " + m);

  console.log(`dev-loop team repair — workspace '${ws.file.team.key}' @ ${ws.root}`);

  // 1. worktree repair + prune per registered repo (git worktrees embed absolute paths — the one real
  //    hazard to "copy the folder = migrate", §10.3 step 4).
  let repaired = 0;
  for (const ref of Object.keys(ws.file.repos)) {
    const dir = effectiveRepo(ws, ref).absPath;
    if (!existsSync(dir)) { info(`repo '${ref}': ${dir} missing on disk (clone it, or /dev-loop:sync-repo)`); continue; }
    if (!isGitRepo(dir)) { info(`repo '${ref}': not a git repo yet (skipping)`); continue; }
    git(dir, ["worktree", "repair"]);
    git(dir, ["worktree", "prune"]);
    pass(`repo '${ref}': git worktree repair + prune`);
    repaired++;
  }
  if (!repaired) info("no git repos to repair yet");

  // 2. re-register the convenience index (self-heal after a move/rename).
  upsertWorkspaceIndex(ws.file.team.key, ws.root);
  pass(`re-registered index: ${ws.file.team.key} → ${ws.root}`);

  // 3. service: checkpoint + truncate the WAL so the copied db carries no side-file baggage.
  if (ws.file.team.backend === "service") {
    const db = wsHubDb(ws);
    if (existsSync(db)) {
      try {
        const conn = openDb(db);
        try { conn.exec("PRAGMA wal_checkpoint(TRUNCATE)"); pass("hub WAL checkpointed + truncated"); } finally { conn.close(); }
      } catch (e) { info(`hub WAL checkpoint skipped: ${(e as Error).message}`); }
    } else info("service backend but no hub.db yet (run `team init` / a first fire)");
  }

  console.log("\nREPAIR_OK");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(teamRepair());
}
