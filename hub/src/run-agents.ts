#!/usr/bin/env node
// `dev-loop run` — a small scheduler that fires agent SKILLs through a headless CLI.
// It deliberately does NOT depend on Claude/Codex `/loop`; it owns cadence here and
// shells out to `claude -p` or `codex exec` once per agent fire.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectFromCwd } from "./resolve-project.ts";

const VALID_AGENTS = [
  "pm", "qa", "dev", "senior-dev", "junior-dev", "sweep", "reflect",
  "ops", "architect", "communication",
] as const;
type Agent = (typeof VALID_AGENTS)[number];
type RunnerCli = "claude" | "codex";

const AGENT_SET = new Set<string>(VALID_AGENTS);
const GROUPS: Record<string, Agent[]> = {
  core: ["pm", "qa", "dev", "sweep"],
  split: ["pm", "qa", "senior-dev", "junior-dev", "sweep"],
  outward: ["ops", "architect", "communication"],
  all: [...VALID_AGENTS],
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

type ProjectsConfig = {
  defaultProject?: string;
  projects?: Record<string, {
    repoPath?: string;
    repos?: Array<{ path?: string; role?: string }>;
  }>;
};

type Options = {
  cli: RunnerCli;
  agents: Agent[];
  intervals: Record<Agent, number>;
  once: boolean;
  dryRun: boolean;
  devSplit: boolean;
  project?: string;
  root: string;
  dataDir: string;
  hubDb: string;
  cwd?: string;
  logDir?: string;
  claudeBin: string;
  codexBin: string;
  codexSafe: boolean;
  maxFires: number;     // 0 = unlimited; else stop after N total fires (cost guard)
  mcpConfig?: string;   // claude: explicit MCP config; defaults to <cwd>/.mcp.json if present
  extraArgs: string[];
};

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (build)
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts"; // server sibling: .ts source / .js published
const isPluginRoot = (p: string) => existsSync(join(p, "skills")) && existsSync(join(p, "references"));
const defaultRoot = () => {
  // Source checkout: hub/src -> repo root. Published package: dist/plugin -> bundled skills/references.
  const candidates = [join(here, "plugin"), resolve(here, "..", "..")];
  return candidates.find(isPluginRoot) ?? resolve(here, "..", "..");
};
const defaultDataDir = () => process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "plugins", "data", "dev-loop");
const defaultHubDb = () => process.env.DEVLOOP_HUB_DB || join(homedir(), ".dev-loop", "hub.db");

