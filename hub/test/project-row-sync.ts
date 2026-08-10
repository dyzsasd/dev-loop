// LOOP-409 regression — the resolved config `mode`/`autonomy` reach the hub `projects` row.
//
// Before the fix, NOTHING wrote those two columns: every row on every workspace ever created carried
// the SQL defaults (`live`/`ask`), and `dev-loop project --json` — the op every `interface:"cli"`
// fire runs first, and quotes in its opening line — reported them as fact. A workspace configured
// `dry-run` would announce `mode: live` and then write to the board.
//
// The direction of every assertion here is deliberate and is AC3: it asserts `dry-run` / `full`.
// An assertion pinning `live`/`ask` passes against the unfixed defaults and proves nothing.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { resolveWorkspace } from "../src/workspace.ts";
import { syncProjectRows } from "../src/project-row-sync.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.env.DEVLOOP_NODE || process.execPath;
const ROOT = `/tmp/dl-project-row-sync-${process.pid}`;
const WS_KEY = "prs";
const PROJ = "prsproj";
const GHOST = "prsghost"; // a hub row with NO dev-loop.json entry (AC5)
const WS_DB = join(ROOT, ".dev-loop", "hub.db");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const clean = { env: { ...scrubFireEnv() } as NodeJS.ProcessEnv };
const cli = (...args: string[]) =>
  spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 30_000, ...clean });
// `dev-loop project --json` for one key — the CLI whoami, read exactly as a fire reads it.
const whoami = (key: string): { mode?: string; autonomy?: string } => {
  const r = spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "project", "--json"],
    { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...scrubFireEnv(), DEVLOOP_PROJECT: key } as NodeJS.ProcessEnv });
  try { return JSON.parse(r.stdout) as { mode?: string; autonomy?: string }; } catch { return {}; }
};
// Read the two columns straight off the row, so an assertion cannot be satisfied by a resolver.
const row = (key: string): { mode: string; autonomy: string } | undefined => {
  const db = openDb(WS_DB);
  try { return db.prepare("SELECT mode, autonomy FROM projects WHERE key=?").get(key) as { mode: string; autonomy: string } | undefined; }
  finally { db.close(); }
};
const fullRow = (key: string): string => {
  const db = openDb(WS_DB);
  try { return JSON.stringify(db.prepare("SELECT * FROM projects WHERE key=?").get(key)); } finally { db.close(); }
};

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

