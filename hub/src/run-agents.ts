#!/usr/bin/env node
// `dev-loop run` — a small scheduler that fires agent SKILLs through a headless CLI.
// It deliberately does NOT depend on Claude/Codex `/loop`; it owns cadence here and
// shells out to `claude -p`, `codex exec`, or `opencode run` once per agent fire.
import { spawn, execFileSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync, appendFileSync, chmodSync, openSync, closeSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveProjectFromCwd } from "./resolve-project.ts";
import { tryResolveWorkspace, wsStateRoot, wsHubDb, wsLockPath, wsFireLedger } from "./workspace.ts";
import { toLegacyView, WsValidationError, primaryRepo, agentInterfaceFor, TEAM_INTAKE_PROJECT, CADENCE_DUR_RE, type Workspace, type HubBlock, type AgentInterface, type ProviderEntry } from "./team-config.ts";
import { rotationCandidates, stewardProjects, smoothWRRStep, loadSchedulerState, saveSchedulerState, type SchedulerState, type CursorMap } from "./rotation.ts";
import { notify } from "./comms.ts";
import { secretsInjectedKeys } from "./secrets.ts"; // Q9: the per-fire secret-scoping strip set
import { assembleBootCorpus } from "./boot-prefix.ts";
import { findCompatibleNode, MIN_NODE_VERSION } from "./node-runtime.ts";
import { devloopDataDir, devloopProjectsPath, hubDbPath, projectConfigCandidates, guardCliPath } from "./paths.ts";
import { openDb, logEvent } from "./db.ts";
import { findProject, AGENT_HANDLES, STEWARD_HANDLES } from "./seed.ts";
import { AGENT_GROUPS } from "./agent-roster.ts"; // LOOP-184: group aliases shared with the bundle-load validator — a zod-free leaf (roster still sourced from seed.ts AGENT_HANDLES)
import { writeSchedulerBuild, teamDirOf } from "./scheduler-build.ts"; // LOOP-253: which build is orchestrating this loop — a zod-free leaf, same LOOP-58 reason
import { preflightTreeSnapshot } from "./tree-snapshot.ts"; // LOOP-312: pre-fire copy of the shared checkout — a zod-free leaf, for the same LOOP-58 reason as servable.ts below
import { servableSlice, isDevTierActor } from "./servable.ts"; // LOOP-144: the SHARED servable predicate the queue-depth gate consumes — a zod-free leaf (NOT agentops, whose tooldefs→zod tree would break the src-only --help load, LOOP-58)
import { updateTicketRow, insertComment } from "./ticketwrite.ts";
import { makeSeenLineWindow, RETRY_LOOP_LINE_WINDOW } from "./seen-lines.ts"; // retry-loop detector memory (bounded + rolling)
import { breaker, formatBreakerMsg, providerOf, classifyFireError } from "./breaker.ts";
import { codexUsageAdapter, claudeAdapter, opencodeAdapter, resolveAdapter } from "./fire-usage.ts";
import { releaseClaimedTickets } from "./ticket-release.ts";
import { rollingSpendUsd, ratePerMsFor, readFireRows, perFireDeadline, DEFAULT_PER_FIRE_USD, type FireUsage } from "./metrics.ts";
import type { DatabaseSync } from "node:sqlite";

// A2: the scheduler roster IS the seed roster — one source (seed.ts AGENT_HANDLES). A gap between the two
// used to fire an agent the hub refuses (G1) — tokens burned, board unwritable. Now they cannot diverge.
const VALID_AGENTS = AGENT_HANDLES;
type Agent = (typeof VALID_AGENTS)[number];

// A coding-agent CLI the scheduler can drive. `claude` + `codex` are fully wired; `opencode` is
// recognized everywhere in config (per-agent selection + per-coding-agent defaults) and launched
// best-effort via `opencode run` — its MCP is registered through the operator's merged opencode
// config, not inline (see docs/PORTABILITY.md). On backend:"service" how a fire reaches the hub is
// the D8 agent interface (hub.agentInterface, resolved per coding agent): "cli" fires get NO hub MCP
// injection — the agent calls the PATH-installed `dev-loop` write verbs, identity riding the spawn
// env — while "mcp" fires keep the scheduler-injected dev-loop-hub server (claude inline JSON /
// codex -c overrides). Adding a CLI = extend this union + DEFAULT_LAUNCH_PROFILES + commandFor().
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
type AgentLaunchConfig = { codingAgent?: string; model?: string; effort?: string; fireTimeout?: string; stallTimeout?: string };

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
const GROUPS: Record<string, Agent[]> = AGENT_GROUPS; // one source, shared with bundle-load (LOOP-184)
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
  // Workspace-level repo registry (flat RepoEntry facts). ONLY the v1 projects.json path can carry
  // one: `toLegacyView` returns LegacyProjectsConfig, which has no `repos` field, and the
  // `as unknown as ProjectsConfig` cast below hides that — so on every v2 workspace this reads
  // `undefined` at runtime (LOOP-279). boot-prefix therefore resolves repo facts from the INLINE
  // per-project repos[] the projection does emit, and uses this registry only to resolve a bare
  // {ref} pointer. Do not add a consumer that depends on this being populated.
  repos?: Record<string, unknown>;
  projects?: Record<string, {
    devSplit?: boolean;
    // Two-level launch config (conventions §11 / config-schema):
    defaultCodingAgent?: string;                                       // project-wide level-1 default coding agent
    codingAgentDefaults?: Partial<Record<CodingAgent, CodingAgentDefault>>; // per-coding-agent default model + effort
    agents?: Partial<Record<Agent, AgentLaunchConfig>>;               // per-agent: codingAgent + model + effort
    hub?: HubBlock;                                                    // D8: agentInterface per coding agent ("cli"|"mcp"; service only)
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
  intervalsExplicit: Set<Agent>; // agents whose cadence came from --interval (beats config cadence)
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
  assembleBoot: boolean; // boot-prefix: append the deterministic §0a boot corpus (conventions union + lessons + backend contract) to the fire prompt — stable prefix for prompt caching; claude lane only (prompt rides stdin: Linux MAX_ARG_STRLEN caps a single execve arg at 128 KiB)
  changeGateTtlMs: number; // R1a: quiet-board TTL for the pm/qa REVIEW tiers — after this long without a fire, a gated pm/qa fire runs even on an unchanged key (0 = never; the pure gate for them too)
  fireTimeoutMs: number; // 0 = none; else SIGTERM (then SIGKILL) a fire that outlives this — a wedged CLI child must not disable its slot forever
  stallTimeoutMs?: number; // liveness watchdog: kill a fire whose combined output has been SILENT this long (errorClass "stalled" — feeds the breaker). undefined = per-lane default: 10m on opencode (it streams tool lines; silence = a hung provider call / silent retry loop — the 2026-07 quota-429 incident wedged every fire for the full hour), 0 (off) on claude/codex (claude -p buffers output until the end, so silence is normal there)
  staggerMs: number;    // boot stagger between the initial slot fires (0 = all at once)
  background: boolean;  // re-spawn detached (log → <workspace>/.dev-loop/run.log) and return the shell — the operator-console flow's "start the loop from my coding-CLI session" verb
  mcpConfig?: string;   // claude: explicit MCP config; defaults to <cwd>/.mcp.json if present
  extraArgs: string[];
  // Model-provider routing (team mode only; teamMain fills these from team.providers /
  // team.opencodePermission — the legacy fixed-project path has no registry and leaves them unset).
  providers?: Record<string, ProviderEntry>;
  opencodePermission?: Record<string, unknown>;
  wsRoot?: string; // Q9 secret scoping: the workspace whose secrets.env-injected keys are stripped per fire
  perAgentFireTimeoutMs?: Partial<Record<Agent, number>>;   // per-agent override; beats opts.fireTimeoutMs
  perAgentStallTimeoutMs?: Partial<Record<Agent, number>>;  // per-agent override; beats opts.stallTimeoutMs
};

// The certified unattended permission policy for opencode fires (PORTABILITY §5, 2026-07-16 on 1.2.24):
// deny-by-default is LOAD-BEARING — operator-installed global extensions add exec-capable tools the
// scheduler has never heard of (an `interactive_bash` tmux tool escaped a narrow bash-only deny AND
// dropped the fire's identity env). Explicit allows cover the standard fire toolset; everything else —
// known interactive/web tools and unknown custom tools alike — is closed. Operators replace the whole
// object via team.opencodePermission (E16). Injected per fire as OPENCODE_PERMISSION (after the
// process.env spread, so the fire policy beats any operator export).
const DEFAULT_OPENCODE_PERMISSION: Record<string, unknown> = {
  "*": "deny",
  read: "allow", edit: "allow", glob: "allow", grep: "allow",
  bash: "allow", task: "allow", skill: "allow", lsp: "allow",
  question: "deny", webfetch: "deny", websearch: "deny", external_directory: "deny", doom_loop: "deny",
};

// On opencode the model-string prefix IS the provider selection (`provider/model-id`); a registry entry
// exists only for CUSTOM endpoints (team.providers), so a miss simply means a built-in opencode provider.
function opencodeProviderEntry(opts: Options, model: string | undefined): ProviderEntry | undefined {
  const prefix = model?.split("/")[0];
  return prefix && prefix !== model ? opts.providers?.[prefix] : undefined;
}

// P0-1b — coarse failure taxonomy for the fire ledger. Matched over the bounded output tail, most
// specific first. "spend-limit" is the field report's 48h-blind-retry class: 407 consecutive ~2s
// failures, every one the same stderr line, indistinguishable in the ledger from real task failures.
// The breaker (P0-1a) keys on repeated identical classes; metrics/doctor split them out. exit-0 shapes
// stay the suspectError flag's job; a non-zero exit with no pattern match is a plain task failure (null).
// classifyFireError moved to breaker.ts (importable) — LOOP-114 needs a regression test that
// asserts the exact provider tails, and nothing may import run-agents.ts (main() is unconditional).

// providerOf moved to breaker.ts (an importable leaf) so the breaker can resolve a provider for an
// agent that has not yet completed a fire — LOOP-72. Imported above; ONE definition, both callers.

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
  dev-loop run --cli claude   [--project <key>] [--agents core,communication]
  dev-loop run --cli codex    [--project <key>] [--agents core,outward]
  dev-loop run --cli opencode [--project <key>] [--agents core]

Cadence is owned by this process, not by Claude/Codex /loop. Each fire shells out once:
  claude -p <agent skill prompt>
  codex exec ... <agent skill prompt>
  opencode run [--variant <effort>] ... <agent skill prompt>   (certified permission policy injected via env)

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
  --assemble-boot             append the deterministic §0a boot corpus (conventions union + lessons + backend
                              contract) to each claude fire's prompt via stdin — a byte-stable prefix so
                              consecutive fires of one agent can hit the prompt cache; the fire skips its own
                              boot reads (env: DEVLOOP_ASSEMBLE_BOOT=1)
  --change-gate               skip spawning a gated inward agent (pm/qa/dev/senior-dev/junior-dev/architect) when
                              neither any repo HEAD nor the hub board moved since its last fire — the biggest cost
                              saver on a quiet loop (service backend only; the agents already no-op in that case,
                              this just avoids paying for the full turn to discover it). pm/qa are REVIEW tiers
                              whose lens-rotation / coverage-expansion work is at its best precisely when nothing
                              changed, so an unchanged board only DEFERS them: after --change-gate-ttl without a
                              fire they run once anyway (dev-tier + architect keep the pure gate)
  --change-gate-ttl <dur>     how long a quiet board may defer a gated pm/qa fire before it runs anyway
                              (default 4h; 0 = defer forever — the pure gate for pm/qa too)
  --fire-timeout <dur>        kill a fire that outlives this (SIGTERM, then SIGKILL after 10s; default 1h; 0 = none)
  --stall-timeout <dur>       liveness watchdog: kill a fire whose output has been SILENT this long (errorClass
                              "stalled") OR whose output keeps arriving but introduces no NEW content for this long
                              (errorClass "retry-loop"), and record it — both feed the breaker. Default: 10m on
                              opencode fires (they stream; silence = a hung provider call, e.g. a quota-429 retry
                              loop), off on claude/codex (claude -p buffers until the end). 0 = off everywhere
  --background                start the scheduler DETACHED and return the shell: output appends to
                              <workspace>/.dev-loop/run.log; stop it with \`dev-loop stop\` (the operator-console flow)
  --stagger <dur>             delay between the initial slot fires so a cold boot doesn't launch every agent at once (default 20s; 0 = simultaneous)
  --codex-safe                omit Codex's unsafe bypass flags; useful for read-only/dry runs
  --breaker <n>               failure-streak circuit breaker: N consecutive identical failures of one agent
                              trip its slot to the probe cadence until a fire succeeds (default 5; 0 = off)
  --breaker-probe <dur>       probe cadence while a breaker is open (default 1h; never faster than the slot)
  --cli-arg <arg>             pass an extra arg to the selected CLI before the prompt; may repeat
                              (CLI binaries: set DEVLOOP_CLAUDE_BIN / DEVLOOP_CODEX_BIN / DEVLOOP_OPENCODE_BIN to override)

Durations accept ms/s/m/h/d. Default agents: core = pm,qa,senior-dev,junior-dev,sweep.
Per-agent launch is two-level (projects.json): agents{}.<agent> picks { codingAgent, model, effort };
codingAgentDefaults{}.<codingAgent> sets per-coding-agent default { model, effort }. The legacy
models{}/efforts{} maps still apply. Resolution: agents{} > models/efforts > codingAgentDefaults > built-in.
Use --agents legacy (or --agents pm,qa,dev,sweep) for the old single-dev loop.`);
}

