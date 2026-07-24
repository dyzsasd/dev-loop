#!/usr/bin/env node
// `dev-loop team add-project` / `add-repo` / `set` — the DETERMINISTIC, VALIDATED config mutators the
// operator skills call to persist (design impl §10). The skills (add-project/add-repo, run in a coding
// CLI) do the discovery / interview / backend MCP writes; the actual dev-loop.json edit goes through here
// so a config is NEVER hand-edited into an invalid state — every write re-validates the whole file first.
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspace, wsHubDb } from "./workspace.ts";
import { validateTeamFile, referencingProjects, type TeamFile, type Workspace } from "./team-config.ts";
import { openDb } from "./db.ts";
import { ensureSeed, findProject } from "./seed.ts";
import { provisionClaudePermissions } from "./team-init.ts";
import { syncOpencodeConfig } from "./opencode-sync.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop team: ${msg}`); process.exit(code); }

// Load the workspace, apply a mutation to a deep copy of the file, validate, and write on success.
function mutate(apply: (file: TeamFile, ws: Workspace) => void): Workspace {
  const ws = resolveWorkspace();
  const file: TeamFile = JSON.parse(JSON.stringify(ws.file));
  apply(file, ws);
  const { errors } = validateTeamFile(file);
  if (errors.length) die("the edit would make dev-loop.json invalid:\n" + errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"), 1);
  writeFileSync(ws.filePath, JSON.stringify(file, null, 2) + "\n");
  return { ...ws, file };
}

// ── set ───────────────────────────────────────────────────────────────────────
// `dev-loop team set <path> <value>` — validated single-field updates over a WHITELIST of the
// operator-tunable paths (the fields references/config-schema.md marks `team set` ✓). Everything else
// (registry paths, owners, agent launch maps, …) is either structural — add-project/add-repo territory —
// or an interview field: edit dev-loop.json directly and let doctor validate.
type SetKind = "string" | "boolean" | "number" | "int" | readonly string[];
const SETTABLE: ReadonlyArray<{ re: RegExp; kind: SetKind }> = [
  { re: /^team\.mode$/, kind: ["dry-run", "live"] as const },
  { re: /^team\.linearTeam$/, kind: "string" },
  { re: /^team\.comms\.provider$/, kind: ["slack", "lark"] as const },
  { re: /^team\.comms\.webhookEnv$/, kind: "string" },
  { re: /^team\.intake\.mode$/, kind: ["autonomous", "passive"] as const },
  { re: /^team\.intake\.todoDepthCap$/, kind: "int" },
  { re: /^projects\.[^.]+\.enabled$/, kind: "boolean" },
  { re: /^projects\.[^.]+\.weight$/, kind: "number" },
  { re: /^projects\.[^.]+\.devSplit$/, kind: "boolean" },
  { re: /^projects\.[^.]+\.testEnv\.baseUrl$/, kind: "string" },
  { re: /^projects\.[^.]+\.testEnv\.authConstraint$/, kind: "string" },
  { re: /^projects\.[^.]+\.intake\.mode$/, kind: ["autonomous", "passive"] as const },
  { re: /^projects\.[^.]+\.intake\.todoDepthCap$/, kind: "int" },
  // communication: the communication agent's per-project ARTICLE config (E14 strict keys; NOT the §22a
  // digest gate — that keys on team.comms). First touch of any leaf creates the block via the walk.
  { re: /^projects\.[^.]+\.communication\.(cadence|language|audience|tone|outputDir|repoOutputDir)$/, kind: "string" },
  { re: /^projects\.[^.]+\.communication\.(maxWords|sourceWindowDays)$/, kind: "int" },
  { re: /^projects\.[^.]+\.communication\.output$/, kind: ["data", "repo"] as const },
  { re: /^projects\.[^.]+\.communication\.includeUnreleased$/, kind: "boolean" },
  // notify: the per-project §9 webhook OVERRIDE (E15; team.comms is canonical and bridges into it).
  // Env-var NAMES only — E15 re-validation rejects URL/secret literals on write (§16/I5).
  { re: /^projects\.[^.]+\.notify\.type$/, kind: ["slack", "lark"] as const },
  { re: /^projects\.[^.]+\.notify\.(webhookEnv|secretEnv)$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.style$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.healthCheck$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.auto$/, kind: "boolean" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.deployPrPrefix$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.command$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.healthCheck$/, kind: "string" },
];
const SETTABLE_SUMMARY =
  "team.{mode,linearTeam,comms.provider,comms.webhookEnv,intake.mode,intake.todoDepthCap}, " +
  "projects.<key>.{enabled,weight,devSplit,testEnv.baseUrl,testEnv.authConstraint,intake.mode,intake.todoDepthCap," +
  "communication.{cadence,language,audience,tone,maxWords,sourceWindowDays,output,outputDir,repoOutputDir,includeUnreleased}," +
  "notify.{type,webhookEnv,secretEnv}}, " +
  "repos.<ref>.deploy.{style,healthCheck,environments.<env>.{auto,deployPrPrefix,command,healthCheck}}";

function coerce(kind: SetKind, raw: string, path: string): unknown {
  if (Array.isArray(kind)) { if (!kind.includes(raw)) die(`${path} must be one of ${kind.join("|")} (got '${raw}')`); return raw; }
  if (kind === "boolean") { if (raw !== "true" && raw !== "false") die(`${path} expects true|false (got '${raw}')`); return raw === "true"; }
  if (kind === "number" || kind === "int") {
    const n = Number(raw);
    if (!Number.isFinite(n) || (kind === "int" && !Number.isInteger(n))) die(`${path} expects a${kind === "int" ? "n integer" : " number"} (got '${raw}')`);
    return n;
  }
  if (!raw.trim()) die(`${path} expects a non-empty value`);
  return raw;
}

export async function teamSet(argv: string[]): Promise<number> {
  const [path, value, ...extra] = argv;
  if (!path || path === "--help" || path === "-h" || value === undefined || extra.length)
    die(`usage: dev-loop team set <path> <value>\n  settable paths: ${SETTABLE_SUMMARY}`);
  const entry = SETTABLE.find((s) => s.re.test(path));
  if (!entry)
    die(`'${path}' is not an operator-settable path.\n  settable: ${SETTABLE_SUMMARY}\n  Anything else is structural (dev-loop team add-project / add-repo) or an interview field — edit dev-loop.json directly and validate with \`dev-loop doctor\`. Field reference: references/config-schema.md`);

  const coerced = coerce(entry.kind, value, path);
  const segs = path.split(".");
  // Own-property discipline: a wildcard segment like `__proto__`/`constructor` resolves on the PROTOTYPE
  // chain (truthy, object-typed) and the walk below would silently mutate Object.prototype instead of the
  // file — reject the reserved names outright and use Object.hasOwn everywhere else.
  for (const seg of segs) if (seg === "__proto__" || seg === "constructor" || seg === "prototype") die(`cannot set ${path}: '${seg}' is not a valid config key`);
  let msg = "";
  const ws = mutate((file) => {
    // Container existence: a projects.<key> / repos.<ref> path must name a REGISTERED entry — `set`
    // tunes fields, it never creates projects/repos (that is add-project/add-repo's job).
    if (segs[0] === "projects" && !Object.hasOwn(file.projects, segs[1])) die(`unknown project '${segs[1]}' — add it first: dev-loop team add-project ${segs[1]}`);
    if (segs[0] === "repos" && !Object.hasOwn(file.repos, segs[1])) die(`unknown repo ref '${segs[1]}' — register it first: dev-loop team add-repo ${segs[1]} --project <key> --path <rel>`);
    // team.comms is created whole on first touch: a lone provider gets the standard env NAME default
    // (matching `team init --comms`), and a lone webhookEnv has no provider to guess — set provider first.
    if (path === "team.comms.provider" && !file.team.comms) {
      file.team.comms = { provider: coerced as "slack" | "lark", webhookEnv: "DEVLOOP_COMMS_WEBHOOK" };
      msg = `set team.comms.provider: (unset) → ${JSON.stringify(coerced)} (webhookEnv defaulted to DEVLOOP_COMMS_WEBHOOK)`;
      return;
    }
    if (path === "team.comms.webhookEnv" && !file.team.comms) die(`team.comms is not configured yet — set the provider first: dev-loop team set team.comms.provider slack|lark`);
    // projects.<k>.notify mirrors the team.comms bootstrap (E15 requires type + webhookEnv together): a
    // lone type gets the standard env NAME default; a lone webhookEnv/secretEnv has no provider to guess.
    const notifyFirstTouch = path.match(/^projects\.([^.]+)\.notify\.(type|webhookEnv|secretEnv)$/);
    if (notifyFirstTouch && !(file.projects[notifyFirstTouch[1]] as { notify?: unknown }).notify) {
      if (notifyFirstTouch[2] !== "type") die(`projects.${notifyFirstTouch[1]}.notify is not configured yet — set the provider first: dev-loop team set projects.${notifyFirstTouch[1]}.notify.type slack|lark`);
      (file.projects[notifyFirstTouch[1]] as { notify?: unknown }).notify = { type: coerced, webhookEnv: "DEVLOOP_COMMS_WEBHOOK" };
      msg = `set ${path}: (unset) → ${JSON.stringify(coerced)} (webhookEnv defaulted to DEVLOOP_COMMS_WEBHOOK)`;
      return;
    }
    let node = file as unknown as Record<string, unknown>;
    for (const seg of segs.slice(0, -1)) {
      if (!Object.hasOwn(node, seg)) node[seg] = {};
      if (node[seg] === null || typeof node[seg] !== "object" || Array.isArray(node[seg])) die(`cannot set ${path}: '${seg}' is not an object in dev-loop.json`);
      node = node[seg] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1];
    const before = Object.hasOwn(node, leaf) ? node[leaf] : undefined;
    node[leaf] = coerced;
    msg = `set ${path}: ${before === undefined ? "(unset)" : JSON.stringify(before)} → ${JSON.stringify(coerced)}`;
  });
  console.log(msg); // printed only AFTER the re-validation + write succeeded
  console.log(`wrote ${ws.filePath}`);
  // Filling team.linearTeam is the moment a --yes linear workspace comes online — run the fingerprint
  // mismatch check against every mapped Linear project so a double-driven board is caught right here.
  if (path === "team.linearTeam" && ws.file.team.backend === "linear") {
    for (const [key, p] of Object.entries(ws.file.projects)) {
      if (typeof p.linearProjectId === "string" && p.linearProjectId.trim()) await stampFingerprint(ws, key, p.linearProjectId);
    }
  }
  return 0;
}

// ── workspace fingerprint (concept P4) ───────────────────────────────────────
// Stamp this workspace's id into the Linear project description marker (linear.ts transport; token from
// env, NEVER stored). Best-effort: no token / no workspaceId / a network failure only prints a note —
// but a MISMATCH (another workspace already claimed the project) warns loudly and is the whole point.
async function stampFingerprint(ws: Workspace, projectKey: string, linearProjectId: string): Promise<void> {
  if (ws.file.team.backend !== "linear") return;
  const wsId = ws.file.workspaceId;
  if (!wsId) { console.log(`fingerprint: this workspace has no workspaceId (pre-1.2 config) — not stamped; re-run \`dev-loop team init --force\` to mint one`); return; }
  const token = process.env.DEVLOOP_LINEAR_TOKEN || process.env.LINEAR_API_KEY;
  if (!token) { console.log(`fingerprint: not stamped on '${projectKey}' (no DEVLOOP_LINEAR_TOKEN / LINEAR_API_KEY in env; /dev-loop:sync-project stamps it later)`); return; }
  try {
    const { stampWorkspaceMarker } = await import("./linear.ts");
    const r = await stampWorkspaceMarker(fetch, token, linearProjectId, wsId);
    if (r.status === "stamped") console.log(`fingerprint: stamped workspace ${wsId} onto Linear project ${linearProjectId} ('${projectKey}')`);
    else if (r.status === "already") console.log(`fingerprint: Linear project ${linearProjectId} already carries this workspace's marker`);
    else console.error(
      `⚠️  WARNING: Linear project ${linearProjectId} ('${projectKey}') is already stamped by ANOTHER dev-loop workspace (${r.foundId}; this workspace is ${wsId}).\n` +
      `   Two workspaces driving one Linear project double-run every agent — retire one workspace, or point '${projectKey}' at a different Linear project.`);
  } catch (e) {
    console.error(`fingerprint: stamp check failed for '${projectKey}' (${(e as Error).message}); continuing`);
  }
}

// ── add-project ───────────────────────────────────────────────────────────────
export async function addProject(argv: string[]): Promise<number> {
  const [key, ...rest] = argv;
  if (!key || key.startsWith("--")) die("usage: dev-loop team add-project <key> [--linear-project <name>] [--linear-project-id <id>] [--test-url <url>] [--dev-split] [--weight <n>] [--enabled true|false] [--intake-mode autonomous|passive] [--name <hub name>] [--prefix <TICKET_PREFIX>]");
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--linear-project") o.linearProject = next();
    else if (a === "--linear-project-id") o.linearProjectId = next();
    else if (a === "--test-url") o.testUrl = next();
    else if (a === "--dev-split") o.devSplit = true;
    else if (a === "--weight") o.weight = next();
    else if (a === "--enabled") o.enabled = next();
    else if (a === "--intake-mode") o.intakeMode = next();
    else if (a === "--name") o.name = next();
    else if (a === "--prefix") o.prefix = next();
    else die(`unknown option '${a}'`);
  }
  const ws = mutate((file) => {
    if (file.projects[key]) die(`project '${key}' already exists — tune it with \`dev-loop team set projects.${key}.<field> <value>\` or edit dev-loop.json`);
    const p: TeamFile["projects"][string] = { repos: [] };
    if (o.linearProject) p.linearProject = o.linearProject as string;
    if (o.linearProjectId) p.linearProjectId = o.linearProjectId as string;
    if (o.testUrl) p.testEnv = { baseUrl: o.testUrl as string };
    if (o.devSplit) p.devSplit = true;
    if (o.weight !== undefined) p.weight = Number(o.weight);
    if (o.enabled !== undefined) p.enabled = o.enabled === "true" || o.enabled === true;
    if (o.intakeMode !== undefined) p.intake = { mode: o.intakeMode as "autonomous" | "passive" }; // E12 validates the value

    file.projects[key] = p;
  });
  console.log(`added project '${key}' to ${ws.filePath} (0 repos — add one with \`dev-loop team add-repo\`)`);
  provisionClaudePermissions(ws.root); // D8: idempotent — pre-D8 workspaces gain the CLI allow rule here too

  // Service backend: AUTO-SEED the hub row (find-or-create, seed.ts logic) so the scheduler's pick-time
  // guard / doctor W08 rarely fire — a config project with no hub row gets zero board access on its fires.
  if (ws.file.team.backend === "service") seedHubRow(ws, key, o.name as string | undefined, o.prefix as string | undefined);
  // Linear backend: stamp the workspace fingerprint when the operator handed us the backend id.
  if (ws.file.team.backend === "linear" && o.linearProjectId) await stampFingerprint(ws, key, o.linearProjectId as string);
  return 0;
}

