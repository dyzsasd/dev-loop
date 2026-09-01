// Schema v2 — the team/workspace config kernel (design: docs/design/team-workspace-impl.md §2).
//
// A `dev-loop.json` at a workspace root declares ONE team (= one Linear team / one backend), a `repos`
// REGISTRY (the physical git-clone folders — each registered exactly once, I2), and `projects` (VIRTUAL
// units that REFERENCE repos by ref; a repo may be shared by N projects). This module is PURE (no fs, no
// process env) except `loadWorkspace`, which reads + validates the file. Everything downstream resolves
// config through here, and legacy consumers get an unchanged view via `toLegacyView` (the M1 de-risk).
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AGENT_HANDLES, AGENT_HANDLE_SET, LANES, LANE_SET, LANE_ACTOR, STEWARD_HANDLES, type Lane } from "./agent-handles.ts";
import { actionClasses } from "./approvals.ts"; // LOOP-394 — the ONE action-class registry (design §4)

// ─── Types (impl §2.1) ───────────────────────────────────────────────────────
export type DocRef = string | { linearDocument: string } | { hubDoc: string } | { path: string };

// `manual:true` (P1-4): the operator runs this role by hand (no scheduled fires) — owner-liveness
// (doctor W16 / the Sweep digest) reports its stranded tickets as "awaiting a human", never as a warn.
export interface AgentLaunchConfig { codingAgent?: string; model?: string; effort?: string; cadence?: string; manual?: boolean;
  // The scheduling switch. `false` ⇒ the scheduler does not fire this lane; absent/true ⇒ it does.
  // Distinct from `manual` on purpose — see laneScheduleBlock for which question each one answers.
  enabled?: boolean;
  fireTimeout?: string; stallTimeout?: string;
  // LOOP-237 — point THIS agent at the on-demand conventions slice instead of pushing the corpus.
  // Per-agent and default OFF: with it off the fire prompt is byte-identical to today.
  conventionsPull?: boolean;
  // WS-A C4 — per-agent codex sandbox posture; beats team.codex.sandbox for this agent's fires.
  codexSandbox?: CodexSandbox;
}

// WS-A C4 — the codex lane's sandbox posture. "safe" (the default) passes NO bypass flags; "bypass" adds
// `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` (the pre-WS-A unconditional shape).
export const CODEX_SANDBOX_MODES = ["safe", "bypass"] as const;
export type CodexSandbox = (typeof CODEX_SANDBOX_MODES)[number];
// WS-A C4 — the claude lane's `--permission-mode` vocabulary (claude-code's own enum, validated strictly so a
// typo is refused at load rather than passed to a CLI that would reject the whole fire).
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
// WS-A A7 — a per-lane price table for `dev-loop metrics --usage` cost-by-channel. `inputUsdPerMTok` is the
// price of one million UNCACHED input tokens; the channel multipliers default to the Anthropic-style
// 1.25× (cache write) / 0.1× (cache read) / 5× (output) when absent.
export interface LanePricing { inputUsdPerMTok: number; cacheWriteMultiplier?: number; cacheReadMultiplier?: number; outputMultiplier?: number }

// The hub block (D8): `agentInterface` maps a coding agent → how its fires reach the hub board on
// backend:"service" — "cli" (the dev-loop write-layer verbs; identity rides the fire env) or "mcp"
// (the scheduler-injected dev-loop-hub MCP server). `docs` + the index signature keep operator
// passthrough fields (e.g. the DL-83 `hub.docs` flag the daemon reads off the projected view) type-legal.
export type AgentInterface = "cli" | "mcp";
// LOOP-339 — the board-snapshot cadence, through the validated mutator like every other tunable.
// everyHours 0 disables it; the defaults (6h, keep 10) are the ones resolveBackupConfig applies.
export interface BackupBlock { everyHours?: number; keep?: number; dir?: string }

export interface HubBlock { agentInterface?: Record<string, AgentInterface>; docs?: unknown; [key: string]: unknown }

// D9 (direct full rollout): claude flips to the CLI interface everywhere immediately; codex flipped
// too once the P8 env-propagation certification PASSED (2026-07-11, codex-cli 0.130.0 — codex exec
// propagates the fire env into shell subprocesses; docs/PORTABILITY.md §4); opencode flipped 2026-07-16
// once ITS P8-style certification passed (opencode 1.2.24 — `opencode run` propagates the fire env into
// its bash tool; docs/PORTABILITY.md §5; "mcp" stays the rollback setting). An unknown coding agent
// defaults to "mcp" (the conservative transport).
export const DEFAULT_AGENT_INTERFACE: Record<string, AgentInterface> = { claude: "cli", codex: "cli", opencode: "cli" };

// The ONE resolver every consumer (scheduler, doctor) reads the interface through: an explicit
// hub.agentInterface.<codingAgent> wins (the D8 rollback switch), else the D9 default.
export function agentInterfaceFor(hub: HubBlock | undefined, codingAgent: string): AgentInterface {
  const v = hub?.agentInterface?.[codingAgent];
  return v === "cli" || v === "mcp" ? v : (DEFAULT_AGENT_INTERFACE[codingAgent] ?? "mcp");
}

// E16 — the team provider registry (docs/design/model-provider-routing.md): CUSTOM OpenAI-compatible
// model endpoints, rendered into the WORKSPACE opencode.json by `dev-loop team sync-opencode`. Built-in
// opencode providers (openrouter, zhipuai, deepseek, …) need NO entry — auth + a `provider/model-id`
// launch string suffice. The entry id doubles as the opencode provider key AND the model-string prefix.
// §16: authTokenEnv is an env-var NAME (value lives in .dev-loop/secrets.env or the process env), never
// a secret. kind:"anthropic" (the claude-runner env-injection route) is deferred — design Appendix A.
export interface ProviderEntry {
  kind: "openai-compatible";
  baseUrl: string;
  authTokenEnv: string;
  models: string[];
  extraOptions?: Record<string, unknown>;
  effortMode?: "passthrough" | "strip";
}

// ─── The two governing knobs: one vocabulary (LOOP-408) ──────────────────────
// §12 `mode` and §12a `autonomy` are read by agents and projected into the hub `projects` row,
// whose CHECK constraints already enumerate exactly these tokens (db.ts:72-73). Three surfaces
// used to spell `autonomy` three ways; these constants are the single source, imported by
// team-edit (the settable enum) and team-init (the flag) rather than re-typed.
export const MODES = ["dry-run", "live"] as const;
export type Mode = (typeof MODES)[number];
export const AUTONOMIES = ["ask", "full"] as const;
export type Autonomy = (typeof AUTONOMIES)[number];
// `guarded` is a LEGACY INPUT alias only: accepted at every boundary, normalized on the way
// through, never stored and never resolved. It exists so a workspace written by an older
// `team init` keeps loading without a migration touching the operator's file.
export const AUTONOMY_INPUTS = ["ask", "full", "guarded"] as const;
// Whether `Human-Blocked` exists as a PARKING PLACE. Orthogonal to autonomy on purpose: `autonomy`
// decides how boldly an agent decides, `humanBlocked` decides whether there is still anybody to wait
// for. `ask` + `off` is a legal, meaningful pair — PM decides cautiously, by itself. The STATE always
// exists (history is never migrated); `off` changes who may park a ticket there and who may take it out.
export const HUMAN_BLOCKED_MODES = ["on", "off"] as const;
export type HumanBlockedMode = (typeof HUMAN_BLOCKED_MODES)[number];
export type AutonomyInput = (typeof AUTONOMY_INPUTS)[number];

