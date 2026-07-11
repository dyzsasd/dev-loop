#!/usr/bin/env node
// `dev-loop init` — the guided onboarding wizard (2026-07 review, init P1). It COMPOSES the existing
// validated mutators — teamInit / addProject / addRepo / provisionClaudePermissions / runDoctor — and
// never reimplements them, so everything it writes went through the same validation the manual path uses.
//
// Shape (D8 CLI-first): interactive on a TTY with a handful of questions where Enter accepts every
// default; `--yes` (or piping) takes the zero-config path end-to-end on the service backend. Resumable:
// an existing dev-loop.json flips to RESUME mode — nothing is re-initialized, doctor prints the verdict
// + its NEXT line, and (interactively) the wizard offers whatever first project/repo is still missing.
// DEVLOOP_INIT_INTERACTIVE=1 forces the interactive branch without a TTY (the test harness drives the
// prompts over a pipe; a real terminal never needs it).
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline/promises";
import { teamInit, provisionClaudePermissions } from "./team-init.ts";
import { addProject, addRepo } from "./team-edit.ts";
import { runDoctor } from "./doctor.ts";
import { hubDbPath } from "./paths.ts";
import { tryResolveWorkspace } from "./workspace.ts";
import { deliveryProjects, RESERVED_NAMES, TEAM_INTAKE_PROJECT, type Workspace } from "./team-config.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop init: ${msg}`); process.exit(code); }

function usage(): void {
  console.log(`dev-loop init — guided onboarding: workspace + first project/repo, doctor-verified

Usage:
  dev-loop init [--dir <path>] [--key <team-key>] [--backend service|linear] [--linear-team <Name>] [--yes]

Interactive on a TTY (Enter accepts every default). Composes the validated mutators —
\`team init\`, \`team add-project\` (hub row auto-seeded on service), \`team add-repo --detect\` —
and finishes with the doctor verdict + its NEXT line.

  --dir <path>          workspace directory (default: cwd; created if missing)
  --key <k>             team key (default: derived from the directory name)
  --backend <b>         service (default — zero-config local hub + web board) or linear
  --linear-team <Name>  the Linear team (linear backend; omit to fill later via team set)
  --yes                 non-interactive: accept every default (end-to-end on service; on
                        linear the team name is deferred via the E09 warning path)

Re-running on an existing workspace RESUMES: nothing is re-initialized; doctor prints the
verdict + NEXT, and (interactively) the wizard offers the missing first project/repo.`);
}

interface Opts { dir?: string; key?: string; backend?: string; linearTeam?: string; yes: boolean }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--dir") o.dir = next();
    else if (a === "--key") o.key = next();
    else if (a === "--backend") o.backend = next();
    else if (a === "--linear-team") o.linearTeam = next();
    else if (a === "--yes") o.yes = true;
    else die(`unknown option '${a}'`);
  }
  return o;
}

// Derive a config key from a directory basename: lowercased runs of [a-z0-9] joined by '-', which
// satisfies BOTH key grammars (team: ^[a-z0-9-]{2,32}$; project/repo: no leading _/-/.). The E11
// reserved names (.dev-loop/ layout) fall back — a repo dir named "wt" must not become a project key.
function keyFrom(name: string, fallback: string): string {
  const k = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return k.length >= 2 && !RESERVED_NAMES.has(k) && k !== TEAM_INTAKE_PROJECT ? k : fallback;
}

const TEAM_KEY_RE = /^[a-z0-9-]{2,32}$/; // mirrors team-config.ts (not exported there; the E02 tripwire)

