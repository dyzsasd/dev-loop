#!/usr/bin/env node
// `dev-loop hub start | stop | status | ensure` — the workspace-scoped hub daemon lifecycle (design §7.2,
// operator feedback #17). Because the hub db lives INSIDE the workspace (I4), its daemon must be managed
// per-workspace too. This is a thin, workspace-aware wrapper over the battle-tested per-project daemon
// lifecycle: it points DEVLOOP_HUB_DB / DEVLOOP_RUN_DIR at the workspace and drives the daemon for the
// `_team` project. `stop` additionally checkpoints + truncates the WAL (required before a machine move).
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsHubDb, wsStateRoot } from "./workspace.ts";
import { TEAM_INTAKE_PROJECT, type Workspace } from "./team-config.ts";
import { daemonLifecycleCode } from "./daemon-lifecycle.ts";
import { openDb } from "./db.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop hub: ${msg}`); process.exit(code); }

// Point the daemon lifecycle at THIS workspace's hub db + runfile dir, keyed to the _team project.
function wireEnv(ws: Workspace): void {
  process.env.DEVLOOP_HUB_DB = wsHubDb(ws);
  process.env.DEVLOOP_RUN_DIR = wsStateRoot(ws);
  if (!process.env.DEVLOOP_PROJECT?.trim()) process.env.DEVLOOP_PROJECT = TEAM_INTAKE_PROJECT;
}

function walCheckpoint(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  try { const db = openDb(dbPath); try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); console.log("✅ hub WAL checkpointed + truncated"); } finally { db.close(); } }
  catch (e) { console.error(`•  WAL checkpoint skipped: ${(e as Error).message}`); }
}

function reportSize(dbPath: string): void {
  const size = (p: string) => { try { return statSync(p).size; } catch { return 0; } };
  console.log(`•  hub.db ${(size(dbPath) / 1024).toFixed(0)} KB · WAL ${(size(dbPath + "-wal") / 1024).toFixed(0)} KB · ${dbPath}`);
}

// Idempotent ensure — used by `dev-loop run` on a service team so the operator needn't start the hub by hand.
export async function ensureHub(ws: Workspace): Promise<number> {
  if (ws.file.team.backend !== "service") return 0;
  wireEnv(ws);
  return daemonLifecycleCode("ensure");
}

export async function hubCmd(argv = process.argv.slice(2)): Promise<number> {
  const sub = argv[0] ?? "status";
  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log("usage: dev-loop hub start|stop|status|ensure  — manage the workspace hub daemon (service backend)");
    return 0;
  }
  const ws = resolveWorkspace();
  if (ws.file.team.backend !== "service") die(`team '${ws.file.team.key}' is backend:'${ws.file.team.backend}' — hub commands are for service-backend teams only (a linear team has no hub.db)`, 2);
  wireEnv(ws);
  switch (sub) {
    case "start": return daemonLifecycleCode("up");
    case "ensure": return daemonLifecycleCode("ensure");
    case "stop": { const c = await daemonLifecycleCode("down"); walCheckpoint(wsHubDb(ws)); return c; }
    case "status": { const c = await daemonLifecycleCode("status"); reportSize(wsHubDb(ws)); return c; }
    default: die(`unknown subcommand '${sub}' (start|stop|status|ensure)`, 2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  hubCmd().then((c) => process.exit(c));
}
