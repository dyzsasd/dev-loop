// `dev-loop-hub doctor` — operator health check. READ-ONLY: it never auto-creates a db
// (a typo'd path reports MISSING, it does not spin an empty one). Backs the §17/§18 promises:
// data home is machine-local + never committed, the SoR is intact.
// DL-81: the `doctor` COMMAND additionally runs a service runtime-wiring reconcile (reads the product
// .mcp.json / daemon runfile / autostart/hook presence + a localhost /api/health GET) — still READ-ONLY (no writes,
// no auto-create) and NON-FATAL; see serviceReconcile. Library callers (init-service) skip it.
import { existsSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainEntry } from "./is-entry.ts";
import { pkgVersion, pkgBuildCommit } from "./paths.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { loadProjectsConfig, resolveProjectFromCwd } from "./resolve-project.ts";
import { tryResolveWorkspace, wsHubDb, resolveHubDbPath } from "./workspace.ts";
import { validateTeamFile, effectiveRepo, effectiveProject, deliveryProjects, isTeamProject, agentInterfaceFor, TEAM_INTAKE_PROJECT, WsValidationError, type Workspace, type WsError, type HubBlock } from "./team-config.ts";
import { checkLessonsBudget } from "./lessons.ts";
import { loadWorkspaceSecrets, secretsInjectedKeys, wsSecretsPath } from "./secrets.ts";
import { opencodeSyncDrift } from "./opencode-sync.ts";
import { openDb as openHubDbConn } from "./db.ts";
import { findProject as findHubProject } from "./seed.ts";
import { detectRepoFacts } from "./team-edit.ts";
import { claudeCliPermissions, DEVLOOP_PERMISSION, KAIZEN_PERMISSION } from "./team-init.ts";
import * as metricsMod from "./metrics.ts";
import { readLandingState } from "./landing.ts";
const require_metrics = () => metricsMod;

// DL-81: the `doctor` COMMAND (server.ts / `node src/doctor.ts`) passes { reconcile: true } to ALSO report
// the service runtime wiring (below). Library callers that only want the DB-integrity verdict (init-service
// step (d)) call runDoctor(dbPath) with no opts → no reconcile, behavior byte-for-byte unchanged.
// preferWorkspace (init-wizard) forces the workspace hub.db even when DEVLOOP_HUB_DB is set; without it,
// the workspace hub.db is still used by default UNLESS DEVLOOP_HUB_DB is explicitly set — an explicit
// DEVLOOP_HUB_DB signals deliberate test-isolation and must be honored (LOOP-117).
export async function runDoctor(dbPath: string, opts: { reconcile?: boolean; preferWorkspace?: boolean } = {}): Promise<boolean> {
  let ok = true;
  const allFails: string[] = [];
  const pass = (m: string) => console.log("✅ " + m);
  const fail = (m: string) => { console.log("❌ " + m); ok = false; allFails.push(m); };
  const warn = (m: string) => console.log("⚠️  " + m);
  const info = (m: string) => console.log("•  " + m);

  // Schema v2: when a workspace is discoverable, run its (READ-ONLY) checks first and point the DB checks
  // below at the workspace hub.db. Library callers (init-service) pass an explicit dbPath and skip this.
  let ws: Workspace | null = null;
  const unseeded: string[] = []; // W08 hits, collected for the NEXT line
  let stalledRepo: string | undefined;
  let skewResult: { codeBehind: number; version: string } | null | undefined;
  let decisionStall: { oldest: { id: string; enteredAt: string; state: string }; count: number } | null | undefined;
  if (opts.reconcile) {
    try { ws = tryResolveWorkspace(); }
    catch (e) {
      console.log(`❌ dev-loop.json invalid: ${(e as Error).message}`);
      console.log("\nDOCTOR_FAILED");
      if (e instanceof WsValidationError && e.errors.length) console.log(`NEXT: ${nextStep(null, e.errors, [])}`);
      return false;
    }
    if (ws) {
      // Finalize boardDb before doctorWorkspace so header + W16/W21 always name the same db (AC6, LOOP-199).
      // Prefer workspace hub.db unless DEVLOOP_HUB_DB is explicitly set (test isolation, LOOP-117).
      // Own-db callers (hub.ts:21,29 wires DEVLOOP_HUB_DB=wsHubDb; team-init.ts:176 creates; bundle.ts:153
      // exports; team-import.ts:230 writes) must NOT follow ambient env — they call wsHubDb(ws) directly.
      if (!process.env.DEVLOOP_HUB_DB || opts.preferWorkspace) dbPath = wsHubDb(ws);
      const wsResult = await doctorWorkspace(ws, { ...opts, boardDb: dbPath });
      ok = wsResult.ok && ok;
      allFails.push(...wsResult.fails);
      stalledRepo = wsResult.stalledRepo;
      skewResult = wsResult.skewResult;
      decisionStall = wsResult.decisionStall;
      if (ws.file.team.backend === "linear") {
        // A linear team has no hub.db; the workspace checks ARE the whole verdict.
        console.log(ok ? "\nDOCTOR_OK" : "\nDOCTOR_FAILED");
        console.log(`NEXT: ${nextStep(ws, [], [], stalledRepo, decisionStall, skewResult, allFails)}`);
        return ok;
      }
    }
  }

  console.log(`dev-loop-hub doctor — ${dbPath}`);

  // 1. Exists (never create on doctor)
  if (!existsSync(dbPath)) {
    fail(`db MISSING — nothing to check (create it: node src/seed.ts <key> "<name>" <PREFIX>). NOT auto-creating.`);
    return false;
  }

  // 2. Open the db READ-ONLY. doctor's whole contract is to be non-destructive (§17/§18): it must
  //    NEVER create or initialize a db. openDb() runs `CREATE TABLE IF NOT EXISTS`, which would
  //    materialize the full schema into an empty / truncated file (0 → ~200KB) and falsely green a
  //    destroyed SoR (DL-54). Read-only mode makes create-if-not-exists impossible for ANY input.
  let db: DatabaseSync;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); db.exec("PRAGMA busy_timeout=5000"); db.exec("PRAGMA foreign_keys=ON"); }
  catch (e) { fail(`db not openable (read-only): ${(e as Error).message}`); return false; }

  // 2b. A 0-byte file IS a valid (empty) SQLite db, so the read-only open above SUCCEEDS on a
  //     truncated / zeroed / placeholder file — it just carries no schema; a non-SQLite file throws
  //     on the first read. Either way it is not a system-of-record: report INVALID and write nothing.
  const HUB_TABLES = ["projects", "tickets", "documents", "actors", "events"]; // every table step 4 below counts — so a partial/foreign db fails HERE, cleanly, not mid-check
  let missing: string[];
  try {
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
    missing = HUB_TABLES.filter((t) => !present.has(t));
  } catch (e) { fail(`db INVALID — not a readable SQLite database: ${(e as Error).message}`); db.close(); return false; }
  if (missing.length) {
    fail(`db INVALID — empty / truncated / non-hub file (missing hub tables: ${missing.join(", ")}); not a system-of-record`);
    db.close();
    return false;
  }
  pass("db opens read-only and carries the hub schema");

  // 3. PRAGMAs
  const jm = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  jm === "wal" ? pass("journal_mode = WAL") : fail(`journal_mode = ${jm} (expected wal)`);
  const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  info(`foreign_keys = ${fk} (set per-connection; informational)`);
  const qc = (db.prepare("PRAGMA quick_check").get() as Record<string, string>);
  Object.values(qc)[0] === "ok" ? pass("quick_check ok (no corruption)") : fail(`quick_check: ${JSON.stringify(qc)}`);

  // 4. Counts + per-project, and the unique-prefix integrity check (the real multi-project guard)
  const c = (sql: string) => (db!.prepare(sql).get() as { c: number }).c;
  info(`projects=${c("SELECT count(*) c FROM projects WHERE CASE WHEN json_valid(settings_json) THEN json_extract(settings_json,'$.scratch') ELSE NULL END IS NOT 1")} tickets=${c("SELECT count(*) c FROM tickets")} docs=${c("SELECT count(*) c FROM documents")} actors=${c("SELECT count(*) c FROM actors")} events=${c("SELECT count(*) c FROM events")}`);
  const projects = db.prepare("SELECT id, key, ticket_prefix FROM projects ORDER BY key").all() as { id: string; key: string; ticket_prefix: string }[];
  const countByProject = db.prepare("SELECT count(*) c FROM tickets WHERE project_id = ?");
  for (const p of projects) {
    const n = (countByProject.get(p.id) as { c: number }).c;
    info(`  project ${p.key} [${p.ticket_prefix}] — ${n} tickets`);
  }
  const prefixes = projects.map((p) => p.ticket_prefix);
  const dupes = prefixes.filter((p, i) => prefixes.indexOf(p) !== i);
  dupes.length
    ? fail(`duplicate ticket_prefix across projects: ${[...new Set(dupes)].join(", ")} — ticket ids will collide on the shared db`)
    : pass(`ticket prefixes unique across projects`);
  info(`valid DEVLOOP_ACTOR values: ${(db.prepare("SELECT handle FROM actors WHERE active=1 ORDER BY handle").all() as { handle: string }[]).map((r) => r.handle).join(", ")}`);

  // W08 — config↔hub reconcile (service workspace only). A config project with NO hub row burns every
  // fire on the hub's G2 refusal (the team scheduler skips it at pick time) → warn with the exact seed
  // command. A hub row with NO config entry is merely unscheduled (historical / hand-seeded) → info.
  // `_team` is the reserved intake row: expected in the hub, forbidden in config (E11).
  if (ws) {
    const hubKeys = new Set(projects.map((p) => p.key));
    for (const key of deliveryProjects(ws)) {
      if (!hubKeys.has(key)) { unseeded.push(key); warn(`[W08] projects.${key}: config project '${key}' has no hub.db row — its fires get no board access; seed it once: dev-loop seed ${key} "<Project Name>" <UNIQUE_PREFIX>`); }
    }
    warnTombstonedProjects(db, unseeded, warn);
    for (const p of projects) {
      if (!isTeamProject(p.key) && !Object.hasOwn(ws.file.projects, p.key)) info(`hub project '${p.key}' has no dev-loop.json entry (unscheduled; historical or hand-seeded)`);
    }
  }

  // 5. §17 secrecy guard — the db must NOT be tracked by git (it's machine-local runtime state)
  const dir = dirname(dbPath);
  let inRepo = false;
  try { inRepo = execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; } catch { /* not a repo */ }
  if (!inRepo) { pass("data home is outside any git repo (machine-local, never committed)"); }
  else {
    let leaked = false;
    for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
      if (!existsSync(f)) continue;
      try { execFileSync("git", ["-C", dir, "check-ignore", "-q", f], { stdio: "ignore" }); } // exit 0 = ignored
      catch { fail(`${f} is INSIDE a git repo and NOT gitignored — the hub DB must never be committed`); leaked = true; }
    }
    if (!leaked) pass("db files are inside a repo but gitignored");
  }
  // LOOP-231: also check every configured repo work tree for un-ignored hub.db files.
  let repoLeakFound = false;
  if (ws) {
    for (const [ref, entry] of Object.entries(ws.file.repos)) {
      const { absPath: repoDir } = effectiveRepo(ws, ref);
      if (!existsSync(repoDir) || !isGitWorkTree(repoDir)) continue;
      for (const baseName of ["hub.db", "hub.db-wal", "hub.db-shm"]) {
        const fullPath = join(repoDir, ".dev-loop", baseName);
        if (!existsSync(fullPath)) continue;
        try { execFileSync("git", ["-C", repoDir, "check-ignore", "-q", join(".dev-loop", baseName)], { stdio: "ignore" }); }
        catch { fail(`${fullPath} is INSIDE a git repo and NOT gitignored — the hub DB must never be committed`); repoLeakFound = true; }
      }
    }
  }
  // Suppress the reassuring PASS when a repo-level leak was found (a clean data-home does not mean the whole set is safe).
  if (repoLeakFound && !inRepo) {
    // Remove the previously printed 'data home is outside any git repo' line by re-printing a warning-level hint.
    // This is a formatting concession: we can't un-print the pass() line, but we can qualify it.
    warn(`[W06] the workspace hub.db data home is outside any git repo, but a hub.db was found inside a configured repo — the existing ✅ line above is misleading; follow the ❌ above to fix it.`);
  }

  db.close();

  // D8/D9 — CLI-interface preflight (service workspace only; ws is set only on the `doctor` COMMAND).
  // Agents on interface="cli" reach the board through the PATH-installed `dev-loop` write verbs, which
  // FAIL CLOSED (exit 4) on a missing binary / pre-write-layer version / broken fire-env identity — every
  // fire would then burn a full turn with zero board access. Warnings, never fails (same class as W08).
  if (ws) cliInterfaceChecks(ws, projects.map((p) => p.key), dbPath, { pass, warn, info });

  // DL-81: optional, additive service runtime-wiring reconcile (only for the `doctor` COMMAND, not library
  // callers like init-service). READ-ONLY + NON-FATAL — it never touches `ok`, so the verdict below is still
  // decided SOLELY by the DB-integrity checks above (§18 SoR contract preserved).
  if (opts.reconcile) await serviceReconcile(projects.map((p) => p.key), dbPath);

  console.log(ok ? "\nDOCTOR_OK" : "\nDOCTOR_FAILED");
  if (ws) console.log(`NEXT: ${nextStep(ws, [], unseeded, stalledRepo, decisionStall, skewResult, allFails)}`);
  return ok;
}

