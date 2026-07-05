// Schema v2 — the team/workspace config kernel (design: docs/design/team-workspace-impl.md §2).
//
// A `dev-loop.json` at a workspace root declares ONE team (= one Linear team / one backend), a `repos`
// REGISTRY (the physical git-clone folders — each registered exactly once, I2), and `projects` (VIRTUAL
// units that REFERENCE repos by ref; a repo may be shared by N projects). This module is PURE (no fs, no
// process env) except `loadWorkspace`, which reads + validates the file. Everything downstream resolves
// config through here, and legacy consumers get an unchanged view via `toLegacyView` (the M1 de-risk).
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// ─── Types (impl §2.1) ───────────────────────────────────────────────────────
export type DocRef = string | { linearDocument: string } | { hubDoc: string } | { path: string };

export interface AgentLaunchConfig { codingAgent?: string; model?: string; effort?: string; cadence?: string }

export interface TeamBlock {
  key: string;
  backend: "linear" | "service";
  linearTeam?: string;
  linearTeamId?: string | null;
  deployPolicy?: Record<string, "auto" | "manual">;
  docSystem?: "local" | "backend";
  docs?: { vision?: DocRef | null; lessons?: { mirror?: boolean } };
  autonomy?: string;
  mode?: string;
  comms?: { provider: "slack" | "lark"; webhookEnv: string };
  reports?: unknown;
  agents?: Record<string, AgentLaunchConfig>;
  defaultCodingAgent?: string;
  codingAgentDefaults?: Record<string, { model?: string; effort?: string }>;
}

export interface RepoEntry {
  path: string;
  remote?: string;
  owner?: string;
  landing?: "pr" | "direct";
  autoMerge?: boolean;
  mergeChecks?: string[];
  build?: { typecheck?: string; build?: string };
  deploy?: { style?: string; healthCheck?: string; environments?: Record<string, { auto?: boolean; deployPrPrefix?: string; command?: string; healthCheck?: string }> };
  ops?: { checks?: string[]; criticalRoutes?: string[]; logsCommand?: string };
}

export interface ProjectRepoRef { ref: string; role?: string }

export interface ProjectEntry {
  enabled?: boolean;
  weight?: number;
  linearProject?: string;
  linearProjectId?: string | null;
  syncedAt?: string;
  strategyDoc?: DocRef;
  testEnv?: { baseUrl?: string; authConstraint?: string };
  devSplit?: boolean;
  blockedStateName?: string | null;   // a real Linear "Blocked" column name; null → the `blocked` label park (§9)
  notify?: unknown;                   // v1-era per-project notify block (passthrough; team.comms is canonical on v2)
  agents?: unknown;
  models?: unknown;
  efforts?: unknown;
  reports?: unknown;
  mode?: string;
  autonomy?: string;
  docSystem?: string;
  defaultCodingAgent?: string;
  codingAgentDefaults?: unknown;
  repos: ProjectRepoRef[];
}

export interface TeamFile {
  schemaVersion: 2;
  team: TeamBlock;
  repos: Record<string, RepoEntry>;
  projects: Record<string, ProjectEntry>;
}

export interface WsError { code: string; path: string; message: string }
export interface WsWarning { code: string; path: string; message: string }

export interface Workspace {
  root: string;         // absolute workspace dir
  filePath: string;     // <root>/dev-loop.json
  file: TeamFile;
  warnings: WsWarning[];
}

// The .dev-loop/ layout (impl §3.2, R1) shares its top-level namespace with project state dirs, so a
// project key / repo ref may not collide with these. `_team` is the reserved service-intake project —
// permitted ONLY as that exact system key (it also violates the leading-char rule below, by design).
export const RESERVED_NAMES = new Set(["team", "lessons", "wt", "locks", "reports", "hub.db", "daemon.json", "scheduler.json", "fires.jsonl"]);
export const TEAM_INTAKE_PROJECT = "_team";
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const TEAM_KEY_RE = /^[a-z0-9-]{2,32}$/;

