// `dev-loop-hub doctor` — operator health check. READ-ONLY: it never auto-creates a db
// (a typo'd path reports MISSING, it does not spin an empty one). Backs the §17/§18 promises:
// data home is machine-local + never committed, the SoR is intact.
// DL-81: the `doctor` COMMAND additionally runs a service runtime-wiring reconcile (reads the product
// .mcp.json / daemon runfile / autostart/hook presence + a localhost /api/health GET) — still READ-ONLY (no writes,
// no auto-create) and NON-FATAL; see serviceReconcile. Library callers (init-service) skip it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { loadProjectsConfig, resolveProjectFromCwd } from "./resolve-project.ts";
import { hubDbPath } from "./paths.ts";
import { tryResolveWorkspace, wsHubDb } from "./workspace.ts";
import { validateTeamFile, effectiveRepo, effectiveProject, deliveryProjects, isTeamProject, agentInterfaceFor, TEAM_INTAKE_PROJECT, WsValidationError, type Workspace, type WsError, type HubBlock } from "./team-config.ts";
import { checkLessonsBudget } from "./lessons.ts";
import { loadWorkspaceSecrets, secretsInjectedKeys, wsSecretsPath } from "./secrets.ts";
import { opencodeSyncDrift } from "./opencode-sync.ts";
import * as metricsMod from "./metrics.ts";
const require_metrics = () => metricsMod;

