#!/usr/bin/env node
// `dev-loop team add-project` / `add-repo` / `set` — the DETERMINISTIC, VALIDATED config mutators the
// operator skills call to persist (design impl §10). The skills (add-project/add-repo, run in a coding
// CLI) do the discovery / interview / backend MCP writes; the actual dev-loop.json edit goes through here
// so a config is NEVER hand-edited into an invalid state — every write re-validates the whole file first.
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspace, wsHubDb, wsStateRoot } from "./workspace.ts";
import { validateTeamFile, referencingProjects, isTeamProject, type TeamFile, type Workspace } from "./team-config.ts";
import { confirmationToken, isolationVerdict, commitBothHalves, TOKEN_PREFIX } from "./destructive-guard.ts";
import { openDb } from "./db.ts";
import { ensureSeed, findProject, AGENT_HANDLES } from "./seed.ts";
import { isCanonicalTicketPrefix } from "./ticket-id.ts";
import { snapshotBeforeDestructive, resolveBackupConfig } from "./board-snapshot.ts"; // LOOP-339 trigger 2
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
type SetKind = "string" | "boolean" | "number" | "int" | "string-list" | "nullable-pos-number" | readonly string[];
export const SETTABLE: ReadonlyArray<{ re: RegExp; kind: SetKind }> = [
  { re: /^team\.mode$/, kind: ["dry-run", "live"] as const },
  { re: /^team\.linearTeam$/, kind: "string" },
  { re: /^team\.git\.defaultBranch$/, kind: "string" },
  { re: /^team\.comms\.provider$/, kind: ["slack", "lark"] as const },
  { re: /^team\.comms\.webhookEnv$/, kind: "string" },
  { re: /^team\.intake\.mode$/, kind: ["autonomous", "passive"] as const },
  { re: /^team\.intake\.todoDepthCap$/, kind: "int" },
  { re: /^team\.intake\.acCompletenessGate$/, kind: "boolean" }, // LOOP-198: opt-in, see the AC5 measurement
  // agentReviewers: comma-separated GitHub logins to exclude from forge-review trips (§3.2); stores as string[]
  { re: /^team\.agentReviewers$/, kind: "string-list" as const },
  // budget: rolling 24h spend ceiling (dailyUsd, null=OFF) and per-fire ceiling (perFireUsd, must be positive)
  { re: /^team\.budget\.dailyUsd$/, kind: "nullable-pos-number" as const },
  { re: /^team\.budget\.perFireUsd$/, kind: "number" },
  // LOOP-339 — the board-snapshot cadence goes through the validated mutator like every other
  // tunable (the operator console's hard rule 1: config through mutators only, never a hand-edit).
  { re: /^team\.backup\.everyHours$/, kind: "number" },
  { re: /^team\.backup\.keep$/, kind: "int" },
  { re: /^team\.backup\.dir$/, kind: "string" },
  { re: /^projects\.[^.]+\.enabled$/, kind: "boolean" },
  { re: /^projects\.[^.]+\.weight$/, kind: "number" },
  { re: /^projects\.[^.]+\.devSplit$/, kind: "boolean" },
  // scratch (LOOP-327): `add-project --scratch` writes it only at creation; without a settable
  // path an existing project's lost marker is UNREPAIRABLE through mutators — and destructive-guard
  // keys its isolation verdict on this field, so unrepairable is a safety problem (the 2026-08-04
  // recovery had to hand-edit it back).
  { re: /^projects\.[^.]+\.scratch$/, kind: "boolean" },
  // team-scope per-agent launch config (LOOP-327): set-model writes projects.<key>.agents only, so
  // _team-scope fires (sweep/ops/…) fell back to the built-in default — one sweep night on the
  // fallback model billed $20.34 against an intended ~$0.003/fire lane.
  { re: /^team\.agents\.[^.]+\.codingAgent$/, kind: ["claude", "codex", "opencode"] as const },
  { re: /^team\.agents\.[^.]+\.model$/, kind: "string" },
  { re: /^team\.agents\.[^.]+\.effort$/, kind: "string" },
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
  // strategyDoc: the repo-relative file path pointer consumed by doc-land / roadmap-banner / file-watcher.
  // Stored as a plain string; absolute paths and Linear doc URLs are rejected at the set gate (not schema-level).
  { re: /^projects\.[^.]+\.strategyDoc$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.style$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.healthCheck$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.auto$/, kind: "boolean" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.deployPrPrefix$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.command$/, kind: "string" },
  { re: /^repos\.[^.]+\.deploy\.environments\.[^.]+\.healthCheck$/, kind: "string" },
];
const SETTABLE_SUMMARY =
  "team.{mode,linearTeam,git.defaultBranch,comms.provider,comms.webhookEnv,intake.mode,intake.todoDepthCap,agentReviewers,budget.dailyUsd,budget.perFireUsd,backup.{everyHours,keep,dir},agents.<a>.{codingAgent,model,effort}}, " +
  "projects.<key>.{enabled,weight,devSplit,scratch,testEnv.baseUrl,testEnv.authConstraint,intake.mode,intake.todoDepthCap," +
  "communication.{cadence,language,audience,tone,maxWords,sourceWindowDays,output,outputDir,repoOutputDir,includeUnreleased}," +
  "notify.{type,webhookEnv,secretEnv}}, " +
  "repos.<ref>.deploy.{style,healthCheck,environments.<env>.{auto,deployPrPrefix,command,healthCheck}}, " +
  "projects.<key>.strategyDoc";

// LOOP-245: Number("0x64") === 100, so a plain Number() check lets hex/octal/binary through silently.
// Only plain decimal integers/decimals are accepted for numeric config fields (no scientific notation).
const PLAIN_DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

function coerce(kind: SetKind, raw: string, path: string): unknown {
  if (Array.isArray(kind)) { if (!kind.includes(raw)) die(`${path} must be one of ${kind.join("|")} (got '${raw}')`); return raw; }
  if (kind === "boolean") { if (raw !== "true" && raw !== "false") die(`${path} expects true|false (got '${raw}')`); return raw === "true"; }
  if (kind === "number" || kind === "int") {
    if (!PLAIN_DECIMAL_RE.test(raw.trim())) die(`${path} expects a${kind === "int" ? "n integer" : " number"} in plain decimal form (got '${raw}') — hex/octal/binary/scientific notation not accepted`);
    const n = Number(raw);
    if (!Number.isFinite(n) || (kind === "int" && !Number.isInteger(n))) die(`${path} expects a${kind === "int" ? "n integer" : " number"} (got '${raw}')`);
    return n;
  }
  if (kind === "nullable-pos-number") {
    if (raw.trim() === "null") return null;
    if (!PLAIN_DECIMAL_RE.test(raw.trim())) die(`${path} must be a plain decimal number or null to disable (got '${raw}') — hex/octal/binary/scientific notation not accepted`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) die(`${path} must be a positive number or null to disable (got '${raw}')`);
    return n;
  }
  if (kind === "string-list") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!raw.trim()) die(`${path} expects a non-empty value`);
  return raw;
}