// ── the NEXT line — the single most-blocking next step, in fix order ──────────────────────────────
// Doctor's checks say what is WRONG; this says what to DO first. One line, one command, priority-ordered:
// an invalid config blocks everything → a blank linearTeam blocks every fire → no projects/repos blocks
// scheduling → an unseeded service project silently starves its fires → dry-run is the last gate before
// live. All green ⇒ run the team.
function nextStep(ws: Workspace | null, errors: WsError[], unseeded: string[], stalledRepo?: string, decisionStall?: { oldest: { id: string; enteredAt: string; state: string }; count: number } | null, skewResult?: { codeBehind: number; version: string } | null, fails?: string[]): string {
  if (errors.length) { const e = errors[0]; return `fix dev-loop.json — [${e.code}] ${e.path ? e.path + ": " : ""}${e.message}`; }
  if (!ws) return "dev-loop run";
  if (fails && fails.length) return `fix the ❌ first: ${fails[0]}`;
  const t = ws.file.team;
  if (t.backend === "linear" && !(t.linearTeam ?? "").trim()) return `dev-loop team set team.linearTeam "<Team Name>"  (fires refuse to launch on a blank Linear team)`;
  if (!deliveryProjects(ws).filter(k => ws.file.projects[k]?.scratch !== true).length) return `dev-loop team add-project <key>  (or /dev-loop:add-project in a coding CLI)`;
  if (unseeded.length) return `dev-loop seed ${unseeded[0]} "<Project Name>" <UNIQUE_PREFIX>  (config project with no hub.db row, W08)`;
  if (!Object.keys(ws.file.repos).length) return `dev-loop team add-repo <ref> --project <key> --path <rel> --detect  (or /dev-loop:add-repo)`;
  if (t.comms?.webhookEnv && process.env[t.comms.webhookEnv] === undefined) return `put ${t.comms.webhookEnv}=<webhook-url> in ${wsSecretsPath(ws.root)} (or export it) — the whole reminder layer is silently dead without it (W12)`;
  if (t.mode === "dry-run") return `dev-loop team set team.mode live  (everything is wired; flip when ready to go live)`;
  // W20 NEXT flip: decision queue stall outranks landing stall — operator is the loop's only unscalable resource
  if (decisionStall != null && decisionStall.count > 0) {
    const oldest = decisionStall.oldest;
    const ageMs = Date.now() - Date.parse(oldest.enteredAt);
    const h = Math.floor(ageMs / 3_600_000);
    const ageStr = h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ageMs / 60_000))}m`;
    return `rule on the oldest decision ${oldest.id} (${ageStr}): http://127.0.0.1:8787/ticket/${oldest.id}`;
  }
  // W22 NEXT flip: a landing stall is the most-blocking state when everything else is green
  if (stalledRepo) return `clear the landing stall: fix the red base / land the wedged PRs — gh pr list --repo ${stalledRepo}`;
  // §9.8 release-readiness hint: when shipped-code skew > 0, tell the operator to cut a release
  if (skewResult != null && skewResult.codeBehind > 0) return `cut a release — ${skewResult.codeBehind} shipped-code commit(s) merged after v${skewResult.version} are not published; dev-loop fixes marked Done are not live. Dispatch release-npm.yml.`;
  return "dev-loop run";
}

// ── W20 helper — extracted to keep doctorWorkspace CC under the CRAP gate threshold ─────────────────────
// Reads the per-project decisionQueue and emits [W20] when non-empty. Best-effort; swallows all exceptions.
// Returns the stall descriptor (oldest + count) for NEXT-line threading, or null when clean/unavailable.
function checkDecisionQueueStall(ws: Workspace, warn: (m: string) => void): { oldest: { id: string; enteredAt: string; state: string }; count: number } | null {
  if (ws.file.team.backend !== "service" || !existsSync(wsHubDb(ws))) return null;
  try {
    const { decisionQueue, decisionEnteredAt } = require_metrics();
    const db = openHubDbConn(wsHubDb(ws));
    try {
      // LOOP-207: age AND "oldest" ordering come from each item's into-queue-state transition event
      // (decisionEnteredAt), NEVER tickets.updated_at — an unrelated later write (a Sweep label repair on
      // a parked item, §9c edge re-pointing) must not reset its age nor change WHICH item is named oldest.
      // decisionQueue's own ORDER BY updated_at is LOOP-108's concern (the metrics render); W20 re-derives
      // and re-sorts locally, so the two corrections don't collide.
      const allItems: Array<{ id: string; title: string; state: string; enteredAt: string }> = [];
      for (const key of deliveryProjects(ws)) {
        const pid = findHubProject(db, key);
        if (!pid) continue;
        for (const t of decisionQueue(db, pid) as Array<{ id: string; title: string; state: string; updatedAt: string }>) {
          allItems.push({ id: t.id, title: t.title, state: t.state, enteredAt: decisionEnteredAt(db, t.id, t.state) });
        }
      }
      if (allItems.length > 0) {
        allItems.sort((a, b) => a.enteredAt < b.enteredAt ? -1 : a.enteredAt > b.enteredAt ? 1 : 0);
        const oldest = allItems[0];
        const ageMs = Date.now() - Date.parse(oldest.enteredAt);
        const h = Math.floor(ageMs / 3_600_000);
        const ageStr = h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ageMs / 60_000))}m`;
        const title60 = oldest.title.length > 60 ? oldest.title.slice(0, 57) + "…" : oldest.title;
        const stateLabel = oldest.state === "In Review" ? "approve" : "blocked";
        const noCommsNote = !ws.file.team.comms?.webhookEnv
          ? " — no out-of-band escalation path (no team.comms): these surface only here and in `dev-loop metrics`, never as a reminder."
          : "";
        warn(`[W20] decision queue: ${allItems.length} waiting on you, oldest ${oldest.id} "${title60}" ${ageStr} (${stateLabel}) — rule on it: http://127.0.0.1:8787/ticket/${oldest.id}; full queue: dev-loop metrics${noCommsNote}`);
        return { oldest: { id: oldest.id, enteredAt: oldest.enteredAt, state: oldest.state }, count: allItems.length };
      }
    } finally { db.close(); }
  } catch { /* decision-queue is best-effort — never fails doctor */ }
  return null;
}

