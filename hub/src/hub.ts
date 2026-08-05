#!/usr/bin/env node
// `dev-loop hub start | stop | status | ensure` — the workspace-scoped hub daemon lifecycle (design §7.2,
// operator feedback #17). Because the hub db lives INSIDE the workspace (I4), its daemon must be managed
// per-workspace too. This is a thin, workspace-aware wrapper over the battle-tested per-project daemon
// lifecycle: it points DEVLOOP_HUB_DB / DEVLOOP_RUN_DIR at the workspace and drives the daemon for the
// `_team` project. `stop` additionally checkpoints + truncates the WAL (required before a machine move).
import { existsSync, statSync } from "node:fs";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsHubDb, wsStateRoot } from "./workspace.ts";
import { TEAM_INTAKE_PROJECT, deliveryProjects, type Workspace } from "./team-config.ts";
import { daemonLifecycleCode, daemonUpForKey, daemonStatusAll } from "./daemon-lifecycle.ts";
import { openDb } from "./db.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop hub: ${msg}`); process.exit(code); }

// Point the daemon lifecycle at THIS workspace's hub db + runfile dir, keyed to the _team project.
// DEVLOOP_PROJECT is always overwritten (not just when unset): an inherited ambient value from a parent
// fire names a DIFFERENT workspace's project, which the cwd-resolved hub.db doesn't know about and
// causes start/status to silently report "not seeded" for the wrong project key (LOOP-6).
function wireEnv(ws: Workspace): void {
  process.env.DEVLOOP_HUB_DB = wsHubDb(ws);
  process.env.DEVLOOP_RUN_DIR = wsStateRoot(ws);
  process.env.DEVLOOP_PROJECT = TEAM_INTAKE_PROJECT;
}

// For `hub status` only: wire HUB_DB + RUN_DIR without pinning DEVLOOP_PROJECT to _team,
// so daemonStatusAll() can enumerate every daemon-*.json in the workspace run dir (LOOP-52).
function wireEnvForStatus(ws: Workspace): void {
  process.env.DEVLOOP_HUB_DB = wsHubDb(ws);
  process.env.DEVLOOP_RUN_DIR = wsStateRoot(ws);
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
// LOOP-261: also ensures each per-project daemon — fire ops resolve against daemon-<key>.json, not
// daemon-_team.json. Both are ensured; neither replaces the other.
export async function ensureHub(ws: Workspace): Promise<number> {
  if (ws.file.team.backend !== "service") return 0;
  // Ensure _team first (web-UI + intake daemon). _team is not in ws.file.projects, so the loop
  // below never reaches it — the explicit call here is required.
  wireEnv(ws);
  let code = await daemonLifecycleCode("ensure");
  // wireEnv set DEVLOOP_HUB_DB + DEVLOOP_RUN_DIR; daemonUpForKey reads them directly (no DEVLOOP_PROJECT).
  for (const key of deliveryProjects(ws)) {
    const c = await daemonUpForKey(key);
    if (c !== 0) code = c;
  }
  return code;
}

export async function hubCmd(argv = process.argv.slice(2)): Promise<number> {
  const sub = argv[0] ?? "status";
  // LOOP-154: `--help` is checked across the WHOLE argv, not just argv[0]. `hub start --help` used to
  // fall past an argv[0]-only test and EXECUTE the start — a documented discovery flag with a real
  // side effect. Help is a request for text; it must never be answered with an action.
  if (argv.some((a) => a === "--help" || a === "-h" || a === "help")) {
    console.log("usage: dev-loop hub start|stop|status|ensure  — manage the workspace hub daemon (service backend)\n\n`hub status` lists every project daemon in the workspace. Run `dev-loop hub status` to find the board URL.");
    return 0;
  }
  const ws = resolveWorkspace();
  if (ws.file.team.backend !== "service") die(`team '${ws.file.team.key}' is backend:'${ws.file.team.backend}' — hub commands are for service-backend teams only (a linear team has no hub.db)`, 2);
  // Read the project the operator named BEFORE wireEnv overwrites DEVLOOP_PROJECT: a non-_team project
  // must never be silently retargeted to _team (LOOP-152/LOOP-186 mis-target fix).
  const namedProject = process.env.DEVLOOP_PROJECT?.trim() || null;
  const isNonTeamProject = namedProject !== null && namedProject !== TEAM_INTAKE_PROJECT;
  switch (sub) {
    case "start": {
      if (isNonTeamProject) die(`'${namedProject}' is a per-project daemon — use 'DEVLOOP_PROJECT=${namedProject} dev-loop daemon up' (hub manages only the '${TEAM_INTAKE_PROJECT}' workspace hub)`);
      wireEnv(ws); console.log(`hub start: '${TEAM_INTAKE_PROJECT}'`); return daemonLifecycleCode("up");
    }
    case "ensure": {
      if (isNonTeamProject) die(`'${namedProject}' is a per-project daemon — use 'DEVLOOP_PROJECT=${namedProject} dev-loop daemon up' (hub manages only the '${TEAM_INTAKE_PROJECT}' workspace hub)`);
      wireEnv(ws); console.log(`hub ensure: '${TEAM_INTAKE_PROJECT}'`); return daemonLifecycleCode("ensure");
    }
    case "stop": {
      if (isNonTeamProject) die(`'${namedProject}' is a per-project daemon — use 'DEVLOOP_PROJECT=${namedProject} dev-loop daemon down' (hub manages only the '${TEAM_INTAKE_PROJECT}' workspace hub)`);
      wireEnv(ws); console.log(`hub stop: '${TEAM_INTAKE_PROJECT}'`);
      const c = await daemonLifecycleCode("down"); walCheckpoint(wsHubDb(ws)); return c;
    }
    case "status": { wireEnvForStatus(ws); const c = await daemonStatusAll(); reportSize(wsHubDb(ws)); return c; }
    default: die(`unknown subcommand '${sub}' (start|stop|status|ensure)`, 2);
  }
}

if (isMainEntry(import.meta.url)) {
  hubCmd().then((c) => process.exit(c));
}
