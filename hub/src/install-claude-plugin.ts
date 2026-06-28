#!/usr/bin/env node
// Install the Claude Code plugin from the npm package/source checkout into the user's personal
// skills-directory plugin location. Claude Code loads any folder under ~/.claude/skills containing
// .claude-plugin/plugin.json as a plugin on the next session, without a marketplace or repo clone.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (build)
const isPluginRoot = (p: string) => existsSync(join(p, ".claude-plugin", "plugin.json")) && existsSync(join(p, "skills")) && existsSync(join(p, "references"));
const defaultRoot = () => {
  const candidates = [join(here, "plugin"), resolve(here, "..", "..")];
  return candidates.find(isPluginRoot) ?? resolve(here, "..", "..");
};
const defaultDest = () => join(homedir(), ".claude", "skills", "dev-loop");

function usage(): void {
  console.log(`dev-loop install-claude-plugin - install dev-loop as a Claude Code skills-directory plugin

Usage:
  dev-loop install-claude-plugin [--dest ~/.claude/skills/dev-loop] [--root <path>] [--dry-run]

This copies the plugin payload from the npm package/source checkout into ~/.claude/skills/dev-loop.
Claude Code loads it on the next session as dev-loop@skills-dir, exposing slash commands such as
/dev-loop:pm-agent, /dev-loop:communication-agent, and /dev-loop:init.

Options:
  --dest <path>    install destination (default: ~/.claude/skills/dev-loop)
  --root <path>    dev-loop plugin root (default: bundled npm assets or source checkout)
  --dry-run        print what would be copied without writing`);
}

function die(msg: string, code = 2): never {
  console.error(`dev-loop install-claude-plugin: ${msg}`);
  process.exit(code);
}

function parseArgs(argv: string[]): { dest: string; root: string; dryRun: boolean } {
  const opts = {
    dest: defaultDest(),
    root: process.env.CLAUDE_PLUGIN_ROOT || process.env.DEVLOOP_PLUGIN_ROOT || defaultRoot(),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--dest") opts.dest = resolve(next());
    else if (a === "--root") opts.root = resolve(next());
    else if (a === "--dry-run") opts.dryRun = true;
    else die(`unknown option '${a}'`);
  }
  return opts;
}

function copyFresh(root: string, dest: string, rel: string): void {
  const src = join(root, rel);
  if (!existsSync(src)) return;
  const to = join(dest, rel);
  rmSync(to, { recursive: true, force: true });
  cpSync(src, to, { recursive: true });
}

function writeNpmSafeHook(dest: string): void {
  const hooksDir = join(dest, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const source = join(dest, "hooks", "hooks.json");
  let hook: unknown;
  try { hook = JSON.parse(readFileSync(source, "utf8")); }
  catch { hook = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "dev-loop daemon up >/dev/null 2>&1 || true", timeout: 15 }] }] } }; }
  const j = hook as {
    hooks?: { SessionStart?: Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number }> }> };
  };
  for (const entry of j.hooks?.SessionStart ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.type === "command" && /daemon\s+up/.test(h.command ?? "")) {
        h.command = "dev-loop daemon up >/dev/null 2>&1 || true";
        h.timeout ??= 15;
      }
    }
  }
  writeFileSync(source, JSON.stringify(j, null, 2) + "\n");
}

export function installClaudePlugin(argv = process.argv.slice(2)): number {
  const opts = parseArgs(argv);
  if (!isPluginRoot(opts.root)) die(`not a dev-loop Claude plugin root: ${opts.root}`, 1);
  const rels = [".claude-plugin", "skills", "references", "hooks", "config"];
  if (opts.dryRun) {
    console.log(`would install dev-loop Claude plugin from ${opts.root} to ${opts.dest}`);
    for (const rel of rels) if (existsSync(join(opts.root, rel))) console.log(`  copy ${rel}/`);
    console.log("  patch hooks/hooks.json to call: dev-loop daemon up");
    return 0;
  }
  mkdirSync(opts.dest, { recursive: true });
  for (const rel of rels) copyFresh(opts.root, opts.dest, rel);
  writeNpmSafeHook(opts.dest);
  console.log(`installed dev-loop Claude plugin to ${opts.dest}`);
  console.log("Restart Claude Code, or run /reload-plugins in an existing session.");
  console.log("Expected commands: /dev-loop:pm-agent, /dev-loop:qa-agent, /dev-loop:dev-agent, /dev-loop:communication-agent, /dev-loop:init");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(installClaudePlugin());
}
