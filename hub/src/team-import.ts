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
import { normalizedRel, validateTeamFile, type TeamFile, type RepoEntry, type ProjectEntry } from "./team-config.ts";
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
    if (file.projects[key]) die(`project '${key}' already exists in the workspace dev-loop.json; use --rename`);

    // Registry entries from repoPath / repos[].
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
      }
      refs.push({ ref, role: r.role });
    }

    const proj: ProjectEntry = { repos: refs };
    const projBag = proj as unknown as Record<string, unknown>;
    for (const f of ["strategyDoc", "testEnv", "devSplit", "linearProject", "linearProjectId", "agents", "models", "efforts", "defaultCodingAgent", "codingAgentDefaults"] as const) {
      const v = (v1p as Record<string, unknown>)[f];
      if (v !== undefined) projBag[f] = v;
    }
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
