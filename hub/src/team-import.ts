#!/usr/bin/env node
// `dev-loop team import` — one-shot v1→v2 migration INTO an existing workspace (design impl §4.2).
// Runtime never reads v1 config (the 1.0 clean break); this command is the ONLY bridge. It reads a legacy
// projects.json, folds the selected projects into the current workspace's dev-loop.json (registry + virtual
// projects), moves their state dirs under <ws>/.dev-loop/, splits lessons.md into the lessons library, and
// (with --hub-db) copies each project's hub rows — re-keying AUTOINCREMENT events so ids never collide.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, cpSync, realpathSync } from "node:fs";
import { join, resolve, basename, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsProjectDir, wsLessonsDir, wsHubDb, ensureStateDirs } from "./workspace.ts";
import { normalizedRel, validateTeamFile, type TeamFile, type RepoEntry, type ProjectEntry, type Workspace } from "./team-config.ts";
import { projectConfigCandidates, devloopDataDir } from "./paths.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop team import: ${msg}`); process.exit(code); }
const log = (m: string) => console.log(m);

interface Opts { from?: string; projects: string[]; renames: Record<string, string>; hubDb?: string; dryRun: boolean }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { projects: [], renames: {}, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--from") o.from = resolve(next());
    else if (a === "--project") o.projects.push(next());
    else if (a === "--rename") { const [k, v] = next().split("="); if (!k || !v) die("--rename expects old=new"); o.renames[k] = v; }
    else if (a === "--hub-db") o.hubDb = resolve(next());
    else if (a === "--dry-run") o.dryRun = true;
    else die(`unknown option '${a}'`);
  }
  return o;
}

function usage(): void {
  console.log(`dev-loop team import — fold a legacy projects.json into the current workspace (one-shot)

Usage (run from inside the workspace created by \`dev-loop team init\`):
  dev-loop team import [--from <projects.json>] [--project <key>]... [--rename old=new]... [--hub-db <old-hub.db>] [--dry-run]

  --from <path>       legacy config (default: ~/.dev-loop/projects.json + the usual candidates)
  --project <key>     import only this project (repeatable; default: all)
  --rename old=new    import project 'old' under the new key 'new'
  --hub-db <path>     also copy the project's hub rows from this old db (events are re-keyed)
  --dry-run           print the full plan; change nothing`);
}

interface V1Project {
  backend?: string; repoPath?: string; repos?: Array<{ path?: string; role?: string; name?: string } & Record<string, unknown>>;
  strategyDoc?: unknown; testEnv?: unknown; devSplit?: boolean; linearProject?: string; linearProjectId?: string;
  agents?: unknown; models?: unknown; efforts?: unknown; defaultCodingAgent?: unknown; codingAgentDefaults?: unknown;
  landing?: unknown; autoMerge?: unknown; mergeChecks?: unknown; build?: unknown; deploy?: unknown; ops?: unknown;
}

function readV1(from: string | undefined): { path: string; cfg: { projects?: Record<string, V1Project> } } {
  const candidates = from ? [from] : projectConfigCandidates(devloopDataDir());
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try { return { path: p, cfg: JSON.parse(readFileSync(p, "utf8")) }; }
    catch (e) { die(`could not parse ${p}: ${(e as Error).message}`, 1); }
  }
  die(`no legacy projects.json found (looked at: ${candidates.join(", ")})`, 1);
}

