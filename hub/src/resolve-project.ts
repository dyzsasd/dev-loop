// DL-13: resolve a project KEY from a cwd by matching it against the configured projects' repo paths, so
// an agent launched inside a project folder auto-pins that project with no manual DEVLOOP_PROJECT. Pure +
// side-effect-light so it is trivially unit-testable AND the launcher can reuse the SAME matcher via the
// `dev-loop-hub resolve-project` subcommand (one rule, no prose/code drift). Backward-compatible: an
// explicit DEVLOOP_PROJECT always wins (the caller checks that first); this runs only when it is unset.
import { realpathSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { relative, isAbsolute, join } from "node:path";

export interface ProjectsConfig {
  defaultProject?: string;
  // The shape resolveProjectFromCwd matches on (repoPath/repos), plus the few fields the daemon reads to
  // resolve per-project behavior — DL-83: hub.docs/director/strategyDoc drive the /roadmap divergence banner.
  projects?: Record<string, { repoPath?: string; repos?: { path?: string }[]; hub?: { docs?: boolean }; director?: unknown; strategyDoc?: unknown }>;
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
// AND shim.ts:38-46). An EXPLICIT DEVLOOP_PROJECT wins; else resolve from cwd (DL-13); else the "demo" default.
// `projectFromCwd` is true only on the cwd-resolved branch (server.ts uses it for a clearer not-seeded error).
export function resolveIdentity(): { actor: string; projectKey: string; projectFromCwd: boolean } {
  const actor = process.env.DEVLOOP_ACTOR ?? "operator"; // who this MCP client IS (the attribution win)
  const explicit = process.env.DEVLOOP_PROJECT?.trim(); // a present-but-empty "" must NOT become the literal key
  if (explicit) return { actor, projectKey: explicit, projectFromCwd: false };
  const cfg = loadProjectsConfig();
  const resolved = cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null;
  return resolved ? { actor, projectKey: resolved, projectFromCwd: true } : { actor, projectKey: "demo", projectFromCwd: false };
}

// Locate + parse projects.json the way the skills do (§11): DEVLOOP_PROJECTS_JSON, then CLAUDE_PLUGIN_DATA,
// then the canonical dev-loop data dir. Returns null when not found/parseable (caller keeps its default).
export function loadProjectsConfig(): ProjectsConfig | null {
  const candidates = [
    process.env.DEVLOOP_PROJECTS_JSON,
    process.env.CLAUDE_PLUGIN_DATA ? join(process.env.CLAUDE_PLUGIN_DATA, "projects.json") : undefined,
    join(homedir(), ".claude", "plugins", "data", "dev-loop", "projects.json"),
  ].filter((x): x is string => !!x);
  for (const p of candidates) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as ProjectsConfig; } catch { /* try next */ }
  }
  return null;
}