// DL-81: the `doctor` COMMAND (server.ts / `node src/doctor.ts`) passes { reconcile: true } to ALSO report
// the service runtime wiring (below). Library callers that only want the DB-integrity verdict (init-service
// step (d)) call runDoctor(dbPath) with no opts → no reconcile, behavior byte-for-byte unchanged.
export async function runDoctor(dbPath: string, opts: { reconcile?: boolean } = {}): Promise<boolean> {
  let ok = true;
  const pass = (m: string) => console.log("✅ " + m);
  const fail = (m: string) => { console.log("❌ " + m); ok = false; };
  const warn = (m: string) => console.log("⚠️  " + m);
  const info = (m: string) => console.log("•  " + m);

  // Schema v2: when a workspace is discoverable, run its (READ-ONLY) checks first and point the DB checks
  // below at the workspace hub.db. Library callers (init-service) pass an explicit dbPath and skip this.
  let ws: Workspace | null = null;
  const unseeded: string[] = []; // W08 hits, collected for the NEXT line
  if (opts.reconcile) {
    try { ws = tryResolveWorkspace(); }
    catch (e) {
      console.log(`❌ dev-loop.json invalid: ${(e as Error).message}`);
      console.log("\nDOCTOR_FAILED");
      if (e instanceof WsValidationError && e.errors.length) console.log(`NEXT: ${nextStep(null, e.errors, [])}`);
      return false;
    }
    if (ws) {
      ok = doctorWorkspace(ws) && ok;
      if (ws.file.team.backend === "linear") {
        // A linear team has no hub.db; the workspace checks ARE the whole verdict.
        console.log(ok ? "\nDOCTOR_OK" : "\nDOCTOR_FAILED");
        console.log(`NEXT: ${nextStep(ws, [], [])}`);
        return ok;
      }
      dbPath = wsHubDb(ws); // service: check the workspace's own hub.db below
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
  info(`projects=${c("SELECT count(*) c FROM projects")} tickets=${c("SELECT count(*) c FROM tickets")} docs=${c("SELECT count(*) c FROM documents")} actors=${c("SELECT count(*) c FROM actors")} events=${c("SELECT count(*) c FROM events")}`);
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
  if (ws) console.log(`NEXT: ${nextStep(ws, [], unseeded)}`);
  return ok;
}

// ── the NEXT line — the single most-blocking next step, in fix order ──────────────────────────────
// Doctor's checks say what is WRONG; this says what to DO first. One line, one command, priority-ordered:
// an invalid config blocks everything → a blank linearTeam blocks every fire → no projects/repos blocks
// scheduling → an unseeded service project silently starves its fires → dry-run is the last gate before
// live. All green ⇒ run the team.
function nextStep(ws: Workspace | null, errors: WsError[], unseeded: string[]): string {
  if (errors.length) { const e = errors[0]; return `fix dev-loop.json — [${e.code}] ${e.path ? e.path + ": " : ""}${e.message}`; }
  if (!ws) return "dev-loop run";
  const t = ws.file.team;
  if (t.backend === "linear" && !(t.linearTeam ?? "").trim()) return `dev-loop team set team.linearTeam "<Team Name>"  (fires refuse to launch on a blank Linear team)`;
  if (!deliveryProjects(ws).length) return `dev-loop team add-project <key>  (or /dev-loop:add-project in a coding CLI)`;
  if (unseeded.length) return `dev-loop seed ${unseeded[0]} "<Project Name>" <UNIQUE_PREFIX>  (config project with no hub.db row, W08)`;
  if (!Object.keys(ws.file.repos).length) return `dev-loop team add-repo <ref> --project <key> --path <rel> --detect  (or /dev-loop:add-repo)`;
  if (t.comms?.webhookEnv && process.env[t.comms.webhookEnv] === undefined) return `put ${t.comms.webhookEnv}=<webhook-url> in ${wsSecretsPath(ws.root)} (or export it) — the whole reminder layer is silently dead without it (W12)`;
  if (t.mode === "dry-run") return `dev-loop team set team.mode live  (everything is wired; flip when ready to go live)`;
  return "dev-loop run";
}

// ── Schema-v2 workspace checks (READ-ONLY; R2 — mutating fixups live in `dev-loop team repair`) ──────────
// Reports the E-code/W-code verdict for a dev-loop.json, that every registered repo exists and is a git
// repo, and the two migration/leak warnings (W05 user-scope MCP for linear steward fires; W06 workspace
// inside a git work-tree). Never writes, never repairs.
export function doctorWorkspace(ws: Workspace): boolean {
  let ok = true;
  const pass = (m: string) => console.log("✅ " + m);
  const fail = (m: string) => { console.log("❌ " + m); ok = false; };
  const warn = (m: string) => console.log("⚠️  " + m);
  const info = (m: string) => console.log("•  " + m);

  console.log(`\ndev-loop workspace — '${ws.file.team.key}' @ ${ws.root} (backend:${ws.file.team.backend})`);

  const { errors, warnings } = validateTeamFile(ws.file);
  if (errors.length) for (const e of errors) fail(`[${e.code}] ${e.path}: ${e.message}`);
  else pass(`dev-loop.json valid (${Object.keys(ws.file.repos).length} repos, ${Object.keys(ws.file.projects).length} projects)`);
  for (const w of [...warnings, ...checkLessonsBudget(ws)]) warn(`[${w.code}] ${w.path}: ${w.message}`);

  // Every registered repo exists on disk + is a git repo (path existence + realpath sanity).
  for (const ref of Object.keys(ws.file.repos)) {
    const r = effectiveRepo(ws, ref);
    const dir = r.absPath;
    if (!existsSync(dir)) fail(`repo '${ref}' path missing on disk: ${dir} (clone it, or /dev-loop:sync-repo)`);
    else if (!isGitWorkTree(dir)) warn(`repo '${ref}' at ${dir} is not a git repo yet`);
    else pass(`repo '${ref}' → ${dir}`);
    // The add-repo --detect contract: interview-only fields stay unset, doctor makes the gap visible.
    if (!r.deploy && !r.ops) info(`repo '${ref}' has no deploy/ops config (interview-only fields) — fill via /dev-loop:add-repo, or team set repos.${ref}.deploy.* once it deploys`);
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
    if (fm.fires > 0) info(`fires (7d): ${fm.fires} — success ${fm.successRate === null ? "—" : Math.round(fm.successRate * 100) + "%"}, ${fm.failures} failed, ${fm.timeouts} timeout, ${fm.suspectErrors} suspect`);
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
      warn(`[W13] provider '${id}' auth env ${p.authTokenEnv} unresolvable — its opencode fires fail pre-spawn (fireError: provider-env-missing); put ${p.authTokenEnv}=<key> in ${wsSecretsPath(ws.root)} or export it`);
    }
  }
  // W14 — workspace opencode.json carries the registry (sync drift). Read-only; the fix is operator-run.
  if (Object.keys(provs).length) {
    const drift = opencodeSyncDrift(ws.root, provs);
    if (drift === null) pass(`opencode.json carries the ${Object.keys(provs).length} registry provider(s)`);
    else warn(`[W14] ${drift} — run: dev-loop team sync-opencode`);
  }

  // W06 — the workspace root inside a git work-tree risks committing .dev-loop state/reports (I5 neighbor).
  if (isGitWorkTree(ws.root)) {
    let ignored = false;
    try { execFileSync("git", ["-C", ws.root, "check-ignore", "-q", ".dev-loop"], { stdio: "ignore" }); ignored = true; } catch { /* not ignored */ }
    if (!ignored) warn(`[W06] the workspace root is inside a git work-tree and .dev-loop/ is not gitignored — state/reports could be committed (add .dev-loop/ to .gitignore)`);
    else info("workspace root is inside a git repo but .dev-loop/ is gitignored");
  }

  return ok;
}

function isGitWorkTree(dir: string): boolean {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() === "true"; }
  catch { return false; }
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
  if (!url) { warn(`daemon — not running (no lifecycle runfile ${runfile}); start it with \`dev-loop daemon up\` from the repo`); return; }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500); // short bound — doctor is a one-shot liveness probe, never a wait
    const r = await fetch(`${url}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(t));
    const b = r.status === 200 ? ((await r.json().catch(() => null)) as { ok?: boolean; project?: string } | null) : null;
    if (b && b.ok === true && b.project === key) pass(`daemon /api/health reachable → ${url} (project '${key}')`);
    else warn(`daemon — ${url}/api/health did not return {ok:true} for '${key}' (wedged/restarting? \`dev-loop daemon up\`)`);
  } catch { warn(`daemon — ${url}/api/health unreachable (not running?); start it with \`dev-loop daemon up\``); }
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
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit((await runDoctor(hubDbPath(), { reconcile: true })) ? 0 : 1);
}
