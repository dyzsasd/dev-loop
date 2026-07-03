#!/usr/bin/env node
// `dev-loop run` — a small scheduler that fires agent SKILLs through a headless CLI.
// It deliberately does NOT depend on Claude/Codex `/loop`; it owns cadence here and
// shells out to `claude -p` or `codex exec` once per agent fire.
import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectFromCwd } from "./resolve-project.ts";
import { tryResolveWorkspace, wsStateRoot, wsHubDb, wsLockPath, wsFireLedger } from "./workspace.ts";
import { toLegacyView, WsValidationError, primaryRepo, type Workspace } from "./team-config.ts";
import { rotationCandidates, smoothWRRStep, loadSchedulerState, saveSchedulerState, type SchedulerState, type CursorMap } from "./rotation.ts";
import { findCompatibleNode, MIN_NODE_VERSION } from "./node-runtime.ts";
import { devloopDataDir, devloopProjectsPath, hubDbPath, projectConfigCandidates } from "./paths.ts";
import { openDb, logEvent } from "./db.ts";
import { findProject, AGENT_HANDLES } from "./seed.ts";
import type { DatabaseSync } from "node:sqlite";

// A2: the scheduler roster IS the seed roster — one source (seed.ts AGENT_HANDLES). A gap between the two
// used to fire an agent the hub refuses (G1) — tokens burned, board unwritable. Now they cannot diverge.
const VALID_AGENTS = AGENT_HANDLES;
type Agent = (typeof VALID_AGENTS)[number];

// A coding-agent CLI the scheduler can drive. `claude` + `codex` are fully wired (the scheduler
// self-injects the hub MCP for them); `opencode` is recognized everywhere in config (per-agent
// selection + per-coding-agent defaults) and launched best-effort via `opencode run` — its MCP is
// registered through the operator's merged opencode config, not inline (see docs/PORTABILITY.md).
// Adding a CLI = extend this union + DEFAULT_LAUNCH_PROFILES + commandFor().
type CodingAgent = "claude" | "codex" | "opencode";
type RunnerCli = CodingAgent; // the --cli flag / DEVLOOP_RUNNER_CLI sets the run-wide DEFAULT coding agent
const CODING_AGENTS: readonly CodingAgent[] = ["claude", "codex", "opencode"];
const CODING_AGENT_SET = new Set<string>(CODING_AGENTS);
const isCodingAgent = (v: unknown): v is CodingAgent => typeof v === "string" && CODING_AGENT_SET.has(v);

// Level 1 (codingAgent) + level 2 (model + thinking/reasoning effort, in that coding agent's own
// value space). This is what every agent fire resolves to and what commandFor() renders.
type LaunchProfile = { codingAgent: CodingAgent; model?: string; effort?: string };

// Per-coding-agent default model + effort — projects.json `codingAgentDefaults.<codingAgent>`.
type CodingAgentDefault = { model?: string; effort?: string };

// The two-level per-agent config — projects.json `agents.<agent>`: level 1 = codingAgent,
// level 2 = model + effort. Strings are validated/normalized at resolve time.
type AgentLaunchConfig = { codingAgent?: string; model?: string; effort?: string };

// Back-compat per-agent maps (pre-two-level). String ⇒ same value for every coding agent;
// object ⇒ per-coding-agent. Still honored as a fallback BELOW agents{} and ABOVE codingAgentDefaults.
type ModelConfigValue = string | {
  model?: string;
  claude?: string;
  codex?: string;
  opencode?: string;
  effort?: string;
  claudeEffort?: string;
  codexEffort?: string;
  opencodeEffort?: string;
};
type EffortConfigValue = string | {
  effort?: string;
  claude?: string;
  codex?: string;
  opencode?: string;
  claudeEffort?: string;
  codexEffort?: string;
  opencodeEffort?: string;
};

const AGENT_SET = new Set<string>(VALID_AGENTS);
const GROUPS: Record<string, Agent[]> = {
  core: ["pm", "qa", "senior-dev", "junior-dev", "sweep"],
  split: ["pm", "qa", "senior-dev", "junior-dev", "sweep"],
  legacy: ["pm", "qa", "dev", "sweep"],
  "single-dev": ["pm", "qa", "dev", "sweep"],
  outward: ["ops", "architect", "communication"],
  all: ["pm", "qa", "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"],
};
const DEFAULT_AGENTS: Agent[] = GROUPS.core;
const DEFAULT_INTERVALS: Record<Agent, number> = {
  pm: 5 * 60_000,
  qa: 5 * 60_000,
  dev: 5 * 60_000,
  "senior-dev": 5 * 60_000,
  "junior-dev": 5 * 60_000,
  sweep: 30 * 60_000,
  reflect: 24 * 60 * 60_000,
  ops: 10 * 60_000,
  architect: 24 * 60 * 60_000,
  communication: 24 * 60 * 60_000,
};
// Built-in role defaults, per coding agent — the floor beneath codingAgentDefaults{}, the back-compat
// models{}/efforts{} maps, and agents{}. opencode model names are provider-specific and unknown to the
// scheduler, so its built-in is empty ({} ⇒ opencode's own default) — pin one via codingAgentDefaults
// or agents{}.
const DEFAULT_LAUNCH_PROFILES: Record<Agent, Record<CodingAgent, CodingAgentDefault>> = {
  pm: {
    claude: { model: "opus", effort: "max" },
    codex: { model: "gpt-5.5", effort: "xhigh" },
    opencode: {},
  },
  qa: {
    claude: { model: "sonnet", effort: "high" },
    codex: { model: "gpt-5.5", effort: "high" },
    opencode: {},
  },
  dev: {
    claude: { model: "opus", effort: "max" },
    codex: { model: "gpt-5.5", effort: "xhigh" },
    opencode: {},
  },
  "senior-dev": {
    claude: { model: "claude-opus-4-8", effort: "max" },
    codex: { model: "gpt-5.5", effort: "xhigh" },
    opencode: {},
  },
  "junior-dev": {
    claude: { model: "claude-sonnet-4-6", effort: "high" },
    codex: { model: "gpt-5.5", effort: "high" },
    opencode: {},
  },
  sweep: {
    claude: { model: "sonnet", effort: "high" },
    codex: { model: "gpt-5.5", effort: "high" },
    opencode: {},
  },
  reflect: {
    claude: { model: "opus", effort: "xhigh" },
    codex: { model: "gpt-5.5", effort: "xhigh" },
    opencode: {},
  },
  ops: {
    claude: { model: "sonnet", effort: "high" },
    codex: { model: "gpt-5.5", effort: "high" },
    opencode: {},
  },
  architect: {
    claude: { model: "opus", effort: "xhigh" },
    codex: { model: "gpt-5.5", effort: "xhigh" },
    opencode: {},
  },
  communication: {
    claude: { model: "sonnet", effort: "high" },
    codex: { model: "gpt-5.5", effort: "high" },
    opencode: {},
  },
};