// The alias DIRECTION is the safety property, not an implementation detail: `guarded` meant
// "check with the operator before acting", which is §12a's `ask`. Mapping it to `full` would
// silently grant every default-initialized workspace standing authority to act without asking.
// Asserted explicitly by name in test/team-config.ts.
export function normalizeAutonomy(v: AutonomyInput | undefined): Autonomy | undefined {
  return v === undefined ? undefined : v === "guarded" ? "ask" : v;
}

export interface TeamBlock {
  key: string;
  backend: "linear" | "service";
  linearTeam?: string;
  linearTeamId?: string | null;
  deployPolicy?: Record<string, "auto" | "manual">;
  docSystem?: "local" | "backend";
  docs?: { vision?: DocRef | null; lessons?: { mirror?: boolean } };
  autonomy?: AutonomyInput;
  mode?: Mode;
  intake?: { mode?: "autonomous" | "passive"; todoDepthCap?: number; acCompletenessGate?: boolean };
  comms?: { provider: "slack" | "lark"; webhookEnv: string };
  reports?: unknown;
  agents?: Record<string, AgentLaunchConfig>;
  humanBlocked?: HumanBlockedMode;   // "on" (default) ⇒ Human-Blocked is a parking place; "off" ⇒ PM rules instead
  defaultCodingAgent?: string;
  codingAgentDefaults?: Record<string, { model?: string; effort?: string }>;
  hub?: HubBlock;
  providers?: Record<string, ProviderEntry>;
  // Per-fire OPENCODE_PERMISSION override (whole-object replacement of the scheduler's certified
  // wildcard-deny default — run-agents.ts DEFAULT_OPENCODE_PERMISSION; PORTABILITY §5).
  opencodePermission?: Record<string, unknown>;
  git?: { defaultBranch?: string }; // top-level default (§19 fallback chain — per-repo wins, else this, else "main")
  agentReviewers?: string[]; // GitHub logins excluded from forge-review merge-guard trips (§3.2); set via `dev-loop team set team.agentReviewers`
  // LOOP-272 — the §0a PUSH path (assembleBootCorpus). Team-level. WS-A (2026-08-27): default ON for
  // every lane; `false` is the explicit opt-out (a fire then boots in §0a pull mode).
  bootCorpus?: boolean;
  // WS-A C4 — codex sandbox posture (default "safe") and the claude permission surface (absent ⇒ no flag).
  codex?: { sandbox?: CodexSandbox };
  claude?: { allowedTools?: string[]; permissionMode?: ClaudePermissionMode };
  // WS-A A7 — optional per-lane pricing (`claude` / `codex` / `opencode`) for the cost-by-channel estimate.
  pricing?: Record<string, LanePricing>;
  backup?: BackupBlock;                                       // LOOP-339: board-snapshot cadence/retention (everyHours 0 = OFF)
  budget?: { dailyUsd?: number | null; perFireUsd?: number }; // cost-governance ceilings (design budget-ceiling); dailyUsd = rolling 24h cap (null/unset = OFF), perFireUsd = per-fire cap
  // LOOP-394 (design approvals §8) — the ONE approvals switch: a per-action-class ENFORCEMENT enable
  // list, default EMPTY. The RECORD (grant/list/revoke/request) has no switch and is unconditional;
  // enforcement reads the record, so modelling them as two knobs would make `enforce` non-empty with
  // the record off representable. Per-class rather than global is required, not stylistic: enabling
  // `reopen` is nearly free, whereas enabling `push` changes what every fire in the workspace may land.
  approvals?: { enforce?: string[] };
}

export interface RepoEntry {
  path: string;
  remote?: string;
  owner?: string;
  defaultBranch?: string; // per-repo override (§19 resolution table); falls back to team.git.defaultBranch, then "main"
  landing?: "pr" | "direct";
  autoMerge?: boolean;
  mergeChecks?: string[];
  ciIrrelevantPaths?: string[]; // LOOP-335: paths whose change cannot alter a check result (exact file, or dir with a trailing /)
  build?: { typecheck?: string; build?: string; test?: string; quality?: string }; // Step-5 gate order: typecheck → build → test → quality (quality = the optional CRAP/mutation gate, quality-gauntlet design)
  deploy?: { style?: string; healthCheck?: string; environments?: Record<string, { auto?: boolean; deployPrPrefix?: string; command?: string; healthCheck?: string }> };
  ops?: { checks?: string[]; criticalRoutes?: string[]; logsCommand?: string };
}

export interface ProjectRepoRef { ref: string; role?: string }