// ─── Path safety (E03/E10) — pure string canonicalization ─────────────────────
// A registry path must be RELATIVE and stay WITHIN the workspace. Returns the normalized POSIX-relative
// form, or null if it is absolute / escapes the root (`..` past the top) / empty.
export function normalizedRel(p: string | undefined): string | null {
  if (!p || typeof p !== "string" || isAbsolute(p)) return null;
  const out: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(seg);
  }
  return out.length ? out.join("/") : null;
}

// ─── Validation (E01–E11 + W01–W04) ───────────────────────────────────────────
export function validateTeamFile(raw: unknown): { errors: WsError[]; warnings: WsWarning[] } {
  const errors: WsError[] = [];
  const warnings: WsWarning[] = [];
  const E = (code: string, path: string, message: string) => errors.push({ code, path, message });
  const W = (code: string, path: string, message: string) => warnings.push({ code, path, message });

  const file = raw as Partial<TeamFile> | null;
  if (!file || typeof file !== "object") { E("E01", "", "config is not a JSON object"); return { errors, warnings }; }
  if (file.schemaVersion !== 2) E("E01", "schemaVersion", `expected schemaVersion:2 (got ${JSON.stringify((file as { schemaVersion?: unknown }).schemaVersion)})`);

  const team = file.team as TeamBlock | undefined;
  if (!team || typeof team !== "object") { E("E02", "team", "missing team block"); return { errors, warnings }; }
  if (typeof team.key !== "string" || !TEAM_KEY_RE.test(team.key)) E("E02", "team.key", `team.key must match ${TEAM_KEY_RE}`);
  if (team.backend !== "linear" && team.backend !== "service") E("E02", "team.backend", `team.backend must be "linear" or "service" (got ${JSON.stringify(team.backend)})`);
  if (team.backend === "linear" && (typeof team.linearTeam !== "string" || !team.linearTeam.trim())) E("E09", "team.linearTeam", "backend:\"linear\" requires team.linearTeam");

  // E07 — comms: provider ∈ {slack,lark}; webhookEnv is an ENV-VAR NAME, never a URL literal (I5).
  if (team.comms !== undefined) {
    const c = team.comms as { provider?: unknown; webhookEnv?: unknown };
    if (c.provider !== "slack" && c.provider !== "lark") E("E07", "team.comms.provider", "comms.provider must be \"slack\" or \"lark\"");
    if (typeof c.webhookEnv !== "string" || !ENV_NAME_RE.test(c.webhookEnv) || /:\/\//.test(c.webhookEnv))
      E("E07", "team.comms.webhookEnv", "comms.webhookEnv must be an ENV-VAR NAME (e.g. DEVLOOP_COMMS_WEBHOOK), not a URL/secret (§16)");
  }

  const repos = (file.repos ?? {}) as Record<string, RepoEntry>;
  const projects = (file.projects ?? {}) as Record<string, ProjectEntry>;
  if (!file.repos || typeof file.repos !== "object") E("E02", "repos", "missing repos registry (may be empty {})");
  if (!file.projects || typeof file.projects !== "object") E("E02", "projects", "missing projects map (may be empty {})");

  // Name validation (E11) for repo refs.
  const canonPaths = new Map<string, string>(); // normalizedRel → first ref (E10)
  for (const [ref, r] of Object.entries(repos)) {
    validateName(ref, `repos.${ref}`, E);
    const rel = normalizedRel(r?.path);
    if (!rel) E("E03", `repos.${ref}.path`, `repo path must be a workspace-relative path that stays inside the workspace (got ${JSON.stringify(r?.path)})`);
    else {
      const prev = canonPaths.get(rel);
      if (prev) E("E10", `repos.${ref}.path`, `two repo refs resolve to the same path '${rel}': ${prev} and ${ref}`);
      else canonPaths.set(rel, ref);
    }
  }

  // Projects: name (E11), repo refs (E04), enabled/weight (E08), linearProjectId dup (E10).
  const seenLinearProjectId = new Map<string, string>();
  const refCount = new Map<string, string[]>(); // ref → [project keys referencing it]
  for (const [key, p] of Object.entries(projects)) {
    validateName(key, `projects.${key}`, E, /* allowTeamIntake */ true);
    if (p?.enabled !== undefined && typeof p.enabled !== "boolean") E("E08", `projects.${key}.enabled`, "enabled must be a boolean");
    if (p?.weight !== undefined && (typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight < 0))
      E("E08", `projects.${key}.weight`, "weight must be a finite number >= 0");
    if (typeof p?.linearProjectId === "string" && p.linearProjectId.trim()) {
      const prev = seenLinearProjectId.get(p.linearProjectId);
      if (prev) E("E10", `projects.${key}.linearProjectId`, `linearProjectId '${p.linearProjectId}' is claimed by both ${prev} and ${key}`);
      else seenLinearProjectId.set(p.linearProjectId, key);
    }
    const refs = Array.isArray(p?.repos) ? p.repos : [];
    if (!refs.length) W("W01", `projects.${key}.repos`, `project '${key}' references no repos`);
    for (const rr of refs) {
      const ref = rr?.ref;
      if (typeof ref !== "string" || !(ref in repos)) { E("E04", `projects.${key}.repos`, `references unknown repo ref ${JSON.stringify(ref)}`); continue; }
      (refCount.get(ref) ?? refCount.set(ref, []).get(ref)!).push(key);
    }
  }

  // E05 — a repo referenced by >1 project needs an `owner` that is one of its referrers. NOTE: this
  // deliberately counts ALL referrers, not just enabled ones — validation must not flip when a project is
  // toggled (invariant I2). W02 — a registered repo referenced by nobody.
  for (const [ref, r] of Object.entries(repos)) {
    const referrers = refCount.get(ref) ?? [];
    if (referrers.length === 0) { W("W02", `repos.${ref}`, `repo '${ref}' is registered but referenced by no project`); continue; }
    if (referrers.length > 1) {
      const owner = r?.owner;
      if (typeof owner !== "string" || !owner.trim()) E("E05", `repos.${ref}.owner`, `repo '${ref}' is shared by ${referrers.length} projects (${referrers.join(", ")}); it must declare an owner`);
      else if (!referrers.includes(owner)) E("E05", `repos.${ref}.owner`, `repo '${ref}' owner '${owner}' is not among its referrers (${referrers.join(", ")})`);
    }
  }

  // W07 — a DEPLOYED repo with no health probe leaves ops blind: referenced by an enabled project,
  // carries a deploy block, but has neither a healthCheck (top-level or per-environment) nor ops.checks.
  for (const [ref, r] of Object.entries(repos)) {
    if (!r?.deploy) continue;
    const referrers = refCount.get(ref) ?? [];
    const enabledReferrer = referrers.some((k) => projects[k]?.enabled !== false);
    if (!enabledReferrer) continue;
    const hasProbe = !!r.deploy.healthCheck
      || Object.values(r.deploy.environments ?? {}).some((e) => !!e?.healthCheck)
      || !!(r.ops?.checks?.length);
    if (!hasProbe) W("W07", `repos.${ref}`, `repo '${ref}' deploys but has NO health probe (no deploy healthCheck, no ops.checks) — ops-agent is blind to it; add one via /dev-loop:add-repo --ops-check`);
  }

  // E06 — deployPolicy is a CEILING: policy[env]="manual" forbids any repo auto-deploying that env (§4.3).
  const policy = team.deployPolicy ?? {};
  for (const [env, level] of Object.entries(policy)) {
    if (level !== "auto" && level !== "manual") E("E02", `team.deployPolicy.${env}`, `deployPolicy.${env} must be "auto" or "manual"`);
  }
  for (const [ref, r] of Object.entries(repos)) {
    const envs = r?.deploy?.environments ?? {};
    for (const [env, e] of Object.entries(envs)) {
      if (policy[env] === "manual" && e?.auto === true)
        E("E06", `repos.${ref}.deploy.environments.${env}.auto`, `deployPolicy.${env}="manual" forbids auto-deploy, but repo '${ref}' sets auto:true`);
    }
  }

  return { errors, warnings };
}

function validateName(name: string, path: string, E: (c: string, p: string, m: string) => void, allowTeamIntake = false): void {
  if (allowTeamIntake && name === TEAM_INTAKE_PROJECT) return; // reserved system key, permitted here only
  if (RESERVED_NAMES.has(name)) { E("E11", path, `'${name}' is a reserved name (.dev-loop/ layout); pick another key/ref`); return; }
  if (!KEY_RE.test(name)) E("E11", path, `'${name}' must match ${KEY_RE} (lowercase, no leading _/-/.)`);
}

// ─── loadWorkspace ────────────────────────────────────────────────────────────
export class WsValidationError extends Error {
  errors: WsError[];
  filePath: string;
  constructor(errors: WsError[], filePath: string) {
    super(`dev-loop.json has ${errors.length} error(s):\n` + errors.map((e) => `  [${e.code}] ${e.path ? e.path + ": " : ""}${e.message}`).join("\n"));
    this.name = "WsValidationError";
    this.errors = errors;
    this.filePath = filePath;
  }
}

export function parseWorkspaceFile(text: string, filePath: string): Workspace["file"] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new WsValidationError([{ code: "E00", path: "", message: `not valid JSON: ${(e as Error).message}` }], filePath); }
  const { errors } = validateTeamFile(raw);
  if (errors.length) throw new WsValidationError(errors, filePath);
  return raw as TeamFile;
}