try {
  const init = spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "team", "init",
    "--dir", ROOT, "--key", WS_KEY, "--backend", "service", "--yes"],
    { cwd: "/tmp", encoding: "utf8", timeout: 30_000, ...clean });
  ok(init.status === 0, `setup: team init exits 0 (got ${init.status}: ${(init.stderr ?? "").split("\n")[0]})`);
  ok(existsSync(WS_DB), "setup: workspace hub.db created");

  // ── AC1 — a project SEEDED from a config already carrying dry-run/full gets those values ──
  ok(cli("team", "set", "team.mode", "dry-run").status === 0, "setup: team set team.mode dry-run exits 0");
  ok(cli("team", "set", "team.autonomy", "full").status === 0, "setup: team set team.autonomy full exits 0");
  const add = cli("team", "add-project", PROJ, "--prefix", "PRS");
  ok(add.status === 0, `setup: add-project exits 0 (got ${add.status}: ${(add.stderr ?? "").split("\n")[0]})`);

  const seeded = whoami(PROJ);
  ok(seeded.mode === "dry-run", `AC1: get_project reports mode 'dry-run' for a freshly seeded project (got ${JSON.stringify(seeded.mode)})`);
  ok(seeded.autonomy === "full", `AC1: get_project reports autonomy 'full' for a freshly seeded project (got ${JSON.stringify(seeded.autonomy)})`);

  // ── AC4 — `_team` takes the TEAM-level resolved values (it has no config entry by construction) ──
  const team = row("_team");
  ok(team?.mode === "dry-run" && team?.autonomy === "full",
    `AC4: the _team row carries the team-level resolved values (got ${JSON.stringify(team)})`);

  // ── AC2 — a later `team set` is observable with NO re-seed ──
  // Go through live/ask first so the final dry-run/full assertion cannot be satisfied by a row that
  // was simply never written: the row must actually MOVE, twice, in both directions.
  ok(cli("team", "set", "team.mode", "live").status === 0, "setup: team set team.mode live exits 0");
  ok(cli("team", "set", "team.autonomy", "ask").status === 0, "setup: team set team.autonomy ask exits 0");
  ok(row(PROJ)?.mode === "live" && row(PROJ)?.autonomy === "ask",
    `AC2: the row follows config back to live/ask (got ${JSON.stringify(row(PROJ))})`);

  ok(cli("team", "set", "team.mode", "dry-run").status === 0, "AC2: team set team.mode dry-run exits 0");
  const afterSet = whoami(PROJ);
  ok(afterSet.mode === "dry-run", `AC2/AC3: 'team set team.mode dry-run' is observable in project --json without a re-seed (got ${JSON.stringify(afterSet.mode)})`);

  // The legacy alias must resolve to the fail-closed value: `guarded` → `ask`, never `full` (D2).
  ok(cli("team", "set", "team.autonomy", "guarded").status === 0, "setup: team set team.autonomy guarded exits 0");
  ok(row(PROJ)?.autonomy === "ask", `AC2: the legacy 'guarded' projects as 'ask' — the fail-closed direction (got ${JSON.stringify(row(PROJ)?.autonomy)})`);

  // A per-project override beats the team value through the one resolver.
  ok(cli("team", "set", `projects.${PROJ}.autonomy`, "full").status === 0, "setup: per-project autonomy full exits 0");
  ok(row(PROJ)?.autonomy === "full" && row("_team")?.autonomy === "ask",
    `AC2: a project override projects onto that project only, not onto _team (got ${JSON.stringify(row(PROJ)?.autonomy)} / ${JSON.stringify(row("_team")?.autonomy)})`);

  // ── AC5 — a hub row with no config entry is never touched ──
  {
    const db = openDb(WS_DB);
    try {
      db.prepare("INSERT INTO projects (id,key,name,ticket_prefix,ticket_seq,mode,autonomy,settings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run("ghost-id", GHOST, "Ghost", "GHO", 7, "live", "ask", '{"hand":"seeded"}', "2026-01-01T00:00:00.000Z");
    } finally { db.close(); }
  }
  const ghostBefore = fullRow(GHOST);
  ok(cli("team", "set", "team.mode", "dry-run").status === 0, "setup: a set that runs the projection over every described row");
  ok(fullRow(GHOST) === ghostBefore, "AC5: an undescribed hub row is byte-identical after a projection run");

  // ── AC6 — idempotence, asserted on the reconciler's own return value ──
  process.env.DEVLOOP_WORKSPACE = ROOT;
  process.env.DEVLOOP_HUB_DB = WS_DB;
  const ws = resolveWorkspace();
  {
    const db = openDb(WS_DB);
    try {
      const first = syncProjectRows(db, ws);   // rows already converged by the CLI runs above
      ok(first.length === 0, `AC6: a call on converged rows reports no changes (got ${JSON.stringify(first)})`);
      db.prepare("UPDATE projects SET mode='live', autonomy='ask' WHERE key=?").run(PROJ);
      const second = syncProjectRows(db, ws);
      ok(second.length === 1 && second[0].key === PROJ && second[0].to.mode === "dry-run" && second[0].to.autonomy === "full",
        `AC6: a diverged row is reported once, with from → to (got ${JSON.stringify(second)})`);
      ok(syncProjectRows(db, ws).length === 0, "AC6: the immediately following call reports no changes (idempotent)");
      ok(!syncProjectRows(db, ws).some((c) => c.key === GHOST), "AC6: the undescribed row is never in the change set");
    } finally { db.close(); }
  }

  // ── AC7 — the heal path: `hub start` converges rows that predate the projection ──
  // Assert the ROW, not the daemon's exit code: the projection runs before any daemon work, so this
  // stays a test of the seam even where a sandbox refuses to fork a daemon.
  {
    const db = openDb(WS_DB);
    try { db.prepare("UPDATE projects SET mode='live', autonomy='ask' WHERE key IN (?,?)").run(PROJ, "_team"); } finally { db.close(); }
  }
  ok(row(PROJ)?.mode === "live", "setup: rows made stale before the heal");
  const start = cli("hub", "start");
  ok(row(PROJ)?.mode === "dry-run" && row(PROJ)?.autonomy === "full",
    `AC7: 'hub start' converges a stale project row (got ${JSON.stringify(row(PROJ))})`);
  ok(row("_team")?.mode === "dry-run", `AC7: 'hub start' converges the stale _team row (got ${JSON.stringify(row("_team"))})`);
  ok(/projected '/.test(start.stdout ?? ""), "AC7: the heal reports what it converged");
  const again = cli("hub", "start");
  ok(!/projected '/.test(again.stdout ?? ""), "AC7: a heal over already-agreeing rows is a silent no-op");
  cli("hub", "stop");
} finally {
  spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "hub", "stop"], { cwd: ROOT, encoding: "utf8", timeout: 20_000, ...clean });
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails === 0 ? "\n✅ project-row-sync: all assertions passed" : `\n❌ project-row-sync: ${fails} assertion(s) failed`);
process.exit(fails === 0 ? 0 : 1);
