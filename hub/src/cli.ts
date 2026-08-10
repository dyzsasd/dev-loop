#!/usr/bin/env node
// `dev-loop` — the unified CLI for the standalone hub (P4 packaging, design daemon-multicli §6).
// A THIN dispatcher over the existing zero-build entry points (each keeps its own arg-parsing). After
// `npm i -g dev-loop` this is on PATH, so a product `.mcp.json` can say {command:"dev-loop", args:["shim"]}
// or {args:["serve"]} instead of a fragile absolute `node .../hub/src/server.ts` path. Zero build: Node
// >=23.6 type-strips the .ts entries directly; the bin shebang runs THIS file the same way.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  init:             ["init-wizard"],               // guided onboarding wizard — composes team init + first project/repo + doctor NEXT (P1)
  team:             ["team"],                      // init | import | repair | set | add-project | add-repo | add-provider | sync-opencode — workspace (v2)
  secret:           ["secret-cli"],                // set | list | unset — workspace secret VALUES (.dev-loop/secrets.env; §16)
  settings:         ["settings-cli"],              // LOOP-479: list|get|set|unset — the hub projects.settings_json switchboard (humanWrite, workflow.transitions, notifier cadences)
  up:               ["up"],                        // one-click: local operator console / --bundle headless load / --attach remote hub
  attach:           ["up", "--attach"],            // sugar: `dev-loop attach <url>` ≡ `dev-loop up --attach <url>` (§6.0)
  bundle:           ["bundle"],                    // export — the encrypted move/backup artifact (one-click §4)
  board:            ["board"],                     // LOOP-338: the board-only snapshot artifact + retention
  hub:              ["hub"],                        // start | stop | status | ensure — the workspace hub daemon (service)
  "next-project":   ["rotation"],                  // print the next project for an agent's fire (shared WRR cursor)
  "with-repo-lock": ["with-repo-lock"],            // serialize base-clone mutations on a shared repo
  notify:           ["comms"],                     // push a message to the team's slack/lark channel
  "push-guard":     ["push-guard"],                // P1-2: pre-push ride-along check (canceled-ticket commits)
  push:             ["push"],                      // LOOP-521: `push-guard --strict` AND `git push` as ONE call — the gate is the precondition of the push, so skipping it is not an available argv (design approvals §16.3)
  "stage-guard":    ["stage-guard"],               // LOOP-320: pre-COMMIT check — refuse another fire's edits in the staged set
  "conventions":    ["conventions-verb"],          // LOOP-237: the PULL half of §0a delivery — one agent's config-pruned slice, on demand
  metrics:          ["metrics"],                   // team KPIs from fires.jsonl (+ hub board on service)
  quality:          ["quality"],                   // per-function CRAP report/gate + mutation probe (quality-gauntlet)
  doctor:           ["server", "doctor"],
  seed:             ["seed"],
  run:              ["run-agents"],                // scheduler: own cadence + shells out to claude/codex once per fire
  stop:             ["stop"],                      // stop the workspace's running scheduler via the run lock (pairs with `run --background`)
  "install-claude-plugin": ["install-claude-plugin"], // register a local npm-source marketplace so Claude Code loads the published plugin
  "init-service":   ["init-service"],              // turnkey bootstrap (DL-60)
  "mcp-merge":      ["mcp-merge"],                 // merge into a product .mcp.json, never clobbers (DL-61)
  "identity-check": ["server", "identity-check"],  // the portability gate (PORTABILITY.md §4)
  "resolve-project":["server", "resolve-project"],
  tickets:          ["cli-tickets", "tickets"],    // read-only terminal board list (DL-90; --json = op-shaped list_issues)
  ticket:           ["cli-tickets", "ticket"],     // read-only single-ticket detail + comments (DL-90; create/update re-route below)
  op:               ["cli-agentops", "op"],        // LAYER 0 (A1/D8): dispatch ANY hub op with raw JSON args through agentOp()
  comment:          ["cli-agentops", "comment"],   // comment add <id> — save_comment sugar
  comments:         ["cli-agentops", "comments"],  // a ticket's comments as JSON (list_comments)
  labels:           ["cli-agentops", "labels"],    // the project's labels as JSON (list_issue_labels)
  label:            ["cli-agentops", "label"],     // label create <name> [--kind K] (create_issue_label)
  project:          ["cli-agentops", "project"],   // the active project as JSON (get_project)
  events:           ["cli-agentops", "events"],    // attribution events as JSON (list_events; --actor/--since filter server-side)
  doc:              ["cli-agentops", "doc"],       // doc list|get|history|diff|save|publish|archive — doc.* 1:1 (save: CAS, CONFLICT → exit 3)
  mirror:           ["cli-agentops", "mirror"],    // mirror push|poll|status — the one-way Linear mirror + comment→intake poll
  queue:            ["cli-agentops", "queue"],     // LAYER 1: the pre-ranked per-agent work lists (§5/§21b) — every agent's mandated first board read
  "dependency-graph":["cli-agentops", "dependency_graph"], // LOOP-105: read-only §9c/W5 dependency-graph surface
  "export-desktop-skill": ["export-desktop-skill"],// render a self-contained Claude Desktop skill for an agent + project (P2-12)
  worktree:         ["worktree"],                  // add <id> [--repo <ref>] — create dev worktree off origin/<defaultBranch> (LOOP-54; LOOP-37 adds path + reaper)
  "merge-guard":    ["merge-guard"],               // LOOP-64+67: forge review (§3.1/§3.2) + board-state (§3.3) axes — trip on human CHANGES_REQUESTED or non-merge-eligible ticket (design: merge-review-guard)
  pr:               ["pr-merge"],                  // LOOP-444: `pr merge <n>` — the guard's three axes AND the squash as ONE call, so a skipped gate is not an available argv
  "doc-land":       ["doc-land"],                  // LOOP-57: land PM's doc-only strategyDoc commits to origin/<defaultBranch> ff-only (design: landing-discipline §4.6)
  // LOOP-392 (approvals C2): typed human authorization the system can consult. approve/revoke are
  // FIRE-REFUSED inside approvals-cli.ts (design §2) — the property every consumer of an approval rests
  // on; request/approvals are agent-callable. Deliberately ABSENT from ATTACH_OK below: they are
  // direct-db verbs, so over an attach they would silently write the LOCAL board.
  approve:          ["approvals-cli", "approve"],
  revoke:           ["approvals-cli", "revoke"],
  approvals:        ["approvals-cli", "approvals"],
  request:          ["approvals-cli", "request"],
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
  daemon up|up-all|down|status|reap|install-autostart|uninstall-autostart
                              daemon lifecycle — idempotent localhost web UI + optional login autostart
  daemon reap [--dry-run]     stop orphaned dev-loop-hub daemons (dbPresent:false) across the port band
  init [--dir <path>] [--yes]  guided setup — workspace + first project/repo (interactive on a TTY;
                              --yes takes every default), ends with the doctor verdict + its NEXT line
  team init|import|repair|set|add-project|add-repo|add-provider|sync-opencode
                              workspace (schema v2): create / migrate-from-v1 / repair / validated config writes
  secret set|list|unset       workspace secret VALUES (.dev-loop/secrets.env, chmod 600) — set prompts on
                              the TTY (echo off) or reads stdin; a value never rides an argument (§16)
  settings list|get|set|unset the hub project's runtime switchboard (projects.settings_json): humanWrite.enabled
                              (the web-write forms), workflow.transitions, the notifier cadences. Additive by
                              path. humanWrite/workflow take effect immediately (read per request); the
                              cadences need a restart of the daemon owning that project (read once at
                              bootstrap) — the write prints the exact command; hub restarts only _team
  up [--cli claude|opencode] [--dry-launch]   one-click: scaffold-if-needed + board daemon + EXEC an
                              interactive operator-console chat (setup happens by talking, not shell);
                              --bundle <f> = headless remote load → run; --attach <url> = console → remote hub
  bundle export …             author the encrypted move/backup artifact (config+secrets+hub.db; age)
  board snapshot|snapshots    the BOARD-only backup (hub.db, never a secret) + retention by embedded timestamp
  hub start|stop|status|ensure   workspace hub daemon lifecycle (service backend; stop checkpoints the WAL)
  metrics [--window 7d] [--json] [--context]   team KPIs — fire success from fires.jsonl (+ board KPIs
                              on service); --context = the per-agent per-fire context bill (§0a)
  notify [--level info|warn|error] [--title T] <text>   push to the team's slack/lark channel (team.comms)
  next-project --agent <a>    print the agent's next rotation pick (shared cursor with run; for /loop rows)
  with-repo-lock <ref> -- <cmd>   run a command holding a shared repo's base-clone lock
  conventions --agent <a> [--project <k>] [--json]      the config-pruned §0a slice for ONE agent, on
                                                        demand (the PULL half of the delivery path)
  stage-guard [--repo <d>] [--override "<why>"]         pre-COMMIT check: refuse staged files that were
                                                        already uncommitted before this run started
  push-guard [--repo <dir>] [--branch <b>] [--strict]   pre-push ride-along check: flag unpushed commits
                              whose referenced tickets are Canceled/Duplicate (P1-2; --strict exits 1 on findings)
  push [--repo <dir>] [--branch <b>] [--remote <n>] [--dry-run] [--json]   gate AND publish a branch in ONE
                              call: push-guard --strict runs inside it and the \`git push\` happens only when
                              every class clears, so there is no argv that waives the gate (LOOP-521). Exit
                              0 pushed/nothing-to-push · 1 HELD (every refusing class named) · 2 usage · 3
                              the gate could not evaluate · 4 gate clear but the push failed · 5 lock busy
  worktree add <id> [--repo <ref>]   create a dev worktree on branch dev-loop/<id> based at origin/<defaultBranch>
                              (never local main — prevents passenger commits; LOOP-54)
  worktree path <id> [--repo <ref>]  print the canonical worktree path (single source of truth; LOOP-37)
  worktree reap [--repo <ref>] [--dry-run]   remove terminal-state ticket worktrees + local branches (LOOP-37)
  merge-guard [--repo <dir>] [--pr <n>] [--ticket <id>] [--strict] [--json]
                              refuse merge on human CHANGES_REQUESTED (forge axis, --pr) or non-merge-eligible
                              ticket (board-state axis); both degrade silently (design: merge-review-guard; LOOP-64+67)
  pr merge <n> [--repo <dir>] [--ticket <id>] [--no-apply] [--json]   gate AND land a feature PR in ONE call:
                              the guard's three axes run inside it and the --squash --delete-branch happens only
                              when they clear, so skipping the gate is not an available argv (LOOP-444). Exit
                              0 merged/already-merged · 1 HELD (every objecting axis named) · 2 usage · 3
                              nothing evaluable · 4 gate clear but the squash failed
  doc-land [--repo <ref>] [--dry-run]   land PM's doc-only strategyDoc progress commits to origin/<defaultBranch>
                              ff-only (design: landing-discipline §4.6; LOOP-57)
  approve <key> [--expires 24h|never] [--note T] [--project K|--workspace] [--json]
  approve --request <approval-id> […]   grant a typed approval — OPERATOR-ONLY, refused inside an agent
                              fire: an approval a fire could grant itself would authorise nothing (LOOP-392)
  revoke <key|approval-id> [--note T] [--project K|--workspace] [--json]   end one early (operator-only,
                              refused inside a fire). A KEY resolves within the scope only — another
                              project's grant is not yours to end from here
  approvals [--key K] [--state S] [--project K|--workspace|--all] [--json]   list them, state derived at
                              read time — read-only, agent-callable, ledgers nothing
  request <key> --ticket <id> [--note T]   file a typed request for an approval this caller cannot grant
                              itself — agent-callable, authorises nothing, and nothing waits on it
                              (an action key names an END STATE: push:main:<sha>, never push:main —
                              run \`dev-loop approve --help\` for the grammar)
  init-service <key> <name> <PREFIX>   (legacy) turnkey-bootstrap a service project — start at \`init\`/\`up\` instead
  run [--background] [--cli claude|codex|opencode] [--agents core,outward]   schedule agents by calling the
                              selected CLI; --background detaches (log → .dev-loop/run.log), \`stop\` ends it
  stop                        cleanly stop this workspace's running scheduler (the hub daemon stays up)
  install-claude-plugin      register a local npm-source marketplace so /plugin install can load it
  mcp-merge <args>            merge dev-loop-hub into a product .mcp.json (never clobbers other servers)
  seed <key> <name> [PREFIX]  (legacy) seed a project into the hub db — \`team add-project\` auto-seeds
  doctor                      health-check the hub system-of-record (DOCTOR_OK)
  identity-check [--expect <actor>[/<project>]]   verify this shell resolves the intended identity
  tickets [--all] [--state S] [--type T] [--owner O] [--label L] [--q TEXT] [--assignee A] [--related-to ID]
          [--updated-since ISO] [--fields summary] [--limit N] [--json]   read-only: list the resolved project's board (no daemon)
  ticket <id> [--json]        read-only: show one ticket — detail + comments
  queue                       the pre-ranked per-agent work list (agent's mandated first board read; same JSON as \`op queue\`)
  op <op-name> [--args-json '<JSON>']   dispatch ANY hub op as the acting agent (raw JSON in/out; stdin ok)
  ticket create|update …      create / update a ticket (labels REPLACE the full set; relatedTo is APPEND-only)
  comment add <id> (--body TEXT | --body-file F | '-')   comment on a ticket (authored as DEVLOOP_ACTOR)
  comments <id>               a ticket's comments as JSON
  labels | label create <name> [--kind K]   list / create labels
  project                     the active project as JSON
  events [--ticket ID] [--actor A] [--since ISO] [--limit N]   attribution events as JSON
  doc list|get|history|diff|save|publish|archive …   the doc family 1:1 (save: --base-version CAS; CONFLICT → exit 3)
  mirror push|poll|status     one-way Linear mirror; poll = comment→needs-pm intake
                              (run \`dev-loop op --help\` for the write layer's full flag surface + exit codes)
  export-desktop-skill <agent> --project <key> [--team] [--out <dir>] [--zip]   render a self-contained Claude Desktop skill
  version | help

Write-layer exit codes: 0 ok · 1 domain error · 2 usage · 3 doc CAS conflict · 4 identity/guard · 5 hub unavailable.
Identity rides DEVLOOP_ACTOR (per pane); project DEVLOOP_PROJECT (or the cwd); db DEVLOOP_HUB_DB.
Docs: https://github.com/dyzsasd/dev-loop  (docs/INDEX.md, docs/RUNNING.md, docs/PORTABILITY.md, docs/DAEMON.md)`);
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }
if (cmd === "version" || cmd === "--version" || cmd === "-v") { console.log(version()); process.exit(0); }