function usage(): void {
  console.log(`dev-loop run — schedule dev-loop agents with a headless CLI

Usage:
  dev-loop run --cli claude [--project <key>] [--agents core,communication]
  dev-loop run --cli codex  [--project <key>] [--agents core,outward]

Cadence is owned by this process, not by Claude/Codex /loop. Each fire shells out once:
  claude -p <agent skill prompt>
  codex exec ... <agent skill prompt>

Options:
  --cli claude|codex          CLI to invoke (default: claude)
  --project <key>             project key; optional. Defaults to DEVLOOP_PROJECT, then cwd→repo match, then defaultProject
  --agents <list>             comma list of agents or groups: core, split, outward, all
  --agent <name>              add one agent; may repeat
  --dev-split                 replace dev with senior-dev + junior-dev in the selected set
  --interval <agent=dur>      override cadence, e.g. pm=2m, communication=24h; may repeat
  --once                      run each selected agent once, then exit
  --dry-run                   print resolved commands; do not launch Claude/Codex
  --root <path>               dev-loop checkout root (default: inferred, or CLAUDE_PLUGIN_ROOT)
  --data <path>               plugin data dir (default: CLAUDE_PLUGIN_DATA or ~/.claude/plugins/data/dev-loop)
  --hub-db <path>             hub db path (default: DEVLOOP_HUB_DB or ~/.dev-loop/hub.db)
  --cwd <path>                working directory for CLI subprocesses (default: project repoPath)
  --mcp-config <path>         claude: MCP config to load + --strict-mcp-config (default: <cwd>/.mcp.json if present)
  --max-fires <n>             stop after N total agent fires, then drain + exit (cost guard; default 0 = unlimited)
  --codex-safe                omit Codex's unsafe bypass flags; useful for read-only/dry runs
  --cli-arg <arg>             pass an extra arg to the selected CLI before the prompt; may repeat
                              (CLI binaries: set DEVLOOP_CLAUDE_BIN / DEVLOOP_CODEX_BIN to override)

Durations accept ms/s/m/h/d. Default agents: core = pm,qa,dev,sweep.`);
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

function parseArgs(argv: string[]): Options {
  const agentSpecs: string[] = [];
  const intervals = { ...DEFAULT_INTERVALS };
  const extraArgs: string[] = [];
  const opts: Options = {
    cli: (process.env.DEVLOOP_RUNNER_CLI as RunnerCli) || "claude",
    agents: [],
    intervals,
    once: false,
    dryRun: false,
    devSplit: false,
    root: process.env.CLAUDE_PLUGIN_ROOT || process.env.DEVLOOP_PLUGIN_ROOT || defaultRoot(),
    dataDir: defaultDataDir(),
    hubDb: defaultHubDb(),
    claudeBin: process.env.DEVLOOP_CLAUDE_BIN || "claude",
    codexBin: process.env.DEVLOOP_CODEX_BIN || "codex",
    codexSafe: false,
    maxFires: 0,
    extraArgs,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--cli") {
      const v = next();
      if (v !== "claude" && v !== "codex") die("--cli must be claude or codex");
      opts.cli = v;
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
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--root") opts.root = resolve(next());
    else if (a === "--data") opts.dataDir = resolve(next());
    else if (a === "--hub-db") opts.hubDb = resolve(next());
    else if (a === "--cwd") opts.cwd = resolve(next());
    else if (a === "--mcp-config") opts.mcpConfig = resolve(next());
    else if (a === "--max-fires") {
      opts.maxFires = Number(next());
      if (!Number.isInteger(opts.maxFires) || opts.maxFires < 0) die("--max-fires must be a non-negative integer (0 = unlimited)");
    }
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
  const p = process.env.DEVLOOP_PROJECTS_JSON || join(dataDir, "projects.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as ProjectsConfig; }
  catch (e) { die(`could not parse ${p}: ${(e as Error).message}`, 1); }
}

function resolveProject(opts: Options, cfg: ProjectsConfig | null): string {
  const explicit = opts.project || process.env.DEVLOOP_PROJECT?.trim();
  if (explicit) return explicit;
  const fromCwd = cfg ? resolveProjectFromCwd(opts.cwd || process.cwd(), cfg) : null;
  return fromCwd || cfg?.defaultProject || Object.keys(cfg?.projects ?? {})[0] || "demo";
}

function resolveCwd(opts: Options, cfg: ProjectsConfig | null, project: string): string {
  if (opts.cwd) return opts.cwd;
  const p = cfg?.projects?.[project];
  const primaryRepo = p?.repos?.find((r) => r.role === "primary" && r.path)?.path;
  const docRepo = p?.repos?.find((r) => r.role === "docs" && r.path)?.path;
  return p?.repoPath || primaryRepo || docRepo || p?.repos?.find((r) => r.path)?.path || process.cwd();
}

function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end > 0 ? lines.slice(end + 1).join("\n").trimStart() : raw;
}

function readPrompt(opts: Options, agent: Agent): string {
  const skill = join(opts.root, "skills", `${agent}-agent`, "SKILL.md");
  if (!existsSync(skill)) die(`skill file not found for '${agent}': ${skill}. Pass --root <dev-loop checkout>.`, 1);
  const body = stripFrontmatter(readFileSync(skill, "utf8"))
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", opts.root)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", opts.dataDir);
  return `You are launched by dev-loop's own scheduler. Run exactly one fresh fire for this agent, then stop.\n\n${body}`;
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

// The dev-loop-hub MCP server the scheduler injects itself, so NEITHER CLI needs the plugin or a
// pre-existing config. Points at this package's own server entry (.ts source / .js published) + the
// resolved hub db, with the per-fire actor/project. claude takes it as inline --mcp-config JSON;
// codex takes the same shape as `-c` overrides (which define the server, not just patch env).
const serverEntry = join(here, `server${EXT}`);

function commandFor(opts: Options, agent: Agent, project: string, prompt: string): { command: string; args: string[] } {
  if (opts.cli === "claude") {
    // explicit --mcp-config file wins; otherwise inject the hub inline so a fresh project needs no .mcp.json.
    const mcpArg = opts.mcpConfig ?? JSON.stringify({
      mcpServers: { "dev-loop-hub": { command: "node", args: [serverEntry], env: { DEVLOOP_ACTOR: agent, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: opts.hubDb } } },
    });
    return { command: opts.claudeBin, args: ["--mcp-config", mcpArg, "--strict-mcp-config", ...opts.extraArgs, "-p", prompt] };
  }
  const args = [
    "exec",
    ...opts.extraArgs,
    "-c", `mcp_servers.dev-loop-hub.command="node"`,
    "-c", `mcp_servers.dev-loop-hub.args=["${serverEntry}"]`,
    "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR="${agent}"`,
    "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_PROJECT="${project}"`,
    "-c", `mcp_servers.dev-loop-hub.env.DEVLOOP_HUB_DB="${opts.hubDb}"`,
  ];
  if (!opts.codexSafe) args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
  args.push(prompt);
  return { command: opts.codexBin, args };
}

function displayCommand(command: string, args: string[], prompt: string): string {
  return [command, ...args.map((a) => a === prompt ? `<prompt:${prompt.length} chars>` : a).map(shellQuote)].join(" ");
}

async function runAgent(opts: Options, agent: Agent, project: string, cwd: string): Promise<number> {
  const prompt = readPrompt(opts, agent);
  const { command, args } = commandFor(opts, agent, project, prompt);
  const env = {
    ...process.env,
    DEVLOOP_ACTOR: agent,
    DEVLOOP_PROJECT: project,
    DEVLOOP_HUB_DB: opts.hubDb,
    CLAUDE_PLUGIN_ROOT: opts.root,
    CLAUDE_PLUGIN_DATA: opts.dataDir,
  };
  const rendered = displayCommand(command, args, prompt);
  if (opts.dryRun) {
    console.log(`[dry-run] ${agent}: cwd=${cwd}`);
    console.log(`[dry-run] ${agent}: ${rendered}`);
    return 0;
  }

  const logDir = opts.logDir || join(opts.dataDir, project, "runner-logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${agent}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n\n===== ${new Date().toISOString()} ${rendered} cwd=${cwd} =====\n`);
  console.log(`[${new Date().toISOString()}] ${agent}: start (${opts.cli}); log ${logPath}`);

  const child: ChildProcessWithoutNullStreams = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  activeChildren.add(child);
  child.stdout.on("data", (d) => { process.stdout.write(`[${agent}] ${d}`); log.write(d); });
  child.stderr.on("data", (d) => { process.stderr.write(`[${agent}] ${d}`); log.write(d); });

  return await new Promise((resolveExit) => {
    child.on("error", (e) => { log.write(`\nERROR: ${e.message}\n`); console.error(`[${agent}] failed to start: ${e.message}`); resolveExit(1); });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      log.write(`\n===== exit code=${code ?? "null"} signal=${signal ?? "null"} =====\n`);
      log.end();
      console.log(`[${new Date().toISOString()}] ${agent}: exit ${code ?? `signal ${signal}`}`);
      resolveExit(code ?? 1);
    });
  });
}

type Slot = { agent: Agent; nextAt: number; running: boolean };
const activeChildren = new Set<ChildProcessWithoutNullStreams>();

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = readProjects(opts.dataDir);
  const project = resolveProject(opts, cfg);
  const cwd = resolveCwd(opts, cfg, project);
  if (!existsSync(cwd)) die(`cwd does not exist: ${cwd}`, 1);
  console.log(`dev-loop run: cli=${opts.cli} project=${project} cwd=${cwd}`);
  console.log(`dev-loop run: root=${opts.root} data=${opts.dataDir} hubDb=${opts.hubDb}`);
  console.log(`dev-loop run: agents=${opts.agents.map((a) => `${a}@${formatDuration(opts.intervals[a])}`).join(", ")}`);

  if (opts.once) {
    const results = await Promise.all(opts.agents.map((a) => runAgent(opts, a, project, cwd)));
    process.exit(results.every((c) => c === 0) ? 0 : 1);
  }

  const slots: Slot[] = opts.agents.map((agent) => ({ agent, nextAt: Date.now(), running: false }));
  let stopping = false;
  let fired = 0; // total fires started; --max-fires caps it (0 = unlimited)
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log("dev-loop run: stopping; forwarding SIGINT to active agent processes");
    for (const child of activeChildren) child.kill("SIGINT");
    if (activeChildren.size === 0) process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const tick = () => {
    const now = Date.now();
    for (const slot of slots) {
      if (stopping || slot.running || slot.nextAt > now) continue;
      slot.running = true;
      fired++;
      runAgent(opts, slot.agent, project, cwd)
        .catch((e) => { console.error(`[${slot.agent}] ${e instanceof Error ? e.message : String(e)}`); return 1; })
        .finally(() => {
          slot.running = false;
          slot.nextAt = Date.now() + opts.intervals[slot.agent];
          if (stopping && activeChildren.size === 0) process.exit(0);
        });
      if (opts.maxFires && fired >= opts.maxFires) {
        console.log(`dev-loop run: reached --max-fires ${opts.maxFires}; draining active fires then exiting`);
        stop();
        break;
      }
    }
  };
  const timer = setInterval(tick, 1_000);
  tick();
}

main().catch((e) => die(e instanceof Error ? e.message : String(e), 1));