// ── Schema-v2 workspace checks (READ-ONLY; R2 — mutating fixups live in `dev-loop team repair`) ──────────
// Reports the E-code/W-code verdict for a dev-loop.json, that every registered repo exists and is a git
// repo, and the two migration/leak warnings (W05 user-scope MCP for linear steward fires; W06 workspace
// inside a git work-tree). Never writes, never repairs.
export async function doctorWorkspace(ws: Workspace, opts: { exec?: import("./landing.ts").ExecFn; boardDb?: string } = {}): Promise<{ ok: boolean; stalledRepo?: string; decisionStall?: { oldest: { id: string; enteredAt: string; state: string }; count: number } | null; skewResult?: { codeBehind: number; version: string } | null; fails: string[] }> {
  let ok = true;
  let stalledRepo: string | undefined;
  let decisionStall: { oldest: { id: string; enteredAt: string; state: string }; count: number } | null = null;
  const fails: string[] = [];
  const pass = (m: string) => console.log("✅ " + m);
  const fail = (m: string) => { console.log("❌ " + m); ok = false; fails.push(m); };
  const warn = (m: string) => console.log("⚠️  " + m);
  const info = (m: string) => console.log("•  " + m);

  console.log(`\ndev-loop workspace — '${ws.file.team.key}' @ ${ws.root} (backend:${ws.file.team.backend})`);

  const { errors, warnings } = validateTeamFile(ws.file);
  if (errors.length) for (const e of errors) fail(`[${e.code}] ${e.path}: ${e.message}`);
  else pass(`dev-loop.json valid (${Object.keys(ws.file.repos).length} repos, ${Object.values(ws.file.projects).filter((p) => !p.scratch).length} projects)`);
  for (const w of [...warnings, ...checkLessonsBudget(ws), ...metricsMod.checkBudget(ws)]) warn(`[${w.code}] ${w.path}: ${w.message}`);

  // Every registered repo exists on disk + is a git repo (path existence + realpath sanity).
  for (const ref of Object.keys(ws.file.repos)) {
    const r = effectiveRepo(ws, ref);
    const dir = r.absPath;
    if (!existsSync(dir)) fail(`repo '${ref}' path missing on disk: ${dir} (clone it, or /dev-loop:sync-repo)`);
    else if (!isGitWorkTree(dir)) warn(`repo '${ref}' at ${dir} is not a git repo yet`);
    else pass(`repo '${ref}' → ${dir}`);
    // The add-repo --detect contract: interview-only fields stay unset, doctor makes the gap visible.
    if (!r.deploy && !r.ops) info(`repo '${ref}' has no deploy/ops config (interview-only fields) — fill via /dev-loop:add-repo, or team set repos.${ref}.deploy.* once it deploys`);
    // No-build-block nudge: if no build block is configured but detection finds gates in the tree,
    // surface the gap. Info only — unwired gates are a recommendation, not a failure.
    if (!r.build) {
      try {
        const detected = detectRepoFacts(dir);
        if (detected.build && Object.keys(detected.build).length) {
          const gates = Object.keys(detected.build).join("/");
          info(`repo '${ref}' has no build gates configured, but detection finds ${gates} — wire them via 'dev-loop team add-repo ${ref} --detect' or 'dev-loop team set repos.${ref}.build.<gate> "<cmd>"'`);
        }
      } catch { /* detectRepoFacts is best-effort in doctor */ }
    }
    // Quality-gauntlet nudge: a repo with a test gate but no quality gate ships on binary green alone —
    // the CRAP/mutation gate is what catches "complex ∧ untested" and tests that don't bite. Info, not a W-code.
    if (r.build?.test && !r.build?.quality) info(`repo '${ref}' has a test gate but no quality gate — consider build.quality (e.g. "dev-loop quality --changed --threshold 30"; see references/config-schema.md)`);
  }

  // W17 — projects with repos but no strategyDoc: the four doc-land / roadmap-banner / file-watcher
  // consumers are silently inert without a resolvable repo-file strategyDoc pointer. ONE warning names
  // all four consumers so the operator knows the blast radius of the missing field.
  for (const [key, p] of Object.entries(ws.file.projects)) {
    if ((p.repos ?? []).length > 0 && !p.strategyDoc)
      warn(`[W17] projects.${key}: has repos but no strategyDoc — doc-land, the /roadmap divergence banner, the strategy-doc file-watcher, and repoFileStrategyPath are inert; set it: dev-loop team set projects.${key}.strategyDoc docs/STRATEGY.md`);
  }

  // W05 — a linear team's steward fires run at the workspace ROOT (cwd), where a repo-level .mcp.json can't
  // apply; the Linear MCP must be configured in USER scope or stewards are starved of the board.
  if (ws.file.team.backend === "linear")
    warn(`[W05] linear steward fires run at the workspace root — ensure the Linear MCP is configured in USER scope (a repo .mcp.json won't apply there)`);

  // Director signal: 7d fire success from the fires.jsonl ledger (informational; a degrading agent —
  // rising failures/timeouts/suspectErrors — should reach the operator without ssh'ing into logs).
  try {
    const { fireMetrics } = require_metrics();
    const fm = fireMetrics(join(ws.root, ".dev-loop", "team", "fires.jsonl"), 7 * 86_400_000);
    if (fm.fires > 0) {
      const cls = Object.entries((fm.byErrorClass ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`).join(", ");
      info(`fires (7d): ${fm.fires} — success ${fm.successRate === null ? "—" : Math.round(fm.successRate * 100) + "%"}, ${fm.failures} failed, ${fm.timeouts} timeout, ${fm.suspectErrors} suspect${cls ? ` — top errors: ${cls}` : ""}`);
    }
  } catch { /* metrics are informational */ }

  // W12 — comms webhook resolvability (the silent-failure killer). team.comms stores an env-var NAME
  // (§16); when NEITHER the process env NOR .dev-loop/secrets.env supplies the VALUE, the entire
  // notification layer silently no-ops: `notify` cannot send, the daemon Human-Blocked reminder never
  // fires, the §22a digest never delivers — and nothing else surfaces it. Never prints the value.
  const comms = ws.file.team.comms;
  if (comms?.webhookEnv) {
    loadWorkspaceSecrets(ws.root); // idempotent; makes this check self-contained for library callers
    if (process.env[comms.webhookEnv] !== undefined) {
      pass(`comms webhook ${comms.webhookEnv} resolvable (${secretsInjectedKeys(ws.root).has(comms.webhookEnv) ? "secrets.env" : "env"})`);
    } else {
      warn(`[W12] comms env ${comms.webhookEnv} unresolvable — notifications (notify / Human-Blocked reminder / §22a digest) will silently no-op; put ${comms.webhookEnv}=<url> in ${wsSecretsPath(ws.root)} or export it`);
    }
  }

  // W13 — provider-registry auth resolvability (the W12 pattern; model-provider-routing). An entry whose
  // auth env resolves neither from the process env nor .dev-loop/secrets.env makes every opencode fire on
  // that provider fail pre-spawn (run-agents `provider-env-missing`) — surface it BEFORE the loop runs.
  // Never prints the value.
  const provs = ws.file.team.providers ?? {};
  for (const [id, p] of Object.entries(provs)) {
    loadWorkspaceSecrets(ws.root); // idempotent (same self-containment as W12)
    if (process.env[p.authTokenEnv] !== undefined) {
      pass(`provider '${id}' auth ${p.authTokenEnv} resolvable (${secretsInjectedKeys(ws.root).has(p.authTokenEnv) ? "secrets.env" : "env"})`);
    } else {
      warn(`[W13] provider '${id}' auth env ${p.authTokenEnv} unresolvable — its opencode fires fail pre-spawn (errorClass: provider-env-missing); put ${p.authTokenEnv}=<key> in ${wsSecretsPath(ws.root)} or export it`);
    }
  }
  // W14 — workspace opencode.json carries the registry (sync drift). Read-only; the fix is operator-run.
  if (Object.keys(provs).length) {
    const drift = opencodeSyncDrift(ws.root, provs);
    if (drift === null) pass(`opencode.json carries the ${Object.keys(provs).length} registry provider(s)`);
    else warn(`[W14] ${drift} — run: dev-loop team sync-opencode`);
  }

  // W15 — opencode preflight (model-provider-routing; PORTABILITY §5): the certified lane needs
  // opencode >= 1.2.24 (`--variant`; OPENCODE_PERMISSION honored — an older binary may silently IGNORE
  // the injected policy, the worst failure shape). Only when the config actually targets opencode.
  const OPENCODE_MIN_VERSION = "1.2.24";
  const targetsOpencode = Object.keys(provs).length > 0
    || ws.file.team.defaultCodingAgent === "opencode"
    || Object.values(ws.file.team.agents ?? {}).some((a) => a?.codingAgent === "opencode")
    || Object.values(ws.file.projects).some((p) => projectCodingAgents(p).includes("opencode"));
  if (targetsOpencode) {
    const v = (() => { try { return execFileSync("opencode", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } })();
    if (!v) warn(`[W15] the config targets opencode but it is not runnable on PATH — those fires cannot launch; install opencode (certified ${OPENCODE_MIN_VERSION}, PORTABILITY §5)`);
    else if (semverBefore(v, OPENCODE_MIN_VERSION)) warn(`[W15] opencode ${v} predates the certified ${OPENCODE_MIN_VERSION} — --variant/OPENCODE_PERMISSION behavior is unverified there (PORTABILITY §5); upgrade opencode`);
    else pass(`opencode ${v} on PATH (certified ${OPENCODE_MIN_VERSION})`);
  }

  // W16 + W21 share the same db path; compute once to avoid repeated ?? (CC budget, LOOP-199).
  const boardDb = opts.boardDb ?? wsHubDb(ws);

  // W16 — owner-liveness (P1-4, the field's MP-156): an owner label whose actor never fires strands its
  // Todo/In Review tickets forever, and nothing notices. Service-backend only (needs the local board).
  // agents.<h>.manual:true (team or project) downgrades the finding to an info line ("awaiting a human").
  if (ws.file.team.backend === "service" && existsSync(boardDb)) {
    try {
      const { ownerLiveness } = require_metrics();
      const db = openHubDbConn(boardDb);
      try {
        const manual = new Set<string>();
        for (const [h, a] of Object.entries(ws.file.team.agents ?? {})) if ((a as { manual?: boolean })?.manual === true) manual.add(h);
        for (const key of deliveryProjects(ws)) {
          for (const [h, a] of Object.entries((effectiveProject(ws, key).agents ?? {}) as Record<string, { manual?: boolean }>)) if (a?.manual === true) manual.add(h);
          const pid = findHubProject(db, key);
          if (!pid) continue;
          for (const f of ownerLiveness(db, pid, join(ws.root, ".dev-loop", "team", "fires.jsonl"), { manualHandles: manual })) {
            const age = f.lastFireTs ? `last fire ${f.lastFireTs.slice(0, 10)}` : "no fire on record";
            if (f.manual) info(`[${key}] manual owner '${f.owner}': ${f.openTickets} open Todo/In Review ticket(s) awaiting a human (oldest ${f.oldestUpdatedAt.slice(0, 10)})`);
            else warn(`[W16] [${key}] owner '${f.owner}' has ${f.openTickets} open Todo/In Review ticket(s) (oldest ${f.oldestUpdatedAt.slice(0, 10)}) but ${age} in 7d — re-owner them, or mark the role manual: dev-loop team set (agents.${f.owner}.manual true is a config edit)`);
          }
        }
      } finally { db.close(); }
    } catch { /* owner-liveness is best-effort — a missing ledger/db never fails doctor */ }
  }

  // W20 — operator decision queue stall (design decision-queue-observability §5.1): a non-empty operator
  // decision queue means a human-gated unblock or approval is waiting, yet NEXT says "dev-loop run" — the
  // operator is the loop's only unscalable resource; a waiting decision is more urgent than a landing stall.
  // Extracted to helper to keep doctorWorkspace CC in budget. Best-effort; never flips DOCTOR_OK.
  decisionStall = checkDecisionQueueStall(ws, warn);

  // W21 — sensitive mis-tier backstop (design sensitive-routing §§3-4): non-terminal tickets whose
  // labels include `sensitive` AND are routed to the junior-dev tier (assignee or label). Layer-1/2
  // enforce at write/queue time; this layer surfaces pre-gate or raw-path rows. Service-backend only.
  if (ws.file.team.backend === "service" && existsSync(boardDb)) {
    try {
      const { sensitiveMistier } = require_metrics();
      const db = openHubDbConn(boardDb);
      try {
        for (const key of deliveryProjects(ws)) {
          const pid = findHubProject(db, key);
          if (!pid) continue;
          const findings = sensitiveMistier(db, pid);
          if (findings.length) {
            const ids = findings.map((f: { id: string }) => f.id).join(", ");
            warn(`[W21] [${key}] ${findings.length} sensitive ticket(s) still assigned to junior-dev tier: ${ids} — re-tier: dev-loop ticket update <id> --assignee senior-dev --labels dev-loop,<other>,senior-dev`);
          }
        }
      } finally { db.close(); }
    } catch { /* W21 is best-effort — never fails doctor */ }
  }

  // W22 — landing stall: extracted to helper to keep doctorWorkspace CC in budget (design §5.1).
  stalledRepo = await checkLandingW22Stall(ws, opts, { warn, info, pass });

  // W19 — unpushed strategy/doc commits: local <defaultBranch> is ahead of origin (LOOP-56).
  // A landing:"pr" repo where PM commits docs to local main but never pushes means every dev
  // worktree (which branches off origin) silently misses those docs, and they land as passengers
  // in dev PRs. Best-effort, warn/info only — NEVER flips DOCTOR_OK.
  try {
    for (const [ref, entry] of Object.entries(ws.file.repos)) {
      if (entry.landing !== "pr") continue;
      const { absPath: dir, defaultBranch } = effectiveRepo(ws, ref);
      if (!existsSync(dir) || !isGitWorkTree(dir)) continue;
      try {
        const r = spawnSync("git", ["-C", dir, "rev-list", "--count", `origin/${defaultBranch}..${defaultBranch}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        if (r.status !== 0 || r.error) {
          // origin/<branch> ref absent or git error — unknown, never warn (§LOOP-56 AC)
          info(`[${ref}] W19: cannot check ahead-of-origin (origin/${defaultBranch} not resolved; best-effort)`);
          continue;
        }
        const ahead = parseInt(r.stdout.trim(), 10);
        if (isNaN(ahead)) { info(`[${ref}] W19: rev-list output unexpected — skipping`); continue; }
        if (ahead > 0) {
          warn(`[W19] [${ref}] local ${defaultBranch} is ${ahead} commit(s) ahead of origin/${defaultBranch} — unpushed strategy/doc commits are invisible to every dev worktree (they branch off origin). Land them: dev-loop doc-land (design landing-discipline §4), or the operator runbook §4.3. Do NOT 'git reset --hard origin/${defaultBranch}' — it destroys them.`);
        }
        // ahead === 0: in sync, silent
      } catch { info(`[${ref}] W19: git check skipped (best-effort)`); }
    }
  } catch { /* W19 is best-effort — never fails doctor */ }

  // W18 — installed CLI vs origin/main skew (LOOP-46 / design landing-observability §9.3).
  // Extracted to helper to keep doctorWorkspace CC in budget. Best-effort; never flips DOCTOR_OK.
  let skewResult: { codeBehind: number; version: string } | null = null;
  try { skewResult = checkInstalledCliSkew(ws, { warn, info, pass }) ?? null; } catch { /* W18 is best-effort */ }

  // W23 — CLI-rename permission drift (LOOP-181 / Phase A): a workspace whose .claude/settings.json was
  // provisioned before the `kaizen` bin landed allows Bash(dev-loop *) but not Bash(kaizen *). Harmless
  // today (prose still types `dev-loop`), but the instant prose flips to `kaizen` (Phase B) that
  // workspace's fires are denied board access. Pre-emptive + warn-only (never flips DOCTOR_OK); the
  // top-up is one command. Best-effort — a missing/malformed settings.json is not a drift finding.
  try {
    const perms = claudeCliPermissions(ws.root);
    if (perms && perms.devloop && !perms.kaizen)
      warn(`[W23] ${join(ws.root, ".claude", "settings.json")} allows ${DEVLOOP_PERMISSION} but not ${KAIZEN_PERMISSION} — the CLI is gaining a \`kaizen\` alias (LOOP-181); top up the allow-list so fires keep board access when prose flips: dev-loop team repair`);
  } catch { /* W23 is best-effort — never fails doctor */ }

  // W26 — unmerged paths in the shared checkout (LOOP-215). Extracted to helper to keep doctorWorkspace
  // CC in budget. Best-effort; never flips DOCTOR_OK.
  warnUnmergedPaths(ws, warn);

  // W06 — git-work-tree leak checks: committable .dev-loop state/reports (I5 neighbor) or a bundle
  // artifact carrying every secret VALUE + hub.db (LOOP-210). Extracted to a helper (same pattern as
  // W26) to keep doctorWorkspace's cyclomatic complexity within the CRAP-ratchet budget; see
  // checkGitTreeLeaks.
  // LOOP-231: also check every configured repo work tree (same pattern as W19/W26).
  checkGitTreeLeaks(ws.root, "workspace root", warn, info);
  for (const ref of Object.keys(ws.file.repos)) {
    const { absPath: dir } = effectiveRepo(ws, ref);
    if (existsSync(dir) && isGitWorkTree(dir))
      checkGitTreeLeaks(dir, `repo '${ref}'`, warn, info);
  }

  // W27 — null-assignee stranded tickets in split-dev (LOOP-244): in a split-dev project a null
  // assignee makes a ticket invisible to every actor's servable slice and to todoDepth. Extracted to
  // helper to keep doctorWorkspace CC in budget. Best-effort; never flips DOCTOR_OK.
  if (ws.file.team.backend === "service" && existsSync(boardDb)) {
    try {
      const db = openHubDbConn(boardDb);
      try {
        for (const key of deliveryProjects(ws)) {
          const pid = findHubProject(db, key);
          if (!pid) continue;
          checkNullAssigneeStranded(db, pid, effectiveProject(ws, key).devSplit ?? false, (m) => warn(`[W27] [${key}] ${m}`));
        }
      } finally { db.close(); }
    } catch { /* W27 is best-effort — never fails doctor */ }
  }

  return { ok, stalledRepo, decisionStall, skewResult, fails };
}

export function isGitWorkTree(dir: string): boolean {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; }
  catch { return false; }
}