export interface ProjectEntry {
  enabled?: boolean;
  weight?: number;
  scratch?: boolean;
  linearProject?: string;
  linearProjectId?: string | null;
  syncedAt?: string;
  strategyDoc?: DocRef;
  testEnv?: { baseUrl?: string; authConstraint?: string };
  intake?: { mode?: "autonomous" | "passive"; todoDepthCap?: number; acCompletenessGate?: boolean };
  devSplit?: boolean;
  blockedStateName?: string | null;   // a real Linear "Blocked" column name; null → the `blocked` label park (§9)
  notify?: unknown;                   // per-project §9 notify webhook override (E15; team.comms is canonical on v2 and bridges into it)
  communication?: unknown;            // the communication agent's ARTICLE config (E14); NOT the §22a digest gate (that keys on team.comms)
  // Typed like team.agents (it was `unknown`): validateAgentConfigs checks BOTH sides against the same
  // shape, and effectiveProject merges them per lane, so a reader that can hold one can hold the other.
  agents?: Record<string, AgentLaunchConfig>;
  humanBlocked?: HumanBlockedMode;   // per-project override of team.humanBlocked
  models?: unknown;
  efforts?: unknown;
  reports?: unknown;
  mode?: Mode;
  autonomy?: AutonomyInput;
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
/**
 * The SCHEDULABLE delivery projects (LOOP-271).
 *
 * This used to return every configured project, so every new consumer was scratch/enabled-blind BY
 * DEFAULT and had to remember to re-filter. Two call sites did remember (rotation.ts, doctor.ts's
 * NEXT ladder); the rest did not, so `metrics` rendered panels for a project that can never fire and
 * `ensureHub` started a real daemon for one.
 *
 * Excluding at the SEAM rather than at each call site is the whole fix. The excluded pair is the one
 * `stewardProjects` already filtered and that config-schema.md defines as removing a project from
 * scheduling entirely: `scratch: true` and `enabled: false`.
 *
 * A caller that genuinely needs the full set asks for it — opt-IN, never opt-out. Getting that
 * direction wrong is what produced this ticket: the default has to be the safe answer, because the
 * unsafe one is what a new consumer gets for free.
 */
export function deliveryProjects(ws: Workspace, opts: { includeUnschedulable?: boolean } = {}): string[] {
  const keys = Object.keys(ws.file.projects).filter((k) => !isTeamProject(k));
  if (opts.includeUnschedulable) return keys;
  return keys.filter((k) => ws.file.projects[k]?.enabled !== false && ws.file.projects[k]?.scratch !== true);
}
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
// ─── validateTeamFile (1.8 quality-gauntlet split) ────────────────────────────────────────────────
// Was ONE CC-105 function (97.5% covered and still CRAP 105 — complexity alone kept it on the
// self-audit's worst list). Now: one module-scope validator per config section, an orchestrator that
// calls them in the ORIGINAL emission order (the E/W sequence is observable via WsValidationError
// messages — order preservation is part of behavior), and the same closures hoisted with an Emit param.
type Emit = (code: string, path: string, message: string) => void;

// E19 — the two governing knobs (§12 `mode`, §12a `autonomy`), validated identically wherever they
// appear (team block and every project). Until LOOP-408 an unrecognized token was accepted in
// silence and then resolved to itself, so `"fulll"` reached an agent's prose as an autonomy posture
// no section defines — the operator's typo decided nothing and said nothing. The path in the message
// is the exact key to fix, which is the whole point of naming it here rather than at the read site.
function checkGovernanceTokens(o: { mode?: unknown; autonomy?: unknown; humanBlocked?: unknown }, base: string, E: Emit): void {
  if (o.mode !== undefined && !(MODES as readonly unknown[]).includes(o.mode))
    E("E19", `${base}.mode`, `mode must be one of ${MODES.join("|")} (got ${JSON.stringify(o.mode)})`);
  if (o.autonomy !== undefined && !(AUTONOMY_INPUTS as readonly unknown[]).includes(o.autonomy))
    E("E19", `${base}.autonomy`, `autonomy must be one of ${AUTONOMIES.join("|")} (got ${JSON.stringify(o.autonomy)}) — "guarded" is also accepted as a legacy alias and resolves to "ask"`);
  if (o.humanBlocked !== undefined && !(HUMAN_BLOCKED_MODES as readonly unknown[]).includes(o.humanBlocked))
    E("E19", `${base}.humanBlocked`, `humanBlocked must be one of ${HUMAN_BLOCKED_MODES.join("|")} (got ${JSON.stringify(o.humanBlocked)}) — "off" means Human-Blocked is not a parking place and PM rules instead (§9)`);
}

// E12 — an intake block (team default or per project): mode governs PM origination (§5a).
function checkIntake(raw: unknown, path: string, E: Emit): void {
  const it = raw as { mode?: unknown; todoDepthCap?: unknown };
  if (it === null || typeof it !== "object" || Array.isArray(it)) { E("E12", path, "intake must be an object"); return; }
  if (it.mode !== undefined && it.mode !== "autonomous" && it.mode !== "passive")
    E("E12", `${path}.mode`, `intake.mode must be "autonomous" or "passive" (got ${JSON.stringify(it.mode)})`);
  if (it.todoDepthCap !== undefined && (typeof it.todoDepthCap !== "number" || !Number.isInteger(it.todoDepthCap) || it.todoDepthCap < 1))
    E("E12", `${path}.todoDepthCap`, `intake.todoDepthCap must be an integer >= 1 (got ${JSON.stringify(it.todoDepthCap)})`);
}

// E13 — a hub block (team default or per project): agentInterface maps coding agent → "cli"|"mcp" (D8).
// Keys are validated STRICTLY (mirror run-agents.ts CODING_AGENTS — the drift tripwire): a typo'd key
// would otherwise silently not apply and the fire would launch on the default interface.
const CODING_AGENT_KEYS = new Set(["claude", "codex", "opencode"]);
function checkHub(raw: unknown, path: string, E: Emit): void {
  const h = raw as { agentInterface?: unknown };
  if (h === null || typeof h !== "object" || Array.isArray(h)) { E("E13", path, "hub must be an object"); return; }
  if (h.agentInterface === undefined) return;
  const ai = h.agentInterface as Record<string, unknown> | null;
  if (ai === null || typeof ai !== "object" || Array.isArray(ai)) { E("E13", `${path}.agentInterface`, "hub.agentInterface must be an object mapping coding agent → \"cli\"|\"mcp\""); return; }
  for (const [ca, v] of Object.entries(ai)) {
    if (!CODING_AGENT_KEYS.has(ca)) E("E13", `${path}.agentInterface.${ca}`, `unknown coding agent '${ca}' (expected claude, codex, or opencode)`);
    else if (v !== "cli" && v !== "mcp") E("E13", `${path}.agentInterface.${ca}`, `agent interface must be "cli" or "mcp" (got ${JSON.stringify(v)})`);
  }
}

// E14 — a per-project `communication` block: the communication agent's ARTICLE config (cadence,
// language, output shape — read by skills/communication-agent §0). Keys are validated STRICTLY:
// presence of this block decides whether the agent drafts at all, so a typo'd key must fail loudly
// instead of silently changing what a fire does. NOTE it is deliberately NOT the §22a team-digest
// gate — the digest keys on team.comms presence (the channel), never on this block.
const COMMUNICATION_KEYS = "cadence, language, audience, tone, maxWords, sourceWindowDays, output, outputDir, repoOutputDir, includeUnreleased";
function checkCommunication(raw: unknown, path: string, E: Emit): void {
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
}

// E15 — a per-project `notify` block: the §9 one-way webhook the daemon's human-park pings ride.
// On v2 team.comms is canonical (toLegacyView bridges it into notify), so a project-level block is an
// explicit OVERRIDE — validated strictly for the same silent-suppression reason as E14. §16/I5: env-var
// NAMES only; an inline webhook/secret literal is rejected outright (a copied workspace folder must
// never carry a credential).
function checkNotify(raw: unknown, path: string, E: Emit): void {
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
}

// E17 — per-agent timeout fields (fireTimeout / stallTimeout): a duration string (same format as the CLI
// --fire-timeout/--stall-timeout flags) or "0" to disable. Validated at load time so a typo surfaces as a
// clear schema error naming the agent+field, never a silent runtime ignore.
const TIMEOUT_DUR_RE = /^\d+(?:\.\d+)?(ms|s|m|h|d)?$/;
// LOOP-336 — exported so run-agents.ts's applyConfigCadence tests the SAME expression the validator
// accepts. Two hand-copied regexes for one contract is exactly how a validator and its read site drift.
export const CADENCE_DUR_RE = /^\d+(?:\.\d+)?(ms|s|m|h|d)?$/;
function parsedDurationMs(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] ?? "m";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
  return Math.round(n * mult);
}
function validateAgentConfigs(agents: unknown, path: string, E: Emit, isProjectScope = false, W?: Emit): void {
  if (agents === null || typeof agents !== "object" || Array.isArray(agents)) { E("E17", path, "agents must be an object"); return; }
  for (const [agent, cfg] of Object.entries(agents as Record<string, unknown>)) {
    const apath = `${path}.${agent}`;
    // LOOP-82 — validate the KEY, not only its fields. A schema that checks a field's VALUE says
    // nothing about whether the key it hangs off is a real agent, so `junoir-dev` passed with zero
    // errors AND zero warnings and then silently never applied: every read site (applyConfigCadence,
    // applyConfigTimeouts, the per-fire codingAgent/model/effort resolution) looks the REAL name up,
    // so a misspelled key is simply never consulted. A warning, not an error — a config carrying a
    // retired agent name must not lock the operator out of the commands that repair it (the E09 shape).
    // pm/qa job-lanes (job-scoped prompts) are valid config keys too: a lane is an agent-roster key the
    // scheduler reads for per-lane model/effort/cadence/timeouts (it fires as its owning actor).
    if (W && !AGENT_HANDLE_SET.has(agent) && !LANE_SET.has(agent))
      W("W04", apath, `'${agent}' is not a known agent — this block is never applied (known: ${[...AGENT_HANDLES, ...LANES].join(", ")}). Check the spelling.`);
    if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) { E("E17", apath, "agent config must be an object"); continue; }
    const a = cfg as Record<string, unknown>;
    // Both scheduling switches are typed. `manual` was accepted-and-unread for its scheduling meaning
    // until 2026-08-29 (the scheduler contained no occurrence of the word), which is how an operator
    // set it to stop a lane, watched the lane fire 11 minutes later, and got no line explaining why.
    for (const field of ["manual", "enabled"] as const) {
      if (a[field] !== undefined && typeof a[field] !== "boolean")
        E("E17", `${apath}.${field}`, `agents.${agent}.${field} must be a boolean (got ${JSON.stringify(a[field])})`);
      // A steward (sweep/ops/reflect/communication) fires at TEAM scope against `_team`, never per
      // delivery project, so a project-scope park could only be accepted and ignored — the defect this
      // switch exists to fix. Refused the same way project-scope `cadence` already is.
      if (isProjectScope && a[field] !== undefined && (STEWARD_HANDLES as readonly string[]).includes(agent))
        E("E17", `${apath}.${field}`, `projects.<key>.agents.${agent}.${field} is not honoured — ${agent} is a steward and fires at team scope, not per project; set it under team.agents.${agent}.${field} instead`);
    }
    for (const field of ["fireTimeout", "stallTimeout"] as const) {
      if (a[field] !== undefined) {
        const v = a[field];
        const t = typeof v === "string" ? v.trim() : "";
        if (typeof v !== "string" || (t !== "0" && !TIMEOUT_DUR_RE.test(t)))
          E("E17", `${apath}.${field}`, `agents.${agent}.${field} must be a duration string (e.g. "30m", "1h") or "0" to disable (got ${JSON.stringify(v)})`);
        else if (t !== "0" && parsedDurationMs(t) <= 0)
          E("E17", `${apath}.${field}`, `agents.${agent}.${field} must be a positive duration or "0" to disable — zero-valued spellings like "0ms" are not allowed (got ${JSON.stringify(v)})`);
        else if (t !== "0" && parsedDurationMs(t) > 2_147_483_647)
          E("E17", `${apath}.${field}`, `agents.${agent}.${field} exceeds Node's 32-bit timer limit (~24.8d); setTimeout coerces it to 1ms, killing the fire immediately (got ${JSON.stringify(v)})`);
      }
    }
    // LOOP-336 — cadence had no format check while its two siblings three lines up did, so a malformed
    // value produced a clean `doctor` and an agent silently running at its built-in default. The read
    // site (run-agents.ts applyConfigCadence) accepts exactly CADENCE_DUR_RE and warns-and-ignores
    // anything else; the validator must accept exactly what the read site accepts and nothing more,
    // or the two spellings drift. Unlike fireTimeout there is no "0" disable form: a zero cadence is
    // not a disable, it is a hot loop, so it is refused with the other non-positive values.
    if (!isProjectScope && a.cadence !== undefined) {
      const v = a.cadence;
      const t = typeof v === "string" ? v.trim() : "";
      if (typeof v !== "string" || !CADENCE_DUR_RE.test(t))
        E("E17", `${apath}.cadence`, `agents.${agent}.cadence must be a duration string (e.g. "10m", "1h", "1d") — the scheduler ignores anything else and runs the built-in default (got ${JSON.stringify(v)})`);
      else if (parsedDurationMs(t) <= 0)
        E("E17", `${apath}.cadence`, `agents.${agent}.cadence must be a POSITIVE duration — a zero cadence is a hot loop, not a disable (got ${JSON.stringify(v)})`);
      else if (parsedDurationMs(t) > 2_147_483_647)
        E("E17", `${apath}.cadence`, `agents.${agent}.cadence exceeds Node's 32-bit timer limit (~24.8d); setTimeout coerces it to 1ms, firing the agent continuously (got ${JSON.stringify(v)})`);
    }
    if (isProjectScope && a.cadence !== undefined)
      E("E17", `${apath}.cadence`, `projects.<key>.agents.<agent>.cadence is not honoured in team mode — the team runs one scheduler that rotates across projects by weight; set cadence under team.agents instead, or express per-project frequency with the project's rotation weight`);
    // WS-A C4 — the per-agent codex sandbox override shares the team-level vocabulary.
    if (a.codexSandbox !== undefined && !(CODEX_SANDBOX_MODES as readonly unknown[]).includes(a.codexSandbox))
      E("E17", `${apath}.codexSandbox`, `agents.${agent}.codexSandbox must be "safe" or "bypass" (got ${JSON.stringify(a.codexSandbox)})`);
  }
}