// LOOP-135 — the rejection an operator reads at the exact moment they need guidance used to end in
// "edit dev-loop.json directly", which is the ONE action the shipped operator console forbids as its
// hard rule 1. Route by class, honestly: name the mutator that does write the path; say plainly when a
// field is create-time-only; and when nothing can write it yet, say THAT rather than implying a route
// exists. `doctor` may still be named as the way to VALIDATE config — never as a blessing for editing it.
const OTHER_MUTATOR: ReadonlyArray<{ re: RegExp; how: string }> = [
  { re: /^repos\.[^.]+\.(path|remote|defaultBranch|landing|mergeChecks|autoMerge|build|ci)/, how: "`dev-loop team add-repo <ref> --project <key> --path <rel> --detect` re-registers a repo and re-detects its build/CI facts" },
  { re: /^projects\.[^.]+\.repos/, how: "`dev-loop team add-repo <ref> --project <key> …` adds a repo reference to a project" },
  { re: /^team\.providers\./, how: "`dev-loop team add-provider <id> --base-url <url> --auth-env <NAME> --models …` (the key VALUE goes through `dev-loop secret set`, never config)" },
  { re: /^team\.agents\.[^.]+\.(codingAgent|model|effort)$/, how: "`dev-loop team set-model <agent> <model> [--effort e] [--team-default]`" },
];
const CREATE_TIME_ONLY = /^(team\.key|team\.backend|projects\.[^.]+\.(linearProject|linearProjectId))$/;

function unsettableGuidance(path: string): string {
  const hit = OTHER_MUTATOR.find((m) => m.re.test(path));
  if (hit) return `  a different mutator owns this path: ${hit.how}`;
  if (CREATE_TIME_ONLY.test(path)) return `  this field is create-time only — it is fixed by \`dev-loop team init\` / \`team add-project\` and there is no supported way to change it in place.`;
  return `  no operator-settable writer exists for this path yet — there is no supported route to change it from the CLI.\n  Field reference: references/config-schema.md. \`dev-loop doctor\` validates the config; it does not authorize hand-editing it.`;
}