// W26 helper — extracted to keep doctorWorkspace CC in budget (LOOP-215). Best-effort; never throws.
function warnUnmergedPaths(ws: Workspace, warn: (msg: string) => void): void {
  try {
    for (const ref of Object.keys(ws.file.repos)) {
      const { absPath: dir } = effectiveRepo(ws, ref);
      if (!existsSync(dir) || !isGitWorkTree(dir)) continue;
      const r = spawnSync("git", ["-C", dir, "ls-files", "--unmerged", "-z"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (r.status !== 0 || r.error) continue;
      const paths = [...new Set(
        r.stdout.split("\0").filter(Boolean).map(line => line.split("\t")[1]).filter(Boolean)
      )];
      if (paths.length)
        warn(`[W26] repo '${ref}' (${dir}) has ${paths.length} unmerged path${paths.length === 1 ? "" : "s"}: ${paths.join(", ")} — conflict markers may block direct tsc/build/test runs (per-ticket worktrees are unaffected). Resolve: edit each file, then \`git add <file>\`. Likely cause: an interrupted \`git stash pop\` or \`git merge\`.`);
    }
  } catch { /* best-effort — never fails doctor */ }
}

// W06 helper (LOOP-210) — extracted to keep doctorWorkspace CC within the CRAP-ratchet budget, matching
// the warnUnmergedPaths (W26) pattern. Warns when the workspace root is a git work-tree that could commit
// .dev-loop state/reports (I5 neighbor) or an un-ignored bundle artifact (every secret VALUE + hub.db).
// The reassuring "clean" info line prints ONLY when the whole checked set is ignored — never on a tree it
// did not measure (the old check asked "is .dev-loop/ ignored?", not "is anything here committable?").
function checkGitTreeLeaks(root: string, treeLabel: string, warn: (msg: string) => void, info: (msg: string) => void): void {
  if (!isGitWorkTree(root)) return;
  const devLoopIgnored = isPathIgnored(root, ".dev-loop");
  if (!devLoopIgnored) warn(`[W06] ${treeLabel} is inside a git work-tree and .dev-loop/ is not gitignored — state/reports could be committed (add .dev-loop/ to .gitignore)`);
  // LOOP-210: a bundle artifact (MAGIC header, any --out name, encrypted or plaintext) or the
  // moved.json marker sitting un-ignored in the tree is a secret/state leak a `git add -A` commits.
  const leaks: { path: string; state: "untracked" | "staged" | "committed" | "published" }[] = unignoredBundleArtifacts(root);
  const movedRel = join(".dev-loop", "moved.json");
  // P1 fix (PRRT_kwDOS6Puk86Vn_bA): moved.json can be in BOTH HEAD (committed) and the index (staged),
  // e.g. a previously committed marker that was re-staged. indexStates() returns all applicable states.
  if (existsSync(join(root, movedRel)) && !isPathIgnored(root, movedRel))
    for (const state of indexStates(root, movedRel)) leaks.push({ path: ".dev-loop/moved.json", state });
  if (leaks.length) {
    // Remediation must match each artifact's git STATE (LOOP-235 review P1 #7/#8), because the escape
    // differs and getting it wrong still leaks: a .gitignore rule removes an UNTRACKED artifact from the
    // next commit but never unstages a tracked blob; `git rm --cached` drops a STAGED blob from the index
    // but does NOT rewrite history, so a bundle already in an unpushed COMMIT survives it and ships on push
    // — that one needs the commit rewritten. Every state present in the leak set prints its clause (a path
    // carrying a bundle in BOTH the index and an unpushed commit contributes both — LOOP-235 both-states),
    // and the artifact names are deduped so such a path is listed once.
    const names = [...new Set(leaks.map((l) => l.path))].join(", ");
    const states = new Set(leaks.map((l) => l.state));
    const fixes: string[] = [];
    if (states.has("untracked")) fixes.push("for an untracked one, add *.age / the artifact to .gitignore or write it outside the repo");
    // P1 fix (PRRT_kwDOS6Puk86Vn_a_): use -f so the command also works for AM blobs (staged then
    // modified in the worktree); without -f `git rm --cached` refuses when the index and worktree differ.
    // LOOP-235 review (PRRT_kwDOS6Puk86VoHA5): `git rm --cached` clears only the INDEX — the worktree copy
    // survives as an untracked file, and the next routine `git add -A` re-stages the identical secret, so
    // the remediation must ALSO delete/move/.gitignore the worktree copy, not just unstage it.
    if (states.has("staged")) fixes.push("for a staged one, `git rm -f --cached <path>` to drop it from the index, then delete or move the worktree copy (or add it to .gitignore) so a later `git add -A` cannot re-stage it");
    if (states.has("committed")) fixes.push("for one already in an unpushed commit, rewrite or drop that commit (`git rebase -i` / `git reset`) before pushing — `git rm --cached` clears only the index, not history");
    // LOOP-235 review (PRRT_kwDOS6Puk86VoHA7): a marker already in a PUSHED commit must NOT get rewrite
    // advice — rewriting published history won't un-leak it and misdirects the operator; the secret is public.
    if (states.has("published")) fixes.push("for one already in a PUSHED commit, the secret is public — rotate/revoke it and add the path to .gitignore so it is not re-committed; rewriting already-pushed history won't un-leak it");
    warn(`[W06] ${treeLabel} is inside a git work-tree and these secret/state-bearing artifacts are reachable by the next commit or push (or already pushed): ${names} (a bundle carries every secret VALUE + hub.db — ${fixes.join("; ")})`);
  }
  if (devLoopIgnored && !leaks.length) info(`${treeLabel} is inside a git repo but .dev-loop/ is gitignored`);
}

// LOOP-210 — `git check-ignore -q <rel>` inside <root>: exit 0 ⇒ ignored. Best-effort: a non-repo or
// a git error is treated as "not ignored" — the safe, loud default for a leak check.
function isPathIgnored(root: string, rel: string): boolean {
  try { execFileSync("git", ["-C", root, "check-ignore", "-q", rel], { stdio: "ignore" }); return true; }
  catch { return false; }
}

// LOOP-235 — the commits the next `git push` would transfer, as a `rev-list`/`diff` range. Prefer the
// branch's configured push destination (`@{push}`) then its upstream (`@{upstream}`): `<dest>..HEAD` is
// EXACTLY what a push to that ref sends, and — unlike `HEAD --not --remotes` — still includes a commit
// merely reachable from an UNRELATED remote (LOOP-235 P1 #5). With NO destination configured (a fresh
// branch never pushed, or a current branch with no tracking ref) the push target is unknowable, so scan
// ALL of HEAD rather than `HEAD --not --remotes`, which subtracts commits an explicit
// `git push origin HEAD:<branch>` still ships (LOOP-235 review, no-destination). Shared by the bundle-blob
// walk AND moved.json's push-aware committed classification so the two can't diverge (LOOP-235 review
// PRRT_kwDOS6Puk86VoHA7).
//
// OFFLINE-SCOPE LIMITATION (LOOP-235 review PRRT_kwDOS6Puk86VoHA3): `@{push}`/`@{upstream}` are cached
// remote-tracking refs, refreshed by `git fetch` — reading them here does NOT contact the remote. If
// another client rewinds or deletes the remote branch AFTER this workspace's last fetch, the cached ref is
// stale and this range can under-report what the next push would restore. Closing that would require a
// network round-trip (`git ls-remote`), which `doctor` deliberately does NOT do: it is a fast, OFFLINE
// diagnostic, and adding per-run network I/O (a contract change — breaks offline use, adds W15/perf cost)
// to catch a narrow multi-client remote-rewind race would be strictly worse than reflecting the last-known
// remote. The range is correct as of the last fetch; a concurrent remote rewind is out of scope for a
// local, offline check.
function unpushedRange(root: string): string[] {
  const revParseOk = (rev: string): boolean =>
    spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", rev], { stdio: ["ignore", "ignore", "ignore"] }).status === 0;
  const dest = revParseOk("@{push}") ? "@{push}" : revParseOk("@{upstream}") ? "@{upstream}" : null;
  return dest ? [`${dest}..HEAD`] : ["HEAD"];
}

// LOOP-235 — classify a path's git state(s) for W06's remediation (review P1 #7/#8/#bA + PRRT_…VoHA7):
// "untracked" (not in the index → a .gitignore rule fixes it), "staged" (in the index, not yet in HEAD →
// `git rm -f --cached` + remove the worktree copy), "committed" (in an UNPUSHED commit → rewrite it before
// pushing), or "published" (in an already-PUSHED commit → rewriting won't un-leak it; rotate + .gitignore).
// The committed-vs-published split is push-aware via `unpushedRange` — the SAME range the bundle arm ships —
// so W06 never tells the operator to rewrite already-published history. A path can be in BOTH "staged" and
// "committed" (a file in a prior unpushed commit, re-staged) — every applicable state is returned so the
// remediation covers each cleanup step. Used for moved.json.
function indexStates(root: string, rel: string): ("untracked" | "staged" | "committed" | "published")[] {
  const runOk = (args: string[]): boolean =>
    spawnSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "ignore"] }).status === 0;
  if (!runOk(["ls-files", "--error-unmatch", "--", rel])) return ["untracked"];
  const states: ("staged" | "committed" | "published")[] = [];
  if (runOk(["cat-file", "-e", `HEAD:${rel}`])) {
    // Push-aware: the blob is in HEAD, but "committed" (rewrite advice) is only right when the commit
    // carrying rel is UNPUSHED — the same range the bundle arm ships. If it is already pushed, rewriting is
    // wrong advice (it would rewrite published history), so classify "published" (rotate + .gitignore).
    const unpushed = spawnSync("git", ["-C", root, "rev-list", ...unpushedRange(root), "--", rel],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    states.push((unpushed.stdout ?? "").trim() ? "committed" : "published");
  }
  // Staged when the index has the file (ls-files matched above) and it differs from HEAD (or HEAD has no entry).
  // `diff --cached --quiet -- rel` exits 0 when no staged diff, 1 when staged changes exist.
  if (spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", rel], { stdio: "ignore" }).status !== 0)
    states.push("staged");
  return states.length ? states : ["staged"]; // fallback: tracked but not in HEAD and no diff (shouldn't happen)
}

// LOOP-210 + LOOP-235 — files under <root> that a routine git op (commit or push) would land in
// history and whose first bytes are the bundle MAGIC header. A bundle (operator-chosen --out name,
// encrypted or plaintext) carries every secret VALUE + hub.db. The guard must see every path reachable
// by the next commit/push AND probe the CONTENT that would actually ship, arm by arm:
//   • untracked, not-ignored — the worktree file IS that content (`ls-files --others` honours .gitignore);
//   • staged — the INDEX blob (`:path`), NOT the worktree: a bundle staged then modified/removed in the
//     worktree (`AM`/`AD`) keeps the magic in the index and still lands on commit (LOOP-235 review P1 #1);
//   • committed-but-unpushed — the blob in EACH unpushed commit's tree, NOT the endpoint diff: a bundle
//     added in one unpushed commit and deleted in a later one nets to nothing in `upstream..HEAD` yet
//     still ships in the intermediate commit on push (LOOP-235 review P1 #2).
// A staged/committed path is tracked, so its presence in the index/local history is itself the leak,
// regardless of ignore rules. A path may carry a DIFFERENT bundle in the index AND in an unpushed commit;
// both are reported with their own state (never collapsed to one), so the remediation covers unstage AND
// rewrite — collapsing would drop a live escape (LOOP-235 review, both-states). The 16-byte MAGIC probe is
// the discriminator, so a broad candidate set is safe — only real bundles are flagged. Only the UNTRACKED
// worktree arm is capped (MAX_UNTRACKED_PROBES), the single set that can be pathologically large; the
// STAGED and COMMITTED arms scan in FULL, because truncating a secret-leak scan could print clean while a
// bundle past the cutoff still ships (LOOP-235 review P1 #9). Every tracked candidate is probed through a
// shared, content-budget-bounded `git cat-file --batch` — one batch process per group, NOT a subprocess
// per path (LOOP-235 review P2: the no-destination scan below can select all of HEAD, so per-path spawning
// would launch a `cat-file` per blob in history). A blob larger than the budget rides its own group and
// costs only the captured prefix (spawnSync returns ENOBUFS yet hands back the leading bytes, all the
// 16-byte compare needs), so a multi-MB bundle is never fully slurped and the scan never truncates. MAGIC
// must match bundle.ts (the bundle-gitguard test writes a real bundle and asserts this detects it, so the
// two constants can't silently drift).
function unignoredBundleArtifacts(root: string): { path: string; state: "untracked" | "staged" | "committed" }[] {
  const MAGIC = "DEVLOOP-BUNDLE/1";
  const MAX_UNTRACKED_PROBES = 2000;
  const CATFILE_BUDGET = 8 << 20; // bytes of blob content captured per `cat-file --batch` group
  const CHECK_CHUNK = 4096;       // specs per `cat-file --batch-check` call (bounds its stdout buffer)
  // P1 fix (PRRT_kwDOS6Puk86Vn_bB): on maxBuffer overflow execFileSync throws; catch rethrows so the
  // W06 check surfaces the truncation rather than silently returning [] and reporting a false clean.
  // All other errors (not a repo, git not found) are safe to swallow with [] — they mean no paths.
  const gitZ = (args: string[]): string[] => {
    try {
      return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24 })
        .toString().split("\0").filter(Boolean);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOBUFS") throw e; // fail loud — a silent [] drops candidates
      return [];
    }
  };
  const gitLines = (args: string[]): string[] => {
    try {
      return execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24 })
        .toString().split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOBUFS") throw e; // fail loud — a silent [] drops candidates
      return [];
    }
  };
  const bufHasMagic = (buf: Buffer | undefined, at = 0): boolean =>
    !!buf && buf.length >= at + MAGIC.length && buf.subarray(at, at + MAGIC.length).toString("latin1") === MAGIC;
  const worktreeHasMagic = (rel: string): boolean => {
    let fd: number | undefined;
    try {
      fd = openSync(join(root, rel), "r");
      const buf = Buffer.alloc(MAGIC.length);
      const n = readSync(fd, buf, 0, MAGIC.length, 0);
      return n === MAGIC.length && buf.toString("latin1") === MAGIC;
    } catch { return false; } // unreadable/gone — skip
    finally { if (fd !== undefined) closeSync(fd); }
  };
  // Single-object probe: `:path` = the staged/index blob, `<commit>:path` = a blob in a commit tree. Used
  // only for the newline-in-path fallback below (the `cat-file --batch` stdin line protocol cannot carry a
  // path with a newline); a small maxBuffer bounds memory — on a large bundle spawnSync returns ENOBUFS yet
  // still hands back the captured prefix, all the 16-byte compare needs.
  const blobHasMagic = (spec: string): boolean =>
    bufHasMagic(spawnSync("git", ["-C", root, "cat-file", "blob", spec], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 16 }).stdout as Buffer | undefined);

  // (path, state) hits, distinct — NOT keyed by path alone, so a path that carries a bundle in BOTH the
  // index and an unpushed commit keeps both states (LOOP-235 review, both-states remediation).
  const pairs: [string, "untracked" | "staged" | "committed"][] = [];
  const seenPair = new Set<string>();
  const addPair = (path: string, state: "untracked" | "staged" | "committed") => {
    const k = `${state}\0${path}`;
    if (!seenPair.has(k)) { seenPair.add(k); pairs.push([path, state]); }
  };

  // ---- gather every tracked candidate object spec, each tagged with its (path, state) ----
  const specs: { spec: string; path: string; state: "staged" | "committed" }[] = [];
  // Staged (index) — `diff --cached --name-only` lists staged paths against HEAD, or the empty tree on an
  // unborn HEAD (a fresh `git init` — the exact repro), so a bundle staged before the first commit is seen.
  // The index blob is `:path`; a staged deletion resolves to `missing` below and is skipped.
  for (const rel of gitZ(["diff", "--cached", "--name-only", "-z"]))
    specs.push({ spec: `:${rel}`, path: rel, state: "staged" });
  // Committed-but-unpushed — walk EVERY commit the next `git push` would transfer (the `unpushedRange`
  // helper: `<dest>..HEAD`, or all of HEAD with no destination — see its doc for the range rationale and the
  // offline-scope limitation) and probe the blobs IT introduced, so an add-then-delete pair is still caught
  // (P1 #2; no cap — P1 #9). `-c` (combined diff) makes a MERGE commit report paths that differ from ALL
  // parents — a bundle added during conflict resolution, which a plain `diff-tree -r` suppresses for merges
  // (P1 #3); for a non-merge commit `-c` is a no-op. `--diff-filter=AMT` keeps a TYPE change (`T`) — a bundle
  // replacing a symlink/submodule (P1 #6). `--root` covers an initial commit; deletions (D, excluded) have
  // no blob here and were already probed at the commit that added them.
  for (const commit of gitLines(["rev-list", ...unpushedRange(root)]))
    for (const rel of gitZ(["diff-tree", "-r", "-c", "--no-commit-id", "--name-only", "-z", "--diff-filter=AMT", "--root", commit]))
      specs.push({ spec: `${commit}:${rel}`, path: rel, state: "committed" });

  // ---- resolve specs → blob OIDs (deduped) via batched `cat-file --batch-check`, then probe each unique
  //      blob through content-budget-bounded `cat-file --batch` groups (LOOP-235 review P2) ----
  const oidRefs = new Map<string, { path: string; state: "staged" | "committed" }[]>(); // oid → its (path,state)s
  const oidSize = new Map<string, number>();
  const nlFallback: { spec: string; path: string; state: "staged" | "committed" }[] = [];
  const batchable = specs.filter((s) => { if (s.path.includes("\n")) { nlFallback.push(s); return false; } return true; });
  for (let i = 0; i < batchable.length; i += CHECK_CHUNK) {
    const chunk = batchable.slice(i, i + CHECK_CHUNK);
    const out = spawnSync("git", ["-C", root, "cat-file", "--batch-check"],
      { input: chunk.map((c) => c.spec).join("\n") + "\n", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 1 << 24 });
    const lines = (out.stdout ? out.stdout.toString() : "").split("\n"); // one line per query, in order
    for (let j = 0; j < chunk.length; j++) {
      const line = lines[j];
      if (!line || line.endsWith(" missing")) continue; // deleted/absent — no blob to ship
      const p = line.split(" ");
      if (p[1] !== "blob") continue;
      const oid = p[0], size = parseInt(p[2], 10);
      if (!Number.isFinite(size)) continue;
      oidSize.set(oid, size);
      let refs = oidRefs.get(oid);
      if (!refs) { refs = []; oidRefs.set(oid, refs); }
      refs.push({ path: chunk[j].path, state: chunk[j].state });
    }
  }
  // Probe unique blobs, grouped so each `--batch` call's captured content stays within budget; a lone blob
  // larger than the budget rides its own group (the ENOBUFS prefix still holds the header + 16 magic bytes).
  // The candidate SET is never truncated (P1 #9) — only content past the budget of an oversized blob is, and
  // the magic sits in the first 16 bytes.
  const magic = new Set<string>();
  const probeGroup = (oids: string[]) => {
    if (!oids.length) return;
    const out = spawnSync("git", ["-C", root, "cat-file", "--batch"],
      { input: oids.join("\n") + "\n", stdio: ["pipe", "pipe", "ignore"], maxBuffer: CATFILE_BUDGET + (1 << 20) });
    const buf = out.stdout as Buffer | undefined;
    if (!buf) return;
    let i = 0;
    while (i < buf.length) {
      const nl = buf.indexOf(0x0a, i);
      if (nl < 0) break;
      const p = buf.toString("utf8", i, nl).split(" ");
      i = nl + 1;
      if (p[p.length - 1] === "missing") continue; // no content body follows
      const size = parseInt(p[2], 10);
      if (!Number.isFinite(size)) break; // malformed header — stop this (bounded) group
      // A blob shorter than MAGIC can't be a bundle; the guard also keeps the probe inside this object's
      // own content rather than reading into the next header.
      if (p[1] === "blob" && size >= MAGIC.length && bufHasMagic(buf, i)) magic.add(p[0]);
      i += size + 1; // skip content + trailing LF; may run past a truncated (ENOBUFS) tail, ending the loop
    }
  };
  {
    let group: string[] = [], bytes = 0;
    for (const [oid, size] of oidSize) {
      // + the `--batch` header (`<oid> blob <size>\n`) and the trailing LF. Sized for a 64-char
      // SHA-256 oid (not just 40-char SHA-1) + a long size field, so the ESTIMATE is never below the
      // real per-object overhead: a group's actual output then stays under `probeGroup`'s maxBuffer
      // (CATFILE_BUDGET + 1 MiB) even for ~100k tiny blobs, and no bundle is lost to an ENOBUFS-
      // truncated tail (LOOP-235 review, SHA-256 header sizing).
      const cost = size + 128;
      if (group.length && bytes + cost > CATFILE_BUDGET) { probeGroup(group); group = []; bytes = 0; }
      group.push(oid); bytes += cost;
      if (bytes >= CATFILE_BUDGET) { probeGroup(group); group = []; bytes = 0; } // an oversized blob flushes alone
    }
    probeGroup(group);
  }
  for (const oid of magic)
    for (const ref of oidRefs.get(oid) ?? []) addPair(ref.path, ref.state);
  // Newline-in-path fallback (unbatchable) — probe individually so the scan stays complete (never silent).
  for (const s of nlFallback)
    if (blobHasMagic(s.spec)) addPair(s.path, s.state);

  // Untracked, not ignored — the worktree file is the content. Probe LAST and capped: a pathological
  // untracked set (a stray node_modules, build output) can be huge, so this is the ONE arm with the DoS cap.
  const trackedPaths = new Set(pairs.map(([path]) => path));
  let u = 0;
  for (const rel of gitZ(["ls-files", "--others", "--exclude-standard", "-z"])) {
    if (u++ >= MAX_UNTRACKED_PROBES) break;
    if (!trackedPaths.has(rel) && worktreeHasMagic(rel)) addPair(rel, "untracked");
  }
  return pairs.map(([path, state]) => ({ path, state }));
}