type ProjectsConfig = {
  defaultProject?: string;
  projects?: Record<string, {
    devSplit?: boolean;
    // Two-level launch config (conventions §11 / config-schema):
    defaultCodingAgent?: string;                                       // project-wide level-1 default coding agent
    codingAgentDefaults?: Partial<Record<CodingAgent, CodingAgentDefault>>; // per-coding-agent default model + effort
    agents?: Partial<Record<Agent, AgentLaunchConfig>>;               // per-agent: codingAgent + model + effort
    // Back-compat per-agent maps (still honored, below agents{} / above codingAgentDefaults):
    models?: Partial<Record<Agent, ModelConfigValue>>;
    efforts?: Partial<Record<Agent, EffortConfigValue>>;
    repoPath?: string;
    repos?: Array<{ path?: string; role?: string }>;
  }>;
};

type Options = {
  cli: RunnerCli;        // run-wide DEFAULT coding agent (from --cli / DEVLOOP_RUNNER_CLI); per-agent config can override it
  cliExplicit: boolean;  // true when --cli was passed on the command line (beats config defaultCodingAgent)
  agents: Agent[];
  intervals: Record<Agent, number>;
  once: boolean;
  dryRun: boolean;
  devSplit: boolean;
  plan: number;          // team mode: print the next N (agent, project) picks and exit (0 = off)
  project?: string;
  root: string;
  dataDir: string;
  dataDirExplicit: boolean; // --data was passed → do not override from a discovered workspace
  hubDb: string;
  hubDbExplicit: boolean;   // --hub-db was passed → do not override from a discovered workspace
  cwd?: string;
  logDir?: string;
  claudeBin: string;
  codexBin: string;
  opencodeBin: string;
  codexSafe: boolean;
  maxFires: number;     // 0 = unlimited; else stop after N total fires (cost guard)
  changeGate: boolean;  // R1: skip spawning a gated inward agent when neither repo HEAD nor the board moved since its last fire (service backend only) — saves the full-turn cost of a fire that would just no-op
  fireTimeoutMs: number; // 0 = none; else SIGTERM (then SIGKILL) a fire that outlives this — a wedged CLI child must not disable its slot forever
  staggerMs: number;    // boot stagger between the initial slot fires (0 = all at once)
  mcpConfig?: string;   // claude: explicit MCP config; defaults to <cwd>/.mcp.json if present
  extraArgs: string[];
};

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (build)
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts"; // server sibling: .ts source / .js published
const isPluginRoot = (p: string) => existsSync(join(p, "skills")) && existsSync(join(p, "references"));
const defaultRoot = () => {
  // A1: ONE packaged copy of the plugin payload (skills/references/…). Published package: dist/cli.js →
  // here=dist → the payload sits at the package root (resolve(here,"..")), where the `files` array copies it
  // (no more duplicate dist/plugin tree). Source checkout: hub/src → the repo root (resolve(here,"..","..")).
  const candidates = [resolve(here, ".."), resolve(here, "..", "..")];
  return candidates.find(isPluginRoot) ?? resolve(here, "..", "..");
};
const defaultDataDir = () => devloopDataDir();
const defaultHubDb = () => hubDbPath();

function usage(): void {
  console.log(`dev-loop run — schedule dev-loop agents with a headless CLI

Usage:
  dev-loop run --cli claude [--project <key>] [--agents core,communication]
  dev-loop run --cli codex  [--project <key>] [--agents core,outward]

Cadence is owned by this process, not by Claude/Codex /loop. Each fire shells out once:
  claude -p <agent skill prompt>
  codex exec ... <agent skill prompt>

Options:
  --cli claude|codex|opencode run-wide DEFAULT coding agent (default: claude). Per-agent
                              agents{}.codingAgent / project defaultCodingAgent override it, so one run can mix CLIs.
  --project <key>             project key; optional. Defaults to DEVLOOP_PROJECT, then cwd→repo match; fails if unresolved
  --agents <list>             comma list of agents or groups: core, split, legacy, single-dev, outward, all
  --agent <name>              add one agent; may repeat
  --dev-split                 compatibility alias: replace dev with senior-dev + junior-dev when dev is selected
  --interval <agent=dur>      override cadence, e.g. pm=2m, communication=24h; may repeat
  --once                      run each selected agent once, then exit
  --dry-run                   print resolved commands; do not launch Claude/Codex
  --root <path>               dev-loop checkout root (default: inferred, or DEVLOOP_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT)
  --data <path>               dev-loop data dir (default: DEVLOOP_DATA_DIR or ~/.dev-loop)
  --hub-db <path>             hub db path (default: DEVLOOP_HUB_DB or ~/.dev-loop/hub.db)
  --cwd <path>                working directory for CLI subprocesses (default: project repoPath)
  --mcp-config <path>         claude: MCP config to load + --strict-mcp-config (default: <cwd>/.mcp.json if present)
  --max-fires <n>             stop after N total agent fires, then drain + exit (cost guard; default 0 = unlimited)
  --change-gate               skip spawning a gated inward agent (pm/qa/dev/senior-dev/junior-dev/architect) when
                              neither any repo HEAD nor the hub board moved since its last fire — the biggest cost
                              saver on a quiet loop (service backend only; the agents already no-op in that case,
                              this just avoids paying for the full turn to discover it)
  --fire-timeout <dur>        kill a fire that outlives this (SIGTERM, then SIGKILL after 10s; default 1h; 0 = none)
  --stagger <dur>             delay between the initial slot fires so a cold boot doesn't launch every agent at once (default 20s; 0 = simultaneous)
  --codex-safe                omit Codex's unsafe bypass flags; useful for read-only/dry runs
  --cli-arg <arg>             pass an extra arg to the selected CLI before the prompt; may repeat
                              (CLI binaries: set DEVLOOP_CLAUDE_BIN / DEVLOOP_CODEX_BIN / DEVLOOP_OPENCODE_BIN to override)

Durations accept ms/s/m/h/d. Default agents: core = pm,qa,senior-dev,junior-dev,sweep.
Per-agent launch is two-level (projects.json): agents{}.<agent> picks { codingAgent, model, effort };
codingAgentDefaults{}.<codingAgent> sets per-coding-agent default { model, effort }. The legacy
models{}/efforts{} maps still apply. Resolution: agents{} > models/efforts > codingAgentDefaults > built-in.
Use --agents legacy (or --agents pm,qa,dev,sweep) for the old single-dev loop.`);
}

function die(msg: string, code = 2): never {
  console.error(`dev-loop run: ${msg}`);
  process.exit(code);
}

function parseDuration(input: string): number {
  const m = input.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) die(`invalid duration '${input}'`);
  const n = Number(m[1]);
  const unit = m[2] ?? "m";
  const mult = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
  const ms = Math.round(n * mult);
  if (!Number.isFinite(ms) || ms <= 0) die(`invalid duration '${input}'`);
  return ms;
}