export function loadWorkspace(root: string): Workspace {
  const filePath = join(root, "dev-loop.json");
  const text = readFileSync(filePath, "utf8"); // ENOENT bubbles to the caller (WsNotFound handled in workspace.ts)
  const file = parseWorkspaceFile(text, filePath);
  const { warnings } = validateTeamFile(file);
  return { root, filePath, file, warnings };
}

// ─── Resolution API (impl §2.3) ───────────────────────────────────────────────
export interface ResolvedRepo extends RepoEntry { ref: string; absPath: string }
export interface ResolvedProject extends ProjectEntry { key: string; backend: string; mode?: string; autonomy?: string; docSystem?: string; reports?: unknown }

export function effectiveRepo(ws: Workspace, ref: string): ResolvedRepo {
  const r = ws.file.repos[ref];
  if (!r) throw new Error(`unknown repo ref '${ref}'`);
  return { ...r, ref, absPath: join(ws.root, normalizedRel(r.path) ?? r.path) };
}

// Behavior fields resolve project ∥ team (nearest wins, §4.2). Physical fields live only on the registry.
export function effectiveProject(ws: Workspace, key: string): ResolvedProject {
  const p = ws.file.projects[key];
  if (!p) throw new Error(`unknown project '${key}'`);
  const t = ws.file.team;
  return {
    ...p, key,
    backend: t.backend,
    mode: p.mode ?? t.mode,
    autonomy: p.autonomy ?? t.autonomy,
    docSystem: p.docSystem ?? t.docSystem,
    reports: p.reports ?? t.reports,
    defaultCodingAgent: p.defaultCodingAgent ?? t.defaultCodingAgent,
    codingAgentDefaults: p.codingAgentDefaults ?? t.codingAgentDefaults,
  };
}