/**
 * Wait for stdout/stderr to reach the OS before exiting.
 *
 * `process.exit()` DISCARDS whatever is still queued for an asynchronous stdio target. Writes to a
 * FILE are synchronous, so a redirected run never showed this; writes to a PIPE are not, so the last
 * lines vanish exactly when output is being captured — `| tee`, CI, a test harness's spawnSync.
 *
 * Measured (LOOP-346): a `--once` fire killed as a retry loop wrote its ledger event correctly and
 * printed nothing. The `sweep: exit … (retry-loop)` line — the only human-visible carrier of the
 * error class — was queued and dropped, so the run read as though it ended silently. It survived
 * whenever the pipe happened to drain before the exit, which is why it passed on CI and failed on a
 * loaded workstation.
 *
 * The same hazard is already recorded one layer down at the runner-log stream ("--once's
 * process.exit() truncated the un-flushed tail"); that fix covered the log FILE and left stdout.
 *
 * A zero-length write's callback fires after everything queued ahead of it has been handed off, which
 * is exactly the ordering guarantee needed — no delay, no polling.
 */
async function flushStdio(): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((s) =>
    new Promise<void>((res) => { s.write("", () => res()); })));
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
  if (ms > 2_147_483_647) die(`duration '${input}' (${ms}ms) exceeds Node's 32-bit timer limit (~24.8d); setTimeout would coerce it to 1ms, killing the fire immediately`);
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
    intervalsExplicit: new Set<Agent>(),
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
    assembleBoot: process.env.DEVLOOP_ASSEMBLE_BOOT === "1",
    changeGateTtlMs: 4 * 60 * 60_000,
    fireTimeoutMs: 60 * 60_000,
    staggerMs: 20_000,
    background: false,
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
      opts.intervalsExplicit.add(agent as Agent);
    } else if (a === "--once") opts.once = true;
    else if (a === "--plan") { opts.plan = Number(next()); if (!Number.isInteger(opts.plan) || opts.plan <= 0) die("--plan must be a positive integer"); }
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--root") opts.root = guardCliPath("--root", resolve(next()));
    else if (a === "--data") { opts.dataDir = guardCliPath("--data", resolve(next())); opts.dataDirExplicit = true; }
    else if (a === "--hub-db") { opts.hubDb = guardCliPath("--hub-db", resolve(next())); opts.hubDbExplicit = true; }
    else if (a === "--cwd") opts.cwd = guardCliPath("--cwd", resolve(next()));
    else if (a === "--mcp-config") opts.mcpConfig = guardCliPath("--mcp-config", resolve(next()));
    else if (a === "--max-fires") {
      opts.maxFires = Number(next());
      if (!Number.isInteger(opts.maxFires) || opts.maxFires < 0) die("--max-fires must be a non-negative integer (0 = unlimited)");
    }
    else if (a === "--change-gate") opts.changeGate = true;
    else if (a === "--assemble-boot") opts.assembleBoot = true;
    else if (a === "--change-gate-ttl") { const v = next(); opts.changeGateTtlMs = v.trim() === "0" ? 0 : parseDuration(v); } // 0 = pure gate for pm/qa too
    else if (a === "--fire-timeout") { const v = next(); opts.fireTimeoutMs = v.trim() === "0" ? 0 : parseDuration(v); } // 0 = disabled (parseDuration rejects non-positive)
    else if (a === "--stall-timeout") { const v = next(); opts.stallTimeoutMs = v.trim() === "0" ? 0 : parseDuration(v); } // explicit value applies to EVERY lane (0 = off); unset keeps the per-lane default
    else if (a === "--background") opts.background = true;
    else if (a === "--stagger") { const v = next(); opts.staggerMs = v.trim() === "0" ? 0 : parseDuration(v); }
    else if (a === "--codex-safe") opts.codexSafe = true;
    else if (a === "--cli-arg") extraArgs.push(next());
    else if (a === "--breaker") { breaker.threshold = Number(next()); if (!Number.isInteger(breaker.threshold) || breaker.threshold < 0) die("--breaker must be a non-negative integer (0 = off)"); }
    else if (a === "--breaker-probe") breaker.probeMs = parseDuration(next());
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

