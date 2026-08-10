#!/usr/bin/env node
// `dev-loop team import` — one-shot v1→v2 migration INTO an existing workspace (design impl §4.2).
// Runtime never reads v1 config (the 1.0 clean break); this command is the ONLY bridge. It reads a legacy
// projects.json, folds the selected projects into the current workspace's dev-loop.json (registry + virtual
// projects), COPIES their state dirs under <ws>/.dev-loop/, splits lessons.md into the lessons library, and
// (with --hub-db) copies each project's hub rows — re-keying AUTOINCREMENT events so ids never collide.
// The legacy tree is never modified and never deleted: the operator keeps running against it until the
// printed per-class report satisfies them, and removing it is a separate, explicit step (LOOP-473).
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, isAbsolute, relative } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsProjectDir, wsLessonsDir, wsHubDb, ensureStateDirs } from "./workspace.ts";
import { normalizedRel, validateTeamFile, type TeamFile, type RepoEntry, type ProjectEntry, type Workspace } from "./team-config.ts";
import { projectConfigCandidates, devloopDataDir } from "./paths.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop team import: ${msg}`); process.exit(code); }
const log = (m: string) => console.log(m);

interface Opts { from?: string; into?: string; projects: string[]; renames: Record<string, string>; hubDb?: string; dryRun: boolean }