// LOOP-339 — team.backup: everyHours >= 0 (0 disables), keep >= 1, dir a non-empty string. Validated
// on the same E18 channel as its sibling scalar block, so a malformed value is refused at load rather
// than silently disabling the only thing standing between this board and the next cascade delete.
const BACKUP_KEYS = new Set(["everyHours", "keep", "dir"]);
function validateBackup(backup: unknown, E: Emit): void {
  const b = backup as { everyHours?: unknown; keep?: unknown; dir?: unknown } | null;
  if (b === null || typeof b !== "object" || Array.isArray(b)) { E("E18", "team.backup", "backup must be an object"); return; }
  for (const k of Object.keys(b as object))
    if (!BACKUP_KEYS.has(k)) E("E18", `team.backup.${k}`, `unknown backup key '${k}' (expected ${[...BACKUP_KEYS].join(", ")})`);
  if (b.everyHours !== undefined && (typeof b.everyHours !== "number" || !Number.isFinite(b.everyHours) || b.everyHours < 0))
    E("E18", "team.backup.everyHours", `backup.everyHours must be a non-negative number (0 disables the cadence) (got ${JSON.stringify(b.everyHours)})`);
  // …and an UPPER bound, for the reason parseDuration already refuses one (run-agents.ts): the value
  // becomes a setTimeout delay, and Node coerces anything past its 32-bit limit to 1ms. `everyHours: 600`
  // does not mean "every 25 days", it means a board snapshot EVERY MILLISECOND — the cadence inverts at
  // the top of the range instead of saturating. The lower bound was validated here and the upper one was
  // not, so the only shape that turns this block into a disk-filling loop was the shape that passed.
  else if (typeof b.everyHours === "number" && b.everyHours * 3_600_000 > 2_147_483_647)
    E("E18", "team.backup.everyHours", `backup.everyHours ${b.everyHours} (${b.everyHours * 3_600_000}ms) exceeds Node's 32-bit timer limit (~596.5h / 24.8d); setTimeout would coerce it to 1ms, snapshotting the board every millisecond`);
  if (b.keep !== undefined && (typeof b.keep !== "number" || !Number.isInteger(b.keep) || b.keep < 1))
    E("E18", "team.backup.keep", `backup.keep must be an integer >= 1 — keeping zero generations is a backup system that deletes its own output (got ${JSON.stringify(b.keep)})`);
  if (b.dir !== undefined && (typeof b.dir !== "string" || !b.dir.trim()))
    E("E18", "team.backup.dir", `backup.dir must be a non-empty string (got ${JSON.stringify(b.dir)})`);
}

// E18 — team.budget: dailyUsd must be a positive number or null/unset; perFireUsd must be a positive number.
const BUDGET_KEYS = new Set(["dailyUsd", "perFireUsd"]);
function validateBudget(budget: unknown, E: Emit): void {
  const b = budget as { dailyUsd?: unknown; perFireUsd?: unknown } | null;
  if (b === null || typeof b !== "object" || Array.isArray(b)) { E("E18", "team.budget", "budget must be an object"); return; }
  for (const k of Object.keys(b as object)) {
    if (!BUDGET_KEYS.has(k)) E("E18", `team.budget.${k}`, `unknown budget key '${k}' (expected ${[...BUDGET_KEYS].join(", ")})`);
  }
  if (b.dailyUsd !== undefined && b.dailyUsd !== null &&
      (typeof b.dailyUsd !== "number" || !Number.isFinite(b.dailyUsd) || b.dailyUsd <= 0))
    E("E18", "team.budget.dailyUsd", `budget.dailyUsd must be a positive number or null/unset to disable (got ${JSON.stringify(b.dailyUsd)})`);
  if (b.perFireUsd !== undefined &&
      (typeof b.perFireUsd !== "number" || !Number.isFinite(b.perFireUsd) || b.perFireUsd <= 0))
    E("E18", "team.budget.perFireUsd", `budget.perFireUsd must be a positive number (got ${JSON.stringify(b.perFireUsd)})`);
}