export async function initWizard(argv = process.argv.slice(2)): Promise<number> {
  const o = parseArgs(argv);
  // Interactive ⇔ a real TTY on both ends and no --yes; DEVLOOP_INIT_INTERACTIVE=1 forces it for tests.
  const interactive = !o.yes && ((process.stdin.isTTY === true && process.stdout.isTTY === true) || process.env.DEVLOOP_INIT_INTERACTIVE === "1");
  const rl: Interface | null = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  // Interactive plumbing: a persistent line queue instead of rl.question(). With a piped stdin the
  // whole input arrives in one chunk and readline emits every buffered line IMMEDIATELY — a bare
  // question() would silently drop the lines that land between two prompts (only the line arriving
  // while a question is registered is captured). A closed stdin (^D / an exhausted pipe) accepts
  // every remaining default and never hangs a pending question.
  let rlClosed = false;
  const pending: string[] = [];
  const waiters: Array<(l: string | null) => void> = [];
  if (rl) {
    rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else pending.push(l); });
    rl.on("close", () => { rlClosed = true; while (waiters.length) waiters.shift()!(null); });
  }
  const prompt = async (text: string): Promise<string> => {
    if (!rl) return "";
    if (!rlClosed) { rl.setPrompt(text); rl.prompt(); }
    else if (!pending.length) return ""; // stdin already ended and nothing was typed ahead → default
    const line = pending.length ? pending.shift()! : await new Promise<string | null>((res) => { rlClosed ? res(null) : waiters.push(res); });
    return (line ?? "").trim();
  };
  const ask = async (label: string, def: string): Promise<string> => (await prompt(def ? `${label} [${def}]: ` : `${label}: `)) || def;
  const confirm = async (label: string, def: boolean): Promise<boolean> => {
    const a = (await prompt(`${label} [${def ? "Y/n" : "y/N"}] `)).toLowerCase();
    return a ? a === "y" || a === "yes" : def;
  };

  try {
    // ── (b) the minimal question set — everything else is defaulted and tunable later ──────────────
    let dir = resolve(o.dir ?? process.cwd());
    if (rl && !o.dir) dir = resolve(await ask("Workspace directory", dir));

    // ── (a) state detection: an existing dev-loop.json flips to RESUME mode ────────────────────────
    const filePath = join(dir, "dev-loop.json");
    const resumed = existsSync(filePath);
    if (resumed) {
      console.log(`dev-loop.json already exists at ${filePath} — resume mode (nothing re-initialized; \`dev-loop team init --force\` replaces a config).`);
      provisionClaudePermissions(dir); // (e) idempotent repair: a pre-D8 workspace gains the CLI allow rule here
    } else {
      if (!rl && !o.yes) die("stdin is not a TTY and --yes was not passed — rerun `dev-loop init --yes` to accept every default (service backend, dry-run mode)");
      let key = o.key ?? (await ask("Team key", keyFrom(basename(dir), "team")));
      while (rl && !TEAM_KEY_RE.test(key)) key = await ask("Team key must be 2-32 chars of [a-z0-9-]", keyFrom(basename(dir), "team"));
      let backend = (o.backend ?? (await ask("Backend — service (zero-config local hub + web board) or linear", "service"))).trim().toLowerCase();
      while (rl && backend !== "service" && backend !== "linear") backend = (await ask("Backend must be 'service' or 'linear'", "service")).trim().toLowerCase();
      if (backend !== "service" && backend !== "linear") die(`--backend must be service or linear (got '${backend}')`);
      let linearTeam = (o.linearTeam ?? "").trim();
      if (backend === "linear" && !linearTeam)
        linearTeam = (await ask("Linear team name (Enter to defer — fires stay blocked until `dev-loop team set team.linearTeam` fills it)", "")).trim();

      // ── (c) compose `team init` — validates, scaffolds .dev-loop/, seeds the service hub (_team row),
      // and provisions the Claude permissions entry (D8/(e)). Its remaining defaults are the wizard's:
      // deploy prod=manual · reports files · autonomy guarded · mode dry-run.
      const initArgs = ["--dir", dir, "--key", key, "--backend", backend, "--yes"];
      if (linearTeam) initArgs.push("--linear-team", linearTeam);
      teamInit(initArgs, { next: false }); // exits non-zero itself on a validation failure (wizard is resumable)
      console.log("Defaults applied: mode=dry-run · autonomy=guarded · deploy prod=manual · reports=files");
      console.log("  (flip live later: dev-loop team set team.mode live — the settable whitelist is in references/config-schema.md; edit dev-loop.json + `dev-loop doctor` for the rest)");
    }

    // Pin every composed mutator + the doctor run below to THIS workspace, regardless of the launch cwd
    // — and drop any leaked shell identity. DEVLOOP_TEAM is merely outranked, but a junk DEVLOOP_HUB_DB
    // reaches hubDbPath() in the epilogue, where the pathEnv 'undefined' tripwire would crash the wizard
    // AFTER it wrote everything (Codex review 2026-07-11). The wizard owns its whole env contract.
    process.env.DEVLOOP_WORKSPACE = dir;
    delete process.env.DEVLOOP_TEAM;
    delete process.env.DEVLOOP_HUB_DB;

    // ── (d) first project + repo — offered, skippable, composed from the validated mutators ────────
    let ws: Workspace | null = null;
    try { ws = tryResolveWorkspace(); } catch { /* invalid config → the doctor epilogue prints the E-codes + NEXT */ }
    if (ws) {
      const isService = ws.file.team.backend === "service";
      let projectKey: string | null = deliveryProjects(ws)[0] ?? null;
      if (!projectKey) {
        // Non-interactive policy: --yes creates the default project only on a FRESH service init (the
        // end-to-end zero-config promise); a resume never mutates silently, and linear onboarding runs
        // through /dev-loop:add-project (backend find-or-create) rather than a placeholder entry.
        const wanted = rl
          ? await confirm(isService ? "Create your first project now (hub board row auto-seeded)?" : "Register your first project in the config now (Linear sync runs later via /dev-loop:add-project or /dev-loop:sync-project)?", true)
          : o.yes && !resumed && isService;
        if (wanted) {
          const key = await ask("Project key", keyFrom(basename(dir), "app"));
          await addProject([key]); // validated write; auto-seeds the hub row on service (exits itself on failure)
          projectKey = key;
        }
      }
      if (projectKey && rl) {
        const rel = await ask(`Path to the first repo for '${projectKey}', relative to the workspace (Enter to skip)`, "");
        if (rel) {
          const ref = keyFrom(basename(rel), "repo");
          let remote = "";
          if (!existsSync(join(dir, rel))) remote = (await ask(`${rel} does not exist yet — git remote URL to clone from (Enter to skip the repo)`, "")).trim();
          if (existsSync(join(dir, rel)) || remote)
            addRepo([ref, "--project", projectKey, "--path", rel, "--detect", ...(remote ? ["--remote", remote] : [])]);
          else console.log(`skipped the repo — later: dev-loop team add-repo <ref> --project ${projectKey} --path <rel> --detect  (or /dev-loop:add-repo)`);
        }
      }
    }

    rl?.close();
    return await epilogue(dir);
  } finally { rl?.close(); }
}

