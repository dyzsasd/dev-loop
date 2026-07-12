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

// The hub block (D8): `agentInterface` maps a coding agent → how its fires reach the hub board on
// backend:"service" — "cli" (the dev-loop write-layer verbs; identity rides the fire env) or "mcp"
// (the scheduler-injected dev-loop-hub MCP server). `docs` + the index signature keep operator
// passthrough fields (e.g. the DL-83 `hub.docs` flag the daemon reads off the projected view) type-legal.
export type AgentInterface = "cli" | "mcp";
export interface HubBlock { agentInterface?: Record<string, AgentInterface>; docs?: unknown; [key: string]: unknown }

// D9 (direct full rollout): claude flips to the CLI interface everywhere immediately; codex flipped
// too once the P8 env-propagation certification PASSED (2026-07-11, codex-cli 0.130.0 — codex exec
// propagates the fire env into shell subprocesses; docs/PORTABILITY.md §4); opencode registers MCP via
// the operator's merged config and stays "mcp". An unknown coding agent defaults to "mcp" (today's behavior).
export const DEFAULT_AGENT_INTERFACE: Record<string, AgentInterface> = { claude: "cli", codex: "cli", opencode: "mcp" };

// The ONE resolver every consumer (scheduler, doctor) reads the interface through: an explicit
// hub.agentInterface.<codingAgent> wins (the D8 rollback switch), else the D9 default.
export function agentInterfaceFor(hub: HubBlock | undefined, codingAgent: string): AgentInterface {
  const v = hub?.agentInterface?.[codingAgent];
  return v === "cli" || v === "mcp" ? v : (DEFAULT_AGENT_INTERFACE[codingAgent] ?? "mcp");
}

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
  intake?: { mode?: "autonomous" | "passive"; todoDepthCap?: number };
  comms?: { provider: "slack" | "lark"; webhookEnv: string };
  reports?: unknown;
  agents?: Record<string, AgentLaunchConfig>;
  defaultCodingAgent?: string;
  codingAgentDefaults?: Record<string, { model?: string; effort?: string }>;
  hub?: HubBlock;
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
  intake?: { mode?: "autonomous" | "passive"; todoDepthCap?: number };
  devSplit?: boolean;
  blockedStateName?: string | null;   // a real Linear "Blocked" column name; null → the `blocked` label park (§9)
  notify?: unknown;                   // per-project §9 notify webhook override (E15; team.comms is canonical on v2 and bridges into it)
  communication?: unknown;            // the communication agent's ARTICLE config (E14); NOT the §22a digest gate (that keys on team.comms)
  agents?: unknown;
  models?: unknown;
  efforts?: unknown;
  reports?: unknown;
  mode?: string;
  autonomy?: string;
  docSystem?: string;
  defaultCodingAgent?: string;
  codingAgentDefaults?: unknown;
  hub?: HubBlock;
  repos: ProjectRepoRef[];
}

export interface TeamFile {
  schemaVersion: 2;
  // Workspace fingerprint (concept P4): a random-but-stable id `team init` mints once. On linear backends
  // add-project/sync-project stamp it into the Linear project description marker so a SECOND workspace
  // pointed at the same Linear project is detected (a loud mismatch warning) instead of double-driving it.
  // Optional: configs written by older CLIs lack it, and validation tolerates unknown/extra top-level keys.
  workspaceId?: string;
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
// it exists ONLY as a hub.db row (seeded by `team init`), never as a config project (E11 rejects it).
export const RESERVED_NAMES = new Set(["team", "lessons", "wt", "locks", "reports", "hub.db", "daemon.json", "scheduler.json", "fires.jsonl"]);
export const TEAM_INTAKE_PROJECT = "_team";
// The ONE place the `_team` exclusion lives: any code iterating config projects for delivery/rotation/
// reporting must route through these, so the exclusion cannot drift across call sites — and stays correct
// even for hand-built Workspace objects that never passed validation.
export function isTeamProject(key: string): boolean { return key === TEAM_INTAKE_PROJECT; }
export function deliveryProjects(ws: Workspace): string[] { return Object.keys(ws.file.projects).filter((k) => !isTeamProject(k)); }
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

// ─── Validation (E01–E12 + W01–W04) ───────────────────────────────────────────
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
  // E09 is a load-time WARNING, not an error: `team init --backend linear --yes` legitimately writes a
  // blank linearTeam to fill later, and a hard load failure would lock the operator out of the very
  // commands that repair it (team set / add-project / doctor). The HARD failure lives where a linear
  // fire would actually launch on the blank value: toLegacyView (the runtime projection) throws E09.
  if (team.backend === "linear" && (typeof team.linearTeam !== "string" || !team.linearTeam.trim()))
    W("E09", "team.linearTeam", `backend:"linear" has a blank team.linearTeam — fires cannot target a Linear team until it is filled: dev-loop team set team.linearTeam "<Team Name>"`);