function formatDuration(ms: number): string {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function expandAgentSpec(parts: string[]): Agent[] {
  const out: Agent[] = [];
  for (const raw of parts.flatMap((p) => p.split(","))) {
    const name = raw.trim();
    if (!name) continue;
    if (GROUPS[name]) out.push(...GROUPS[name]);
    else if (AGENT_SET.has(name)) out.push(name as Agent);
    else die(`unknown agent/group '${name}'`);
  }
  return [...new Set(out)];
}

function runtimeDevSplit(opts: Pick<Options, "devSplit" | "agents">): boolean {
  return opts.devSplit || opts.agents.includes("senior-dev") || opts.agents.includes("junior-dev");
}

function parseArgs(argv: string[]): Options {
  const agentSpecs: string[] = [];
  const intervals = { ...DEFAULT_INTERVALS };
  const extraArgs: string[] = [];
  const envCli = process.env.DEVLOOP_RUNNER_CLI;
  if (envCli && !isCodingAgent(envCli)) die(`DEVLOOP_RUNNER_CLI must be claude, codex, or opencode (got '${envCli}')`);
  const opts: Options = {
    cli: (envCli as RunnerCli) || "claude",
    agents: [],
    intervals,
    once: false,
    dryRun: false,
    devSplit: false,
    plan: 0,
    root: process.env.DEVLOOP_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || defaultRoot(),
    dataDir: defaultDataDir(),
    dataDirExplicit: false,
    hubDb: defaultHubDb(),
    hubDbExplicit: false,
    cliExplicit: false,
    claudeBin: process.env.DEVLOOP_CLAUDE_BIN || "claude",
    codexBin: process.env.DEVLOOP_CODEX_BIN || "codex",
    opencodeBin: process.env.DEVLOOP_OPENCODE_BIN || "opencode",
    codexSafe: false,
    maxFires: 0,
    changeGate: false,
    fireTimeoutMs: 60 * 60_000,
    staggerMs: 20_000,
    extraArgs,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--cli") {
      const v = next();
      if (!isCodingAgent(v)) die("--cli must be claude, codex, or opencode");
      opts.cli = v;
      opts.cliExplicit = true;
    } else if (a === "--project") opts.project = next();
    else if (a === "--agents") agentSpecs.push(next());
    else if (a === "--agent") agentSpecs.push(next());
    else if (a === "--dev-split") opts.devSplit = true;
    else if (a === "--interval") {
      const raw = next();
      const eq = raw.indexOf("=");
      if (eq <= 0) die("--interval must look like agent=duration");
      const agent = raw.slice(0, eq);
      if (!AGENT_SET.has(agent)) die(`unknown agent in --interval '${agent}'`);
      intervals[agent as Agent] = parseDuration(raw.slice(eq + 1));
    } else if (a === "--once") opts.once = true;
    else if (a === "--plan") { opts.plan = Number(next()); if (!Number.isInteger(opts.plan) || opts.plan <= 0) die("--plan must be a positive integer"); }
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--root") opts.root = resolve(next());
    else if (a === "--data") { opts.dataDir = resolve(next()); opts.dataDirExplicit = true; }
    else if (a === "--hub-db") { opts.hubDb = resolve(next()); opts.hubDbExplicit = true; }
    else if (a === "--cwd") opts.cwd = resolve(next());
    else if (a === "--mcp-config") opts.mcpConfig = resolve(next());
    else if (a === "--max-fires") {
      opts.maxFires = Number(next());
      if (!Number.isInteger(opts.maxFires) || opts.maxFires < 0) die("--max-fires must be a non-negative integer (0 = unlimited)");
    }
    else if (a === "--change-gate") opts.changeGate = true;
    else if (a === "--fire-timeout") { const v = next(); opts.fireTimeoutMs = v.trim() === "0" ? 0 : parseDuration(v); } // 0 = disabled (parseDuration rejects non-positive)
    else if (a === "--stagger") { const v = next(); opts.staggerMs = v.trim() === "0" ? 0 : parseDuration(v); }
    else if (a === "--codex-safe") opts.codexSafe = true;
    else if (a === "--cli-arg") extraArgs.push(next());
    else die(`unknown option '${a}'`);
  }

  let agents = expandAgentSpec(agentSpecs.length ? agentSpecs : DEFAULT_AGENTS);
  if (opts.devSplit) {
    agents = agents.flatMap((a) => a === "dev" ? ["senior-dev", "junior-dev"] as Agent[] : [a]);
    agents = [...new Set(agents)];
  }
  opts.agents = agents;
  return opts;
}

function readProjects(dataDir: string): ProjectsConfig | null {
  for (const p of projectConfigCandidates(dataDir)) {
    if (!existsSync(p)) continue;
    try { return JSON.parse(readFileSync(p, "utf8")) as ProjectsConfig; }
    catch (e) { die(`could not parse ${p}: ${(e as Error).message}`, 1); }
  }
  return null;
}

function projectsPath(dataDir: string): string {
  return devloopProjectsPath(dataDir);
}

function resolveProject(opts: Options, cfg: ProjectsConfig | null): string {
  const explicit = opts.project || process.env.DEVLOOP_PROJECT?.trim();
  if (explicit) return explicit;
  const fromCwd = cfg ? resolveProjectFromCwd(opts.cwd || process.cwd(), cfg) : null;
  if (fromCwd) return fromCwd;
  const cwd = opts.cwd || process.cwd();
  const keys = Object.keys(cfg?.projects ?? {});
  const configured = keys.length ? keys.join(", ") : "none";
  die(`no project resolved from cwd ${cwd}. Add this repo to ${projectsPath(opts.dataDir)} as repoPath/repos[].path, pass --project <key>, or set DEVLOOP_PROJECT. Configured projects: ${configured}.`, 2);
}

function resolveCwd(opts: Options, cfg: ProjectsConfig | null, project: string): string {
  if (opts.cwd) return opts.cwd;
  const p = cfg?.projects?.[project];
  const primaryRepo = p?.repos?.find((r) => r.role === "primary" && r.path)?.path;
  const docRepo = p?.repos?.find((r) => r.role === "docs" && r.path)?.path;
  return p?.repoPath || primaryRepo || docRepo || p?.repos?.find((r) => r.path)?.path || process.cwd();
}

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function modelOverride(v: ModelConfigValue | undefined, cli: RunnerCli): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return stringValue(v);
  return stringValue(v[cli]) ?? stringValue(v.model);
}

function perCliEffort(v: { claudeEffort?: string; codexEffort?: string; opencodeEffort?: string }, cli: CodingAgent): string | undefined {
  return cli === "claude" ? v.claudeEffort : cli === "codex" ? v.codexEffort : v.opencodeEffort;
}

function effortFromModelOverride(v: ModelConfigValue | undefined, cli: CodingAgent): string | undefined {
  if (!v || typeof v === "string") return undefined;
  return stringValue(perCliEffort(v, cli)) ?? stringValue(v.effort);
}

function effortOverride(v: EffortConfigValue | undefined, cli: CodingAgent): string | undefined {
  if (!v) return undefined;
  if (typeof v === "string") return stringValue(v);
  return stringValue(perCliEffort(v, cli))
    ?? stringValue(v[cli])
    ?? stringValue(v.effort);
}