// One v1 project's repo list → registry entries (register new refs; MERGE fields an existing entry
// lacks — registry-wins on conflict, §4.2) + the project's ref list. Extracted from the teamImport
// main loop (1.8.1 quality-gauntlet drain: CC 81 → phase functions).
function importRepoRefs(
  v1p: Record<string, unknown> & { repos?: Array<{ path?: string; name?: string; role?: string }>; repoPath?: string },
  srcKey: string, key: string, ws: Workspace, file: TeamFile,
  refFor: Map<string, string>, plan: string[],
): Array<{ ref: string; role?: string }> {
  const rawRepos = v1p.repos?.length ? v1p.repos : (v1p.repoPath ? [{ path: v1p.repoPath, role: "primary" }] : []);
  const refs: Array<{ ref: string; role?: string }> = [];
  for (const r of rawRepos) {
      const absOrRel = r.path ?? "";
      // Canonicalize so a /tmp vs /private/tmp (or any symlink) mismatch doesn't misflag an in-workspace
      // repo as "outside". ws.root is already realpath-canonical (resolveWorkspace).
      const absRaw = isAbsolute(absOrRel) ? absOrRel : join(ws.root, absOrRel);
      const abs = canon(absRaw) ?? absRaw;
      const inside = isAbsolute(absOrRel) ? normalizedRel(relOrNull(ws.root, abs) ?? "") : normalizedRel(absOrRel);
      let ref = r.name || basename(abs) || key;
      while (refFor.has(ref) && refFor.get(ref) !== abs) ref = `${key}-${ref}`; // de-collide across projects
      refFor.set(ref, abs);
      if (!file.repos[ref]) {
        const entry: RepoEntry = { path: inside ?? basename(abs) };
        const entryBag = entry as unknown as Record<string, unknown>;
        for (const f of ["landing", "autoMerge", "mergeChecks", "build", "deploy", "ops"] as const) {
          const v = (r as Record<string, unknown>)[f] ?? (v1p as Record<string, unknown>)[f];
          if (v !== undefined) entryBag[f] = v;
        }
        file.repos[ref] = entry;
        if (!inside) plan.push(`MOVE  repo '${ref}' is OUTSIDE the workspace (${abs}); registered at '${entry.path}'. Run:  mv ${abs} ${join(ws.root, entry.path)}`);
      } else {
        // The ref is already registered (add-repo earlier, or a repo shared across imported projects).
        // Physical fields live ONCE on the registry (§4.2): MERGE each v1 field the entry LACKS (a bare
        // add-repo registration followed by an import must not lose build/deploy facts — they'd land
        // nowhere and fires would run with no gates); a CONFLICTING value is kept registry-wins + surfaced.
        const existing = file.repos[ref] as unknown as Record<string, unknown>;
        const conflicts: string[] = [];
        for (const f of ["landing", "autoMerge", "mergeChecks", "build", "deploy", "ops"] as const) {
          const v = (r as Record<string, unknown>)[f] ?? (v1p as Record<string, unknown>)[f];
          if (v === undefined) continue;
          if (existing[f] === undefined) { existing[f] = v; plan.push(`MERGE  repo '${ref}': adopted ${f} from project '${srcKey}' (registry entry lacked it)`); }
          else if (JSON.stringify(v) !== JSON.stringify(existing[f])) conflicts.push(f);
        }
        if (conflicts.length) plan.push(`WARN  repo '${ref}' already registered — project '${srcKey}' carried DIFFERENT ${conflicts.join("/")}; kept the registry values (physical facts live once, §4.2). Review manually if intentional.`);
      }
      refs.push({ ref, role: r.role });
    }
  return refs;
}

