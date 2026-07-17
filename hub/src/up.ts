#!/usr/bin/env node
// `dev-loop up` — the one-click entry (docs/design/one-click-deployment.md §2). THREE legs, one verb:
//   LOCAL (default)   minimal bootstrap → exec an INTERACTIVE coding-agent chat primed as the operator
//                     console. The human never types a shell command — the chat does setup via the
//                     validated `dev-loop` verbs (the workspace-root CLAUDE.md/AGENTS.md brief).
//   MOVE (--bundle)   headless load of a locally-authored encrypted bundle → chain into `dev-loop run`.
//   ATTACH (--attach) the same local console, pointed at a REMOTE hub over the token-authed op-API.
// `up` deliberately re-implements NOTHING: scaffold = team init, board = hub ensure, config = the
// mutators, loop = run. Its own job is env + priming + the ONE net-new piece, the interactive spawn —
// a sibling of the headless renderers (stdio:"inherit" vs their ["ignore","pipe","pipe"]), never a
// branch inside commandFor()/runAgent().
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tryResolveWorkspace, wsHubDb, wsStateRoot } from "./workspace.ts";
import type { Workspace } from "./team-config.ts";
import { teamInit } from "./team-init.ts";
import { scaffoldOperatorBriefs } from "./operator-brief.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop up: ${msg}`); process.exit(code); }

const srcDir = resolve(fileURLToPath(import.meta.url), "..");

// The plugin payload root (skills/ + references/) — export-desktop-skill's resolution, shared shape.
function pluginRoot(): string {
  for (const c of [process.env.DEVLOOP_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT, resolve(srcDir, ".."), resolve(srcDir, "..", "..")]) {
    if (c && existsSync(join(c, "skills")) && existsSync(join(c, "references"))) return c;
  }
  return resolve(srcDir, "..", ".."); // best-effort — the brief works plugin-less anyway
}

interface UpOpts {
  dir: string; cli?: "claude" | "opencode"; model?: string; effort?: string;
  key?: string; backend: "service" | "linear"; noDaemon: boolean; dryLaunch: boolean;
  bundle?: string; attach?: string; forceReseed: boolean;
}

export function parseUpArgs(argv: string[]): UpOpts {
  const o: UpOpts = { dir: process.cwd(), backend: "service", noDaemon: false, dryLaunch: false, forceReseed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--dir") o.dir = resolve(next());
    else if (a === "--cli") { const v = next(); if (v !== "claude" && v !== "opencode") die("--cli must be claude or opencode (the interactive console targets)"); o.cli = v; }
    else if (a === "--model") o.model = next();
    else if (a === "--effort") o.effort = next();
    else if (a === "--key") o.key = next();
    else if (a === "--backend") { const v = next(); if (v !== "service" && v !== "linear") die("--backend must be service or linear"); o.backend = v; }
    else if (a === "--no-daemon") o.noDaemon = true;
    else if (a === "--dry-launch") o.dryLaunch = true;
    else if (a === "--bundle") o.bundle = resolve(next());
    else if (a === "--attach") o.attach = next();
    else if (a === "--force-reseed") o.forceReseed = true;
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else die(`unknown option '${a}'`);
  }
  return o;
}

function usage(): void {
  console.log(`dev-loop up — one-click: land in the operator console (local), load a bundle (remote), or attach

Usage:
  dev-loop up [--dir <d>] [--cli claude|opencode] [--model M] [--effort E]     local interactive console
              [--key <team-key>] [--backend service|linear] [--no-daemon]
  dev-loop up --bundle <file.tar.age> [--dir <d>] [--force-reseed]             headless bundle load → run
  dev-loop up --attach <hub-url> [--cli …]                                     local console → REMOTE hub

Local: scaffolds a workspace when none exists (team init --yes; key from --key or the dir name),
starts the board daemon (service backend), then EXECS an interactive coding-agent session primed as
the operator console (CLAUDE.md/AGENTS.md at the workspace root; you do setup by talking).
  --dry-launch   print the resolved launch (command/args/env) as JSON instead of spawning — the test
                 and inspection surface.
Attach: same console, but every dev-loop verb targets the remote hub (DEVLOOP_HUB_URL + the §6.2
bearer from DEVLOOP_UI_TOKEN(_FILE)). Home-only verbs (run/daemon/seed/team file writes) refuse there.
Bundle: see \`dev-loop bundle --help\` for authoring the encrypted move/backup artifact.`);
}