  // E12 — an intake block (team default or per project): mode governs PM origination (§5a).
  const checkIntake = (raw: unknown, path: string) => {
    const it = raw as { mode?: unknown; todoDepthCap?: unknown };
    if (it === null || typeof it !== "object" || Array.isArray(it)) { E("E12", path, "intake must be an object"); return; }
    if (it.mode !== undefined && it.mode !== "autonomous" && it.mode !== "passive")
      E("E12", `${path}.mode`, `intake.mode must be "autonomous" or "passive" (got ${JSON.stringify(it.mode)})`);
    if (it.todoDepthCap !== undefined && (typeof it.todoDepthCap !== "number" || !Number.isInteger(it.todoDepthCap) || it.todoDepthCap < 1))
      E("E12", `${path}.todoDepthCap`, `intake.todoDepthCap must be an integer >= 1 (got ${JSON.stringify(it.todoDepthCap)})`);
  };
  if (team.intake !== undefined) checkIntake(team.intake, "team.intake");

  // E13 — a hub block (team default or per project): agentInterface maps coding agent → "cli"|"mcp" (D8).
  // Keys are validated STRICTLY (mirror run-agents.ts CODING_AGENTS — the drift tripwire): a typo'd key
  // would otherwise silently not apply and the fire would launch on the default interface.
  const CODING_AGENT_KEYS = new Set(["claude", "codex", "opencode"]);
  const checkHub = (raw: unknown, path: string) => {
    const h = raw as { agentInterface?: unknown };
    if (h === null || typeof h !== "object" || Array.isArray(h)) { E("E13", path, "hub must be an object"); return; }
    if (h.agentInterface === undefined) return;
    const ai = h.agentInterface as Record<string, unknown> | null;
    if (ai === null || typeof ai !== "object" || Array.isArray(ai)) { E("E13", `${path}.agentInterface`, "hub.agentInterface must be an object mapping coding agent → \"cli\"|\"mcp\""); return; }
    for (const [ca, v] of Object.entries(ai)) {
      if (!CODING_AGENT_KEYS.has(ca)) E("E13", `${path}.agentInterface.${ca}`, `unknown coding agent '${ca}' (expected claude, codex, or opencode)`);
      else if (v !== "cli" && v !== "mcp") E("E13", `${path}.agentInterface.${ca}`, `agent interface must be "cli" or "mcp" (got ${JSON.stringify(v)})`);
    }
  };
  if (team.hub !== undefined) checkHub(team.hub, "team.hub");

  // E14 — a per-project `communication` block: the communication agent's ARTICLE config (cadence,
  // language, output shape — read by skills/communication-agent §0). Keys are validated STRICTLY:
  // presence of this block decides whether the agent drafts at all, so a typo'd key must fail loudly
  // instead of silently changing what a fire does. NOTE it is deliberately NOT the §22a team-digest
  // gate — the digest keys on team.comms presence (the channel), never on this block.
  const COMMUNICATION_KEYS = "cadence, language, audience, tone, maxWords, sourceWindowDays, output, outputDir, repoOutputDir, includeUnreleased";
  const checkCommunication = (raw: unknown, path: string) => {
    const c = raw as Record<string, unknown>;
    if (c === null || typeof c !== "object" || Array.isArray(c)) { E("E14", path, "communication must be an object"); return; }
    for (const [k, v] of Object.entries(c)) {
      switch (k) {
        case "cadence": case "language": case "audience": case "tone": case "outputDir": case "repoOutputDir":
          if (typeof v !== "string" || !v.trim()) E("E14", `${path}.${k}`, `communication.${k} must be a non-empty string`);
          break;
        case "maxWords": case "sourceWindowDays":
          if (typeof v !== "number" || !Number.isInteger(v) || v < 1) E("E14", `${path}.${k}`, `communication.${k} must be an integer >= 1`);
          break;
        case "output":
          if (v !== "data" && v !== "repo") E("E14", `${path}.output`, `communication.output must be "data" or "repo" (got ${JSON.stringify(v)})`);
          break;
        case "includeUnreleased":
          if (typeof v !== "boolean") E("E14", `${path}.includeUnreleased`, "communication.includeUnreleased must be a boolean");
          break;
        default:
          E("E14", `${path}.${k}`, `unknown communication key '${k}' (expected ${COMMUNICATION_KEYS})`);
      }
    }
  };

