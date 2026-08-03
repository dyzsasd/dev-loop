#!/usr/bin/env node
// `dev-loop team repair` — the MUTATING workspace fixups doctor must NOT do (doctor stays read-only, R2).
// Idempotent: repairs git worktrees whose absolute gitdir moved (the machine-migration case, §10.3),
// prunes stale worktrees, re-registers the convenience index, (service) truncates the hub WAL, and
// reaps worktrees whose ticket is in a terminal state (Done / Canceled / Duplicate). LOOP-37.
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsHubDb, upsertWorkspaceIndex } from "./workspace.ts";
import { effectiveRepo, validateTeamFile } from "./team-config.ts";
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";
import { worktreeReap } from "./worktree.ts";
import { ensureCliPermissions, CLI_PERMISSIONS } from "./team-init.ts";

function usage(): void {
  console.log(`dev-loop team repair — fix a workspace after a move/migration (mutating; doctor is read-only)

Usage (from inside the workspace):
  dev-loop team repair [--reap] [--dry-run]

Does (non-destructive, always): git worktree repair + prune for every registered repo, re-register the
workspace index, and (service backend) checkpoint+truncate the hub WAL. Also REPORTS worktrees whose
ticket is in a terminal state (Done / Canceled / Duplicate).
  --reap:    additionally REMOVE those terminal worktrees and DELETE their branches — but only when the
             work is recoverable (branch merged into the base, or pushed to origin). A dirty worktree or
             an unrecoverable Canceled branch is KEPT with a printed reason. Destructive; opt-in (LOOP-106).
             (Standalone equivalent: dev-loop worktree reap.)
  --dry-run: print what would be repaired/reaped without changing anything.`);
}

