// DL-88 — `seed --help` / `seed -h` must print usage and exit 0 WITHOUT seeding. The footgun: argv's
// `--help` was bound to the positional `key` (no flag guard), creating a project literally keyed `--help`
// + its actors + labels. Drives the REAL `node src/seed.ts` against ISOLATED temp DBs (never ~/.dev-loop).
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, existsSync, mkdtempSync, cpSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
    env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: db },
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
  // Decision 1: the four remaining bail-shape labels seed on create (kind=workflow, like external-prereq)
  ok(count("decision-needed") === 1 && count("info-needed") === 1 && count("scope-design") === 1 && count("fix-exhausted") === 1,
    "Decision 1: the bail-shape labels (decision-needed/info-needed/scope-design/fix-exhausted) are seeded on create");
  const kindOf = (name: string) => (db.prepare("SELECT kind FROM labels WHERE project_id=? AND name=?").get(pid, name) as { kind: string } | undefined)?.kind;
  ok(["decision-needed", "info-needed", "scope-design", "fix-exhausted"].every((n) => kindOf(n) === "workflow"),
    "Decision 1: each bail-shape label is kind=workflow");
  db.prepare("DELETE FROM labels WHERE project_id=? AND name=?").run(pid, "external-prereq"); // simulate a pre-taxonomy project
  db.prepare("DELETE FROM labels WHERE project_id=? AND name=?").run(pid, "decision-needed");  // simulate a pre-Decision-1 project
  ensureSeed(db, "bf", "BF", "BF");                                                          // re-seed hits the EXISTING branch
  ok(count("external-prereq") === 1, "re-running seed BACKFILLS a missing label on an existing project (no early-return skip)");
  ok(count("decision-needed") === 1, "Decision 1: re-running seed BACKFILLS a bail-shape label onto an existing (pre-Decision-1) project");
  db.close();
}

// ── 6. LOOP-63: `node src/seed.ts` must SEED from a checkout path containing a SPACE ──
// seed.ts:94 guarded main() with `import.meta.url === \`file://${process.argv[1]}\``. import.meta.url is a
// percent-ENCODED file URL while process.argv[1] is a RAW path, so on a spaced checkout the two diverged
// and the guard silently no-op'd: `node src/seed.ts` seeded NOTHING (0 B stdout, no db) and its 23 test
// spawn sites failed downstream far from the cause. Copy src into a dir whose name holds spaces (realpath'd,
// so the space is the ONLY variable — not a /tmp symlink) and assert a real seed still writes + prints.
// FAILS against the guarded form (0 B stdout, 0 projects); PASSES with the realpath isMainEntry() form.
{
  const spaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "dl seed 63 ")));         // last segment holds spaces
  cpSync("src", join(spaceRoot, "src"), { recursive: true });                        // cwd is hub/ (as for `src/seed.ts` above)
  writeFileSync(join(spaceRoot, "package.json"), JSON.stringify({ type: "module" })); // ESM for the copied .ts
  const db = join(ROOT, "spaced.db");
  const r = spawnSync("node", [join(spaceRoot, "src", "seed.ts"), "sp", "Spaced Project", "SP"], {
    encoding: "utf8", timeout: 30000, env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: db },
  });
  const out = r.stdout ?? "";
  ok(out.length > 0 && projectCount(db) === 1,
    `LOOP-63: seed.ts seeds from a spaced checkout path (${out.length}B stdout, ${projectCount(db)} project, exit ${r.status})`);
  rmSync(spaceRoot, { recursive: true, force: true });
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fails === 0 ? "\nSEED_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
