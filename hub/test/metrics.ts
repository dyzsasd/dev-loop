// metrics.ts — fire metrics from fires.jsonl (window, success, suspect, medians), the 90d prune,
// board KPIs from issue.transition events (accept rate = Done ÷ (Done + In Review→Canceled)), and the CLI.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireMetrics, pruneFireLedger, boardMetrics, readFireRows, decisionQueue, ownerLiveness, renderHuman, usageReport, fireRowsFromEvents, renderUsage, renderCost, sensitiveMistier } from "../src/metrics.ts";
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

  // ── LOOP-73: renderHuman decision queue age — AC1/AC2/AC3/AC4 ─────────────────────────────────────
  {
    // Minimal Workspace stub (renderHuman reads only ws.file.team.key).
    const fakeWs = { file: { team: { key: "test-key" }, repos: {}, projects: {} } } as any;
    const fakeFires = { windowMs: 7 * DAY, fires: 0, failures: 0, timeouts: 0, suspectErrors: 0, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 0, costMeteredFires: 0, costUsd: null };
    const fakeRollup = { throughput: 0, verifyFails: 0, acceptRate: null, blockedNow: 0, sequencedNow: 0, bugsFiled: 0, escaped: 0 };

    // AC1: decision queue line shows age per item and names the oldest — oldest-first (T-3 at 4d, T-5 at 2d)
    const dqItems = [
      { id: "T-3", state: "In Review", project: "p", updatedAt: iso(NOW - 4 * DAY) },
      { id: "T-5", state: "Human-Blocked", project: "p", updatedAt: iso(NOW - 2 * DAY) },
    ];
    const lines73a: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines73a.push(String(args[0] ?? ""));
    try { renderHuman(fakeWs, 7 * DAY, fakeFires, { teamRollup: fakeRollup, decisionQueue: dqItems }, NOW); }
    finally { console.log = origLog; }
    const dqLine = lines73a.find((l) => l.startsWith("decision queue"));
    ok(dqLine !== undefined, "LOOP-73 AC1: decision queue line is present in renderHuman output");
    ok(/oldest T-3\[approve\] waiting 4d/.test(dqLine ?? ""),
      `LOOP-73 AC1: oldest item (T-3, 4 days) named with age in the header (got: ${dqLine})`);
    ok(/T-3\[approve\] 4d/.test(dqLine ?? "") && /T-5\[blocked\] 2d/.test(dqLine ?? ""),
      `LOOP-73 AC1: both items listed with their individual ages (got: ${dqLine})`);
    ok(/decision queue \(yours\): 2, oldest/.test(dqLine ?? ""),
      `LOOP-73 AC1: count prefix is correct (got: ${dqLine})`);

    // AC2: age is derived from updatedAt vs the threaded nowMs — no new query
    // (Verified by the test calling renderHuman with a fixed NOW; updatedAt already in the dq item.)

    // AC3: --json decisionQueue shape is byte-unchanged (id/title/state/updatedAt/project)
    const jsonItem = { id: "T-3", title: "approve me", state: "In Review", updatedAt: iso(NOW - 4 * DAY), project: "p" };
    ok(Object.keys(jsonItem).sort().join(",") === "id,project,state,title,updatedAt",
      "LOOP-73 AC3: --json decisionQueue item still has exactly id/title/state/updatedAt/project (shape unchanged)");

    // AC4: empty decision queue — no line emitted (the if (dq.length) guard stays)
    const lines73empty: string[] = [];
    const origLog2 = console.log;
    console.log = (...args: unknown[]) => lines73empty.push(String(args[0] ?? ""));
    try { renderHuman(fakeWs, 7 * DAY, fakeFires, { teamRollup: fakeRollup, decisionQueue: [] }, NOW); }
    finally { console.log = origLog2; }
    ok(!lines73empty.some((l) => l.startsWith("decision queue")),
      "LOOP-73 AC4: empty queue → no decision queue line (renders exactly as today)");
  }

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

  // LOOP-30: assignee-only ticket (no tier label) must not create a silent-zero (AC1+AC2)
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-6','p','assignee-only','d','Feature','Todo','junior-dev',2,?,  '[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "pm"]), iso(NOW - DAY), iso(NOW - DAY));
  const olEmptyLedger = join(tmp, "ol-empty.jsonl");
  writeFileSync(olEmptyLedger, "");
  const olAssigneeOnly = ownerLiveness(db, "p", olEmptyLedger, { nowMs: NOW, handles: ["junior-dev"] });
  ok(olAssigneeOnly.some((f) => f.owner === "junior-dev"),
    "LOOP-30 AC1+AC2: Todo with assignee='junior-dev' but no tier label yields a finding — silent-zero path closed");
  // AC3: In Review's assignee is the implementer, NOT the verifier — label wins for In Review.
  // Capture count BEFORE inserting T-7 so the assertion is robust when other fixtures (e.g. LOOP-26
  // T-SEQ with label "junior-dev") are also in the DB on the merged branch.
  const jdCountBeforeT7 = olAssigneeOnly.find((f) => f.owner === "junior-dev")?.openTickets ?? 0;
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-7','p','in-review-shipped','d','Bug','In Review','junior-dev',2,?,  '[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "qa"]), iso(NOW - DAY), iso(NOW - DAY));
  const olInReview = ownerLiveness(db, "p", olEmptyLedger, { nowMs: NOW, handles: ["junior-dev", "qa"] });
  const jdFinding = olInReview.find((f) => f.owner === "junior-dev");
  ok(jdFinding !== undefined && jdFinding.openTickets === jdCountBeforeT7,
    `LOOP-30 AC3: In Review with assignee=junior-dev and label=qa is NOT counted toward junior-dev — openTickets stays ${jdCountBeforeT7} (same as before T-7 insert, not +1)`);
  ok(olInReview.some((f) => f.owner === "qa" && f.openTickets >= 1),
    "LOOP-30 AC3: In Review ticket with label=qa IS owned by qa (verifier ownership via label)");

  // ── LOOP-81: sensitiveMistier — backstop surfacing (design sensitive-routing Child C) ──
  // No senior-dev actor yet → function is a no-op regardless of ticket state.
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-SM1','p','sensitive-junior','d','Feature','Todo','junior-dev',2,?,  '[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "pm", "sensitive", "junior-dev"]), iso(NOW - DAY), iso(NOW - DAY));
  ok(sensitiveMistier(db, "p").length === 0,
    "sensitiveMistier: returns [] when no senior-dev actor exists (no-op in single-dev projects)");

  // Insert senior-dev actor → now the mis-tiered ticket is found.
  db.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES('a-sd','senior-dev','agent','Senior Dev',1,'t')").run();
  const smFindings = sensitiveMistier(db, "p");
  ok(smFindings.some((f) => f.id === "T-SM1" && f.assignee === "junior-dev" && f.labels.includes("sensitive")),
    "sensitiveMistier: finds non-terminal sensitive+junior-dev ticket when senior-dev exists");

  // A ticket with sensitive label but junior-dev only in assignee (no tier label) is also found.
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-SM2','p','sensitive-assignee-only','d','Feature','In Progress','junior-dev',2,?,  '[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "pm", "sensitive"]), iso(NOW - DAY), iso(NOW - DAY));
  const smFindings2 = sensitiveMistier(db, "p");
  ok(smFindings2.some((f) => f.id === "T-SM2"),
    "sensitiveMistier: finds sensitive+assignee='junior-dev' without the tier label");

  // Terminal tickets (Done, Canceled, Duplicate) must not appear.
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-SM3','p','sensitive-done','d','Feature','Done','junior-dev',2,?,  '[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "pm", "sensitive", "junior-dev"]), iso(NOW - DAY), iso(NOW - DAY));
  ok(!sensitiveMistier(db, "p").some((f) => f.id === "T-SM3"),
    "sensitiveMistier: terminal (Done) sensitive+junior ticket is NOT surfaced");

  // A non-sensitive ticket is never returned.
  ok(!sensitiveMistier(db, "p").some((f) => f.id === "T-1"),
    "sensitiveMistier: non-sensitive tickets are never returned");

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

  // Assert that svcOut (ws2, repos:{}) gives landed:null and landing:[] — AC3 baseline
  ok(svcOut.landed === null, `LOOP-42 AC3: no qualifying repos → landed: null not 0 (got ${JSON.stringify(svcOut.landed)})`);
  ok(Array.isArray(svcOut.landing), "LOOP-42 AC3: landing is always an array even with no qualifying repos");

  // ── LOOP-42: landed (number) + landing[] shape + human render "done"/"landed" with fake gh ──
  const ghBin = join(tmp, "fake-gh-bin");
  mkdirSync(ghBin, { recursive: true });
  const fakeGhPath = join(ghBin, "gh");
  writeFileSync(fakeGhPath, [
    "#!/usr/bin/env node",
    "const a = process.argv.slice(2).join(' ');",
    "const recent = new Date(Date.now() - 86400000).toISOString();",
    "if (/--state[= ]merged/.test(a)) process.stdout.write(JSON.stringify([{headRefName:'dev-loop/LOOP-1',mergedAt:recent}]));",
    "else if (/--state[= ]open/.test(a)) process.stdout.write(JSON.stringify([]));",
    "else if (/check-runs/.test(a)) process.stdout.write(JSON.stringify({check_runs:[]}));",
  ].join("\n"));
  chmodSync(fakeGhPath, 0o755);

  const wsLand = join(tmp, "ws-land");
  mkdirSync(join(wsLand, ".dev-loop"), { recursive: true });
  writeFileSync(join(wsLand, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2, workspaceId: "test-ws-land",
    team: { key: "land-team", backend: "service", mode: "live", autonomy: "guarded" },
    repos: { myrepo: { path: "myrepo", remote: "https://github.com/test-org/my-repo.git", landing: "pr", autoMerge: true } },
    projects: { "land-team": { repos: [{ ref: "myrepo" }] } },
  }));
  spawnSync("node", [join(hubRoot, "src", "seed.ts"), "land-team", "Land Team", "LAND", join(wsLand, ".dev-loop", "hub.db")], { cwd: hubRoot, encoding: "utf8" });

  const pathWithFakeGh = `${ghBin}:${process.env.PATH ?? ""}`;
  const rLand = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d", "--json"], {
    cwd: wsLand, env: { ...process.env, PATH: pathWithFakeGh }, encoding: "utf8",
  });
  const landOut = (() => { try { return JSON.parse((rLand.stdout ?? "").trim()); } catch { return {}; } })() as Record<string, unknown>;
  ok(rLand.status === 0, `LOOP-42 AC1: metrics CLI with landing repo exits 0 (stderr: ${(rLand.stderr ?? "").replace(/\(node:.*?\)\n/g, "").slice(0, 200)})`);

  // AC1: landed is a number (sum of mergedInWindow for known repos)
  ok(typeof landOut.landed === "number", `LOOP-42 AC1: landed is a number (got ${JSON.stringify(landOut.landed)})`);
  ok(landOut.landed === 1, `LOOP-42 AC1: landed === 1 (one merged dev-loop PR in window, got ${landOut.landed})`);

  // AC1: landing[] has the expected shape
  ok(Array.isArray(landOut.landing), "LOOP-42 AC1: landing[] is an array");
  ok((landOut.landing as unknown[]).length === 1, `LOOP-42 AC1: landing[] has 1 entry (got ${(landOut.landing as unknown[]).length})`);
  const ls = (landOut.landing as Record<string, unknown>[])[0]!;
  ok(ls.repo === "myrepo", `LOOP-42 AC1: landing[0].repo = "myrepo" (got ${ls.repo})`);
  ok(ls.state === "healthy", `LOOP-42 AC1: landing[0].state = "healthy" (no open PRs → healthy, got ${ls.state})`);
  ok(ls.mergedInWindow === 1, `LOOP-42 AC1: landing[0].mergedInWindow === 1 (got ${ls.mergedInWindow})`);

  // AC2: throughput key byte-unchanged — landing addition must not rename or remove it
  ok(typeof (landOut.teamRollup as Record<string, unknown> | undefined)?.throughput === "number",
    "LOOP-42 AC2: teamRollup.throughput still present and a number after landing addition");

  // AC4: human render board line contains "done" and "landed"
  const rLandHuman = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d"], {
    cwd: wsLand, env: { ...process.env, PATH: pathWithFakeGh }, encoding: "utf8",
  });
  const landHumanOut = (rLandHuman.stdout ?? "").trim();
  ok(/\bdone\b/.test(landHumanOut), `LOOP-42 AC4: human board line contains "done" (got: ${landHumanOut.slice(0, 300)})`);
  ok(/\blanded\b/.test(landHumanOut), `LOOP-42 AC4: human board line contains "landed" (got: ${landHumanOut.slice(0, 300)})`);

  // ── LOOP-125: usageReport, fireMetrics cost fields, fireRowsFromEvents ──────
  {
    const usageLedger = join(tmp, "usage-fires.jsonl");
    const claudeRow = { ts: iso(NOW - 1 * DAY), agent: "pm", project: "web",
      codingAgent: "claude", provider: "anthropic", model: "claude-sonnet-4-5", effort: "high",
      durationMs: 60_000, exitCode: 0, fireId: "f1",
      usage: { source: "provider", inputTokens: 1000, outputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 50, costUsd: 0.015, currency: "USD" } };
    const codexRow = { ts: iso(NOW - 2 * DAY), agent: "dev", project: "web",
      codingAgent: "codex", provider: "openai", model: "gpt-4o", effort: "high",
      durationMs: 30_000, exitCode: 0, fireId: "f2",
      usage: { source: "provider", inputTokens: 500, outputTokens: 150, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, currency: null } };
    const opencodeRow = { ts: iso(NOW - 3 * DAY), agent: "qa", project: "web",
      codingAgent: "opencode", provider: null, model: null, effort: null,
      durationMs: 45_000, exitCode: 0, fireId: "f3" };
    const preMeteringRow = { ts: iso(NOW - 4 * DAY), agent: "sweep", project: "web",
      durationMs: 10_000, exitCode: 0 };
    const bootBytesRow = { ts: iso(NOW - 1 * DAY), agent: "pm", project: "web",
      durationMs: 5_000, exitCode: 0, bootBytes: 999_999 };
    writeFileSync(usageLedger, [claudeRow, codexRow, opencodeRow, preMeteringRow, bootBytesRow]
      .map((r) => JSON.stringify(r)).join("\n") + "\n");

    // fireMetrics cost fields
    const fm125 = fireMetrics(usageLedger, 7 * DAY, NOW);
    ok(fm125.fires === 5, `LOOP-125: fireMetrics sees all 5 fires (got ${fm125.fires})`);
    ok(fm125.meteredFires === 2, `LOOP-125: meteredFires = 2 (claude+codex; got ${fm125.meteredFires})`);
    ok(fm125.costMeteredFires === 1, `LOOP-125: costMeteredFires = 1 (only claude has costUsd; got ${fm125.costMeteredFires})`);
    ok(fm125.costUsd !== null && Math.abs(fm125.costUsd - 0.015) < 1e-9,
      `LOOP-125: costUsd = 0.015 (got ${fm125.costUsd})`);
    // bootBytes must never leak into costUsd
    ok(fm125.costUsd !== 999_999, "LOOP-125 AC5: bootBytes never populates a cost field");

    // usageReport — by provider
    const report = usageReport(readFireRows(usageLedger), 7 * DAY, { groupBy: "provider", nowMs: NOW });
    ok(report.totalFires === 5, `LOOP-125: usageReport totalFires=5 (got ${report.totalFires})`);
    ok(report.meteredFires === 2, `LOOP-125: usageReport meteredFires=2 (got ${report.meteredFires})`);
    ok(report.overall.inputTokens === 1500, `LOOP-125: overall inputTokens=1500 (got ${report.overall.inputTokens})`);
    ok(report.overall.costUsd !== null && Math.abs(report.overall.costUsd - 0.015) < 1e-9,
      `LOOP-125: overall costUsd=0.015 (got ${report.overall.costUsd})`);
    ok(report.overall.costMetered === 1, `LOOP-125: overall costMetered=1`);

    // by-provider cells
    ok(report.byDimension !== undefined, "LOOP-125: byDimension present when groupBy set");
    const byDim = report.byDimension!;
    ok((byDim["anthropic"]?.inputTokens ?? -1) === 1000,
      `LOOP-125 AC1: anthropic inputTokens=1000 (got ${byDim["anthropic"]?.inputTokens})`);
    ok((byDim["openai"]?.inputTokens ?? -1) === 500,
      `LOOP-125 AC1: openai inputTokens=500 (got ${byDim["openai"]?.inputTokens})`);
    // openai row has costUsd:null → group costUsd must be null, not 0
    ok(byDim["openai"]?.costUsd === null,
      `LOOP-125 AC1: openai costUsd is null (no priced fires; got ${byDim["openai"]?.costUsd})`);
    ok(byDim["openai"]?.costMetered === 0, `LOOP-125: openai costMetered=0`);
    // unmetered group (null/absent provider) → all token sums null, not 0
    const unknownCell = byDim["(unknown)"];
    ok(unknownCell !== undefined && unknownCell.metered === 0, "LOOP-125 AC1: (unknown) group metered=0");
    ok(unknownCell?.inputTokens === null, "LOOP-125 AC1: unmetered group inputTokens is null not 0");
    ok(unknownCell?.costUsd === null, "LOOP-125 AC1: unmetered group costUsd is null not 0");

    // renderCost: "unavailable" (never "$0.00") when the group has no priced fires
    const costLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => costLines.push(String(args[0] ?? ""));
    try { renderCost({ windowMs: 7 * DAY, totalFires: 1, meteredFires: 1, overall: byDim["openai"]!, byDimension: undefined }, "provider"); }
    finally { console.log = origLog; }
    ok(costLines.some((l) => /unavailable/.test(l) && !/\$0/.test(l)),
      `LOOP-125 AC2: renderCost writes "unavailable", never "$0.00" for unpriced group (got: ${costLines.join("|")})`);

    // renderUsage: prints coverage line
    const usageLines: string[] = [];
    console.log = (...args: unknown[]) => usageLines.push(String(args[0] ?? ""));
    try { renderUsage(report, "provider"); }
    finally { console.log = origLog; }
    ok(usageLines.some((l) => /metered/.test(l)), "LOOP-125: renderUsage prints N-of-M metered coverage");

    // FireRow types codingAgent/provider/model/effort — roundtrip via readFireRows
    const claudeParsed = readFireRows(usageLedger).find((r) => r.fireId === "f1");
    ok(claudeParsed?.codingAgent === "claude" && claudeParsed?.provider === "anthropic" && claudeParsed?.model === "claude-sonnet-4-5" && claudeParsed?.effort === "high",
      `LOOP-125 AC6: FireRow.codingAgent/provider/model/effort parsed correctly`);

    // CLI tests: use recent timestamps so the fires land inside the CLI's 7-day window.
    // (The fixture rows above use the fixed NOW=2026-07-04 for deterministic unit tests; CLI fires
    // use Date.now() so they are always inside the default 7-day window.)
    const NOW_REAL = Date.now();
    const mkRow = (offsetMs: number, extra: Record<string, unknown>) =>
      ({ ts: new Date(NOW_REAL - offsetMs).toISOString(), ...extra });
    const cliClaudeRow = mkRow(1 * DAY, { agent: "pm", project: "web", codingAgent: "claude", provider: "anthropic", model: "claude-sonnet-4-5", durationMs: 60_000, exitCode: 0, usage: { source: "provider", inputTokens: 1000, outputTokens: 300, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.015, currency: "USD" } });
    const cliCodexRow  = mkRow(2 * DAY, { agent: "dev", project: "web", codingAgent: "codex",  provider: "openai",    model: "gpt-4o",           durationMs: 30_000, exitCode: 0, usage: { source: "provider", inputTokens: 500, outputTokens: 150, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, currency: null } });
    const cliPreRow    = mkRow(3 * DAY, { agent: "sweep", project: "web", durationMs: 10_000, exitCode: 0 });

    const usageWs = join(tmp, "ws-usage");
    mkdirSync(join(usageWs, ".dev-loop", "team"), { recursive: true });
    writeFileSync(join(usageWs, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, workspaceId: "test-ws-u", team: { key: "u-team", backend: "linear", mode: "live", autonomy: "guarded" },
      repos: {}, projects: { "u-team": { repos: [] } },
    }));
    writeFileSync(join(usageWs, ".dev-loop", "team", "fires.jsonl"),
      [cliClaudeRow, cliCodexRow, cliPreRow].map((r) => JSON.stringify(r)).join("\n") + "\n");

    // CLI --usage --by provider --json
    const rUJ = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--usage", "--by", "provider", "--json"],
      { cwd: usageWs, env: { ...process.env }, encoding: "utf8" });
    const uJOut = (() => { try { return JSON.parse((rUJ.stdout ?? "").trim()); } catch { return null; } })();
    ok(rUJ.status === 0, `LOOP-125: --usage --json exits 0 (stderr: ${(rUJ.stderr ?? "").slice(0, 200)})`);
    ok(uJOut?.usage?.meteredFires === 2, `LOOP-125 AC1: --json meteredFires=2 (got ${uJOut?.usage?.meteredFires})`);
    const byDimJ = uJOut?.usage?.byDimension as Record<string, { inputTokens: number | null; costUsd: number | null }> | undefined;
    ok(byDimJ?.["anthropic"]?.inputTokens === 1000, `LOOP-125 AC1: --json anthropic inputTokens=1000 (got ${byDimJ?.["anthropic"]?.inputTokens})`);
    ok(byDimJ?.["openai"]?.costUsd === null, `LOOP-125 AC1: --json openai costUsd=null (not 0; got ${byDimJ?.["openai"]?.costUsd})`);

    // CLI --cost --json: overall.costUsd sums only priced rows; never a string "$0.00"
    const rCJ = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--cost", "--json"],
      { cwd: usageWs, env: { ...process.env }, encoding: "utf8" });
    const cJOut = (() => { try { return JSON.parse((rCJ.stdout ?? "").trim()); } catch { return null; } })();
    ok(rCJ.status === 0, `LOOP-125: --cost --json exits 0`);
    ok(typeof (cJOut?.usage?.overall?.costUsd ?? null) !== "string",
      `LOOP-125 AC2: --cost overall.costUsd is a number or null (never a string "$0.00"; got ${JSON.stringify(cJOut?.usage?.overall?.costUsd)})`);
    ok(cJOut?.usage?.overall?.costMetered === 1,
      `LOOP-125 AC2: --cost overall.costMetered=1 (only claude row priced; got ${cJOut?.usage?.overall?.costMetered})`);

    // CLI --flow --json: linear backend → throughput:null, boardNote mentions linear
    const rFJ = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--flow", "--json"],
      { cwd: usageWs, env: { ...process.env }, encoding: "utf8" });
    const fJOut = (() => { try { return JSON.parse((rFJ.stdout ?? "").trim()); } catch { return null; } })();
    ok(rFJ.status === 0, `LOOP-125: --flow --json exits 0`);
    ok(fJOut?.flow?.throughput === null, `LOOP-125 AC3: --flow on linear → throughput:null (got ${fJOut?.flow?.throughput})`);
    ok(typeof fJOut?.flow?.boardNote === "string" && /linear/.test(fJOut.flow.boardNote),
      `LOOP-125 AC3: --flow on linear → boardNote mentions linear`);

    // fireRowsFromEvents — shapes hub events into FireRows (ORDER BY created_at ASC: older=dev, newer=pm)
    const evDb = openDb(join(tmp, "ev-hub.db"));
    evDb.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p2','evtest','EvTest','t')").run();
    evDb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p2',NULL,'pm','fire.completed',?,?)")
      .run(JSON.stringify({ codingAgent: "claude", provider: "anthropic", model: "claude-opus-5", effort: "high", durationMs: 10_000, exitCode: 0, timedOut: false, fireId: "ev1", usage: { source: "provider", inputTokens: 200, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.005, currency: "USD" } }), iso(NOW - 1 * DAY));
    evDb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p2',NULL,'dev','fire.completed',?,?)")
      .run(JSON.stringify({ codingAgent: "codex", provider: "openai", model: "gpt-4o", effort: null, durationMs: 5_000, exitCode: 0, timedOut: false }), iso(NOW - 2 * DAY));
    const evRows = fireRowsFromEvents(evDb, "p2", iso(NOW - 7 * DAY));
    evDb.close();
    ok(evRows.length === 2, `LOOP-125: fireRowsFromEvents returns 2 rows (got ${evRows.length})`);
    // ASC order: dev row (NOW-2) comes before pm row (NOW-1)
    const evPm  = evRows.find((r) => r.agent === "pm");
    const evDev = evRows.find((r) => r.agent === "dev");
    ok(evPm  !== undefined && evPm.project === "evtest",
      "LOOP-125: actor→agent, project key resolved from projects table");
    ok(evPm?.provider === "anthropic" && evPm?.model === "claude-opus-5",
      "LOOP-125: provider/model shaped from event data");
    ok(evPm?.usage?.costUsd === 0.005, "LOOP-125: usage.costUsd shapes correctly from event");
    ok(evDev !== undefined && evDev.usage === undefined, "LOOP-125: row without usage key → usage:undefined");
  }

  console.log(fails === 0 ? "\nMETRICS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};