const git = (repo: string, args: string[]): string | null => {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const isGitRepo = (dir: string): boolean => git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";

export async function teamRepair(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { usage(); return 0; }
  const dryRun = argv.includes("--dry-run");
  const reap = argv.includes("--reap");
  const ws = resolveWorkspace();
  const pass = (m: string) => console.log("✅ " + m);
  const info = (m: string) => console.log("•  " + m);

  console.log(`dev-loop team repair — workspace '${ws.file.team.key}' @ ${ws.root}${dryRun ? " [dry-run]" : ""}`);

  if (!dryRun) {
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
  }

  // Claude-settings CLI permission top-up (LOOP-181): .claude/settings.json is written ONCE at init and
  // never updated by an npm upgrade, so a workspace created before the `kaizen` bin landed carries only
  // Bash(dev-loop *). Top up any missing rule of the CLI pair — idempotent, non-destructive (create-or-
  // merge; a malformed file is left untouched), and honoring --dry-run (report, don't write).
  {
    const r = ensureCliPermissions(ws.root, { dryRun });
    const rel = ".claude/settings.json";
    if (r.outcome === "untouched")
      info(`${rel} ${r.untouchedReason} — left untouched (add ${CLI_PERMISSIONS.join(" + ")} to permissions.allow by hand)`);
    else if (r.outcome === "present")
      pass(`${rel} already allows ${CLI_PERMISSIONS.join(" + ")}`);
    else if (dryRun)
      info(`${rel} would gain ${r.added.map((p) => JSON.stringify(p)).join(" + ")}${r.created ? " (file would be created)" : ""} — run \`dev-loop team repair\` to apply`);
    else
      pass(`${rel}: permissions.allow += ${r.added.map((p) => JSON.stringify(p)).join(" + ")}${r.created ? " (created)" : ""}`);
  }

  // 4. Terminal-state worktrees (Done / Canceled / Duplicate). LOOP-37 enumerates them from
  //    `git worktree list` so all roots are covered (incl. legacy / /tmp paths). DESTRUCTIVE + OPT-IN
  //    (LOOP-106): the default pass only REPORTS what it would reap; `--reap` performs the removal. This
  //    keeps every automatic/non-interactive caller (e.g. `dev-loop up --bundle`, bundle.ts:380 — which
  //    runs BEFORE the doctor gate) non-destructive by default: no unattended, irreversible deletion.
  const reapForReal = reap && !dryRun;
  for (const ref of Object.keys(ws.file.repos)) {
    const dir = effectiveRepo(ws, ref).absPath;
    if (!existsSync(dir) || !isGitRepo(dir)) continue;
    const result = await worktreeReap(ws, ref, {
      dryRun: !reapForReal, // report-only unless --reap was passed (and not overridden by --dry-run)
      print: (m) => console.log("•  " + m),
    });
    if (reapForReal && result.reaped.length > 0) pass(`repo '${ref}': reaped ${result.reaped.length} terminal worktree(s)`);
    else if (!reapForReal && result.reaped.length > 0) info(`repo '${ref}': ${result.reaped.length} terminal worktree(s) would be reaped — run \`dev-loop team repair --reap\` (or \`dev-loop worktree reap\`) to remove them`);
  }

  // 5. Scratch project reap — scratch + zero-ticket + zero-repo projects.
  // Service backend only (ticket count requires hub.db). Mirrors worktreeReap's guard shape:
  // report-only by default; --reap (without --dry-run) applies; no forced destroy.
  if (ws.file.team.backend === "service") {
    const dbPath = wsHubDb(ws);
    let db: ReturnType<typeof openDb> | undefined;
    try { if (existsSync(dbPath)) db = openDb(dbPath); } catch { /* hub db unreachable */ }

    const candidates = Object.entries(ws.file.projects)
      .filter(([, p]) => p.scratch === true && (p.repos ?? []).length === 0)
      .map(([k]) => k);

    for (const key of candidates) {
      const projectId = db ? findProject(db, key) : null;
      const tc = db && projectId
        ? ((db.prepare("SELECT count(*) c FROM tickets WHERE project_id=?").get(projectId) as { c: number }).c)
        : 0;
      if (tc > 0) { info(`project '${key}': scratch but has ${tc} ticket(s) — kept`); continue; }
      if (!reapForReal) {
        info(`project '${key}': scratch 0-ticket 0-repo — would be reaped (run \`team repair --reap\` to apply)`);
        continue;
      }
      // Apply: config first (validated write), then db
      try {
        const file = JSON.parse(JSON.stringify(ws.file)) as typeof ws.file;
        delete file.projects[key];
        const { errors } = validateTeamFile(file);
        if (errors.length) { info(`project '${key}': skipped — config invalid after removal: ${errors[0].message}`); continue; }
        writeFileSync(ws.filePath, JSON.stringify(file, null, 2) + "\n");
        ws.file = file;
      } catch (e) { info(`project '${key}': config removal failed: ${(e as Error).message}`); continue; }
      if (db && projectId) {
        try {
          db.prepare("DELETE FROM channel_messages WHERE channel_id IN (SELECT id FROM channels WHERE project_id=?)").run(projectId);
          db.prepare("DELETE FROM channels WHERE project_id=?").run(projectId);
          db.prepare("DELETE FROM labels WHERE project_id=?").run(projectId);
          db.prepare("DELETE FROM document_versions WHERE doc_id IN (SELECT id FROM documents WHERE project_id=?)").run(projectId);
          db.prepare("DELETE FROM documents WHERE project_id=?").run(projectId);
          db.prepare("DELETE FROM events WHERE project_id=?").run(projectId);
          db.prepare("DELETE FROM mirror_map WHERE project_id=?").run(projectId);
          db.prepare("DELETE FROM projects WHERE key=?").run(key);
        } catch (e2) { info(`project '${key}': db cleanup failed: ${(e2 as Error).message}`); continue; }
      }
      pass(`project '${key}': reaped (scratch 0-ticket 0-repo)`);
    }
    db?.close();
  }

  console.log(dryRun ? "\nREPAIR_DRYRUN_OK" : "\nREPAIR_OK");
  return 0;
}

if (isMainEntry(import.meta.url)) {
  teamRepair().then((c) => process.exit(c)).catch((e) => { console.error(`dev-loop team repair: ${(e as Error).message}`); process.exit(1); });
}
