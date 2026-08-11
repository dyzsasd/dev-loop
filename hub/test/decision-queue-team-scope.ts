// LOOP-534 — the `_team` board is inside the operator's decision-queue surfaces.
//
// The defect: both consumers of the queue (`metrics --json` → `.decisionQueue`, and doctor's W20)
// iterated `deliveryProjects(ws)`, which drops `_team` at the seam. Four of the ten agents fire at
// `_team` scope, so a steward's approval request and a §9b team intake PM parks there were both
// accepted, stored — and reached no operator surface. The board reported healthy while holding items.
//
// What makes this testable at all: the scope lives in the CALLERS, not in `decisionQueue(db, pid)`,
// which takes one already-resolved project id and so cannot observe the project set. So the suite
// drives the two callers directly against a fixture workspace + fixture hub.db, in-process — never a
// CLI spawn, which would inherit the fire's env markers (LOOP-193) and the operator's live board.
//
// Mutation-checked (AC7). Restoring `deliveryProjects` at either call site fails that call site's
// assertions specifically; implementing the fix by widening `deliveryProjects` itself fails AC5.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { collectBoardMetrics, type DecisionItem } from "../src/metrics.ts";
import { checkDecisionQueueStall } from "../src/doctor.ts";
import { requestApproval } from "../src/approvals.ts";
import { deliveryProjects, decisionQueueProjects, type Workspace } from "../src/team-config.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = mkdtempSync(join(tmpdir(), "dl-dq-team-"));
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-11T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const KEY = "npm-publish:@dyzsasd/dev-loop:1.15.2";

// The fixture workspace has the shape this ticket describes: one delivery project, one SCRATCH
// project, and NO `_team` entry — E11 rejects `_team` from dev-loop.json.projects, so a fixture that
// carried one could not exist on a real workspace and would prove nothing about this bug.
const ws = {
  file: {
    team: { key: "loop", backend: "service", mode: "live", comms: { provider: "lark", webhookEnv: "X" } },
    repos: {},
    projects: { loop: {}, fixture: { scratch: true } },
  },
  root: tmp,
} as unknown as Workspace;

const dbPath = join(tmp, "hub.db");
function seed() {
  const db = openDb(dbPath);
  const proj = (id: string, key: string) =>
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,'t')").run(id, key, key);
  // All three boards exist as hub rows — `_team` is seeded by `team init` exactly like this.
  proj("p-loop", "loop"); proj("p-team", "_team"); proj("p-fix", "fixture");
  const ticket = (id: string, pid: string, title: string, state: string, assignee: string | null, at: string) =>
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'d','Feature',?,?,0,'[]','[]','pm',?,?)")
      .run(id, pid, title, state, assignee, at, at);
  // AC3, the ticket arm, on `_team`: both queue shapes — a §9b intake PM parked, and a board-approval
  // stop assigned to the operator. Aged oldest so a scope regression also moves WHICH item is "oldest".
  ticket("T-TEAM-1", "p-team", "team intake parked on the operator", "Human-Blocked", null, iso(NOW - 9 * DAY));
  ticket("T-TEAM-2", "p-team", "team design awaiting sign-off", "In Review", "operator", iso(NOW - 5 * DAY));
  ticket("T-TEAM-3", "p-team", "steward work in flight", "In Review", "sweep", iso(NOW - DAY)); // never the operator's
  ticket("T-LOOP-1", "p-loop", "delivery park", "Human-Blocked", null, iso(NOW - 2 * DAY));
  // The scratch board holds an item too. Nothing fires there, so this row cannot occur in the field —
  // it is here as the discriminator for AC6: if scratch were carried, this would show up.
  ticket("T-FIX-1", "p-fix", "scratch park", "Human-Blocked", null, iso(NOW - 30 * DAY));
  return db;
}