  // E15 — a per-project `notify` block: the §9 one-way webhook the daemon's human-park pings ride.
  // On v2 team.comms is canonical (toLegacyView bridges it into notify), so a project-level block is an
  // explicit OVERRIDE — validated strictly for the same silent-suppression reason as E14. §16/I5: env-var
  // NAMES only; an inline webhook/secret literal is rejected outright (a copied workspace folder must
  // never carry a credential).
  const checkNotify = (raw: unknown, path: string) => {
    const n = raw as Record<string, unknown>;
    if (n === null || typeof n !== "object" || Array.isArray(n)) { E("E15", path, "notify must be an object"); return; }
    for (const [k, v] of Object.entries(n)) {
      switch (k) {
        case "type":
          if (v !== "slack" && v !== "lark") E("E15", `${path}.type`, `notify.type must be "slack" or "lark" (got ${JSON.stringify(v)})`);
          break;
        case "webhookEnv": case "secretEnv":
          if (typeof v !== "string" || !ENV_NAME_RE.test(v) || /:\/\//.test(v))
            E("E15", `${path}.${k}`, `notify.${k} must be an ENV-VAR NAME (e.g. DEVLOOP_COMMS_WEBHOOK), not a URL/secret (§16)`);
          break;
        case "webhook": case "secret":
          E("E15", `${path}.${k}`, `inline notify.${k} literals never live in dev-loop.json (§16/I5) — export the value in an env var and set notify.${k}Env to its NAME`);
          break;
        case "events":
          if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) E("E15", `${path}.events`, "notify.events must be an array of event-name strings");
          break;
        default:
          E("E15", `${path}.${k}`, `unknown notify key '${k}' (expected type, webhookEnv, secretEnv, events)`);
      }
    }
    if (!("type" in n)) E("E15", `${path}.type`, `notify.type is required ("slack" or "lark")`);
    if (!("webhookEnv" in n)) E("E15", `${path}.webhookEnv`, "notify.webhookEnv (an ENV-VAR NAME) is required — without it the block is a dead send target");
  };

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
    validateName(key, `projects.${key}`, E);
    if (p?.enabled !== undefined && typeof p.enabled !== "boolean") E("E08", `projects.${key}.enabled`, "enabled must be a boolean");
    if (p?.weight !== undefined && (typeof p.weight !== "number" || !Number.isFinite(p.weight) || p.weight < 0))
      E("E08", `projects.${key}.weight`, "weight must be a finite number >= 0");
    if (typeof p?.linearProjectId === "string" && p.linearProjectId.trim()) {
      const prev = seenLinearProjectId.get(p.linearProjectId);
      if (prev) E("E10", `projects.${key}.linearProjectId`, `linearProjectId '${p.linearProjectId}' is claimed by both ${prev} and ${key}`);
      else seenLinearProjectId.set(p.linearProjectId, key);
    }
    if (p?.intake !== undefined) checkIntake(p.intake, `projects.${key}.intake`);
    if (p?.hub !== undefined) checkHub(p.hub, `projects.${key}.hub`);
    if (p?.communication !== undefined) checkCommunication(p.communication, `projects.${key}.communication`);
    if (p?.notify !== undefined) checkNotify(p.notify, `projects.${key}.notify`);
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

function validateName(name: string, path: string, E: (c: string, p: string, m: string) => void): void {
  if (name === TEAM_INTAKE_PROJECT) { E("E11", path, `'${TEAM_INTAKE_PROJECT}' is the reserved hub intake project — it lives only as a hub.db row (team init seeds it), never in dev-loop.json`); return; }
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
    // intake merges FIELD-WISE (not whole-block nearest-wins): mode and todoDepthCap are orthogonal
    // knobs, so a project tuning only its cap must not silently drop a team-level "passive".
    ...(p.intake || t.intake ? { intake: { ...t.intake, ...p.intake } } : {}),
    // hub merges FIELD-WISE too, one level deeper for agentInterface (a per-coding-agent map): a project
    // flipping only claude must not silently drop a team-level codex setting (D8 rollback granularity).
    ...(p.hub || t.hub ? {
      hub: {
        ...t.hub, ...p.hub,
        ...(t.hub?.agentInterface || p.hub?.agentInterface
          ? { agentInterface: { ...t.hub?.agentInterface, ...p.hub?.agentInterface } } : {}),
      },
    } : {}),
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
  // The E09 hard-fail seam: a blank linearTeam LOADS (warning, so team set/add-project/doctor can repair
  // it) but must never reach a running agent — an unscoped Linear query pollutes other teams' boards.
  // toLegacyView is the one projection every runtime consumer reads (the team scheduler's teamMain,
  // resolve-project's loadProjectsConfig — which already catches WsValidationError and degrades loudly),
  // so throwing here fails exactly the paths that would exercise the backend, and nothing else.
  if (t.backend === "linear" && !(t.linearTeam ?? "").trim())
    throw new WsValidationError([{ code: "E09", path: "team.linearTeam", message: `backend:"linear" has a blank team.linearTeam — a fire cannot target a Linear team. Fill it: dev-loop team set team.linearTeam "<Team Name>"` }], ws.filePath);
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
      intake: eff.intake,
      hub: eff.hub,
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
