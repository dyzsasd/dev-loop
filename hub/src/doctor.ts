// `dev-loop-hub doctor` — operator health check. READ-ONLY: it never auto-creates a db
// (a typo'd path reports MISSING, it does not spin an empty one). Backs the §17/§18 promises:
// data home is machine-local + never committed, the SoR is intact.
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "./db.ts";

export function runDoctor(dbPath: string): boolean {
  let ok = true;
  const pass = (m: string) => console.log("✅ " + m);
  const fail = (m: string) => { console.log("❌ " + m); ok = false; };
  const info = (m: string) => console.log("•  " + m);

  console.log(`dev-loop-hub doctor — ${dbPath}`);

  // 1. Exists (never create on doctor)
  if (!existsSync(dbPath)) {
    fail(`db MISSING — nothing to check (create it: node src/seed.ts <key> "<name>" <PREFIX>). NOT auto-creating.`);
    return false;
  }

  // 2. Writable / openable (opening an EXISTING file; schema create-if-not-exists is a no-op)
  let db;
  try { db = openDb(dbPath); pass("db opens read-write"); }
  catch (e) { fail(`db not openable: ${(e as Error).message}`); return false; }

  // 3. PRAGMAs
  const jm = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  jm === "wal" ? pass("journal_mode = WAL") : fail(`journal_mode = ${jm} (expected wal)`);
  const fk = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  info(`foreign_keys = ${fk} (set per-connection; informational)`);
  const qc = (db.prepare("PRAGMA quick_check").get() as Record<string, string>);
  Object.values(qc)[0] === "ok" ? pass("quick_check ok (no corruption)") : fail(`quick_check: ${JSON.stringify(qc)}`);

  // 4. Counts + per-project, and the unique-prefix integrity check (the real multi-project guard)
  const c = (sql: string) => (db!.prepare(sql).get() as { c: number }).c;
  info(`projects=${c("SELECT count(*) c FROM projects")} tickets=${c("SELECT count(*) c FROM tickets")} actors=${c("SELECT count(*) c FROM actors")} events=${c("SELECT count(*) c FROM events")}`);
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
  console.log(ok ? "\nDOCTOR_OK" : "\nDOCTOR_FAILED");
  return ok;
}

// CLI: node src/doctor.ts  (or `dev-loop-hub doctor` via server.ts dispatch / `npm run doctor`)
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.env.DEVLOOP_HUB_DB ?? `${process.env.HOME}/.dev-loop/hub.db`;
  process.exit(runDoctor(dbPath) ? 0 : 1);
}
