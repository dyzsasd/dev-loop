// Workspace discovery, the .dev-loop/ path API, and the self-healing team index (design impl §3).
//
// A workspace is a directory holding a `dev-loop.json` (schema v2). Discovery precedence:
//   1. DEVLOOP_WORKSPACE (absolute path — a bad/missing value is a HARD error, no fall-through)
//   2. DEVLOOP_TEAM (key) → ~/.dev-loop/workspaces.json index → path
//   3. cwd realpath walked upward to the first dir that has a valid dev-loop.json
// All run/state paths live UNDER the workspace (I4: copy the folder = migrate the machine); the only thing
// in ~/.dev-loop is a NON-authoritative convenience index that any in-workspace run rebuilds.
import { realpathSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { loadWorkspace, normalizedRel, type Workspace } from "./team-config.ts";
import { devloopHome, hubDbPath } from "./paths.ts";
import { loadWorkspaceSecrets } from "./secrets.ts";

export class WsNotFound extends Error {
  constructor(msg: string) { super(msg); this.name = "WsNotFound"; }
}

const guidance = "Run `dev-loop team init` in a directory to create a workspace, or `cd` into an existing one.";

// ─── Discovery ────────────────────────────────────────────────────────────────
export function findWorkspaceRoot(cwd = process.cwd()): string | null {
  // 1. explicit workspace path
  const explicit = process.env.DEVLOOP_WORKSPACE?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new WsNotFound(`DEVLOOP_WORKSPACE must be an absolute path (got '${explicit}')`);
    if (!existsSync(join(explicit, "dev-loop.json"))) throw new WsNotFound(`DEVLOOP_WORKSPACE=${explicit} has no dev-loop.json`);
    return canon(explicit);
  }
  // 2. team key via the index
  const teamKey = process.env.DEVLOOP_TEAM?.trim();
  if (teamKey) {
    const root = readWorkspaceIndex()[teamKey];
    if (!root || !existsSync(join(root, "dev-loop.json"))) throw new WsNotFound(`DEVLOOP_TEAM='${teamKey}' is not in the workspace index (or its path is gone). cd into the workspace once to re-register it.`);
    return canon(root);
  }
  // 3. cwd ascent
  let dir = canon(cwd);
  if (!dir) return null;
  for (;;) {
    if (existsSync(join(dir, "dev-loop.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Resolve + load + validate the workspace for this cwd/env. Throws WsNotFound (no workspace) or
// WsValidationError (bad config). On success best-effort registers the index (self-heal).
export function resolveWorkspace(cwd = process.cwd()): Workspace {
  const root = findWorkspaceRoot(cwd);
  if (!root) throw new WsNotFound(`no dev-loop.json found from ${cwd} upward. ${guidance}`);
  // §16 secrets: hydrate `<root>/.dev-loop/secrets.env` into process.env (real env ALWAYS wins) the
  // moment the root is known — cli/daemon/run-agents all resolve through here, and the agent fires
  // they spawn inherit process.env, so this ONE hook makes every env-var NAME in dev-loop.json
  // resolvable with zero machine-global shell setup (I4 self-containment).
  loadWorkspaceSecrets(root);
  const ws = loadWorkspace(root);
  upsertWorkspaceIndex(ws.file.team.key, root);
  return ws;
}

export function tryResolveWorkspace(cwd = process.cwd()): Workspace | null {
  try { return resolveWorkspace(cwd); } catch (e) { if (e instanceof WsNotFound) return null; throw e; }
}

const canon = (p: string): string | null => { try { return realpathSync(p); } catch { return isAbsolute(p) ? p : null; } };

// ─── The .dev-loop/ path API (impl §3.2, R1) ─────────────────────────────────
export function wsStateRoot(ws: Workspace): string { return join(ws.root, ".dev-loop"); }
export function wsProjectDir(ws: Workspace, key: string): string { return join(wsStateRoot(ws), key); }
export function wsTeamDir(ws: Workspace): string { return join(wsStateRoot(ws), "team"); }
export function wsLessonsDir(ws: Workspace): string { return join(wsStateRoot(ws), "lessons"); }
export function wsWorktree(ws: Workspace, ticket: string, ref: string): string { return join(wsStateRoot(ws), "wt", ticket, ref); }
export function wsLockPath(ws: Workspace, name: string): string { return join(wsStateRoot(ws), "locks", `${name}.lock`); }
export function wsHubDb(ws: Workspace): string { return join(wsStateRoot(ws), "hub.db"); }
// The operator-CLI hub-DB ladder (field report P2 #1/#2): explicit DEVLOOP_HUB_DB > the discovered
// workspace's .dev-loop/hub.db > the machine-global default. op/tickets/seed/doctor used to jump
// straight to the global default (seed even to ./hub.db in cwd), silently reading or CREATING a
// different board than the workspace the operator was standing in — the day-1 double-db split.
export function resolveHubDbPath(startDir = process.cwd()): string {
  if (process.env.DEVLOOP_HUB_DB?.trim()) return hubDbPath();
  const ws = tryResolveWorkspace(startDir);
  return ws ? wsHubDb(ws) : hubDbPath();
}
export function wsDaemonRunfile(ws: Workspace): string { return join(wsStateRoot(ws), "daemon.json"); }
export function wsFireLedger(ws: Workspace): string { return join(wsTeamDir(ws), "fires.jsonl"); }
export function wsScheduler(ws: Workspace): string { return join(wsTeamDir(ws), "scheduler.json"); }

// Scaffold the state tree (init + first run). Idempotent.
export function ensureStateDirs(ws: Workspace): void {
  for (const d of [wsStateRoot(ws), wsTeamDir(ws), wsLessonsDir(ws), join(wsStateRoot(ws), "wt"), join(wsStateRoot(ws), "locks")]) mkdirSync(d, { recursive: true });
}

// ─── repo/project resolution from cwd (DL-13 matcher over the registry) ───────
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = normalizedRelSeg(parent, child);
  return rel !== null;
}
function normalizedRelSeg(parent: string, child: string): string | null {
  if (!child.startsWith(parent)) return null;
  const rest = child.slice(parent.length);
  return rest.startsWith("/") ? rest.slice(1) : null;
}

// The repo ref whose absolute path is the NEAREST ancestor of cwd (segment-boundary safe; tie → null).
export function resolveRepoFromCwd(ws: Workspace, cwd: string): string | null {
  const c = canon(cwd);
  if (!c) return null;
  let best: { ref: string; depth: number } | null = null;
  let tie = false;
  for (const [ref, r] of Object.entries(ws.file.repos)) {
    const abs = canon(join(ws.root, normalizedRel(r.path) ?? r.path));
    if (!abs || !isWithin(c, abs)) continue;
    const depth = abs.length;
    if (!best || depth > best.depth) { best = { ref, depth }; tie = false; }
    else if (depth === best.depth && ref !== best.ref) tie = true;
  }
  return best && !tie ? best.ref : null;
}

// ─── The convenience index (~/.dev-loop/workspaces.json) — NON-authoritative ──
export function workspacesIndexPath(): string { return join(devloopHome(), "workspaces.json"); }

export function readWorkspaceIndex(): Record<string, string> {
  try { const j = JSON.parse(readFileSync(workspacesIndexPath(), "utf8")); return j && typeof j === "object" ? j : {}; }
  catch { return {}; }
}

export function upsertWorkspaceIndex(teamKey: string, root: string): void {
  try {
    const idx = readWorkspaceIndex();
    if (idx[teamKey] === root) return;
    idx[teamKey] = root;
    const p = workspacesIndexPath();
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2));
    renameSync(tmp, p);
  } catch { /* the index is a convenience; a failed write just means the next in-workspace run re-registers */ }
}