function normalizeEffort(cli: RunnerCli, effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const v = effort.trim().toLowerCase();
  const aliases: Record<string, string> = {
    "extra-high": "xhigh",
    "extra_high": "xhigh",
    extrahigh: "xhigh",
    maximum: "max",
  };
  const normalized = aliases[v] ?? v;
  // Codex exposes xhigh but not Claude's max tier, so keep the strongest portable setting.
  return cli === "codex" && normalized === "max" ? "xhigh" : normalized;
}

type ProjectCfg = NonNullable<ProjectsConfig["projects"]>[string];

// Level 1: which coding agent runs THIS agent. Precedence: per-agent agents{}.codingAgent >
// an explicit --cli flag > project defaultCodingAgent > the run default (DEVLOOP_RUNNER_CLI / claude).
function resolveCodingAgent(opts: Options, projectCfg: ProjectCfg | undefined, agent: Agent): CodingAgent {
  const perAgent = projectCfg?.agents?.[agent]?.codingAgent;
  if (isCodingAgent(perAgent)) return perAgent;
  if (opts.cliExplicit) return opts.cli;
  const projDefault = projectCfg?.defaultCodingAgent;
  if (isCodingAgent(projDefault)) return projDefault;
  return opts.cli;
}

// Level 1 (codingAgent) + level 2 (model + effort). Model/effort precedence, most specific first:
// agents{} (two-level) > models{}/efforts{} (back-compat) > codingAgentDefaults{} > built-in role default.
function resolveLaunchProfile(opts: Options, cfg: ProjectsConfig | null, project: string, agent: Agent): LaunchProfile {
  const projectCfg = cfg?.projects?.[project];
  const codingAgent = resolveCodingAgent(opts, projectCfg, agent);
  const builtin = DEFAULT_LAUNCH_PROFILES[agent][codingAgent];
  const agentCfg = projectCfg?.agents?.[agent];
  const caDefault = projectCfg?.codingAgentDefaults?.[codingAgent];
  const modelCfg = projectCfg?.models?.[agent];
  const effortCfg = projectCfg?.efforts?.[agent];
  const model =
    stringValue(agentCfg?.model)
    ?? modelOverride(modelCfg, codingAgent)
    ?? stringValue(caDefault?.model)
    ?? builtin.model;
  const effort =
    stringValue(agentCfg?.effort)
    ?? effortFromModelOverride(modelCfg, codingAgent)
    ?? effortOverride(effortCfg, codingAgent)
    ?? stringValue(caDefault?.effort)
    ?? builtin.effort;
  return { codingAgent, model, effort: normalizeEffort(codingAgent, effort) };
}

function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end > 0 ? lines.slice(end + 1).join("\n").trimStart() : raw;
}

function readPrompt(opts: Options, agent: Agent, project: string, profile: LaunchProfile): string {
  const skill = join(opts.root, "skills", `${agent}-agent`, "SKILL.md");
  if (!existsSync(skill)) die(`skill file not found for '${agent}': ${skill}. Pass --root <dev-loop checkout>.`, 1);
  const split = runtimeDevSplit(opts);
  const body = stripFrontmatter(readFileSync(skill, "utf8"))
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", opts.root)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", opts.dataDir)
    .replaceAll("${DEVLOOP_DATA_DIR:-~/.dev-loop}", opts.dataDir)
    .replaceAll("${DEVLOOP_DATA_DIR}", opts.dataDir)
    .replaceAll("${DEVLOOP_PROJECTS_JSON}", projectsPath(opts.dataDir));
  return `You are launched by dev-loop's own scheduler. Run exactly one fresh fire for this agent, then stop.

Scheduler context:
- project: ${project}
- agent: ${agent}
- selected agents: ${opts.agents.join(",")}
- coding agent: ${profile.codingAgent}
- launch model: ${profile.model ?? "(cli default)"}
- launch effort: ${profile.effort ?? "(cli default)"}
- DEVLOOP_DEV_SPLIT: ${split ? "true" : "false"}

Treat DEVLOOP_DEV_SPLIT:true as an explicit scheduler/runtime split-dev switch for this fire, equivalent to project config devSplit:true. It is not inferred from tickets, history, or logs.

${body}`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

// The dev-loop-hub MCP server the scheduler injects itself, so NEITHER CLI needs the plugin or a
// pre-existing config. Points at this package's own server entry (.ts source / .js published) + the
// resolved hub db, with the per-fire actor/project. claude takes it as inline --mcp-config JSON;
// codex takes the same shape as `-c` overrides (which define the server, not just patch env).
const serverEntry = join(here, `server${EXT}`);
const hubNode = findCompatibleNode() ?? die(`dev-loop-hub MCP needs Node >= ${MIN_NODE_VERSION} for node:sqlite. Set DEVLOOP_NODE=/absolute/path/to/node.`);
const tomlString = (s: string): string => JSON.stringify(s);
const tomlStringArray = (xs: string[]): string => `[${xs.map(tomlString).join(",")}]`;

function commandFor(opts: Options, agent: Agent, project: string, prompt: string, profile: LaunchProfile, backend: string): { command: string; args: string[] } {
  const devSplit = runtimeDevSplit(opts) ? "true" : "false";
  // MCP wiring is BACKEND-dependent (§18). Only backend:"service" needs the dev-loop-hub MCP; a
  // linear/local project instead needs the operator's OWN MCP config to apply (e.g. the Linear MCP),
  // so we must NOT inject the hub or pass --strict-mcp-config there — that would strip the Linear MCP
  // and starve the agents of the board. An explicit --mcp-config / <cwd>/.mcp.json always wins.
  const hubInject = backend === "service";
  // The CLI is the per-AGENT resolved coding agent (level 1), NOT the run-wide --cli — so one run can
  // mix claude/codex/opencode panes. Model + effort (level 2) are rendered in this coding agent's format.
  if (profile.codingAgent === "claude") {
    // explicit --mcp-config file wins; else on service inject the hub inline (fresh project needs no
    // .mcp.json); else (linear/local) pass NOTHING so claude's normal config — incl. the Linear MCP — applies.
    const mcpArg = opts.mcpConfig ?? (hubInject ? JSON.stringify({
      mcpServers: { "dev-loop-hub": { command: hubNode, args: [serverEntry], env: { DEVLOOP_ACTOR: agent, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: opts.hubDb, DEVLOOP_DEV_SPLIT: devSplit } } },
    }) : undefined);
    return {
      command: opts.claudeBin,
      args: [
        ...(mcpArg ? ["--mcp-config", mcpArg, "--strict-mcp-config"] : []),
        ...(profile.model ? ["--model", profile.model] : []),
        ...(profile.effort ? ["--effort", profile.effort] : []),
        ...opts.extraArgs,
        "-p", prompt,
      ],
    };
  }
  if (profile.codingAgent === "codex") {
    // service ⇒ inject the hub via -c overrides; linear/local ⇒ omit them and let codex's own
    // ~/.codex/config.toml MCP servers (which the operator must wire the Linear MCP into) apply.
    const hubOverrides = hubInject ? [
      "-c", `mcp_servers.dev-loop-hub.command=${tomlString(hubNode)}`,
      "-c", `mcp_servers.dev-loop-hub.args=${tomlStringArray([serverEntry])}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR=${tomlString(agent)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_PROJECT=${tomlString(project)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_HUB_DB=${tomlString(opts.hubDb)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_DEV_SPLIT=${tomlString(devSplit)}`,
    ] : [];
    const args = [
      "exec",
      ...(profile.model ? ["--model", profile.model] : []),
      ...(profile.effort ? ["-c", `model_reasoning_effort=${tomlString(profile.effort)}`] : []),
      ...opts.extraArgs,
      ...hubOverrides,
    ];
    if (!opts.codexSafe) args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    args.push(prompt);
    return { command: opts.codexBin, args };
  }
  // opencode (best-effort; docs/PORTABILITY.md). opencode registers MCP via the operator's MERGED
  // config (config/mcp.opencode.json.example), not inline like claude/codex — so the scheduler only
  // passes the model and relies on the spawn env (set in runAgent) for per-pane identity. opencode's
  // reasoning/effort flag is version-specific, so effort is NOT auto-passed; use --cli-arg if needed.
  // The runtime split switch still rides the env (DEVLOOP_DEV_SPLIT), same as the env identity.
  const args = [
    "run",
    ...(profile.model ? ["--model", profile.model] : []),
    ...opts.extraArgs,
    prompt,
  ];
  return { command: opts.opencodeBin, args };
}