function parseArgs(argv: string[]): Opts {
  const o: Opts = { projects: [], renames: {}, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? die(`${a} requires a value`);
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--from") o.from = resolve(next());
    else if (a === "--into") o.into = resolve(next());
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

Usage (run from inside the workspace created by \`dev-loop team init\`, or point at one with --into):
  dev-loop team import [--from <projects.json>] [--into <workspace-root>] [--project <key>]...
                       [--rename old=new]... [--hub-db <old-hub.db>] [--dry-run]

  --from <path>       legacy config (default: ~/.dev-loop/projects.json + the usual candidates)
  --into <root>       the destination workspace root (default: discovered upward from cwd). Seed one
                      first with \`dev-loop team init --dir <root> --backend <backend>\`; a project
                      keeps its own backend, so a linear project needs a linear workspace.
  --project <key>     import only this project (repeatable; default: all)
  --rename old=new    import project 'old' under the new key 'new'
  --hub-db <path>     also copy the project's hub rows from this old db (events are re-keyed)
  --dry-run           print the full plan; change nothing

The migration COPIES: the legacy tree is never modified and never deleted, an existing destination
file is never overwritten, and a re-run over an already-migrated project is a reported skip. Delete
the legacy tree yourself once the printed report says everything you need arrived.`);
}

interface V1Project {
  backend?: string; repoPath?: string; repos?: Array<{ path?: string; role?: string; name?: string } & Record<string, unknown>>;
  strategyDoc?: unknown; testEnv?: unknown; devSplit?: boolean; linearProject?: string; linearProjectId?: string;
  agents?: unknown; models?: unknown; efforts?: unknown; defaultCodingAgent?: unknown; codingAgentDefaults?: unknown;
  landing?: unknown; autoMerge?: unknown; mergeChecks?: unknown; build?: unknown; deploy?: unknown; ops?: unknown;
}

function readV1(from: string | undefined): { path: string; cfg: { projects?: Record<string, V1Project>; defaultProject?: string } } {
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

// ─── LOOP-472: the state migration is a COPY, per file class ─────────────────
// The legacy tree is live data the operator still runs against until they confirm this ran, so the
// three properties below are the whole point of the verb and are asserted, not assumed:
//   COPY       — the source is never renamed, written or deleted (removal is LOOP-473's job).
//   RE-RUNNABLE— an existing destination file is never overwritten; a second run is a reported skip.
//   LOUD       — a per-file failure is recorded and reported, and the verb exits non-zero. A
//                half-copied tree stays recoverable precisely because a re-run tops it up.
type FileClass = "lessons" | "reports" | "state-json" | "worktrees" | "other";

interface ClassStat { copied: number; skipped: number; failed: number }
type StateReport = Record<FileClass, ClassStat> & { failures: string[] };

function newReport(): StateReport {
  const z = (): ClassStat => ({ copied: 0, skipped: 0, failed: 0 });
  return { lessons: z(), reports: z(), "state-json": z(), worktrees: z(), other: z(), failures: [] };
}

const STATE_JSON_RE = /^[a-z0-9][a-z0-9-]*-state\.json$/;

// Which class a path INSIDE a project state dir belongs to. `rel` is always POSIX-joined by the
// walker below, so the prefix test is stable across platforms.
function classifyStatePath(rel: string): FileClass {
  if (rel === "lessons.md") return "lessons";
  const [head] = rel.split("/");
  if (head === "reports") return "reports";
  if (head === "wt") return "worktrees";
  if (!rel.includes("/") && STATE_JSON_RE.test(rel)) return "state-json";
  return "other";
}

// Copy ONE file, never overwriting. Returns what happened so the caller can class-count it, and — on
// a failure — the ORIGINAL error text: "copy failed" tells the operator nothing, while EACCES vs
// ENOSPC is the whole difference between the two things they would do next.
function copyFileOnce(src: string, dst: string): { outcome: "copied" | "skipped" | "failed"; error?: string } {
  if (existsSync(dst)) return { outcome: "skipped" }; // AC2 — destination content is never replaced
  try {
    mkdirSync(join(dst, ".."), { recursive: true });
    cpSync(src, dst); // cpSync on a file: content + mode, source untouched
    return { outcome: "copied" };
  } catch (e) { return { outcome: "failed", error: (e as Error).message }; }
}

// Walk `srcDir` and copy every file into `dstDir`, classifying as it goes.
//
// TWO reasons a class leaves the walk, and they must not share a counter (PR #286 review, P2).
// `notCarried` (worktrees) is left behind on purpose, so it is COUNTED — the report names the size of
// the gap rather than letting the operator find it after deleting the source. `handledElsewhere`
// (lessons.md, re-homed into the library by its own copy) has ALREADY been counted by that copy, so
// counting it again reported `1 copied, 1 skipped` for a clean first import and explained the skip as
// "the destination already existed" — untrue, and untrue in the per-class report the operator is told
// to read before deleting live data.
function copyClassified(srcDir: string, dstDir: string, rep: StateReport, notCarried: ReadonlySet<FileClass>, handledElsewhere: ReadonlySet<FileClass>, relBase = ""): void {
  let entries: string[];
  try { entries = readdirSync(srcDir); }
  catch (e) { rep.failures.push(`${srcDir}: ${(e as Error).message}`); rep.other.failed++; return; }
  for (const name of entries) {
    const rel = relBase ? `${relBase}/${name}` : name;
    const src = join(srcDir, name);
    let isDir: boolean;
    try { isDir = statSync(src).isDirectory(); }
    catch (e) { rep.failures.push(`${src}: ${(e as Error).message}`); rep.other.failed++; continue; }
    const cls = classifyStatePath(rel);
    if (handledElsewhere.has(cls)) continue;   // already copied AND already counted by its own pass
    if (notCarried.has(cls)) { if (!isDir) rep[cls].skipped++; else countTree(src, rep, cls); continue; }
    if (isDir) { copyClassified(src, join(dstDir, name), rep, notCarried, handledElsewhere, rel); continue; }
    const { outcome, error } = copyFileOnce(src, join(dstDir, name));
    rep[cls][outcome]++;
    if (outcome === "failed") rep.failures.push(`${cls}: ${src} → ${join(dstDir, name)}: ${error}`);
  }
}

// Count (never copy) the files under a deliberately-skipped subtree, so the report can name the size
// of what it left behind.
function countTree(dir: string, rep: StateReport, cls: FileClass): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let isDir: boolean;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) countTree(p, rep, cls); else rep[cls].skipped++;
  }
}

