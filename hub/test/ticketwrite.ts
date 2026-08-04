// LOOP-79 regression: sensitive re-tier gate must silently correct sensitive+junior-dev tickets
// to senior-dev (assignee + label swap) in BOTH insertTicket and updateTicketRow, and log
// issue.retier. Must be a strict no-op when sensitive label absent, junior-dev absent, or
// senior-dev actor not registered. Design: sensitive-routing §2 / LOOP-79 Child A.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { insertTicket, updateTicketRow, moveTicket, verifyCreateGateRejection } from "../src/ticketwrite.ts";
import type { NewTicketFields, TicketUpdateFields } from "../src/ticketwrite.ts";
import { agentOp, type OpResult } from "../src/agentops.ts"; // LOOP-183 Vector B: exercise the wired create path (opSaveIssue)
import { AGENT_HANDLES } from "../src/seed.ts"; // LOOP-208: drive the actor-coverage assertion from the REAL roster, so a future handle fails the test

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-ticketwrite-"));
try {
  // ── Fixture: hub.db with actors and a project ─────────────────────────────────
  const dbPath = join(ROOT, "hub.db");
  const db = openDb(dbPath);

  const actor = (handle: string, kind: "agent" | "human" = "agent"): void => {
    db.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)")
      .run(handle, handle, kind, handle, "2024-01-01T00:00:00Z");
  };
  // LOOP-208: seed the FULL agent roster from AGENT_HANDLES (plus the human operator) so the
  // actor-coverage assertions below can drive EVERY handle — including the five non-builder,
  // non-owner stewards (sweep/reflect/ops/architect/communication) that fell through the old gate —
  // through the write path. Deriving the fixture from the roster keeps it in lock-step with seed.ts.
  for (const h of AGENT_HANDLES) actor(h);
  actor("operator", "human");
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)")
    .run("p", "TW", "test", "2024-01-01T00:00:00Z");

  // Helper: read a ticket row back
  const row = (id: string): { assignee: string | null; labels: string } =>
    db.prepare("SELECT assignee, labels FROM tickets WHERE id=?").get(id) as { assignee: string | null; labels: string };

  // Helper: query issue.retier events for a ticket
  const retierEvents = (id: string): Array<{ data: string }> =>
    db.prepare("SELECT data FROM events WHERE ticket_id=? AND kind='issue.retier'").all(id) as Array<{ data: string }>;

  // Helper: minimal NewTicketFields
  const newFields = (override: Partial<NewTicketFields> = {}): NewTicketFields => ({
    title: "t", description: "", type: "Feature", state: "Todo",
    assignee: null, priority: 0, labels: [], duplicateOf: null, relatedTo: [],
    ...override,
  });

  // Helper: minimal TicketUpdateFields
  const updateFields = (override: Partial<TicketUpdateFields> = {}): TicketUpdateFields => ({
    title: "t", description: "", type: "Feature", state: "In Progress",
    assignee: null, priority: 0, labels: "[]", duplicate_of: null, related_to: "[]",
    ...override,
  });

  // ── insertTicket: sensitive + junior-dev → retier to senior-dev ───────────────
  const id1 = insertTicket(db, "p", "pm", newFields({ assignee: "junior-dev", labels: ["sensitive", "junior-dev"] }), {});
  const r1 = row(id1);
  ok(r1.assignee === "senior-dev", "insert: sensitive+junior-dev assignee → retiered to senior-dev");
  ok(JSON.parse(r1.labels).includes("senior-dev"), "insert: label junior-dev → senior-dev after retier");
  ok(!JSON.parse(r1.labels).includes("junior-dev"), "insert: junior-dev label removed after retier");
  ok(JSON.parse(r1.labels).includes("sensitive"), "insert: sensitive label preserved");
  const ev1 = retierEvents(id1);
  ok(ev1.length === 1, "insert: issue.retier event logged");
  const ev1Data = JSON.parse(ev1[0]!.data);
  ok(ev1Data.from === "junior-dev" && ev1Data.to === "senior-dev", "insert: retier event has correct from/to");
  ok(ev1Data.reason === "sensitive", "insert: retier event has reason=sensitive");

  // ── insertTicket: sensitive present but NOT junior-dev → no retier ─────────────
  const id2 = insertTicket(db, "p", "pm", newFields({ assignee: "senior-dev", labels: ["sensitive"] }), {});
  const r2 = row(id2);
  ok(r2.assignee === "senior-dev", "insert: sensitive+senior-dev → no retier (already senior)");
  ok(retierEvents(id2).length === 0, "insert: no issue.retier when not junior-dev");

  // ── insertTicket: junior-dev but NOT sensitive → no retier ────────────────────
  const id3 = insertTicket(db, "p", "pm", newFields({ assignee: "junior-dev", labels: ["junior-dev"] }), {});
  const r3 = row(id3);
  ok(r3.assignee === "junior-dev", "insert: junior-dev without sensitive → no retier");
  ok(retierEvents(id3).length === 0, "insert: no issue.retier when sensitive absent");

  // ── insertTicket: sensitive+junior-dev but no senior-dev actor → no retier ────
  // Create a separate DB without senior-dev to test the actorExists guard
  const db2 = openDb(join(ROOT, "hub2.db"));
  db2.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)").run("pm2", "pm", "human", "pm", "2024-01-01T00:00:00Z");
  db2.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)").run("jd2", "junior-dev", "agent", "jr", "2024-01-01T00:00:00Z");
  db2.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)").run("p2", "TW2", "test2", "2024-01-01T00:00:00Z");
  const id4 = insertTicket(db2, "p2", "pm", newFields({ assignee: "junior-dev", labels: ["sensitive", "junior-dev"] }), {});
  const r4 = db2.prepare("SELECT assignee, labels FROM tickets WHERE id=?").get(id4) as { assignee: string | null; labels: string };
  ok(r4.assignee === "junior-dev", "insert: sensitive+junior-dev but no senior-dev actor → no retier");
  ok((db2.prepare("SELECT data FROM events WHERE ticket_id=? AND kind='issue.retier'").all(id4) as unknown[]).length === 0, "insert: no retier event when senior-dev actor absent");
  db2.close();

  // ── insertTicket: assignee=null but junior-dev label present → retier ──────────
  const id5 = insertTicket(db, "p", "pm", newFields({ assignee: null, labels: ["sensitive", "junior-dev"] }), {});
  const r5 = row(id5);
  ok(r5.assignee === "senior-dev", "insert: null assignee + junior-dev label → retiered assignee to senior-dev");
  ok(retierEvents(id5).length === 1, "insert: issue.retier event logged for null assignee case");

  //
  // ── LOOP-223: tier restore — null-assignee Todo tickets get assignee from tier label ──
  //
  // Helper: query issue.restore events for a ticket
  const restoreEvents = (id: string): Array<{ data: string }> =>
    db.prepare("SELECT data FROM events WHERE ticket_id=? AND kind='issue.restore'").all(id) as Array<{ data: string }>;

  // AC1: Todo + null assignee + exactly one dev-tier label → restored from label
  const ac1Id = insertTicket(db, "p", "pm", newFields({ assignee: null, labels: ["junior-dev"] }), {});
  const ac1r = row(ac1Id);
  ok(ac1r.assignee === "junior-dev", "LOOP-223 AC1: insert Todo+null+junior-dev label → assignee restored from label");
  ok(JSON.parse(ac1r.labels).includes("junior-dev"), "LOOP-223 AC1: junior-dev label preserved after restore");
  const ac1ev = restoreEvents(ac1Id);
  ok(ac1ev.length === 1, "LOOP-223 AC1: issue.restore event logged");
  ok(JSON.parse(ac1ev[0].data).to === "junior-dev", "LOOP-223 AC1: restore event has to=junior-dev");

  // AC1: update path — seed a ticket, then update to Todo+null+junior-dev label
  const ac1uId = insertTicket(db, "p", "pm", newFields({ assignee: "junior-dev", labels: ["junior-dev"], state: "In Progress" }), {});
  const ac1u = updateTicketRow(db, "p", "junior-dev", ac1uId, "In Progress",
    updateFields({ state: "Todo", assignee: null, labels: JSON.stringify(["junior-dev"]) }));
  ok(ac1u.ok, "LOOP-223 AC1: update to Todo+null+junior-dev label succeeds");
  const ac1ur = row(ac1uId);
  ok(ac1ur.assignee === "junior-dev", "LOOP-223 AC1: update Todo assignee restored from label");
  const ac1uev = restoreEvents(ac1uId);
  ok(ac1uev.length === 1, "LOOP-223 AC1: update issue.restore event logged");

  // AC1: senior-dev label
  const ac1sId = insertTicket(db, "p", "pm", newFields({ assignee: null, labels: ["senior-dev"] }), {});
  ok(row(ac1sId).assignee === "senior-dev", "LOOP-223 AC1: insert Todo+null+senior-dev label → assignee restored to senior-dev");
  ok(restoreEvents(ac1sId).length === 1, "LOOP-223 AC1: senior-dev restore event logged");

  // AC1: null assignee with no dev-tier labels (pm-owned tracker) → pass through, NOT restored, NOT rejected
  const ac1pId = insertTicket(db, "p", "pm", newFields({ assignee: null, labels: ["pm"] }), {});
  ok(row(ac1pId).assignee === null, "LOOP-223 AC1: Todo+null+pm label (no dev tier) → assignee stays null");
  ok(restoreEvents(ac1pId).length === 0, "LOOP-223 AC1: no restore event for non-dev-tier ticket");

  // AC2 (amended): more than one dev-tier label → rejected with error message
  const ac2a = updateTicketRow(db, "p", "pm", ac1uId, "Todo",
    updateFields({ state: "Todo", assignee: null, labels: JSON.stringify(["junior-dev", "senior-dev"]) }));
  ok(!ac2a.ok, "LOOP-223 AC2: update Todo+null+junior-dev&senior-dev labels → REJECTED (ambiguous)");
  ok(!ac2a.ok && /junior-dev.*senior-dev/.test(ac2a.error), "LOOP-223 AC2: rejection names the conflicting labels");

  // AC2 (amended): zero dev-tier labels on Todo+null (pm/qa tracker shape → e.g. LOOP-277) → succeeds, assignee stays null
  const ac2z = updateTicketRow(db, "p", "pm", ac1uId, "Todo",
    updateFields({ state: "Todo", assignee: null, labels: JSON.stringify(["pm"]) }));
  ok(ac2z.ok, "LOOP-223 AC2: Todo+null+pm label (zero dev-tier) → succeeds (tracker shape unblocked)");
  ok(row(ac1uId).assignee === null, "LOOP-223 AC2: assignee stays null for zero-dev-tier tracker");

  // AC3: legacy (non-split) project — null assignee + Todo is servable by dev, so no restoration needed
  // Create a separate DB without split-dev actors, simulating a legacy project
  const db3 = openDb(join(ROOT, "hub3.db"));
  db3.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)").run("dev", "dev", "agent", "dev", "2024-01-01T00:00:00Z");
  db3.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)").run("pm3", "pm", "human", "pm", "2024-01-01T00:00:00Z");
  db3.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)").run("p3", "LG", "legacy", "2024-01-01T00:00:00Z");
  const ac3Id = insertTicket(db3, "p3", "pm3", newFields({ assignee: null, labels: [] }), {});
  const ac3r = db3.prepare("SELECT assignee FROM tickets WHERE id=?").get(ac3Id) as { assignee: string | null };
  ok(ac3r.assignee === null, "LOOP-223 AC3: legacy project — Todo+null+no tier labels → assignee stays null (legacy dev servability)");
  db3.close();

  // AC4: LOOP-175 reproduction — assign junior-dev, move to In Progress, then orphan-reset to Todo (clear assignee)
  const ac4Id = insertTicket(db, "p", "pm", newFields({ assignee: "junior-dev", labels: ["junior-dev"], state: "In Progress" }), {});
  const ac4Reset = updateTicketRow(db, "p", "junior-dev", ac4Id, "In Progress",
    updateFields({ state: "Todo", assignee: null, labels: JSON.stringify(["junior-dev"]) }));
  ok(ac4Reset.ok, "LOOP-223 AC4: orphan-reset (Todo+null+junior-dev) succeeds");
  // After the reset, the ticket must still be servable by junior-dev
  const { servableSlice } = await import("../src/servable.ts");
  const slice = servableSlice(db, "p", "junior-dev");
  const inSlice = slice.todo.find((t) => t.id === ac4Id);
  ok(!!inSlice, "LOOP-223 AC4: orphan-reset ticket is in junior-dev's servable todo slice");
  ok(inSlice?.assignee === "junior-dev", "LOOP-223 AC4: servable ticket has assignee=junior-dev");
  // ── updateTicketRow: sensitive + junior-dev → retier to senior-dev ─────────────
  // Seed a ticket first, then update with sensitive+junior-dev labels
  const idU = insertTicket(db, "p", "pm", newFields({ state: "In Progress" }), {});
  const upd = updateTicketRow(db, "p", "pm", idU, "In Progress",
    updateFields({ assignee: "junior-dev", labels: JSON.stringify(["sensitive", "junior-dev"]) }));
  ok(upd.ok, "update: updateTicketRow ok=true after retier");
  const rU = row(idU);
  ok(rU.assignee === "senior-dev", "update: sensitive+junior-dev assignee → retiered to senior-dev");
  ok(JSON.parse(rU.labels).includes("senior-dev"), "update: junior-dev label → senior-dev after retier");
  ok(!JSON.parse(rU.labels).includes("junior-dev"), "update: junior-dev label removed in update");
  ok(JSON.parse(rU.labels).includes("sensitive"), "update: sensitive label preserved in update");
  const evU = retierEvents(idU);
  ok(evU.length === 1, "update: issue.retier event logged");
  const evUData = JSON.parse(evU[0]!.data);
  ok(evUData.from === "junior-dev" && evUData.to === "senior-dev", "update: retier event from/to correct");

  // ── updateTicketRow: no sensitive → no retier ──────────────────────────────────
  const idU2 = insertTicket(db, "p", "pm", newFields({ state: "In Progress" }), {});
  updateTicketRow(db, "p", "pm", idU2, "In Progress",
    updateFields({ assignee: "junior-dev", labels: JSON.stringify(["junior-dev"]) }));
  const rU2 = row(idU2);
  ok(rU2.assignee === "junior-dev", "update: junior-dev without sensitive → no retier");
  ok(retierEvents(idU2).length === 0, "update: no retier event when sensitive absent");

  // ── updateTicketRow: retier happens BEFORE transition gates ───────────────────
  // An update that would trip verifyGate (In Progress → Done) still gets REJECTED even after retier
  const idU3 = insertTicket(db, "p", "pm", newFields({ state: "In Progress" }), {});
  const gateRes = updateTicketRow(db, "p", "pm", idU3, "In Progress",
    updateFields({ assignee: "junior-dev", labels: JSON.stringify(["sensitive", "junior-dev"]), state: "Done" }));
  ok(!gateRes.ok, "update: verify gate still fires even when retier would apply");
  ok(/verify gate/.test(gateRes.ok ? "" : gateRes.error), "update: error mentions verify gate");
  const rU3 = row(idU3);
  ok(rU3.assignee === null, "update: gate rejection writes nothing (row unchanged after gate trip)");

  //
  // ── LOOP-157: the two-hop self-accept — a builder tier cannot self-verify its own qa/pm-owned work ──────────

  // In Review → Done close when the acting actor is a dev tier AND the ticket carries a qa/pm verifier-owner label.
  const stateOf = (id: string): string =>
    (db.prepare("SELECT state FROM tickets WHERE id=?").get(id) as { state: string }).state;
  const QA_BUG = ["dev-loop", "Bug", "qa", "junior-dev"];

  // (a) junior-dev drives In Progress → In Review (the legal hand-off) …
  const idSA = insertTicket(db, "p", "junior-dev", newFields({ state: "In Progress", assignee: "junior-dev", labels: QA_BUG }), {});
  const saH1 = updateTicketRow(db, "p", "junior-dev", idSA, "In Progress",
    updateFields({ state: "In Review", assignee: "junior-dev", labels: JSON.stringify(QA_BUG) }));
  ok(saH1.ok, "LOOP-157: In Progress → In Review by the builder stays legal (the hand-off)");
  // … then In Review → Done by the SAME dev-tier builder → REJECTED (the two-hop self-accept)
  const saH2 = updateTicketRow(db, "p", "junior-dev", idSA, "In Review",
    updateFields({ state: "Done", assignee: "junior-dev", labels: JSON.stringify(QA_BUG) }));
  ok(!saH2.ok, "LOOP-157: In Review → Done by the dev-tier builder is REJECTED (no owner self-verify)");
  ok(/verify gate/.test(saH2.ok ? "" : saH2.error), "LOOP-157: the refusal names the verify gate");
  ok(!saH2.ok && /junior-dev/.test(saH2.error) && /qa/.test(saH2.error), "LOOP-157: the refusal names the actor + owner label (observability)");
  ok(stateOf(idSA) === "In Review", "LOOP-157: the rejected self-close did NOT move the ticket (rollback)");

  // (b) the qa OWNER (a DIFFERENT actor) closes In Review → Done → LEGAL — Job A's mechanism must not regress (AC3)
  const saOwner = updateTicketRow(db, "p", "qa", idSA, "In Review",
    updateFields({ state: "Done", assignee: "junior-dev", labels: JSON.stringify(QA_BUG) }));
  ok(saOwner.ok && stateOf(idSA) === "Done", "LOOP-157: In Review → Done by the qa verifier-owner (different actor) stays legal");

  // (c) no over-block — a dev tier's In Review → Done is legal when the ticket has NO qa/pm owner label (§9a self-verified)
  const idNoOwner = insertTicket(db, "p", "senior-dev", newFields({ state: "In Review", assignee: "senior-dev", labels: ["dev-loop"] }), {});
  const saNoOwner = updateTicketRow(db, "p", "senior-dev", idNoOwner, "In Review",
    updateFields({ state: "Done", assignee: "senior-dev", labels: JSON.stringify(["dev-loop"]) }));
  ok(saNoOwner.ok && stateOf(idNoOwner) === "Done", "LOOP-157: dev-tier In Review → Done stays legal with NO qa/pm owner label (no over-block)");

  // (d) operator carve-out — the operator may always close a verifier-owned ticket (parity with the terminal-exit gate)
  const idOp = insertTicket(db, "p", "junior-dev", newFields({ state: "In Review", assignee: "junior-dev", labels: QA_BUG }), {});
  const saOp = updateTicketRow(db, "p", "operator", idOp, "In Review",
    updateFields({ state: "Done", assignee: "junior-dev", labels: JSON.stringify(QA_BUG) }));
  ok(saOp.ok && stateOf(idOp) === "Done", "LOOP-157: operator In Review → Done on a verifier-owned ticket stays legal (carve-out)");

  // ── LOOP-183 Vector A: dropping the qa/pm owner label in the CLOSING write must not unlock the self-close ──────
  // The gate now keys on the STORED owner labels ∪ the incoming set, not next.labels alone. A dev tier that
  // REPLACE-merges a label set omitting the ticket's qa owner label in the SAME In Review → Done write is still
  // rejected (previously owners.length === 0 on next.labels → the gate passed → the builder self-closed).
  const idVA = insertTicket(db, "p", "junior-dev", newFields({ state: "In Review", assignee: "junior-dev", labels: QA_BUG }), {});
  const vaDrop = updateTicketRow(db, "p", "junior-dev", idVA, "In Review",
    updateFields({ state: "Done", assignee: "junior-dev", labels: JSON.stringify(["dev-loop", "Bug", "junior-dev"]) })); // qa DROPPED
  ok(!vaDrop.ok, "LOOP-183 A: In Review → Done that DROPS the qa owner label is REJECTED (stored-label gate)");
  ok(/verify gate/.test(vaDrop.ok ? "" : vaDrop.error) && /qa/.test(vaDrop.ok ? "" : vaDrop.error), "LOOP-183 A: the refusal names the verify gate + the stored qa owner");
  ok(stateOf(idVA) === "In Review", "LOOP-183 A: the rejected label-strip close did NOT move the ticket (rollback)");

  // … clearing ALL labels in the closing write is likewise rejected (the stored set still owns it)
  const idVA2 = insertTicket(db, "p", "junior-dev", newFields({ state: "In Review", assignee: "junior-dev", labels: QA_BUG }), {});
  const vaClear = updateTicketRow(db, "p", "junior-dev", idVA2, "In Review",
    updateFields({ state: "Done", assignee: "junior-dev", labels: JSON.stringify([]) }));
  ok(!vaClear.ok && stateOf(idVA2) === "In Review", "LOOP-183 A: In Review → Done that CLEARS all labels is still REJECTED (stored qa owner)");

  // … regression guard on the legit path: the qa OWNER may still close AND drop its own label (not a dev tier → gate never fires)
  const idVA3 = insertTicket(db, "p", "junior-dev", newFields({ state: "In Review", assignee: "junior-dev", labels: QA_BUG }), {});
  const vaOwnerHygiene = updateTicketRow(db, "p", "qa", idVA3, "In Review",
    updateFields({ state: "Done", assignee: "junior-dev", labels: JSON.stringify(["dev-loop", "Bug"]) })); // qa owner drops qa while closing
  ok(vaOwnerHygiene.ok && stateOf(idVA3) === "Done", "LOOP-183 A: the qa OWNER closing + dropping labels stays legal (owner hygiene)");

  // ── LOOP-183 Vector B: create-as-Done — insertTicket runs no transition gate; the create path enforces the invariant ──
  // (i) the predicate: a builder tier may not create a qa/pm-owned ticket directly in Done; every legit carve-out passes.
  ok(verifyCreateGateRejection("junior-dev", "Done", ["dev-loop", "Bug", "qa"]) !== null, "LOOP-183 B: dev-tier create into Done on a qa-owned ticket is rejected");
  ok(verifyCreateGateRejection("senior-dev", "Done", ["dev-loop", "pm"]) !== null, "LOOP-183 B: dev-tier create into Done on a pm-owned ticket is rejected");
  ok(verifyCreateGateRejection("junior-dev", "Todo", ["dev-loop", "Bug", "qa"]) === null, "LOOP-183 B: Todo intake create with a qa label stays legal (§9a)");
  ok(verifyCreateGateRejection("junior-dev", "Backlog", ["pm"]) === null, "LOOP-183 B: Backlog intake create with a pm label stays legal (§9a)");
  ok(verifyCreateGateRejection("senior-dev", "Done", ["dev-loop"]) === null, "LOOP-183 B: dev-tier create into Done with NO owner label stays legal (non-owner create)");
  ok(verifyCreateGateRejection("qa", "Done", ["dev-loop", "Bug", "qa"]) === null, "LOOP-183 B: the qa OWNER may create a closed qa ticket (not a builder tier)");
  ok(verifyCreateGateRejection("operator", "Done", ["qa"]) === null, "LOOP-183 B: the operator may create a closed qa ticket (carve-out)");

  // (ii) the WIRING: the gate is enforced inside the save_issue create op (not just the predicate) — a dev-tier
  // create-as-Done is a 400 that writes NO row; the same qa-labelled create in Todo (legit intake) succeeds.
  const countP = (): number => (db.prepare("SELECT COUNT(*) c FROM tickets WHERE project_id='p'").get() as { c: number }).c;
  const beforeCount = countP();
  const vbWired = agentOp("save_issue", db, "p", "TW", "junior-dev",
    { title: "LOOP-183 vB create-as-Done reject", type: "Bug", state: "Done", labels: ["dev-loop", "Bug", "qa"] }) as OpResult;
  ok(vbWired.status === 400, "LOOP-183 B: opSaveIssue create-as-Done (dev tier, qa-owned) → 400 (wired, not just the predicate)");
  ok(/verify gate/.test(((vbWired.body as { error?: string })?.error) ?? ""), "LOOP-183 B: the wired refusal names the verify gate");
  ok(countP() === beforeCount, "LOOP-183 B: the rejected create wrote NO ticket row");
  const vbTodo = agentOp("save_issue", db, "p", "TW", "junior-dev",
    { title: "LOOP-183 vB todo intake ok", type: "Bug", state: "Todo", labels: ["dev-loop", "Bug", "qa"] }) as OpResult;
  ok(vbTodo.status === 200, "LOOP-183 B: the same qa-labelled create in Todo succeeds (intake unaffected)");

  // ── LOOP-208: actor coverage — the close/create gate keys on OWNERSHIP, not builder-tier ──────────
  // LOOP-157/183 keyed the gate on isDevTierActor ("is this a BUILDER?"). The roster has ten agents;
  // three are builders, two (qa/pm) are the verifier-owners, and the remaining five — sweep, reflect,
  // ops, architect, communication — are NEITHER, so they fell straight through the gate and could close
  // a qa/pm-owned ticket In Review → Done with rc=0. The gate now asks "is the actor this ticket's
  // verifier-owner?": refused for EVERY non-owner, non-operator actor. The assertions DRIVE from
  // AGENT_HANDLES itself, so adding a handle to the roster fails THIS test rather than the invariant.
  const QA_OWN = ["dev-loop", "Bug", "qa"];
  const PM_OWN = ["dev-loop", "Feature", "pm"];

  // (a) transition edge — a qa-owned In Review ticket is refused Done for every non-qa, non-operator
  // handle in the roster (a gate rejection writes nothing, so one fixture ticket serves the whole loop).
  const rosterQa = insertTicket(db, "p", "qa", newFields({ state: "In Review", type: "Bug", labels: QA_OWN }), {});
  for (const h of AGENT_HANDLES) {
    if (h === "qa") continue; // the owner's own close is asserted legal right after the loop
    const res = updateTicketRow(db, "p", h, rosterQa, "In Review",
      updateFields({ state: "Done", labels: JSON.stringify(QA_OWN) }));
    ok(!res.ok, `LOOP-208: In Review → Done on a qa-owned ticket is REFUSED for non-owner handle '${h}'`);
    ok(!res.ok && res.error.includes(`'${h}'`) && /qa/.test(res.error),
      `LOOP-208: the '${h}' refusal names the actor + the qa verifier-owner (observability)`);
    ok(!res.ok && !/builder tier/.test(res.error),
      `LOOP-208: the '${h}' refusal makes NO 'builder tier' claim (that is the wrong question)`);
    ok(stateOf(rosterQa) === "In Review", `LOOP-208: the refused '${h}' close did not move the qa-owned ticket`);
  }
  // … and the qa OWNER closes that very same ticket → LEGAL (the gate admits exactly the owner)
  const rosterQaOwner = updateTicketRow(db, "p", "qa", rosterQa, "In Review",
    updateFields({ state: "Done", labels: JSON.stringify(QA_OWN) }));
  ok(rosterQaOwner.ok && stateOf(rosterQa) === "Done", "LOOP-208: the qa verifier-owner closes its own qa ticket → LEGAL");

  // (b) transition edge — symmetric for a pm-owned ticket: refused for every non-pm, non-operator handle.
  const rosterPm = insertTicket(db, "p", "pm", newFields({ state: "In Review", labels: PM_OWN }), {});
  for (const h of AGENT_HANDLES) {
    if (h === "pm") continue;
    const res = updateTicketRow(db, "p", h, rosterPm, "In Review",
      updateFields({ state: "Done", labels: JSON.stringify(PM_OWN) }));
    ok(!res.ok && stateOf(rosterPm) === "In Review",
      `LOOP-208: In Review → Done on a pm-owned ticket is REFUSED for non-owner handle '${h}'`);
  }
  const rosterPmOwner = updateTicketRow(db, "p", "pm", rosterPm, "In Review",
    updateFields({ state: "Done", labels: JSON.stringify(PM_OWN) }));
  ok(rosterPmOwner.ok && stateOf(rosterPm) === "Done", "LOOP-208: the pm verifier-owner closes its own pm ticket → LEGAL");

  // (c) create edge — the same ownership rule mirrored at create-into-Done, driven from the roster:
  // every non-owner, non-operator handle is refused; the owner (and, below, the operator) pass.
  for (const h of AGENT_HANDLES) {
    const qaRej = verifyCreateGateRejection(h, "Done", QA_OWN);
    if (h === "qa") ok(qaRej === null, "LOOP-208: create-into-Done of a qa-owned ticket is ALLOWED for the qa owner");
    else {
      ok(qaRej !== null, `LOOP-208: create-into-Done of a qa-owned ticket is REFUSED for non-owner handle '${h}'`);
      ok(qaRej !== null && qaRej.includes(`'${h}'`) && !/builder tier/.test(qaRej),
        `LOOP-208: the '${h}' create refusal names the actor and makes no 'builder tier' claim`);
    }
    const pmRej = verifyCreateGateRejection(h, "Done", PM_OWN);
    if (h === "pm") ok(pmRej === null, "LOOP-208: create-into-Done of a pm-owned ticket is ALLOWED for the pm owner");
    else ok(pmRej !== null, `LOOP-208: create-into-Done of a pm-owned ticket is REFUSED for non-owner handle '${h}'`);
  }
  ok(verifyCreateGateRejection("operator", "Done", QA_OWN) === null, "LOOP-208: the operator may create a closed qa ticket (carve-out)");

  // (d) the RULED open question — STRICT cross-owner: pm may NOT close a qa-owned ticket, nor qa a
  // pm-owned one (each is an unverified close — "Done means verified by ITS owner", §3). Also covered by
  // the roster loops above; asserted explicitly here because it is the design's load-bearing ruling.
  const pmXqaId = insertTicket(db, "p", "qa", newFields({ state: "In Review", type: "Bug", labels: QA_OWN }), {});
  const pmXqa = updateTicketRow(db, "p", "pm", pmXqaId, "In Review", updateFields({ state: "Done", labels: JSON.stringify(QA_OWN) }));
  ok(!pmXqa.ok && stateOf(pmXqaId) === "In Review", "LOOP-208: pm may NOT close a qa-owned ticket (strict cross-owner ruling)");
  const qaXpmId = insertTicket(db, "p", "pm", newFields({ state: "In Review", labels: PM_OWN }), {});
  const qaXpm = updateTicketRow(db, "p", "qa", qaXpmId, "In Review", updateFields({ state: "Done", labels: JSON.stringify(PM_OWN) }));
  ok(!qaXpm.ok && stateOf(qaXpmId) === "In Review", "LOOP-208: qa may NOT close a pm-owned ticket (strict cross-owner ruling)");

  // (e) a DUAL qa+pm-owned ticket is closable by EITHER owner (actor ∈ owners), never by a non-owner.
  const DUAL_OWN = ["dev-loop", "qa", "pm"];
  const dualA = insertTicket(db, "p", "pm", newFields({ state: "In Review", labels: DUAL_OWN }), {});
  ok(updateTicketRow(db, "p", "qa", dualA, "In Review", updateFields({ state: "Done", labels: JSON.stringify(DUAL_OWN) })).ok && stateOf(dualA) === "Done",
    "LOOP-208: a dual qa+pm-owned ticket is closable by the qa owner");
  const dualB = insertTicket(db, "p", "pm", newFields({ state: "In Review", labels: DUAL_OWN }), {});
  ok(updateTicketRow(db, "p", "pm", dualB, "In Review", updateFields({ state: "Done", labels: JSON.stringify(DUAL_OWN) })).ok && stateOf(dualB) === "Done",
    "LOOP-208: a dual qa+pm-owned ticket is closable by the pm owner");
  const dualC = insertTicket(db, "p", "pm", newFields({ state: "In Review", labels: DUAL_OWN }), {});
  const dualCsweep = updateTicketRow(db, "p", "sweep", dualC, "In Review", updateFields({ state: "Done", labels: JSON.stringify(DUAL_OWN) }));
  ok(!dualCsweep.ok && stateOf(dualC) === "In Review", "LOOP-208: a dual qa+pm-owned ticket is NOT closable by a non-owner (sweep)");

  // (f) the gate lives in the SHARED write path, so the daemon board-move primitive (moveTicket →
  // updateTicketRow) is covered too: sweep's move is refused; the operator's move (a human actor) is legal.
  const mvId = insertTicket(db, "p", "qa", newFields({ state: "In Review", type: "Bug", labels: QA_OWN }), {});
  const mvSweep = moveTicket(db, "p", "sweep", mvId, "Done");
  ok(!mvSweep.ok && stateOf(mvId) === "In Review", "LOOP-208: the daemon board-move (moveTicket) refuses a non-owner In Review → Done");
  const mvOp = moveTicket(db, "p", "operator", mvId, "Done");
  ok(mvOp.ok && stateOf(mvId) === "Done", "LOOP-208: the daemon board-move by the operator In Review → Done stays legal (human actor)");

  // (g) the gate is edge-specific — a NON-transition write (e.g. sweep re-labelling an In Review qa
  // ticket, its actual job) never reaches the gate, so owner-label hygiene by any actor is unaffected.
  const hyId = insertTicket(db, "p", "qa", newFields({ state: "In Review", type: "Bug", labels: QA_OWN }), {});
  const hySweep = updateTicketRow(db, "p", "sweep", hyId, "In Review",
    updateFields({ state: "In Review", labels: JSON.stringify([...QA_OWN, "needs-qa"]) }));
  ok(hySweep.ok && stateOf(hyId) === "In Review", "LOOP-208: a non-transition write (sweep re-labels an In Review qa ticket) is NOT gated (edge-specific)");

  db.close();
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "ticketwrite: all checks passed");
process.exit(fails ? 1 : 0);