function displayCommand(command: string, args: string[], prompt: string): string {
  return [command, ...args.map((a) => a === prompt ? `<prompt:${prompt.length} chars>` : a).map(shellQuote)].join(" ");
}

// P1 per-fire telemetry: write a `fire.completed` event to the hub so the operator gets a queryable cost/
// outcome ledger (durationMs, exitCode, model/effort) — the precursor the STRATEGY.md budget-ceiling work
// was banked on. Best-effort + lazy: opened once, skipped silently on a non-hub (linear/local) project, and
// never allowed to crash a fire. One writable connection reused across fires (the scheduler is single-writer).
let fireDb: DatabaseSync | null | undefined;                         // undefined = not tried; null = unavailable
let fireLedgerPath: string | null = null;                            // team mode: a backend-agnostic JSONL ledger
function recordFire(hubDb: string, project: string, agent: Agent, profile: LaunchProfile, durationMs: number, exitCode: number, timedOut: boolean): void {
  // Backend-agnostic ledger (team mode): the GA soak success-rate metric needs a data source even on
  // linear, where there is no hub `fire.completed` event. Best-effort append; never crashes a fire.
  if (fireLedgerPath) {
    try {
      mkdirSync(dirname(fireLedgerPath), { recursive: true });
      const row = { ts: new Date().toISOString(), agent, project, codingAgent: profile.codingAgent, model: profile.model ?? null, effort: profile.effort ?? null, durationMs, exitCode, timedOut };
      appendFileSync(fireLedgerPath, JSON.stringify(row) + "\n");
    } catch { /* ledger is best-effort */ }
  }
  try {
    if (fireDb === undefined) { try { fireDb = openDb(hubDb); } catch { fireDb = null; } }
    if (!fireDb) return;
    const projectId = findProject(fireDb, project);
    if (!projectId) return;                                          // not a hub-seeded project ⇒ no ledger to write
    logEvent(fireDb, { project_id: projectId, actor: agent, kind: "fire.completed",
      data: { codingAgent: profile.codingAgent, model: profile.model ?? null, effort: profile.effort ?? null, durationMs, exitCode, timedOut } });
  } catch { /* telemetry is best-effort; a fire's real outcome is its exit code, not this row */ }
}

// ─── R1 change-gate: skip a would-be no-op fire without spawning ────────────────────────────────────────
// The gated inward agents (below) already no-op cheaply inside the fire when neither the code (repo HEAD) nor
// the board (any ticket/comment/doc write → an events row) has moved since they last ran — but paying a full
// CLI turn to *discover* that is the loop's biggest waste on a quiet day. The scheduler can decide it for $0:
// a change-key of (every repo HEAD + max(events.id)) captures ANY code push or board mutation, so an unchanged
// key means the agent would see byte-identical inputs and no-op again. Conservative: gate only these inward
// implementers (ops/communication/reflect are time-based and always fire), and only on the service backend
// (max(events.id) is the board-change signal — linear/local have no hub cursor, so the gate stays off there).
const GATED_AGENTS = new Set<Agent>(["pm", "qa", "dev", "senior-dev", "junior-dev", "architect"]);
function repoPathsFor(cfg: ProjectsConfig | null, project: string): string[] {
  const p = cfg?.projects?.[project] as { repoPath?: string; repos?: { path?: string }[] } | undefined;
  if (p?.repos?.length) return p.repos.map((r) => r.path).filter((x): x is string => !!x);
  return p?.repoPath ? [p.repoPath] : [];
}
function changeKey(opts: Options, cfg: ProjectsConfig | null, project: string): string | null {
  // board cursor: max(events.id) on the hub (any write bumps it). No hub row ⇒ null ⇒ gate disabled for safety.
  if (fireDb === undefined) { try { fireDb = openDb(opts.hubDb); } catch { fireDb = null; } }
  if (!fireDb) return null;
  const projectId = findProject(fireDb, project);
  if (!projectId) return null;
  let cursor = 0;
  try { cursor = Number((fireDb.prepare("SELECT COALESCE(MAX(id),0) AS m FROM events WHERE project_id=?").get(projectId) as { m: number }).m); } catch { return null; }
  const heads = repoPathsFor(cfg, project).map((repo) => {
    try { return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return "no-head"; } // no commits yet / not a repo — a stable sentinel (still gates on the board cursor)
  });
  return `${cursor}|${heads.join(",")}`;
}
type GateState = Record<string, string>;
function gateStatePath(opts: Options, project: string): string { return join(opts.dataDir, project, "scheduler-gate.json"); }
function loadGateState(opts: Options, project: string): GateState {
  try { return JSON.parse(readFileSync(gateStatePath(opts, project), "utf8")) as GateState; } catch { return {}; }
}
function saveGateState(opts: Options, project: string, state: GateState): void {
  try {
    const f = gateStatePath(opts, project); mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(state)); renameSync(tmp, f);
  } catch { /* best-effort — a lost gate write just means the next fire runs (fails open) */ }
}

