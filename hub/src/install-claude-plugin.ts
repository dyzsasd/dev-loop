#!/usr/bin/env node
// `dev-loop install-claude-plugin` — register a LOCAL marketplace whose single plugin has an `npm`
// source, so Claude Code installs the published @dyzsasd/dev-loop plugin from npm (no GitHub, no
// file-copy that drifts from the npm version). Claude Code marketplaces support an npm plugin source
// (docs: plugin-marketplaces). We write the tiny marketplace.json + print the two `/plugin` commands
// (those are interactive — this CLI can't run them).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pkgVersion } from "./paths.ts";

const MARKETPLACE = "dev-loop-npm";
const PLUGIN = "dev-loop";
const defaultDest = () => join(homedir(), ".claude", "plugins", "marketplaces", MARKETPLACE);

function usage(): void {
  console.log(`dev-loop install-claude-plugin — register a local npm-source marketplace for the Claude plugin

Usage:
  dev-loop install-claude-plugin [--dest <dir>] [--package <name>] [--version <semver>] [--dry-run]

Writes a marketplace.json whose plugin pulls from npm (default @dyzsasd/dev-loop), then prints the
two interactive /plugin commands to run. No GitHub, no file copy — the npm package is the single
source of truth for the plugin version.

Options:
  --dest <dir>      marketplace dir (default: ~/.claude/plugins/marketplaces/${MARKETPLACE})
  --package <name>  npm package (default: @dyzsasd/dev-loop)
  --version <semver> pin a version (default: latest)
  --dry-run         print the marketplace.json + commands without writing`);
}

function die(msg: string, code = 2): never {
  console.error(`dev-loop install-claude-plugin: ${msg}`);
  process.exit(code);
}

export function installClaudePlugin(argv = process.argv.slice(2)): number {
  const opts = { dest: defaultDest(), pkg: "@dyzsasd/dev-loop", version: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--dest") opts.dest = resolve(next());
    else if (a === "--package") opts.pkg = next();
    else if (a === "--version") opts.version = next();
    else if (a === "--dry-run") opts.dryRun = true;
    else die(`unknown option '${a}'`);
  }

  // Default the version pin to THIS CLI's own version so the installed plugin matches the CLI the operator
  // just installed. Without a pin, Claude Code resolves the npm `latest` dist-tag — which SKIPS a prerelease
  // published under another tag (e.g. an rc on `next`), silently installing an OLDER plugin than the CLI and
  // omitting its newest skills (add-project/add-repo, …). `--version <semver|dist-tag>` overrides; pass
  // `--version latest` to opt back into the floating latest.
  const version = opts.version || pkgVersion();
  const source: Record<string, string> = { source: "npm", package: opts.pkg };
  if (version && version !== "latest") source.version = version;
  const marketplace = { name: MARKETPLACE, owner: { name: "Shuai" }, plugins: [{ name: PLUGIN, source }] };
  const file = join(opts.dest, ".claude-plugin", "marketplace.json");
  const json = JSON.stringify(marketplace, null, 2) + "\n";

  if (opts.dryRun) {
    console.log(`would write ${file}:\n${json}`);
  } else {
    mkdirSync(join(opts.dest, ".claude-plugin"), { recursive: true });
    writeFileSync(file, json);
    console.log(`wrote ${file}`);
  }
  console.log(`\nNow run these two interactive Claude Code commands:`);
  console.log(`  /plugin marketplace add ${opts.dest}`);
  console.log(`  /plugin install ${PLUGIN}@${MARKETPLACE}`);
  console.log(`\nInstalls @dyzsasd/dev-loop@${version || "latest"} (pinned to this CLI's version; pass --version to change).`);
  console.log(`Then /reload-plugins (or restart). Skills appear as /dev-loop:pm-agent … /dev-loop:add-project.`);
  if (!opts.dryRun && !existsSync(file)) die(`failed to write ${file}`, 1);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(installClaudePlugin());
}
