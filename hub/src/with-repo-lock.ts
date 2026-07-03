#!/usr/bin/env node
// `dev-loop with-repo-lock <ref> [--wait <dur>] -- <cmd...>` — run a command while holding the base-clone
// lock for a registered repo, so two projects sharing that repo serialize their base-clone mutations
// (git fetch / worktree add / worktree prune). Worktree-internal work does NOT need this. (design §6.4)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsLockPath } from "./workspace.ts";
import { effectiveRepo } from "./team-config.ts";
import { acquireLock } from "./locks.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop with-repo-lock: ${msg}`); process.exit(code); }

function parseDurationMs(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) die(`invalid duration '${s}'`);
  const n = Number(m[1]); const u = m[2] ?? "s";
  return Math.round(n * (u === "ms" ? 1 : u === "s" ? 1000 : u === "m" ? 60000 : 3600000));
}

export async function withRepoLock(argv: string[]): Promise<number> {
  const sep = argv.indexOf("--");
  if (sep < 0) die("usage: dev-loop with-repo-lock <ref> [--wait <dur>] -- <cmd> [args...]");
  const head = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  if (!cmd.length) die("no command after `--`");
  const ref = head.find((a) => !a.startsWith("-"));
  if (!ref) die("a repo ref is required");
  let waitMs = 60_000;
  const wi = head.indexOf("--wait");
  if (wi >= 0) waitMs = parseDurationMs(head[wi + 1] ?? die("--wait requires a value"));

  const ws = resolveWorkspace();
  if (!ws.file.repos[ref]) die(`repo '${ref}' is not registered in team '${ws.file.team.key}'`);
  const repoDir = effectiveRepo(ws, ref).absPath;
  const lockPath = wsLockPath(ws, `repo-${ref}`);

  let release: () => void;
  try { release = await acquireLock(lockPath, { totalMs: waitMs }); }
  catch (e) { die((e as Error).message, 1); }
  try {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: repoDir, stdio: "inherit" });
    return r.status ?? (r.signal ? 1 : 0);
  } finally { release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  withRepoLock(process.argv.slice(2)).then((c) => process.exit(c));
}