// W27 helper — extracted to keep doctorWorkspace CC in budget (LOOP-244). Best-effort; never throws.
// Flags non-terminal null-assignee tickets unreachable by every actor. Backlog+Todo are only
// flagged in split-dev (mine() makes null Todo dev's own in legacy; PM's backlog queue is label-blind).
// In Progress: always flag — mine() only applies to Todo; inProgress keys on strict assignee===actor.
// InReview: reachable iff (a) qa/pm label (verify slice, both modes) OR (b) dev-tier label AND
// devSplit:true (servable.ts tier-label fallback, split-dev only; not wired for legacy dev actor).
// W29 — tombstoned-project divergence (LOOP-307 AC4, design destructive-verb-safety "Child C").
// W08 covers the general never-seeded case; W29 fires only when the missing hub row has a
// removed_projects tombstone — the config still names a project a destructive verb DELETED, which
// is the 2026-08-04 shape (deletion masked for two hours by a silent find-or-create re-seed).
// Warn-only, never flips DOCTOR_OK; a named helper, not inline, per the CRAP-90 ratchet.
function warnTombstonedProjects(db: DatabaseSync, unseededKeys: string[], warn: (m: string) => void): void {
  for (const key of unseededKeys) {
    try {
      const tomb = db.prepare("SELECT removed_at, removed_by, ticket_count, verb FROM removed_projects WHERE key=?").get(key) as
        | { removed_at: string; removed_by: string; ticket_count: number; verb: string } | undefined;
      if (!tomb) continue;
      warn(`[W29] projects.${key}: config still lists '${key}', but it was REMOVED on ${tomb.removed_at} by ${tomb.removed_by} (${tomb.ticket_count} ticket(s) destroyed, via ${tomb.verb}) — a re-seed would resurrect it as an empty board. Either delete the config entry (dev-loop team remove-project ${key}) or re-create deliberately with DEVLOOP_ALLOW_RESURRECT=1.`);
    } catch { /* pre-tombstone db (table absent) — nothing to report; W08 already covered the gap */ }
  }
}