async function runAgent(opts: Options, cfg: ProjectsConfig | null, agent: Agent, project: string, cwd: string): Promise<number> {
  const profile = resolveLaunchProfile(opts, cfg, project, agent);
  const prompt = readPrompt(opts, agent, project, profile);
  const backend = (cfg?.projects?.[project] as { backend?: string } | undefined)?.backend ?? "linear";
  const { command, args } = commandFor(opts, agent, project, prompt, profile, backend);
  const env = {
    ...process.env,
    DEVLOOP_ACTOR: agent,
    DEVLOOP_PROJECT: project,
    DEVLOOP_HUB_DB: opts.hubDb,
    DEVLOOP_DEV_SPLIT: runtimeDevSplit(opts) ? "true" : "false",
    DEVLOOP_DATA_DIR: opts.dataDir,
    DEVLOOP_PROJECTS_JSON: projectsPath(opts.dataDir),
    DEVLOOP_PLUGIN_ROOT: opts.root,
    CLAUDE_PLUGIN_ROOT: opts.root,
    CLAUDE_PLUGIN_DATA: opts.dataDir,
  };
  const rendered = displayCommand(command, args, prompt);
  if (opts.dryRun) {
    console.log(`[dry-run] ${agent}: cwd=${cwd} cli=${profile.codingAgent} model=${profile.model ?? "(cli default)"} effort=${profile.effort ?? "(cli default)"}`);
    console.log(`[dry-run] ${agent}: ${rendered}`);
    return 0;
  }

  const logDir = opts.logDir || join(opts.dataDir, project, "runner-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${agent}.log`);
  // Unattended runs append forever — rotate at 50MB (single .1 generation) so a chatty agent can't fill the disk.
  try { if (statSync(logPath).size > 50 * 1024 * 1024) renameSync(logPath, `${logPath}.1`); } catch { /* no log yet */ }
  const log = createWriteStream(logPath, { flags: "a" });
  // A stream 'error' with no listener is an uncaught exception that kills the WHOLE scheduler —
  // one ENOSPC/EACCES on a log file must degrade logging, not take down the loop.
  log.on("error", (e) => console.error(`[${agent}] runner-log write failed (${e.message}); continuing without file log`));
  log.write(`\n\n===== ${new Date().toISOString()} ${rendered} cwd=${cwd} =====\n`);
  console.log(`[${new Date().toISOString()}] ${agent}: start (${profile.codingAgent}); log ${logPath}`);

  const startedAt = Date.now();
  const child: RunnerChild = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  activeChildren.add(child);
  child.stdout.on("data", (d) => { process.stdout.write(`[${agent}] ${d}`); log.write(d); });
  child.stderr.on("data", (d) => { process.stderr.write(`[${agent}] ${d}`); log.write(d); });

  return await new Promise((resolveExit) => {
    // Fire timeout: without it a wedged CLI child holds its slot's non-reentrancy flag forever —
    // the agent silently stops firing until the operator notices. SIGTERM first, SIGKILL after 10s
    // (same escalation shape as the daemon lifecycle's lcStop).
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const fireTimer = opts.fireTimeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      console.error(`[${agent}] fire exceeded ${formatDuration(opts.fireTimeoutMs)} — SIGTERM (SIGKILL in 10s)`);
      log.write(`\n===== fire timeout after ${formatDuration(opts.fireTimeoutMs)}: SIGTERM =====\n`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (activeChildren.has(child)) child.kill("SIGKILL"); }, 10_000);
      killTimer.unref?.();
    }, opts.fireTimeoutMs) : undefined;
    fireTimer?.unref?.();
    child.on("error", (e) => { log.write(`\nERROR: ${e.message}\n`); console.error(`[${agent}] failed to start: ${e.message}`); clearTimeout(fireTimer); resolveExit(1); });
    // Resolve on 'exit', not 'close': 'close' additionally waits for the stdio pipes, which a grandchild
    // the CLI spawned can hold open long after the CLI itself died — exactly the wedged case the fire
    // timeout exists for. The log stream stays open until 'close' so late pipe output is still captured.
    child.on("exit", (code, signal) => {
      clearTimeout(fireTimer);
      clearTimeout(killTimer);
      activeChildren.delete(child);
      log.write(`\n===== exit code=${code ?? "null"} signal=${signal ?? "null"}${timedOut ? " (fire timeout)" : ""} =====\n`);
      console.log(`[${new Date().toISOString()}] ${agent}: exit ${code ?? `signal ${signal}`}${timedOut ? " (fire timeout)" : ""}`);
      const exitCode = timedOut ? 124 : (code ?? 1);
      recordFire(opts.hubDb, project, agent, profile, Date.now() - startedAt, exitCode, timedOut);
      resolveExit(exitCode);
    });
    child.on("close", () => log.end());
  });
}

type Slot = { agent: Agent; nextAt: number; running: boolean };
type RunnerChild = ChildProcessByStdio<null, Readable, Readable>; // stdio: ["ignore","pipe","pipe"]
const activeChildren = new Set<RunnerChild>();

