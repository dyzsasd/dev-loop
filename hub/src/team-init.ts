#!/usr/bin/env node
// `dev-loop team init` — create a workspace. PURE CLI: no LLM, no backend calls (§9.1). Every input is
// an operator-known fact; the output is deterministic scaffolding (dev-loop.json + .dev-loop/ tree, and
// for a service backend the hub.db + seeded _team intake project). Backend writes (verify Linear team,
// labels, create projects) are deferred to the first `/dev-loop:add-project`, which runs in a coding CLI.
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateTeamFile, TEAM_INTAKE_PROJECT, type TeamFile, type Workspace } from "./team-config.ts";
import { ensureStateDirs, upsertWorkspaceIndex, wsHubDb } from "./workspace.ts";
import { openDb } from "./db.ts";
import { ensureSeed } from "./seed.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop team init: ${msg}`); process.exit(code); }

function usage(): void {
  console.log(`dev-loop team init — create a workspace (pure CLI; no backend calls)

Usage:
  dev-loop team init [--dir <path>] --key <team-key> --backend linear|service [options]

Required:
  --key <k>                 team key (^[a-z0-9-]{2,32}$; the state-dir + index key)
  --backend linear|service  the single backend for this team

Options:
  --dir <path>              workspace dir (default: cwd)
  --linear-team <Name>      Linear team name (required for --backend linear)
  --deploy dev=auto,prod=manual   deploy-policy CEILING per env (default: prod=manual)
  --doc-system backend|local      team doc-system default (default: backend)
  --comms lark|slack[:ENV_NAME]   outward channel + its webhook ENV-VAR NAME (default env: DEVLOOP_COMMS_WEBHOOK)
  --reports files|linear|hub      report sink default (default: files)
  --mode live|dry-run             team mode default (default: dry-run for first contact)
  --autonomy full|guarded         team autonomy default (default: guarded)
  --intake-mode autonomous|passive  team intake default (§5a; default: autonomous — passive means
                                  PM originates nothing and only responds to explicit needs-pm intake)
  --yes                     accept defaults for anything not passed (non-interactive)
  --force                   overwrite an existing dev-loop.json (prints the diff first)`);
}

interface Opts {
  dir: string; key?: string; backend?: string; linearTeam?: string;
  deploy?: string; docSystem?: string; comms?: string; reports?: string;
  mode?: string; autonomy?: string; intakeMode?: string; yes: boolean; force: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { dir: process.cwd(), yes: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--dir") o.dir = resolve(next());
    else if (a === "--key") o.key = next();
    else if (a === "--backend") o.backend = next();
    else if (a === "--linear-team") o.linearTeam = next();
    else if (a === "--deploy") o.deploy = next();
    else if (a === "--doc-system") o.docSystem = next();
    else if (a === "--comms") o.comms = next();
    else if (a === "--reports") o.reports = next();
    else if (a === "--mode") o.mode = next();
    else if (a === "--autonomy") o.autonomy = next();
    else if (a === "--intake-mode") o.intakeMode = next();
    else if (a === "--yes") o.yes = true;
    else if (a === "--force") o.force = true;
    else die(`unknown option '${a}'`);
  }
  return o;
}

function parseDeploy(s: string | undefined): Record<string, "auto" | "manual"> {
  const policy: Record<string, "auto" | "manual"> = { prod: "manual" };
  if (!s) return policy;
  for (const pair of s.split(",")) {
    const [env, level] = pair.split("=").map((x) => x.trim());
    if (!env || (level !== "auto" && level !== "manual")) die(`--deploy expects env=auto|manual pairs (got '${pair}')`);
    policy[env] = level;
  }
  return policy;
}

function parseComms(s: string | undefined): { provider: "slack" | "lark"; webhookEnv: string } | undefined {
  if (!s) return undefined;
  const [provider, env] = s.split(":");
  if (provider !== "slack" && provider !== "lark") die(`--comms provider must be slack or lark (got '${provider}')`);
  return { provider, webhookEnv: env?.trim() || "DEVLOOP_COMMS_WEBHOOK" };
}

