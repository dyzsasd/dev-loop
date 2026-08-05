// LOOP-329 — the Backlog side per dev tier, and the starvation warning.
//
// Every surface that reported dev-tier load reported only the TODO side, so a tier with capacity and
// nothing it is allowed to pull was invisible to the operator and re-derived by hand by PM on every
// fire. Measured on the loop board 2026-08-05: senior-dev at 6/10 Todo — 4 idle slots — with ZERO
// promotable Backlog anywhere, while 66 junior tickets queued at a tier already over its cap.
//
// The discriminating case is AC4: idle slots WITH candidates available must be SILENT. Without it an
// always-firing warning and a correct one are indistinguishable — the axis LOOP-250 and LOOP-242 both
// shipped without.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { servableBacklogDepth, servableTodoDepth } from "../src/servable.ts";
import { resolveTodoDepthCap, loadWorkspace, DEFAULT_TODO_DEPTH_CAP } from "../src/team-config.ts";
import { checkTierStarvation } from "../src/doctor.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-backlog-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const dbPath = join(tmp, "hub.db");
  const db = openDb(dbPath);
  ensureSeed(db, "bd", "Backlog Depth", "BD");
  const pid = findProject(db, "bd")!;
  let n = 0;
  const mk = (state: string, assignee: string | null, labels: string[] = []) =>
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t','','Improvement',?,?,2,?,'[]','pm','t','t')")
      .run(`BD-${++n}`, pid, state, assignee, JSON.stringify(labels));

  // ── AC1: the count ────────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < 3; i++) mk("Backlog", "senior-dev");
  for (let i = 0; i < 5; i++) mk("Backlog", "junior-dev");
  mk("Backlog", "junior-dev", ["blocked"]);            // not promotable ⇒ not a candidate
  mk("Backlog", "senior-dev", ["blocked"]);
  mk("Backlog", "junior-dev", ["sensitive"]);          // Layer-2: never servable to junior
  mk("Todo", "senior-dev");                            // a Todo row must not leak into the backlog count

  const b = servableBacklogDepth(db, pid);
  ok(b["senior-dev"] === 3, `LOOP-329 AC1: senior Backlog candidates counted (got ${b["senior-dev"]}, want 3)`);
  ok(b["junior-dev"] === 5, `LOOP-329 AC1: junior's sensitive row is NOT a junior candidate — the same Layer-2 rule the servable slice applies (got ${b["junior-dev"]}, want 5)`);
  ok(b.total === 9, `LOOP-329 AC1: total counts every non-blocked Backlog row (got ${b.total}, want 9)`);
  ok(b["senior-dev"] + b["junior-dev"] !== b.total,
    "LOOP-329: total is NOT the sum of the tiers — the sensitive row is in total and in neither tier, which is exactly why both are reported");

  // Keyed the same way as todoDepth, from the same predicate — LOOP-169's whole point.
  const t = servableTodoDepth(db, pid);
  ok(Object.keys(b).sort().join(",") === Object.keys(t).sort().join(","),
    "LOOP-329 AC1: backlogDepth is keyed identically to todoDepth");
  ok(t["senior-dev"] === 1 && t.total === 1, `LOOP-329: …and the Todo side is unchanged by any of this (got ${t["senior-dev"]}/${t.total})`);

  // ── the §5a cap, nearest-wins ────────────────────────────────────────────────────────────────
  const mkWs = (teamCap?: number, projCap?: number, devSplit = true): string => {
    const root = join(tmp, `ws-${teamCap ?? "d"}-${projCap ?? "d"}-${devSplit}`);
    mkdirSync(join(root, ".dev-loop"), { recursive: true });
    mkdirSync(join(root, "repo"), { recursive: true });
    writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "bd-team", backend: "service", ...(teamCap ? { intake: { todoDepthCap: teamCap } } : {}) },
      repos: { repo: { path: "repo" } },
      projects: { bd: { devSplit, ...(projCap ? { intake: { todoDepthCap: projCap } } : {}) } },
    }));
    return root;
  };
  ok(resolveTodoDepthCap(loadWorkspace(mkWs()), "bd") === DEFAULT_TODO_DEPTH_CAP,
    `LOOP-329: the shipped default cap is ${DEFAULT_TODO_DEPTH_CAP}`);
  ok(resolveTodoDepthCap(loadWorkspace(mkWs(4)), "bd") === 4, "LOOP-329: a team cap applies");
  ok(resolveTodoDepthCap(loadWorkspace(mkWs(4, 7)), "bd") === 7,
    "LOOP-329: a project cap overrides the team's — NEAREST WINS, per §5a");

  // ── AC3/AC4: the warning, and the two silences ───────────────────────────────────────────────
  const w31 = (wsRoot: string): string => {
    const lines: string[] = [];
    checkTierStarvation(loadWorkspace(wsRoot), dbPath, (m) => lines.push(m));
    return lines.join("\n");
  };

  // Board right now: senior 1 Todo / 3 Backlog, junior 0 Todo / 5 Backlog. Cap 10 ⇒ both tiers have
  // idle slots AND candidates. THIS IS THE DISCRIMINATOR — an always-firing check passes everything
  // else in this file and fails only here.
  ok(!w31(mkWs()).includes("[W31]"),
    "LOOP-329 AC4: idle slots WITH candidates available is SILENT — that is a PM fire that has not run yet, not starvation");

  // Now starve senior: promote its 3 Backlog rows to Todo, leaving 0 candidates and 6 idle slots.
  db.prepare("UPDATE tickets SET state='Todo' WHERE project_id=? AND state='Backlog' AND assignee='senior-dev' AND labels NOT LIKE '%blocked%'").run(pid);
  const bStarved = servableBacklogDepth(db, pid);
  ok(bStarved["senior-dev"] === 0, `LOOP-329: senior now has 0 promotable Backlog (got ${bStarved["senior-dev"]})`);
  const warned = w31(mkWs());
  ok(warned.includes("[W31]"), "LOOP-329 AC3: a tier with idle slots and ZERO candidates warns");
  ok(/senior-dev/.test(warned) && /idle Todo slot/.test(warned), `LOOP-329 AC3: …naming the tier and the idle-slot count (${warned.slice(0, 130)})`);
  ok(/'junior-dev' holds 5 Backlog candidate/.test(warned),
    `LOOP-329 AC3: …and the SIBLING tier's backlog depth, which is what makes it actionable (${warned.slice(warned.indexOf("while"), warned.indexOf("while") + 60)})`);
  ok(!/'junior-dev' has \d+ idle/.test(warned),
    "LOOP-329 AC3: …and junior does NOT warn — it has candidates, so it is not starved");

  // AC3's other silence: at cap is not starvation. Cap 1 ⇒ senior's 4 Todo rows are over cap.
  ok(!w31(mkWs(1)).includes("[W31]"),
    "LOOP-329 AC3: a tier AT OR OVER its cap is silent — a full queue is the healthy state, not a finding");

  // A single-tier project has no starved sibling to name, so the check does not apply.
  ok(!w31(mkWs(undefined, undefined, false)).includes("[W31]"),
    "LOOP-329: a project without devSplit is silent — there is no sibling tier for the finding to point at");

  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nBACKLOG_DEPTH_OK");
process.exit(fails ? 1 : 0);
