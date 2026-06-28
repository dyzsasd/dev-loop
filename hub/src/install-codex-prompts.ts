#!/usr/bin/env node
// Generate Codex CLI custom prompts from the dev-loop agent SKILLs.
// Codex custom prompts are the only documented way to expose user-defined slash commands in the CLI
// (`/prompts:<name>`). They are deprecated in favor of skills, so this is an optional compatibility layer;
// `dev-loop run --cli codex` remains the unattended/recommended path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PromptSpec = { agent: string; skillDir: string; command: string; actor: string; description: string };

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (build)
const isPluginRoot = (p: string) => existsSync(join(p, "skills")) && existsSync(join(p, "references"));
const defaultRoot = () => {
  const candidates = [join(here, "plugin"), resolve(here, "..", "..")];
  return candidates.find(isPluginRoot) ?? resolve(here, "..", "..");
};
const defaultDataDir = () => process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "plugins", "data", "dev-loop");

const PROMPTS: PromptSpec[] = [
  { agent: "pm", skillDir: "pm-agent", command: "dev-loop-pm-agent", actor: "pm", description: "Run the dev-loop Product Manager agent once." },
  { agent: "qa", skillDir: "qa-agent", command: "dev-loop-qa-agent", actor: "qa", description: "Run the dev-loop QA agent once." },
  { agent: "dev", skillDir: "dev-agent", command: "dev-loop-dev-agent", actor: "dev", description: "Run the dev-loop Dev agent once." },
  { agent: "senior-dev", skillDir: "senior-dev-agent", command: "dev-loop-senior-dev-agent", actor: "senior-dev", description: "Run the optional dev-loop senior-dev design lead once." },
  { agent: "junior-dev", skillDir: "junior-dev-agent", command: "dev-loop-junior-dev-agent", actor: "junior-dev", description: "Run the optional dev-loop junior-dev implementer once." },
  { agent: "sweep", skillDir: "sweep-agent", command: "dev-loop-sweep-agent", actor: "sweep", description: "Run the dev-loop Sweep hygiene agent once." },
  { agent: "reflect", skillDir: "reflect-agent", command: "dev-loop-reflect-agent", actor: "reflect", description: "Run the dev-loop Reflect retrospective agent once." },
  { agent: "ops", skillDir: "ops-agent", command: "dev-loop-ops-agent", actor: "ops", description: "Run the dev-loop Ops production-watch agent once." },
  { agent: "architect", skillDir: "architect-agent", command: "dev-loop-architect-agent", actor: "architect", description: "Run the dev-loop Architect technical-health agent once." },
  { agent: "director", skillDir: "director-agent", command: "dev-loop-director-agent", actor: "director", description: "Run the dev-loop Director roadmap/discussion agent once." },
  { agent: "communication", skillDir: "communication-agent", command: "dev-loop-communication-agent", actor: "communication", description: "Run the dev-loop Communication article-drafting agent once." },
  { agent: "init", skillDir: "init", command: "dev-loop-init", actor: "operator", description: "Run the dev-loop project bootstrap flow." },
];

function usage(): void {
  console.log(`dev-loop install-codex-prompts — install optional Codex CLI slash prompts

Usage:
  dev-loop install-codex-prompts [--dest ~/.codex/prompts] [--root <path>] [--data <path>]

Installs prompt files named /prompts:dev-loop-*-agent. Codex custom prompts are a compatibility
path for interactive CLI use; they do not own cadence. For unattended runs, prefer:
  dev-loop run --cli codex --agents core,communication

Options:
  --dest <path>    Codex prompts directory (default: ~/.codex/prompts)
  --root <path>    dev-loop plugin root (default: bundled npm assets or source checkout)
  --data <path>    dev-loop data dir substituted into prompts (default: ~/.claude/plugins/data/dev-loop)
  --list           print the prompt commands without writing files`);
}

function die(msg: string, code = 2): never {
  console.error(`dev-loop install-codex-prompts: ${msg}`);
  process.exit(code);
}

function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return raw;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end > 0 ? lines.slice(end + 1).join("\n").trimStart() : raw;
}

function parseArgs(argv: string[]): { dest: string; root: string; dataDir: string; list: boolean } {
  const opts = {
    dest: join(homedir(), ".codex", "prompts"),
    root: process.env.CLAUDE_PLUGIN_ROOT || process.env.DEVLOOP_PLUGIN_ROOT || defaultRoot(),
    dataDir: defaultDataDir(),
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--dest") opts.dest = resolve(next());
    else if (a === "--root") opts.root = resolve(next());
    else if (a === "--data") opts.dataDir = resolve(next());
    else if (a === "--list") opts.list = true;
    else die(`unknown option '${a}'`);
  }
  return opts;
}

function renderPrompt(spec: PromptSpec, root: string, dataDir: string): string {
  const skill = join(root, "skills", spec.skillDir, "SKILL.md");
  if (!existsSync(skill)) die(`skill file not found: ${skill}`, 1);
  const body = stripFrontmatter(readFileSync(skill, "utf8"))
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir);
  const actorFlag = spec.actor === "operator"
    ? ""
    : `\n\nFor correct hub attribution, this Codex session should have been started with:\n\n\`\`\`bash\ncodex -c 'mcp_servers.dev-loop-hub.env.DEVLOOP_ACTOR="${spec.actor}"'\n\`\`\`\n\nBefore making hub writes, call the dev-loop-hub \`whoami\` MCP tool. If its actor is not \`${spec.actor}\`, stop and tell the operator to restart Codex with the override above.`;
  return `---\ndescription: ${JSON.stringify(spec.description)}\nargument-hint: "[optional project/context]"\n---\n\nYou are running the dev-loop ${spec.agent} prompt from Codex CLI custom prompts. Codex exposes this command as \`/prompts:${spec.command}\`.${actorFlag}\n\nAdditional operator context, if any: $ARGUMENTS\n\n${body}`;
}

export function installCodexPrompts(argv = process.argv.slice(2)): number {
  const opts = parseArgs(argv);
  if (opts.list) {
    for (const p of PROMPTS) console.log(`/prompts:${p.command}`);
    return 0;
  }
  if (!isPluginRoot(opts.root)) die(`not a dev-loop plugin root: ${opts.root}`, 1);
  mkdirSync(opts.dest, { recursive: true });
  for (const p of PROMPTS) {
    const path = join(opts.dest, `${p.command}.md`);
    writeFileSync(path, renderPrompt(p, opts.root, opts.dataDir));
    console.log(`✓ /prompts:${p.command} → ${path}`);
  }
  console.log(`\nInstalled ${PROMPTS.length} Codex custom prompts. Restart Codex CLI, then type /prompts:dev-loop-…`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(installCodexPrompts());
}