try {
  const db = seed();
  // AC1 — a pending approval request filed from a `_team` fire (`resolveScope` falls back to
  // DEVLOOP_PROJECT, which is `_team` for the stewards).
  const req = requestApproval(db, { projectId: "p-team", actionKey: KEY, requestedBy: "sweep", ticketId: "T-TEAM-1" });
  db.prepare("UPDATE approvals SET requested_at=? WHERE id=?").run(iso(NOW - 12 * DAY), req.id);
  db.close();

  // ── AC5 / AC6 — the two project sets, and the reason they differ ──────────────────────────────
  ok(JSON.stringify(deliveryProjects(ws)) === JSON.stringify(["loop"]),
    `AC5: deliveryProjects is UNCHANGED — the scheduling seam still returns just the delivery set (got ${JSON.stringify(deliveryProjects(ws))})`);
  ok(JSON.stringify(decisionQueueProjects(ws)) === JSON.stringify(["loop", "_team"]),
    `AC5: the decision-queue seam is a SECOND set — delivery + _team (got ${JSON.stringify(decisionQueueProjects(ws))})`);
  // AC6, decided explicitly: scratch/disabled stay OUT of both. No agent fires on them, so nothing can
  // enter their queue; carrying them would add permanently-empty boards to the operator's set.
  ok(!decisionQueueProjects(ws).includes("fixture"),
    "AC6: a scratch project is deliberately EXCLUDED — nothing fires there, so nothing can enter its queue");

  // ── AC1 + AC3 — the metrics arm ───────────────────────────────────────────────────────────────
  const out: Record<string, unknown> = {};
  await collectBoardMetrics(ws, 24 * 3_600_000, out, dbPath, true, NOW);
  const queue = (out.decisionQueue ?? []) as Array<DecisionItem & { project: string; enteredAt?: string }>;
  const ids = queue.map((q) => q.id);

  ok(ids.includes("T-TEAM-1") && ids.includes("T-TEAM-2"),
    `AC3: both _team ticket shapes reach .decisionQueue — Human-Blocked and In Review@operator (got ${JSON.stringify(ids)})`);
  const appr = queue.find((q) => q.kind === "approval");
  ok(appr !== undefined && appr.kind === "approval" && appr.actionKey === KEY,
    `AC1: the _team approval request reaches .decisionQueue with LOOP-393's kind:'approval' shape (got ${JSON.stringify(appr)})`);
  ok(appr?.project === "_team",
    `AC1: …carrying its own project, so the operator can tell which board to act on (got ${JSON.stringify(appr?.project)})`);
  ok(!ids.includes("T-TEAM-3"),
    "AC3: a _team ticket in In Review assigned to an AGENT is still not the operator's — widening the scope did not widen the predicate");
  ok(!ids.includes("T-FIX-1"),
    `AC6: the scratch board's item is absent from the queue, matching the documented decision (got ${JSON.stringify(ids)})`);
  ok(ids.includes("T-LOOP-1"),
    "AC1: the delivery project's own item is still there — the team scope is ADDITIVE, not a replacement");
  // The queue is sorted oldest-WAIT first across every board, so the _team request (12d) leads.
  ok(queue[0]?.kind === "approval" && queue[0]?.project === "_team",
    `AC1: cross-board ordering is by wait, so the oldest _team item leads the queue (got ${JSON.stringify(queue[0])})`);
  // …and the panels did NOT grow a `_team` entry: the queue's set and the board-KPI set stay separate.
  ok(!Object.hasOwn((out.board ?? {}) as object, "_team") && Object.hasOwn((out.board ?? {}) as object, "loop"),
    `AC5: _team gained a queue arm WITHOUT gaining a board panel or a teamRollup contribution (got ${JSON.stringify(Object.keys((out.board ?? {}) as object))})`);

  // ── AC2 — doctor's W20 ────────────────────────────────────────────────────────────────────────
  const warns: string[] = [];
  const db2 = openDb(dbPath);
  const ctx = {
    ws, opts: {}, boardDb: dbPath,
    out: { pass: () => {}, fail: () => {}, warn: (m: string) => warns.push(m), info: () => {} },
    openBoardDb: () => db2,
  } as never;
  const stall = checkDecisionQueueStall(ctx);
  ok(stall !== null, "AC2: W20 reports a stall rather than reading the board as healthy");
  ok(stall !== null && stall.count === queue.length,
    `AC2: W20 counts exactly what metrics renders — the two surfaces cannot disagree (W20 ${stall?.count} vs metrics ${queue.length})`);
  ok(stall?.oldest.id === req.id,
    `AC2: the oldest item it names is the _team approval request (got ${JSON.stringify(stall?.oldest)})`);
  ok(stall?.ruleOn?.includes(`dev-loop approve --request ${req.id}`) === true,
    `AC2: ruleOn stays describeDecisionOldest's grant verb, unchanged by the scope fix (got ${JSON.stringify(stall?.ruleOn)})`);
  ok(warns.some((w) => w.startsWith("[W20]") && w.includes(KEY)),
    `AC2: the W20 line names the _team request by its action key (got ${JSON.stringify(warns)})`);
  db2.close();

  // ── AC2, the failing-half control ─────────────────────────────────────────────────────────────
  // A board whose ONLY items are on `_team` is the exact case that read as empty before this fix. It
  // is asserted separately because the mixed board above would still produce a W20 line from its
  // delivery item alone — i.e. the mixed case cannot discriminate the bug.
  const onlyPath = join(tmp, "team-only.db");
  {
    const d = openDb(onlyPath);
    d.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p-loop','loop','loop','t')").run();
    d.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p-team','_team','_team','t')").run();
    d.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-ONLY','p-team','only item on the board','d','Feature','Human-Blocked',NULL,0,'[]','[]','pm',?,?)")
      .run(iso(NOW - 3 * DAY), iso(NOW - 3 * DAY));
    d.close();
  }
  const out2: Record<string, unknown> = {};
  await collectBoardMetrics(ws, 24 * 3_600_000, out2, onlyPath, true, NOW);
  ok(((out2.decisionQueue ?? []) as unknown[]).length === 1,
    `AC1 (discriminating case): a queue holding ONLY _team items is non-empty in metrics (got ${JSON.stringify(out2.decisionQueue)})`);
  const warns2: string[] = [];
  const d2 = openDb(onlyPath);
  const stall2 = checkDecisionQueueStall({
    ws, opts: {}, boardDb: onlyPath,
    out: { pass: () => {}, fail: () => {}, warn: (m: string) => warns2.push(m), info: () => {} },
    openBoardDb: () => d2,
  } as never);
  ok(stall2 !== null && stall2.count === 1 && stall2.oldest.id === "T-ONLY",
    `AC2 (discriminating case): …and W20 reports it instead of a clean bill of health (got ${JSON.stringify(stall2)})`);
  d2.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(fails === 0 ? "\nDQ_TEAM_SCOPE_OK" : `\n${fails} test(s) failed`);
process.exit(fails === 0 ? 0 : 1);
