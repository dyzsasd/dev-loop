// DL-60 — `dev-loop-hub init-service <key> "<name>" <PREFIX> [--dry-run]`: the idempotent CODE that
// init's "Step 0.5 — choose your ticket system" flow INVOKES for a backend:"service" project. (The SKILL
// prose that calls it is DL-53, operator-applied — agents never self-edit a SKILL, §17.) It PERFORMS
// (not prints) the turnkey service-backend bootstrap by ORCHESTRATING the existing pieces — no
// re-implementation of any of them:
//   (a) `npm install` in the hub if node_modules is absent
//   (b) seed the project row + the agent/operator actors + the §4 labels (ensureSeed — idempotent on
//       key; a duplicate PREFIX hard-throws, surfaced as a clear "pick a unique prefix" error, never
//       swallowed — seed.ts:42-47)
//   (c) merge (never clobber) the dev-loop-hub server into the PRODUCT repo's .mcp.json, env-name-only
//       (DL-61's mergeMcpServer; skipped cleanly when the project config carries no repoPath)
//   (d) `runDoctor(dbPath)` → assert DOCTOR_OK (doctor.ts — read-only, never auto-creates a db)
//   (e) one-shot `daemon up` (the shipped DL-41 lifecycle) → confirm `/api/health {ok:true}` → report
//       the board URL
// then report lifecycle options. The standalone dev-loop lifecycle is `dev-loop daemon up` plus the
// optional OS login item (`dev-loop daemon install-autostart`). The Claude SessionStart hook is kept as
// a compatibility convenience for plugin sessions, not the canonical lifecycle owner.
//
// Idempotent: a re-run is a clean no-op (seed idempotent-on-key, daemon already-up detected). Honors
// config: a NON-"service" backend → exit-0 no-op (back-compat — the DL-41/42 safety contract); a
// `mode:"dry-run"` project (or `--dry-run`) prints every step and performs NONE. §16: localhost-only;
// identity by env-var NAME; no secrets. §17: this is CODE only — it never edits skills/init/SKILL.md
// (DL-53) and can never name/write a SKILL/conventions/code file.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb } from "./db.ts";
import { ensureSeed } from "./seed.ts";
import { runDoctor } from "./doctor.ts";
import { loadProjectsConfig } from "./resolve-project.ts";
import { mergeMcpServer } from "./mcp-merge.ts";
import { hubDbPath } from "./paths.ts";

export interface InitServiceOpts {
  key: string;
  name: string;
  prefix: string;
  dbPath: string;          // the hub SoR (REQUIRED — tests pass an isolated path so they never touch the live ~/.dev-loop)
  dryRun?: boolean;        // a `--dry-run` override (OR config mode:"dry-run")
  hubDir?: string;         // default <hub/src>/.. — for the node_modules check + `npm install` cwd
  pluginRoot?: string;     // default DEVLOOP_PLUGIN_ROOT ?? <hub/src>/../.. — optional Claude hook compatibility check
  serverEntry?: string;    // default <hub/src>/server.ts — the `daemon up` is spawned via it
}

const log = (m: string) => console.log(m);

// Resolve the project's backend + mode from projects.json (honors DEVLOOP_PROJECTS_JSON, which tests set,
// via the shared §11 locator in resolve-project.ts). §18: a missing `backend` ⇒ "linear". A key ABSENT
// from config ⇒ the explicit `init-service` invocation is taken as service intent (init invokes this only
// when setting up a service project); a key PRESENT with a non-"service" backend is honored as a no-op.
function resolveProjectCfg(key: string): { backend: string; mode: string; repoPath?: string } {
  const cfg = loadProjectsConfig();
  const proj = cfg?.projects?.[key] as { backend?: string; mode?: string; repoPath?: string } | undefined;
  if (!proj) return { backend: "service", mode: "live" };
  return { backend: proj.backend ?? "linear", mode: proj.mode ?? "live", repoPath: proj.repoPath };
}

