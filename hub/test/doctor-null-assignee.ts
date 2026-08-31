// doctor-null-assignee.ts — W27 regression: null-assignee tickets are unreachable in split-dev.
// Also covers the servable.ts inReview label-based fix (LOOP-244).
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { servableSlice } from "../src/servable.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-w27-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const NOW = "2026-08-01T00:00:00.000Z";

const capture = async (fn: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

function seedWs(root: string, devSplit: boolean): void {
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w27-test", backend: "service" },
    repos: {},
    projects: { loop: { prefix: "LOOP", devSplit } },
  }));
}

function seedDb(dbPath: string, tickets: Array<{ id: string; state: string; labels: string[]; assignee: string | null }>): void {
  const db = openDb(dbPath);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
  const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const t of tickets) {
    ins.run(t.id, "p1", "title", "", "Bug", t.state, 2, JSON.stringify(t.labels), "[]", "qa", NOW, NOW, t.assignee);
  }
  db.close();
}

try {
  // ── AC1: W27 fires in a split-dev board with a null-assignee Todo ticket ──
  {
    const root = join(tmp, "ac1");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-1", state: "Todo", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(out.includes("[W27]"), `AC1: W27 fires on split-dev board with null-assignee Todo`);
    ok(out.includes("LOOP-1"), "AC1: W27 names the ticket id");
    ok(out.includes("--assignee junior-dev"), "AC1: W27 remediation is paste-ready with actual tier");
    ok(!out.includes("DOCTOR_OK"), "AC1: DOCTOR_OK not printed while W27 fires (doctorWorkspace does not print DOCTOR_OK itself)");
  }

  // ── AC2: W27 does NOT fire for legacy single-dev Todo, but DOES fire for InProgress/InReview ──
  {
    // AC2a: legacy + Todo + null → W27 silent (mine() makes it dev's own)
    const root2a = join(tmp, "ac2a");
    seedWs(root2a, false);
    const dbPath2a = join(root2a, ".dev-loop", "hub.db");
    seedDb(dbPath2a, [
      { id: "LOOP-2a", state: "Todo", labels: ["dev-loop", "Bug", "qa"], assignee: null },
    ]);
    const ws2a = loadWorkspace(root2a);
    const out2a = await capture(() => doctorWorkspace(ws2a, { boardDb: dbPath2a }));
    ok(!out2a.includes("[W27]"), "AC2a: W27 silent for legacy (devSplit:false) Todo + null (mine() makes it dev's own)");

    // AC2b: legacy + In Progress + null → W27 FIRES (mine() is Todo-only; inProgress keys on assignee===actor)
    const root2b = join(tmp, "ac2b");
    seedWs(root2b, false);
    const dbPath2b = join(root2b, ".dev-loop", "hub.db");
    seedDb(dbPath2b, [
      { id: "LOOP-2b", state: "In Progress", labels: ["dev-loop", "Bug", "qa"], assignee: null },
    ]);
    const ws2b = loadWorkspace(root2b);
    const out2b = await capture(() => doctorWorkspace(ws2b, { boardDb: dbPath2b }));
    ok(out2b.includes("[W27]") && out2b.includes("LOOP-2b"), "AC2b: W27 fires for legacy InProgress + null (unreachable; mine() is Todo-only)");

    // AC2c: legacy + In Review + qa label → W27 silent (verifiable via qa label)
    const root2c = join(tmp, "ac2c");
    seedWs(root2c, false);
    const dbPath2c = join(root2c, ".dev-loop", "hub.db");
    seedDb(dbPath2c, [
      { id: "LOOP-2c", state: "In Review", labels: ["dev-loop", "Bug", "qa"], assignee: null },
    ]);
    const ws2c = loadWorkspace(root2c);
    const out2c = await capture(() => doctorWorkspace(ws2c, { boardDb: dbPath2c }));
    ok(!out2c.includes("[W27]"), "AC2c: W27 silent for legacy InReview + qa label (qa verify slice needs no assignee)");

    // AC2d: legacy + In Review + tier label only (no qa/pm) → W27 FIRES (tier-label fix is split-dev only)
    const root2d = join(tmp, "ac2d");
    seedWs(root2d, false);
    const dbPath2d = join(root2d, ".dev-loop", "hub.db");
    seedDb(dbPath2d, [
      { id: "LOOP-2d", state: "In Review", labels: ["dev-loop", "Bug", "junior-dev"], assignee: null },
    ]);
    const ws2d = loadWorkspace(root2d);
    const out2d = await capture(() => doctorWorkspace(ws2d, { boardDb: dbPath2d }));
    ok(out2d.includes("[W27]") && out2d.includes("LOOP-2d"), "AC2d: W27 fires for legacy InReview + tier label only (tier-label fallback is split-dev only)");
    // LOOP-270: the remediation must preserve the resolved tier — a residual dev-tier label here
    // yields `--assignee junior-dev`, never the literal `<tier>` placeholder (AC4 paste-ready guard).
    ok(out2d.includes("--assignee junior-dev"), "AC2d/LOOP-270: remediation carries the real tier (--assignee junior-dev)");
    ok(!out2d.includes("--assignee <tier>"), "AC2d/LOOP-270: remediation never prints the literal <tier> placeholder when a real tier label exists");
  }

  // ── AC3: W27 does NOT fire on terminal tickets (Done, Canceled, Duplicate) ──
  {
    const root = join(tmp, "ac3");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-3a", state: "Done", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
      { id: "LOOP-3b", state: "Canceled", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
      { id: "LOOP-3c", state: "Duplicate", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(!out.includes("[W27]"), "AC3: W27 does NOT fire on terminal tickets (Done/Canceled/Duplicate)");
  }

  // ── LOOP-293 AC1: Backlog + null assignee → W27 does NOT fire (PM backlog queue is label-blind in both modes) ──
  {
    const root = join(tmp, "backlog");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-4a", state: "Backlog", labels: ["dev-loop", "Bug", "pm"], assignee: null }, // pm owner, no dev-tier
      { id: "LOOP-4b", state: "Backlog", labels: ["dev-loop", "Feature"], assignee: null },           // no owner, no dev-tier
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(!out.includes("[W27]"), "LOOP-293 AC1: Backlog + null assignee — W27 silent (unconditional exemption)");
    ok(!out.includes("LOOP-4a"), "LOOP-293 AC1: LOOP-4a (pm-owned Backlog) not flagged");
    ok(!out.includes("LOOP-4b"), "LOOP-293 AC1: LOOP-4b (no-owner Backlog) not flagged");
  }

  // ── InReview + null: W27 predicate — reachable via dev-tier label OR qa/pm owner label ──
  {
    const root = join(tmp, "inreview");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-5a", state: "In Review", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
      // LOOP-5b: qa label → reachable via opQueue verify slice; NOT stranded even with no dev-tier label
      { id: "LOOP-5b", state: "In Review", labels: ["dev-loop", "Bug", "qa"], assignee: null },
      // LOOP-5c: no dev-tier AND no qa/pm label → truly stuck; must fire W27
      { id: "LOOP-5c", state: "In Review", labels: ["dev-loop", "Bug"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(!out.includes("LOOP-5a"), "InReview + null + tier label: W27 silent (servable.ts fix makes it landable)");
    ok(!out.includes("LOOP-5b"), "InReview + null + qa label: W27 silent (reachable via opQueue verify slice)");
    // LOOP-293 AC4: genuinely tier-less (no verifiable, no landable) has no useful remediation — skip
    ok(!out.includes("LOOP-5c"), "LOOP-293 AC4: InReview + null + no tier + no qa/pm — W27 silent (no useful remediation)");

    // Verify servable.ts inReview fix: LOOP-5a now appears in junior-dev's inReview slice
    const db = openDb(dbPath);
    const slice = servableSlice(db, "p1", "junior-dev");
    db.close();
    ok(slice.inReview.some((t) => t.id === "LOOP-5a"), "servable.ts: null-assignee InReview + tier label appears in inReview slice");
    ok(!slice.inReview.some((t) => t.id === "LOOP-5b"), "servable.ts: null-assignee InReview + no dev-tier label stays out of inReview slice");
    ok(!slice.inReview.some((t) => t.id === "LOOP-5c"), "servable.ts: null-assignee InReview + no labels stays out of inReview slice");
  }

  // ── P1 fix: explicit-assignee InReview must NOT leak to other tier via label (LOOP-244) ──
  {
    const root = join(tmp, "assignee-leak");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      // senior-dev owns this ticket; junior-dev label is residual but should not grant access
      { id: "LOOP-6a", state: "In Review", labels: ["dev-loop", "Bug", "qa", "junior-dev", "senior-dev"], assignee: "senior-dev" },
    ]);
    const db = openDb(dbPath);
    const jrSlice = servableSlice(db, "p1", "junior-dev");
    const srSlice = servableSlice(db, "p1", "senior-dev");
    db.close();
    ok(!jrSlice.inReview.some((t) => t.id === "LOOP-6a"), "P1 fix: explicitly-assigned senior-dev ticket NOT in junior-dev inReview (label fallback requires assignee===null)");
    ok(srSlice.inReview.some((t) => t.id === "LOOP-6a"), "P1 fix: that same ticket IS in senior-dev inReview (assignee match)");
  }

  // ── LOOP-293: regression tests for the three shapes ──
  {
    const root = join(tmp, "loop293");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      // LOOP-293 shape (a): LOOP-228's shape — Backlog, null assignee, owner pm, no dev-tier
      { id: "LOOP-293a", state: "Backlog", labels: ["dev-loop", "Improvement", "pm"], assignee: null },
      // LOOP-293 shape (b): LOOP-277's shape — Todo, null assignee, owner pm, no dev-tier
      { id: "LOOP-293b", state: "Todo", labels: ["dev-loop", "Improvement", "pm"], assignee: null },
      // LOOP-293 shape (c): Todo, null assignee, dev-tier label present
      { id: "LOOP-293c", state: "Todo", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    // AC1: Backlog exempt unconditionally
    ok(!out.includes("LOOP-293a"), "LOOP-293 AC1: Backlog + null + pm owner — NOT flagged (unconditional exemption)");
    // AC2: Todo + owner label + no dev-tier → flagged with operator park hint
    ok(out.includes("LOOP-293b"), "LOOP-293 AC2: Todo + null + pm owner — flagged (genuinely stranded)");
    ok(out.includes("--state Human-Blocked --assignee operator"), "LOOP-293 AC2: remediation is operator park");
    ok(!out.includes("<tier>"), "LOOP-293 AC2: no literal <tier> in output");
    // AC3: Todo + dev-tier label → flagged with tier hint
    ok(out.includes("LOOP-293c"), "LOOP-293 AC3: Todo + null + dev-tier — flagged");
    ok(out.includes("--assignee junior-dev"), "LOOP-293 AC3: remediation is paste-ready tier assignment");
  }

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nDOCTOR_NULL_ASSIGNEE_OK");