// Schema v2: a discoverable workspace is authoritative for BOTH config and state paths (hub db, data dir,
// gate/lock/log roots). A workspace found-but-invalid is a hard stop (fix it, don't run stale).
function resolveWs(opts: Options): Workspace | null {
  let ws;
  try { ws = tryResolveWorkspace(opts.cwd ?? process.cwd()); }
  catch (e) { if (e instanceof WsValidationError) die(e.message, 1); throw e; }
  if (!ws) return null;
  if (!opts.dataDirExplicit) opts.dataDir = wsStateRoot(ws);
  if (!opts.hubDbExplicit) opts.hubDb = wsHubDb(ws);
  return ws;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Team mode: a discoverable workspace runs ONE team-level scheduler that rotates delivery/steward fires
  // across the enabled projects (weighted round-robin). No workspace → the legacy fixed-project path below.
  const ws = resolveWs(opts);
  if (ws) return teamMain(opts, ws);

  const cfg = readProjects(opts.dataDir);
  const project = resolveProject(opts, cfg);
  const cwd = resolveCwd(opts, cfg, project);
  if (!existsSync(cwd)) die(`cwd does not exist: ${cwd}`, 1);
  // Service-backend preflight: an unseeded project means every fire boots the hub MCP straight into its
  // G2 refusal — the agent runs a full LLM turn with zero board access. Catch it before any tokens burn.
  const backend = (cfg?.projects?.[project] as { backend?: string } | undefined)?.backend;
  if (backend === "service") {
    let seeded = false;
    try { const probe = openDb(opts.hubDb); try { seeded = !!findProject(probe, project); } finally { probe.close(); } } catch { seeded = false; }
    if (!seeded) {
      const hint = `seed it once: dev-loop seed ${project} "<Project Name>" <UNIQUE_PREFIX>`;
      if (opts.dryRun) console.log(`[dry-run] WARNING: project '${project}' is backend:"service" but not seeded in ${opts.hubDb} — real fires would get no hub tools; ${hint}`);
      else die(`project '${project}' is backend:"service" but not seeded in the hub DB (${opts.hubDb}) — every fire would burn tokens with no board access; ${hint}`);
    }
  } else {
    // P5: the DL-77 verify gate, the DL-76 no-progress circuit breaker, Human-Blocked reminders, and the
    // accept-rate/cycle-time metrics are all hub/service-only. An unattended loop on linear/local runs with
    // NONE of those runaway rails — surface it once at startup so an adopter following the documented default
    // knows what they're giving up (see the README backend safety matrix).
    console.warn(`dev-loop run: WARNING backend:"${backend ?? "linear"}" has NO loop-governance rails — the verify gate, no-progress breaker, Human-Blocked reminders, and accept-rate metrics are service-only. For an unattended loop, backend:"service" is strongly recommended.`);
  }
  // R1 change-gate: active only when opted in AND on the service backend (needs the hub board cursor).
  const gateActive = opts.changeGate && backend === "service";
  if (opts.changeGate && !gateActive) console.warn(`dev-loop run: --change-gate ignored on backend:"${backend ?? "linear"}" (needs the service hub board cursor)`);
  const gateState = gateActive ? loadGateState(opts, project) : {};
  if (gateActive) console.log(`dev-loop run: change-gate ON for ${[...GATED_AGENTS].filter((g) => opts.agents.includes(g)).join(", ") || "(no gated agents selected)"}`);
  console.log(`dev-loop run: cli=${opts.cli} project=${project} cwd=${cwd}`);
  console.log(`dev-loop run: root=${opts.root} data=${opts.dataDir} hubDb=${opts.hubDb}`);
  const cfgDevSplit = cfg?.projects?.[project]?.devSplit === true;
  const runtimeSplit = runtimeDevSplit(opts);
  if (runtimeSplit || cfgDevSplit) console.log(`dev-loop run: devSplit=${runtimeSplit ? "runtime" : "config"}${cfgDevSplit ? " (config:true)" : ""}`);
  console.log(`dev-loop run: agents=${opts.agents.map((a) => `${a}@${formatDuration(opts.intervals[a])}`).join(", ")}`);
  console.log(`dev-loop run: launch=${opts.agents.map((a) => {
    const p = resolveLaunchProfile(opts, cfg, project, a);
    return `${a}:${p.codingAgent}:${p.model ?? "cli-default"}/${p.effort ?? "cli-default"}`;
  }).join(", ")}`);

  if (opts.once) {
    const results = await Promise.all(opts.agents.map((a) => runAgent(opts, cfg, a, project, cwd)));
    process.exit(results.every((c) => c === 0) ? 0 : 1);
  }

  // Cross-process mutual exclusion: two schedulers for one project double-fire every agent AND put two
  // same-actor fires on one checkout (the §7 claim can't protect a shared working tree). O_EXCL lock with
  // a liveness-checked stale takeover — the same shape as the daemon lifecycle's cold-start lock.
  const lockPath = join(process.env.DEVLOOP_RUN_DIR ?? dirname(opts.hubDb), `run-${project}.lock`);
  if (!opts.dryRun) {
    const takeLock = () => writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
    try { takeLock(); } catch {
      let holder: { pid?: number } = {};
      try { holder = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* unreadable = stale */ }
      const alive = (() => { try { process.kill(holder.pid ?? -1, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } })();
      if (alive) die(`another \`dev-loop run\` for '${project}' is already running (pid ${holder.pid}, lock ${lockPath}); two schedulers double-fire every agent — stop it first`);
      console.log(`dev-loop run: taking over stale run lock (pid ${holder.pid ?? "?"} is gone)`);
      try { unlinkSync(lockPath); } catch { /* raced */ }
      takeLock();
    }
    process.on("exit", () => { try { unlinkSync(lockPath); } catch { /* already gone */ } });
  }

  // Boot stagger: every slot used to start at nextAt=now, so a cold `core` boot fired 5 CLI processes
  // simultaneously against one checkout and one hub. Space the initial fires; steady-state cadence is
  // then completion-relative per slot as before.
  const slots: Slot[] = opts.agents.map((agent, i) => ({ agent, nextAt: Date.now() + i * opts.staggerMs, running: false }));
  let stopping = false;
  let fired = 0; // total fires started; --max-fires caps it (0 = unlimited)
  // Two distinct stop shapes (they were one function, and --max-fires "drain" SIGINT'd the fire it had
  // just launched): interrupt = operator signal, forward it to children; drain = stop scheduling NEW
  // fires but let in-flight fires finish (--max-fires' documented contract).
  const drain = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (activeChildren.size === 0) process.exit(0);
  };
  const interrupt = () => {
    const first = !stopping;
    drain();
    if (first) console.log("dev-loop run: stopping; forwarding SIGINT to active agent processes");
    for (const child of activeChildren) child.kill("SIGINT");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const tick = () => {
    const now = Date.now();
    for (const slot of slots) {
      if (stopping || slot.running || slot.nextAt > now) continue;
      // R1: for a gated agent, if neither the code nor the board moved since its last fire, skip the spawn
      // entirely (the agent would just no-op). fails open: a null key (no hub / git error) never skips.
      if (gateActive && GATED_AGENTS.has(slot.agent)) {
        const key = changeKey(opts, cfg, project);
        if (key !== null && gateState[slot.agent] === key) {
          slot.nextAt = now + opts.intervals[slot.agent];
          continue; // no change since last fire ⇒ don't pay for a no-op turn
        }
      }
      slot.running = true;
      fired++;
      runAgent(opts, cfg, slot.agent, project, cwd)
        .catch((e) => { console.error(`[${slot.agent}] ${e instanceof Error ? e.message : String(e)}`); return 1; })
        .finally(() => {
          slot.running = false;
          slot.nextAt = Date.now() + opts.intervals[slot.agent];
          // Record the POST-fire change-key so the next tick compares against the state this fire left behind
          // (an agent's own writes bump the key once, then it settles → skips until the NEXT external change).
          if (gateActive && GATED_AGENTS.has(slot.agent)) {
            const key = changeKey(opts, cfg, project);
            if (key !== null) { gateState[slot.agent] = key; saveGateState(opts, project, gateState); }
          }
          if (stopping && activeChildren.size === 0) process.exit(0);
        });
      if (opts.maxFires && fired >= opts.maxFires) {
        console.log(`dev-loop run: reached --max-fires ${opts.maxFires}; draining active fires then exiting`);
        drain();
        break;
      }
    }
  };
  const timer = setInterval(tick, 1_000);
  tick();
}

// ─── Team mode: one scheduler, weighted round-robin across the enabled projects ─────────────────────────
// Each agent has its own cadence slot (unchanged); when a slot fires, the target project is chosen by the
// shared smooth-WRR cursor (rotation.ts). `--project` degrades to a filter (rotate over just that one).
// In M3 EVERY agent still fires per-project (steward team-scoping is M4); rotation is the only new behavior.
async function teamMain(opts: Options, ws: Workspace): Promise<void> {
  const cfg = toLegacyView(ws) as unknown as ProjectsConfig;
  const backend = ws.file.team.backend;

  // `--project` filter: restrict rotation to a single named project (must exist + be enabled).
  const allCandidates = rotationCandidates(ws);
  const candidates = opts.project ? allCandidates.filter((c) => c.key === opts.project) : allCandidates;
  if (opts.project && !candidates.length) die(`--project '${opts.project}' is not an enabled, positively-weighted project in team '${ws.file.team.key}'`, 2);
  if (!candidates.length) die(`no enabled, positively-weighted project to fire in team '${ws.file.team.key}' (all disabled or weight:0?)`, 2);

  console.log(`dev-loop run: team '${ws.file.team.key}' @ ${ws.root} (backend:${backend}); projects=${candidates.map((c) => `${c.key}×${c.weight}`).join(", ")}`);
  console.log(`dev-loop run: agents=${opts.agents.map((a) => `${a}@${formatDuration(opts.intervals[a])}`).join(", ")}`);

  // A local WRR picker over just the (possibly filtered) candidate set, persisting the shared cursor.
  let schedState: SchedulerState = loadSchedulerState(ws);
  const pickProject = (agent: Agent): string => {
    // pickAndAdvance uses rotationCandidates(ws); to honor a --project filter we run the step on `candidates`.
    const { pick, cur } = smoothWRRStep(candidates, schedState[agent] ?? {});
    schedState[agent] = cur as CursorMap;
    saveSchedulerState(ws, schedState);
    return pick ?? candidates[0].key;
  };

  // --plan: print the next N (agent, project) picks WITHOUT firing or persisting (a preview).
  if (opts.plan > 0) {
    const preview: SchedulerState = JSON.parse(JSON.stringify(schedState));
    console.log(`dev-loop run: --plan ${opts.plan} (agent → project; no fires, cursor untouched):`);
    for (let i = 0; i < opts.plan; i++) {
      for (const agent of opts.agents) {
        const { pick, cur } = smoothWRRStep(candidates, preview[agent] ?? {});
        preview[agent] = cur as CursorMap;
        console.log(`  ${String(i + 1).padStart(3)}  ${agent} → ${pick}`);
      }
    }
    return;
  }

  const fireLedger = wsFireLedger(ws);
  fireLedgerPath = fireLedger; // recordFire appends here (backend-agnostic soak metric)

  const cwdFor = (project: string): string | null => primaryRepo(ws, project);

  // change-gate key per (agent, project) — service only, fails open (null key never skips). We evaluate it
  // AFTER a pick; a gate-skip advances to the next candidate in the same slot fire so a quiet project never
  // eats the fire opportunity of an active sibling.
  const gateActive = opts.changeGate && backend === "service";
  if (opts.changeGate && !gateActive) console.warn(`dev-loop run: --change-gate ignored on backend:"${backend}" (needs the service hub board cursor)`);
  const gateState: Record<string, string> = gateActive ? loadGateState(opts, "team") : {};
  const gateKey = (agent: Agent, project: string) => `${agent}:${project}`;

  // A single fire for one agent: pick a project (skipping gated-unchanged ones up to one full rotation),
  // resolve its cwd, and run. Returns after the fire (or immediately if every candidate is gated).
  const fireAgentOnce = async (agent: Agent): Promise<void> => {
    let project: string | null = null;
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const p = pickProject(agent); // advances the shared cursor every attempt (skip-advance)
      if (gateActive && GATED_AGENTS.has(agent)) {
        const key = changeKey(opts, cfg, p);
        if (key !== null && gateState[gateKey(agent, p)] === key) continue; // unchanged ⇒ skip, try next candidate
      }
      project = p; break;
    }
    if (project === null) return; // every candidate gated-unchanged this round ⇒ no fire
    const cwd = cwdFor(project);
    if (!cwd || !existsSync(cwd)) { console.error(`[${agent}] project '${project}' has no usable repo cwd (${cwd ?? "none"}); skipping`); return; }
    await runAgent(opts, cfg, agent, project, cwd);
    if (gateActive && GATED_AGENTS.has(agent)) {
      const key = changeKey(opts, cfg, project);
      if (key !== null) { gateState[gateKey(agent, project)] = key; saveGateState(opts, "team", gateState); }
    }
  };

  if (opts.once) {
    for (const a of opts.agents) await fireAgentOnce(a);
    process.exit(0);
  }

  // One scheduler per team: the run lock is team-scoped (two schedulers for one team double-fire everything).
  const lockPath = wsLockPath(ws, "run");
  if (!opts.dryRun) acquireRunLock(lockPath, ws.file.team.key);

  // Hot-reload dev-loop.json on mtime change: enabled/weight edits take effect without a restart. A parse
  // failure keeps the last-good config (never run with a half-written file).
  let cfgMtime = safeMtime(ws.filePath);
  const hotReload = () => {
    const m = safeMtime(ws.filePath);
    if (m === cfgMtime) return;
    cfgMtime = m;
    try {
      const fresh = tryResolveWorkspace(ws.root);
      if (fresh) { ws = fresh; const c = rotationCandidates(ws); candidates.length = 0; candidates.push(...(opts.project ? c.filter((x) => x.key === opts.project) : c)); schedState = pruneCursor(schedState, candidates.map((x) => x.key)); console.log(`dev-loop run: reloaded dev-loop.json — projects=${candidates.map((x) => x.key).join(", ")}`); }
    } catch (e) { console.error(`dev-loop run: dev-loop.json reload failed (${(e as Error).message}); keeping the last-good config`); }
  };

  const slots: Slot[] = opts.agents.map((agent, i) => ({ agent, nextAt: Date.now() + i * opts.staggerMs, running: false }));
  let stopping = false;
  let fired = 0;
  const drain = () => { if (stopping) return; stopping = true; clearInterval(timer); if (activeChildren.size === 0) process.exit(0); };
  const interrupt = () => { const first = !stopping; drain(); if (first) console.log("dev-loop run: stopping; forwarding SIGINT to active agent processes"); for (const child of activeChildren) child.kill("SIGINT"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const tick = () => {
    hotReload();
    const now = Date.now();
    for (const slot of slots) {
      if (stopping || slot.running || slot.nextAt > now) continue;
      slot.running = true;
      fired++;
      fireAgentOnce(slot.agent)
        .catch((e) => { console.error(`[${slot.agent}] ${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => {
          slot.running = false;
          slot.nextAt = Date.now() + opts.intervals[slot.agent];
          if (stopping && activeChildren.size === 0) process.exit(0);
        });
      if (opts.maxFires && fired >= opts.maxFires) { console.log(`dev-loop run: reached --max-fires ${opts.maxFires}; draining then exiting`); drain(); break; }
    }
  };
  const timer = setInterval(tick, 1_000);
  tick();
}

function safeMtime(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }
function pruneCursor(state: SchedulerState, keys: string[]): SchedulerState {
  const keep = new Set(keys); const out: SchedulerState = {};
  for (const [agent, cur] of Object.entries(state)) { const c: CursorMap = {}; for (const [k, v] of Object.entries(cur)) if (keep.has(k)) c[k] = v; out[agent] = c; }
  return out;
}
// The team run lock (O_EXCL + liveness-checked stale takeover) — mirrors the fixed-project lock in main().
function acquireRunLock(lockPath: string, teamKey: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const take = () => writeFileSync(lockPath, JSON.stringify({ pid: process.pid, team: teamKey, startedAt: new Date().toISOString() }), { flag: "wx" });
  try { take(); } catch {
    let holder: { pid?: number } = {};
    try { holder = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* unreadable = stale */ }
    const alive = (() => { try { process.kill(holder.pid ?? -1, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } })();
    if (alive) die(`another \`dev-loop run\` for team '${teamKey}' is already running (pid ${holder.pid}, lock ${lockPath}); two schedulers double-fire every agent — stop it first`);
    console.log(`dev-loop run: taking over stale team run lock (pid ${holder.pid ?? "?"} is gone)`);
    try { unlinkSync(lockPath); } catch { /* raced */ }
    take();
  }
  process.on("exit", () => { try { unlinkSync(lockPath); } catch { /* already gone */ } });
}

main().catch((e) => die(e instanceof Error ? e.message : String(e), 1));
