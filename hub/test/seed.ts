// DL-88 — `seed --help` / `seed -h` must print usage and exit 0 WITHOUT seeding. The footgun: argv's
// `--help` was bound to the positional `key` (no flag guard), creating a project literally keyed `--help`
// + its actors + labels. Drives the REAL `node src/seed.ts` against ISOLATED temp DBs (never ~/.dev-loop).
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";

const ROOT = "/tmp/hub-seed-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// run `node src/seed.ts <args>` with an isolated temp db (DEVLOOP_HUB_DB); returns {status, stdout, db}
function seed(dbName: string, args: string[]): { status: number | null; stdout: string; db: string } {
  const db = join(ROOT, dbName);
  const r = spawnSync("node", ["src/seed.ts", ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, DEVLOOP_HUB_DB: db },
  });
  return { status: r.status, stdout: r.stdout ?? "", db };
}
// projects written (0 if the db file was never even created — the guard exits before openDb)
function projectCount(db: string): number {
  if (!existsSync(db)) return 0;
  const d = openDb(db);
  const n = (d.prepare("SELECT count(*) AS c FROM projects").get() as { c: number }).c;
  d.close();
  return n;
}

// ── 1. `seed --help` → exit 0, usage printed, NOTHING written (no db ⇒ no project / actors / labels) ──
const help = seed("help.db", ["--help"]);
ok(help.status === 0, `seed --help → exit 0 (got ${help.status})`);
ok(/seed <key> <name> \[PREFIX\]/.test(help.stdout), "seed --help → prints the usage line");
ok(!existsSync(help.db), "seed --help → wrote nothing (no db created ⇒ no project row, no actors, no labels — the junk `--help` project bug is fixed)");

// ── 2. `seed -h` → same ──
const h = seed("h.db", ["-h"]);
ok(h.status === 0 && /seed <key> <name> \[PREFIX\]/.test(h.stdout) && !existsSync(h.db), "seed -h → usage + exit 0 + nothing written");

// ── 3. a real `seed <key> <name> <PREFIX>` STILL seeds exactly one project (not over-guarded) ──
const real = seed("real.db", ["myproj", "My Project", "MK"]);
ok(real.status === 0, `seed myproj → exit 0 (got ${real.status})`);
ok(projectCount(real.db) === 1, "a real seed still writes its project row");

// ── 4. a bare `seed` (demo defaults) is unchanged — still seeds ──
const bare = seed("bare.db", []);
ok(bare.status === 0 && projectCount(bare.db) === 1, "bare `seed` still seeds the demo defaults (unchanged)");

// ── 5. label backfill reaches EXISTING projects (a taxonomy addition must not strand old hubs) ──
{
  const { ensureSeed } = await import("../src/seed.ts");
  const db = openDb(join(ROOT, "backfill.db"));
  const pid = ensureSeed(db, "bf", "BF", "BF");
  const count = (name: string) => (db.prepare("SELECT COUNT(*) c FROM labels WHERE project_id=? AND name=?").get(pid, name) as { c: number }).c;
  ok(count("external-prereq") === 1 && count("external-code") === 1 && count("external-access") === 1, "the §9c external labels are seeded on create");
  db.prepare("DELETE FROM labels WHERE project_id=? AND name=?").run(pid, "external-prereq"); // simulate a pre-taxonomy project
  ensureSeed(db, "bf", "BF", "BF");                                                          // re-seed hits the EXISTING branch
  ok(count("external-prereq") === 1, "re-running seed BACKFILLS a missing label on an existing project (no early-return skip)");
  db.close();
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fails === 0 ? "\nSEED_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
