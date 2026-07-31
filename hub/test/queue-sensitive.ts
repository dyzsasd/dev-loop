// LOOP-80 regression: junior-dev queue slice must never serve a sensitive ticket, even when
// the row exists (residual / pre-gate / raw-insert). Design: sensitive-routing §2 / LOOP-80 Child B.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { agentOp } from "../src/agentops.ts";

let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-queue-sensitive-"));

type QueueResult = { agent: string; todo: Array<{ id: string }>; inProgress: Array<{ id: string }> };

function queue(db: DatabaseSync, projectId: string, actor: string): QueueResult {
  const r = agentOp("queue", db, projectId, "QS", actor, {}) as { status: number; body: QueueResult };
  if (r.status !== 200) throw new Error(`queue failed: ${JSON.stringify(r)}`);
  return r.body;
}

try {
  // ── Fixture ───────────────────────────────────────────────────────────────────
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
    .run("p", "QS", "test", "2024-01-01T00:00:00Z");

  // Raw insert that BYPASSES ticketwrite.ts (simulates residual/pre-gate row for Layer-2 test)
  const rawTicket = (id: string, state: string, assignee: string, labels: string[]): void => {
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "p", `t-${id}`, "", "Improvement", state, assignee, 0, JSON.stringify(labels), "[]", "pm", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z");
  };

  // Residual: sensitive+junior in Todo (should be excluded from junior-dev queue)
  rawTicket("QS-1", "Todo", "junior-dev", ["sensitive", "junior-dev"]);
  // Residual: sensitive+junior In Progress (also excluded)
  rawTicket("QS-2", "In Progress", "junior-dev", ["sensitive", "junior-dev"]);
  // Normal junior ticket (should appear in junior queue)
  rawTicket("QS-3", "Todo", "junior-dev", ["junior-dev"]);
  // Sensitive ticket assigned to senior-dev (should appear in senior-dev queue)
  rawTicket("QS-4", "Todo", "senior-dev", ["sensitive", "senior-dev"]);

  // ── AC1: junior-dev queue omits sensitive tickets ─────────────────────────────
  const juniorQ = queue(db, "p", "junior-dev");
  const juniorTodoIds = juniorQ.todo.map((t) => t.id);
  const juniorInProgIds = juniorQ.inProgress.map((t) => t.id);

  ok(!juniorTodoIds.includes("QS-1"), "junior-dev todo: sensitive+junior ticket (QS-1) excluded");
  ok(!juniorInProgIds.includes("QS-2"), "junior-dev inProgress: sensitive+junior ticket (QS-2) excluded");
  ok(juniorTodoIds.includes("QS-3"), "junior-dev todo: normal junior ticket (QS-3) present");

  // ── AC2: senior-dev queue includes sensitive tickets ──────────────────────────
  const seniorQ = queue(db, "p", "senior-dev");
  ok(seniorQ.todo.map((t) => t.id).includes("QS-4"), "senior-dev todo: sensitive+senior ticket (QS-4) present");

  // ── AC3: legacy dev queue includes sensitive (unfiltered for dev actor) ────────
  const db2 = openDb(join(ROOT, "hub2.db"));
  db2.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)").run("pm2", "pm", "human", "pm", "2024-01-01T00:00:00Z");
  db2.prepare("INSERT INTO actors(id,handle,kind,display_name,created_at) VALUES(?,?,?,?,?)").run("dev2", "dev", "agent", "dev", "2024-01-01T00:00:00Z");
  db2.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)").run("p2", "QS2", "test2", "2024-01-01T00:00:00Z");
  db2.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("QS2-1", "p2", "t", "", "Improvement", "Todo", "dev", 0, JSON.stringify(["sensitive"]), "[]", "pm", "2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z");
  const devQ = agentOp("queue", db2, "p2", "QS2", "dev", {}) as { status: number; body: QueueResult };
  ok(devQ.status === 200, "dev queue op succeeded");
  ok((devQ.body.todo ?? []).map((t) => t.id).includes("QS2-1"), "dev (legacy) queue: sensitive ticket still included (unfiltered for dev actor)");
  db2.close();

  db.close();
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "queue-sensitive: all checks passed");
process.exit(fails ? 1 : 0);
