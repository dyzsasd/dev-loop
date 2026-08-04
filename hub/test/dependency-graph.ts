// Tests for hub/src/dependency-graph.ts — read-only dependency-graph surface (LOOP-105).
// Each AC from the ticket is named as a test, plus the PM binding AC for zero-edge.
import { dependencyGraph } from "../src/dependency-graph.ts";
import { openDb } from "../src/db.ts";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-depgraph-")));

try {
  // ── Setup: a project with tickets and comments ──
  const db = openDb(join(tmp, "hub.db"));
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','test','Test','t')").run();

  // Helper: insert a ticket with labels as a JSON string.
  const insertTicket = (id: string, state: string, labels: string[]) => {
    db.prepare(
      "INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t','d','Bug',?,2,?,'[]','t',?,?)"
    ).run(id, "p", state, JSON.stringify(labels), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  };

  // Helper: add a comment to a ticket.
  let seq = 0;
  const addComment = (ticketId: string, body: string) => {
    seq++;
    db.prepare(
      "INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES(?,?,?,?,?)"
    ).run(`c${seq}`, ticketId, "t", body, "2026-01-01T00:00:00Z");
  };

  // ── Tickets (using canonical ticket IDs: <PREFIX>-<digits>) ──
  // T-1: blocked by T-2 and T-3
  // T-2: blocked by T-3
  // T-3: no blockers (terminal Done)
  // T-4: blocked, zero edges (no-edge case)
  // T-5: blocked by X-1 (dangling — does not exist in project)
  // T-6: blocked by T-7 (terminal Done) — unpark-eligible
  // T-7: terminal Done
  // T-8: cyclic — blocked by T-9
  // T-9: blocked by T-8 (cycle)
  // T-10: non-blocked ticket with blockers (not blocked label)

  insertTicket("T-1", "Todo", ["blocked"]);
  insertTicket("T-2", "Todo", ["blocked"]);
  insertTicket("T-3", "Done", []);
  insertTicket("T-4", "Todo", ["blocked"]);
  insertTicket("T-5", "Todo", ["blocked"]);
  insertTicket("T-6", "Todo", ["blocked"]);
  insertTicket("T-7", "Done", []);
  insertTicket("T-8", "Todo", ["blocked"]);
  insertTicket("T-9", "Todo", ["blocked"]);
  insertTicket("T-10", "Todo", []); // no blocked label, but has blockers

  // Comments (blocker edges)
  addComment("T-1", "Blocked-by: T-2 T-3");
  addComment("T-2", "Blocked-by: T-3");
  // T-3: no comments — terminal Done with no blockers
  // T-4: no comments — zero-edge case
  addComment("T-5", "Blocked-by: X-1"); // X-1 does not exist in this project
  addComment("T-6", "Blocked-by: T-7"); // T-7 is Done (terminal)
  // T-7: no blockers
  addComment("T-8", "Blocked-by: T-9");
  addComment("T-9", "Blocked-by: T-8");
  addComment("T-10", "Blocked-by: T-1");

  // ── Run the dependency-graph query ──
  const report = dependencyGraph(db, "p");

  // ── AC 1: blockedEdges — each open blocked ticket → its blockers ──
  {
    const t1 = report.blockedEdges.find((e) => e.ticketId === "T-1");
    ok(!!t1, "blockedEdges: T-1 is in the report");
    ok(t1?.blockers.length === 2 && t1?.blockers.includes("T-2") && t1?.blockers.includes("T-3"),
      `blockedEdges: T-1 → [T-2, T-3] (got ${JSON.stringify(t1?.blockers)})`);
  }
  {
    const t4 = report.blockedEdges.find((e) => e.ticketId === "T-4");
    ok(!!t4, "blockedEdges: T-4 (zero edge) is in the report");
    ok(t4?.blockers.length === 0, `blockedEdges: T-4 → [] (got ${JSON.stringify(t4?.blockers)})`);
  }

  // ── AC 2: reverse transitive fan-out ──
  {
    const rfo = report.reverseFanOut;
    const t3Entry = rfo.find((r) => r.blockerId === "T-3");
    ok(!!t3Entry, "reverseFanOut: T-3 has an entry");
    ok(t3Entry?.direct.includes("T-1") && t3Entry?.direct.includes("T-2"),
      `reverseFanOut: T-3 directly gates [T-1, T-2] (got direct=${JSON.stringify(t3Entry?.direct)})`);
    // Transitive: T-2 blocks T-1, T-3 blocks T-2, so T-3 transitively gates T-1 via T-2
    ok(t3Entry?.transitive.includes("T-1"),
      `reverseFanOut: T-3 transitively gates T-1 via T-2 (got transitive=${JSON.stringify(t3Entry?.transitive)})`);
  }
  {
    // Reverse transitive fan-out: A gates B, B gates C ⇒ A gates {B,C}
    // T-1 blocks T-10 (direct). T-2 blocks T-1 (direct). T-3 blocks T-2 (direct).
    // So T-3 transitively gates T-1 (via T-2) and T-10 (via T-2→T-1).
    const t3Entry = report.reverseFanOut.find((r) => r.blockerId === "T-3");
    ok(t3Entry !== undefined, "AC transitive: T-3 has reverse fan-out entry");
    ok(t3Entry?.transitive.includes("T-1"),
      `AC transitive: T-3 transitively gates T-1 (got transitive=${JSON.stringify(t3Entry?.transitive)})`);
  }

  // ── AC 3: dangling flag ──
  {
    // T-5 is blocked by X-1 which does not exist in this project
    const integrity = report.integrity;
    ok(integrity["T-5"] !== undefined, "integrity: T-5 has integrity entry");
    ok(integrity["T-5"].dangling.length === 1 && integrity["T-5"].dangling[0] === "X-1",
      `integrity: T-5 has dangling [X-1] (got ${JSON.stringify(integrity["T-5"].dangling)})`);
    ok(!integrity["T-5"].unparkEligible, "integrity: dangling blocker is NOT unpark-eligible");
    ok(!integrity["T-5"].cyclic, "integrity: dangling is not cyclic");
    ok(!integrity["T-5"].noEdge, "integrity: T-5 has edges (noEdge=false)");
  }

  // ── AC 4: cyclic flag ──
  {
    // T-8 blocked by T-9, T-9 blocked by T-8
    const integrity = report.integrity;
    ok(integrity["T-8"] !== undefined, "integrity: T-8 has integrity entry");
    ok(integrity["T-8"].cyclic, `integrity: T-8 is cyclic (got cyclic=${integrity["T-8"].cyclic})`);
    ok(integrity["T-9"] !== undefined, "integrity: T-9 has integrity entry");
    ok(integrity["T-9"].cyclic, `integrity: T-9 is cyclic (got cyclic=${integrity["T-9"].cyclic})`);
  }

  // ── PM binding AC: unpark-eligible requires ≥1 edge ──
  {
    // T-4 has blocked label but zero blocker edges (like LOOP-101: Human-Blocked, zero edges).
    const integrity = report.integrity;
    ok(integrity["T-4"] !== undefined, "PM binding: T-4 has integrity entry");
    ok(integrity["T-4"].noEdge, `PM binding: T-4 is noEdge (got noEdge=${integrity["T-4"].noEdge})`);
    ok(!integrity["T-4"].unparkEligible,
      `PM binding: T-4 (zero edges) is NOT unpark-eligible (got unparkEligible=${integrity["T-4"].unparkEligible})`);
  }

  // ── unpark-eligible: all blockers terminal ──
  {
    // T-6 is blocked by T-7 which is Done (terminal)
    const integrity = report.integrity;
    ok(integrity["T-6"] !== undefined, "unpark: T-6 has integrity entry");
    ok(integrity["T-6"].unparkEligible,
      `unpark: T-6 (blocked by Done T-7) is unpark-eligible (got ${JSON.stringify(integrity["T-6"])})`);
    ok(!integrity["T-6"].dangling.length, "unpark: T-6 has no dangling");
    ok(!integrity["T-6"].cyclic, "unpark: T-6 is not cyclic");
    ok(!integrity["T-6"].noEdge, "unpark: T-6 has edges");
  }

  // ── allDangling ──
  {
    ok(report.allDangling.includes("X-1"), `allDangling: X-1 is listed (got ${JSON.stringify(report.allDangling)})`);
    ok(!report.allDangling.includes("T-1"), "allDangling: T-1 (real ticket) is NOT listed as dangling");
  }

  // ── gatingOpen ──
  {
    // T-1, T-2, T-8, T-9, T-10 are non-terminal blockers.
    // T-3 and T-7 are Done (terminal) — not open.
    ok(report.gatingOpen.includes("T-1"), "gatingOpen: T-1 is open and gates tickets");
    ok(report.gatingOpen.includes("T-2"), "gatingOpen: T-2 is open and gates tickets");
    ok(report.gatingOpen.includes("T-8"), "gatingOpen: T-8 is open (part of cycle)");
    ok(report.gatingOpen.includes("T-9"), "gatingOpen: T-9 is open (part of cycle)");
    ok(!report.gatingOpen.includes("T-10"), "gatingOpen: T-10 is NOT a blocker (it is blocked by T-1, does not gate others)");
    ok(!report.gatingOpen.includes("T-3"), "gatingOpen: T-3 (terminal Done) is NOT in open list");
    ok(!report.gatingOpen.includes("T-7"), "gatingOpen: T-7 (terminal Done) is NOT in open list");
  }

  // ── No enforcement / no state changes verified by construction ──
  // Verify no state was changed by the read-only query.
  const states = db.prepare("SELECT id, state FROM tickets WHERE project_id='p' ORDER BY id").all() as { id: string; state: string }[];
  const originalStates: Record<string, string> = { "T-1": "Todo", "T-2": "Todo", "T-3": "Done", "T-4": "Todo", "T-5": "Todo", "T-6": "Todo", "T-7": "Done", "T-8": "Todo", "T-9": "Todo", "T-10": "Todo" };
  for (const { id, state } of states) {
    ok(state === originalStates[id], `no-enforcement: ${id} state unchanged (expected ${originalStates[id]}, got ${state})`);
  }

  db.close();

} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nDEPENDENCY_GRAPH_OK");