// Derive a valid team key (^[a-z0-9-]{2,32}$) from a directory name.
export function deriveTeamKey(dir: string): string {
  const raw = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return /^[a-z0-9-]{2,32}$/.test(raw) ? raw : "team";
}

// Pre-seed Claude Code's folder-trust for the workspace (verified structure: ~/.claude.json →
// projects.<abs>.hasTrustDialogAccepted). MERGE-only on an existing, parseable file — if claude has
// never run, we do NOT invent its config; the preflight message covers the onboarding case instead.
export function preseedClaudeTrust(root: string, claudeJsonPath = join(homedir(), ".claude.json")): "seeded" | "already" | "absent" | "unparseable" {
  if (!existsSync(claudeJsonPath)) return "absent";
  let cfg: Record<string, unknown>;
  try { cfg = JSON.parse(readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>; } catch { return "unparseable"; }
  if (typeof cfg !== "object" || cfg === null) return "unparseable";
  const projects = (cfg.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (projects[root]?.hasTrustDialogAccepted === true) return "already";
  projects[root] = { ...(projects[root] ?? {}), hasTrustDialogAccepted: true };
  cfg.projects = projects;
  writeFileSync(claudeJsonPath, JSON.stringify(cfg, null, 2));
  return "seeded";
}

// The net-new child-process contract (§2.2): interactive TUIs, verified flags only.
//   claude:   bare TUI; --model/--effort/--append-system-prompt confirmed on the interactive session.
//   opencode: bare TUI; -m/--model confirmed. Effort is NOT passable on the TUI (only `run --variant`)
//             — it rides team.codingAgentDefaults via the workspace opencode.json instead.
export function interactiveCommandFor(cli: "claude" | "opencode", profile: { model?: string; effort?: string }, brief: string): { command: string; args: string[] } {
  if (cli === "claude") {
    return {
      command: process.env.DEVLOOP_CLAUDE_BIN || "claude",
      args: [
        ...(profile.model ? ["--model", profile.model] : []),
        ...(profile.effort ? ["--effort", profile.effort] : []),
        "--append-system-prompt", brief,
      ],
    };
  }
  return {
    command: process.env.DEVLOOP_OPENCODE_BIN || "opencode",
    args: [...(profile.model ? ["--model", profile.model] : [])],
  };
}

const CONSOLE_BRIEF =
  "You are the dev-loop OPERATOR CONSOLE (DEVLOOP_ACTOR=operator). Read and follow the workspace-root " +
  "CLAUDE.md; the full guide is /dev-loop:operator-console when the dev-loop plugin is installed. All " +
  "setup and board actions go through `dev-loop` CLI verbs — never hand-edit dev-loop.json, and never " +
  "accept a secret value in chat: run `dev-loop secret set <NAME>` so the human types it on the TTY.";

export async function upCli(argv = process.argv.slice(2)): Promise<number> {
  const o = parseUpArgs(argv);

  // ── MOVE: headless bundle load (design §4.5) ──────────────────────────────
  if (o.bundle) {
    const { bundleLoad } = await import("./bundle.ts");
    return bundleLoad(o.bundle, o.dir, { forceReseed: o.forceReseed, noRun: o.dryLaunch }); // --dry-launch on this leg = load, verify, don't start the loop
  }

  // Mixed-state guard (review finding): a bare `up` under an exported DEVLOOP_HUB_URL would scaffold
  // and ensure LOCALLY while every verb the console then runs hits the REMOTE — two half-homes. Be
  // explicit or be refused.
  if (!o.attach && !o.bundle && process.env.DEVLOOP_HUB_URL?.trim())
    die(`DEVLOOP_HUB_URL is set (${process.env.DEVLOOP_HUB_URL.trim()}) — run \`dev-loop up --attach <url>\` to drive that remote home, or unset DEVLOOP_HUB_URL to work locally`);

  // ── LOCAL / ATTACH: resolve-or-scaffold, then the interactive console ─────
  let ws: Workspace | null = null;
  if (o.attach) {
    // Attach needs no local hub/scaffold — the home is remote. A local workspace is OPTIONAL context.
    try { const u = new URL(o.attach); if (u.protocol !== "http:" && u.protocol !== "https:") die("--attach must be an http(s) URL"); }
    catch { die(`--attach: '${o.attach}' is not a valid URL`); }
    ws = tryResolveWorkspace(o.dir);
  } else {
    ws = tryResolveWorkspace(o.dir);
    if (!ws) {
      const key = o.key ?? deriveTeamKey(o.dir);
      console.log(`no workspace at ${o.dir} — scaffolding one (team '${key}', backend ${o.backend})`);
      const code = teamInit(["--dir", o.dir, "--key", key, "--backend", o.backend, ...(o.backend === "linear" ? ["--linear-team", ""] : []), "--yes"], { next: false });
      if (code !== 0) die(`team init failed (exit ${code})`, 1);
      ws = tryResolveWorkspace(o.dir) ?? die("scaffold succeeded but the workspace does not resolve — run `dev-loop doctor`", 1);
    }
    scaffoldOperatorBriefs(ws.root); // idempotent create-only (older workspaces gain the briefs here)
  }

  // Launch profile: --cli > team.defaultCodingAgent > DEVLOOP_RUNNER_CLI > claude (§2.4).
  const teamDefault = ws?.file.team.defaultCodingAgent;
  const envDefault = process.env.DEVLOOP_RUNNER_CLI;
  const cli: "claude" | "opencode" =
    o.cli
    ?? (teamDefault === "claude" || teamDefault === "opencode" ? teamDefault : undefined)
    ?? (envDefault === "claude" || envDefault === "opencode" ? envDefault : undefined)
    ?? "claude";
  const caDefaults = (ws?.file.team.codingAgentDefaults ?? {})[cli] ?? {};
  const profile = { model: o.model ?? caDefaults.model, effort: o.effort ?? caDefaults.effort };

  // Board daemon (service backend, local only): idempotent, health-gated — the ticket UI is live
  // before the chat opens. Best-effort like run's ensure; --no-daemon skips (tests/CI).
  if (ws && !o.attach && !o.noDaemon && ws.file.team.backend === "service") {
    try { const { ensureHub } = await import("./hub.ts"); const c = await ensureHub(ws); if (c !== 0) console.warn(`dev-loop up: hub ensure returned ${c} (continuing — board may be down; \`dev-loop hub status\`)`); }
    catch (e) { console.warn(`dev-loop up: hub ensure failed (${(e as Error).message}); continuing`); }
  }

  // Claude trust pre-seed (§2.2a): resolves the trust-folder prompt so the first launch lands in a chat.
  if (cli === "claude" && ws) {
    const seeded = preseedClaudeTrust(ws.root);
    if (seeded === "absent") console.log("note: ~/.claude.json not found — claude's first run may show onboarding/login before the chat.");
    else if (seeded === "unparseable") console.log("note: ~/.claude.json unreadable — skipping the trust pre-seed.");
  }

  // The operator env block (§2.3): identity + workspace levers; NEVER the fire markers (an operator
  // write refuses under them, exit 4 — the trap the design calls out).
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DEVLOOP_TEAM_SCOPE;
  delete env.DEVLOOP_DEV_SPLIT;
  const envAdded: Record<string, string> = { DEVLOOP_ACTOR: "operator" };
  if (ws) {
    envAdded.DEVLOOP_WORKSPACE = ws.root;
    envAdded.DEVLOOP_HUB_DB = wsHubDb(ws);
    envAdded.DEVLOOP_DATA_DIR = wsStateRoot(ws);
  }
  const proot = pluginRoot();
  envAdded.DEVLOOP_PLUGIN_ROOT = proot;
  envAdded.CLAUDE_PLUGIN_ROOT = proot;
  if (o.attach) envAdded.DEVLOOP_HUB_URL = o.attach; // §6.0: every dev-loop verb in the session targets the remote hub
  Object.assign(env, envAdded);

  const { command, args } = interactiveCommandFor(cli, profile, CONSOLE_BRIEF);
  const cwd = ws?.root ?? o.dir;

  if (o.dryLaunch) {
    console.log(JSON.stringify({ command, args, cwd, envAdded, envRemoved: ["DEVLOOP_TEAM_SCOPE", "DEVLOOP_DEV_SPLIT"], cli, attach: o.attach ?? null }, null, 2));
    return 0;
  }

  if (ws && !o.attach && ws.file.team.backend === "service" && !o.noDaemon)
    console.log(`board: http://127.0.0.1:${process.env.DEVLOOP_DAEMON_PORT ?? 8787}/  (dev-loop hub status)`);
  console.log(`launching the operator console: ${command}${args.length ? " " + args.map((a) => (a.includes(" ") ? `'${a.slice(0, 40)}…'` : a)).join(" ") : ""}`);
  // stdio:"inherit" — a REAL TTY, the one child-process contract no fire uses (§2.2). Blocks until the
  // operator ends the session; the exit code is theirs.
  const r = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (r.error) die(`could not launch ${command}: ${(r.error as Error).message} — is it installed and on PATH?`, 1);
  return r.status ?? 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await upCli());
}