function checkNullAssigneeStranded(db: DatabaseSync, projectId: string, devSplitOn: boolean, warn: (m: string) => void): void {
  try {
    const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]);
    const DEV_TIERS = ["junior-dev", "senior-dev"];
    const rows = db.prepare("SELECT id, state, labels FROM tickets WHERE project_id=? AND assignee IS NULL").all(projectId) as { id: string; state: string; labels: string }[];
    const stranded: { id: string; tier: string | null }[] = [];
    for (const row of rows) {
      if (TERMINAL.has(row.state)) continue;
      const labels = JSON.parse(row.labels) as string[];
      const tier = DEV_TIERS.find((t) => labels.includes(t)) ?? null;
      if (row.state === "Backlog" || row.state === "Todo") {
        // legacy: mine() makes null Todo dev's own; Backlog is PM-visible via label-blind backlog queue
        if (!devSplitOn) continue;
        stranded.push({ id: row.id, tier });
        continue;
      }
      if (row.state === "In Review") {
        // Reachable via qa/pm owner label (verify slice, both modes) OR dev-tier label in split-dev
        // (servable.ts tier-label fallback is only wired for non-dev split-dev actors).
        const verifiable = labels.includes("qa") || labels.includes("pm");
        const landable = devSplitOn && tier !== null;
        // Preserve the resolved tier (LOOP-270): a residual dev-tier label on a legacy-mode
        // stranded ticket must yield a paste-ready `--assignee <tier>` hint, not the literal
        // `<tier>` placeholder — that fallback is only for the genuinely tier-less case.
        if (!verifiable && !landable) stranded.push({ id: row.id, tier });
        continue;
      }
      // In Progress — mine() only applies to Todo; inProgress keys on strict assignee===actor in both modes
      stranded.push({ id: row.id, tier });
    }
    if (stranded.length === 0) return;
    const idList = stranded.map((s) => s.id).join(", ");
    const first = stranded[0]!;
    const tierHint = first.tier ?? "<tier>";
    warn(`${stranded.length} non-terminal ticket${stranded.length === 1 ? "" : "s"} with null assignee unreachable: ${idList} — fix: dev-loop ticket update ${first.id} --assignee ${tierHint}`);
  } catch { /* best-effort — never fails doctor */ }
}

// W22 — landing stall: forge glance, warn/info only, never flips DOCTOR_OK (design §5.1).
// Fires only when ≥1 qualifying repo (landing:"pr" + autoMerge). DEVLOOP_DOCTOR_NO_FORGE=1 → skip.
// Returns the first stalled ghRepo name (for NEXT flip), or undefined.
async function checkLandingW22Stall(
  ws: Workspace,
  opts: { exec?: import("./landing.ts").ExecFn },
  out: { warn: (m: string) => void; info: (m: string) => void; pass: (m: string) => void }
): Promise<string | undefined> {
  const { warn, info, pass } = out;
  const hasQualifyingRepo = Object.values(ws.file.repos).some((r) => r.landing === "pr" && r.autoMerge);
  if (!hasQualifyingRepo) return undefined;
  if (process.env.DEVLOOP_DOCTOR_NO_FORGE === "1") { info("landing check skipped (DEVLOOP_DOCTOR_NO_FORGE=1)"); return undefined; }
  let stalledRepo: string | undefined;
  try {
    const states = await readLandingState(ws, opts.exec ? { exec: opts.exec } : {});
    for (const s of states) {
      if (s.state === "stalled") {
        const age = s.oldestAgeDays !== null ? `${Math.round(s.oldestAgeDays)}d` : "?d";
        const base = s.baseChecks ?? "unknown";
        const remote = ws.file.repos[s.repo]?.remote ?? "";
        const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
        const ghRepo = m ? m[1]! : s.repo;
        warn(`[W22] [${s.repo}] landing stalled: ${s.openLoopPRs} open dev-loop/* PR(s), oldest ${age}; base '${effectiveRepo(ws, s.repo).defaultBranch}' required checks ${base} — autoMerge cannot fire. Clear it: gh pr list --repo ${ghRepo} --state open --head dev-loop/`);
        if (!stalledRepo) stalledRepo = ghRepo;
      } else if (s.state === "unknown") {
        info(`landing: ${s.reason ?? "forge unreachable"} (best-effort; not a failure)`);
      } else if (s.state === "healthy" && (s.openLoopPRs ?? 0) > 0) {
        pass(`landing: ${s.openLoopPRs} open loop PR(s), base green — nothing wedged`);
      }
    }
  } catch { /* W22 is best-effort — never fails doctor */ }
  return stalledRepo;
}

// Resolve hub/package.json 'files' to git-repo paths for the W18 code-commit pathspec.
// dist/ is compiled from hub/src/ (not tracked in git); postinstall.cjs is under hub/;
// README.md is packaged but doc-only. Root-relative entries (skills/, references/, etc.) pass through.
function packagedCodePaths(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f === "README.md" || f === "CHANGELOG.md") continue;
    if (f === "dist/" || f === "dist") { out.push("hub/src/"); continue; }
    out.push(f === "postinstall.cjs" ? "hub/postinstall.cjs" : f);
  }
  return out;
}