// The legacy layout writes a project's state under <dataDir>/<key>/, but the PRE-per-project form
// left <agent>-state.json at the dataDir ROOT. Those root files belong to the registry's
// `defaultProject` and to no other, so they are carried only for that project — and reported either
// way, because LOOP-473 deletes this tree and a silent drop is unrecoverable.
function rootStateFiles(dataDir: string): string[] {
  try { return readdirSync(dataDir).filter((n) => STATE_JSON_RE.test(n) && !statSync(join(dataDir, n)).isDirectory()); }
  catch { return []; }
}

// PROVENANCE — what makes a second run a RE-RUN rather than a collision (PR #286 review, P1).
//
// `file.projects[key]` already existing has two utterly different causes: this verb ran before (top
// up the missing files), or the destination workspace has an UNRELATED project under the same key
// (its state dir and lessons must not receive a stranger's files). The config alone cannot tell them
// apart, so the first import records where the project came from and the next run reads it back.
//
// Written BEFORE the copies, not after: AC4's recoverable state depends on a run that dies partway
// still being recognisable as its own on the next attempt. A marker written at the end would turn
// every interrupted migration into a hard stop.
const IMPORT_MARKER = ".v1-import.json";
interface ImportProvenance { from: string; srcKey: string }

function readProvenance(dir: string): ImportProvenance | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, IMPORT_MARKER), "utf8")) as Partial<ImportProvenance>;
    return typeof raw.from === "string" && typeof raw.srcKey === "string" ? { from: raw.from, srcKey: raw.srcKey } : null;
  } catch { return null; }
}

function writeProvenance(dir: string, prov: ImportProvenance): void {
  if (existsSync(join(dir, IMPORT_MARKER))) return;   // never rewrite: the FIRST import owns the answer
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, IMPORT_MARKER), JSON.stringify(prov, null, 2) + "\n");
}

function renderReport(key: string, rep: StateReport): string[] {
  const lines: string[] = [];
  for (const cls of ["lessons", "reports", "state-json", "other", "worktrees"] as const) {
    const s = rep[cls];
    if (!s.copied && !s.skipped && !s.failed) continue;
    const parts = [`${s.copied} copied`];
    if (s.skipped) parts.push(`${s.skipped} skipped`);
    if (s.failed) parts.push(`${s.failed} FAILED`);
    const why = cls === "worktrees" ? " (not carried — a worktree is reconstructible with `git worktree add`; the branch and its commits live in the repo, not here)"
      : s.skipped ? " (skipped = the destination file already existed and was left as-is)" : "";
    lines.push(`REPORT ${key} ${cls.padEnd(10)} ${parts.join(", ")}${why}`);
  }
  return lines;
}

