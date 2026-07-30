// metrics.ts — fire metrics from fires.jsonl (window, success, suspect, medians), the 90d prune,
// board KPIs from issue.transition events (accept rate = Done ÷ (Done + In Review→Canceled)), and the CLI.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireMetrics, pruneFireLedger, boardMetrics, readFireRows, decisionQueue, ownerLiveness } from "../src/metrics.ts";
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
  ok(bm.sequencedNow === 0, "LOOP-26: no live Blocked-by edges initially → sequencedNow = 0");
  ok(bm.qa.bugsFiled === 2 && bm.qa.escaped === 1 && bm.qa.escapeRatio === 0.5, "QA escape ratio = incident/signal Bugs ÷ all Bugs");

  // ── LOOP-26: blockedNow/sequencedNow split ─────────────────────────────────
  // T-SEQ: a ticket with `blocked` + live Blocked-by edge → sequenced (not parked)
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-DEP','p','blocker','d','Feature','Todo',2,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-SEQ','p','sequenced','d','Feature','Todo',2,?,'[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "junior-dev", "blocked"]), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES('c-seq','T-SEQ','pm',?,?)")
    .run("Blocked-by: T-DEP", iso(NOW - DAY));  // T-DEP is Todo (open) → live edge

  // T-DONE-DEP: a ticket with `blocked` + Blocked-by pointing to a Done ticket → parked (AC2)
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-DONE-DEP','p','done blocker','d','Feature','Done',2,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-PAR2','p','parked2','d','Feature','Todo',2,?,'[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "blocked"]), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES('c-par2','T-PAR2','pm',?,?)")
    .run("Blocked-by: T-DONE-DEP", iso(NOW - DAY));  // T-DONE-DEP is Done → satisfied edge → parked

  const bm2 = boardMetrics(db, "p", 7 * DAY, NOW);
  // Now: T-1 (parked, no Blocked-by), T-PAR2 (parked, all Blocked-by done) → blockedNow=2
  //      T-SEQ (sequenced, live Blocked-by) → sequencedNow=1
  ok(bm2.blockedNow === 2, `LOOP-26: blockedNow counts only parked (attention-needed) tickets (got ${bm2.blockedNow})`);
  ok(bm2.sequencedNow === 1, `LOOP-26: sequencedNow counts tickets with live Blocked-by edges (got ${bm2.sequencedNow})`);
  ok(bm2.blockedNow + bm2.sequencedNow === 3, "LOOP-26: blockedNow + sequencedNow = total blocked-labelled open tickets");

  // AC6: a ticket with `blocked` but no Blocked-by comment at all → parked (fail-safe)
  // (T-1 covers this: it has `blocked` label, no comments at all)
  ok((() => { const bmChk = boardMetrics(db, "p", 7 * DAY, NOW); return bmChk.blockedNow >= 1; })(),
    "LOOP-26 AC6: blocked+no-Blocked-by-comment counts as parked (fail-safe toward needs-attention)");

  // ── P1-3: decisionQueue = Human-Blocked ∪ In Review@operator, oldest first ──
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-3','p','approve me','d','Feature','In Review','operator',0,'[]','[]','pm',?,?)")
    .run(iso(NOW - 4 * DAY), iso(NOW - 4 * DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-4','p','agent review','d','Feature','In Review','qa',0,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-5','p','parked','d','Feature','Human-Blocked',NULL,0,'[]','[]','pm',?,?)")
    .run(iso(NOW - 2 * DAY), iso(NOW - 2 * DAY));
  const dq = decisionQueue(db, "p");
  ok(dq.length === 2 && dq[0].id === "T-3" && dq[1].id === "T-5", `decisionQueue = HB ∪ InReview@operator, oldest first (got ${dq.map((t) => t.id).join(",")})`);
  ok(!dq.some((t) => t.id === "T-4"), "an agent-assigned In Review ticket is not in the operator's queue");

  // ── P1-4: ownerLiveness — a stranded owner (open tickets, no fires) is found; live/manual handled ──
  db.prepare("UPDATE tickets SET labels=? WHERE id='T-3'").run(JSON.stringify(["dev-loop", "qa"]));      // qa-owned, In Review
  db.prepare("UPDATE tickets SET labels=? WHERE id='T-4'").run(JSON.stringify(["dev-loop", "pm"]));      // pm-owned, In Review
  const olLedger = join(tmp, "ol-fires.jsonl");
  writeFileSync(olLedger, JSON.stringify({ ts: iso(NOW - DAY), agent: "pm", project: "web", durationMs: 1, exitCode: 0, timedOut: false }) + "\n");
  const ol = ownerLiveness(db, "p", olLedger, { nowMs: NOW });
  ok(ol.some((f) => f.owner === "qa" && f.openTickets >= 1 && f.lastFireTs === null && !f.manual),
    `ownerLiveness: qa owns open tickets with no fire on record → finding (got ${JSON.stringify(ol.map((f) => f.owner))})`);
  ok(!ol.some((f) => f.owner === "pm"), "ownerLiveness: pm fired within the window → no finding");
  const olManual = ownerLiveness(db, "p", olLedger, { nowMs: NOW, manualHandles: new Set(["qa"]) });
  ok(olManual.some((f) => f.owner === "qa" && f.manual), "ownerLiveness: agents.qa.manual:true flags the finding manual (awaiting a human)");
  const olStale = ownerLiveness(db, "p", olLedger, { nowMs: NOW + 10 * DAY });
  ok(olStale.some((f) => f.owner === "pm" && f.lastFireTs !== null), "ownerLiveness: a fire OLDER than the window counts as stranded too");
  // Mutation-killer (quality --mutate survivor, 1.7.1): the last-fire scan keys on
  // `!has(agent) || ts > max` — flipped to `&&`, a SECOND newer row never updates the max, so an
  // agent whose latest fire is inside the window (but whose FIRST row is stale) gets flagged.
  // Two rows, old-then-new, window covering only the new one: must stay un-flagged.
  const olTwo = join(tmp, "ol-two-fires.jsonl");
  writeFileSync(olTwo,
    JSON.stringify({ ts: iso(NOW - 9 * DAY), agent: "pm", project: "web", durationMs: 1, exitCode: 0, timedOut: false }) + "\n" +
    JSON.stringify({ ts: iso(NOW - DAY), agent: "pm", project: "web", durationMs: 1, exitCode: 0, timedOut: false }) + "\n");
  ok(!ownerLiveness(db, "p", olTwo, { nowMs: NOW }).some((f) => f.owner === "pm"),
    "ownerLiveness: the LATEST of several fires decides liveness (old row first must not stick)");
  db.close();

  // ── LOOP-12: FireRow with fireId parses; legacy row without fireId also parses ──
  const fireIdLedger = join(tmp, "fireid.jsonl");
  writeFileSync(fireIdLedger, [
    JSON.stringify({ ts: iso(NOW - DAY), agent: "pm", project: "web", durationMs: 100, exitCode: 0, fireId: "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    JSON.stringify({ ts: iso(NOW - 2 * DAY), agent: "qa", project: "web", durationMs: 200, exitCode: 0 }), // legacy: no fireId
  ].join("\n") + "\n");
  const fiRows = readFireRows(fireIdLedger);
  ok(fiRows.length === 2, `LOOP-12: both rows parse (got ${fiRows.length})`);
  ok(fiRows[0].fireId === "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee",
    `LOOP-12: FireRow with fireId parses correctly (got ${fiRows[0].fireId})`);
  ok(fiRows[1].fireId === undefined, `LOOP-12: legacy FireRow without fireId parses without error (fireId=${fiRows[1].fireId})`);

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
  // Mutation-killer (quality --mutate survivor, 1.7.1): `let asJson = false` flipped to true made
  // every run emit JSON and nothing asserted the HUMAN default. Without --json the output must be
  // the human render, not a parsable JSON object.
  const rh = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d"], { cwd: ws, env: { ...process.env, DEVLOOP_HOME: HOME }, encoding: "utf8" });
  const humanOut = (rh.stdout ?? "").trim();
  const parsesAsJson = (() => { try { JSON.parse(humanOut); return true; } catch { return false; } })();
  ok(rh.status === 0 && !parsesAsJson && /met-team/.test(humanOut), "CLI without --json renders the HUMAN report (not JSON)");

  // ── LOOP-26: AC3 + AC4 — service-backend CLI emits sequencedNow in JSON and human render ──
  const ws2 = join(tmp, "ws-svc");
  // The CLI's collectBoardMetrics checks existsSync(wsHubDb(ws)) = ws2/.dev-loop/hub.db,
  // so we must seed the DB at that exact path, not at an arbitrary svcHubDb path.
  const svcStateDir = join(ws2, ".dev-loop");
  const svcHubDb = join(svcStateDir, "hub.db");
  mkdirSync(svcStateDir, { recursive: true });
  writeFileSync(join(ws2, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2, workspaceId: "test-ws-svc",
    team: { key: "svc-team", backend: "service", mode: "live", autonomy: "guarded" },
    repos: {}, projects: { "svc-team": { repos: [] } },
  }));
  spawnSync("node", [join(hubRoot, "src", "seed.ts"), "svc-team", "Svc Team", "SVC", svcHubDb], { cwd: hubRoot, encoding: "utf8" });
  const rSvc = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d", "--json"], { cwd: ws2, env: { ...process.env }, encoding: "utf8" });
  const svcOut = (() => { try { return JSON.parse((rSvc.stdout ?? "").trim()); } catch { return {}; } })();
  ok(rSvc.status === 0, `LOOP-26 AC3: service metrics CLI exits 0 (stderr: ${(rSvc.stderr ?? "").replace(/\(node:.*?\)\n/g, "").slice(0, 200)})`);
  const svcBoard = svcOut.board?.["svc-team"] as Record<string, unknown> | undefined;
  ok(!!(svcBoard && typeof svcBoard.blockedNow === "number" && typeof svcBoard.sequencedNow === "number"),
    `LOOP-26 AC3: board JSON includes both blockedNow and sequencedNow (got ${JSON.stringify(svcBoard)})`);
  ok(!!(svcOut.teamRollup && typeof (svcOut.teamRollup as Record<string, unknown>).sequencedNow === "number"),
    "LOOP-26 AC3: teamRollup includes sequencedNow");
  const rSvcHuman = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d"], { cwd: ws2, env: { ...process.env }, encoding: "utf8" });
  const svcHumanOut = (rSvcHuman.stdout ?? "").trim();
  ok(/parked/.test(svcHumanOut) && /sequenced/.test(svcHumanOut),
    `LOOP-26 AC4: human render contains both 'parked' and 'sequenced' (got: ${svcHumanOut.slice(0, 300)})`);

  console.log(fails === 0 ? "\nMETRICS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