// E18 — team.approvals.enforce (LOOP-394, design approvals §8): the per-action-class enforcement
// enable list. Members are validated against the ACTION_CLASSES registry rather than accepted as
// opaque strings, and the reason is the same one design §4 gives for the key grammar: a typo'd class
// name here is not a cosmetic error, it is enforcement the operator believes is ON and that is
// silently OFF. Refusing at load is what makes `approvals.enforce: ["pushh"]` impossible to hold.
const APPROVALS_KEYS = new Set(["enforce"]);
function validateApprovals(approvals: unknown, E: Emit): void {
  const a = approvals as { enforce?: unknown } | null;
  if (a === null || typeof a !== "object" || Array.isArray(a)) { E("E18", "team.approvals", "approvals must be an object"); return; }
  for (const k of Object.keys(a as object))
    if (!APPROVALS_KEYS.has(k)) E("E18", `team.approvals.${k}`, `unknown approvals key '${k}' (expected ${[...APPROVALS_KEYS].join(", ")})`);
  if (a.enforce === undefined) return;
  if (!Array.isArray(a.enforce)) {
    E("E18", "team.approvals.enforce", `approvals.enforce must be an array of action-class names (legal: ${actionClasses().join(", ")}) — omit it or use [] to enforce nothing`);
    return;
  }
  const legal = new Set(actionClasses());
  const seen = new Set<string>();
  for (const raw of a.enforce as unknown[]) {
    if (typeof raw !== "string" || !raw.trim()) { E("E18", "team.approvals.enforce", `an entry must be a non-empty action-class name (legal: ${actionClasses().join(", ")})`); continue; }
    if (!legal.has(raw)) E("E18", "team.approvals.enforce", `unknown action class '${raw}' — legal classes: ${actionClasses().join(", ")}. A class name that matches nothing is enforcement you believe is on and that is off.`);
    else if (seen.has(raw)) E("E18", "team.approvals.enforce", `action class '${raw}' is listed more than once`);
    seen.add(raw);
  }
}

/**
 * Is enforcement ON for this action class? The ONE reader every enforcing consumer calls (design §8).
 *
 * Default-off is the whole safety story of this increment: an absent block, an absent `enforce`, or an
 * empty list all answer `false`, so a workspace that has never heard of approvals behaves exactly as
 * it did before. Consumers must not re-derive this from `team.approvals` themselves — a second copy of
 * the default is a second place for it to drift ON.
 */
export function approvalsEnforced(team: Pick<TeamBlock, "approvals"> | undefined | null, actionClass: string): boolean {
  const list = team?.approvals?.enforce;
  return Array.isArray(list) && list.includes(actionClass);
}