export function teamImport(argv = process.argv.slice(2)): number {
  const o = parseArgs(argv);
  // --into names the destination workspace explicitly (LOOP-472: the migrated project gets its OWN
  // workspace, so the operator is standing somewhere else when they run this); without it, the
  // workspace is discovered upward from cwd as before. Either way there must already BE one —
  // seeding is `dev-loop team init`, which this verb deliberately does not duplicate.
  const ws = resolveWorkspace(o.into); // throws WsNotFound if there is no workspace there — `team init` first
  const { path: v1Path, cfg: v1 } = readV1(o.from);
  const allKeys = Object.keys(v1.projects ?? {});
  const selected = o.projects.length ? o.projects : allKeys;
  for (const k of selected) if (!(k in (v1.projects ?? {}))) die(`--project '${k}' not found in ${v1Path} (has: ${allKeys.join(", ")})`);

  const teamBackend = ws.file.team.backend;
  const defaultProject = v1.defaultProject;
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
    // AC2 — a re-run is a reported SKIP, not a failure and not a second copy. The key already being
    // present is the normal shape of a second run over an already-migrated project; it is also how a
    // genuine key collision looks, so the line names `--rename` for that case. Either way the config
    // is left exactly as it is and the state copy below still runs — it never overwrites, so it tops
    // up a run that died partway (AC4's recoverable state) instead of starting over.
    if (file.projects[key]) {
      // Provenance decides, and it decides BEFORE anything is written: a stranger under the same key
      // would otherwise receive this project's state files and lessons through the copy below, which
      // never overwrites but does happily ADD (PR #286 review, P1).
      const prov = readProvenance(wsProjectDir(ws, key));
      if (!prov) {
        die(`project '${key}' already exists in ${ws.filePath} and was NOT created by this verb — it is a different project that happens to share the key, and importing '${srcKey}' into it would merge this project's state files and lessons into that one. Nothing was changed. Re-run with --rename ${srcKey}=<new-key>.`);
      }
      const sameSource = prov.from === v1Path || (canon(prov.from) !== null && canon(prov.from) === canon(v1Path));
      if (prov.srcKey !== srcKey || !sameSource) {
        die(`project '${key}' in ${ws.filePath} was imported from '${prov.srcKey}' in ${prov.from}, not from '${srcKey}' in ${v1Path} — two different legacy projects cannot share one destination key. Nothing was changed. Re-run with --rename ${srcKey}=<new-key>.`);
      }
      plan.push(`SKIP   project '${key}' was already imported from '${prov.srcKey}' (${prov.from}) — config left as-is; the state copy below tops up whatever is still missing`);
    } else {

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
    }

    // State dir copy: <dataDir>/<srcKey>/ → <ws>/.dev-loop/<key>/ ; lessons.md → lessons/<key>.md.
    // COPY, not move (AC3) — the operator keeps running against the legacy tree until they confirm
    // this report, and LOOP-473 is what removes it.
    const oldStateDir = join(devloopDataDir(), srcKey);
    if (existsSync(oldStateDir)) plan.push(`STATE  copy ${oldStateDir} → ${wsProjectDir(ws, key)} (source left in place)`);
    const oldLessons = join(oldStateDir, "lessons.md");
    if (existsSync(oldLessons)) plan.push(`LESSON ${oldLessons} → ${join(wsLessonsDir(ws), `${key}.md`)}`);
    const rootState = srcKey === defaultProject ? rootStateFiles(devloopDataDir()) : [];
    if (rootState.length) plan.push(`STATE  copy ${rootState.length} root-level ${rootState.join(", ")} → ${wsProjectDir(ws, key)} ('${srcKey}' is the legacy registry's defaultProject, so the pre-per-project state files are its own)`);
    const strandedRoot = srcKey !== defaultProject ? rootStateFiles(devloopDataDir()) : [];
    if (strandedRoot.length) plan.push(`WARN  ${strandedRoot.length} root-level state file(s) (${strandedRoot.join(", ")}) belong to defaultProject '${defaultProject ?? "<unset>"}', not '${srcKey}' — NOT carried by this run; import that project too before deleting the legacy tree`);
    if (o.hubDb) plan.push(`HUBDB  copy project '${srcKey}' rows from ${o.hubDb} → ${wsHubDb(ws)} (events re-keyed)`);
  }

  // Validate the merged file BEFORE any mutation.
  const { errors } = validateTeamFile(file);
  if (errors.length) die("the merged dev-loop.json would be invalid:\n" + errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"), 1);

  log(`dev-loop team import — from ${v1Path} into workspace '${ws.file.team.key}' @ ${ws.root}`);
  for (const line of plan) log("  " + line);

  if (o.dryRun) { log("\n(--dry-run: nothing changed)"); return 0; }

  // Execute. Config first (the source of truth), then the classified copy.
  writeFileSync(ws.filePath, JSON.stringify(file, null, 2) + "\n");
  ensureStateDirs(ws);
  const reports: string[] = [];
  let anyFailed = false;
  for (const srcKey of selected) {
    const key = o.renames[srcKey] ?? srcKey;
    const oldStateDir = join(devloopDataDir(), srcKey);
    const rep = newReport();
    // Stamped first, so a run that dies mid-copy is still recognisable as this verb's own work on the
    // next attempt (AC4) rather than reading as a foreign project under the same key.
    writeProvenance(wsProjectDir(ws, key), { from: v1Path, srcKey });

    // lessons.md is re-homed into the library rather than copied in place, so it is handled here and
    // excluded from the tree walk below (classifyStatePath maps it to "lessons" either way).
    const oldLessons = join(oldStateDir, "lessons.md");
    if (existsSync(oldLessons)) {
      mkdirSync(wsLessonsDir(ws), { recursive: true });
      const { outcome, error } = copyFileOnce(oldLessons, join(wsLessonsDir(ws), `${key}.md`));
      rep.lessons[outcome]++;
      if (outcome === "failed") rep.failures.push(`lessons: ${oldLessons} → ${join(wsLessonsDir(ws), `${key}.md`)}: ${error}`);
    }
    if (existsSync(oldStateDir)) copyClassified(oldStateDir, wsProjectDir(ws, key), rep, new Set<FileClass>(["worktrees"]), new Set<FileClass>(["lessons"]));
    // The pre-per-project root state files, for the defaultProject only (see rootStateFiles).
    if (srcKey === defaultProject) {
      for (const n of rootStateFiles(devloopDataDir())) {
        const { outcome, error } = copyFileOnce(join(devloopDataDir(), n), join(wsProjectDir(ws, key), n));
        rep["state-json"][outcome]++;
        if (outcome === "failed") rep.failures.push(`state-json: ${join(devloopDataDir(), n)} → ${join(wsProjectDir(ws, key), n)}: ${error}`);
      }
    }
    if (o.hubDb) copyHubRows(o.hubDb, wsHubDb(ws), srcKey, key);

    reports.push(...renderReport(key, rep));
    if (rep.failures.length) {
      anyFailed = true;
      reports.push(...rep.failures.map((f) => `FAIL   ${key}: ${f}`));
    }
  }
  const movedNeeded = plan.some((l) => l.startsWith("MOVE"));
  log(`\nwrote ${ws.filePath}`);
  // AC5 — what actually arrived, per file class, so the operator can confirm before LOOP-473.
  for (const line of reports) log("  " + line);
  log("  REPORT the legacy tree was NOT modified: this verb only ever copies, and never overwrites an existing destination file.");
  // AC4 — a partial copy is reported and exits non-zero. It stays recoverable because a re-run tops
  // up exactly the files that are missing.
  if (anyFailed) {
    log("\nMIGRATION INCOMPLETE — the FAIL lines above did not copy. The source is untouched and nothing was overwritten;");
    log("fix the cause (permissions, disk space) and re-run this command: it copies only what is still missing.");
    return 1;
  }
  if (movedNeeded) { log("Some repos are outside the workspace — run the printed `mv` commands, then `dev-loop doctor`."); return 1; }
  log("Run `dev-loop doctor` to verify, then `/dev-loop:sync-project` to reconcile backend ids.");
  log(`Once this report shows everything you need, remove the legacy tree yourself (${devloopDataDir()}) — this verb never deletes it.`);
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
      // Events re-key: their `id` is an autoincrement the destination assigns, so `INSERT OR IGNORE`
      // — which the TEXT-id tables above rely on — cannot deduplicate them. A plain INSERT therefore
      // duplicated the WHOLE event history on every re-run, including the re-run that recovers a
      // partial copy (PR #286 review, P1).
      //
      // Deduplicated on CONTENT rather than by skipping the pass, so the two properties this verb
      // promises both hold: a second run adds nothing, and a run interrupted halfway is repaired by
      // the next one. `IS` (not `=`) because SQLite's `=` is unknown for NULL, and a nullable column
      // that is null on both sides must read as the same row, not as a new one.
      const cols = (db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((r) => r.name).filter((c) => c !== "id");
      const same = cols.map((c) => `n."${c}" IS o."${c}"`).join(" AND ");
      db.exec(`INSERT INTO events(${cols.map((c) => `"${c}"`).join(",")}) SELECT ${cols.map((c) => `o."${c}"`).join(",")} FROM old.events o WHERE o.project_id='${srcId.replace(/'/g, "''")}' AND NOT EXISTS (SELECT 1 FROM events n WHERE ${same}) ORDER BY o.id`);
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

if (isMainEntry(import.meta.url)) {
  process.exit(teamImport());
}
