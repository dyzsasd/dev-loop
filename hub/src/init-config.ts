#!/usr/bin/env node
// Write an empty starter projects.json.
// This keeps the scheduler-only path clone-free: install npm package -> init-config -> edit -> run.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devloopProjectsPath, legacyClaudeDataDir } from "./paths.ts";

const defaultDest = () => devloopProjectsPath();
const STARTER_CONFIG = {
  _comment: "Add your projects under projects. dev-loop does not enable any sample project by default.",
  projects: {},
};

function usage(): void {
  console.log(`dev-loop init-config - write an empty starter projects.json for scheduler runs

Usage:
  dev-loop init-config [--dest ~/.dev-loop/projects.json] [--template <path>] [--force]

Options:
  --dest <path>       output file (default: ~/.dev-loop/projects.json)
  --template <path>   copy this explicit template instead of writing the empty starter
  --force             overwrite an existing projects.json`);
}

function die(msg: string, code = 2): never {
  console.error(`dev-loop init-config: ${msg}`);
  process.exit(code);
}

export function initConfig(argv = process.argv.slice(2)): number {
  const opts: { dest: string; template?: string; force: boolean } = { dest: defaultDest(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--dest") opts.dest = resolve(next());
    else if (a === "--template") opts.template = resolve(next());
    else if (a === "--force") opts.force = true;
    else die(`unknown option '${a}'`);
  }

  if (opts.template && !existsSync(opts.template)) die(`template not found: ${opts.template}`, 1);
  if (existsSync(opts.dest) && !opts.force) {
    console.log(`projects.json already exists: ${opts.dest}`);
    console.log("Edit that file, or rerun with --force to replace it.");
    return 0;
  }
  mkdirSync(dirname(opts.dest), { recursive: true });
  if (opts.template) copyFileSync(opts.template, opts.dest);
  else writeFileSync(opts.dest, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`);
  console.log(`wrote ${opts.dest}`);
  console.log("No project is predefined. Add one project key, repoPath/repos[], strategyDoc, testEnv, backend, and keep mode:\"dry-run\" for first contact.");
  const legacy = `${legacyClaudeDataDir()}/projects.json`;
  if (legacy !== opts.dest && existsSync(legacy)) {
    console.log(`legacy Claude-plugin config still exists at ${legacy}; dev-loop now defaults to ${opts.dest}. Copy only the projects you still want.`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(initConfig());
}