export async function teamSet(argv: string[]): Promise<number> {
  const [path, value, ...extra] = argv;
  if (!path || path === "--help" || path === "-h" || value === undefined || extra.length)
    die(`usage: dev-loop team set <path> <value>\n  settable paths: ${SETTABLE_SUMMARY}`);
  const entry = SETTABLE.find((s) => s.re.test(path));
  if (!entry) die(`'${path}' is not an operator-settable path.\n  settable: ${SETTABLE_SUMMARY}\n${unsettableGuidance(path)}`);

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
    // budget.perFireUsd must be strictly positive (the "number" kind accepts any finite number).
    if (path === "team.budget.perFireUsd" && (coerced as number) <= 0)
      die(`team.budget.perFireUsd must be a positive number (got '${value}')`);
    // strategyDoc validation: must be a repo-relative path (no absolute paths, no Linear document URLs).
    if (segs[0] === "projects" && segs[2] === "strategyDoc") {
      const v = coerced as string;
      if (isAbsolute(v)) die(`projects.<key>.strategyDoc must be a repo-relative path, not an absolute path (got '${v}') — see references/config-schema.md`);
      if (/linear\.app\/.*\/document\//.test(v)) die(`projects.<key>.strategyDoc must be a repo-relative file path; Linear document URLs are not accepted here`);
    }
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
  if (!key || key.startsWith("--")) die("usage: dev-loop team add-project <key> [--linear-project <name>] [--linear-project-id <id>] [--test-url <url>] [--dev-split] [--scratch] [--weight <n>] [--enabled true|false] [--intake-mode autonomous|passive] [--name <hub name>] [--prefix <TICKET_PREFIX>] [--strategy-doc <rel-path>]");
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--linear-project") o.linearProject = next();
    else if (a === "--linear-project-id") o.linearProjectId = next();
    else if (a === "--test-url") o.testUrl = next();
    else if (a === "--dev-split") o.devSplit = true;
    else if (a === "--scratch") o.scratch = true;
    else if (a === "--weight") o.weight = next();
    else if (a === "--enabled") o.enabled = next();
    else if (a === "--intake-mode") o.intakeMode = next();
    else if (a === "--name") o.name = next();
    else if (a === "--prefix") o.prefix = next();
    else if (a === "--strategy-doc") o.strategyDoc = next();
    else die(`unknown option '${a}'`);
  }
  if (o.strategyDoc !== undefined) {
    const sd = o.strategyDoc as string;
    if (isAbsolute(sd)) die(`--strategy-doc must be a repo-relative path, not an absolute path (got '${sd}')`);
    if (/linear\.app\/.*\/document\//.test(sd)) die(`--strategy-doc must be a repo-relative file path; Linear document URLs are not accepted here`);
  }
  // LOOP-301 — every precondition `seedHubRow` will enforce is checked BEFORE `mutate()` writes
  // dev-loop.json. Previously `--prefix` was not looked at until three steps later, so a rejected
  // prefix left a config project the same command could no longer complete (`project already exists`)
  // with no hub row behind it. Route chosen: FRONT DOOR (pre-flight), not rollback-on-failure — on a
  // service backend the hub db is readable here, which makes the check exact; `ensureProject`'s own
  // check stays as the backstop for `dev-loop seed` and any future caller.
  preflightHubRow(key, o.prefix as string | undefined);

  const ws = mutate((file) => {
    if (file.projects[key]) die(dupProjectMessage(key));
    const p: TeamFile["projects"][string] = { repos: [] };
    if (o.linearProject) p.linearProject = o.linearProject as string;
    if (o.linearProjectId) p.linearProjectId = o.linearProjectId as string;
    if (o.testUrl) p.testEnv = { baseUrl: o.testUrl as string };
    if (o.devSplit) p.devSplit = true;
    if (o.scratch) p.scratch = true;
    // LOOP-288: through the SHARED coerce, not a bare Number(). `Number("0x64") === 100`, so the
    // operator asked for 0x64 and the config silently recorded 100 — while `team set` on the very
    // same key refused it. One field, two write paths, one contract now.
    if (o.weight !== undefined) p.weight = coerce("number", String(o.weight), `projects.${key}.weight`) as number;
    if (o.enabled !== undefined) p.enabled = o.enabled === "true" || o.enabled === true;
    if (o.intakeMode !== undefined) p.intake = { mode: o.intakeMode as "autonomous" | "passive" }; // E12 validates the value
    if (o.strategyDoc !== undefined) p.strategyDoc = o.strategyDoc as string;

    file.projects[key] = p;
  });
  console.log(`added project '${key}' to ${ws.filePath} (0 repos — add one with \`dev-loop team add-repo\`)`);
  provisionClaudePermissions(ws.root); // D8: idempotent — pre-D8 workspaces gain the CLI allow rule here too

  // Service backend: AUTO-SEED the hub row (find-or-create, seed.ts logic) so the scheduler's pick-time
  // guard / doctor W08 rarely fire — a config project with no hub row gets zero board access on its fires.
  if (ws.file.team.backend === "service") seedHubRow(ws, key, o.name as string | undefined, o.prefix as string | undefined, !!o.scratch);
  // Linear backend: stamp the workspace fingerprint when the operator handed us the backend id.
  if (ws.file.team.backend === "linear" && o.linearProjectId) await stampFingerprint(ws, key, o.linearProjectId as string);
  return 0;
}

// LOOP-135 second emitter — the duplicate-key refusal must route the operator to a SANCTIONED action.
// It used to end in "or edit dev-loop.json", the one thing the shipped operator console forbids as its
// hard rule 1; and on a config-only project (config row present, hub row absent — the exact state the
// LOOP-301 bug used to leave behind) the "tune it" hint is the wrong recovery anyway.
function dupProjectMessage(key: string): string {
  let hubRowMissing = false;
  try {
    const ws = resolveWorkspace();
    if (ws.file.team.backend === "service") {
      const db = openDb(wsHubDb(ws));
      try { hubRowMissing = !findProject(db, key); } finally { db.close(); }
    }
  } catch { /* best-effort: an unreadable db must not change WHICH error the operator gets */ }
  return hubRowMissing
    ? `project '${key}' is in dev-loop.json but has NO hub row — finish it with \`dev-loop seed ${key} "<Project Name>" <UNIQUE_PREFIX>\` (doctor reports the gap as W08)`
    : `project '${key}' already exists — tune it with \`dev-loop team set projects.${key}.<field> <value>\``;
}

// LOOP-301 — the front door for every precondition `seedHubRow` enforces, run BEFORE the config write.
// Only shape + uniqueness are checkable here; both are the ones `ensureProject` refuses on, and on a
// service backend the db is readable at this point so the answer is exact rather than a guess. On any
// other backend (or an unreadable db) this is a no-op and `ensureProject` remains the only guard —
// there is no config write to protect there, because seedHubRow does not run.
function preflightHubRow(key: string, prefix: string | undefined): void {
  if (prefix !== undefined && !isCanonicalTicketPrefix(prefix))
    die(`ticket prefix '${prefix}' is not a valid <PREFIX> for project '${key}': must be uppercase, start with a letter, and contain only letters/digits (e.g. LOOP, WEB2) — nothing was written`);
  let ws: Workspace;
  try { ws = resolveWorkspace(); } catch { return; } // no workspace ⇒ mutate() raises the real error
  if (ws.file.team.backend !== "service" || prefix === undefined) return;
  try {
    const db = openDb(wsHubDb(ws));
    try {
      const clash = db.prepare("SELECT key FROM projects WHERE ticket_prefix=? AND key<>?").get(prefix, key) as { key: string } | undefined;
      if (clash) die(`ticket prefix '${prefix}' is already held by project '${clash.key}' — pick another; nothing was written`);
    } finally { db.close(); }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("dev-loop team:")) throw e; // die() already exited; belt-and-braces
    /* unreadable db: fall through — seedHubRow reports it with its own by-hand remedy */
  }
}

function seedHubRow(ws: Workspace, key: string, name: string | undefined, prefix: string | undefined, scratch = false): void {
  const dbPath = wsHubDb(ws);
  let db: DatabaseSync;
  try { db = openDb(dbPath); }
  catch (e) { die(`could not open the workspace hub db at ${dbPath} (${(e as Error).message}) — seed by hand: dev-loop seed ${key} "<Project Name>" <UNIQUE_PREFIX>`, 1); }
  try {
    const existed = !!findProject(db, key);
    const chosen = prefix ?? derivePrefix(db, key);
    try { ensureSeed(db, key, name ?? key, chosen); }
    catch (e) { die(`config written, but the hub row could not be seeded: ${(e as Error).message}\n  fix it by hand: dev-loop seed ${key} "<Project Name>" <UNIQUE_PREFIX>  (doctor reports the gap as W08)`, 1); }
    if (scratch) {
      const row = db.prepare("SELECT settings_json FROM projects WHERE key=?").get(key) as { settings_json: string | null } | undefined;
      let settings: Record<string, unknown> = {};
      try { settings = row?.settings_json ? (JSON.parse(row.settings_json) as Record<string, unknown>) : {}; } catch { /* malformed — start fresh */ }
      db.prepare("UPDATE projects SET settings_json=? WHERE key=?").run(JSON.stringify({ ...settings, scratch: true }), key);
    }
    console.log(existed
      ? `hub row for '${key}' already present in ${dbPath} (labels backfilled; find-or-create)`
      : `seeded hub row '${key}' (prefix ${chosen}) in ${dbPath}`);
  } finally { db.close(); }
}

// A unique, derived ticket prefix: the key's alphanumerics uppercased (max 8), de-clashed with a numeric
// suffix. Deterministic — the same key on the same db always lands the same prefix.
// The result must satisfy `isCanonicalTicketPrefix` (LOOP-264): `ensureProject` now rejects an out-of-shape
// prefix at the INSERT, so a derive path that could emit one would turn a previously-working
// `team add-project` into a hard failure. The one shape it could emit is a DIGIT-LEADING base — a key like
// `2fa` derives `2FA`, and ids must start with a letter — so a leading `P` is prepended in that case.
function derivePrefix(db: DatabaseSync, key: string): string {
  const taken = new Set((db.prepare("SELECT ticket_prefix FROM projects").all() as { ticket_prefix: string }[]).map((r) => r.ticket_prefix));
  const alnum = key.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const base = (/^[A-Z]/.test(alnum) ? alnum : `P${alnum}`).slice(0, 8) || "P";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) { const c = `${base}${n}`; if (!taken.has(c)) return c; }
}