export function reposOfProject(ws: Workspace, key: string): Array<{ ref: string; role?: string; absPath: string }> {
  const p = ws.file.projects[key];
  if (!p) throw new Error(`unknown project '${key}'`);
  return (p.repos ?? []).map((rr) => ({ ref: rr.ref, role: rr.role, absPath: effectiveRepo(ws, rr.ref).absPath }));
}

// The fire cwd for a project: the primary repo, else the first referenced repo.
export function primaryRepo(ws: Workspace, key: string): string | null {
  const repos = reposOfProject(ws, key);
  return (repos.find((r) => r.role === "primary") ?? repos.find((r) => r.role === "docs") ?? repos[0])?.absPath ?? null;
}

export function referencingProjects(ws: Workspace, ref: string): string[] {
  return Object.entries(ws.file.projects).filter(([, p]) => (p.repos ?? []).some((r) => r.ref === ref)).map(([k]) => k);
}

export type InferResult = { kind: "unique"; key: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" };
export function inferProjectForRepo(ws: Workspace, ref: string): InferResult {
  const refs = referencingProjects(ws, ref);
  if (refs.length === 1) return { kind: "unique", key: refs[0] };
  if (refs.length > 1) return { kind: "ambiguous", candidates: refs };
  return { kind: "none" };
}

// Ops/alert routing home for a repo: explicit owner, else its sole referrer (E05 guarantees resolvability
// for shared repos). A repo referenced by nobody has no owner → throw (a W02 config the caller must fix).
export function ownerOf(ws: Workspace, ref: string): string {
  const r = ws.file.repos[ref];
  if (!r) throw new Error(`unknown repo ref '${ref}'`);
  if (typeof r.owner === "string" && r.owner.trim()) return r.owner;
  const refs = referencingProjects(ws, ref);
  if (refs.length === 1) return refs[0];
  throw new Error(`repo '${ref}' has no owner and ${refs.length} referrers; cannot route`);
}

// ─── toLegacyView (impl §2.4) — the M1 de-risk ────────────────────────────────
// Produce the OLD ProjectsConfig shape every existing consumer (run-agents/daemon/server/shim/doctor)
// reads, sourced from the v2 workspace with all paths ABSOLUTE. The fire-behavior diff at M1 is thus
// "where config comes from", not "what it looks like" — a revert is one loader swap.
export interface LegacyProjectsConfig {
  defaultProject?: string;
  projects: Record<string, Record<string, unknown>>;
}

export function toLegacyView(ws: Workspace): LegacyProjectsConfig {
  const t = ws.file.team;
  const projects: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(ws.file.projects)) {
    const p = ws.file.projects[key];
    const eff = effectiveProject(ws, key);
    const repos = reposOfProject(ws, key).map((r) => {
      const reg = effectiveRepo(ws, r.ref);
      return {
        path: r.absPath, role: r.role, name: r.ref,
        landing: reg.landing, autoMerge: reg.autoMerge, mergeChecks: reg.mergeChecks,
        build: reg.build, deploy: reg.deploy, ops: reg.ops,
      };
    });
    const primary = primaryRepo(ws, key);
    projects[key] = {
      // Passthrough FIRST: any operator-set field the v2 schema doesn't model explicitly (blockedStateName,
      // a v1-era notify block kept by `team import`, communication, …) must survive into the legacy view —
      // a whitelist here silently strips config that agents/daemon read (the blockedStateName bug).
      ...(p as unknown as Record<string, unknown>),
      backend: t.backend,
      linearTeam: t.linearTeam,
      linearProject: p.linearProject,
      linearProjectId: p.linearProjectId,
      strategyDoc: p.strategyDoc,
      testEnv: p.testEnv,
      devSplit: p.devSplit,
      enabled: p.enabled ?? true,
      weight: p.weight ?? 1,
      mode: eff.mode,
      autonomy: eff.autonomy,
      docSystem: eff.docSystem,
      reports: eff.reports,
      agents: p.agents,
      models: p.models,
      efforts: p.efforts,
      defaultCodingAgent: eff.defaultCodingAgent,
      codingAgentDefaults: eff.codingAgentDefaults,
      deployPolicy: t.deployPolicy,
      comms: t.comms,
      // notify bridge: v1 consumers (the daemon's human-park pings, agent prompts) read a per-project
      // `notify` block. On v2 the canonical channel is team.comms — bridge it to the legacy shape unless
      // the project carries its own passthrough notify (env-var NAME only; never a URL, §16/I5).
      ...(p.notify === undefined && t.comms ? { notify: { type: t.comms.provider, webhookEnv: t.comms.webhookEnv } } : {}),
      // repoPath is COMPUTED from the registry (or absent): a stale hand-written literal riding the
      // passthrough must not hijack cwd→project resolution on a zero-repo project.
      repoPath: primary ?? undefined,
      repos,
    };
  }
  return { projects };
}
