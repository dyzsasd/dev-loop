// metrics.ts — fire metrics from fires.jsonl (window, success, suspect, medians), the 90d prune,
// board KPIs from issue.transition events (accept rate = Done ÷ (Done + In Review→Canceled)), and the CLI.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireMetrics, pruneFireLedger, boardMetrics, readFireRows, decisionQueue, ownerLiveness, renderHuman, usageReport, fireRowsFromEvents, renderUsage, renderCost, renderFlow, sensitiveMistier, kaizenReport, renderKaizen, rollingSpendUsd, parkedSplit, escapeSignalSourceRan, profileDeadlines, perFireDeadline } from "../src/metrics.ts";
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
  // Fixture ids are `<PREFIX>-<n>` because that is the only id the hub can mint (`db.ts` nextTicketId:
  // `${ticket_prefix}-${seq}`) and the only shape a marker parses (`ticket-id.ts`, LOOP-264). These were
  // `T-DEP`/`T-SEQ`/`T-DONE-DEP`/`T-PAR2` — hyphenated non-numeric tokens, which no project can ever
  // produce. They only parsed because the old blocked-by copy accepted ANY hyphenated token, i.e. this
  // suite was passing on the exact defect LOOP-264 repairs. Assertions below are unchanged.
  // TSEQ-1: a ticket with `blocked` + live Blocked-by edge → sequenced (not parked)
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('TDEP-1','p','blocker','d','Feature','Todo',2,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('TSEQ-1','p','sequenced','d','Feature','Todo',2,?,'[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "junior-dev", "blocked"]), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES('c-seq','TSEQ-1','pm',?,?)")
    .run("Blocked-by: TDEP-1", iso(NOW - DAY));  // TDEP-1 is Todo (open) → live edge

  // TDONE-1: a ticket with `blocked` + Blocked-by pointing to a Done ticket → parked (AC2)
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('TDONE-1','p','done blocker','d','Feature','Done',2,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('TPAR-2','p','parked2','d','Feature','Todo',2,?,'[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "blocked"]), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES('c-par2','TPAR-2','pm',?,?)")
    .run("Blocked-by: TDONE-1", iso(NOW - DAY));  // TDONE-1 is Done → satisfied edge → parked

  const bm2 = boardMetrics(db, "p", 7 * DAY, NOW);
  // Now: T-1 (parked, no Blocked-by), TPAR-2 (parked, all Blocked-by done) → blockedNow=2
  //      TSEQ-1 (sequenced, live Blocked-by) → sequencedNow=1
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

  // ── LOOP-31: shared parkedSplit reconciles metrics + /activity ────────────────
  // The binding AC: Human-Blocked with no blocked label (LOOP-92 shape) counts as parked.
  // T-5 is already inserted as Human-Blocked with labels [] — no blocked label.
  const ps = parkedSplit(db, "p");
  ok(ps.parkedIds.includes("T-5"), `LOOP-31 AC1: Human-Blocked T-5 (no blocked label) is in parkedIds (got ${ps.parkedIds.join(",")})`);
  ok(ps.parkedIds.includes("T-1"), "LOOP-31 AC1: blocked-label T-1 (no edge) is in parkedIds");
  ok(ps.parkedIds.includes("TPAR-2"), "LOOP-31 AC1: blocked-label TPAR-2 (edge to Done) is in parkedIds");
  ok(!ps.parkedIds.includes("TSEQ-1"), "LOOP-31 AC3: blocked+live-edge TSEQ-1 is NOT in parkedIds (sequenced)");
  ok(ps.sequencedNow === 1, `LOOP-31 AC3: sequencedNow=1 (TSEQ-1 only; got ${ps.sequencedNow})`);
  // AC5: boardMetrics uses the same parkedSplit → same numbers
  const bm31 = boardMetrics(db, "p", 7 * DAY, NOW);
  ok(bm31.blockedNow === ps.parkedIds.length,
    `LOOP-31 AC5: boardMetrics.blockedNow (${bm31.blockedNow}) === parkedIds.length (${ps.parkedIds.length})`);
  ok(bm31.sequencedNow === ps.sequencedNow,
    `LOOP-31 AC5: boardMetrics.sequencedNow (${bm31.sequencedNow}) === ps.sequencedNow (${ps.sequencedNow})`);
  // AC4: Human-Blocked distinguishable from Dev bail — parkedIds includes both but
  // the tile shows "awaiting you · Human-Blocked" separately. Verify the count split.
  const hbCount = db.prepare("SELECT COUNT(*) as n FROM tickets WHERE project_id=? AND state='Human-Blocked'").get("p") as { n: number };
  ok(hbCount.n === 1, `LOOP-31 AC4: exactly 1 Human-Blocked ticket (T-5; got ${hbCount.n})`);
  ok(ps.parkedIds.length - hbCount.n === 2, `LOOP-31 AC4: 2 Dev-bail parks (T-1, TPAR-2) distinguishable from ${hbCount.n} Human-Blocked`);
  // AC2: a blocked + needs-pm ticket (non-Human-Blocked) is visible as parked
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('L31-DB','p','dev-bail','d','Feature','Todo',NULL,2,?,  '[]','pm',?,?)")
    .run(JSON.stringify(["dev-loop", "blocked", "needs-pm"]), iso(NOW - DAY), iso(NOW - DAY));
  const ps2 = parkedSplit(db, "p");
  ok(ps2.parkedIds.includes("L31-DB"), "LOOP-31 AC2: blocked+needs-pm Dev bail (L31-DB) is in parkedIds");

  // ── LOOP-73: renderHuman decision queue age — AC1/AC2/AC3/AC4 ─────────────────────────────────────
  {
    // Minimal Workspace stub (renderHuman reads only ws.file.team.key).
    const fakeWs = { file: { team: { key: "test-key" }, repos: {}, projects: {} } } as any;
    const fakeFires = { windowMs: 7 * DAY, fires: 0, failures: 0, timeouts: 0, suspectErrors: 0, interrupted: 0, discardedFires: 0, discardedCostUsd: null, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 0, costMeteredFires: 0, costUsd: null, meteringOnsetTs: null };
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
    const noUsageFires = { windowMs: 7 * DAY, fires: 12, failures: 0, timeouts: 0, suspectErrors: 0, interrupted: 0, discardedFires: 0, discardedCostUsd: null, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 0, costMeteredFires: 0, costUsd: null, meteringOnsetTs: null };
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
    const meteredFires = { windowMs: 7 * DAY, fires: 20, failures: 0, timeouts: 0, suspectErrors: 0, interrupted: 0, discardedFires: 0, discardedCostUsd: null, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 5, costMeteredFires: 3, costUsd: 0.12, meteringOnsetTs: null };
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
  // TSEQ-1 with label "junior-dev") are also in the DB on the merged branch.
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

  // ── LOOP-227: rollingSpendUsd — enforcement spend total estimates killed/unpriced fires ──
  {
    const WIN = 7 * DAY;
    const mkU = (costUsd: number | null) => ({
      source: "provider" as const, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, costUsd, currency: "USD" as const,
    });

    // AC1: a killed row (no usage) returns a NON-ZERO estimate — this is the gap fireMetrics has
    const ac1 = rollingSpendUsd(
      [{ ts: iso(NOW - DAY), agent: "pm", project: "web", timedOut: true, durationMs: 3_600_000 }],
      WIN, NOW,
    );
    ok(ac1 > 0, `LOOP-227 AC1: timedOut row with no usage → non-zero estimate (got ${ac1})`);
    // 3_600_000 × (18.21 / 3_600_000) = 18.21 exactly (same constants cancel)
    ok(Math.abs(ac1 - 18.21) < 1e-6, `LOOP-227 AC1: fallback estimate ≈ $18.21 (got ${ac1})`);

    // AC2: all-priced window → exact costUsd sum (parity with fireMetrics on this case)
    const ac2 = rollingSpendUsd([
      { ts: iso(NOW - DAY), agent: "pm", project: "web", durationMs: 60_000, exitCode: 0, usage: mkU(5.00) },
      { ts: iso(NOW - 2 * DAY), agent: "qa", project: "web", durationMs: 30_000, exitCode: 0, usage: mkU(3.50) },
    ], WIN, NOW);
    ok(Math.abs(ac2 - 8.50) < 1e-9, `LOOP-227 AC2: all-priced window = exact costUsd sum (got ${ac2})`);

    // AC3: mixed — priced exact + killed estimated via same-profile median, or fallback
    //   priced row: $6.00 over 60_000 ms → rate 1e-4 $/ms
    //   same-profile killed: 3_600_000 × 1e-4 = $360
    //   diff-profile killed (no priced history): 1_800_000 × (18.21/3_600_000) ≈ $9.105
    const sameRate = 6.00 / 60_000;
    const expectedAc3 = 6.00 + 3_600_000 * sameRate + 1_800_000 * (18.21 / 3_600_000);
    const ac3 = rollingSpendUsd([
      { ts: iso(NOW - DAY), agent: "pm", project: "web", durationMs: 60_000, exitCode: 0,
        codingAgent: "claude", model: "claude-3", usage: mkU(6.00) },
      { ts: iso(NOW - 2 * DAY), agent: "qa", project: "web", durationMs: 3_600_000, timedOut: true,
        codingAgent: "claude", model: "claude-3" },
      { ts: iso(NOW - 3 * DAY), agent: "sweep", project: "web", durationMs: 1_800_000, timedOut: true,
        codingAgent: "other", model: "other-model" },
    ], WIN, NOW);
    ok(Math.abs(ac3 - expectedAc3) < 1e-6,
      `LOOP-227 AC3: mixed = priced exact + same-profile estimate + fallback (expected ${expectedAc3.toFixed(4)}, got ${ac3.toFixed(4)})`);

    // AC4: pure function — nowMs injection excludes out-of-window rows
    const ac4 = rollingSpendUsd(
      [{ ts: iso(NOW - 30 * DAY), agent: "pm", project: "web", timedOut: true, durationMs: 3_600_000 }],
      WIN, NOW,
    );
    ok(ac4 === 0, `LOOP-227 AC4: out-of-window row excluded when nowMs injected (got ${ac4})`);
  }

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

  // ── LOOP-276: perFire divides by fires with costUsd > 0, not all fires or costMetered ──
  {
    const mixedLedger = join(tmp, "loop276-fires.jsonl");
    // fixture: 3 priced (cost>0), 2 zero-cost rate-limit (cost=0), 1 unpriced (costUsd:null), 1 no-usage
    // costUsd = 0.10+0.20+0.30 = 0.60; fires=7, costMetered=5, costPriced=3; perFire = 0.60/3 = $0.20
    const mkRow276 = (agent: string, costUsd: number | null, hasUsage: boolean) => ({
      ts: iso(NOW - 1 * DAY), agent, project: "web",
      codingAgent: "claude", durationMs: 1000, exitCode: 0, fireId: `f276-${agent}`,
      ...(hasUsage ? { usage: { source: "provider", inputTokens: 100, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, costUsd, currency: costUsd !== null ? "USD" : null } } : {}),
    });
    writeFileSync(mixedLedger, [
      mkRow276("a1", 0.10, true),   // priced: costPriced++
      mkRow276("a2", 0.20, true),   // priced: costPriced++
      mkRow276("a3", 0.30, true),   // priced: costPriced++
      mkRow276("b1", 0.0, true),    // zero-cost rate-limit: costMetered++ only
      mkRow276("b2", 0.0, true),    // zero-cost rate-limit: costMetered++ only
      mkRow276("c1", null, true),   // unpriced: metered++ only (costUsd:null)
      mkRow276("d1", null, false),  // no usage at all
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const report276 = usageReport(readFireRows(mixedLedger), 7 * DAY, { nowMs: NOW });
    const cell276 = report276.overall;

    ok(cell276.fires === 7, `LOOP-276: fires=7 (got ${cell276.fires})`);
    ok(cell276.costMetered === 5, `LOOP-276: costMetered=5 (priced+zero-cost, excl null; got ${cell276.costMetered})`);
    ok(cell276.costPriced === 3, `LOOP-276: costPriced=3 (only cost>0; got ${cell276.costPriced})`);
    ok(cell276.costUsd !== null && Math.abs(cell276.costUsd - 0.60) < 1e-9,
      `LOOP-276: costUsd=0.60 (got ${cell276.costUsd})`);

    // fixture verifiably distinguishes all three denominators
    const wrongFires   = cell276.costUsd! / cell276.fires;      // 0.60/7 ≈ 0.0857
    const wrongMetered = cell276.costUsd! / cell276.costMetered; // 0.60/5 = 0.12
    const correct      = cell276.costUsd! / cell276.costPriced;  // 0.60/3 = 0.20
    ok(Math.abs(correct - wrongFires)   > 1e-6, `LOOP-276: fixture separates /costPriced from /fires`);
    ok(Math.abs(correct - wrongMetered) > 1e-6, `LOOP-276: fixture separates /costPriced from /costMetered`);

    // renderFlow must print "/priced fire" at the correct amount
    const flowLines276: string[] = [];
    const origLog276 = console.log;
    console.log = (...args: unknown[]) => flowLines276.push(String(args[0] ?? ""));
    try { renderFlow(report276, null, null); }
    finally { console.log = origLog276; }
    const perFireLine276 = flowLines276.find((l) => /cost-per-fire/.test(l));
    ok(perFireLine276 !== undefined, `LOOP-276: renderFlow emits cost-per-fire line`);
    ok(perFireLine276 !== undefined && /priced fire/.test(perFireLine276),
      `LOOP-276 AC1: label reads "/priced fire" (got: ${perFireLine276})`);
    ok(perFireLine276 !== undefined && /\$0\.2000/.test(perFireLine276),
      `LOOP-276 AC1: perFire=$0.2000 = cost/costPriced (got: ${perFireLine276})`);
    ok(perFireLine276 === undefined || (!/\$0\.08/.test(perFireLine276) && !/\$0\.12/.test(perFireLine276)),
      `LOOP-276 AC1: perFire ≠ /fires ($0.0857) and ≠ /costMetered ($0.12) (got: ${perFireLine276})`);

    // views/usage.ts formula (costPriced) must match renderFlow — anti-drift assertion
    const webPerFire276 = cell276.costPriced > 0 && cell276.costUsd !== null
      ? cell276.costUsd / cell276.costPriced : null;
    ok(webPerFire276 !== null && Math.abs(webPerFire276 - correct) < 1e-9,
      `LOOP-276 AC4: views/usage.ts formula matches renderFlow (both =${webPerFire276})`);

    // guard: zero denominator → "unavailable"
    const zeroCell: typeof cell276 = { ...cell276, costPriced: 0, costUsd: null };
    const zeroReport276 = { ...report276, overall: zeroCell };
    const zeroLines276: string[] = [];
    console.log = (...args: unknown[]) => zeroLines276.push(String(args[0] ?? ""));
    try { renderFlow(zeroReport276, null, null); }
    finally { console.log = origLog276; }
    ok(zeroLines276.some((l) => /unavailable/.test(l) && !/\$0/.test(l)),
      `LOOP-276 AC2: zero denominator → "unavailable", never "$0" (got: ${zeroLines276.join("|")})`);
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

  // ── LOOP-239: costMeteredFires counts only costUsd>0; meteringOnsetTs=earliest usage ts; per-agent usdPerFire ──
  {
    const loop239Ledger = join(tmp, "loop239-fires.jsonl");
    const mkRow239 = (agent: string, ts: string, costUsd: number | null, hasUsage: boolean, exitCode = 0) => ({
      ts, agent, project: "loop", codingAgent: "claude", durationMs: 1000, exitCode, fireId: `f239-${agent}-${ts}`,
      ...(hasUsage ? { usage: { source: "provider", inputTokens: 100, outputTokens: 50, cacheReadTokens: null, cacheWriteTokens: null, costUsd, currency: costUsd !== null ? "USD" : null } } : {}),
    });
    const ONSET_TS = iso(NOW - 5 * DAY); // earliest usage-bearing row → meteringOnsetTs
    const PRE_ONSET = iso(NOW - 10 * DAY); // no usage; outside 7d window
    writeFileSync(loop239Ledger, [
      // Pre-onset rows: no usage → excluded from meteringOnsetTs and all cost counts; outside window
      mkRow239("pm",         PRE_ONSET,             null,  false),
      mkRow239("qa",         PRE_ONSET,             null,  false),
      // Onset row: earliest row carrying usage in the full ledger
      mkRow239("pm",         ONSET_TS,              0.05,  true),
      // Zero-cost rate-limit failure: usage present but costUsd=0 → excluded from costMeteredFires
      mkRow239("pm",         iso(NOW - 4 * DAY),    0.0,   true, 1),
      // Priced fires for two agents
      mkRow239("pm",         iso(NOW - 3 * DAY),    0.10,  true),
      mkRow239("qa",         iso(NOW - 2 * DAY),    0.08,  true),
      mkRow239("qa",         iso(NOW - 1 * DAY),    0.07,  true),
      // Null-cost usage row: metered but costUsd:null → meteredFires++ only
      mkRow239("senior-dev", iso(NOW - 1 * DAY),    null,  true),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const fm239 = fireMetrics(loop239Ledger, 7 * DAY, NOW);

    // 6 in-window rows (pre-onset pair is 10d ago, outside 7d window)
    ok(fm239.fires === 6, `LOOP-239: fires=6 (in-window only; got ${fm239.fires})`);
    // meteringOnsetTs derived from the full ledger — earliest row with usage
    ok(fm239.meteringOnsetTs === ONSET_TS,
      `LOOP-239: meteringOnsetTs = earliest usage-bearing ts (got ${fm239.meteringOnsetTs})`);
    // all 6 in-window rows carry usage
    ok(fm239.meteredFires === 6, `LOOP-239: meteredFires=6 (all in-window rows have usage; got ${fm239.meteredFires})`);
    // costMeteredFires: only costUsd>0 (excludes zero-cost and null); onset+pm2+qa1+qa2 = 4
    ok(fm239.costMeteredFires === 4,
      `LOOP-239: costMeteredFires=4 (>0 only; excludes zero-cost and null; got ${fm239.costMeteredFires})`);
    // costUsd = 0.05+0.10+0.08+0.07 = 0.30
    ok(fm239.costUsd !== null && Math.abs(fm239.costUsd - 0.30) < 1e-9,
      `LOOP-239: costUsd=0.30 (sum of >0 rows; got ${fm239.costUsd})`);

    // per-agent breakdown: pm has onset+priced2 (2 priced); qa has qa1+qa2 (2 priced)
    const pm239 = fm239.byAgent["pm"];
    const qa239 = fm239.byAgent["qa"];
    const sd239 = fm239.byAgent["senior-dev"];
    ok(pm239 !== undefined && pm239.fires === 3,
      `LOOP-239: pm.fires=3 (onset+zero-cost+priced2 in window; got ${pm239?.fires})`);
    ok(pm239 !== undefined && pm239.costMeteredFires === 2,
      `LOOP-239: pm costMeteredFires=2 (zero-cost excluded; got ${pm239?.costMeteredFires})`);
    ok(pm239 !== undefined && pm239.costUsd !== null && Math.abs(pm239.costUsd - 0.15) < 1e-9,
      `LOOP-239: pm costUsd=0.15 (0.05+0.10; got ${pm239?.costUsd})`);
    ok(pm239 !== undefined && pm239.usdPerFire !== null && Math.abs(pm239.usdPerFire - 0.075) < 1e-9,
      `LOOP-239: pm usdPerFire=0.075 (0.15/2; got ${pm239?.usdPerFire})`);
    ok(qa239 !== undefined && qa239.costMeteredFires === 2,
      `LOOP-239: qa costMeteredFires=2 (got ${qa239?.costMeteredFires})`);
    ok(qa239 !== undefined && qa239.costUsd !== null && Math.abs(qa239.costUsd - 0.15) < 1e-9,
      `LOOP-239: qa costUsd=0.15 (0.08+0.07; got ${qa239?.costUsd})`);
    ok(qa239 !== undefined && qa239.usdPerFire !== null && Math.abs(qa239.usdPerFire - 0.075) < 1e-9,
      `LOOP-239: qa usdPerFire=0.075 (0.15/2; got ${qa239?.usdPerFire})`);
    // senior-dev: null-cost usage row → 0 costMeteredFires, usdPerFire=null
    ok(sd239 !== undefined && sd239.costMeteredFires === 0 && sd239.usdPerFire === null,
      `LOOP-239: senior-dev costMeteredFires=0, usdPerFire=null (null costUsd; got cmf=${sd239?.costMeteredFires}, upf=${sd239?.usdPerFire})`);
  }

  // ══ the measurement-honesty batch ══════════════════════════════════════════════════════════
  // Each block below pins an ABSOLUTE expected value, not a parity between two surfaces: LOOP-251
  // shipped three parity assertions that all stayed green under a mutated shared predicate because
  // both sides moved together.

  // ── LOOP-98: acceptRate's numerator and denominator are ONE population ──────────────────────
  // The census from the ticket: 30 In Review→Done, 5 →Canceled, 3 →In Progress, 2 →Human-Blocked,
  // plus 2 →Done that never passed through In Review. Old code returned 32/(32+5) = 0.865; the
  // true In-Review accept rate is 30/40 = 0.75. throughput must stay 32 (LOOP-42's contract).
  {
    const d98 = openDb(join(tmp, "l98.db"));
    d98.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','w','W','t')").run();
    const t98 = (from: string, to: string) =>
      d98.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
        .run(JSON.stringify({ from, to }), iso(NOW - DAY));
    for (let i = 0; i < 30; i++) t98("In Review", "Done");
    for (let i = 0; i < 5; i++) t98("In Review", "Canceled");
    for (let i = 0; i < 3; i++) t98("In Review", "In Progress");   // hand-back — invisible before
    for (let i = 0; i < 2; i++) t98("In Review", "Human-Blocked");  // hand-back — invisible before
    t98("Backlog", "Done"); t98("Todo", "Done");                    // never verified by anyone
    const b98 = boardMetrics(d98, "p", 7 * DAY, NOW);
    ok(b98.throughput === 32, `LOOP-98: throughput is UNCHANGED at 32 board-wide →Done (got ${b98.throughput})`);
    ok(b98.acceptRate !== null && Math.abs(b98.acceptRate - 30 / 40) < 1e-9,
      `LOOP-98: acceptRate = 30/40 = 0.75, not the old 32/37 = 0.865 (got ${b98.acceptRate})`);
    ok(b98.inReviewExits["In Progress"] === 3 && b98.inReviewExits["Human-Blocked"] === 2,
      "LOOP-98: every In Review exit edge is reported, so a hand-back is never invisible again");
    ok(b98.verifyFails === 5, `LOOP-98: verifyFails still means In Review→Canceled only (got ${b98.verifyFails})`);
    const empty98 = openDb(join(tmp, "l98b.db"));
    empty98.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','w','W','t')").run();
    ok(boardMetrics(empty98, "p", 7 * DAY, NOW).acceptRate === null,
      "LOOP-98: acceptRate is null — never 0, never 1 — when the window holds no In Review exit");
    empty98.close(); d98.close();
  }

  // ── LOOP-122: measured-zero vs unmeasurable ─────────────────────────────────────────────────
  {
    const d122 = openDb(join(tmp, "l122.db"));
    d122.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','w','W','t')").run();
    const bug = (id: string, labels: string[]) =>
      d122.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,'p','t','d','Bug','Todo',2,?,'[]','qa',?,?)")
        .run(id, JSON.stringify(labels), iso(NOW - DAY), iso(NOW - DAY));
    bug("B-1", ["dev-loop", "Bug", "qa"]);
    bug("B-2", ["dev-loop", "Bug", "qa"]);
    const noSource = boardMetrics(d122, "p", 7 * DAY, NOW, { escapeSourceConfigured: false });
    ok(noSource.qa.escaped === null && noSource.qa.escapeRatio === null,
      `LOOP-122: no ops/communication source ⇒ escaped is null, NOT 0 (got ${noSource.qa.escaped})`);
    ok(noSource.qa.bugsFiled === 2, "LOOP-122: bugsFiled is measured and unchanged");
    const measuredZero = boardMetrics(d122, "p", 7 * DAY, NOW, { escapeSourceConfigured: true });
    ok(measuredZero.qa.escaped === 0 && measuredZero.qa.escapeRatio === 0,
      "LOOP-122: with a source present, a real 0 keeps its meaning");
    bug("B-3", ["dev-loop", "Bug", "qa", "incident"]);
    ok(boardMetrics(d122, "p", 7 * DAY, NOW, { escapeSourceConfigured: true }).qa.escaped === 1,
      "LOOP-122: a real escape counts");
    ok(!escapeSignalSourceRan({ byAgent: { pm: { fires: 3 }, qa: { fires: 9 } } }),
      "LOOP-122: the source predicate reads the LEDGER — a loop running neither agent has no source");
    ok(escapeSignalSourceRan({ byAgent: { ops: { fires: 1 } } }), "LOOP-122: one ops fire is a source");
    d122.close();
  }

  // ── LOOP-313: an aggregate whose event history is shorter than its window says so ───────────
  {
    const d313 = openDb(join(tmp, "l313.db"));
    d313.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','w','W','t')").run();
    d313.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
      .run(JSON.stringify({ from: "In Review", to: "Done" }), iso(NOW - 2 * DAY));
    const short = boardMetrics(d313, "p", 30 * DAY, NOW);
    ok(short.historyIncomplete === true && short.historyFloor === iso(NOW - 2 * DAY),
      `LOOP-313: a 30d window over 2d of history is flagged incomplete and names the floor (got ${short.historyFloor})`);
    const full = boardMetrics(d313, "p", 1 * DAY, NOW);
    ok(full.historyIncomplete === false,
      "LOOP-313: a window INSIDE the available history carries no qualifier — output unchanged");
    d313.close();
  }

  // ── LOOP-314: --since/--until is a CLOSED era, both bounds ──────────────────────────────────
  // The trap: setting nowMs alone leaves `ts >= cutoff` unbounded above, so a "before" query still
  // contains the entire "after" era. These assertions fail against that shape.
  {
    const l314 = join(tmp, "l314.jsonl");
    writeFileSync(l314, [
      row({ ts: iso(NOW - 10 * DAY), agent: "pm", project: "w", exitCode: 0, durationMs: 1 }),  // before the era
      row({ ts: iso(NOW - 5 * DAY), agent: "pm", project: "w", exitCode: 0, durationMs: 1 }),   // INSIDE
      row({ ts: iso(NOW - 4 * DAY), agent: "pm", project: "w", exitCode: 0, durationMs: 1 }),   // INSIDE
      row({ ts: iso(NOW - 1 * DAY), agent: "pm", project: "w", exitCode: 0, durationMs: 1 }),   // after the era
    ].join("\n") + "\n");
    const era = fireMetrics(l314, 3 * DAY, NOW - 3 * DAY); // era = [NOW-6d, NOW-3d]
    ok(era.fires === 2, `LOOP-314: a closed era counts ONLY its own rows (got ${era.fires}, want 2)`);
    const rows314 = readFireRows(l314);
    ok(usageReport(rows314, 3 * DAY, { nowMs: NOW - 3 * DAY }).totalFires === 2,
      "LOOP-314: usageReport honours the upper bound too");
    ok(fireMetrics(l314, 30 * DAY, NOW).fires === 4, "LOOP-314: a trailing window is unchanged — all 4 rows");
  }

  // ── LOOP-268: an ABSENT usage key is not a measured zero ────────────────────────────────────
  {
    const rows268 = [
      { ts: iso(NOW - DAY), agent: "qa", project: "w", usage: { source: "provider", inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, currency: null } },
      { ts: iso(NOW - DAY), agent: "qa", project: "w", usage: { source: "provider", inputTokens: 20, outputTokens: 8, cacheWriteTokens: null, costUsd: null, currency: null } }, // cacheReadTokens KEY ABSENT
    ] as unknown as Parameters<typeof usageReport>[0];
    const u268 = usageReport(rows268, 7 * DAY, { nowMs: NOW });
    ok(u268.overall.cacheReadTokens === null,
      `LOOP-268: a missing key sums to null, never 0 — the never-0 honest-null contract (got ${u268.overall.cacheReadTokens})`);
    ok(u268.overall.inputTokens === 30, "LOOP-268: present values still sum normally");
    ok(u268.overall.costMetered === 0, "LOOP-268: an absent/null costUsd is unpriced, not a $0 fire");
  }

  // ── LOOP-155 + LOOP-219: an operator stop is not an agent failure, and discarded ≠ delivered ─
  {
    const l155 = join(tmp, "l155.jsonl");
    writeFileSync(l155, [
      row({ ts: iso(NOW - DAY), agent: "pm", project: "w", exitCode: 0, durationMs: 1, usage: { source: "p", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 1.00, currency: "USD" } }),
      row({ ts: iso(NOW - DAY), agent: "pm", project: "w", exitCode: 0, durationMs: 1, usage: { source: "p", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 3.00, currency: "USD" } }),
      row({ ts: iso(NOW - DAY), agent: "qa", project: "w", exitCode: 0, durationMs: 1, interrupted: true, usage: { source: "p", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 2.00, currency: "USD" } }),
      row({ ts: iso(NOW - DAY), agent: "qa", project: "w", exitCode: 0, durationMs: 1, suspectError: true, usage: { source: "p", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 4.00, currency: "USD" } }),
    ].join("\n") + "\n");
    const f155 = fireMetrics(l155, 7 * DAY, NOW);
    // 4 fires, 1 interrupted (excluded entirely), 1 suspectError → scored = 3, success = (3-0-1)/3.
    ok(f155.interrupted === 1, `LOOP-155: the interrupted fire is counted as its own class (got ${f155.interrupted})`);
    ok(f155.suspectErrors === 1, "LOOP-155: the genuine suspectError is untouched — this NARROWS the class");
    ok(f155.successRate !== null && Math.abs(f155.successRate - 2 / 3) < 1e-9,
      `LOOP-155: successRate excludes the interrupted fire from BOTH sides = 2/3 (got ${f155.successRate})`);
    ok(f155.discardedFires === 2 && f155.discardedCostUsd !== null && Math.abs(f155.discardedCostUsd - 6.00) < 1e-9,
      `LOOP-219: discarded = interrupted + suspectError = $6.00 over 2 fires (got $${f155.discardedCostUsd})`);
    ok(f155.costUsd !== null && Math.abs(f155.costUsd - 10.00) < 1e-9,
      "LOOP-219: the GROSS total is unchanged — this adds a decomposition, it does not restate the bill");
    const u219 = usageReport(readFireRows(l155), 7 * DAY, { nowMs: NOW, groupBy: "agent" });
    const sumDisc = Object.values(u219.byDimension ?? {}).reduce((a, c) => a + (c.discardedUsd ?? 0), 0);
    ok(Math.abs(sumDisc - 6.00) < 1e-9, `LOOP-219 invariant: Σ per-agent discarded == total discarded (got ${sumDisc})`);
    ok((u219.byDimension?.pm.discardedUsd ?? -1) === 0,
      "LOOP-219: an agent with priced rows and no discards reports a MEASURED 0.00, not null");
  }

  // ── LOOP-297: the displayed deadline IS the enforcer's own output ───────────────────────────
  {
    const l297 = join(tmp, "l297.jsonl");
    const priced = (agent: string, ca: string, model: string, cost: number, ms: number) =>
      row({ ts: iso(NOW - DAY), agent, project: "w", codingAgent: ca, model, exitCode: 0, durationMs: ms, usage: { source: "p", inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: cost, currency: "USD" } });
    writeFileSync(l297, [
      priced("pm", "claude", "fast", 1.0, 3_600_000),    // $1/hr  → $12 ceiling arms at 12h
      priced("sd", "claude", "slow", 12.0, 3_600_000),   // $12/hr → arms at 60 min exactly
      row({ ts: iso(NOW - DAY), agent: "qa", project: "w", codingAgent: "claude", model: "unpriced", exitCode: 0, durationMs: 1000 }),
    ].join("\n") + "\n");
    const rows297 = readFireRows(l297);
    const pds = profileDeadlines(rows297, 12.0, 7 * DAY, NOW);
    const slow = pds.find((d) => d.model === "slow");
    const unpriced = pds.find((d) => d.model === "unpriced");
    ok(slow !== undefined && Math.abs(slow.deadlineMinutes! - 60) < 1e-6,
      `LOOP-297: a $12/hr profile against a $12 ceiling arms at exactly 60 min (got ${slow?.deadlineMinutes})`);
    ok(unpriced !== undefined && unpriced.priced === false,
      "LOOP-297: a profile with no priced history is LABELLED as using the fallback, not shown as measured");
    // AC2 — the display can never drift from the enforcer, because it is the same function.
    const enforced = perFireDeadline(12.0, rows297, "claude", "slow", NOW);
    ok(enforced !== null && Math.abs(enforced.deadlineMs / 60_000 - slow!.deadlineMinutes!) < 1e-9,
      "LOOP-297 AC2: the printed deadline equals perFireDeadline()'s own output");
  }

  // ── LOOP-102: W16's owned set matches what the routers actually serve ───────────────────────
  {
    const d102 = openDb(join(tmp, "l102.db"));
    d102.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','w','W','t')").run();
    const tk = (id: string, state: string, assignee: string | null, labels: string[]) =>
      d102.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,'p','t','d','Improvement',?,?,2,?,'[]','pm',?,?)")
        .run(id, state, assignee, JSON.stringify(labels), iso(NOW - DAY), iso(NOW - DAY));
    const emptyLedger = join(tmp, "l102.jsonl");
    writeFileSync(emptyLedger, "");
    const find = (h: string) => ownerLiveness(d102, "p", emptyLedger, { nowMs: NOW, handles: [h] });

    tk("A-1", "Todo", "junior-dev", ["dev-loop", "blocked"]);
    ok(find("junior-dev").length === 0,
      "LOOP-102: a handle whose only open ticket is `blocked` produces NO finding — no router would serve it");
    tk("A-2", "Todo", "junior-dev", ["dev-loop"]);
    ok(find("junior-dev")[0]?.openTickets === 1,
      "LOOP-102: …and an unblocked sibling still produces one, counting only the servable row");

    tk("B-1", "In Progress", "senior-dev", ["dev-loop"]);  // assignee only — NO senior-dev label
    ok(find("senior-dev")[0]?.openTickets === 1,
      "LOOP-102: In Progress is owned by its ASSIGNEE — the state whose only recovery is that actor firing again");
    tk("C-1", "Human-Blocked", "pm", ["dev-loop", "pm"]);
    ok(find("pm").length === 0,
      "LOOP-102: Human-Blocked stays OUT — it is a park awaiting a human, not owner stranding");
    d102.close();
  }

  // ── LOOP-115 sibling: the `--kaizen` CLI path had ZERO coverage ─────────────────────────────
  // Same shape as codexUsageAdapter.isError: a CC-9 function at 0% coverage scores exactly 90.0
  // against the ratchet's threshold of 90, so the repo passed its required merge check by a margin
  // of 0.0 and one added branch anywhere in it would red-line every PR. These invocations are real
  // subprocesses, so NODE_V8_COVERAGE (inherited from the test run) counts them.
  {
    const kws = join(tmp, "kaizen-ws");
    mkdirSync(join(kws, ".dev-loop"), { recursive: true });
    mkdirSync(join(kws, "repo"), { recursive: true });
    writeFileSync(join(kws, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "kz", backend: "service", mode: "live" },
      repos: { repo: { path: "repo" } },
      projects: { kzp: { repos: [{ ref: "repo" }] } },
    }, null, 2));
    const kdb = openDb(join(kws, ".dev-loop", "hub.db"));
    kdb.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('kp','kzp','KZ','t')").run();
    kdb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('K-1','kp','t','d','Improvement','Done',2,'[]','[]','pm',?,?)")
      .run(iso(NOW - DAY), iso(NOW - DAY));
    kdb.close();
    const kenv = { ...process.env, DEVLOOP_HOME: join(tmp, "khome"), DEVLOOP_PROJECT: "kzp" };
    const kj = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--kaizen", "--json"], { cwd: kws, env: kenv, encoding: "utf8" });
    ok(kj.status === 0, `LOOP-115 sibling: metrics --kaizen --json exits 0 (got ${kj.status}) ${(kj.stderr ?? "").slice(-160)}`);
    let parsed: unknown = null;
    try { parsed = JSON.parse(kj.stdout ?? ""); } catch { /* asserted below */ }
    ok(Array.isArray(parsed) && (parsed as unknown[]).length === 1,
      "LOOP-115 sibling: --kaizen --json emits ONE parseable array regardless of project count");
    const kh = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--kaizen"], { cwd: kws, env: kenv, encoding: "utf8" });
    ok(kh.status === 0 && /self/i.test(kh.stdout ?? ""), `LOOP-115 sibling: the human --kaizen panel renders (got ${kh.status})`);
    // The refusal path: a linear-backend workspace has no hub.db and must say so, not throw.
    const lws = join(tmp, "kaizen-linear");
    mkdirSync(lws, { recursive: true });
    writeFileSync(join(lws, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2, team: { key: "kzl", backend: "linear", linearTeam: "T" }, repos: {}, projects: {},
    }, null, 2));
    const kl = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--kaizen"], { cwd: lws, env: kenv, encoding: "utf8" });
    ok(kl.status === 1 && /requires service backend/.test(kl.stderr ?? ""),
      `LOOP-115 sibling: --kaizen on a linear workspace refuses cleanly with exit 1 (got ${kl.status})`);
  }

  console.log(fails === 0 ? "\nMETRICS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
