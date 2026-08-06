// LOOP-271 — the exclusion belongs to the SEAM, not to each call site.
//
// `deliveryProjects()` returned every configured project, so every new consumer was
// scratch/enabled-blind BY DEFAULT and had to remember to re-filter. Two sites remembered
// (rotation.ts, doctor.ts's NEXT ladder); the rest did not, so `metrics` rendered panels for a
// project that can never fire and `ensureHub` started a real daemon for one.
//
// The direction is the point: a caller that wants the full set asks for it. A default that is the
// unsafe answer is what a new consumer gets for free, and that is how this ticket happened.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryProjects, loadWorkspace } from "../src/team-config.ts";
import { stewardProjects } from "../src/rotation.ts";
import { projectIndexPage } from "../src/views/projects.ts";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-seam-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const wsRoot = join(tmp, "ws");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(join(wsRoot, "repo"), { recursive: true });
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "seam", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: {
      real: { repos: [{ ref: "repo", role: "primary" }] },
      // AC4's control: a legitimately NEW project — zero repos, not scratch — must be unaffected.
      // LOOP-220's AC4, re-asserted so this fix cannot over-reach into silencing real projects.
      fresh: {},
      scratchy: { scratch: true },
      offline: { enabled: false },
    },
  }));
  const ws = loadWorkspace(wsRoot);

  // ── AC1: the seam ────────────────────────────────────────────────────────────────────────────
  const got = deliveryProjects(ws).sort();
  ok(got.join(",") === "fresh,real", `LOOP-271 AC1: deliveryProjects returns only SCHEDULABLE projects (got ${got.join(",")})`);
  ok(!got.includes("scratchy"), "LOOP-271 AC1: scratch:true is excluded at the seam");
  ok(!got.includes("offline"), "LOOP-271 AC1: enabled:false is excluded too — the same pair config-schema.md defines as removing a project from scheduling");
  ok(got.includes("fresh"),
    "LOOP-271 AC4: a zero-repo NON-scratch project is untouched — this widens nothing into silencing real projects");

  // Opt-IN, never opt-out. A caller that genuinely needs the full set says so.
  const all = deliveryProjects(ws, { includeUnschedulable: true }).sort();
  ok(all.join(",") === "fresh,offline,real,scratchy", `LOOP-271 AC1: the full set is available on request (got ${all.join(",")})`);

  // The two hand-rolled re-filters are now redundant, and their behaviour is UNCHANGED.
  ok(stewardProjects(ws).join(",") === "fresh,real",
    `LOOP-271 AC1: stewardProjects is byte-identical after its own filter was removed (got ${stewardProjects(ws).join(",")})`);

  // ── AC3: the web surfaces ────────────────────────────────────────────────────────────────────
  {
    const dbPath = join(tmp, "hub.db");
    const db = openDb(dbPath);
    ensureSeed(db, "real", "Real Project", "REAL");
    ensureSeed(db, "scratchy", "Scratch Project", "SCR");
    // Mark it scratch the way the config does — through settings_json, which is what the SQL reads.
    db.prepare("UPDATE projects SET settings_json=? WHERE key=?").run(JSON.stringify({ scratch: true }), "scratchy");
    const page = projectIndexPage(db, Date.now());
    ok(/Real Project/.test(page), "LOOP-271 AC3: the project index still lists a real project");
    ok(!/Scratch Project/.test(page), "LOOP-271 AC3: …and omits the scratch one");

    // Hidden ≠ deleted. The row is still there, so /p/<scratch-key>/ resolves — the same rule §21a D6
    // applies to doc version history.
    const still = db.prepare("SELECT key FROM projects WHERE key=?").get("scratchy") as { key?: string } | undefined;
    ok(still?.key === "scratchy", "LOOP-271 AC3: the scratch project is HIDDEN from the index, not deleted — direct navigation still resolves");

    // The predicate must survive a row whose settings_json is not JSON at all: json_extract alone
    // throws on it, which would take the whole index page down rather than hide one project.
    db.prepare("UPDATE projects SET settings_json=? WHERE key=?").run("not json at all", "real");
    let threw = "";
    try { projectIndexPage(db, Date.now()); } catch (e) { threw = (e as Error).message; }
    ok(threw === "", `LOOP-271 AC3: a row with non-JSON settings_json does not take the page down (${threw})`);
    db.close();
  }

  // ── the shape the SQL and the config predicate must agree on ─────────────────────────────────
  // Two definitions of "is this scratch?" is how the seam drifted in the first place. Assert the SQL
  // answers the same as the config for both spellings.
  {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE projects(key TEXT, settings_json TEXT)");
    const ins = db.prepare("INSERT INTO projects(key,settings_json) VALUES(?,?)");
    ins.run("a", JSON.stringify({ scratch: true }));
    ins.run("b", JSON.stringify({ scratch: false }));
    ins.run("c", "{}");
    ins.run("d", "not json");
    const rows = db.prepare("SELECT key FROM projects WHERE CASE WHEN json_valid(settings_json) THEN json_extract(settings_json,'$.scratch') ELSE NULL END IS NOT 1 ORDER BY key")
      .all() as { key: string }[];
    ok(rows.map((r) => r.key).join(",") === "b,c,d",
      `LOOP-271: the SQL predicate excludes only scratch:true — false, absent and unparseable all stay visible (got ${rows.map((r) => r.key).join(",")})`);
    db.close();
  }

  // ── LOOP-349: one definition of the SQL predicate, not three ─────────────────────────────
  {
    const here = import.meta.dirname;
    const src = join(here, "..", "src");
    const files = ["daemon.ts", "doctor.ts", "views/projects.ts"];
    const inline = /json_valid.*settings_json.*json_extract.*scratch/;
    for (const f of files) {
      const content = readFileSync(join(src, f), "utf8");
      ok(!inline.test(content), `LOOP-349: ${f} has no inline scratch SQL predicate left`);
      ok(content.includes("NOT_SCRATCH_SQL"), `LOOP-349: ${f} imports the shared NOT_SCRATCH_SQL`);
    }
    const shared = readFileSync(join(src, "sql-predicates.ts"), "utf8");
    ok(shared.includes("NOT_SCRATCH_SQL"), "LOOP-349: sql-predicates.ts exports NOT_SCRATCH_SQL");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nSCHEDULABLE_SEAM_OK");
process.exit(fails ? 1 : 0);