// `ticket create|update` are the WRITE sugar verbs (cli-agentops, A1); every other `ticket …` stays the
// DL-90 read-only detail view (cli-tickets). Decided HERE so the two entries keep single responsibilities.
const route = cmd === "ticket" && (rest[0] === "create" || rest[0] === "update")
  ? (["cli-agentops", "ticket"] as [string, ...string[]])
  : ROUTES[cmd];
if (!route) { console.error(`dev-loop: unknown command '${cmd}'\n`); usage(); process.exit(2); }

// ── ATTACH gate (one-click §6.0, fail-closed ALLOWLIST) ────────────────────────────────────────────
// With DEVLOOP_HUB_URL set the home is REMOTE: only the OP surface travels (board/doc reads+writes,
// attributed over the token-authed op-API). Everything that touches the home's filesystem, db file,
// scheduler, or daemon lifecycle refuses with the home pointer — a home-side verb silently running
// against local state while the operator THINKS they're driving the remote is the failure mode this
// gate exists to prevent.
if (process.env.DEVLOOP_HUB_URL?.trim()) {
  const ATTACH_OK = new Set(["tickets", "ticket", "op", "queue", "comment", "comments", "labels", "label", "project", "events", "doc", "up", "attach", "version", "help"]);
  if (!ATTACH_OK.has(cmd)) {
    console.error(`dev-loop ${cmd}: this verb runs at the WORKSPACE HOME, not over attach (DEVLOOP_HUB_URL is set). Run it on the home host (ssh / redeploy a bundle), or unset DEVLOOP_HUB_URL to work locally.`);
    process.exit(2);
  }
}

