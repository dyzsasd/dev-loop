#!/usr/bin/env node
// `dev-loop` — the unified CLI for the standalone hub (P4 packaging, design daemon-multicli §6).
// A THIN dispatcher over the existing zero-build entry points (each keeps its own arg-parsing). After
// `npm i -g dev-loop` this is on PATH, so a product `.mcp.json` can say {command:"dev-loop", args:["shim"]}
// or {args:["serve"]} instead of a fragile absolute `node .../hub/src/server.ts` path. Zero build: Node
// >=23.6 type-strips the .ts entries directly; the bin shebang runs THIS file the same way.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)
// Resolve siblings by THIS file's own extension: `.ts` when run from source (zero-build dev), `.js` when
// run from the compiled, published package (node refuses to type-strip under node_modules — P4 ships JS).
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
const [cmd, ...rest] = process.argv.slice(2);

// subcommand → [entry base (no ext), ...prefix args]; the entry's OWN dispatcher consumes the rest unchanged.
const ROUTES: Record<string, [string, ...string[]]> = {
  serve:            ["server"],                    // the stdio MCP server (the agent transport; = the dev-loop-hub bin)
  shim:             ["shim"],                      // thin stdio MCP → loopback daemon op-API (DL-55)
  daemon:           ["server", "daemon"],          // up | down | status | ensure (DL-41)
  doctor:           ["server", "doctor"],
  seed:             ["seed"],
  "init-service":   ["init-service"],              // turnkey bootstrap (DL-60)
  "mcp-merge":      ["mcp-merge"],                 // merge into a product .mcp.json, never clobbers (DL-61)
  "identity-check": ["server", "identity-check"],  // the portability gate (PORTABILITY.md §4)
  "resolve-project":["server", "resolve-project"],
  "release-version":["release-version"],           // single-version stamp (P4)
};

const version = (): string => {
  try { return (JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
};

const usage = (): void => {
  console.log(`dev-loop ${version()} — standalone coordination hub (daemon + MCP + CLI)

Usage: dev-loop <command> [args]

  serve                       run the stdio MCP server (the agent transport; same as the dev-loop-hub bin)
  shim                        run the thin stdio MCP shim → the loopback daemon op-API (hub.transport:"daemon")
  daemon up|down|status       per-project daemon lifecycle — idempotent, auto-starts the localhost web UI
  init-service <key> <name> <PREFIX>   turnkey-bootstrap a service-backend project (seed → doctor → daemon up)
  mcp-merge <args>            merge dev-loop-hub into a product .mcp.json (never clobbers other servers)
  seed <key> <name> [PREFIX]  seed a project + actors + labels into the hub db
  doctor                      health-check the hub system-of-record (DOCTOR_OK)
  identity-check [--expect <actor>[/<project>]]   verify this shell resolves the intended identity
  version | help

Identity rides DEVLOOP_ACTOR (per pane); project DEVLOOP_PROJECT (or the cwd); db DEVLOOP_HUB_DB.
Docs: https://github.com/dyzsasd/dev-loop  (docs/RUNNING.md, docs/PORTABILITY.md, docs/HUB-ARCHITECTURE.md)`);
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

const route = ROUTES[cmd];
if (!route) { console.error(`dev-loop: unknown command '${cmd}'\n`); usage(); process.exit(2); }

const [entryBase, ...prefix] = route;
const r = spawnSync(process.execPath, [join(here, entryBase + EXT), ...prefix, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