function seedHubRow(ws: Workspace, key: string, name: string | undefined, prefix: string | undefined): void {
  const dbPath = wsHubDb(ws);
  let db: DatabaseSync;
  try { db = openDb(dbPath); }
  catch (e) { die(`could not open the workspace hub db at ${dbPath} (${(e as Error).message}) — seed by hand: dev-loop seed ${key} "<Project Name>" <UNIQUE_PREFIX>`, 1); }
  try {
    const existed = !!findProject(db, key);
    const chosen = prefix ?? derivePrefix(db, key);
    try { ensureSeed(db, key, name ?? key, chosen); }
    catch (e) { die(`config written, but the hub row could not be seeded: ${(e as Error).message}\n  fix it by hand: dev-loop seed ${key} "<Project Name>" <UNIQUE_PREFIX>  (doctor reports the gap as W08)`, 1); }
    console.log(existed
      ? `hub row for '${key}' already present in ${dbPath} (labels backfilled; find-or-create)`
      : `seeded hub row '${key}' (prefix ${chosen}) in ${dbPath}`);
  } finally { db.close(); }
}

// A unique, derived ticket prefix: the key's alphanumerics uppercased (max 8), de-clashed with a numeric
// suffix. Deterministic — the same key on the same db always lands the same prefix.
function derivePrefix(db: DatabaseSync, key: string): string {
  const taken = new Set((db.prepare("SELECT ticket_prefix FROM projects").all() as { ticket_prefix: string }[]).map((r) => r.ticket_prefix));
  const base = (key.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "P").slice(0, 8);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const c = `${base}${n}`; if (!taken.has(c)) return c; }
}