// team.key/backend/E09 + E12/E13 (team level) + E07 comms + E16 providers/opencodePermission.
function validateTeamBlock(team: TeamBlock, E: Emit, W: Emit): void {
  if (typeof team.key !== "string" || !TEAM_KEY_RE.test(team.key)) E("E02", "team.key", `team.key must match ${TEAM_KEY_RE}`);
  if (team.backend !== "linear" && team.backend !== "service") E("E02", "team.backend", `team.backend must be "linear" or "service" (got ${JSON.stringify(team.backend)})`);
  // LOOP-272 — the §0a push path is reachable today ONLY by a hand-typed flag, so it never runs from
  // config and its absence is unobservable. A non-boolean here would silently resolve OFF, which is
  // exactly the failure this knob exists to make visible.
  if (team.bootCorpus !== undefined && typeof team.bootCorpus !== "boolean")
    E("E18", "team.bootCorpus", `team.bootCorpus must be a boolean (got ${JSON.stringify(team.bootCorpus)})`);
  // E09 is a load-time WARNING, not an error: `team init --backend linear --yes` legitimately writes a
  // blank linearTeam to fill later, and a hard load failure would lock the operator out of the very
  // commands that repair it (team set / add-project / doctor). The HARD failure lives where a linear
  // fire would actually launch on the blank value: toLegacyView (the runtime projection) throws E09.
  if (team.backend === "linear" && (typeof team.linearTeam !== "string" || !team.linearTeam.trim()))
    W("E09", "team.linearTeam", `backend:"linear" has a blank team.linearTeam — fires cannot target a Linear team until it is filled: dev-loop team set team.linearTeam "<Team Name>"`);
  if (team.backup !== undefined) validateBackup((team as { backup?: unknown }).backup, E); // LOOP-339
  checkGovernanceTokens(team, "team", E); // LOOP-408 — §12 mode / §12a autonomy
  if (team.intake !== undefined) checkIntake(team.intake, "team.intake", E);
  if (team.hub !== undefined) checkHub(team.hub, "team.hub", E);

  // E07 — comms: provider ∈ {slack,lark}; webhookEnv is an ENV-VAR NAME, never a URL literal (I5).
  if (team.comms !== undefined) {
    const c = team.comms as { provider?: unknown; webhookEnv?: unknown };
    if (c.provider !== "slack" && c.provider !== "lark") E("E07", "team.comms.provider", "comms.provider must be \"slack\" or \"lark\"");
    if (typeof c.webhookEnv !== "string" || !ENV_NAME_RE.test(c.webhookEnv) || /:\/\//.test(c.webhookEnv))
      E("E07", "team.comms.webhookEnv", "comms.webhookEnv must be an ENV-VAR NAME (e.g. DEVLOOP_COMMS_WEBHOOK), not a URL/secret (§16)");
  }

  // E16 — team.providers (the custom-endpoint registry) + team.opencodePermission. Strictly validated:
  // a typo'd entry renders a DEAD opencode provider block (fires on it would 404/401 a whole turn), and
  // authTokenEnv is name-only (§16 — a copied workspace folder must never carry a credential).
  if (team.agents !== undefined) validateAgentConfigs(team.agents, "team.agents", E, false, W);
  if (team.providers !== undefined) validateProviders(team.providers, E);
  if (team.opencodePermission !== undefined) {
    const op = team.opencodePermission as unknown;
    if (op === null || typeof op !== "object" || Array.isArray(op))
      E("E16", "team.opencodePermission", "opencodePermission must be a JSON object (opencode permission config, injected per fire — replaces the certified wildcard-deny default wholesale)");
  }
  if (team.budget !== undefined) validateBudget(team.budget, E);
  if (team.approvals !== undefined) validateApprovals((team as { approvals?: unknown }).approvals, E); // LOOP-394
  // WS-A C4 / A7 — codex sandbox, claude permission surface, lane pricing. Strict: each of these changes what a
  // fire is ALLOWED to do (or what the operator is told it cost), so a typo must fail at load, not resolve to a
  // silent default.
  if (team.codex !== undefined) {
    const c = team.codex as { sandbox?: unknown } | null;
    if (c === null || typeof c !== "object" || Array.isArray(c)) E("E18", "team.codex", "team.codex must be an object ({ sandbox?: \"safe\"|\"bypass\" })");
    else {
      for (const k of Object.keys(c)) if (k !== "sandbox") E("E18", `team.codex.${k}`, `unknown team.codex key '${k}' (expected sandbox)`);
      if (c.sandbox !== undefined && !(CODEX_SANDBOX_MODES as readonly unknown[]).includes(c.sandbox))
        E("E18", "team.codex.sandbox", `team.codex.sandbox must be "safe" or "bypass" (got ${JSON.stringify(c.sandbox)}) — "bypass" restores the pre-WS-A --dangerously-bypass-approvals-and-sandbox lane`);
    }
  }
  if (team.claude !== undefined) {
    const c = team.claude as { allowedTools?: unknown; permissionMode?: unknown } | null;
    if (c === null || typeof c !== "object" || Array.isArray(c)) E("E18", "team.claude", "team.claude must be an object ({ allowedTools?: string[], permissionMode?: string })");
    else {
      for (const k of Object.keys(c)) if (k !== "allowedTools" && k !== "permissionMode") E("E18", `team.claude.${k}`, `unknown team.claude key '${k}' (expected allowedTools, permissionMode)`);
      if (c.allowedTools !== undefined && !(Array.isArray(c.allowedTools) && c.allowedTools.length > 0 && c.allowedTools.every((t) => typeof t === "string" && t.trim())))
        E("E18", "team.claude.allowedTools", "team.claude.allowedTools must be a non-empty array of non-empty tool strings (e.g. [\"Read\", \"Bash(git log:*)\"]) — passed to claude as --allowedTools");
      if (c.permissionMode !== undefined && !(CLAUDE_PERMISSION_MODES as readonly unknown[]).includes(c.permissionMode))
        E("E18", "team.claude.permissionMode", `team.claude.permissionMode must be one of ${CLAUDE_PERMISSION_MODES.join("|")} (got ${JSON.stringify(c.permissionMode)}) — passed to claude as --permission-mode`);
    }
  }
  if (team.pricing !== undefined) {
    const p = team.pricing as Record<string, unknown> | null;
    if (p === null || typeof p !== "object" || Array.isArray(p)) E("E18", "team.pricing", "team.pricing must be an object mapping lane (claude|codex|opencode) → { inputUsdPerMTok, cacheWriteMultiplier?, cacheReadMultiplier?, outputMultiplier? }");
    else for (const [lane, raw] of Object.entries(p)) {
      const path = `team.pricing.${lane}`;
      if (!CODING_AGENT_KEYS.has(lane)) E("E18", path, `unknown lane '${lane}' (expected claude, codex, or opencode)`);
      const e = raw as Record<string, unknown> | null;
      if (e === null || typeof e !== "object" || Array.isArray(e)) { E("E18", path, "lane pricing must be an object"); continue; }
      for (const k of Object.keys(e)) if (!["inputUsdPerMTok", "cacheWriteMultiplier", "cacheReadMultiplier", "outputMultiplier"].includes(k)) E("E18", `${path}.${k}`, `unknown pricing key '${k}'`);
      if (typeof e.inputUsdPerMTok !== "number" || !(e.inputUsdPerMTok >= 0)) E("E18", `${path}.inputUsdPerMTok`, `inputUsdPerMTok must be a non-negative number (USD per million uncached input tokens)`);
      for (const k of ["cacheWriteMultiplier", "cacheReadMultiplier", "outputMultiplier"]) if (e[k] !== undefined && (typeof e[k] !== "number" || !(e[k] as number >= 0))) E("E18", `${path}.${k}`, `${k} must be a non-negative number (a multiplier on the input price)`);
    }
  }
}

const PROVIDER_KEYS = "kind, baseUrl, authTokenEnv, models, extraOptions, effortMode";
function validateProviders(providers: unknown, E: Emit): void {
  const ps = providers as Record<string, unknown> | null;
  if (ps === null || typeof ps !== "object" || Array.isArray(ps)) { E("E16", "team.providers", "providers must be an object mapping provider-id → entry"); return; }
  for (const [id, raw] of Object.entries(ps)) {
    const path = `team.providers.${id}`;
    if (!KEY_RE.test(id)) E("E16", path, `provider id '${id}' must match ${KEY_RE} (it becomes the opencode provider key and the model-string prefix)`);
    const e = raw as Record<string, unknown> | null;
    if (e === null || typeof e !== "object" || Array.isArray(e)) { E("E16", path, "provider entry must be an object"); continue; }
    for (const k of Object.keys(e)) {
      if (!["kind", "baseUrl", "authTokenEnv", "models", "extraOptions", "effortMode"].includes(k))
        E("E16", `${path}.${k}`, `unknown provider key '${k}' (expected ${PROVIDER_KEYS})`);
    }
    if (e.kind !== "openai-compatible")
      E("E16", `${path}.kind`, `provider.kind must be "openai-compatible" (got ${JSON.stringify(e.kind)}) — the "anthropic" claude-runner route is deferred (model-provider-routing Appendix A)`);
    if (typeof e.baseUrl !== "string" || !/^https?:\/\//.test(e.baseUrl))
      E("E16", `${path}.baseUrl`, `provider.baseUrl must be an http(s) URL (got ${JSON.stringify(e.baseUrl)})`);
    if (typeof e.authTokenEnv !== "string" || !ENV_NAME_RE.test(e.authTokenEnv) || /:\/\//.test(e.authTokenEnv))
      E("E16", `${path}.authTokenEnv`, `provider.authTokenEnv must be an ENV-VAR NAME (e.g. SYNTHETIC_KEY), not a URL/secret (§16)`);
    if (!Array.isArray(e.models) || !e.models.length || e.models.some((m) => typeof m !== "string" || !m.trim()))
      E("E16", `${path}.models`, "provider.models must be a non-empty array of model-id strings (rendered into the opencode provider block)");
    if (e.extraOptions !== undefined && (e.extraOptions === null || typeof e.extraOptions !== "object" || Array.isArray(e.extraOptions)))
      E("E16", `${path}.extraOptions`, "provider.extraOptions must be an object (opencode provider-options passthrough)");
    if (e.effortMode !== undefined && e.effortMode !== "passthrough" && e.effortMode !== "strip")
      E("E16", `${path}.effortMode`, `provider.effortMode must be "passthrough" or "strip" (got ${JSON.stringify(e.effortMode)})`);
  }
}

// Repo registry: name validation (E11), path shape (E03), duplicate canonical paths (E10).
function validateRepoRegistry(repos: Record<string, RepoEntry>, E: Emit): void {
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
    // LOOP-335 — ciIrrelevantPaths decides whether a PR is exempted from a staleness trip, so a
    // malformed entry silently widens what gets merged without re-verification. Refused at load,
    // where every other repo fact is.
    const cip = (r as { ciIrrelevantPaths?: unknown } | null)?.ciIrrelevantPaths;
    if (cip !== undefined) {
      if (!Array.isArray(cip) || cip.some((v) => typeof v !== "string")) {
        E("E08", `repos.${ref}.ciIrrelevantPaths`, "ciIrrelevantPaths must be an array of strings");
      } else {
        for (const raw of cip as string[]) {
          const v = raw.trim();
          if (!v) E("E08", `repos.${ref}.ciIrrelevantPaths`, "an entry must be a non-empty path");
          else if (isAbsolute(v) || /^[A-Za-z]:[\\/]/.test(v)) E("E08", `repos.${ref}.ciIrrelevantPaths`, `'${raw}' must be repo-relative, not absolute`);
          else if (v.split("/").includes("..")) E("E08", `repos.${ref}.ciIrrelevantPaths`, `'${raw}' must not traverse outside the repo ('..')`);
          else if (/[*?\[\]]/.test(v)) E("E08", `repos.${ref}.ciIrrelevantPaths`, `'${raw}' must be an exact file or a directory prefix ending in '/', not a glob — a glob language is a second thing to get wrong`);
        }
      }
    }
  }
}

// Projects: name (E11), repo refs (E04), enabled/weight (E08), linearProjectId dup (E10), per-project
// blocks (E12/E13/E14/E15). Returns ref → referencing project keys for the shared-ownership pass.
function validateProjects(projects: Record<string, ProjectEntry>, repos: Record<string, RepoEntry>, E: Emit, W: Emit): Map<string, string[]> {
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
    checkGovernanceTokens(p ?? {}, `projects.${key}`, E); // LOOP-408 — the project override of the same knobs
    if (p?.intake !== undefined) checkIntake(p.intake, `projects.${key}.intake`, E);
    if (p?.hub !== undefined) checkHub(p.hub, `projects.${key}.hub`, E);
    if (p?.communication !== undefined) checkCommunication(p.communication, `projects.${key}.communication`, E);
    if (p?.notify !== undefined) checkNotify(p.notify, `projects.${key}.notify`, E);
    if (p?.agents !== undefined) validateAgentConfigs(p.agents, `projects.${key}.agents`, E, true, W);
    if (p?.scratch !== undefined && typeof p.scratch !== "boolean") E("E08", `projects.${key}.scratch`, "scratch must be a boolean");
    const refs = Array.isArray(p?.repos) ? p.repos : [];
    if (!refs.length && p?.scratch !== true) W("W01", `projects.${key}.repos`, `project '${key}' references no repos`);
    for (const rr of refs) {
      const ref = rr?.ref;
      if (typeof ref !== "string" || !(ref in repos)) { E("E04", `projects.${key}.repos`, `references unknown repo ref ${JSON.stringify(ref)}`); continue; }
      (refCount.get(ref) ?? refCount.set(ref, []).get(ref)!).push(key);
    }
  }
  return refCount;
}

// E05 — a repo referenced by >1 project needs an `owner` that is one of its referrers. NOTE: this
// deliberately counts ALL referrers, not just enabled ones — validation must not flip when a project is
// toggled (invariant I2). W02 — a registered repo referenced by nobody.
function validateSharedOwnership(repos: Record<string, RepoEntry>, refCount: Map<string, string[]>, E: Emit, W: Emit): void {
  for (const [ref, r] of Object.entries(repos)) {
    const referrers = refCount.get(ref) ?? [];
    if (referrers.length === 0) { W("W02", `repos.${ref}`, `repo '${ref}' is registered but referenced by no project`); continue; }
    if (referrers.length > 1) {
      const owner = r?.owner;
      if (typeof owner !== "string" || !owner.trim()) E("E05", `repos.${ref}.owner`, `repo '${ref}' is shared by ${referrers.length} projects (${referrers.join(", ")}); it must declare an owner`);
      else if (!referrers.includes(owner)) E("E05", `repos.${ref}.owner`, `repo '${ref}' owner '${owner}' is not among its referrers (${referrers.join(", ")})`);
    }
  }
}

// W07 — a DEPLOYED repo with no health probe leaves ops blind. E06 — deployPolicy is a CEILING:
// policy[env]="manual" forbids any repo auto-deploying that env (§4.3).
function validateProbesAndPolicy(team: TeamBlock, repos: Record<string, RepoEntry>, projects: Record<string, ProjectEntry>, refCount: Map<string, string[]>, E: Emit, W: Emit): void {
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
}

export function validateTeamFile(raw: unknown): { errors: WsError[]; warnings: WsWarning[] } {
  const errors: WsError[] = [];
  const warnings: WsWarning[] = [];
  const E: Emit = (code, path, message) => errors.push({ code, path, message });
  const W: Emit = (code, path, message) => warnings.push({ code, path, message });

  const file = raw as Partial<TeamFile> | null;
  if (!file || typeof file !== "object") { E("E01", "", "config is not a JSON object"); return { errors, warnings }; }
  if (file.schemaVersion !== 2) E("E01", "schemaVersion", `expected schemaVersion:2 (got ${JSON.stringify((file as { schemaVersion?: unknown }).schemaVersion)})`);

  const team = file.team as TeamBlock | undefined;
  if (!team || typeof team !== "object") { E("E02", "team", "missing team block"); return { errors, warnings }; }
  validateTeamBlock(team, E, W);

  const repos = (file.repos ?? {}) as Record<string, RepoEntry>;
  const projects = (file.projects ?? {}) as Record<string, ProjectEntry>;
  if (!file.repos || typeof file.repos !== "object") E("E02", "repos", "missing repos registry (may be empty {})");
  if (!file.projects || typeof file.projects !== "object") E("E02", "projects", "missing projects map (may be empty {})");

  validateRepoRegistry(repos, E);
  const refCount = validateProjects(projects, repos, E, W);
  validateSharedOwnership(repos, refCount, E, W);
  validateProbesAndPolicy(team, repos, projects, refCount, E, W);

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
export interface ResolvedRepo extends RepoEntry { ref: string; absPath: string; defaultBranch: string }
// `autonomy` NARROWS on resolution: the input alias set goes in, the canonical §12a pair comes out.
export interface ResolvedProject extends Omit<ProjectEntry, "autonomy" | "humanBlocked"> { key: string; backend: string; mode?: Mode; autonomy?: Autonomy; docSystem?: string; reports?: unknown;
  /** Always resolved (absent config ⇒ "on"), so no reader re-defaults it and they cannot disagree. */
  humanBlocked: HumanBlockedMode }

export function effectiveRepo(ws: Workspace, ref: string): ResolvedRepo {
  const r = ws.file.repos[ref];
  if (!r) throw new Error(`unknown repo ref '${ref}'`);
  return {
    ...r, ref,
    absPath: join(ws.root, normalizedRel(r.path) ?? r.path),
    defaultBranch: r.defaultBranch ?? ws.file.team.git?.defaultBranch ?? "main",
  };
}

// Resolve the defaultBranch for a repo identified by its absolute working directory.
// Returns undefined when the dir matches no registered repo — callers must fail loud, never fall back to "main".
export function resolveDefaultBranchForPath(ws: Workspace, absDir: string): string | undefined {
  const hit = Object.keys(ws.file.repos).find((ref) => effectiveRepo(ws, ref).absPath === absDir);
  return hit ? effectiveRepo(ws, hit).defaultBranch : undefined;
}

// Behavior fields resolve project ∥ team (nearest wins, §4.2). Physical fields live only on the registry.
/**
 * Should the scheduler REFUSE to fire this lane, and why? `null` ⇒ fire it.
 *
 * Two keys, because the operator has two different intents and conflating them cost a lane's liveness
 * warning during the incident that produced this function:
 *
 *   • `enabled: false` — "do not run this lane for now". The scheduler skips it; doctor's W16
 *     owner-liveness warning is UNAFFECTED, because a deliberately parked lane still has stranded
 *     tickets worth reporting. This is the stop-gap switch.
 *   • `manual: true` — "a human runs this role BY HAND" (config-schema's own words). The scheduler
 *     skips it AND W16 downgrades to an info line, because "no fires in 7d" is the expected state for
 *     a human-run role rather than a finding.
 *
 * Until 2026-08-29 `manual` did neither of the first halves: run-agents.ts contained no occurrence of
 * the word, so the key was accepted, never read, and doctor's own W16 remedy told operators to set it
 * to stop a lane. An operator set it at 15:30Z and the lane fired again at 15:41:03Z for $3.91, with
 * no skip line anywhere. `cadence: 0` is refused by E17 as "a hot loop, not a disable", and
 * project-scope `cadence` is refused outright — so before `enabled` there was no per-lane off switch
 * at all.
 *
 * Scope: `projectKey` given ⇒ the project's merged view (effectiveProject already layers
 * projects.<key>.agents over team.agents per field), so a lane can be parked for ONE project and keep
 * serving its siblings. Omitted ⇒ the team block alone, which is the whole-lane answer.
 *
 * Key lookup is the exact SchedKey first, then the lane's owning ACTOR — so `agents.pm.enabled:false`
 * parks pm-maintenance/groom/review together, while `agents.pm-groom.enabled:false` parks just one.
 */
export function laneScheduleBlock(
  ws: Workspace, agent: string, projectKey?: string,
): { key: string; reason: string } | null {
  const blocks = projectKey && ws.file.projects[projectKey]
    ? (effectiveProject(ws, projectKey).agents ?? {})
    : (ws.file.team.agents ?? {});
  const actor = LANE_ACTOR[agent as Lane] ?? agent;
  const scope = projectKey ? `projects.${projectKey}.agents` : "team.agents";
  for (const key of agent === actor ? [agent] : [agent, actor]) {
    const c = blocks[key];
    if (!c) continue;
    if (c.enabled === false) return { key, reason: `${scope}.${key}.enabled is false — this lane is parked in config` };
    if (c.manual === true) return { key, reason: `${scope}.${key}.manual is true — this role is run by a human, not the scheduler` };
  }
  return null;
}

/** Union of the lanes named on either side, each lane's fields merged with the project's winning. */
function mergeAgentBlocks(
  team: Record<string, AgentLaunchConfig> | undefined,
  project: Record<string, AgentLaunchConfig> | undefined,
): Record<string, AgentLaunchConfig> {
  const out: Record<string, AgentLaunchConfig> = {};
  for (const lane of new Set([...Object.keys(team ?? {}), ...Object.keys(project ?? {})])) {
    out[lane] = { ...team?.[lane], ...project?.[lane] };
  }
  return out;
}

export function effectiveProject(ws: Workspace, key: string): ResolvedProject {
  const p = ws.file.projects[key];
  if (!p) throw new Error(`unknown project '${key}'`);
  const t = ws.file.team;
  return {
    ...p, key,
    backend: t.backend,
    mode: p.mode ?? t.mode,
    // Normalize at RESOLUTION, never by rewriting the operator's file: a config carrying the
    // legacy `guarded` keeps working untouched and every reader sees the canonical `ask`.
    autonomy: normalizeAutonomy(p.autonomy ?? t.autonomy),
    docSystem: p.docSystem ?? t.docSystem,
    humanBlocked: p.humanBlocked ?? t.humanBlocked ?? "on", // absent ⇒ "on": today's behaviour, byte for byte

    reports: p.reports ?? t.reports,
    defaultCodingAgent: p.defaultCodingAgent ?? t.defaultCodingAgent,
    codingAgentDefaults: p.codingAgentDefaults ?? t.codingAgentDefaults,
    // intake merges FIELD-WISE (not whole-block nearest-wins): mode and todoDepthCap are orthogonal
    // knobs, so a project tuning only its cap must not silently drop a team-level "passive".
    ...(p.intake || t.intake ? { intake: { ...t.intake, ...p.intake } } : {}),
    // agents merges PER LANE, then per field. team.agents is the team-level launch default and
    // projects.<key>.agents overrides it — the reading `dev-loop team set`'s whitelist has always
    // implied (it offers team.agents.<a>.{codingAgent,model,effort,codexSandbox} and no project-level
    // equivalent) and the one the built-in profile table's own comments state. Before this, the
    // projection below emitted the PROJECT block alone, so the settable key reached no reader at all:
    // an operator who set team.agents.pm-review.model got no error and no change.
    //
    // Per FIELD, not whole-block nearest-wins, for the reason intake and hub already merge that way:
    // a project pinning only `model` must not silently drop the team's `effort` for that lane.
    ...(p.agents || t.agents ? { agents: mergeAgentBlocks(t.agents, p.agents) } : {}),
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

// WS-A C4 review 1 — which agent handles the CONFIG routes to the codex lane, and where that routing
// comes from. From config alone (doctor cannot see a run's --cli; `team set` runs with no scheduler).
// This mirrors run-agents' resolveCodingAgent EXACTLY — per-agent project override, else the project's
// (team-merged) defaultCodingAgent — and consults only the projects a fire can launch on (enabled, not
// scratch). Steward fires resolve their profile against the first enabled project, so the per-project
// walk covers them too. `team.agents.<h>.codingAgent` IS a source, through effectiveProject's per-lane
// merge: the launch-profile resolver reads the same merged block, so a lane routed to codex at team
// level fires as codex and W45 must warn about it. (It was excluded while the resolver had no reader
// for the key — counting it then would have warned about a lane that did not fire.) `handles` is
// passed in rather than imported from seed.ts so this module keeps its zero-dependency shape.
export interface CodexRoute { handle: string; via: string }
export function codexRoutedHandles(ws: Workspace, handles: readonly string[]): CodexRoute[] {
  const out = new Map<string, string>();
  const add = (h: string, via: string) => { if (!out.has(h)) out.set(h, via); };
  for (const key of deliveryProjects(ws)) {
    const eff = effectiveProject(ws, key);
    const agents = (eff.agents ?? {}) as Record<string, { codingAgent?: unknown } | undefined>;
    for (const [h, a] of Object.entries(agents)) if (a?.codingAgent === "codex") add(h, `projects.${key}.agents.${h}.codingAgent`);
    if (eff.defaultCodingAgent === "codex") {
      const via = ws.file.projects[key]?.defaultCodingAgent === "codex" ? `projects.${key}.defaultCodingAgent` : "team.defaultCodingAgent";
      for (const h of handles) if (typeof agents[h]?.codingAgent !== "string") add(h, via);
    }
  }
  return [...out.entries()].map(([handle, via]) => ({ handle, via }));
}

// The routed handles whose sandbox posture is NOT pinned anywhere — i.e. the ones riding the "safe"
// default. Empty when team.codex.sandbox is set (it covers every handle) or when every routed handle
// carries its own agents.<h>.codexSandbox. This is the one predicate doctor (W45), `team set` and the
// scheduler-start notice share, so the three can never disagree about who is on the default.
export function codexSandboxUnpinned(ws: Workspace, handles: readonly string[]): CodexRoute[] {
  if (ws.file.team.codex?.sandbox !== undefined) return [];
  return codexRoutedHandles(ws, handles).filter((r) => ws.file.team.agents?.[r.handle]?.codexSandbox === undefined);
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

/**
 * The §5a Todo-depth cap for a project — NEAREST WINS, as conventions §5a states: a project's own
 * `intake.todoDepthCap` overrides the team's, and the shipped default is 10.
 *
 * Written here because there was no code-side resolver at all (LOOP-329): the knob existed in config
 * and in the PM agent's prose, and every reader that wanted it had to re-derive the precedence. One
 * resolver means the doctor check, the metrics line and any future consumer cannot disagree about
 * what "at cap" means.
 */
export const DEFAULT_TODO_DEPTH_CAP = 10;

export function resolveTodoDepthCap(ws: Workspace, key: string): number {
  const p = ws.file.projects[key]?.intake?.todoDepthCap;
  if (typeof p === "number" && Number.isInteger(p) && p >= 1) return p;
  const t = ws.file.team.intake?.todoDepthCap;
  if (typeof t === "number" && Number.isInteger(t) && t >= 1) return t;
  return DEFAULT_TODO_DEPTH_CAP;
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
      agents: eff.agents,
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
