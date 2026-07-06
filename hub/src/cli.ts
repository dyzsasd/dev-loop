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
import { findCompatibleNode, MIN_NODE_VERSION, nodeVersionOk } from "./node-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)
// Resolve siblings by THIS file's own extension: `.ts` when run from source (zero-build dev), `.js` when
// run from the compiled, published package (node refuses to type-strip under node_modules — P4 ships JS).
const EXT = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
const [cmd, ...rest] = process.argv.slice(2);

// subcommand → [entry base (no ext), ...prefix args]; the entry's OWN dispatcher consumes the rest unchanged.
const ROUTES: Record<string, [string, ...string[]]> = {
  serve:            ["server"],                    // the stdio MCP server (the agent transport; = the dev-loop-hub bin)
  shim:             ["shim"],                      // thin stdio MCP → loopback daemon op-API (DL-55)
  daemon:           ["daemon"],                    // up | down | status | ensure (DL-41)
  team:             ["team"],                      // init | import | repair | add-project | add-repo — workspace (v2)
  hub:              ["hub"],                        // start | stop | status | ensure — the workspace hub daemon (service)
  "next-project":   ["rotation"],                  // print the next project for an agent's fire (shared WRR cursor)
  "with-repo-lock": ["with-repo-lock"],            // serialize base-clone mutations on a shared repo
  notify:           ["comms"],                     // push a message to the team's slack/lark channel
  metrics:          ["metrics"],                   // team KPIs from fires.jsonl (+ hub board on service)
  doctor:           ["server", "doctor"],
  seed:             ["seed"],
  run:              ["run-agents"],                // scheduler: own cadence + shells out to claude/codex once per fire
  "install-claude-plugin": ["install-claude-plugin"], // register a local npm-source marketplace so Claude Code loads the published plugin
  "init-service":   ["init-service"],              // turnkey bootstrap (DL-60)
  "mcp-merge":      ["mcp-merge"],                 // merge into a product .mcp.json, never clobbers (DL-61)
  "identity-check": ["server", "identity-check"],  // the portability gate (PORTABILITY.md §4)
  "resolve-project":["server", "resolve-project"],
  tickets:          ["cli-tickets", "tickets"],    // read-only terminal board list (DL-90)
  ticket:           ["cli-tickets", "ticket"],     // read-only single-ticket detail + comments (DL-90)
  "export-desktop-skill": ["export-desktop-skill"],// render a self-contained Claude Desktop skill for an agent + project (P2-12)
  // NB: `release-version` is deliberately NOT routed here — it mutates repo-only manifests
  // (.claude-plugin/*) absent from the npm package, so it's a source-tree-only tool: run it in-repo
  // via `node hub/src/release-version.ts <semver>` (Codex review 2026-06-27).
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
  daemon up|up-all|down|status|install-autostart|uninstall-autostart
                              daemon lifecycle — idempotent localhost web UI + optional login autostart
  team init|import|repair|add-project|add-repo
                              workspace (schema v2): create / migrate-from-v1 / repair / validated config writes
  hub start|stop|status|ensure   workspace hub daemon lifecycle (service backend; stop checkpoints the WAL)
  metrics [--window 7d] [--json]   team KPIs — fire success from fires.jsonl (+ board KPIs on service)
  notify [--level info|warn|error] [--title T] <text>   push to the team's slack/lark channel (team.comms)
  next-project --agent <a>    print the agent's next rotation pick (shared cursor with run; for /loop rows)
  with-repo-lock <ref> -- <cmd>   run a command holding a shared repo's base-clone lock
  init-service <key> <name> <PREFIX>   turnkey-bootstrap a service-backend project (seed → doctor → daemon up)
  run --cli claude|codex [--project <key>] [--agents core,outward]   schedule agents by calling the selected CLI
  install-claude-plugin      register a local npm-source marketplace so /plugin install can load it
  mcp-merge <args>            merge dev-loop-hub into a product .mcp.json (never clobbers other servers)
  seed <key> <name> [PREFIX]  seed a project + actors + labels into the hub db
  doctor                      health-check the hub system-of-record (DOCTOR_OK)
  identity-check [--expect <actor>[/<project>]]   verify this shell resolves the intended identity
  tickets [--all] [--state S] [--type T] [--owner O] [--label L] [--q TEXT]   read-only: list the resolved project's board (no daemon)
  ticket <id>                 read-only: show one ticket — detail + comments
  export-desktop-skill <agent> --project <key> [--team] [--out <dir>] [--zip]   render a self-contained Claude Desktop skill
  version | help

Identity rides DEVLOOP_ACTOR (per pane); project DEVLOOP_PROJECT (or the cwd); db DEVLOOP_HUB_DB.
Docs: https://github.com/dyzsasd/dev-loop  (docs/INDEX.md, docs/RUNNING.md, docs/PORTABILITY.md, docs/DAEMON.md)`);
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

const route = ROUTES[cmd];
if (!route) { console.error(`dev-loop: unknown command '${cmd}'\n`); usage(); process.exit(2); }

const NEEDS_NODE_SQLITE = new Set(["serve", "shim", "daemon", "doctor", "seed", "run", "init-service", "identity-check", "tickets", "ticket", "team", "next-project", "hub", "metrics"]);
// NB: `notify`, `with-repo-lock`, `next-project`, `team` don't strictly need node:sqlite for linear teams,
// but `team`/`next-project` may touch the hub on a service team — kept in the set above only where needed.
if (NEEDS_NODE_SQLITE.has(cmd) && !nodeVersionOk()) {
  const compatible = findCompatibleNode();
  if (compatible && compatible !== process.execPath) {
    const r = spawnSync(compatible, [fileURLToPath(import.meta.url), cmd, ...rest], { stdio: "inherit", env: { ...process.env, DEVLOOP_NODE: compatible } });
    process.exit(r.status ?? 1);
  }
  console.error(`dev-loop: '${cmd}' needs Node >= ${MIN_NODE_VERSION} for node:sqlite. Current Node is ${process.versions.node} (${process.execPath}).`);
  console.error("Install a newer Node or set DEVLOOP_NODE=/absolute/path/to/node before running this command.");
  process.exit(1);
}

const [entryBase, ...prefix] = route;
const r = spawnSync(process.execPath, [join(here, entryBase + EXT), ...prefix, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
