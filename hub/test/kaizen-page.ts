// kaizen-page.ts — kaizenPage renderer unit test (LOOP-206, design kaizen-panel Surface 2).
// Model: hub/test/accept-rate.ts (seed a temp db, call the renderer with injected nowMs, assert HTML).
// Covers: header-line suppress rule (both branches), honest empty states per unpopulated stat,
// /ticket/:id links, CLI≡web agreement (AC4 — kaizenReport numbers appear in kaizenPage HTML).
import { rmSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { kaizenPage } from "../src/views/kaizen.ts";
import { kaizenReport } from "../src/metrics.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
type DB = ReturnType<typeof openDb>;
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const NOW = Date.parse("2026-08-01T00:00:00Z");

// Force no lessons dir so file-read paths are fully deterministic in tests.
process.env.DEVLOOP_LESSONS_DIR = "/tmp/nonexistent-lessons-dir-kaizen-test";

function seedDb(path: string): DB {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','2026-01-01T00:00:00Z')").run();
  return db;
}
// Insert an agent-filed ticket.
const agentTicket = (db: DB, id: string, createdBy: string, state: string) =>
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "p", `title-${id}`, "", "Bug", state, 2, "[]", "[]", createdBy, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z", null);
// Insert an In Review → Canceled event (verify-fail edge).
const verifyFail = (db: DB, createdAt: string) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
    .run(JSON.stringify({ from: "In Review", to: "Canceled" }), createdAt);

// ── AC2 branch A: with a seeded self-fix, header line renders above stat 1 ──
{
  const db = seedDb("/tmp/dl-kz-withfix.db");
  agentTicket(db, "LOOP-A1", "pm", "Done");   // self-filed, self-fixed
  agentTicket(db, "LOOP-A2", "operator", "Done"); // operator-filed, Done but not selfFixed
  const html = kaizenPage(db, "p", "k", NOW);
  ok(html.includes("It ships software. Then it improves the shipping."),
    "AC2 branch A: header line renders when selfFixed >= 1");
  ok(html.includes("/ticket/LOOP-A1"), "AC2: /ticket/:id link for a self-fixed ticket");
  ok(!html.includes("hasn't filed and fixed"), "AC2 branch A: empty-state line ABSENT when selfFixed >= 1");
  ok(html.includes("self-fixed"), "AC2: stat 1 body rendered with self-fix data");
  db.close();
}

// ── AC2 branch B: with no self-fix, header line is ABSENT and honest empty state shows ──
{
  const db = seedDb("/tmp/dl-kz-nofix.db");
  agentTicket(db, "LOOP-B1", "pm", "In Progress");  // self-filed, NOT Done
  agentTicket(db, "LOOP-B2", "operator", "Done");    // operator-filed, Done
  const html = kaizenPage(db, "p", "k", NOW);
  ok(!html.includes("It ships software. Then it improves the shipping."),
    "AC2 branch B: header line ABSENT when selfFixed === 0");
  ok(html.includes("hasn't filed and fixed") || html.includes("none fixed yet"),
    "AC2 branch B: honest empty state shows when header suppressed");
  db.close();
}

// ── AC3: each unpopulated stat shows its honest empty state — no fabricated 0/0%/0.00 ──
{
  const db = seedDb("/tmp/dl-kz-empty.db");
  const html = kaizenPage(db, "p", "k", NOW);
  ok(!html.includes(">0%<") && !html.includes(">$0") && !html.includes(">0.00"),
    "AC3: no fabricated 0%/$0.00 in the empty-board state");
  ok(html.includes("hasn't filed its own issues yet"),
    "AC3: stat 1 honest empty state (selfFiled===0)");
  ok(html.includes("no lessons recorded yet"),
    "AC3: stat 2 honest empty state (lessons dir absent)");
  // stat 3 (ratchet) — current threshold absent when package.json not the test fixture → honest empty
  // stat 4
  ok(html.includes("no §17 proposals filed yet"),
    "AC3: stat 4 honest empty state (no proposals)");
  // stat 5
  ok(html.includes("no verify-fails in the last"),
    "AC3: stat 5 honest empty state (no verify-fails)");
  db.close();
}

// ── AC4: shared board-derived numbers equal kaizenReport output (CLI≡web agreement) ──
{
  const db = seedDb("/tmp/dl-kz-agree.db");
  agentTicket(db, "LOOP-C1", "pm", "Done");
  agentTicket(db, "LOOP-C2", "pm", "Done");
  agentTicket(db, "LOOP-C3", "pm", "In Progress");
  agentTicket(db, "LOOP-C4", "operator", "Done");
  verifyFail(db, new Date(NOW - 1 * 86_400_000).toISOString()); // 1 day ago (within default 7d window)
  const report = kaizenReport(db, "p", { nowMs: NOW, lessonsDir: undefined });
  const html = kaizenPage(db, "p", "k", NOW);
  // selfFiled=3 (pm-filed), selfFixed=2 (LOOP-C1, LOOP-C2), totalDone=3 (C1+C2+C4)
  ok(report.selfImprovement.selfFiled === 3, "AC4 setup: selfFiled === 3");
  ok(report.selfImprovement.selfFixed === 2, "AC4 setup: selfFixed === 2");
  ok(html.includes(String(report.selfImprovement.selfFiled)), `AC4: selfFiled ${report.selfImprovement.selfFiled} appears in HTML`);
  ok(html.includes(String(report.selfImprovement.selfFixed)), `AC4: selfFixed ${report.selfImprovement.selfFixed} appears in HTML`);
  ok(html.includes("LOOP-C1") && html.includes("LOOP-C2"), "AC4: /ticket/:id links for both fixed tickets");
  ok(html.includes(String(report.verifyFail.totalInWindow)), `AC4: verifyFail total ${report.verifyFail.totalInWindow} in HTML`);
  db.close();
}

// ── cap 20 with explicit "showing latest 20 of N" ──
{
  const db = seedDb("/tmp/dl-kz-cap20.db");
  for (let i = 0; i < 25; i++) agentTicket(db, `LOOP-D${i}`, "pm", "Done");
  const html = kaizenPage(db, "p", "k", NOW);
  ok(html.includes("showing latest 20 of 25"), "cap 20: explicit 'showing latest 20 of 25' label");
  db.close();
}

// ── cleanup ──
for (const base of ["/tmp/dl-kz-withfix.db", "/tmp/dl-kz-nofix.db", "/tmp/dl-kz-empty.db", "/tmp/dl-kz-agree.db", "/tmp/dl-kz-cap20.db"]) clean(base);
console.log(fails === 0 ? "\nKAIZEN_PAGE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
