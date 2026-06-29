#!/usr/bin/env node
// Write the starter projects.json from the bundled npm payload/source checkout.
// This keeps the scheduler-only path clone-free: install npm package -> init-config -> edit -> run.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (build)
const defaultDest = () => join(homedir(), ".claude", "plugins", "data", "dev-loop", "projects.json");
const defaultTemplate = () => {
  const candidates = [
    join(here, "plugin", "config", "projects.example.json"),
    resolve(here, "..", "..", "config", "projects.example.json"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
};

function usage(): void {
  console.log(`dev-loop init-config - write a starter projects.json for scheduler runs

Usage:
  dev-loop init-config [--dest ~/.claude/plugins/data/dev-loop/projects.json] [--template <path>] [--force]

Options:
  --dest <path>       output file (default: ~/.claude/plugins/data/dev-loop/projects.json)
  --template <path>   template file (default: bundled npm config/projects.example.json)
  --force             overwrite an existing projects.json`);
}

function die(msg: string, code = 2): never {
  console.error(`dev-loop init-config: ${msg}`);
  process.exit(code);
}

export function initConfig(argv = process.argv.slice(2)): number {
  const opts = { dest: defaultDest(), template: defaultTemplate(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--dest") opts.dest = resolve(next());
    else if (a === "--template") opts.template = resolve(next());
    else if (a === "--force") opts.force = true;
    else die(`unknown option '${a}'`);
  }

  if (!existsSync(opts.template)) die(`template not found: ${opts.template}`, 1);
  if (existsSync(opts.dest) && !opts.force) {
    console.log(`projects.json already exists: ${opts.dest}`);
    console.log("Edit that file, or rerun with --force to replace it from the bundled template.");
    return 0;
  }
  mkdirSync(dirname(opts.dest), { recursive: true });
  copyFileSync(opts.template, opts.dest);
  console.log(`wrote ${opts.dest}`);
  console.log("Edit repoPath/repos[], strategyDoc, testEnv, backend, and keep mode:\"dry-run\" for first contact.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(initConfig());
}