// ── add-repo ──────────────────────────────────────────────────────────────────
export function addRepo(argv: string[]): number {
  const [ref, ...rest] = argv;
  if (!ref || ref.startsWith("--")) die("usage: dev-loop team add-repo <ref> --project <key> [--path <rel>] [--detect] [--role primary|docs] [--remote <url>] [--owner <proj>] [--landing pr|direct] [--auto-merge] [--merge-check <name>]... [--typecheck-cmd <c>] [--build-cmd <c>] [--test-cmd <c>] [--quality-cmd <c>] [--deploy-style <s>] [--ops-check <url>]...");
  const o: Record<string, unknown> = { mergeChecks: [] as string[], opsChecks: [] as string[], criticalRoutes: [] as string[] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--project") o.project = next();
    else if (a === "--path") o.path = next();
    else if (a === "--detect") o.detect = true;
    else if (a === "--role") o.role = next();
    else if (a === "--remote") o.remote = next();
    else if (a === "--owner") o.owner = next();
    else if (a === "--landing") o.landing = next();
    else if (a === "--auto-merge") o.autoMerge = true;
    else if (a === "--merge-check") (o.mergeChecks as string[]).push(next());
    else if (a === "--typecheck-cmd") o.typecheck = next();
    else if (a === "--build-cmd") o.build = next();
    else if (a === "--test-cmd") o.test = next();
    else if (a === "--quality-cmd") o.quality = next(); // the CRAP/mutation gate (quality-gauntlet)
    else if (a === "--deploy-style") o.deployStyle = next();
    else if (a === "--ops-check") (o.opsChecks as string[]).push(next());
    else if (a === "--critical-route") (o.criticalRoutes as string[]).push(next());
    else if (a === "--logs-command") o.logsCommand = next();
    else die(`unknown option '${a}'`);
  }
  const project = o.project as string | undefined;
  if (!project) die("--project <key> is required (which project references this repo)");

  // --detect: DETERMINISTIC repo-fact detection, no LLM (CLI parity with the /dev-loop:add-repo skill's
  // detection step). Clone if needed, read package.json scripts, list CI workflow job names as candidate
  // merge checks, then register with the sensible defaults (landing:"pr", NO auto-merge). Explicit flags
  // always beat detection. Interview-only fields (deploy, ops probes, owner) stay unset — doctor surfaces
  // the gaps (repo info line; W07 once the repo deploys).
  if (o.detect) {
    const ws0 = resolveWorkspace();
    const rel = (o.path as string | undefined) ?? ws0.file.repos[ref]?.path;
    if (!rel) die(`--detect needs a repo path: pass --path <workspace-relative-path> (ref '${ref}' is not registered yet)`);
    const abs = join(ws0.root, rel);
    if (!existsSync(abs)) {
      if (!o.remote) die(`repo path ${abs} does not exist — pass --remote <url> to clone it, or clone it yourself first`);
      console.log(`cloning ${o.remote} → ${abs}`);
      const r = spawnSync("git", ["clone", o.remote as string, abs], { stdio: "inherit" });
      if (r.status !== 0) die(`git clone failed (exit ${r.status ?? "?"})`, 1);
    }
    const facts = detectRepoFacts(abs);
    if (!o.typecheck && facts.build?.typecheck) o.typecheck = facts.build.typecheck;
    if (!o.build && facts.build?.build) o.build = facts.build.build;
    if (!o.test && facts.build?.test) o.test = facts.build.test;
    if (!o.quality && facts.build?.quality) o.quality = facts.build.quality;
    if (!(o.mergeChecks as string[]).length && facts.mergeChecks?.length) o.mergeChecks = facts.mergeChecks;
    if (!o.landing) o.landing = "pr";
    console.log("detected (deterministic, no LLM):");
    console.log(JSON.stringify({ ...(facts.build ? { build: facts.build } : {}), ...(facts.mergeChecks?.length ? { mergeChecks: facts.mergeChecks } : {}), landing: o.landing }, null, 2));
    console.log(`NOTE: interview-only fields left unset (deploy, ops health checks${o.owner ? "" : ", owner"}) — \`dev-loop doctor\` surfaces the gaps (repo info line; W07 once the repo deploys).`);
  }

  const ws = mutate((file) => {
    if (!file.projects[project]) die(`project '${project}' does not exist — add it first with \`dev-loop team add-project ${project}\``);
    // Registry entry: create if new; if the ref already exists we're only adding a reference from another project.
    if (!file.repos[ref]) {
      if (!o.path) die(`repo '${ref}' is not registered yet — pass --path <workspace-relative-path>`);
      const entry: TeamFile["repos"][string] = { path: o.path as string };
      if (o.remote) entry.remote = o.remote as string;
      if (o.owner) entry.owner = o.owner as string;
      if (o.landing) entry.landing = o.landing as "pr" | "direct";
      if (o.autoMerge) entry.autoMerge = true;
      if ((o.mergeChecks as string[]).length) entry.mergeChecks = o.mergeChecks as string[];
      if (o.typecheck || o.build || o.test || o.quality) entry.build = {
        ...(o.typecheck ? { typecheck: o.typecheck as string } : {}), ...(o.build ? { build: o.build as string } : {}),
        ...(o.test ? { test: o.test as string } : {}), ...(o.quality ? { quality: o.quality as string } : {}) };
      if (o.deployStyle) entry.deploy = { style: o.deployStyle as string, environments: {} };
      if ((o.opsChecks as string[]).length || (o.criticalRoutes as string[]).length || o.logsCommand)
        entry.ops = { ...((o.opsChecks as string[]).length ? { checks: o.opsChecks as string[] } : {}),
                      ...((o.criticalRoutes as string[]).length ? { criticalRoutes: o.criticalRoutes as string[] } : {}),
                      ...(o.logsCommand ? { logsCommand: o.logsCommand as string } : {}) };
      file.repos[ref] = entry;
    } else if (o.owner) {
      file.repos[ref].owner = o.owner as string; // updating owner on an existing shared repo
    }
    // Project reference edge.
    const refs = file.projects[project].repos ?? (file.projects[project].repos = []);
    if (!refs.some((r) => r.ref === ref)) refs.push({ ref, ...(o.role ? { role: o.role as string } : {}) });
  });
  const shared = referencingProjects(ws, ref);
  console.log(`registered repo '${ref}'${o.path ? ` (${o.path})` : ""} under project '${project}'${shared.length > 1 ? ` — now shared by ${shared.join(", ")} (owner: ${ws.file.repos[ref].owner ?? "?"})` : ""}`);
  return 0;
}

