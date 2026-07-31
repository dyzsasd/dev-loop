// LOOP-79 regression: sensitive re-tier gate must silently correct sensitive+junior-dev tickets
// to senior-dev (assignee + label swap) in BOTH insertTicket and updateTicketRow, and log
// issue.retier. Must be a strict no-op when sensitive label absent, junior-dev absent, or
// senior-dev actor not registered. Design: sensitive-routing §2 / LOOP-79 Child A.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { insertTicket, updateTicketRow } from "../src/ticketwrite.ts";
import type { NewTicketFields, TicketUpdateFields } from "../src/ticketwrite.ts";

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
  actor("pm", "human");
  actor("junior-dev");
  actor("senior-dev");
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

  db.close();
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "ticketwrite: all checks passed");
process.exit(fails ? 1 : 0);
