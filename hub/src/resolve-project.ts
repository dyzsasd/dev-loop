// DL-13: resolve a project KEY from a cwd by matching it against the configured projects' repo paths, so
// an agent launched inside a project folder auto-pins that project with no manual DEVLOOP_PROJECT. Pure +
// side-effect-light so it is trivially unit-testable AND the launcher can reuse the SAME matcher via the
// `dev-loop-hub resolve-project` subcommand (one rule, no prose/code drift). Backward-compatible: an
// explicit DEVLOOP_PROJECT always wins (the caller checks that first); this runs only when it is unset.
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { projectConfigCandidates } from "./paths.ts";
import { tryResolveWorkspace } from "./workspace.ts";
import { toLegacyView, WsValidationError, type HubBlock } from "./team-config.ts";

export interface ProjectsConfig {
  defaultProject?: string;
  // The shape resolveProjectFromCwd matches on (repoPath/repos), plus the few fields the daemon reads to
  // resolve per-project behavior — DL-83: hub.docs/director/strategyDoc drive the /roadmap divergence
  // banner; the hub block is the shared HubBlock (docs passthrough + the D8 agentInterface map).
  projects?: Record<string, { repoPath?: string; repos?: { path?: string }[]; hub?: HubBlock; director?: unknown; strategyDoc?: unknown }>;
}

// The candidate repo paths for a project (§19): repos[].path if present, else [repoPath].
function projectPaths(p: { repoPath?: string; repos?: { path?: string }[] }): string[] {
  if (p.repos?.length) return p.repos.map((r) => r.path).filter((x): x is string => !!x);
  return p.repoPath ? [p.repoPath] : [];
}
// Is `child` the same as, or a descendant of, `parent` on a SEGMENT boundary — so `/work/repo` does NOT
// match `/work/repo-2`? Both must be realpath-canonical absolute paths.
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
const canon = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

// Resolve at most ONE project key whose repo path is the NEAREST ancestor of cwd. A tie between two
// DISTINCT projects at the same longest depth → null (never guess); cwd outside every repo → null.
export function resolveProjectFromCwd(cwd: string, config: ProjectsConfig): string | null {
  const c = canon(cwd);
  if (!c) return null;
  let best: { key: string; depth: number } | null = null;
  let tie = false;
  for (const [key, proj] of Object.entries(config.projects ?? {})) {
    for (const raw of projectPaths(proj)) {
      const P = canon(raw);
      if (!P || !isWithin(c, P)) continue;
      const depth = P.length; // a longer canonical ancestor path = a nearer ancestor
      if (!best || depth > best.depth) { best = { key, depth }; tie = false; }
      else if (depth === best.depth && key !== best.key) { tie = true; }
    }
  }
  return best && !tie ? best.key : null;
}

// DL-85: the ONE DEVLOOP_ACTOR + DEVLOOP_PROJECT/cwd identity resolution (was re-derived in server.ts:21-32
// AND shim.ts:38-46). An EXPLICIT DEVLOOP_PROJECT wins; else resolve from cwd (DL-13); else unresolved.
// `projectFromCwd` is true only on the cwd-resolved branch (server.ts uses it for a clearer not-seeded error).
export function resolveIdentity(): { actor: string; projectKey: string; projectFromCwd: boolean; projectResolved: boolean } {
  const actor = process.env.DEVLOOP_ACTOR ?? "operator"; // who this MCP client IS (the attribution win)
  const explicit = process.env.DEVLOOP_PROJECT?.trim(); // a present-but-empty "" must NOT become the literal key
  if (explicit) return { actor, projectKey: explicit, projectFromCwd: false, projectResolved: true };
  const cfg = loadProjectsConfig();
  const resolved = cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null;
  return resolved
    ? { actor, projectKey: resolved, projectFromCwd: true, projectResolved: true }
    : { actor, projectKey: "", projectFromCwd: false, projectResolved: false };
}

// Config resolution (1.0): a discoverable workspace (dev-loop.json, schema v2) is THE config —
// loaded, validated, and projected to the legacy ProjectsConfig shape via toLegacyView so every
// consumer reads one shape. A workspace FOUND but INVALID is a loud error (never run stale). The ONLY
// non-workspace source is an EXPLICIT DEVLOOP_PROJECTS_JSON injection (tests/CI); the implicit v1
// fallback (~/.dev-loop/projects.json + the legacy plugin dir) was REMOVED at 1.0 — migrate once with
// `dev-loop team init && dev-loop team import`.
export function loadProjectsConfig(): ProjectsConfig | null {
  try {
    const ws = tryResolveWorkspace();
    if (ws) return toLegacyView(ws) as unknown as ProjectsConfig;
  } catch (e) {
    if (e instanceof WsValidationError) { console.error(`[dev-loop] ${e.message}`); return null; }
    throw e; // WsNotFound is already swallowed by tryResolveWorkspace; anything else is unexpected
  }
  for (const p of projectConfigCandidates()) {
    if (!existsSync(p)) continue;
    try { return JSON.parse(readFileSync(p, "utf8")) as ProjectsConfig; }
    catch (e) { console.error(`[dev-loop] projects.json at ${p} is malformed JSON (${(e as Error).message}); ignoring it`); }
  }
  return null;
}