// ── deterministic repo-fact detection (`add-repo --detect`) ───────────────────
export interface DetectedRepoFacts { build?: { typecheck?: string; build?: string; test?: string; quality?: string }; mergeChecks?: string[] }

// package.json scripts named `typecheck`/`build` become build gates (runner chosen by lockfile:
// pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm); .github/workflows job names become CANDIDATE
// merge checks (a job's `name:` when set, else its key). Pure fs reads — deterministic and LLM-free.
export function detectRepoFacts(absPath: string): DetectedRepoFacts {
  const out: DetectedRepoFacts = {};
  try {
    const pkg = JSON.parse(readFileSync(join(absPath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const pm = existsSync(join(absPath, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(absPath, "yarn.lock")) ? "yarn" : "npm";
    const runCmd = (name: string) => `${pm} run ${name}`;
    const build: { typecheck?: string; build?: string; test?: string; quality?: string } = {};
    if (typeof pkg.scripts?.typecheck === "string") build.typecheck = runCmd("typecheck");
    if (typeof pkg.scripts?.build === "string") build.build = runCmd("build");
    if (typeof pkg.scripts?.test === "string") build.test = runCmd("test");
    if (typeof pkg.scripts?.quality === "string") build.quality = runCmd("quality"); // the CRAP/mutation gate (quality-gauntlet)
    if (build.typecheck || build.build) out.build = build;
  } catch { /* no package.json (or unparseable) → no build facts */ }
  const checks: string[] = [];
  try {
    const wfDir = join(absPath, ".github", "workflows");
    for (const f of readdirSync(wfDir).sort()) {
      if (!/\.ya?ml$/.test(f)) continue;
      try { checks.push(...workflowJobNames(readFileSync(join(wfDir, f), "utf8"))); } catch { /* unreadable workflow */ }
    }
  } catch { /* no workflows dir */ }
  if (checks.length) out.mergeChecks = [...new Set(checks)];
  return out;
}

// Line-oriented extraction of the job names under a workflow's top-level `jobs:` key — a job's display
// `name:` (one nesting level below the job key) wins over the key. NOT a YAML parser: a deterministic
// heuristic good enough for candidate merge checks (step-level `name:` lines start with `- ` and are
// deeper than the accepted indent window, so they never match).
export function workflowJobNames(text: string): string[] {
  const names: string[] = [];
  let inJobs = false;
  let jobIndent = -1;
  let openJobIdx = -1; // the job still awaiting a display name (−1 once named / none)
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):/); // any new top-level key ends the jobs block
    if (top) { inJobs = top[1] === "jobs"; jobIndent = -1; openJobIdx = -1; continue; }
    if (!inJobs || !line.trim()) continue;
    const m = line.match(/^([ \t]+)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (jobIndent === -1) jobIndent = indent; // the first key under jobs: fixes the job indent level
    if (indent === jobIndent) { names.push(m[2]); openJobIdx = names.length - 1; }
    else if (openJobIdx >= 0 && m[2] === "name" && indent > jobIndent && indent <= jobIndent + 4 && m[3].trim()) {
      names[openJobIdx] = m[3].trim().replace(/^["']|["']$/g, "");
      openJobIdx = -1;
    }
  }
  return names;
}

// ── add-provider (one-click Q1) ──────────────────────────────────────────────
// The FIRST-CLASS provider mutator — closes the last "no CLI verb" gap so the operator-console skill's
// "never hand-edit dev-loop.json" HARD LIMIT holds uniformly. Writes the E16-validated
// team.providers.<id> entry through the same mutate() path as every other config write, then renders it
// into the workspace opencode.json itself (the sync step the operator used to have to remember). §16:
// takes the env-var NAME only; the VALUE goes in separately via `dev-loop secret set <NAME>` (TTY-
// prompted — the key never appears on a command line, in the chat, or in shell history).
export function addProvider(argv: string[]): number {
  const [id, ...rest] = argv;
  if (!id || id.startsWith("--"))
    die("usage: dev-loop team add-provider <id> --base-url <https-url> --auth-env <ENV_NAME> --models <a,b,…> [--effort-mode passthrough|strip] [--force]");
  const o: { baseUrl?: string; authEnv?: string; models?: string; effortMode?: string; force?: boolean } = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--base-url") o.baseUrl = next();
    else if (a === "--auth-env") o.authEnv = next();
    else if (a === "--models") o.models = next();
    else if (a === "--effort-mode") o.effortMode = next();
    else if (a === "--force") o.force = true;
    else die(`unknown option '${a}'`);
  }
  if (!o.baseUrl || !o.authEnv || !o.models) die("--base-url, --auth-env, and --models are all required");
  if (o.effortMode !== undefined && o.effortMode !== "passthrough" && o.effortMode !== "strip")
    die(`--effort-mode must be passthrough or strip (got '${o.effortMode}')`);
  const baseUrl = o.baseUrl, authTokenEnv = o.authEnv;
  const effortMode = o.effortMode as "passthrough" | "strip" | undefined;
  const models = o.models.split(",").map((m) => m.trim()).filter(Boolean);
  const ws = mutate((file) => {
    const team = file.team as TeamFile["team"] & { providers?: Record<string, unknown> };
    team.providers ??= {};
    if (team.providers[id] && !o.force) die(`provider '${id}' already exists — pass --force to overwrite it`, 1);
    team.providers[id] = {
      kind: "openai-compatible", baseUrl, authTokenEnv, models,
      ...(effortMode ? { effortMode } : {}),
    };
  });
  const sync = syncOpencodeConfig(ws.root, (ws.file.team.providers ?? {}) as never);
  if (!sync.ok) { console.error(`⚠️  provider saved but opencode.json sync failed: ${sync.error} — run: dev-loop team sync-opencode`); return 1; }
  console.log(`✅ provider '${id}' registered (${models.length} model${models.length === 1 ? "" : "s"}) + opencode.json ${sync.action}`);
  console.log(`   launch strings: ${models.map((m) => `${id}/${m}`).join(", ")}`);
  if (process.env[o.authEnv] === undefined)
    console.log(`   next: dev-loop secret set ${o.authEnv}   (the key VALUE — doctor W13 checks resolvability)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "add-project") process.exit(await addProject(rest));
  if (sub === "add-repo") process.exit(addRepo(rest));
  if (sub === "set") process.exit(await teamSet(rest));
  if (sub === "add-provider") process.exit(addProvider(rest));
  console.error("usage: team-edit add-project|add-repo|set|add-provider …"); process.exit(2);
}