// ── add-repo ──────────────────────────────────────────────────────────────────
// The --detect half of add-repo (1.8.1 quality-gauntlet drain: addRepo CC 46 → detect vs mutate
// halves): clone if needed, read package.json scripts + CI workflow names, fill only the flags the
// operator did not pass. Mutates `o` in place (explicit flags always beat detection).
function detectHalf(ref: string, o: Record<string, unknown>): void {
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
    if (!o.defaultBranch && facts.defaultBranch) o.defaultBranch = facts.defaultBranch;
    if (!o.landing) o.landing = "pr";
    console.log("detected (deterministic, no LLM):");
    console.log(JSON.stringify({ ...(facts.build ? { build: facts.build } : {}), ...(facts.mergeChecks?.length ? { mergeChecks: facts.mergeChecks } : {}), ...(o.defaultBranch ? { defaultBranch: o.defaultBranch } : {}), landing: o.landing }, null, 2));
    console.log(`NOTE: interview-only fields left unset (deploy, ops health checks${o.owner ? "" : ", owner"}) — \`dev-loop doctor\` surfaces the gaps (repo info line; W07 once the repo deploys).`);
  }
}

export function addRepo(argv: string[]): number {
  const [ref, ...rest] = argv;
  if (!ref || ref.startsWith("--")) die("usage: dev-loop team add-repo <ref> --project <key> [--path <rel>] [--detect] [--role primary|docs] [--remote <url>] [--owner <proj>] [--landing pr|direct] [--auto-merge] [--merge-check <name>]... [--default-branch <name>] [--typecheck-cmd <c>] [--build-cmd <c>] [--test-cmd <c>] [--quality-cmd <c>] [--deploy-style <s>] [--ops-check <url>]...\nNote: field flags (--path, --landing, --merge-check, --build-cmd, etc.) are only applied when <ref> is new. Re-running on an already-registered ref with field flags exits non-zero. To update a registered repo's fields use: dev-loop team set repos.<ref>.<field> <value>. --owner and --default-branch are exceptions: they update in place on an existing ref.");
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
    else if (a === "--default-branch") o.defaultBranch = next();
    else die(`unknown option '${a}'`);
  }
  const project = o.project as string | undefined;
  if (!project) die("--project <key> is required (which project references this repo)");

  // --detect: DETERMINISTIC repo-fact detection, no LLM (CLI parity with the /dev-loop:add-repo skill's
  // detection step). Clone if needed, read package.json scripts, list CI workflow job names as candidate
  // merge checks, then register with the sensible defaults (landing:"pr", NO auto-merge). Explicit flags
  // always beat detection. Interview-only fields (deploy, ops probes, owner) stay unset — doctor surfaces
  // the gaps (repo info line; W07 once the repo deploys).
  if (o.detect) detectHalf(ref, o);

  const ws = mutate((file) => {
    if (!file.projects[project]) die(`project '${project}' does not exist — add it first with \`dev-loop team add-project ${project}\``);
    // Registry entry: create if new; if the ref already exists, refuse field-flag writes (they would
    // be silently discarded — LOOP-134). The shared-repo re-registration path (no field flags, just
    // --project) is the one legitimate existing-ref use case; --owner is the one update-in-place field.
    if (!file.repos[ref]) {
      if (!o.path) die(`repo '${ref}' is not registered yet — pass --path <workspace-relative-path>`);
      const entry: TeamFile["repos"][string] = { path: o.path as string };
      if (o.remote) entry.remote = o.remote as string;
      if (o.owner) entry.owner = o.owner as string;
      if (o.landing) entry.landing = o.landing as "pr" | "direct";
      if (o.autoMerge) entry.autoMerge = true;
      if ((o.mergeChecks as string[]).length) entry.mergeChecks = o.mergeChecks as string[];
      if (o.defaultBranch) entry.defaultBranch = o.defaultBranch as string;
      if (o.typecheck || o.build || o.test || o.quality) entry.build = {
        ...(o.typecheck ? { typecheck: o.typecheck as string } : {}), ...(o.build ? { build: o.build as string } : {}),
        ...(o.test ? { test: o.test as string } : {}), ...(o.quality ? { quality: o.quality as string } : {}) };
      if (o.deployStyle) entry.deploy = { style: o.deployStyle as string, environments: {} };
      if ((o.opsChecks as string[]).length || (o.criticalRoutes as string[]).length || o.logsCommand)
        entry.ops = { ...((o.opsChecks as string[]).length ? { checks: o.opsChecks as string[] } : {}),
                      ...((o.criticalRoutes as string[]).length ? { criticalRoutes: o.criticalRoutes as string[] } : {}),
                      ...(o.logsCommand ? { logsCommand: o.logsCommand as string } : {}) };
      file.repos[ref] = entry;
    } else {
      // Existing ref: field flags would be silently dropped — refuse loudly so the operator knows.
      const hasFieldFlags = !!(o.path || o.remote || o.landing || o.autoMerge ||
        (o.mergeChecks as string[]).length || o.typecheck || o.build || o.test || o.quality ||
        o.deployStyle || (o.opsChecks as string[]).length || (o.criticalRoutes as string[]).length || o.logsCommand);
      if (hasFieldFlags)
        die(`repo '${ref}' is already registered — field flags on an existing ref are not applied (add-repo only writes them at creation time). To update individual fields, use: dev-loop team set repos.${ref}.<field> <value>  (see \`dev-loop team set --help\` for the settable-paths list)`);
      if (o.owner) file.repos[ref].owner = o.owner as string;
      if (o.defaultBranch) file.repos[ref].defaultBranch = o.defaultBranch as string;
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
export interface DetectedRepoFacts { build?: { typecheck?: string; build?: string; test?: string; quality?: string }; mergeChecks?: string[]; defaultBranch?: string }

// package.json scripts named `typecheck`/`build` become build gates (runner chosen by lockfile:
// pnpm-lock.yaml → pnpm, yarn.lock → yarn, else npm); .github/workflows job names become CANDIDATE
// merge checks (a job's `name:` when set, else its key). Pure fs reads — deterministic and LLM-free.
export function detectRepoFacts(absPath: string): DetectedRepoFacts {
  const out: DetectedRepoFacts = {};
  const parsePkg = (dir: string): { scripts?: Record<string, string> } | null => {
    try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }; }
    catch { return null; }
  };
  const GATES = ["typecheck", "build", "test", "quality"] as const;
  const buildFromPkg = (pkg: { scripts?: Record<string, string> }, dir: string, subdir?: string) => {
    const pm = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : "npm";
    const prefix = subdir ? `cd ${subdir} && ` : "";
    const runCmd = (n: string) => `${prefix}${pm} run ${n}`;
    const build: { typecheck?: string; build?: string; test?: string; quality?: string } = {};
    if (typeof pkg.scripts?.typecheck === "string") build.typecheck = runCmd("typecheck");
    if (typeof pkg.scripts?.build === "string") build.build = runCmd("build");
    if (typeof pkg.scripts?.test === "string") build.test = runCmd("test");
    if (typeof pkg.scripts?.quality === "string") build.quality = runCmd("quality"); // the CRAP/mutation gate (quality-gauntlet)
    return Object.keys(build).length ? build : null;
  };
  const rootPkg = parsePkg(absPath);
  if (rootPkg !== null) {
    const build = buildFromPkg(rootPkg, absPath);
    if (build) out.build = build;
  } else {
    // root has no package.json — scan one level of subdirectories; emit only when exactly one candidate matches
    try {
      const candidates: Array<{ name: string; pkg: { scripts?: Record<string, string> } }> = [];
      for (const entry of readdirSync(absPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = join(absPath, entry.name);
        const pkg = parsePkg(sub);
        if (pkg && GATES.some(s => typeof pkg.scripts?.[s] === "string")) candidates.push({ name: entry.name, pkg });
      }
      if (candidates.length === 1) {
        const build = buildFromPkg(candidates[0].pkg, join(absPath, candidates[0].name), candidates[0].name);
        if (build) out.build = build;
      }
    } catch { /* unreadable dir */ }
  }
  const checks: string[] = [];
  try {
    const wfDir = join(absPath, ".github", "workflows");
    for (const f of readdirSync(wfDir).sort()) {
      if (!/\.ya?ml$/.test(f)) continue;
      try { checks.push(...workflowJobNames(readFileSync(join(wfDir, f), "utf8"), f)); } catch { /* unreadable workflow */ }
    }
  } catch { /* no workflows dir */ }
  if (checks.length) out.mergeChecks = [...new Set(checks)];
  // Detect the default branch: try symbolic-ref first (fast, offline), fall back to `remote show`.
  const symRef = spawnSync("git", ["-C", absPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf8" });
  if (symRef.status === 0 && symRef.stdout.trim()) {
    out.defaultBranch = symRef.stdout.trim().replace(/^origin\//, "");
  } else {
    const remoteShow = spawnSync("git", ["-C", absPath, "remote", "show", "origin"], { encoding: "utf8" });
    if (remoteShow.status === 0) {
      const m = remoteShow.stdout.match(/HEAD branch:\s*(.+)/);
      const parsed = m?.[1].trim();
      if (parsed && parsed !== "(unknown)") out.defaultBranch = parsed;
    }
  }
  return out;
}

// Triggers whose presence in a workflow's `on:` block means it CAN produce a PR check context.
const PR_TRIGGERS = new Set(["push", "pull_request", "pull_request_target"]);

// Extract the set of top-level `on:` triggers from a workflow YAML text (line-oriented heuristic).
function workflowTriggers(text: string): Set<string> {
  const out = new Set<string>();
  let inOn = false, onIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)/);
    if (top) {
      if (top[1] === "on") {
        inOn = true; onIndent = -1;
        const rest = top[2].trim();
        if (rest) {
          // Inline form: "on: push" or "on: [push, pull_request]"
          const segs = rest.startsWith("[") ? rest.slice(1, rest.lastIndexOf("]")).split(",") : [rest];
          for (const s of segs) out.add(s.trim().replace(/^["']|["']$/g, ""));
          inOn = false;
        }
      } else { inOn = false; onIndent = -1; }
      continue;
    }
    if (!inOn) continue;
    const m = line.match(/^([ \t]+)([A-Za-z0-9_-]+):/);
    if (!m) continue;
    const d = m[1].length;
    if (onIndent < 0) onIndent = d;
    if (d === onIndent) out.add(m[2]);
  }
  return out;
}

// Scan lines[start..end) for strategy.matrix entries within a job at jobIndent.
// Returns a map of matrix variable name → list of static string values.
function scanJobMatrix(lines: string[], start: number, end: number, jobIndent: number): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};
  let inMatrix = false, matrixIndent = -1, varIndent = -1, curVar = "", blockSeq = false;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (blockSeq && curVar) {
      const seq = line.match(/^([ \t]+)-\s+(.+?)\s*$/);
      if (seq && seq[1].length > matrixIndent) { (matrix[curVar] ??= []).push(seq[2].replace(/^["']|["']$/g, "")); continue; }
      blockSeq = false;
    }
    const m = line.match(/^([ \t]+)([A-Za-z0-9_-]+):\s*(.*)/);
    if (!m) continue;
    const [, ind, key, rest] = m;
    const depth = ind.length;
    if (depth <= jobIndent) break; // left this job
    if (!inMatrix) { if (key === "matrix") { inMatrix = true; matrixIndent = depth; } continue; }
    if (depth <= matrixIndent) { inMatrix = false; break; } // exited matrix block
    if (varIndent < 0) varIndent = depth;
    if (depth !== varIndent) continue; // nested keys (include/exclude/etc.)
    curVar = key; blockSeq = false;
    const v = rest.trim();
    if (v.startsWith("[") && v.includes("]")) {
      // Inline flow sequence: ["23.6.0", "24"] or [23.6.0, 24]
      const inner = v.slice(v.indexOf("[") + 1, v.lastIndexOf("]"));
      matrix[curVar] = inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (!v) { blockSeq = true; }
  }
  return matrix;
}

// Expand ${{ matrix.xxx }} expressions in a name template using the given matrix.
// Returns the expanded names list, or null if any referenced variable is absent from the matrix.
function expandMatrix(template: string, matrix: Record<string, string[]>): string[] | null {
  const refs = [...template.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g)];
  if (!refs.length) return [template];
  let results = [template];
  for (const ref of refs) {
    const values = matrix[ref[1]];
    if (!values?.length) return null;
    results = results.flatMap(r => values.map(v => r.replace(ref[0], v)));
  }
  return results;
}

// Line-oriented extraction of the job names under a workflow's top-level `jobs:` key — a job's display
// `name:` (one nesting level below the job key) wins over the key. NOT a YAML parser: a deterministic
// heuristic good enough for candidate merge checks (step-level `name:` lines start with `- ` and are
// deeper than the accepted indent window, so they never match).
// Trigger-aware: workflows not triggered by push/pull_request/pull_request_target are silently skipped —
// they never produce PR check contexts so their job names would be phantom mergeChecks.
// Matrix-aware: a job name containing ${{ matrix.xxx }} is expanded from the job's static matrix values;
// if the values cannot be read statically, the name is omitted and a warning is printed (filename arg).
export function workflowJobNames(text: string, filename = ""): string[] {
  // Only emit check names from workflows that can produce PR-visible check contexts (LOOP-5).
  if (![...workflowTriggers(text)].some(t => PR_TRIGGERS.has(t))) return [];

  const lines = text.split(/\r?\n/);
  const jobs: Array<{ name: string; key: string; start: number; end: number }> = [];
  let inJobs = false, jobIndent = -1;
  let cur: { name: string; key: string; start: number } | null = null;
  let curNamed = false;

  const closeJob = (end: number) => { if (cur) { jobs.push({ ...cur, end }); cur = null; curNamed = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):/); // any new top-level key ends the jobs block
    if (top) { closeJob(i); inJobs = top[1] === "jobs"; jobIndent = -1; continue; }
    if (!inJobs || !line.trim()) continue;
    const m = line.match(/^([ \t]+)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, ind, key, val] = m;
    const indent = ind.length;
    if (jobIndent < 0) jobIndent = indent; // the first key under jobs: fixes the job indent level
    if (indent === jobIndent) {
      closeJob(i);
      cur = { name: key, key, start: i + 1 };
      curNamed = false;
    } else if (cur && !curNamed && key === "name" && indent > jobIndent && indent <= jobIndent + 4 && val.trim()) {
      cur.name = val.trim().replace(/^["']|["']$/g, "");
      curNamed = true;
    }
  }
  closeJob(lines.length);

  const result: string[] = [];
  for (const { name, key, start, end } of jobs) {
    if (/\$\{\{/.test(name)) {
      const mat = scanJobMatrix(lines, start, end, jobIndent);
      const expanded = expandMatrix(name, mat);
      if (!expanded) {
        // Cannot expand statically — warn so the operator knows to set mergeChecks by hand.
        if (filename) console.warn(`dev-loop detect: ${filename}: job '${key}' name '${name}' has unexpandable matrix expression — add mergeChecks manually`);
      } else {
        result.push(...expanded);
      }
    } else {
      result.push(name);
    }
  }
  return result;
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

// ── remove-project ────────────────────────────────────────────────────────────
// `dev-loop team remove-project <key> [--force] [--dry-run]`
// Recoverable-only by default: refuses if the project has tickets or repos. `--force` bypasses.
// `--dry-run` reports what WOULD happen and mutates nothing. Handles the db-only case (key in hub but
// absent from config). Never removes _team / reserved.
//
// The preview DERIVES from the same facts the live guard consumes — it never re-derives the decision
// (LOOP-290). A dry-run that computed "would it refuse?" separately would keep reporting the old answer
// the first time someone edited the guard, and this command's whole reason to exist is being trusted
// before an irreversible 10-table cascade delete.
export function removeProject(argv: string[]): number {
  const [key, ...rest] = argv;
  const usage = "usage: dev-loop team remove-project <key> [--force] [--dry-run] [--i-understand-this-deletes-<key>]";
  if (!key || key.startsWith("--")) die(usage);
  if (isTeamProject(key)) die(`'${key}' is a reserved project key and cannot be removed`, 1);
  const force = rest.includes("--force");
  const dryRun = rest.includes("--dry-run");
  const token = confirmationToken(key);
  // Reject anything else rather than ignoring it. Reading only `rest.includes("--force")` meant a typo
  // one keystroke away from the real flag (`--dryrun`, `--dry_run`) fell straight through to the LIVE
  // cascade — the exact hazard that produced LOOP-286. Matches addProject's `else die("unknown option")`.
  for (const a of rest) {
    if (a === "--force" || a === "--dry-run" || a === token) continue;
    // The token is accepted by EXACT equality only. Accepting it by prefix would let
    // `--i-understand-this-deletes-anything` through and make the naming token name nothing (LOOP-305).
    // A token-shaped argument for a DIFFERENT project is an operator mistake worth naming precisely —
    // falling through to the generic `unknown option` would hide which half of it was wrong.
    if (a.startsWith(TOKEN_PREFIX))
      die(`confirmation token '${a}' names a different project than '${key}' — expected ${token}`);
    die(`unknown option '${a}'\n${usage}`);
  }

  const ws = resolveWorkspace();
  const inConfig = key in (ws.file.projects ?? {});

  let inDb = false, projectId: string | null = null;
  let db: ReturnType<typeof openDb> | undefined;
  // dbUnverifiable: service backend + the hub.db file is PRESENT but we could not read it (openDb or the
  // project lookup threw — busy past busy_timeout, corrupt, permission denied). We then cannot know the
  // ticket count, and an unreadable db is exactly when a silent config-only removal would orphan a
  // project's live tickets — so fail CLOSED below, never treat it as 0 tickets. Distinct from "db absent"
  // and "db opened but project genuinely not present", both real 0-ticket cases that stay removable. (LOOP-280)
  let dbUnverifiable = false;
  if (ws.file.team.backend === "service") {
    const dbPath = wsHubDb(ws);
    if (existsSync(dbPath)) {
      // Defense in depth on a preview: `query_only=ON` makes "mutates nothing" true at the SQLite layer,
      // not merely by reaching the early return below. Set before the first read, so no code path between
      // open and return can write. A failure to set it is treated exactly like an unreadable db.
      try {
        db = openDb(dbPath);
        if (dryRun) db.exec("PRAGMA query_only=ON");
        projectId = findProject(db, key); inDb = projectId !== null;
      }
      catch { dbUnverifiable = true; /* present but unreadable — refuse below unless --force */ }
    }
  }

  // Fail closed on an unverifiable db BEFORE the not-found check, so the message names the real cause
  // (unreadable, not "not found") and no removal happens without a deliberate --force override. (LOOP-280)
  // A dry-run does not die here — it REPORTS the same refusal below. It must never mask an unreadable db
  // as "0 tickets", which is the one way a preview could talk an operator into a destructive run.
  if (!dryRun && dbUnverifiable && !force)
    die(`project '${key}': hub.db is present but could not be opened to verify its ticket count — refusing to remove (pass --force to override); an unreadable db is when a silent removal would orphan live tickets`, 1);

  // Runs for BOTH paths: a preview of a nonexistent key must error where the real thing errors.
  if (!inConfig && !inDb && !dbUnverifiable) { db?.close(); die(`project '${key}' not found in config or hub db`, 1); }

  // ── the read-only facts, computed ONCE and shared by the preview and the live guard ────────────
  // ticketCount stays null when there is no project row to count, or when the count query itself failed;
  // countFailed distinguishes the second case, which is a refusal reason and never a zero.
  let ticketCount: number | null = null;
  let countFailed = false;
  if (db && projectId) {
    try { ticketCount = (db.prepare("SELECT count(*) c FROM tickets WHERE project_id=?").get(projectId) as { c: number }).c; }
    catch { countFailed = true; }
  }
  const repoCount = inConfig ? (ws.file.projects[key].repos ?? []).length : 0;
  // The guard decision as data. Identical inputs to the live `die`s below, so the preview cannot drift
  // from them: whatever makes the live path refuse is what makes the preview say WOULD REFUSE.
  const refuseReason = dbUnverifiable ? "hub.db unreadable"
    : countFailed ? "hub.db ticket-count query failed"
    : (ticketCount ?? 0) > 0 ? `${ticketCount} ticket(s)`
    : repoCount > 0 ? `${repoCount} repo(s)`
    : null;
  // The ISOLATION gate (LOOP-305), computed here — after the read-only facts, before the dry-run branch —
  // so the preview and the live path consume ONE verdict object and cannot drift. Everything above this
  // point is a pure read (config load, findProject, a count(*)), so no effect can precede the gate, and the
  // existing error precedence (reserved key → unreadable db → not-found) is unchanged: the operator still
  // gets the most specific message first.
  const isolation = isolationVerdict(ws, key, rest);

  if (dryRun) {
    const dbLine = dbUnverifiable ? "UNREADABLE (would refuse without --force)"
      : !db ? "absent"
      : projectId === null ? "project row absent"
      : countFailed ? `project_id=${projectId}, ticket count UNVERIFIABLE (would refuse without --force)`
      : `project_id=${projectId}, ${ticketCount} ticket(s)`;
    console.log(`dry-run: remove-project '${key}' would:`);
    console.log(`  config : ${inConfig ? "present" : "absent"}`);
    console.log(`  hub.db : ${dbLine}`);
    console.log(`  repos  : ${repoCount}`);
    // Derived from the same verdict object the live path enforces, never recomputed. The third form
    // (NOT scratch, token supplied) exists because a preview that said "needs <token>" to an operator who
    // had already passed it would be misleading in exactly the way this command must never be.
    console.log(`  isolation : ${isolation.scratch ? "scratch (no token needed)"
      : isolation.tokenPresent ? `NOT scratch — ${isolation.requiredToken} present`
      : `NOT scratch — needs ${isolation.requiredToken}`}`);
    // BOTH refusal reasons are reported, on separate lines, in the order the live path enforces them. An
    // operator who reads one reason, satisfies it, and re-runs straight into the second has been misled by
    // the preview — and being trusted before an irreversible cascade is this command's entire reason to exist.
    const wouldRefuseCount = !!refuseReason && !force;
    if (isolation.refusal || wouldRefuseCount) {
      if (isolation.refusal) console.log(`  → WOULD REFUSE (not a scratch project; needs ${isolation.requiredToken})`);
      if (wouldRefuseCount) console.log(`  → WOULD REFUSE (${refuseReason}; needs --force)`);
    } else {
      const targets = [inConfig ? "the config key" : null, db && projectId ? "the hub.db rows (10-table cascade)" : null]
        .filter(Boolean).join(" + ");
      console.log(`  → WOULD PROCEED — delete ${targets || "nothing (already absent)"}${refuseReason ? ` [--force overrides: ${refuseReason}]` : ""}`);
    }
    db?.close();
    console.log("REMOVE_PROJECT_DRYRUN_OK");
    return 0;   // ← zero writes: no mutate(), no DELETE
  }

  // The isolation gate fires BEFORE the recoverability guard and before every write (LOOP-305). Order is
  // deliberate: "did you mean this project?" must be answered before "is this project recoverable?", so an
  // operator who reaches for --force to get past the count guard still has to name the target.
  if (isolation.refusal) { db?.close(); die(isolation.refusal, 1); }

  if (!force) {
    if (db && projectId) {
      if (countFailed) { db.close(); die(`project '${key}': hub.db ticket-count query failed — refusing to remove (pass --force to override)`, 1); }
      if ((ticketCount ?? 0) > 0) { db.close(); die(`project '${key}' has ${ticketCount} ticket(s) — pass --force to remove anyway`, 1); }
    }
    if (repoCount > 0) {
      db?.close();
      die(`project '${key}' has ${repoCount} repo(s) — pass --force to remove anyway`, 1);
    }
  }

  // ── the two halves, through ONE commit (LOOP-306) ────────────────────────────────────────────
  // Deliberately NOT through `mutate()`: mutate writes the file itself, so routing the config half
  // through it would put the write outside the joint commit. It also calls `resolveWorkspace()` a
  // SECOND time, and `delete file.projects[key]` on that second read is a silent no-op if the key is
  // already gone — validation passes, the file is rewritten identically, and the success line prints
  // for a write that changed nothing. Computing from the `ws` we already resolved removes that seam.
  // `mutate()` is unchanged for every other mutator; this is not a refactor of the config layer.
  let configText: string | null = null;
  if (inConfig) {
    const file: TeamFile = JSON.parse(JSON.stringify(ws.file));
    delete file.projects[key];
    const { errors } = validateTeamFile(file);
    // Validation failure still dies before ANYTHING is touched — same precedence as mutate()'s.
    if (errors.length) { db?.close(); die("the edit would make dev-loop.json invalid:\n" + errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"), 1); }
    configText = JSON.stringify(file, null, 2) + "\n";
  }
  // Cascade delete child rows (FK-safe order) before removing the project row. Runs INSIDE the
  // transaction commitBothHalves opens — the ten statements were previously un-transacted, so a
  // failure partway through left the project row present with its children already gone.
  const dbWork = db && projectId
    ? () => {
        db.prepare("DELETE FROM channel_messages WHERE channel_id IN (SELECT id FROM channels WHERE project_id=?)").run(projectId);
        db.prepare("DELETE FROM channels WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM labels WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM document_versions WHERE doc_id IN (SELECT id FROM documents WHERE project_id=?)").run(projectId);
        db.prepare("DELETE FROM documents WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM events WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM mirror_map WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM comments WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=?)").run(projectId);
        db.prepare("DELETE FROM tickets WHERE project_id=?").run(projectId);
        db.prepare("DELETE FROM projects WHERE key=?").run(key);
        // LOOP-307 (design Child C): the tombstone rides THIS closure so it commits or rolls back
        // with the cascade — a tombstone without the deletion, or a deletion without the tombstone,
        // would each be worse than neither. ensureProject consults it before any re-INSERT.
        db.prepare(
          "INSERT OR REPLACE INTO removed_projects(key,removed_at,removed_by,ticket_count,verb) VALUES (?,?,?,?,?)",
        ).run(key, new Date().toISOString(), process.env.DEVLOOP_ACTOR ?? "unknown", ticketCount ?? 0, "remove-project");
      }
    : null;
  try {
    // LOOP-339 trigger 2 — remove-project is the verb that destroyed the board on 2026-08-04.
    // Fail-closed: if the copy cannot be taken, the delete does not happen.
    const backupCfg = resolveBackupConfig(ws.file.team as Parameters<typeof resolveBackupConfig>[0], wsStateRoot(ws));
    commitBothHalves({
      configPath: ws.filePath, configText, db, dbWork,
      preSnapshot: () => snapshotBeforeDestructive({ dbPath: wsHubDb(ws), dir: backupCfg.dir, keep: backupCfg.keep, verb: "remove-project" }),
    });
  } catch (e) {
    // Rethrow the message VERBATIM. commitBothHalves already states what each half's actual state is;
    // wrapping it in a summary of our own ("nothing was changed") would be a claim this frame cannot
    // make — the combined-failure arm exists precisely because that claim is sometimes false.
    db?.close();
    die(`remove-project '${key}': ${(e as Error).message}`, 1);
  }
  // Announced only after BOTH halves are durable. Each half printing its own line as it went is the
  // defect: it let the CLI report a config write that had not happened. (LOOP-302 ②)
  if (inConfig) console.log(`removed project '${key}' from dev-loop.json`);
  if (db && projectId) console.log(`removed project '${key}' from hub.db`);
  db?.close();
  if (!inConfig) console.log(`note: '${key}' was db-only (not in dev-loop.json)`);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "add-project") process.exit(await addProject(rest));
  if (sub === "add-repo") process.exit(addRepo(rest));
  if (sub === "set") process.exit(await teamSet(rest));
  if (sub === "add-provider") process.exit(addProvider(rest));
  if (sub === "remove-project") process.exit(removeProject(rest));
  console.error("usage: team-edit add-project|add-repo|set|add-provider|remove-project …"); process.exit(2);
}

// ── set-model ─────────────────────────────────────────────────────────────────
// `dev-loop team set-model <agent> <model> [--project <key>] [--coding-agent c] [--effort e] [--team-default]`
// The one-command model switch (1.8; field origin: the 2026-07 Qwen→Gemini hot-swap was five hand
// edits + a sync + a restart, and the operator mis-killed processes in between). Writes the validated
// config (projects.<key>.agents.<agent> — or codingAgentDefaults with --team-default), re-syncs
// opencode.json when the model's provider prefix is a team.providers entry, and prints the restart
// pointer. Model strings are the launch values run-agents resolves (opencode: provider/model-id).
export async function setModel(argv: string[]): Promise<number> {
  const HANDLES = new Set<string>(AGENT_HANDLES);
  let project: string | undefined; let codingAgent: string | undefined; let effort: string | undefined;
  let teamDefault = false;
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--project") project = next();
    else if (a === "--coding-agent") codingAgent = next();
    else if (a === "--effort") effort = next();
    else if (a === "--team-default") teamDefault = true;
    else if (a === "--help" || a === "-h") { console.log("usage: dev-loop team set-model <agent> <model> [--project <key>] [--coding-agent claude|codex|opencode] [--effort E] [--team-default]"); return 0; }
    else if (a.startsWith("--")) die(`unknown option '${a}'`);
    else pos.push(a);
  }
  const [agent, model] = pos;
  if (!agent || !model || pos.length > 2) die("usage: dev-loop team set-model <agent> <model> [--project <key>] [--coding-agent c] [--effort e] [--team-default]");
  if (!teamDefault && !HANDLES.has(agent)) die(`unknown agent '${agent}' — one of ${AGENT_HANDLES.join(", ")} (or use --team-default with a coding agent)`);
  if (codingAgent !== undefined && !["claude", "codex", "opencode"].includes(codingAgent)) die("--coding-agent must be claude, codex, or opencode");

  const ws = mutate((file) => {
    if (teamDefault) {
      const ca = codingAgent ?? "opencode";
      const t = file.team as TeamFile["team"] & { codingAgentDefaults?: Record<string, { model?: string; effort?: string }> };
      t.codingAgentDefaults = t.codingAgentDefaults ?? {};
      t.codingAgentDefaults[ca] = { ...t.codingAgentDefaults[ca], model, ...(effort !== undefined ? { effort } : {}) };
      return;
    }
    const keys = Object.keys(file.projects);
    const key = project ?? (keys.length === 1 ? keys[0] : undefined);
    if (!key) die(`--project <key> is required (workspace has ${keys.length} projects: ${keys.join(", ")})`);
    const p = file.projects[key] as (typeof file.projects)[string] & { agents?: Record<string, { codingAgent?: string; model?: string; effort?: string }> };
    if (!p) die(`project '${key}' does not exist`);
    p.agents = p.agents ?? {};
    p.agents[agent] = { ...p.agents[agent], model,
      ...(codingAgent !== undefined ? { codingAgent } : {}), ...(effort !== undefined ? { effort } : {}) };
  });

  const target = teamDefault ? `team.codingAgentDefaults.${codingAgent ?? "opencode"}` : `projects.*.agents.${agent}`;
  console.log(`set ${target}.model = ${model}${effort !== undefined ? ` (effort ${effort})` : ""}`);
  // A registry-provider model prefix means opencode.json must carry the provider — re-render it here
  // so the operator never ships a model the fires cannot resolve (the OPENCODE_CONFIG injection makes
  // the workspace file authoritative for fires since 1.6.0).
  const prefix = model.includes("/") ? model.split("/")[0] : null;
  if (prefix && ws.file.team.providers && ws.file.team.providers[prefix]) {
    const { syncOpencodeCmd } = await import("./opencode-sync.ts");
    const rc = syncOpencodeCmd([]);
    if (rc !== 0) console.error("warning: opencode.json sync failed — run `dev-loop team sync-opencode` by hand");
  }
  console.log("restart the scheduler to pick it up: `dev-loop stop && dev-loop run --background …` (the startup model preflight will verify it resolves)");
  return 0;
}