const NEEDS_NODE_SQLITE = new Set(["serve", "shim", "daemon", "doctor", "seed", "run", "init", "init-service", "identity-check", "tickets", "ticket", "team", "next-project", "hub", "metrics", "push-guard", "up", "bundle",
  "op", "queue", "comment", "comments", "labels", "label", "project", "events", "doc", "mirror",
  "worktree", "merge-guard", "pr", "doc-land", "push", "settings",
  "approve", "revoke", "approvals", "request"]); // worktree reap queries hub.db; merge-guard §3.3 board-state axis reads tickets table (so `pr merge`, which runs it, needs it too); doc-land calls pushGuard; settings reads/writes the projects row; the approvals verbs read/write the approvals table
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
// EVERY entry is spawned through this one line, which makes it the single install site for the CLI's
// presentation contract — the runtime's own ExperimentalWarning noise (LOOP-44) and the one-line
// framing of a missing/broken workspace (LOOP-283 AC3), both in cli-bootstrap.ts. DEVLOOP_CLI_VERB
// lets that framing name the verb the operator actually typed.
const bootstrap = pathToFileURL(join(here, "cli-bootstrap" + EXT)).href;
const r = spawnSync(process.execPath, ["--import", bootstrap, join(here, entryBase + EXT), ...prefix, ...rest],
  { stdio: "inherit", env: { ...process.env, DEVLOOP_CLI_VERB: cmd } });
process.exit(r.status ?? 1);