// ── (f) epilogue: doctor verdict + NEXT line, then the backend-specific launch card ─────────────────
// The plugin/MCP setup is a REQUIRED step only for a linear backend (onboarding + steward fires run
// through Claude Code there); on service+claude the agents talk to the board through the dev-loop CLI
// directly (D8), so the plugin is a one-line optional note.
async function epilogue(dir: string): Promise<number> {
  console.log("");
  const ok = await runDoctor(hubDbPath(), { reconcile: true }); // prints the full verdict + the NEXT line
  let ws: Workspace | null = null;
  try { ws = tryResolveWorkspace(); } catch { /* invalid config: doctor's NEXT already says what to fix */ }
  if (!ws) return ok ? 0 : 1;
  console.log("");
  if (ws.file.team.backend === "linear") {
    console.log("── next steps (linear backend) ─────────────────────────────");
    if (!(ws.file.team.linearTeam ?? "").trim())
      console.log(`  fill the team:  dev-loop team set team.linearTeam "<Team Name>"   (fires refuse to launch until set)`);
    console.log("  Linear MCP:     configure the Linear MCP in Claude Code USER scope (steward fires run at the workspace root; doctor warns W05 without it)");
    console.log("  plugin:         dev-loop install-claude-plugin — then run the two printed /plugin commands inside Claude Code");
    console.log("  onboard:        /dev-loop:add-project then /dev-loop:add-repo in Claude Code (find-or-create the Linear project, labels, strategy doc)");
    console.log("  preview + run:  dev-loop run --once --dry-run   →   dev-loop run");
  } else {
    console.log("── next steps ──────────────────────────────────────────────");
    console.log(`  web board:      dev-loop hub start   → ${boardUrl(dir)}`);
    console.log("  preview:        dev-loop run --once --dry-run   (every agent's exact command; launches nothing)");
    console.log("  run the team:   dev-loop run   (^C stops everything; team.mode stays dry-run until: dev-loop team set team.mode live)");
    console.log("  optional:       dev-loop install-claude-plugin   (Claude Code /dev-loop:* slash commands — agents already reach the board through the dev-loop CLI)");
  }
  return ok ? 0 : 1;
}

// The board URL: exact when the workspace hub daemon is already up (its lifecycle runfile records it),
// else the fixed default port the lifecycle starts from (`hub start` prints the final URL either way).
function boardUrl(dir: string): string {
  try {
    const u = (JSON.parse(readFileSync(join(dir, ".dev-loop", `daemon-${TEAM_INTAKE_PROJECT}.json`), "utf8")) as { url?: string }).url;
    if (u) return `${u} (already running)`;
  } catch { /* not running */ }
  return "http://127.0.0.1:8787 (default port; `hub start` prints the exact URL)";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await initWizard());
}