// Sanitize the v1 communication/notify blocks onto the v2 project (E14/E15 strict keys; §16 inline
// secrets never copied) and lift a usable env-name notify into team.comms when comms is unset.
function importCommsBlocks(
  v1p: Record<string, unknown>, srcKey: string, projBag: Record<string, unknown>,
  file: TeamFile, plan: string[],
): void {
    // communication: v1 blocks may carry keys the v2 schema doesn't model (E14 validates the block
    // STRICTLY — the silent-suppression guard). Keep the known article fields and drop the rest with a
    // plan line; the block itself is kept even when emptied — its PRESENCE is what opts article drafting
    // in, and an import must not silently turn that off. Import must always emit a VALID dev-loop.json.
    const comm = projBag.communication;
    if (comm && typeof comm === "object" && !Array.isArray(comm)) {
      const KNOWN_COMM = new Set(["cadence", "language", "audience", "tone", "maxWords", "sourceWindowDays", "output", "outputDir", "repoOutputDir", "includeUnreleased"]);
      const kept: Record<string, unknown> = {};
      const dropped: string[] = [];
      for (const [f, v] of Object.entries(comm as Record<string, unknown>)) { if (KNOWN_COMM.has(f)) kept[f] = v; else dropped.push(f); }
      if (dropped.length) plan.push(`COMMUN project '${srcKey}': unknown communication key(s) ${dropped.join(", ")} NOT copied (E14 validates the block strictly; fields: references/config-schema.md)`);
      projBag.communication = kept;
    }
    // notify: lift the env-name form to team.comms (the v2 canonical channel) when comms is unset; keep an
    // env-name notify as a project passthrough for the legacy daemon path; NEVER copy an inline webhook/secret
    // literal into dev-loop.json (§16/I5 — the workspace folder must stay copyable with zero secrets).
    const notify = (v1p as { notify?: Record<string, unknown> }).notify;
    if (notify && typeof notify === "object") {
      const clean: Record<string, unknown> = { ...notify };
      const stripped: string[] = [];
      if (typeof clean.webhook === "string") { delete clean.webhook; stripped.push("webhook"); }
      if (typeof clean.secret === "string") { delete clean.secret; stripped.push("secret"); }
      if (stripped.length) plan.push(`NOTIFY project '${srcKey}': inline ${stripped.join("+")} NOT copied into dev-loop.json (§16/I5) — export the value in an env var and set notify.webhookEnv/secretEnv instead`);
      // E15 validates the passthrough strictly: keep only the keys the v2 schema models, with a plan line
      // for anything dropped (same shape as the communication sanitize above).
      const KNOWN_NOTIFY = new Set(["type", "webhookEnv", "secretEnv", "events"]);
      const junk = Object.keys(clean).filter((f) => !KNOWN_NOTIFY.has(f));
      for (const f of junk) delete clean[f];
      if (junk.length) plan.push(`NOTIFY project '${srcKey}': unknown notify key(s) ${junk.join(", ")} NOT copied (E15 validates the block strictly)`);
      // Only keep a passthrough notify that is still USABLE (has an env-name webhook AND a provider the
      // daemon can send over — resolveNotifyWebhook is slack/lark-only). A stripped husk ({type} with no
      // webhookEnv) would suppress the team.comms bridge in toLegacyView while itself resolving to
      // nothing — permanently killing human-park pings for this project.
      if (typeof clean.webhookEnv === "string" && (clean.type === "slack" || clean.type === "lark")) projBag.notify = clean;
      else if (typeof clean.webhookEnv === "string") plan.push(`NOTIFY project '${srcKey}': provider '${String(clean.type)}' is not slack/lark — the notify block resolves to nothing and was NOT copied (team.comms will bridge instead)`);
      const envName = notify.webhookEnv;
      if (!file.team.comms && (notify.type === "slack" || notify.type === "lark") && typeof envName === "string" && /^[A-Z][A-Z0-9_]*$/.test(envName)) {
        file.team.comms = { provider: notify.type, webhookEnv: envName };
        plan.push(`COMMS  team.comms ← project '${srcKey}' notify (${notify.type}, env ${envName})`);
      }
    }
}