// Claude plugin compatibility: if the plugin hook is present, report it. Missing hooks are fine for
// scheduler/Codex/standalone installs; `dev-loop daemon install-autostart` is the durable machine-level
// lifecycle path.
function sessionStartHookPresent(pluginRoot: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const cmds = (j.hooks?.SessionStart ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
    return cmds.some((c) => /daemon\s+up/.test(c));
  } catch { return false; }
}

export async function runInitService(opts: InitServiceOpts): Promise<number> {
  const { key, name, prefix, dbPath } = opts;
  const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)
  // Resolve the server entry by THIS file's own extension — .ts in-repo (zero-build dev), .js when run
  // from the compiled npm package (node won't type-strip under node_modules; the published build is dist/*.js).
  const selfExt = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
  const hubDir = opts.hubDir ?? join(here, "..");
  const pluginRoot = opts.pluginRoot ?? process.env.DEVLOOP_PLUGIN_ROOT ?? join(here, "..", "..");
  const serverEntry = opts.serverEntry ?? join(here, `server${selfExt}`);

  const { backend, mode, repoPath } = resolveProjectCfg(key);
  const dryRun = !!opts.dryRun || mode === "dry-run";
  log(`dev-loop-hub init-service — project '${key}' (prefix ${prefix}), backend '${backend}'${dryRun ? " [dry-run]" : ""}`);

  // ── Back-compat: a non-"service" backend is a clean no-op (the DL-41/42 safety contract). ──
  if (backend !== "service") {
    log(`•  backend is '${backend}', not 'service' — nothing to bootstrap (no-op).`);
    return 0;
  }

  // ── (a) `npm install` if the hub deps are absent ──
  if (existsSync(join(hubDir, "node_modules"))) {
    log("✅ hub dependencies present (node_modules) — skipping install");
  } else if (dryRun) {
    log(`[dry-run] would: npm install (in ${hubDir})`);
  } else {
    log(`•  installing hub dependencies (npm install in ${hubDir}) …`);
    const r = spawnSync("npm", ["install"], { cwd: hubDir, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) { log(`❌ npm install failed (exit ${r.status}) — install the hub deps and re-run`); return 1; }
    log("✅ hub dependencies installed");
  }

  // ── (b) seed the project row + actors + labels (idempotent on key; a prefix clash → a clear error) ──
  if (dryRun) {
    log(`[dry-run] would: seed project '${key}' ("${name}", prefix ${prefix}) + actors + labels in ${dbPath}`);
  } else {
    try {
      const db = openDb(dbPath);
      try { ensureSeed(db, key, name, prefix); } finally { db.close(); }
      log(`✅ project '${key}' seeded (idempotent on key) + actors + labels in ${dbPath}`);
    } catch (e) {
      // ensureProject hard-throws on a duplicate prefix — its message already says "pick a unique prefix".
      log(`❌ seed failed: ${(e as Error).message}`);
      return 1;
    }
  }

  // ── (c) [DL-61] merge the dev-loop-hub server into the PRODUCT repo's .mcp.json, env-name-only (never
  //        clobbering other servers). Needs the product repoPath (from config); absent ⇒ skip cleanly.
  //        A malformed product .mcp.json is reported (left untouched) but does NOT abort the bootstrap. ──
  if (!repoPath) {
    log("•  no repoPath in config — skipping .mcp.json registration (register dev-loop-hub by hand from config/mcp.example.json)");
  } else if (dryRun) {
    log(`[dry-run] would: merge the dev-loop-hub MCP server into ${join(repoPath, ".mcp.json")} (env-name-only, preserving any other servers)`);
  } else {
    const m = mergeMcpServer({ mcpJsonPath: join(repoPath, ".mcp.json"), hubServerPath: serverEntry, projectKey: key });
    if (m.ok) log(`✅ .mcp.json ${m.action}: dev-loop-hub registered in ${join(repoPath, ".mcp.json")} (servers: ${m.servers.join(", ")})`);
    else log(`⚠️  .mcp.json registration skipped: ${m.error}\n   register dev-loop-hub by hand from config/mcp.example.json, then re-run.`);
  }

  // ── (d) doctor → assert DOCTOR_OK ──
  if (dryRun) {
    log(`[dry-run] would: run doctor on ${dbPath} and assert DOCTOR_OK`);
  } else if (!(await runDoctor(dbPath))) {
    log("❌ doctor did not report DOCTOR_OK — the SoR is not healthy; not starting the daemon");
    return 1;
  } else {
    log("✅ doctor: DOCTOR_OK");
  }

  // ── (e) one-shot `daemon up` (DL-41) → confirm `/api/health {ok:true}` → report the board URL ──
  let boardUrl: string | null = null;
  if (dryRun) {
    log(`[dry-run] would: start the daemon once (${serverEntry} daemon up) and confirm /api/health {ok:true}, then report the board URL`);
  } else {
    const r = spawnSync(process.execPath, [serverEntry, "daemon", "up"], {
      encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_DB: dbPath, DEVLOOP_PROJECT: key, DEVLOOP_ACTOR: "operator" },
    });
    if (r.status !== 0) { log(`❌ daemon up failed (exit ${r.status})${r.stderr ? "\n   " + r.stderr.trim() : ""}`); return 1; }
    const out = (r.stdout ?? "").trim();
    if (out) log(out.split("\n").map((l) => "   " + l).join("\n"));
    // Confirm health + learn the URL from the runfile the lifecycle just wrote (runDir mirrors lcRunDir).
    const runDir = process.env.DEVLOOP_RUN_DIR ?? dirname(dbPath);
    try {
      const run = JSON.parse(readFileSync(join(runDir, `daemon-${key}.json`), "utf8")) as { url: string };
      const h = (await fetch(`${run.url}/api/health`).then((x) => x.json()).catch(() => null)) as { ok?: boolean } | null;
      if (!h || h.ok !== true) { log(`❌ daemon started but /api/health is not ok at ${run.url}`); return 1; }
      boardUrl = run.url;
      log("✅ daemon healthy → /api/health {ok:true}");
    } catch (e) {
      log(`❌ could not confirm daemon health: ${(e as Error).message}`);
      return 1;
    }
  }

  // ── lifecycle report: standalone autostart first; Claude hook only as compatibility ──
  log("ℹ️  For login-time daemon startup, run `dev-loop daemon install-autostart` once (macOS LaunchAgent; use your OS process manager elsewhere).");
  if (sessionStartHookPresent(pluginRoot)) {
    log("✅ Claude SessionStart hook present — plugin sessions can also nudge `dev-loop daemon up`");
  } else {
    log("ℹ️  Claude SessionStart hook not found — fine for scheduler/Codex/standalone installs.");
  }

  // ── report ──
  if (dryRun) log("\n[dry-run] init-service preview complete — no changes made.");
  else log(`\n✅ service backend ready for '${key}'.${boardUrl ? `  Board: ${boardUrl}` : ""}`);
  return 0;
}

// CLI: `node src/init-service.ts <key> "<name>" <PREFIX> [--dry-run]` (also `npm run init-service -- …`).
// A standalone entry, deliberately NOT wired into the `dev-loop-hub` (server.ts) subcommand surface — the
// ticket fences server.ts off, and the init SKILL (DL-53) invokes the mechanics generically, so this needs
// no server.ts dispatch. Importing this module is side-effect-free — the guard keys on argv[1].
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rest = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const [key, name, prefix] = rest.filter((a) => a !== "--dry-run");
  if (!key || !name || !prefix) {
    console.error(`[hub] usage: dev-loop-hub init-service <key> "<name>" <PREFIX> [--dry-run]`);
    process.exit(2);
  }
  const code = await runInitService({
    key, name, prefix, dryRun,
    dbPath: hubDbPath(),
  });
  process.exit(code);
}