// W18 — installed CLI vs origin/main skew (design landing-observability §9.3).
// Only fires when the running package's repository matches a configured landing:"pr" repo (the dogfooding
// case). For all normal product workspaces this is a zero-cost n/a — no git calls, no output.
// DEVLOOP_W18_PKG_JSON overrides the package.json path for test injection (no real reinstall needed).
// Returns { codeBehind, version } when honest code-commit skew > 0 (for the §9.8 NEXT hint); null otherwise.
function checkInstalledCliSkew(ws: Workspace, out: { warn: (m: string) => void; info: (m: string) => void; pass: (m: string) => void }): { codeBehind: number; version: string } | null {
  const { warn, info, pass } = out;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgFile = process.env.DEVLOOP_W18_PKG_JSON ?? join(here, "..", "package.json");
  let pkgData: { name?: string; version?: string; repository?: string | { url?: string } } | null = null;
  try { pkgData = JSON.parse(readFileSync(pkgFile, "utf8")); } catch { /* unreadable — skip silently */ }
  if (!pkgData) return null;
  const V = (pkgData.version ?? "").trim();
  const rawUrl = typeof pkgData.repository === "string" ? pkgData.repository : (pkgData.repository?.url ?? "");
  if (!V || !rawUrl) return null;
  const normalize = (u: string): string => {
    const s = u.replace(/^git\+/, "").replace(/\.git$/, "");
    const ssh = s.match(/^git@([^:]+):(.+)$/);
    if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
    try { const p = new URL(s); return (p.host + "/" + p.pathname.replace(/^\//, "")).toLowerCase(); } catch { return s.toLowerCase(); }
  };
  const pkgNorm = normalize(rawUrl);
  let matchRef: string | null = null, matchDir = "", matchBranch = "main";
  const pkgName = pkgData.name ?? "dev-loop";
  for (const [ref, entry] of Object.entries(ws.file.repos)) {
    if (entry.landing !== "pr" || !entry.remote) continue;
    if (normalize(entry.remote) === pkgNorm) {
      const r = effectiveRepo(ws, ref);
      matchRef = ref; matchDir = r.absPath; matchBranch = r.defaultBranch; break;
    }
  }
  if (matchRef === null) return null; // n/a — no configured repo matches this package
  if (!existsSync(matchDir) || !isGitWorkTree(matchDir)) {
    info(`[${matchRef}] W18: repo not on disk — cannot check installed-vs-origin skew (best-effort)`);
    return null;
  }
  try {
    let vCommit: string | null = null;
    let isSourceBuild = false;
    // LOOP-250: a build-commit stamp tells us EXACTLY which commit is running (source build).
    // Under DEVLOOP_W18_PKG_JSON the stamp must come from BESIDE the injected package.json —
    // pkgBuildCommit() reads the running source tree's own stamp via import.meta.url, which is
    // the wrong tree for an injected fixture (and a committed stale stamp there poisons every
    // arm: 2026-08-04, doctor-build-commit + team-cli W18 cases).
    let buildCommit: string | null;
    if (process.env.DEVLOOP_W18_PKG_JSON) {
      try {
        buildCommit = (JSON.parse(readFileSync(join(dirname(pkgFile), "build-commit.json"), "utf8")) as { commit?: string }).commit ?? null;
      } catch { buildCommit = null; }
    } else {
      buildCommit = pkgBuildCommit();
    }
    if (buildCommit) {
      vCommit = buildCommit;
      isSourceBuild = true;
    } else {
      const tagR = spawnSync("git", ["-C", matchDir, "rev-parse", "-q", "--verify", `refs/tags/v${V}^{commit}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (tagR.status === 0 && tagR.stdout.trim()) {
        vCommit = tagR.stdout.trim();
      } else {
        const logR = spawnSync("git", ["-C", matchDir, "log", `--grep=chore(release): v${V}`, "--format=%H", "-1"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        if (logR.status === 0 && logR.stdout.trim()) vCommit = logR.stdout.trim();
      }
    }
    if (!vCommit) {
      info(`[${matchRef}] W18: v${V} commit unresolvable (no v${V} tag and no matching release commit) — skipping (best-effort)`);
      return null;
    }
    const behindR = spawnSync("git", ["-C", matchDir, "rev-list", "--count", `${vCommit}..origin/${matchBranch}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (behindR.status !== 0 || !behindR.stdout.trim()) {
      info(`[${matchRef}] W18: origin/${matchBranch} not resolved locally (run git fetch to check; best-effort)`);
      return null;
    }
    const behind = parseInt(behindR.stdout.trim(), 10);
    if (isNaN(behind)) {
      info(`[${matchRef}] W18: rev-list output unexpected — skipping (best-effort)`);
    } else if (behind > 0) {
      // Count only packaged-path commits. LOOP-151: doc-only fires are noise.
      // LOOP-191: derive pathspec from hub/package.json so skills/**/*.md and
      // references/**/*.md (published behavior) count; fallback to :(exclude)*.md when absent.
      const hubPkgPath = join(matchDir, "hub", "package.json");
      let codePathspec: string[] = [".", ":(exclude)docs/", ":(exclude)*.md"]; // LOOP-151 fallback
      try {
        const hubFiles = (JSON.parse(readFileSync(hubPkgPath, "utf8")).files ?? []) as string[];
        const resolved = packagedCodePaths(hubFiles);
        if (resolved.length > 0) codePathspec = resolved;
      } catch { /* keep fallback when hub/package.json is absent or unreadable */ }
      const codeR = spawnSync("git", ["-C", matchDir, "rev-list", "--count", `${vCommit}..origin/${matchBranch}`,
        "--", ...codePathspec],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const codeRaw = (codeR.status === 0 && codeR.stdout.trim()) ? parseInt(codeR.stdout.trim(), 10) : NaN;
      const codeBehind = isNaN(codeRaw) ? behind : codeRaw; // fallback to total when pathspec fails
      if (codeBehind > 0) {
        const docBehind = behind - codeBehind;
        const shortR = spawnSync("git", ["-C", matchDir, "rev-parse", "--short", `origin/${matchBranch}`],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const shortSha = shortR.stdout.trim() || "unknown";
        const docNote = docBehind > 0 ? ` (+${docBehind} doc-only)` : "";
        const sourceNote = isSourceBuild
          ? "the installed CLI is a local source build — reinstall from the updated source"
          : "every fire runs the published npm package, not origin/main. An operator must re-publish + agents reinstall, or pin agents to a local build (design landing-observability §9.2)";
        warn(`[W18] [${matchRef}] installed ${pkgName} v${V} is ${codeBehind} code commit(s) behind origin/${matchBranch} (${shortSha})${docNote} — CLI-behavior fixes merged after v${V} are NOT live: ${sourceNote}.`);
        return { codeBehind, version: V };
      }
      // codeBehind === 0: all commits are doc-only — silent (no behavior skew)
    } else {
      // behind === 0, but only as fresh as the local tracking ref. Include the ref's
      // short sha and age so the operator knows when this was last measured.
      const shortRefR = spawnSync("git", ["-C", matchDir, "rev-parse", "--short", `origin/${matchBranch}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const ageR = spawnSync("git", ["-C", matchDir, "log", "-1", "--format=%ar", `origin/${matchBranch}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const refSha = shortRefR.stdout.trim() || "unknown";
      const refAge = ageR.stdout.trim();
      const qualifier = refAge ? `${refSha}, ${refAge}` : refSha;
      pass(`[${matchRef}] installed ${pkgName} v${V} matches origin/${matchBranch} (${qualifier}) — no skew as of last fetch; run git fetch to confirm`);
    }
  } catch { info(`[${matchRef}] W18: git check skipped (best-effort)`); }
  return null;
}

// ── D8/D9: CLI-interface preflight (W09/W10/W11) ─────────────────────────────────────────────────────────
// The release that shipped the dev-loop write-layer verbs (op/ticket create|update/comment/doc save/…) — an
// older global install has no board-write surface, so every interface="cli" fire fails closed with exit 4.
const WRITE_VERBS_MIN_VERSION = "1.2.0";

// The coding agents a project's fires may launch with, from CONFIG alone: the project/team
// defaultCodingAgent plus every per-agent codingAgent override; the scheduler's built-in default
// ('claude') when none is declared. Doctor cannot see a run's --cli flag — config is the contract.
function projectCodingAgents(p: { defaultCodingAgent?: unknown; agents?: unknown } | undefined): string[] {
  const out = new Set<string>();
  out.add(typeof p?.defaultCodingAgent === "string" && p.defaultCodingAgent.trim() ? p.defaultCodingAgent.trim() : "claude");
  for (const a of Object.values((p?.agents ?? {}) as Record<string, { codingAgent?: unknown } | undefined>)) {
    if (a && typeof a.codingAgent === "string" && a.codingAgent.trim()) out.add(a.codingAgent.trim());
  }
  return [...out];
}

// major.minor.patch compare; an unparseable version counts as older (the warn text carries the raw string).
function semverBefore(a: string, b: string): boolean {
  const pa = a.match(/^(\d+)\.(\d+)\.(\d+)/), pb = b.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return true;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d !== 0) return d < 0; }
  return false;
}

// W09 — `dev-loop` must resolve on PATH from a fire's env (fires inherit this process's PATH);
// W10 — the installed version must carry the write verbs (>= WRITE_VERBS_MIN_VERSION);
// W11 — identity smoke: `dev-loop project` under a fire-shaped env must exit 0 (the fail-closed
//        regression: an unresolved/unseeded project or phantom actor exits 4 — catch it here, not
//        as a silent full-turn burn on every fire). Prints NOTHING when no interface is "cli".
function cliInterfaceChecks(ws: Workspace, hubKeys: string[], dbPath: string,
  out: { pass: (m: string) => void; warn: (m: string) => void; info: (m: string) => void }): void {
  const byInterface: Record<"cli" | "mcp", Set<string>> = { cli: new Set(), mcp: new Set() };
  const cliProjects: string[] = [];
  for (const key of deliveryProjects(ws)) {
    const eff = effectiveProject(ws, key);
    let onCli = false;
    for (const ca of projectCodingAgents(eff)) {
      byInterface[agentInterfaceFor(eff.hub as HubBlock | undefined, ca)].add(ca);
      if (agentInterfaceFor(eff.hub as HubBlock | undefined, ca) === "cli") onCli = true;
    }
    if (onCli) cliProjects.push(key);
  }
  if (!byInterface.cli.size) return; // fully on MCP — the CLI preflight does not apply
  const iface = (["cli", "mcp"] as const).flatMap((i) => [...byInterface[i]].sort().map((ca) => `${ca}→${i}`)).join(", ");
  out.info(`agent interface: ${iface} — "cli" fires depend on the PATH-installed dev-loop write layer`);
  const ver = spawnSync("dev-loop", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (ver.error || (ver.status ?? 1) !== 0) {
    out.warn(`[W09] dev-loop is not runnable on PATH — every interface="cli" fire has NO board access; install it: npm i -g @dyzsasd/dev-loop`);
    return;
  }
  const installed = (ver.stdout ?? "").trim();
  if (semverBefore(installed, WRITE_VERBS_MIN_VERSION)) {
    out.warn(`[W10] dev-loop '${installed}' on PATH predates the CLI write layer (need >= ${WRITE_VERBS_MIN_VERSION}) — interface="cli" fires cannot write the board; upgrade: npm i -g @dyzsasd/dev-loop@latest`);
    return;
  }
  out.pass(`dev-loop ${installed} on PATH (>= ${WRITE_VERBS_MIN_VERSION}, carries the write verbs)`);
  // Fire-shaped env: the exact identity vars run-agents exports per fire (runAgent), against THIS hub.db.
  // Prefer a seeded interface="cli" delivery project; else the _team intake row (team init always seeds it).
  const smokeKey = cliProjects.find((k) => hubKeys.includes(k)) ?? TEAM_INTAKE_PROJECT;
  const smoke = spawnSync("dev-loop", ["project", "--json"], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, DEVLOOP_ACTOR: "pm", DEVLOOP_PROJECT: smokeKey, DEVLOOP_HUB_DB: dbPath, DEVLOOP_DEV_SPLIT: "false" },
  });
  if ((smoke.status ?? 1) !== 0) {
    const firstErr = (smoke.stderr ?? "").trim().split("\n")[0] ?? "";
    out.warn(`[W11] identity smoke failed: \`dev-loop project\` exited ${smoke.status ?? "?"} for project '${smokeKey}' under a fire-shaped env — interface="cli" fires would boot with NO board access${firstErr ? ` (${firstErr})` : ""}`);
  } else {
    out.pass(`identity smoke: dev-loop project → '${smokeKey}' as pm under a fire-shaped env (exit 0)`);
  }
}

// ── DL-81: service runtime-wiring reconcile ──────────────────────────────────────────────────────────────
// ADDITIVE, READ-ONLY, NON-FATAL. After the DB-integrity checks (the ONLY hard-fail gate), if this doctor run
// is for a service-backend project that LIVES IN THE DB WE JUST INSPECTED, ALSO report whether the runtime an
// operator wired at init (init-service.ts steps (c)/(e) + the DL-42 hook) is still in place — the idempotent
// "is my service backend wired and up?" reconcile. init already runs doctor (DL-60), so its Step-8 readiness
// checklist inherits these lines with no SKILL change. Every line is PASS/WARN, NEVER a fail: a stopped daemon
// / absent .mcp.json / missing hook is operator-actionable info, not a broken SoR. With NO service context
// this prints NOTHING — the DB-only verdict stays byte-for-byte today's.
async function serviceReconcile(dbProjectKeys: string[], dbPath: string): Promise<void> {
  const pass = (m: string) => console.log("✅ " + m);
  const warn = (m: string) => console.log("⚠️  " + m);

  // Resolve the project context exactly as the MCP server / DL-13 launcher do: an explicit DEVLOOP_PROJECT
  // wins, else match cwd against the configured repo paths. null ⇒ no context.
  const cfg = loadProjectsConfig();
  const key = process.env.DEVLOOP_PROJECT?.trim() || (cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null);
  // The reconcile is about the wiring of a project that lives in the db doctor just checked. A key resolved
  // from cwd/env but ABSENT from this db (doctor pointed at a temp/other db, or cwd resolved a SIBLING project)
  // is not this db's context — skip silently, keeping the DB-only verdict byte-for-byte unchanged.
  if (!key || !dbProjectKeys.includes(key)) return;

  console.log(`\nservice runtime wiring — '${key}' (best-effort; informational, not a hard-fail gate):`);

  // (1) the product repo .mcp.json registers dev-loop-hub with a real server path + DEVLOOP_ACTOR wiring.
  // D8 scope: this is an MCP-interface concern only — when every coding agent configured for this project
  // resolves to interface="cli" (D9 default for claude), a missing registration is CORRECT, not a gap.
  const pcfg = cfg?.projects?.[key] as { repoPath?: string; hub?: unknown; defaultCodingAgent?: unknown; agents?: unknown } | undefined;
  const anyMcp = projectCodingAgents(pcfg).some((ca) => agentInterfaceFor(pcfg?.hub as HubBlock | undefined, ca) === "mcp");
  if (!anyMcp) pass(`.mcp.json — not required: every coding agent configured for '${key}' is on interface="cli" (the dev-loop write layer, D8)`);
  else if (!pcfg?.repoPath) warn(`.mcp.json — no repoPath for '${key}' in projects.json; cannot verify the dev-loop-hub registration (set repoPath, or register by hand from config/mcp.example.json)`);
  else reconcileMcpJson(join(pcfg.repoPath, ".mcp.json"), pass, warn);

  // (2) the per-project daemon /api/health is reachable (url from the lifecycle runfile beside the db).
  await reconcileDaemonHealth(key, dbPath, pass, warn);

  // (3) standalone autostart and optional Claude hook compatibility.
  reconcileAutostart(pass, warn);
  reconcileSessionStartHook(pass);
}

function reconcileMcpJson(mcpJsonPath: string, pass: (m: string) => void, warn: (m: string) => void): void {
  if (!existsSync(mcpJsonPath)) { warn(`.mcp.json — ${mcpJsonPath} not found; dev-loop-hub is not registered (re-run init, or merge from config/mcp.example.json)`); return; }
  let cfg: { mcpServers?: Record<string, { command?: unknown; args?: unknown[]; env?: Record<string, unknown> }> };
  try { cfg = JSON.parse(readFileSync(mcpJsonPath, "utf8")); }
  catch (e) { warn(`.mcp.json — ${mcpJsonPath} is malformed JSON, cannot verify the registration (${(e as Error).message})`); return; }
  const entry = cfg?.mcpServers?.["dev-loop-hub"];
  if (!entry || typeof entry !== "object") { warn(`.mcp.json — no mcpServers["dev-loop-hub"] entry in ${mcpJsonPath} (re-run init to register it)`); return; }
  const actorWired = !!entry.env && typeof entry.env === "object" && "DEVLOOP_ACTOR" in entry.env;
  // The canonical installed shape mcp-merge/init-service write is the PATH bin: command "dev-loop" (or
  // dev-loop-hub) + a serve/shim subcommand — no on-disk server path exists to verify, the bin resolves on
  // PATH at MCP start. Doctor used to WARN on exactly this shape and suggest "re-run init", which rewrites
  // the identical entry — a repair loop that could never converge.
  const cmd = typeof entry.command === "string" ? entry.command : "";
  const strArgs = (Array.isArray(entry.args) ? entry.args : []).filter((a): a is string => typeof a === "string");
  if (/(^|\/)dev-loop(-hub)?$/.test(cmd) && (strArgs.includes("serve") || strArgs.includes("shim"))) {
    if (!actorWired) { warn(`.mcp.json — the dev-loop-hub entry has no DEVLOOP_ACTOR env wiring in ${mcpJsonPath} (re-run init to repair)`); return; }
    pass(`.mcp.json registers dev-loop-hub → ${cmd} ${strArgs.join(" ")} (DEVLOOP_ACTOR wired)`);
    return;
  }
  const serverArg = strArgs.find((a) => /server\.(ts|js)$/.test(a));
  if (!serverArg) { warn(`.mcp.json — the dev-loop-hub entry is neither the \`dev-loop serve\`/\`shim\` bin form nor a server.ts/.js path in ${mcpJsonPath} (re-run init to repair)`); return; }
  if (!existsSync(serverArg)) { warn(`.mcp.json — the dev-loop-hub server path is missing on disk: ${serverArg} (the dev-loop checkout moved? re-run init)`); return; }
  if (!actorWired) { warn(`.mcp.json — the dev-loop-hub entry has no DEVLOOP_ACTOR env wiring in ${mcpJsonPath} (re-run init to repair)`); return; }
  pass(`.mcp.json registers dev-loop-hub → ${serverArg} (DEVLOOP_ACTOR wired)`);
}

async function reconcileDaemonHealth(key: string, dbPath: string, pass: (m: string) => void, warn: (m: string) => void): Promise<void> {
  const runDir = process.env.DEVLOOP_RUN_DIR ?? dirname(dbPath); // mirrors the lifecycle's lcRunDir (DL-41)
  const runfile = join(runDir, `daemon-${key}.json`);
  let url: string | undefined;
  try { url = (JSON.parse(readFileSync(runfile, "utf8")) as { url?: string }).url; } catch { /* no runfile ⇒ not running */ }
  if (!url) { warn(`daemon — not running (no lifecycle runfile ${runfile}); start it with \`DEVLOOP_PROJECT=${key} dev-loop daemon up\``); return; }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500); // short bound — doctor is a one-shot liveness probe, never a wait
    const r = await fetch(`${url}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(t));
    const b = r.status === 200 ? ((await r.json().catch(() => null)) as { ok?: boolean; project?: string; version?: string; actor?: string } | null) : null;
    if (b && b.ok === true && b.project === key) {
      pass(`daemon /api/health reachable → ${url} (project '${key}')`);
      if (b.version !== undefined && b.version !== pkgVersion())
        warn(`daemon — running old code v${b.version}, CLI is v${pkgVersion()}; run \`DEVLOOP_PROJECT=${key} dev-loop daemon up\` to restart`);
      if (b.actor !== undefined && b.actor !== "operator")
        warn(`daemon — actor='${b.actor}' (not operator; publish/attribution may be mis-gated)`);
    } else warn(`daemon — ${url}/api/health did not return {ok:true} for '${key}' (wedged/restarting? \`DEVLOOP_PROJECT=${key} dev-loop daemon up\`)`);
  } catch { warn(`daemon — ${url}/api/health unreachable (not running?); start it with \`DEVLOOP_PROJECT=${key} dev-loop daemon up\``); }
}

function reconcileSessionStartHook(pass: (m: string) => void): void {
  const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)
  const pluginRoot = process.env.DEVLOOP_PLUGIN_ROOT ?? join(here, "..", ".."); // the repo/plugin root holds hooks/
  const hookFile = join(pluginRoot, "hooks", "hooks.json");
  try {
    const j = JSON.parse(readFileSync(hookFile, "utf8")) as { hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> } };
    const cmds = (j.hooks?.SessionStart ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
    if (cmds.some((c) => /daemon\s+up/.test(c))) pass(`Claude SessionStart hook compatibility present → ${hookFile}`);
  } catch { /* Claude plugin hook is optional for standalone scheduler/Codex installs. */ }
}

function reconcileAutostart(pass: (m: string) => void, warn: (m: string) => void): void {
  if (platform() !== "darwin") {
    warn("daemon autostart — not installed by dev-loop on this OS; use systemd/cron/your process manager to run `dev-loop daemon up-all` at login");
    return;
  }
  const plist = join(homedir(), "Library", "LaunchAgents", "com.dyzsasd.dev-loop.daemon.plist");
  if (existsSync(plist)) pass(`daemon autostart installed → ${plist}`);
  else warn("daemon autostart — not installed; run `dev-loop daemon install-autostart` to start service projects at login");
}

// CLI: node src/doctor.ts  (or `dev-loop-hub doctor` via server.ts dispatch / `npm run doctor`)
if (isMainEntry(import.meta.url)) {
  process.exit((await runDoctor(resolveHubDbPath(), { reconcile: true })) ? 0 : 1); // workspace-aware ladder (P2 #1)
}
