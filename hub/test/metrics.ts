// metrics.ts — fire metrics from fires.jsonl (window, success, suspect, medians), the 90d prune,
// board KPIs from issue.transition events (accept rate = Done ÷ (Done + In Review→Canceled)), and the CLI.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireMetrics, pruneFireLedger, boardMetrics, readFireRows } from "../src/metrics.ts";
import { openDb } from "../src/db.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-metrics-")));
const DAY = 86_400_000;
const NOW = Date.parse("2026-07-04T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

try {
  // ── fire metrics ──
  const ledger = join(tmp, "fires.jsonl");
  const row = (o: Record<string, unknown>) => JSON.stringify(o);
  writeFileSync(ledger, [
    row({ ts: iso(NOW - 1 * DAY), agent: "pm", project: "web", durationMs: 60_000, exitCode: 0 }),
    row({ ts: iso(NOW - 2 * DAY), agent: "pm", project: "web", durationMs: 120_000, exitCode: 0 }),
    row({ ts: iso(NOW - 3 * DAY), agent: "qa", project: "web", durationMs: 30_000, exitCode: 1 }),          // failure
    row({ ts: iso(NOW - 4 * DAY), agent: "qa", project: "web", durationMs: 40_000, exitCode: 0, suspectError: true, outputTail: "Execution error" }),
    row({ ts: iso(NOW - 5 * DAY), agent: "sweep", project: "", durationMs: 10_000, exitCode: 124, timedOut: true }),
    row({ ts: iso(NOW - 30 * DAY), agent: "pm", project: "web", durationMs: 5_000, exitCode: 0 }),          // outside 7d window
    "{torn json line",                                                                                       // crash mid-append → skipped
  ].join("\n") + "\n");

  const fm = fireMetrics(ledger, 7 * DAY, NOW);
  ok(fm.fires === 5, `7d window counts 5 fires (got ${fm.fires}; the 30d-old row + torn line excluded)`);
  ok(fm.failures === 2 && fm.timeouts === 1 && fm.suspectErrors === 1, "failures/timeouts/suspectErrors tallied");
  ok(fm.successRate !== null && Math.abs(fm.successRate - 2 / 5) < 1e-9, "success rate = (5-2-1)/5 = 40%");
  ok(fm.byAgent.pm.fires === 2 && fm.byAgent.pm.medianMs === 120_000, "per-agent median duration");
  ok(fm.byProject.web.fires === 4 && fm.byProject["(team)"].fires === 1, "per-project split; steward '' → (team)");

  // ── prune keeps only the retention window ──
  pruneFireLedger(ledger, 10 * DAY, NOW);
  ok(readFireRows(ledger).length === 5 && !readFileSync(ledger, "utf8").includes("torn"), "prune drops old + torn rows, keeps the window");

  // ── board KPIs from issue.transition events ──
  const db = openDb(join(tmp, "hub.db"));
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','web','Web','t')").run();
  const trans = (from: string, to: string, ms: number) =>
    db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
      .run(JSON.stringify({ from, to }), iso(ms));
  trans("In Review", "Done", NOW - 1 * DAY);
  trans("In Review", "Done", NOW - 2 * DAY);
  trans("In Review", "Done", NOW - 3 * DAY);
  trans("In Review", "Canceled", NOW - 2 * DAY);   // verify-fail
  trans("Todo", "Canceled", NOW - 2 * DAY);         // ordinary cancel — NOT in the accept denominator
  trans("In Review", "Done", NOW - 20 * DAY);       // outside window
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-1','p','t','d','Bug','Todo',2,?, '[]','qa',?,?)")
    .run(JSON.stringify(["dev-loop", "Bug", "qa", "blocked"]), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-2','p','t','d','Bug','Todo',2,?, '[]','ops',?,?)")
    .run(JSON.stringify(["dev-loop", "Bug", "qa", "incident"]), iso(NOW - DAY), iso(NOW - DAY));
  const bm = boardMetrics(db, "p", 7 * DAY, NOW);
  ok(bm.throughput === 3, `throughput = 3 Done in window (got ${bm.throughput})`);
  ok(bm.verifyFails === 1 && bm.acceptRate !== null && Math.abs(bm.acceptRate - 0.75) < 1e-9, "accept rate = 3/(3+1) = 75%; ordinary Cancel excluded");
  ok(bm.blockedNow === 1, "blocked-open count from the labels column");
  ok(bm.qa.bugsFiled === 2 && bm.qa.escaped === 1 && bm.qa.escapeRatio === 0.5, "QA escape ratio = incident/signal Bugs ÷ all Bugs");
  db.close();

  // ── CLI e2e on a real workspace (linear → fire metrics + boardNote) ──
  const HOME = join(tmp, "home");
  const ws = join(tmp, "ws");
  spawnSync("node", [join(hubRoot, "src", "team.ts"), "init", "--dir", ws, "--key", "met-team", "--backend", "linear", "--linear-team", "L"], { env: { ...process.env, DEVLOOP_HOME: HOME }, encoding: "utf8" });
  mkdirSync(join(ws, ".dev-loop", "team"), { recursive: true });
  writeFileSync(join(ws, ".dev-loop", "team", "fires.jsonl"), row({ ts: new Date().toISOString(), agent: "pm", project: "web", durationMs: 1000, exitCode: 0 }) + "\n");
  const r = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d", "--json"], { cwd: ws, env: { ...process.env, DEVLOOP_HOME: HOME }, encoding: "utf8" });
  const out = JSON.parse((r.stdout ?? "").trim());
  ok(r.status === 0 && out.team === "met-team" && out.fires.fires === 1, "CLI --json reports team + fire metrics from the workspace ledger");
  ok(typeof out.boardNote === "string" && /linear/.test(out.boardNote), "linear backend: boardNote says the digest agent owns board KPIs (no guessing)");

  console.log(fails === 0 ? "\nMETRICS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