export function teamImport(argv = process.argv.slice(2)): number {
  const o = parseArgs(argv);
  const ws = resolveWorkspace(); // throws WsNotFound if there is no workspace here — the operator must `team init` first
  const { path: v1Path, cfg: v1 } = readV1(o.from);
  const allKeys = Object.keys(v1.projects ?? {});
  const selected = o.projects.length ? o.projects : allKeys;
  for (const k of selected) if (!(k in (v1.projects ?? {}))) die(`--project '${k}' not found in ${v1Path} (has: ${allKeys.join(", ")})`);

  const teamBackend = ws.file.team.backend;
  const plan: string[] = [];
  const file: TeamFile = JSON.parse(JSON.stringify(ws.file)); // mutate a copy; write once at the end
  const refFor = new Map<string, string>();

  for (const srcKey of selected) {
    const key = o.renames[srcKey] ?? srcKey;
    const v1p = v1.projects![srcKey];
    if (v1p.backend && v1p.backend !== teamBackend)
      die(`project '${srcKey}' is backend:'${v1p.backend}' but the team backend is '${teamBackend}' — one team, one backend (I3). Import it into a separate ${v1p.backend} workspace.`);
    // linearTeam is re-homed to the TEAM level — a mismatch would silently re-target every ticket to the
    // workspace's team, so it is a hard stop (same shape as the backend-mismatch guard above).
    const v1Team = (v1p as { linearTeam?: string }).linearTeam;
    if (teamBackend === "linear" && v1Team && ws.file.team.linearTeam && v1Team !== ws.file.team.linearTeam)
      die(`project '${srcKey}' is linearTeam:'${v1Team}' but this workspace is team '${ws.file.team.linearTeam}' — import it into a workspace for that Linear team instead.`);
    if (file.projects[key]) die(`project '${key}' already exists in the workspace dev-loop.json; use --rename`);

    const refs = importRepoRefs(v1p as never, srcKey, key, ws, file, refFor, plan);

    const proj: ProjectEntry = { repos: refs };
    const projBag = proj as unknown as Record<string, unknown>;
    // Generic passthrough: EVERY v1 project field survives except the ones this import re-homes (physical
    // repo facts → the registry; backend/linearTeam → team; notify → handled below). A whitelist here
    // silently dropped operator config (blockedStateName, communication, …) — never again.
    const REHOMED = new Set(["repoPath", "repos", "backend", "linearTeam", "notify", "landing", "autoMerge", "mergeChecks", "build", "deploy", "ops"]);
    for (const [f, v] of Object.entries(v1p as Record<string, unknown>)) {
      if (!REHOMED.has(f) && v !== undefined) projBag[f] = v;
    }
    importCommsBlocks(v1p as Record<string, unknown>, srcKey, projBag, file, plan);

    file.projects[key] = proj;
    plan.push(`CONFIG project '${srcKey}'${key !== srcKey ? ` → '${key}'` : ""}: ${refs.length} repo ref(s) [${refs.map((r) => r.ref).join(", ")}]`);

    // State dir move: ~/.dev-loop/<srcKey>/ → <ws>/.dev-loop/<key>/ ; lessons.md → lessons/<key>.md
    const oldStateDir = join(devloopDataDir(), srcKey);
    if (existsSync(oldStateDir)) plan.push(`STATE  mv ${oldStateDir} → ${wsProjectDir(ws, key)}`);
    const oldLessons = join(oldStateDir, "lessons.md");
    if (existsSync(oldLessons)) plan.push(`LESSON ${oldLessons} → ${join(wsLessonsDir(ws), `${key}.md`)}`);
    if (o.hubDb) plan.push(`HUBDB  copy project '${srcKey}' rows from ${o.hubDb} → ${wsHubDb(ws)} (events re-keyed)`);
  }

  // Validate the merged file BEFORE any mutation.
  const { errors } = validateTeamFile(file);
  if (errors.length) die("the merged dev-loop.json would be invalid:\n" + errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"), 1);

  log(`dev-loop team import — from ${v1Path} into workspace '${ws.file.team.key}' @ ${ws.root}`);
  for (const line of plan) log("  " + line);

  if (o.dryRun) { log("\n(--dry-run: nothing changed)"); return 0; }

  // Execute. Config first (the source of truth), then best-effort filesystem moves.
  writeFileSync(ws.filePath, JSON.stringify(file, null, 2) + "\n");
  ensureStateDirs(ws);
  for (const srcKey of selected) {
    const key = o.renames[srcKey] ?? srcKey;
    const oldStateDir = join(devloopDataDir(), srcKey);
    const oldLessons = join(oldStateDir, "lessons.md");
    if (existsSync(oldLessons)) { mkdirSync(wsLessonsDir(ws), { recursive: true }); try { cpSync(oldLessons, join(wsLessonsDir(ws), `${key}.md`)); } catch { /* best-effort */ } }
    if (existsSync(oldStateDir) && !existsSync(wsProjectDir(ws, key))) { try { renameSync(oldStateDir, wsProjectDir(ws, key)); } catch { try { cpSync(oldStateDir, wsProjectDir(ws, key), { recursive: true }); } catch { /* leave in place */ } } }
    if (o.hubDb) copyHubRows(o.hubDb, wsHubDb(ws), srcKey, key);
  }
  const movedNeeded = plan.some((l) => l.startsWith("MOVE"));
  log(`\nwrote ${ws.filePath}`);
  if (movedNeeded) { log("Some repos are outside the workspace — run the printed `mv` commands, then `dev-loop doctor`."); return 1; }
  log("Run `dev-loop doctor` to verify, then `/dev-loop:sync-project` to reconcile backend ids.");
  return 0;
}

// Copy one project's rows old→new hub db. TEXT-id tables copy as-is (prefix uniqueness guarded by seed);
// events.id is AUTOINCREMENT, so re-insert ORDERED BY the old id WITHOUT the id (ids are re-assigned by the
// new db; order preserved). Runs inside the new db via ATTACH.
function copyHubRows(oldDb: string, newDb: string, srcKey: string, newKey: string): void {
  if (!existsSync(oldDb)) { console.error(`  [hubdb] ${oldDb} not found; skipping row copy`); return; }
  const { openDb } = dbmod;
  const db = openDb(newDb);
  try {
    db.exec(`ATTACH DATABASE '${oldDb.replace(/'/g, "''")}' AS old`);
    const srcId = (db.prepare("SELECT id FROM old.projects WHERE key=?").get(srcKey) as { id?: string } | undefined)?.id;
    if (!srcId) { console.error(`  [hubdb] project '${srcKey}' not in ${oldDb}; skipping`); db.exec("DETACH DATABASE old"); return; }
    // Ensure the destination project row exists (created here with the NEW key, preserving its own id space).
    let dstId = (db.prepare("SELECT id FROM projects WHERE key=?").get(newKey) as { id?: string } | undefined)?.id;
    if (!dstId) {
      const src = db.prepare("SELECT * FROM old.projects WHERE id=?").get(srcId) as Record<string, unknown>;
      const cols = Object.keys(src);
      db.prepare(`INSERT INTO projects(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => c === "key" ? newKey : src[c] as never));
      dstId = String(src.id);
    }
    // TEXT-id child tables → copy verbatim (INSERT OR IGNORE guards a re-run). events → re-key.
    for (const t of ["tickets", "documents", "labels"]) {
      try { db.exec(`INSERT OR IGNORE INTO ${t} SELECT * FROM old.${t} WHERE project_id='${srcId.replace(/'/g, "''")}'`); } catch (e) { console.error(`  [hubdb] ${t}: ${(e as Error).message}`); }
    }
    try {
      const cols = (db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((r) => r.name).filter((c) => c !== "id");
      db.exec(`INSERT INTO events(${cols.join(",")}) SELECT ${cols.join(",")} FROM old.events WHERE project_id='${srcId.replace(/'/g, "''")}' ORDER BY id`);
    } catch (e) { console.error(`  [hubdb] events: ${(e as Error).message}`); }
    db.exec("DETACH DATABASE old");
    console.error(`  [hubdb] copied rows for '${srcKey}' → '${newKey}'`);
  } finally { db.close(); }
}

function relOrNull(root: string, abs: string): string | null {
  const r = relative(root, abs);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : null;
}
const canon = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

import * as dbmod from "./db.ts";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(teamImport());
}