// 1.0 clean break: with no workspace, config comes ONLY from an EXPLICIT injection — the --data flag
// or DEVLOOP_PROJECTS_JSON (tests/CI). The implicit machine-global v1 fallback is gone.
function readProjects(opts: Options): ProjectsConfig | null {
  if (!opts.dataDirExplicit && !process.env.DEVLOOP_PROJECTS_JSON) return null;
  for (const p of projectConfigCandidates(opts.dataDir)) {
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
  die(`no workspace found from ${cwd} (and no explicit --data/DEVLOOP_PROJECTS_JSON injection). 1.0 no longer reads ~/.dev-loop/projects.json — create a workspace: dev-loop team init; migrate a v1 setup once: dev-loop team import. Configured projects: ${configured}.`, 2);
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

// Team-scope fire context (M4 stewards): the enabled-project list plus the team comms channel fact.
// teamComms is load-bearing for communication fires — the §22a director digest is gated on TEAM.COMMS
// presence (the channel), NOT on any per-project "communication" block (that block only configures
// article drafting, and `_team` never has one — keying the digest on it silently suppressed the
// director's one message a day).
type TeamScope = { enabledProjects: string[]; teamComms?: { provider: string; webhookEnv: string } | null };

function readPrompt(opts: Options, agent: Agent, project: string, profile: LaunchProfile, teamScope?: TeamScope): string {
  const skill = join(opts.root, "skills", `${agent}-agent`, "SKILL.md");
  if (!existsSync(skill)) die(`skill file not found for '${agent}': ${skill}. Pass --root <dev-loop checkout>.`, 1);
  const split = runtimeDevSplit(opts);
  const body = stripFrontmatter(readFileSync(skill, "utf8"))
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", opts.root)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", opts.dataDir)
    .replaceAll("${DEVLOOP_DATA_DIR:-~/.dev-loop}", opts.dataDir)
    .replaceAll("${DEVLOOP_DATA_DIR}", opts.dataDir)
    .replaceAll("${DEVLOOP_PROJECTS_JSON}", projectsPath(opts.dataDir));
  const commsLine = teamScope
    ? teamScope.teamComms
      ? `- team comms: ${teamScope.teamComms.provider} (webhook env ${teamScope.teamComms.webhookEnv}) — \`dev-loop notify\` is wired\n`
      : `- team comms: not configured — \`dev-loop notify\` has no channel\n`
    : "";
  const digestLine = teamScope && agent === "communication"
    ? teamScope.teamComms
      ? `- §22a digest gate: the team comms line above IS the digest gate — compose and push the team daily digest even when no project carries a per-project "communication" block (that block governs article drafting only, never the digest)\n`
      : `- §22a digest gate: no team comms channel — skip the digest push and surface the missing channel in your report\n`
    : "";
  const teamLines = teamScope
    ? `- team-scope: true (this is a TEAM-level fire — iterate/route across the enabled projects below, do not act on a single project only)
- enabled projects: ${teamScope.enabledProjects.join(", ")}\n${commsLine}${digestLine}`
    : "";
  return `You are launched by dev-loop's own scheduler. Run exactly one fresh fire for this agent, then stop.

Scheduler context:
- project: ${project || "(team scope — no single project)"}
- agent: ${agent}
${teamLines}- selected agents: ${opts.agents.join(",")}
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

function commandFor(opts: Options, agent: Agent, project: string, prompt: string, profile: LaunchProfile, backend: string, iface: AgentInterface, fireId: string, promptViaStdin = false): { command: string; args: string[]; stdinPayload?: string } {
  const devSplit = runtimeDevSplit(opts) ? "true" : "false";
  // MCP wiring is BACKEND-dependent (§18) AND interface-dependent (D8/D9). Only backend:"service" needs
  // the dev-loop-hub MCP; a linear/local project instead needs the operator's OWN MCP config to apply
  // (e.g. the Linear MCP), so we must NOT inject the hub or pass --strict-mcp-config there — that would
  // strip the Linear MCP and starve the agents of the board. On service, interface="cli" fires get NO
  // injection either: the agent reaches the board through the PATH-installed `dev-loop` write verbs,
  // identity riding the spawn env (runAgent). An explicit --mcp-config always wins on claude.
  const hubInject = backend === "service" && iface === "mcp";
  // The CLI is the per-AGENT resolved coding agent (level 1), NOT the run-wide --cli — so one run can
  // mix claude/codex/opencode panes. Model + effort (level 2) are rendered in this coding agent's format.
  if (profile.codingAgent === "claude") {
    // explicit --mcp-config file wins; else on service+interface="mcp" inject the hub inline (fresh
    // project needs no .mcp.json); else (linear/local, or service on the D9 "cli" interface) pass
    // NOTHING — claude's normal config applies and a "cli" fire talks to the hub via `dev-loop`.
    const mcpArg = opts.mcpConfig ?? (hubInject ? JSON.stringify({
      mcpServers: { "dev-loop-hub": { command: hubNode, args: [serverEntry], env: { DEVLOOP_ACTOR: agent, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: opts.hubDb, DEVLOOP_DEV_SPLIT: devSplit, DEVLOOP_FIRE_ID: fireId } } },
    }) : undefined);
    return {
      command: opts.claudeBin,
      args: [
        ...(mcpArg ? ["--mcp-config", mcpArg, "--strict-mcp-config"] : []),
        ...(profile.model ? ["--model", profile.model] : []),
        ...(profile.effort ? ["--effort", profile.effort] : []),
        ...claudeAdapter.extraArgs, // "--output-format json" — one terminal JSON object for token/cost + result-text capture
        ...opts.extraArgs,
        // boot-prefix fires pipe the (large) prompt via stdin: Linux MAX_ARG_STRLEN caps one
        // execve argument at 128 KiB, and an assembled corpus exceeds it. `claude -p` with no
        // positional reads the prompt from stdin (the documented headless piping form).
        ...(promptViaStdin ? ["-p"] : ["-p", prompt]),
      ],
      ...(promptViaStdin ? { stdinPayload: prompt } : {}),
    };
  }
  if (profile.codingAgent === "codex") {
    // service+interface="mcp" ⇒ inject the hub via -c overrides; linear/local (or a "cli"-flipped
    // codex, post-P8) ⇒ omit them and let codex's own ~/.codex/config.toml MCP servers apply.
    const hubOverrides = hubInject ? [
      "-c", `mcp_servers.dev-loop-hub.command=${tomlString(hubNode)}`,
      "-c", `mcp_servers.dev-loop-hub.args=${tomlStringArray([serverEntry])}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR=${tomlString(agent)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_PROJECT=${tomlString(project)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_HUB_DB=${tomlString(opts.hubDb)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_DEV_SPLIT=${tomlString(devSplit)}`,
      "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_FIRE_ID=${tomlString(fireId)}`,
    ] : [];
    const args = [
      "exec",
      ...codexUsageAdapter.extraArgs, // "--json" — structured JSONL output for usage capture
      ...(profile.model ? ["--model", profile.model] : []),
      ...(profile.effort ? ["-c", `model_reasoning_effort=${tomlString(profile.effort)}`] : []),
      ...opts.extraArgs,
      ...hubOverrides,
    ];
    if (!opts.codexSafe) args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    args.push(prompt);
    return { command: opts.codexBin, args };
  }
  // opencode (certified 2026-07-16 on 1.2.24; docs/PORTABILITY.md §5). Default interface is "cli"
  // (identity rides the spawn env into the bash tool); on the "mcp" rollback opencode registers MCP via
  // the operator's MERGED config (config/mcp.opencode.json.example), not inline like claude/codex.
  // Effort rides `--variant` (opencode's reasoning-effort flag, values model-specific, passed raw) —
  // a registry provider opts out via effortMode:"strip". The split switch rides the env (DEVLOOP_DEV_SPLIT).
  const passEffort = profile.effort && opencodeProviderEntry(opts, profile.model)?.effortMode !== "strip";
  const args = [
    "run",
    ...(profile.model ? ["--model", profile.model] : []),
    ...(passEffort ? ["--variant", profile.effort as string] : []),
    ...opencodeAdapter.extraArgs, // "--format json" — raw JSONL events for token/cost capture (usage:null on shape drift). opencode STREAMS these, so echo stays live (no resultText) — the operator sees the fire, LOOP-14's regression suppressed it.
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
let perFireCeilingUsd: number | null = null;                         // team mode: the resolved per-fire $ ceiling (LOOP-230); null ⇒ watchdog inert (legacy path, mirrors fireLedgerPath)
// LOOP-155: latched by the scheduler's SIGINT/SIGTERM forwarding path. Module scope, not a parameter,
// because the classifier runs inside runAgent while the signal arrives in the scheduler loop — and it
// is one-way on purpose: once the operator has asked to stop, every fire still in flight is being
// discarded, so none of them is evidence about the agent's health.
let schedulerInterrupted = false;
// Internal (not exported): main() is unconditional, so nothing may import this module without running the
// scheduler. recordFire's ledger + event writes are covered by real-fire subprocess harnesses instead —
// the fires.jsonl row in test/team-scheduler.ts and the fire.completed event in test/run-agents-live.ts.

// §16 perms posture for the fire ledger AND the operator debug logs (run.log / runner-logs — LOOP-93), the
// secrets.ts warnLoosePerms sibling: all three sit in the same .dev-loop data home as secrets.env and capture
// credential-adjacent fire output, so keep them owner-only. chmod ONLY a file/dir WE just created; a
// PRE-EXISTING loose one is warned once — never chmod'd behind the operator's back, never a failure, never on win32.
const ledgerPermsWarned = new Set<string>();
function hardenLedgerPerms(p: string, existedBefore: boolean, mode: number, chmodHint: string): void {
  if (platform() === "win32") return;                                   // never touch perms on win32
  if (!existedBefore) { try { chmodSync(p, mode); } catch { /* best-effort */ } return; } // we created it → owner-only
  if (ledgerPermsWarned.has(p)) return;                                 // pre-existing loose → warn once, never chmod
  try {
    const cur = statSync(p).mode;
    if (cur & 0o077) {
      ledgerPermsWarned.add(p);
      console.error(`[dev-loop] ${p} is readable by group/others (mode ${(cur & 0o777).toString(8)}) — it can hold credential-adjacent fire output; tighten it: chmod ${chmodHint} ${p}`);
    }
  } catch { /* raced away between the write and the stat — nothing to warn about */ }
}
function recordFire(hubDb: string, project: string, agent: Agent, profile: LaunchProfile, durationMs: number, exitCode: number, timedOut: boolean, fireId: string,
  extra?: { suspectError?: boolean; interrupted?: boolean; outputTail?: string; errorClass?: string; bootBytes?: number; usage?: FireUsage }): void {
  const provider = providerOf(profile); // the metrics cost dimension (model-provider-routing)
  breaker.record(agent, exitCode, extra?.errorClass, extra?.outputTail, provider); // P0-1a/P0-1b — every completed fire feeds the streak
  // Backend-agnostic ledger (team mode): the GA soak success-rate metric needs a data source even on
  // linear, where there is no hub `fire.completed` event. Best-effort append; never crashes a fire.
  if (fireLedgerPath) {
    try {
      const dir = dirname(fireLedgerPath);
      const dirExisted = existsSync(dir);
      mkdirSync(dir, { recursive: true });
      // §16 (LOOP-62): ENUMERATE the safe telemetry fields — mirror the logEvent sibling below — instead of
      // spreading `extra` whole. The raw `outputTail` is a credential-adjacent CLI stream with ZERO ledger
      // consumers (metrics/doctor never read it); the breaker + the suspectError/errorClass buckets already
      // consumed it in-memory, so it must NEVER reach disk.
      const row = { ts: new Date().toISOString(), agent, project, codingAgent: profile.codingAgent, provider,
        model: profile.model ?? null, effort: profile.effort ?? null, durationMs, exitCode, timedOut, fireId,
        ...(extra?.suspectError ? { suspectError: true } : {}),
        ...(extra?.interrupted ? { interrupted: true } : {}),
        ...(extra?.errorClass ? { errorClass: extra.errorClass } : {}),
        ...(extra?.bootBytes ? { bootBytes: extra.bootBytes } : {}),
        // usage is numeric-only (FireUsage: tokens + cost + source/currency) — §16-safe for disk, and it's the
        // backend-agnostic soak/cost metric's ONLY source on linear (no fire.completed event there). Mirrors the
        // logEvent sibling below; the codex wiring stamped the event but missed this row (LOOP-83).
        ...(extra?.usage ? { usage: extra.usage } : {}) };
      const fileExisted = existsSync(fireLedgerPath);
      appendFileSync(fireLedgerPath, JSON.stringify(row) + "\n");
      hardenLedgerPerms(dir, dirExisted, 0o700, "700");                 // .dev-loop/team/ → owner-only
      hardenLedgerPerms(fireLedgerPath, fileExisted, 0o600, "600");     // fires.jsonl → owner-only
    } catch { /* ledger is best-effort */ }
  }
  try {
    if (fireDb === undefined) { try { fireDb = openDb(hubDb); } catch { fireDb = null; } }
    if (!fireDb) return;
    const projectId = findProject(fireDb, project);
    if (!projectId) return;                                          // not a hub-seeded project ⇒ no ledger to write
    logEvent(fireDb, { project_id: projectId, actor: agent, kind: "fire.completed",
      data: { codingAgent: profile.codingAgent, provider, model: profile.model ?? null, effort: profile.effort ?? null, durationMs, exitCode, timedOut, fireId, ...(extra?.suspectError ? { suspectError: true } : {}), ...(extra?.interrupted ? { interrupted: true } : {}), ...(extra?.errorClass ? { errorClass: extra.errorClass } : {}), ...(extra?.bootBytes ? { bootBytes: extra.bootBytes } : {}), ...(extra?.usage ? { usage: extra.usage } : {}) } });
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
// Stewardship agents (M4): in team mode these fire at TEAM scope (cwd = workspace root, project = _team/"",
// DEVLOOP_TEAM_SCOPE=1) and iterate/route across the enabled projects, rather than rotating one project.
// Derived from seed.ts's STEWARD_HANDLES (the A2 pattern) — the same set the D1 project-override matrix
// (agentops.resolveProjectOverride) grants cross-project access to, so scheduler and hub cannot drift.
const STEWARD_AGENTS = new Set<Agent>(STEWARD_HANDLES);
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
// R1a — gate state per gated slot ("<agent>" fixed-project / "<agent>:<project>" team): the change-key the
// slot last fired on plus WHEN it fired. pm/qa are REVIEW tiers (PM lens-rotation, QA coverage-expansion)
// whose best work happens precisely when nothing changed — for them an unchanged key only DEFERS the fire:
// once opts.changeGateTtlMs elapses since the last fire, the gate lets one through anyway (which re-arms
// it). The dev tier + architect keep the PURE gate — an unchanged key means byte-identical inputs and a
// guaranteed no-op. Pre-TTL state files stored a bare key string — read it as firedAt:0 (TTL long expired
// ⇒ the next review fire runs; fails open, same as every other gate edge).
const REVIEW_GATED_AGENTS = new Set<Agent>(["pm", "qa"]);
type GateEntry = { key: string; firedAt: number };
type GateState = Record<string, GateEntry | string>;
function gateEntry(state: GateState, slot: string): GateEntry | null {
  const v = state[slot];
  if (v === undefined) return null;
  return typeof v === "string" ? { key: v, firedAt: 0 } : v;
}
// Decide whether the gate SKIPS this fire. null key (no hub row / git error) never skips (fails open).
function gateSkips(opts: Options, state: GateState, slot: string, agent: Agent, key: string | null): boolean {
  if (key === null) return false;
  const e = gateEntry(state, slot);
  if (!e || e.key !== key) return false;                 // the code or the board moved ⇒ fire
  if (REVIEW_GATED_AGENTS.has(agent) && opts.changeGateTtlMs > 0 && Date.now() - e.firedAt >= opts.changeGateTtlMs)
    return false;                                        // quiet-board TTL elapsed ⇒ the review fire runs anyway
  return true;
}
function gateRecord(state: GateState, slot: string, key: string): void { state[slot] = { key, firedAt: Date.now() }; }
// R1b (LOOP-144) — the dev-tier queue-depth gate, a sibling of the R1 change-gate. The change-gate above fires
// whenever ANY agent moved the board cursor or a repo HEAD; on a busy board that lets a dev tier through even
// when its OWN queue is empty, so it boots the full (opus/max) corpus in runAgent() only to no-op. Consult the
// SAME servable predicate the `queue` op serves (agentops.servableSlice — imported, never a second copy): skip
// the launch when a dev tier has NO servable Todo, NO own In Progress, AND NO In Review to land. The In-Progress
// term is load-bearing — an own In Progress row is the Step-0 orphan-resume input and MUST still fire; gating on
// empty-Todo alone would turn this optimisation into a starvation bug. The In-Review term is load-bearing after
// LOOP-244: null-assignee InReview tickets now appear in the slice via tier-label matching, so a fire with only
// InReview work (Step 0.5 — land a green PR) must not be gated out. Dev tiers ONLY — pm/qa/architect/stewards
// do their best work on a quiet board and have no Todo slice, so they are never gated here (isDevTierActor
// short-circuits). FAILS OPEN exactly like changeKey: any read miss (no hub cursor on linear/local, unseeded/
// absent project, db busy) ⇒ null ⇒ fire anyway; never let a broken read starve the loop. Returns the skip
// REASON (for a distinct, non-silent log line — a silent skip is indistinguishable from a crash) when the fire
// should skip, else null.
function devTierQueueSkip(opts: Options, agent: Agent, project: string): string | null {
  if (!isDevTierActor(agent)) return null;                    // pm/qa/architect/stewards — never queue-gated
  try {
    if (fireDb === undefined) { try { fireDb = openDb(opts.hubDb); } catch { fireDb = null; } }
    if (!fireDb) return null;                                 // no hub cursor (linear/local) ⇒ fail open (fire)
    const projectId = findProject(fireDb, project);
    if (!projectId) return null;                              // unseeded / unknown project ⇒ fail open (fire)
    const { todo, inProgress, inReview } = servableSlice(fireDb, projectId, agent);
    return todo.length === 0 && inProgress.length === 0 && inReview.length === 0
      ? "queue empty (0 servable Todo, 0 In Progress, 0 In Review)"  // distinct from the change-gate's silent skip
      : null;
  } catch { return null; }                                    // any read error ⇒ fail open (fire)
}

// ─── budget-ceiling launch gate (LOOP-229 / design budget-ceiling, Child 3 of LOOP-197) ──────────────────
const DAY_MS = 86_400_000; // rolling window for the dailyUsd ceiling (the 24h cost window metrics/doctor use)
// Default per-fire ceiling (LOOP-230, budget-ceiling Child 4 — SHIPS ON). Provenance (AC4), from the observed
// distribution: the worst runaway was $18.21 over ~60 min (a claude wall-hit), detectable at ~$10 mid-flight;
// a NORMAL fire costs pm $6.43 / senior $7.46. $12.00 sits above the priciest normal fire ($7.46 → 1.61×,
// +61% headroom, so a normal fire is never clipped) yet well below the runaway ($18.21), catching that class
// at ~66% of its runtime (~40 min of a 60-min runaway ⇒ ~$6 / ~20 min saved). perFireUsd bounds ONE fire, so
// unlike dailyUsd it can never refuse EVERY launch (no deadlock risk); team.budget.perFireUsd overrides it.
// DEFAULT_PER_FIRE_USD / RATE_WINDOW_MS / perFireDeadline now live in metrics.ts beside ratePerMsFor —
// the surface that DISPLAYS the armed deadline must be the same function that ENFORCES it (LOOP-297).
// The ONE shared budget predicate both schedulers (legacy tick + team --once/tick) route through so they
// cannot drift — a sibling of devTierQueueSkip above. Returns the refusal REASON when today's rolling spend is
// over team.budget.dailyUsd, else null.
//   • INV-1 (AC5, anti-deadlock, LOAD-BEARING): a null/undefined dailyUsd returns null IMMEDIATELY — no ledger
//     read, no log, no side effect — so an unset workspace's launch path is byte-identical to today's build.
//   • Fails open on a missing ledger or ANY read error (product ruling #1: a ceiling that silently refuses
//     every launch is a worse outage than the spend it prevents — never let a broken read deadlock the loop).
//   • The total is Child 2's estimate-augmented rollingSpendUsd — a killed/unpriced fire is estimated, never
//     read as $0 (INV-5) — so this number matches what `dev-loop metrics` and `doctor` show the operator.
function budgetGateReason(dailyUsd: number | null | undefined, ledgerPath: string | null, nowMs: number): string | null {
  if (dailyUsd == null) return null;                          // INV-1 short-circuit: unset ⇒ today's path, byte-identical
  if (!ledgerPath) return null;                               // no ledger to read (legacy fixed-project path) ⇒ fail open
  try {
    const rolling = rollingSpendUsd(readFireRows(ledgerPath), DAY_MS, nowMs);
    return rolling > dailyUsd
      ? `budget dailyUsd $${dailyUsd.toFixed(2)} reached (rolling $${rolling.toFixed(2)}/$${dailyUsd.toFixed(2)})`
      : null;
  } catch { return null; }                                    // any read error ⇒ fail open (never deadlock the loop)
}
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

async function runAgent(opts: Options, cfg: ProjectsConfig | null, agent: Agent, project: string, cwd: string, teamScope?: TeamScope): Promise<number> {
  // For a team-scoped steward fire the launch profile resolves against a representative project (the first
  // enabled one) since `project` is "" / "_team"; delivery fires resolve against their own project.
  const profileProject = teamScope && teamScope.enabledProjects.length ? teamScope.enabledProjects[0] : project;
  const profile = resolveLaunchProfile(opts, cfg, profileProject, agent);
  const basePrompt = readPrompt(opts, agent, project, profile, teamScope);
  const backend = (cfg?.projects?.[profileProject] as { backend?: string } | undefined)?.backend ?? "linear";
  // boot-prefix: a deterministic §0a corpus appended to the prompt (claude lane only — the prompt then
  // rides stdin, see commandFor). Assembly failure fails OPEN: the fire boots in classic pull mode.
  const boot = opts.assembleBoot && profile.codingAgent === "claude"
    ? assembleBootCorpus(opts.root, opts.dataDir, agent, project, backend,
        cfg?.projects?.[profileProject] as Record<string, unknown> | undefined,
        cfg?.repos as Record<string, unknown> | undefined, // config-aware selection: feature-off spans never ship
        // LOOP-275: a team-scoped steward fire spans EVERY enabled project, so the repo-shaped
        // predicates must see all of them. Passing only the representative project pruned §19 from a
        // team fire whenever the first enabled project happened to be single-repo.
        teamScope ? teamScope.enabledProjects.slice(1).map((k) => cfg?.projects?.[k] as Record<string, unknown> | undefined).filter(Boolean) as Record<string, unknown>[] : undefined)
    : null;
  if (opts.assembleBoot && profile.codingAgent === "claude" && !boot)
    console.warn(`[${agent}] --assemble-boot: corpus assembly unavailable — firing in §0a pull mode`);
  const prompt = boot ? basePrompt + boot.text : basePrompt;
  // D8 agent interface (service only; meaningless elsewhere): "cli" fires get no hub MCP injection.
  const iface = agentInterfaceFor((cfg?.projects?.[profileProject] as { hub?: HubBlock } | undefined)?.hub, profile.codingAgent);
  const fireId = randomUUID();
  const { command, args, stdinPayload } = commandFor(opts, agent, project, prompt, profile, backend, iface, fireId, !!boot);
  // This env block IS the identity transport for interface="cli" fires (D8): the `dev-loop` write layer
  // resolves the actor from DEVLOOP_ACTOR, the project from DEVLOOP_PROJECT, the SoR from DEVLOOP_HUB_DB,
  // and treats DEVLOOP_DEV_SPLIT/DEVLOOP_TEAM_SCOPE as the fire markers behind its operator-write guard —
  // the same values both MCP injections carry. Removing any of these strands every "cli" fire (exit 4).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEVLOOP_ACTOR: agent,
    DEVLOOP_PROJECT: project,
    DEVLOOP_HUB_DB: opts.hubDb,
    DEVLOOP_DEV_SPLIT: runtimeDevSplit(opts) ? "true" : "false",
    DEVLOOP_FIRE_ID: fireId,
    DEVLOOP_DATA_DIR: opts.dataDir,
    DEVLOOP_PROJECTS_JSON: projectsPath(opts.dataDir),
    DEVLOOP_PLUGIN_ROOT: opts.root,
    CLAUDE_PLUGIN_ROOT: opts.root,
    CLAUDE_PLUGIN_DATA: opts.dataDir,
    ...(teamScope ? { DEVLOOP_TEAM_SCOPE: "1" } : {}),
  };
  // The scheduler sets reasoning effort PER AGENT via the resolved `--effort` flag (claude) / model_reasoning_effort
  // (codex). Claude's effort precedence is CLAUDE_CODE_EFFORT_LEVEL (env) > --effort > model default — so an
  // operator who exported CLAUDE_CODE_EFFORT_LEVEL (e.g. from an /effort or ultracode session) would silently
  // OVERRIDE every agent's configured effort, flattening them all to one level. Strip it so the per-agent
  // config is authoritative. (--model already outranks ANTHROPIC_MODEL, so the model needs no such strip.)
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  // Model-provider routing (opencode fires): resolve the registry entry once. The auth guard itself
  // runs AFTER the dry-run branch — a dry-run must render the command and note the gap, never write
  // the fire ledger. Built-in providers (no registry entry) are opencode's own auth concern.
  const providerEntry = profile.codingAgent === "opencode" ? opencodeProviderEntry(opts, profile.model) : undefined;
  const providerEnvMissing = providerEntry && process.env[providerEntry.authTokenEnv] === undefined ? providerEntry.authTokenEnv : null;
  // ── Per-fire secret scoping (one-click Q9 / §7 boundary 5) ────────────────────────────────────────
  // Every fire's build/test/detect grandchildren inherit the fire env, so a secrets.env hydrated into
  // THIS scheduler's process.env would hand every key to every script an agent runs. Scope it: strip
  // every key the WORKSPACE secrets file injected (secretsInjectedKeys — the §16 value set), then
  // re-add only what THIS fire's own runner needs in-process:
  //   • its registry provider's authTokenEnv (opencode resolves {env:VAR} in-process);
  //   • the ANTHROPIC_* ambient keys on a claude fire (its own auth lane).
  // Everything else re-sources from the FILE at use time — the `dev-loop` CLI grandchildren re-hydrate
  // secrets.env on workspace resolution (comms webhook for `notify`, mirror tokens), and git auth rides
  // the GIT_ASKPASS/deploy-key files (§4.1a) — so stripping loses no capability, only exposure. The
  // decrypt key (DEVLOOP_BUNDLE_KEY / AGE_IDENTITY_FILE) and the UI token never belong in a fire.
  {
    const injected = secretsInjectedKeys(opts.wsRoot ?? "");
    const keep = new Set<string>();
    if (providerEntry) keep.add(providerEntry.authTokenEnv);
    if (profile.codingAgent === "claude") { keep.add("ANTHROPIC_API_KEY"); keep.add("ANTHROPIC_AUTH_TOKEN"); }
    if (profile.codingAgent === "codex") keep.add("OPENAI_API_KEY"); // its own auth lane, same rule as claude's
    for (const k of injected) if (!keep.has(k)) delete env[k];
    delete env.DEVLOOP_BUNDLE_KEY;
    delete env.AGE_IDENTITY_FILE;
    delete env.DEVLOOP_UI_TOKEN;
    delete env.DEVLOOP_UI_TOKEN_FILE;
  }
  if (profile.codingAgent === "opencode") {
    // Certified permission injection (PORTABILITY §5): wildcard-deny is what closes operator-installed
    // custom exec tools (they escape narrow patterns AND can drop the identity env — the tmux finding).
    // Assigned AFTER the process.env spread so the fire policy beats any operator export.
    env.OPENCODE_PERMISSION = JSON.stringify(opts.opencodePermission ?? DEFAULT_OPENCODE_PERMISSION);
    // Workspace opencode.json (the sync-opencode render of team.providers) is otherwise INVISIBLE to a
    // fire: the fire's cwd is a repo, and opencode's config discovery stops at that repo's own git root —
    // it never walks up to the workspace file (field finding, 2026-07-22: every fire on a registry
    // provider died ProviderModelNotFoundError until the operator hand-merged the providers into the
    // GLOBAL config). Point the fire at the workspace file explicitly; opencode merges it with the
    // global config. An operator's own OPENCODE_CONFIG export still wins.
    if (opts.wsRoot && env.OPENCODE_CONFIG === undefined) {
      const wsOpencode = join(opts.wsRoot, "opencode.json");
      if (existsSync(wsOpencode)) env.OPENCODE_CONFIG = wsOpencode;
    }
  }
  // Resolve per-agent timeouts here so the dry-run log can report them (same values used below at fire time).
  // Project-scope timeout override applies to delivery fires only — steward fires use team-scope timeouts since
  // profileProject on a steward fire is the first enabled project, not the actual firing context (a per-project
  // timeout on a steward would silently favour one project's config).
  const projTO = !teamScope ? cfg?.projects?.[profileProject]?.agents?.[agent] : undefined;
  const parseTO = (s?: string): number | undefined => s === undefined ? undefined : (s.trim() === "0" ? 0 : parseDuration(s.trim()));
  const effectiveFireTimeoutMs = parseTO(projTO?.fireTimeout) ?? opts.perAgentFireTimeoutMs?.[agent] ?? opts.fireTimeoutMs;
  const stallConfigOverride    = parseTO(projTO?.stallTimeout) ?? opts.perAgentStallTimeoutMs?.[agent] ?? opts.stallTimeoutMs;
  const effectiveStallMs = stallConfigOverride !== undefined ? stallConfigOverride
    : (profile.codingAgent === "opencode" ? 10 * 60_000 : 0);
  const rendered = displayCommand(command, args, prompt) + (stdinPayload ? ` <stdin:${stdinPayload.length} chars>` : "");
  if (opts.dryRun) {
    if (boot) console.log(`[dry-run] ${agent}: boot corpus ${Math.round(boot.bytes / 1024)}KB (conventions ${Math.round(boot.conventionsBytes / 1024)}KB; lessons ${boot.lessonsBytes}B${boot.pruned.length ? `; config-pruned §${boot.pruned.join(" §")}` : ""}) hash=${boot.hash} — prompt via stdin`);
    const intakeMode = (cfg?.projects?.[project] as { intake?: { mode?: string } } | undefined)?.intake?.mode;
    const dryProvider = providerOf(profile);
    const fireStr = effectiveFireTimeoutMs > 0 ? formatDuration(effectiveFireTimeoutMs) : "off";
    const stallStr = effectiveStallMs > 0 ? formatDuration(effectiveStallMs) : "off";
    console.log(`[dry-run] ${agent}: cwd=${cwd} cli=${profile.codingAgent} model=${profile.model ?? "(cli default)"} effort=${profile.effort ?? "(cli default)"}${dryProvider ? ` provider=${dryProvider}` : ""}${backend === "service" ? ` interface=${iface}` : ""}${agent === "pm" && intakeMode === "passive" ? " intake=passive" : ""} fireTimeout=${fireStr} stallTimeout=${stallStr}`);
    console.log(`[dry-run] ${agent}: ${rendered}`);
    if (providerEnvMissing) console.log(`[dry-run] ${agent}: NOTE provider auth env ${providerEnvMissing} unresolvable — a real fire fails pre-spawn (doctor W13)`);
    return 0;
  }

  // Pre-spawn auth guard (model-provider-routing): a registry-provider fire whose auth env is
  // unresolvable would burn a whole turn on 401s — fail it BEFORE spawning, visibly in the fire
  // ledger (`fireError: "provider-env-missing"`), zero tokens.
  if (providerEnvMissing) {
    const prefix = profile.model?.split("/")[0];
    console.error(`[${agent}] provider '${prefix}' auth env ${providerEnvMissing} unresolvable — put ${providerEnvMissing}=<key> in <workspace>/.dev-loop/secrets.env or export it; failing this fire pre-spawn (doctor W13 surfaces this before the loop)`);
    recordFire(opts.hubDb, project, agent, profile, 0, 4, false, fireId, { errorClass: "provider-env-missing", outputTail: `provider '${prefix}' auth env ${providerEnvMissing} unresolvable` });
    return 4;
  }

  const logDir = opts.logDir || join(opts.dataDir, project, "runner-logs");
  const logDirExisted = existsSync(logDir);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${agent}.log`);
  // Unattended runs append forever — rotate at 50MB (single .1 generation) so a chatty agent can't fill the disk.
  try { if (statSync(logPath).size > 50 * 1024 * 1024) renameSync(logPath, `${logPath}.1`); } catch { /* no log yet */ }
  // §16 (LOOP-93): the runner logs hold the FULL stdout+stderr fire stream — a strictly larger credential-adjacent
  // surface than the fires.jsonl ledger LOOP-62 hardened, in the same .dev-loop data home. Same posture: owner-only
  // on create, a pre-existing loose one warned once (never chmod'd). Read `existed` AFTER the rotation rename so a
  // freshly-rotated log counts as new and is re-hardened (AC4 — rotation must not recreate at the default umask).
  // createWriteStream opens its fd asynchronously, so touch the file synchronously first — otherwise the chmodSync
  // in hardenLedgerPerms would race the open and silently no-op on ENOENT, leaving a new log world-readable.
  const logFileExisted = existsSync(logPath);
  try { closeSync(openSync(logPath, "a")); } catch { /* the stream open below surfaces any real error */ }
  hardenLedgerPerms(logDir, logDirExisted, 0o700, "700");   // runner-logs/ → owner-only
  hardenLedgerPerms(logPath, logFileExisted, 0o600, "600"); // <agent>.log  → owner-only
  const log = createWriteStream(logPath, { flags: "a" });
  // A stream 'error' with no listener is an uncaught exception that kills the WHOLE scheduler —
  // one ENOSPC/EACCES on a log file must degrade logging, not take down the loop.
  let logDead = false; // 'error' fired — degrade logging, and NEVER let a fire block on the log below
  log.on("error", (e) => { logDead = true; console.error(`[${agent}] runner-log write failed (${e.message}); continuing without file log`); });
  // Single-owner stream lifecycle: finalize() ends the log AFTER its last write and resolves the fire
  // only once the flush completes. Two field failures live here (report P2-4): the close handler used to
  // end the stream first, so finalize's footer/suspect writes died as "write after end" (×103); and
  // --once's process.exit() truncated the un-flushed tail even when the writes succeeded. logOpen gates
  // late pipe chunks on the 150ms grace path (finalize-before-close), where data may trickle after end.
  let logOpen = true;
  const endLog = (done?: () => void) => {
    if (!logOpen || logDead) { done?.(); return; }
    logOpen = false;
    let called = false;
    const fin = () => { if (!called) { called = true; done?.(); } };
    log.once("error", fin); // a flush-time error must not hang the fire
    log.end(fin);
  };
  log.write(`\n\n===== ${new Date().toISOString()} ${rendered} cwd=${cwd} =====\n`);
  console.log(`[${new Date().toISOString()}] ${agent}: start (${profile.codingAgent}); log ${logPath}`);

  const startedAt = Date.now();
  // detached: true puts the fire in its own process group (pgid = child.pid) so watchdog kills reach
  // every descendant — the scheduler itself is NOT in this group and is safe from the group signal.
  const child = spawn(command, args, { cwd, env, stdio: [stdinPayload ? "pipe" : "ignore", "pipe", "pipe"], detached: true }) as RunnerChild;
  // Send a signal to the entire process group (negative pid = every process with pgid = child.pid).
  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid) try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
  };
  activeChildren.add(child);
  if (stdinPayload && child.stdin) {
    child.stdin.on("error", () => { /* EPIPE on an instantly-dead child must not crash the scheduler */ });
    child.stdin.write(stdinPayload);
    child.stdin.end();
  }
  // Keep a rolling tail of the child's combined output. Some CLI failures exit 0 while printing an error
  // body (e.g. claude -p emitting just "Execution error") — the exit code alone masks them, poisoning the
  // fire ledger with fake successes the operator can't alert on. Bounded (2 KB) so memory is constant.
  let outTail = "";
  let outBytes = 0;
  let lastOutputAt = Date.now(); // liveness watchdog anchor — any stdout/stderr byte resets it
  let lastNewContentAt = Date.now(); // retry-loop watchdog: last time output introduced a genuinely new line
  const usageAdapter = resolveAdapter(profile.codingAgent); // codex JSONL / claude --output-format json / null
  const isStructuredLane = usageAdapter !== null;
  // A lane that can extract result text (claude — one terminal JSON blob, NOT a live stream) DEFERS its echo:
  // buffer silently, then print the parsed text in finalize(). Echoing the raw blob live would bury the
  // agent's output in escaped JSON and leave a truncated fire unreadable. codex's JSONL streams — echo live.
  const deferEcho = !!usageAdapter?.resultText;
  const MAX_FULL_STDOUT = 4 * 1024 * 1024; // 4 MiB cap — overflow degrades to usage:null, never OOM
  let fullStdout = "";
  // Bounded, ROLLING window of recently-seen lines (seen-lines.ts). It evicts the oldest line on
  // overflow instead of freezing on the first N — the LOOP-23 fix for a detector that went inert
  // after ~200 distinct lines (a saturated Set treated every later line, including a genuine retry
  // loop's repeating line, as new content, so `looping` below never tripped).
  const seenLines = makeSeenLineWindow();
  const keepTail = (d: Buffer | string) => {
    const s = d.toString();
    outBytes += s.length;
    lastOutputAt = Date.now();
    outTail = (outTail + s).slice(-2048);
    // Refresh lastNewContentAt only when a line is genuinely new. Truncate each line to 200 chars so
    // one huge line cannot dominate the window (and trivial suffix churn on a long repeated line
    // still counts as a repeat).
    for (const raw of s.split("\n")) {
      const l = raw.trim().slice(0, 200);
      if (l.length === 0) continue;
      if (seenLines.markNew(l)) lastNewContentAt = Date.now();
    }
  };
  child.stdout.on("data", (d) => {
    keepTail(d);
    if (!deferEcho) { process.stdout.write(`[${agent}] ${d}`); if (logOpen) log.write(d); } // deferred lanes echo in finalize()
    if (isStructuredLane && fullStdout.length < MAX_FULL_STDOUT) {
      const s = d.toString();
      fullStdout += s.slice(0, MAX_FULL_STDOUT - fullStdout.length);
    }
  });
  child.stderr.on("data", (d) => { keepTail(d); process.stderr.write(`[${agent}] ${d}`); if (logOpen) log.write(d); });

  return await new Promise((resolveExit) => {
    // Fire timeout: without it a wedged CLI child holds its slot's non-reentrancy flag forever —
    // the agent silently stops firing until the operator notices. SIGTERM first, SIGKILL after 10s
    // (same escalation shape as the daemon lifecycle's lcStop).
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    // Declared here (not at the budget watchdog below) so the two OTHER watchdogs can stand down once a budget
    // kill is in flight: AC4's "never confused with a wall-timeout" must hold by construction, not by timing —
    // the stall interval ticks every 15s and would otherwise re-classify a SIGTERM'd-but-silent child mid-grace.
    let budgetKilled = false;
    // effectiveFireTimeoutMs / effectiveStallMs resolved above (before the dry-run branch) — same values here.
    const fireTimer = effectiveFireTimeoutMs > 0 ? setTimeout(() => {
      if (budgetKilled) return; // the budget watchdog already killed this fire — do not stamp timedOut on its row
      timedOut = true;
      console.error(`[${agent}] fire exceeded ${formatDuration(effectiveFireTimeoutMs)} — SIGTERM (SIGKILL in 10s)`);
      log.write(`\n===== fire timeout after ${formatDuration(effectiveFireTimeoutMs)}: SIGTERM =====\n`);
      killGroup("SIGTERM");
      killTimer = setTimeout(() => { if (activeChildren.has(child)) killGroup("SIGKILL"); }, 10_000);
      killTimer.unref?.();
    }, effectiveFireTimeoutMs) : undefined;
    fireTimer?.unref?.();
    // Liveness watchdog (errorClass "stalled" / "retry-loop"): the fire-timeout alone let a hung provider
    // call burn the FULL hour per fire — the 2026-07 quota-429 incident wedged every opencode fire in a
    // silent retry loop, and the resulting `exit 0 (fire timeout)` shape never fed the breaker, so the
    // loop idled for hours at full cadence. Silence ≠ slowness: a live opencode fire streams tool lines
    // constantly. Reclaim a stuck fire in minutes and record a class the breaker can trip on.
    // Two shapes detected: (a) SILENCE — no output bytes at all; (b) RETRY-LOOP — bytes keep arriving
    // but every line is a verbatim repeat of content already seen (the 429 shape: "retrying in 2s…" ×∞).
    let stalled = false;
    let retryLoop = false;
    const stallMs = effectiveStallMs; // claude -p buffers until the end — silence is normal there
    const stallTimer = stallMs > 0 ? setInterval(() => {
      if (stalled || timedOut || budgetKilled) return; // a budget kill in its SIGTERM→SIGKILL grace is not a stall
      const silent = Date.now() - lastOutputAt >= stallMs;
      const looping = !silent && Date.now() - lastNewContentAt >= stallMs;
      if (!silent && !looping) return;
      stalled = true;
      retryLoop = looping;
      // Both ages, always. Which watchdog arm tripped is the first question a reader has, and
      // deriving it from the message alone is guesswork: "no new content" and "no output" are
      // different causes with different remedies, and the two arms share one timer.
      const ageOut = Date.now() - lastOutputAt, ageNew = Date.now() - lastNewContentAt;
      const ages = `[silent ${formatDuration(ageOut)} · no-new-content ${formatDuration(ageNew)} · window ${seenLines.size}/${RETRY_LOOP_LINE_WINDOW}]`;
      if (retryLoop) {
        console.error(`[${agent}] output arriving but no NEW content for ${formatDuration(stallMs)} ${ages} — fire looks STUCK in a retry loop; SIGTERM (SIGKILL in 10s)`);
        log.write(`\n===== retry-loop: output arriving but no new content for ${formatDuration(stallMs)}: SIGTERM =====\n`);
      } else {
        console.error(`[${agent}] no output for ${formatDuration(stallMs)} ${ages} — fire looks WEDGED (hung provider call / silent retry loop); SIGTERM (SIGKILL in 10s)`);
        log.write(`\n===== stalled: no output for ${formatDuration(stallMs)}: SIGTERM =====\n`);
      }
      killGroup("SIGTERM");
      killTimer = setTimeout(() => { if (activeChildren.has(child)) killGroup("SIGKILL"); }, 10_000);
      killTimer.unref?.();
    }, 15_000) : undefined;
    stallTimer?.unref?.();
    // Budget watchdog (LOOP-230, budget-ceiling Child 4): terminate a fire whose ESTIMATED spend crosses
    // team.budget.perFireUsd, DISTINCTLY from a wall-timeout. Cost is known only post-hoc, so the mid-flight
    // signal is elapsed wall-time: kill at perFireUsd / ratePerMs (this profile's $/ms median from the ledger —
    // Child 2's derivation; the conservative FALLBACK when unpriced). Inert on the legacy path (perFireCeilingUsd
    // null — only teamMain sets it, mirroring fireLedgerPath). A budget kill ledgers as errorClass
    // "budget-per-fire" with a distinct console reason + exit 126 (finalize below), never confused with a timeout.
    // (`budgetKilled` is declared with `timedOut` above — the other two watchdogs read it.)
    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = perFireDeadline(perFireCeilingUsd, fireLedgerPath ? readFireRows(fireLedgerPath) : null, profile.codingAgent, profile.model, startedAt); // null ⇒ arm nothing
    if (budget) {
      const { deadlineMs: budgetMs, ratePerMs } = budget;
      const ceiling = perFireCeilingUsd as number;
      const ceilingLabel = ceiling >= 0.01 ? ceiling.toFixed(2) : String(ceiling); // a sub-cent ceiling must not print as "$0.00"
      const estRatePerHr = ratePerMs * 3_600_000;             // the measured rate itself — a clamped deadline must not distort it
      budgetTimer = setTimeout(() => {
        if (timedOut || stalled) return; // a wall/stall kill is already in flight — don't double-fire
        budgetKilled = true;
        console.error(`[${agent}] fire estimated over budget perFireUsd $${ceilingLabel} (~$${estRatePerHr.toFixed(2)}/hr × ${formatDuration(budgetMs)}) — SIGTERM (SIGKILL in 10s)`);
        log.write(`\n===== budget perFireUsd $${ceilingLabel} reached (est ~$${estRatePerHr.toFixed(2)}/hr): SIGTERM =====\n`);
        killGroup("SIGTERM");
        killTimer = setTimeout(() => { if (activeChildren.has(child)) killGroup("SIGKILL"); }, 10_000);
        killTimer.unref?.();
      }, budgetMs);
      budgetTimer.unref?.();
    }
    child.on("error", (e) => {
      if (logOpen && !logDead) log.write(`\nERROR: ${e.message}\n`);
      console.error(`[${agent}] failed to start: ${e.message}`);
      clearTimeout(fireTimer);
      clearInterval(stallTimer);
      clearTimeout(budgetTimer);
      // A spawn failure (missing/broken CLI bin) never reached the ledger — invisible to metrics AND to
      // the P0-1a breaker, whose canonical trigger (a wedged bin fast-failing identically forever) it is.
      recordFire(opts.hubDb, project, agent, profile, Date.now() - startedAt, 1, false, fireId, { errorClass: "spawn-failed", outputTail: e.message.slice(-400) });
      endLog(() => resolveExit(1));
    });
    // Resolve on 'exit', not 'close': 'close' additionally waits for the stdio pipes, which a grandchild
    // the CLI spawned can hold open long after the CLI itself died — exactly the wedged case the fire
    // timeout exists for. The log stream stays open until 'close' so late pipe output is still captured.
    // Finalize (suspect detection + ledger + resolve) runs AFTER the stdio pipes settle: on 'close', or a
    // short grace timer after 'exit' — whichever first. Computing on bare 'exit' raced the last pipe chunk
    // (a failure marker still in flight → false negative; real output in flight → false "no output"). The
    // timer caps the wedged-grandchild case ('close' may be held open long after the CLI died), preserving
    // the resolve-on-exit intent within a bounded 150ms.
    let finalized = false;
    let closed = false;
    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finalized) return;
      finalized = true;
      // Operator-visible output on a deferred-echo lane (claude): the raw JSON blob was NOT streamed live, so
      // emit the agent's result text now — BEFORE the exit marker so it reads as this fire's output, not the
      // next one's. Parsed text when the buffer is whole; else the raw buffer as a fallback so a truncated/
      // killed fire still leaves SOMETHING readable in the console + run.log, never nothing. §16: result text
      // (the agent's own prose) only — the numeric usage rides the ledger row, never this echo.
      if (deferEcho) {
        const shown = usageAdapter?.resultText?.(fullStdout) ?? fullStdout;
        if (shown.trim() !== "") { process.stdout.write(`[${agent}] ${shown}\n`); if (logOpen) log.write(shown + "\n"); }
      }
      const stalledLabel = stalled ? (retryLoop ? " (retry-loop)" : " (stalled)") : "";
      const budgetLabel = budgetKilled ? " (budget perFireUsd)" : ""; // LOOP-230: DISTINCT from " (fire timeout)" so a budget kill is never read as a wall-timeout
      log.write(`\n===== exit code=${code ?? "null"} signal=${signal ?? "null"}${timedOut ? " (fire timeout)" : ""}${budgetLabel}${stalledLabel} =====\n`);
      console.log(`[${new Date().toISOString()}] ${agent}: exit ${code ?? `signal ${signal}`}${timedOut ? " (fire timeout)" : ""}${budgetLabel}${stalledLabel}`);
      const exitCode = budgetKilled ? 126 : timedOut ? 124 : stalled ? 125 : (code ?? 1); // 126 = budget-per-fire kill, distinct from 124 (timeout) / 125 (stalled)
      // Suspect-error detection (narrow, tail-anchored to avoid false positives on error text an agent
      // merely echoed mid-run): exit 0 but the LAST line is a known CLI failure marker, or no visible
      // output at all (whitespace-only counts as none). Bare "Error:" is deliberately NOT matched — an
      // agent's own prose can legitimately end that way. Telemetry only; the exit code stays untouched.
      const lastLine = outTail.trimEnd().split("\n").pop()?.trim() ?? "";
      // LOOP-155 — an operator-initiated stop is not an agent failure. `dev-loop run`'s SIGINT
      // forwarding leaves the agent exiting 0 with a trailing "Execution error", which is
      // BYTE-IDENTICAL to the genuine exit-0-looks-like-a-failure case the heuristic exists for.
      // The discriminator is not in the output at all — it is that WE sent the signal. Classify on
      // that, so the heuristic keeps catching real cases and stops charging the operator's own
      // restarts to the agents (10 of 10 suspectErrors on the board that found this were kills).
      const interrupted = schedulerInterrupted && exitCode === 0 && !timedOut;
      let suspectError = !interrupted && exitCode === 0 && !timedOut && (outTail.trim() === "" || /^(Execution error|API Error)/.test(lastLine));
      // Structured lanes ADD the adapter's isError signal ON TOP of the tail-regex — never a replacement.
      // The text/empty arm above still catches a crash/kill/timeout that leaves an UNPARSEABLE buffer (claude
      // printing "Execution error" and exiting 0, or emitting nothing at all); the JSON signal additionally
      // catches an exit-0 fire whose terminal object reports is_error / subtype!=="success". Replacing the
      // text arm (LOOP-83) let a fake-success on the one lane the loop runs, and a silent fire, record healthy.
      if (!suspectError && !interrupted && isStructuredLane && exitCode === 0 && !timedOut) {
        try { if (usageAdapter?.isError?.(fullStdout)) suspectError = true; } catch { /* isError is best-effort */ }
      }
      if (suspectError) {
        const why = outTail.trim() === "" ? `no visible output (${outBytes} bytes)` : `last line: ${JSON.stringify(lastLine.slice(0, 120))}`;
        console.error(`[${agent}] exit 0 but the output looks like a FAILURE (${why}) — flagged suspectError in the fire ledger`);
        log.write(`\n===== suspectError: exit 0 but output looks like a failure (${why}) =====\n`);
      }
      let usage: FireUsage | undefined;
      if (usageAdapter) {
        try { const parsed = usageAdapter.parse(fullStdout); if (parsed) usage = parsed; } catch { /* usage is best-effort */ }
      }
      const errorClass = classifyFireError(exitCode, timedOut, outTail, stalled, retryLoop, budgetKilled); // P0-1b taxonomy (+ liveness "stalled"/"retry-loop" + LOOP-230 "budget-per-fire")
      if (interrupted) log.write(`\n===== interrupted: operator stop (SIGINT forwarded) — not charged to the agent =====\n`);
      const fireExtras = {
        ...(suspectError ? { suspectError: true } : {}),
        ...(interrupted ? { interrupted: true } : {}),   // LOOP-155: excluded from successRate entirely
        ...(errorClass ? { errorClass } : {}),
        // every failure carries its tail — the breaker keys on it
        ...(suspectError || errorClass || exitCode !== 0 ? { outputTail: outTail.slice(-400) } : {}),
        ...(boot ? { bootBytes: boot.bytes } : {}), // boot-prefix: the assembled-corpus size rides every ledger row
        ...(usage ? { usage } : {}),
      };
      recordFire(opts.hubDb, project, agent, profile, Date.now() - startedAt, exitCode, timedOut, fireId,
        Object.keys(fireExtras).length ? fireExtras : undefined);
      if (timedOut || stalled || budgetKilled) releaseClaimedTickets(fireDb, project, agent, fireId, budgetKilled ? "budget" : timedOut ? "timeout" : "stall"); // a budget kill must free its claim too (reclaimable next fire)
      endLog(() => resolveExit(exitCode)); // resolve after the flush — --once process.exit must not truncate the tail
    };
    child.on("exit", (code, signal) => {
      clearTimeout(fireTimer);
      clearInterval(stallTimer);
      clearTimeout(killTimer);
      clearTimeout(budgetTimer);
      activeChildren.delete(child);
      if (closed) { finalize(code, signal); return; }        // pipes already drained → finalize now
      const grace = setTimeout(() => finalize(code, signal), 150);
      grace.unref?.();
      child.once("close", () => { clearTimeout(grace); finalize(code, signal); });
    });
    child.on("close", () => { closed = true; }); // stream end belongs to finalize (single owner)
  });
}

type Slot = { agent: Agent; nextAt: number; running: boolean };
type RunnerChild = ChildProcessByStdio<Writable | null, Readable, Readable>; // stdio: [pipe|ignore,"pipe","pipe"] — stdin is a pipe only on boot-prefix fires
const activeChildren = new Set<RunnerChild>();

// Config-driven cadence (the `agents.<agent>.cadence` field): CLI --interval > config cadence >
// built-in DEFAULT_INTERVALS. Previously `cadence` was seeded by `team init` and documented but NEVER
// read — a dead knob whose silent default (10m ops) contradicted the seeded value. A malformed cadence
// warns and keeps the default (a config typo must not kill the loop).
// LOOP-90 — `configured` is the FULL set of agents carrying a cadence in config, not just the ones
// in the run set. The loop below iterates only the SELECTED agents, so a cadence configured for any
// other agent was dropped with no log line and no warning — and `team init` seeds FOUR cadences into
// every new workspace while the default run set (`core`) contains exactly one of them. The config was
// well-formed, correctly spelled, semantically meaningful, and written by the product's own `init`.
//
// The output asymmetry IS the bug's whole surface: an applied cadence is confirmed on stdout, a
// malformed one is warned about, and a DROPPED one said nothing at all — the one case where the
// operator's intent was discarded silently.
function applyConfigCadence(opts: Options, cadenceFor: (agent: Agent) => string | undefined, configured: readonly string[] = []): void {
  for (const agent of opts.agents) {
    if (opts.intervalsExplicit.has(agent)) continue;              // --interval wins
    const cad = cadenceFor(agent);
    if (!cad) continue;
    // CADENCE_DUR_RE, not a hand-copied literal: the schema validator (E17, LOOP-336) refuses exactly
    // what this ignores, so the two cannot disagree about which spellings are legal.
    if (!CADENCE_DUR_RE.test(cad.trim())) { console.warn(`dev-loop run: ignoring malformed cadence '${cad}' for ${agent} (use e.g. "10m", "1h")`); continue; }
    opts.intervals[agent] = parseDuration(cad.trim());
    console.log(`dev-loop run: cadence ${agent}=${formatDuration(opts.intervals[agent])} (from config)`);
  }
  // The third case, previously silent. Named once, with the remedy, so the operator can tell a
  // cadence that is RUNNING from one that merely exists in the file.
  const selected = new Set<string>(opts.agents);
  const dropped = configured.filter((a) => !selected.has(a));
  if (dropped.length)
    console.warn(`dev-loop run: ${dropped.length} configured cadence(s) NOT APPLIED — ${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} outside this run's agent set (${opts.agents.join(",")}), so ${dropped.length === 1 ? "it" : "they"} will never fire. Add ${dropped.length === 1 ? "it" : "them"} with --agents, or remove the cadence from config.`);
}

// The agents carrying a cadence in a config block — the input LOOP-90's dropped-cadence warning needs.
function agentsWithCadence(agents: Record<string, { cadence?: string }> | undefined): string[] {
  return Object.entries(agents ?? {}).filter(([, c]) => typeof c?.cadence === "string" && c.cadence.trim() !== "").map(([a]) => a);
}

// Config-driven per-agent fire/stall timeouts: per-agent config > explicit CLI flag > per-lane default.
// Schema validation in team-config.ts (E17) guarantees values are well-formed; parseDuration is safe here.
function applyConfigTimeouts(opts: Options, timeoutFor: (agent: Agent) => { fireTimeout?: string; stallTimeout?: string } | undefined): void {
  if (!opts.perAgentFireTimeoutMs) opts.perAgentFireTimeoutMs = {};
  if (!opts.perAgentStallTimeoutMs) opts.perAgentStallTimeoutMs = {};
  for (const agent of opts.agents) {
    const t = timeoutFor(agent);
    if (t?.fireTimeout !== undefined) {
      const v = t.fireTimeout.trim();
      opts.perAgentFireTimeoutMs[agent] = v === "0" ? 0 : parseDuration(v);
      console.log(`dev-loop run: fireTimeout ${agent}=${v === "0" ? "off" : formatDuration(opts.perAgentFireTimeoutMs[agent]!)} (from config)`);
    }
    if (t?.stallTimeout !== undefined) {
      const v = t.stallTimeout.trim();
      opts.perAgentStallTimeoutMs[agent] = v === "0" ? 0 : parseDuration(v);
      console.log(`dev-loop run: stallTimeout ${agent}=${v === "0" ? "off" : formatDuration(opts.perAgentStallTimeoutMs[agent]!)} (from config)`);
    }
  }
}

// Scheduler-internal comms: STRICTLY gated on team.comms existing. notify() itself die(3)s on a
// comms-less workspace (correct for the CLI verb — the operator asked and must hear "not configured"),
// but `die` is process.exit — a promise .catch() cannot contain it, so an ungated call from inside the
// scheduler KILLS the whole loop the first time it tries to alert (field regression caught by
// test/stop.ts B5: the config-guard alert on a comms-less workspace took the scheduler down with exit 3).
function schedulerNotify(ws: Workspace | null, level: "info" | "warn" | "error", text: string): void {
  if (!ws?.file.team.comms) return; // console output already happened at the call site; nothing to send
  void notify(ws, { title: "dev-loop scheduler", level, text }).catch(() => { /* best-effort */ });
}

// P0-1a: trip/recovery each surface ONCE — always on the console, and to the team comms channel when a
// workspace with team.comms exists (comms-less: console only — see schedulerNotify's die(3) note).
function wireBreakerEvents(ws: Workspace | null): void {
  breaker.onEvent = (agent, ev, key, streak) => {
    const msg = formatBreakerMsg(agent, ev, key, streak, formatDuration(breaker.probeMs), breaker._agentProvider);
    console.error(`[breaker] ${msg}`);
    schedulerNotify(ws, ev === "open" ? "error" : "info", msg);
  };
}

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
  // --background (operator-console flow): re-spawn THIS entry detached with the same args and return the
  // shell. The child owns the run lock as usual (a second scheduler is still refused), output appends to
  // the workspace run log, and `dev-loop stop` is the matching off switch. Deliberately BEFORE workspace
  // resolution: the child re-resolves everything itself; the parent only needs the log path.
  if (opts.background && !opts.dryRun && !opts.once) {
    const bgWs = tryResolveWorkspace(opts.cwd ?? process.cwd());
    const logPath = bgWs ? join(bgWs.root, ".dev-loop", "run.log") : join(opts.dataDir, "run.log");
    mkdirSync(dirname(logPath), { recursive: true });
    // §16 (LOOP-93): run.log holds the FULL unredacted detached fire stream (every agent's stdout+stderr) in the
    // .dev-loop data home alongside secrets.env — owner-only on create, a pre-existing loose one warned once. openSync
    // is synchronous, so hardenLedgerPerms' chmod acts on a file that already exists (no createWriteStream race here).
    const runLogExisted = existsSync(logPath);
    const fd = openSync(logPath, "a");
    hardenLedgerPerms(logPath, runLogExisted, 0o600, "600");
    const args = process.argv.slice(2).filter((a) => a !== "--background");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
    child.unref();
    closeSync(fd);
    console.log(`dev-loop run: scheduler started in background (pid ${child.pid}); log → ${logPath}`);
    console.log(`dev-loop run: stop it with \`dev-loop stop\`${bgWs ? "" : " (or kill the pid)"}; \`dev-loop tickets\` / the hub UI show the board`);
    return;
  }
  if (opts.background) console.warn("dev-loop run: --background ignored with --dry-run/--once (both are foreground by nature)");
  // Team mode: a discoverable workspace runs ONE team-level scheduler that rotates delivery/steward fires
  // across the enabled projects (weighted round-robin). No workspace → the legacy fixed-project path below.
  const ws = resolveWs(opts);
  if (ws) return teamMain(opts, ws);
  wireBreakerEvents(null); // legacy fixed-project path: console-only breaker notices

  const cfg = readProjects(opts);
  const project = resolveProject(opts, cfg);
  const projAgents = (cfg?.projects?.[project] as { agents?: Record<string, { cadence?: string }> } | undefined)?.agents;
  applyConfigCadence(opts, (agent) => projAgents?.[agent]?.cadence, agentsWithCadence(projAgents));
  applyConfigTimeouts(opts, (agent) => (cfg?.projects?.[project] as { agents?: Record<string, AgentLaunchConfig> } | undefined)?.agents?.[agent]);
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
  if (gateActive) console.log(`dev-loop run: change-gate ON for ${[...GATED_AGENTS].filter((g) => opts.agents.includes(g)).join(", ") || "(no gated agents selected)"} (pm/qa quiet-board TTL ${opts.changeGateTtlMs > 0 ? formatDuration(opts.changeGateTtlMs) : "off — pure gate"})`);
  console.log(`dev-loop run: cli=${opts.cli} project=${project} cwd=${cwd}`);
  console.log(`dev-loop run: root=${opts.root} data=${opts.dataDir} hubDb=${opts.hubDb}`);
  const cfgDevSplit = cfg?.projects?.[project]?.devSplit === true;
  const runtimeSplit = runtimeDevSplit(opts);
  if (runtimeSplit || cfgDevSplit) console.log(`dev-loop run: devSplit=${runtimeSplit ? "runtime" : "config"}${cfgDevSplit ? " (config:true)" : ""}`);
  console.log(`dev-loop run: agents=${opts.agents.map((a) => `${a}@${formatDuration(opts.intervals[a])}`).join(", ")}`);
  console.log(`dev-loop run: launch=${opts.agents.map((a) => {
    const p = resolveLaunchProfile(opts, cfg, project, a);
    breaker.seedProvider(a, providerOf(p)); // LOOP-72: close the cold-start window before any fire runs
    return `${a}:${p.codingAgent}:${p.model ?? "cli-default"}/${p.effort ?? "cli-default"}`;
  }).join(", ")}`);

  if (opts.once) {
    const results = await Promise.all(opts.agents.map((a) => runAgent(opts, cfg, a, project, cwd)));
    await flushStdio();
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
  // LOOP-23 decision — the scheduler interrupt path is deliberately NOT routed through the fire's
  // process-group kill. A forwarded SIGINT is the GRACEFUL stop (LOOP-10): it lets the agent CLI
  // catch it and wind down its OWN subtree cleanly (finish/checkpoint the fire). Signalling the whole
  // group (`-child.pid`) would deliver SIGINT to every grandchild at once — the git/tsx/npm helpers
  // the agent spawns to checkpoint — turning a graceful drain into a forced reap and defeating the
  // checkpoint intent LOOP-10 made an explicit non-goal for auto-release. Forced group reaping stays
  // confined to the fire-timeout / stall watchdog (killGroup, per fire), which fire precisely when the
  // agent is presumed wedged and its cleanup is moot. (A zombie descendant that outlives a graceful
  // stop is LOOP-19's concern — runner-side ticket release — not a reason to make this signal forceful.)
  const interrupt = () => {
    const first = !stopping;
    schedulerInterrupted = true; // LOOP-155: from here on, an exit-0 fire is OUR kill, not its failure
    drain();
    if (first) console.log("dev-loop run: stopping; forwarding SIGINT to active agent processes");
    for (const child of activeChildren) child.kill("SIGINT"); // direct child only — see the LOOP-23 decision above
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  const tick = () => {
    const now = Date.now();
    // Budget-ceiling launch gate (LOOP-229). The legacy fixed-project path has no workspace, no team.budget,
    // and no fire ledger (fireLedgerPath stays null — only teamMain assigns it), so this resolves INERT
    // (INV-1: undefined dailyUsd ⇒ null, no side effect). It is wired here so BOTH schedulers route through the
    // one budgetGateReason predicate and cannot drift; on the live team path it enforces (teamMain below).
    const budgetReason = budgetGateReason(undefined, fireLedgerPath, now);
    for (const slot of slots) {
      if (stopping || slot.running || slot.nextAt > now) continue;
      if (budgetReason !== null) {                               // over dailyUsd ⇒ refuse the launch, loudly (INV-3/AC3)
        console.log(`[${slot.agent}] launch refused: ${budgetReason}`);
        slot.nextAt = now + Math.max(opts.intervals[slot.agent], breaker.probeMs); // back off to probe cadence (INV-2)
        continue;
      }
      // R1: for a gated agent, if neither the code nor the board moved since its last fire, skip the spawn
      // entirely (the agent would just no-op) — except a pm/qa review fire past the quiet-board TTL (R1a).
      // fails open: a null key (no hub / git error) never skips.
      if (gateActive && GATED_AGENTS.has(slot.agent)) {
        const key = changeKey(opts, cfg, project);
        if (gateSkips(opts, gateState, slot.agent, slot.agent, key)) {
          slot.nextAt = now + breaker.intervalFor(slot.agent, opts.intervals[slot.agent]);
          continue; // no change since last fire ⇒ don't pay for a no-op turn
        }
        // R1b (LOOP-144): a dev tier whose servable slice is empty would boot only to no-op — skip the launch.
        // Mirrors the change-gate continue above: it does NOT gateRecord (the .finally below never runs), so the
        // change-key stays un-advanced and a genuine later change still fires the next rotation.
        const queueSkip = devTierQueueSkip(opts, slot.agent, project);
        if (queueSkip !== null) {
          console.log(`[${slot.agent}] skipped: ${queueSkip}`);
          slot.nextAt = now + breaker.intervalFor(slot.agent, opts.intervals[slot.agent]);
          continue;
        }
      }
      slot.running = true;
      fired++;
      runAgent(opts, cfg, slot.agent, project, cwd)
        .catch((e) => { console.error(`[${slot.agent}] ${e instanceof Error ? e.message : String(e)}`); return 1; })
        .finally(() => {
          slot.running = false;
          slot.nextAt = Date.now() + breaker.intervalFor(slot.agent, opts.intervals[slot.agent]); // P0-1a: open ⇒ probe cadence
          // Record the POST-fire change-key (+ the fire time, the R1a TTL anchor) so the next tick compares
          // against the state this fire left behind (an agent's own writes bump the key once, then it
          // settles → skips until the NEXT external change or, for pm/qa, the TTL).
          if (gateActive && GATED_AGENTS.has(slot.agent)) {
            const key = changeKey(opts, cfg, project);
            if (key !== null) { gateRecord(gateState, slot.agent, key); saveGateState(opts, project, gateState); }
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

// Opencode model preflight: `opencode models` prints every id launchable with the CURRENT auth+config —
// a configured model missing from that list fails EVERY fire (ModelNotFound / dead provider) at full
// spawn+slot cost until someone reads the logs. One cheap zero-token listing at startup catches the
// whole class (typo'd model string, un-synced workspace opencode.json, missing provider auth) before
// the first fire. Warn-only: `opencode models` availability differs by version, so a preflight failure
// must never block the loop (the fire itself still surfaces the real error).
function preflightOpencodeModels(opts: Options, cfg: ProjectsConfig | null, wsRoot: string, projects: string[]): void {
  // Persistent-scheduler guard only: a --once/--dry-run invocation is an interactive one-shot whose
  // fire surfaces any model/auth error immediately — spawning the opencode bin there would also break
  // the pre-spawn zero-token contract (provider-routing tests assert the bin is never touched).
  if (opts.once || opts.dryRun) return;
  const models = new Set<string>();
  for (const agent of opts.agents)
    for (const p of projects.length ? projects : [""]) {
      const prof = resolveLaunchProfile(opts, cfg, p, agent);
      if (prof.codingAgent === "opencode" && prof.model) models.add(prof.model);
    }
  if (!models.size) return;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const wsOpencode = join(wsRoot, "opencode.json");
    if (existsSync(wsOpencode) && env.OPENCODE_CONFIG === undefined) env.OPENCODE_CONFIG = wsOpencode; // same view a fire gets
    const out = execFileSync(opts.opencodeBin, ["models"], { encoding: "utf8", timeout: 30_000, env, stdio: ["ignore", "pipe", "pipe"] });
    const known = new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
    const missing = [...models].filter((m) => !known.has(m));
    if (missing.length)
      console.warn(`dev-loop run: WARNING opencode cannot resolve configured model(s): ${missing.join(", ")} — every fire on them will fail. Check the model string, provider auth, and \`dev-loop team sync-opencode\` (the workspace opencode.json rides OPENCODE_CONFIG into fires).`);
    else console.log(`dev-loop run: opencode model preflight ok (${models.size} model${models.size > 1 ? "s" : ""})`);
  } catch (e) { console.warn(`dev-loop run: opencode model preflight skipped (${(e as Error).message.split("\n")[0]})`); }
}

// ─── Team mode: one scheduler, weighted round-robin across the enabled projects ─────────────────────────
// Each agent has its own cadence slot (unchanged); when a slot fires, the target project is chosen by the
// shared smooth-WRR cursor (rotation.ts). `--project` degrades to a filter (rotate over just that one).
// In M3 EVERY agent still fires per-project (steward team-scoping is M4); rotation is the only new behavior.
async function teamMain(opts: Options, ws: Workspace): Promise<void> {
  // Q4 moved-source guard (one-click §4.3): a home that was bundle-exported --move must not keep
  // firing — two live homes double-drive the board. Marker + refusal is the whole mechanism (operator
  // decision); deleting .dev-loop/moved.json un-retires deliberately.
  try {
    const { movedMarker } = await import("./bundle.ts");
    const moved = movedMarker(ws.root);
    if (moved && !opts.dryRun)
      die(`this workspace was MOVED (bundle '${moved.bundle ?? "?"}' at ${moved.movedAt ?? "?"}) — the home now runs elsewhere; use \`dev-loop up --attach <url>\` here, or delete .dev-loop/moved.json to un-retire`, 1);
  } catch (e) { if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw e; }
  const cfg = toLegacyView(ws) as unknown as ProjectsConfig;
  (cfg as ProjectsConfig).repos = ws.file.repos as unknown as Record<string, unknown>;
  const backend = ws.file.team.backend;
  // Model-provider routing: the TEAM-level registry + permission override ride the run options into
  // commandFor/runAgent (never the legacy per-project view — providers are team infrastructure).
  opts.providers = ws.file.team.providers ?? {};
  opts.opencodePermission = ws.file.team.opencodePermission;
  opts.wsRoot = ws.root; // Q9: fire env strips this workspace's secrets.env-injected keys
  wireBreakerEvents(ws); // P0-1a notices ride team comms when configured

  // `--project` filter: restrict DELIVERY rotation to a single named project. It must exist + be enabled;
  // a weight:0 target is NOT an error — that just pauses delivery (the block below decides), and stewards
  // are never narrowed by the filter either way.
  if (opts.project) {
    const p = ws.file.projects[opts.project];
    if (!p) die(`--project '${opts.project}' is not a project in team '${ws.file.team.key}'`, 2);
    if (p.enabled === false) die(`--project '${opts.project}' is disabled (enabled:false) in team '${ws.file.team.key}'`, 2);
  }
  const allCandidates = rotationCandidates(ws);
  const candidates = opts.project ? allCandidates.filter((c) => c.key === opts.project) : allCandidates;
  // weight:0 = maintenance mode (T3.2): delivery rotation pauses but stewards keep covering the project —
  // so an all-weight:0 team still runs its selected stewards. Refuse only when NOTHING could ever fire.
  const stewardsSelected = opts.agents.some((a) => STEWARD_AGENTS.has(a));
  if (!candidates.length) {
    const scope = opts.project ? `--project '${opts.project}' is weight:0` : `no enabled, positively-weighted project in team '${ws.file.team.key}' (all disabled or weight:0?)`;
    if (!stewardsSelected || !stewardProjects(ws).length) die(`${scope} — nothing to fire (weight:0 pauses delivery; only stewards keep covering it)`, 2);
    console.warn(`dev-loop run: delivery rotation paused — ${scope} (weight:0 pauses delivery only); steward fires continue`);
  }

  console.log(`dev-loop run: team '${ws.file.team.key}' @ ${ws.root} (backend:${backend}); projects=${candidates.map((c) => `${c.key}×${c.weight}`).join(", ")}`);
  applyConfigCadence(opts, (agent) => ws.file.team.agents?.[agent]?.cadence, agentsWithCadence(ws.file.team.agents as Record<string, { cadence?: string }> | undefined));
  applyConfigTimeouts(opts, (agent) => ws.file.team.agents?.[agent]);
  preflightOpencodeModels(opts, cfg, ws.root, candidates.map((c) => c.key)); // zero-token: catch dead models/providers before the first fire
  // LOOP-312 — the shared checkout is a mutable global that no fire owns. Copy its uncommitted
  // TRACKED work before the first fire launches, and record which paths were already dirty, so
  // (a) another fire's `git checkout` cannot silently destroy it, and (b) the ship guard (LOOP-320)
  // can tell a fire's own edits from ones that were already sitting in the tree.
  preflightTreeSnapshot(ws.root, wsStateRoot(ws), (m) => console.log(m));
  // LOOP-253 — record WHICH BUILD is orchestrating this loop. Node caches every module at import
  // time and never reloads, so a reinstall mid-run leaves this process executing the code it loaded
  // at boot while `doctor` (a fresh process each invocation) reports the new one. Measured: four
  // landed fixes were live for doctor and dead in the orchestrator, with DOCTOR_OK printing.
  {
    const rec = writeSchedulerBuild(teamDirOf(wsStateRoot(ws)));
    if (rec) console.log(`dev-loop run: build ${rec.version} (pid ${rec.pid}) from ${rec.modulePath}`);
  }
  // Prod-monitoring guard: a team with health probes but no scheduled ops agent runs blind.
  const hasProbes = Object.values(ws.file.repos).some((r) => !!(r.ops?.checks?.length) || !!r.deploy?.healthCheck || Object.values(r.deploy?.environments ?? {}).some((e) => !!e?.healthCheck));
  if (hasProbes && !opts.agents.includes("ops")) console.warn(`dev-loop run: WARNING health probes are configured but 'ops' is not scheduled — prod incidents will go unnoticed. Launch with --agents core,ops (or all).`);
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
        console.log(`  ${String(i + 1).padStart(3)}  ${agent} → ${pick ?? "(delivery paused)"}`);
      }
    }
    return;
  }

  // Service backend: make sure the workspace hub daemon is up before the loop (operator needn't start it
  // by hand). Best-effort — a failed ensure logs but never blocks the scheduler.
  if (backend === "service" && !opts.dryRun) {
    try { const { ensureHub } = await import("./hub.ts"); const c = await ensureHub(ws); if (c !== 0) console.warn(`dev-loop run: hub ensure returned ${c} (continuing)`); }
    catch (e) { console.warn(`dev-loop run: hub ensure failed (${(e as Error).message}); continuing`); }
  }

  const fireLedger = wsFireLedger(ws);
  fireLedgerPath = fireLedger; // recordFire appends here (backend-agnostic soak metric)
  perFireCeilingUsd = ws.file.team.budget?.perFireUsd ?? DEFAULT_PER_FIRE_USD; // LOOP-230 in-flight watchdog: default ON, config overrides (only teamMain sets it ⇒ legacy path stays inert)
  try { const { pruneFireLedger } = await import("./metrics.ts"); pruneFireLedger(fireLedger); } catch { /* best-effort */ }

  const cwdFor = (project: string): string | null => primaryRepo(ws, project);

  // change-gate key per (agent, project) — service only, fails open (null key never skips). We evaluate it
  // AFTER a pick; a gate-skip advances to the next candidate in the same slot fire so a quiet project never
  // eats the fire opportunity of an active sibling.
  const gateActive = opts.changeGate && backend === "service";
  if (opts.changeGate && !gateActive) console.warn(`dev-loop run: --change-gate ignored on backend:"${backend}" (needs the service hub board cursor)`);
  if (gateActive) console.log(`dev-loop run: change-gate ON (pm/qa quiet-board TTL ${opts.changeGateTtlMs > 0 ? formatDuration(opts.changeGateTtlMs) : "off — pure gate"})`);
  const gateState: GateState = gateActive ? loadGateState(opts, "team") : {};
  const gateKey = (agent: Agent, project: string) => `${agent}:${project}`;

  // The project list a steward fire iterates over (it also drives the launch-profile representative):
  // every ENABLED project at ANY weight — weight:0 pauses DELIVERY only (T3.2) — and never narrowed by
  // --project (a steward fire is team-scope, not part of the rotation).
  const stewardScope = () => stewardProjects(ws);
  // Team scope for a steward: cwd = workspace root, project = _team (service) / "" (linear).
  const stewardProject = backend === "service" ? TEAM_INTAKE_PROJECT : "";

  // Pick-time seed guard (service): a config project with no hub.db row boots the hub MCP straight into
  // its G2 refusal — a full LLM turn with zero board access. The legacy fixed-project path dies at startup
  // (main() above); a rotating team must instead SKIP the unseeded project (warn once per project per
  // process) and keep its siblings firing. Fails open on an unreadable hub db — the fire surfaces that.
  const unseededWarned = new Set<string>();
  const seededInHub = (project: string): boolean => {
    if (backend !== "service") return true;
    if (fireDb === undefined) { try { fireDb = openDb(opts.hubDb); } catch { fireDb = null; } }
    if (!fireDb) return true;
    try { return !!findProject(fireDb, project); } catch { return true; }
  };
  const warnUnseeded = (agent: Agent, project: string): void => {
    if (unseededWarned.has(project)) return;
    unseededWarned.add(project);
    console.error(`[${agent}] project '${project}' is backend:"service" but not seeded in ${opts.hubDb} — ${opts.dryRun ? "real fires would get no hub tools" : "skipping its fires (siblings keep rotating)"}; seed it once: dev-loop seed ${project} "<Project Name>" <UNIQUE_PREFIX>`);
  };

  // A single fire for one agent. Stewards (M4) fire at TEAM scope (no rotation). Delivery agents rotate:
  // pick a project (skipping gated-unchanged + unseeded ones up to one full rotation), resolve its cwd, and run.
  const fireAgentOnce = async (agent: Agent): Promise<void> => {
    if (STEWARD_AGENTS.has(agent)) {
      // teamComms reads through `ws` at fire time so a hot-reloaded comms block takes effect next fire.
      await runAgent(opts, cfg, agent, stewardProject, ws.root, { enabledProjects: stewardScope(), teamComms: ws.file.team.comms ?? null });
      return;
    }
    let project: string | null = null;
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const p = pickProject(agent); // advances the shared cursor every attempt (skip-advance)
      if (!seededInHub(p)) {
        warnUnseeded(agent, p);
        if (!opts.dryRun) continue; // skip the token burn; a dry-run previews on (same shape as the legacy preflight)
      }
      if (gateActive && GATED_AGENTS.has(agent)) {
        const key = changeKey(opts, cfg, p);
        if (gateSkips(opts, gateState, gateKey(agent, p), agent, key)) continue; // unchanged (and inside the pm/qa TTL) ⇒ skip, try next candidate
        // R1b (LOOP-144): a dev tier with an empty servable slice in THIS project would no-op — skip to the next
        // candidate project (does not gateRecord; a genuine later change still fires). See devTierQueueSkip.
        const queueSkip = devTierQueueSkip(opts, agent, p);
        if (queueSkip !== null) { console.log(`[${agent}] skipped: ${queueSkip}`); continue; }
      }
      project = p; break;
    }
    if (project === null) return; // every candidate gated-unchanged / unseeded this round ⇒ no fire
    const cwd = cwdFor(project);
    if (!cwd || !existsSync(cwd)) { console.error(`[${agent}] project '${project}' has no usable repo cwd (${cwd ?? "none"}); skipping`); return; }
    await runAgent(opts, cfg, agent, project, cwd);
    if (gateActive && GATED_AGENTS.has(agent)) {
      const key = changeKey(opts, cfg, project);
      if (key !== null) { gateRecord(gateState, gateKey(agent, project), key); saveGateState(opts, "team", gateState); }
    }
  };

  if (opts.once) {
    // Budget-ceiling launch gate (LOOP-229): --once fires bypass tick() (they call fireAgentOnce directly), so
    // the gate is applied here too. Computed once for all agents (INV-1: unset ⇒ null, byte-identical to today).
    // fireLedgerPath + ws.file.team.budget are the live team ledger + ceiling.
    const budgetReason = budgetGateReason(ws.file.team.budget?.dailyUsd, fireLedgerPath, Date.now());
    for (const a of opts.agents) {
      if (budgetReason !== null) { console.log(`[${a}] launch refused: ${budgetReason}`); continue; } // refuse, loudly (AC3)
      await fireAgentOnce(a);
    }
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
      if (fresh) {
        ws = fresh; const c = rotationCandidates(ws); candidates.length = 0; candidates.push(...(opts.project ? c.filter((x) => x.key === opts.project) : c)); schedState = pruneCursor(schedState, candidates.map((x) => x.key));
        // Providers/permission follow the reload (the teamComms fire-time-read pattern): an operator adding
        // a registry entry + key mid-run must not need a scheduler restart. (The cfg/launch-profile projection
        // staying stale across reloads is a pre-existing class — see the 2026-07 review notes.)
        opts.providers = ws.file.team.providers ?? {};
        opts.opencodePermission = ws.file.team.opencodePermission;
        console.log(`dev-loop run: reloaded dev-loop.json — projects=${candidates.map((x) => x.key).join(", ")}`);
      }
    } catch (e) { console.error(`dev-loop run: dev-loop.json reload failed (${(e as Error).message}); keeping the last-good config`); }
  };

  const slots: Slot[] = opts.agents.map((agent, i) => ({ agent, nextAt: Date.now() + i * opts.staggerMs, running: false }));
  let stopping = false;
  let fired = 0;
  const drain = () => { if (stopping) return; stopping = true; clearInterval(timer); if (activeChildren.size === 0) process.exit(0); };
  // Graceful stop: forward SIGINT to the DIRECT child only (not the process group) — see the LOOP-23
  // decision at the other scheduler entrypoint above for why the graceful path stays non-forceful.
  const interrupt = () => { const first = !stopping; drain(); if (first) console.log("dev-loop run: stopping; forwarding SIGINT to active agent processes"); for (const child of activeChildren) child.kill("SIGINT"); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  // Config-integrity guard (field incident, 2026-07-23): an agent hand-edited dev-loop.json into invalid
  // JSON and every subsequent fire became an expensive no-op — the fire's own `dev-loop` CLI verbs die on
  // workspace resolution (exit 5), but the SCHEDULER kept spawning them at full cadence with no signal.
  // hotReload already keeps the last-good in-memory config; this guard additionally PAUSES spawning and
  // says so loudly (console always, comms once) until the file parses again. Fires resume by themselves.
  let cfgBroken = false;
  const configParses = (): boolean => {
    try { JSON.parse(readFileSync(ws.filePath, "utf8")); } catch (e) {
      if (!cfgBroken) {
        cfgBroken = true;
        const msg = `dev-loop.json is INVALID JSON (${(e as Error).message.split("\n")[0]}) — PAUSING all fires until it parses again. Did an agent hand-edit it? Config writes go through \`dev-loop team\`; restore the file (git checkout / .bak) to resume.`;
        console.error(`dev-loop run: ${msg}`);
        schedulerNotify(ws, "error", msg);
      }
      return false;
    }
    if (cfgBroken) {
      cfgBroken = false;
      console.log("dev-loop run: dev-loop.json parses again — resuming fires");
      schedulerNotify(ws, "info", "dev-loop.json restored — fires resumed");
    }
    return true;
  };

  const tick = () => {
    hotReload();
    if (!configParses()) return; // broken config ⇒ no new fires (in-flight fires finish; recovery is automatic)
    const now = Date.now();
    // Budget-ceiling launch gate (LOOP-229): computed once per tick (INV-1: unset ⇒ null, byte-identical). Over
    // team.budget.dailyUsd ⇒ refuse every runnable slot this tick and back off to probe cadence (INV-2). Read
    // through the (hot-reloaded) ws so an operator raising the ceiling — or the costly rows aging out of the
    // 24h window — resumes launches on the next tick (AC6).
    const budgetReason = budgetGateReason(ws.file.team.budget?.dailyUsd, fireLedgerPath, now);
    for (const slot of slots) {
      if (stopping || slot.running || slot.nextAt > now) continue;
      if (budgetReason !== null) {                               // over dailyUsd ⇒ refuse the launch, loudly (INV-3/AC3)
        console.log(`[${slot.agent}] launch refused: ${budgetReason}`);
        slot.nextAt = now + Math.max(opts.intervals[slot.agent], breaker.probeMs); // back off to probe cadence (INV-2)
        continue;
      }
      slot.running = true;
      fired++;
      fireAgentOnce(slot.agent)
        .catch((e) => { console.error(`[${slot.agent}] ${e instanceof Error ? e.message : String(e)}`); })
        .finally(() => {
          slot.running = false;
          slot.nextAt = Date.now() + breaker.intervalFor(slot.agent, opts.intervals[slot.agent]); // P0-1a: open ⇒ probe cadence
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

// main() runs unconditionally — this file is only ever the entry point (nothing imports it; recordFire
// is covered by the real-fire test harnesses, not a direct import). LOOP-58: LOOP-12 had guarded this
// with `import.meta.url === \`file://${process.argv[1]}\`` so the test could import recordFire without
// running main(). But `import.meta.url` is a percent-ENCODED file URL while `process.argv[1]` is a RAW
// path, so the guard silently failed on any checkout path holding a URL-escaped char (a space, `#`, `?`,
// non-ASCII) — `dev-loop run` then became an exit-0 no-op that fired, logged, and reported nothing (macOS
// `Google Drive` / `iCloud Drive` paths trip it). Deleting the guard deletes the whole failure class.
main().catch((e) => die(e instanceof Error ? e.message : String(e), 1));