// opts.next: the trailing "Next: …" guidance block — the init wizard (init-wizard.ts) composes this
// function and prints its own, richer epilogue (doctor verdict + NEXT line), so it passes next:false.
export function teamInit(argv = process.argv.slice(2), opts: { next?: boolean } = {}): number {
  const o = parseArgs(argv);
  if (!o.key) die("--key <team-key> is required");
  if (o.backend !== "linear" && o.backend !== "service") die("--backend must be linear or service");
  if (o.backend === "linear" && !o.linearTeam && !o.yes) die("--linear-team <Name> is required for a linear backend (or pass --yes to leave it blank and fill it at add-project)");

  mkdirSync(o.dir, { recursive: true }); // the workspace dir may not exist yet (`team init --dir new/path`)
  const filePath = join(o.dir, "dev-loop.json");
  if (existsSync(filePath) && !o.force) {
    console.log(`dev-loop.json already exists: ${filePath}`);
    console.log("Edit it directly, or rerun with --force to replace it. (init is idempotent.)");
    provisionClaudePermissions(o.dir); // idempotent repair path: pre-D8 workspaces gain the allow rule on re-init
    return 0;
  }

  // Workspace fingerprint (concept P4): random once, STABLE forever — a --force rewrite keeps the id the
  // previous file carried, so re-init never orphans the markers already stamped onto Linear projects.
  let workspaceId: string = randomUUID();
  if (existsSync(filePath)) {
    try {
      const prev = (JSON.parse(readFileSync(filePath, "utf8")) as { workspaceId?: unknown }).workspaceId;
      if (typeof prev === "string" && prev.trim()) workspaceId = prev;
    } catch { /* unreadable previous file → mint fresh */ }
  }

  const team: TeamFile["team"] = {
    key: o.key,
    backend: o.backend,
    ...(o.backend === "linear" ? { linearTeam: o.linearTeam ?? "", linearTeamId: null } : {}),
    deployPolicy: parseDeploy(o.deploy),
    docSystem: (o.docSystem as "backend" | "local") ?? "backend",
    docs: { vision: null, lessons: { mirror: false } },
    autonomy: o.autonomy ?? "guarded",
    mode: o.mode ?? "dry-run",
    ...(o.intakeMode ? { intake: { mode: o.intakeMode as "autonomous" | "passive" } } : {}), // E12 validates the value below

    ...(parseComms(o.comms) ? { comms: parseComms(o.comms) } : {}),
    reports: { sink: o.reports ?? "files" },
    agents: { sweep: { cadence: "30m" }, ops: { cadence: "10m" }, reflect: { cadence: "1d" }, communication: { cadence: "1d" } },
  };
  const file: TeamFile = { schemaVersion: 2, workspaceId, team, repos: {}, projects: {} };

  // Validate before writing — init must never emit a file that doctor would reject (an empty repos/projects
  // map is valid; a blank linearTeam under --yes is only the E09 WARNING, filled via `team set`/add-project).
  const { errors } = validateTeamFile(file);
  if (errors.length) die("refusing to write an invalid config:\n" + errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"), 1);

  if (existsSync(filePath) && o.force) {
    console.log("--force: replacing existing dev-loop.json. Previous content:");
    try { console.log(readFileSync(filePath, "utf8").split("\n").map((l) => "  | " + l).join("\n")); } catch { /* unreadable */ }
  }

  writeFileSync(filePath, JSON.stringify(file, null, 2) + "\n");
  const ws: Workspace = { root: o.dir, filePath, file, warnings: [] };
  ensureStateDirs(ws);
  upsertWorkspaceIndex(o.key, o.dir);
  console.log(`wrote ${filePath}`);
  console.log(`scaffolded ${join(o.dir, ".dev-loop")}/ {team, lessons, wt, locks}`);
  provisionClaudePermissions(o.dir);

  if (o.backend === "service") {
    seedServiceHub(ws);
    console.log(`initialized hub.db + seeded '${TEAM_INTAKE_PROJECT}' intake project (prefix TEAM)`);
  }

  if (o.backend === "linear" && !(team.linearTeam ?? "").trim())
    console.log(`NOTE: team.linearTeam is blank — the workspace loads, but fires refuse to launch until you fill it: dev-loop team set team.linearTeam "<Team Name>"`);

  if (opts.next !== false) {
    console.log("");
    console.log("Next: in a coding CLI (claude/codex), run  /dev-loop:add-project  to create your first project,");
    console.log("then  /dev-loop:add-repo  to clone + register a repo. `dev-loop doctor` checks the workspace.");
  }
  return 0;
}

// Only called for a service backend, so the linear path never touches sqlite / the hub schema.
function seedServiceHub(ws: Workspace): void {
  const db = openDb(wsHubDb(ws));
  try { ensureSeed(db, TEAM_INTAKE_PROJECT, "Team Intake", "TEAM"); } finally { db.close(); }
}

// ── D8: workspace Claude-settings permission for the CLI interface ───────────────────────────────
// Agents on interface="cli" call `dev-loop …` from inside a Claude Code fire, so `team init` (and
// `team add-project`, idempotently) provision the workspace-level allow rule once. CREATE-OR-MERGE,
// never clobber: every unknown key/entry in .claude/settings.json is preserved; a malformed or
// unexpected-shape file is left untouched with a note (the operator adds the rule by hand).
export const DEVLOOP_PERMISSION = "Bash(dev-loop *)";
export function provisionClaudePermissions(root: string): void {
  const file = join(root, ".claude", "settings.json");
  const manual = (why: string) =>
    console.log(`NOTE: ${file} ${why} — left untouched; add ${JSON.stringify(DEVLOOP_PERMISSION)} to permissions.allow yourself`);
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); }
    catch { manual("is not valid JSON"); return; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) { manual("is not a JSON object"); return; }
    settings = parsed as Record<string, unknown>;
  }
  const rawPerm = settings.permissions;
  if (rawPerm !== undefined && (rawPerm === null || typeof rawPerm !== "object" || Array.isArray(rawPerm))) { manual("has a non-object `permissions` key"); return; }
  const permissions = (rawPerm ?? {}) as Record<string, unknown>;
  const rawAllow = permissions.allow;
  if (rawAllow !== undefined && !Array.isArray(rawAllow)) { manual("has a non-array `permissions.allow`"); return; }
  const allow = (rawAllow ?? []) as unknown[];
  if (allow.includes(DEVLOOP_PERMISSION)) { console.log(`${file} already allows ${DEVLOOP_PERMISSION} (unchanged)`); return; }
  permissions.allow = [...allow, DEVLOOP_PERMISSION];
  settings.permissions = permissions;
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`provisioned ${file}: permissions.allow += ${JSON.stringify(DEVLOOP_PERMISSION)} (agents call the dev-loop CLI, D8)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(teamInit());
}
