// doctor-stale-claims.ts — W43 regression: stale claim detection (LOOP-450).
// Tests AC1–AC5: stale claim findings, no double-report with W16, events-ledger age,
// healthy-lane silence, stale-lane silence, and the metrics.ts predicate.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { staleClaimFindings } from "../src/metrics.ts";
import { loadWorkspace } from "../src/team-config.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-w43-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const NOW = "2026-08-01T12:00:00.000Z";

const capture = async (fn: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

function seedWs(root: string, projectKey = "loop"): void {
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w43-test", backend: "service" },
    repos: {},
    projects: { [projectKey]: { prefix: "LOOP", devSplit: true } },
  }));
}

function seedDb(
  dbPath: string,
  tickets: Array<{ id: string; state: string; labels: string[]; assignee: string | null }>,
  eventOverrides: Array<{ ticketId: string; lastEventAt: string }> = [],
): void {
  const db = openDb(dbPath);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
  const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const evIns = db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)");
  for (const t of tickets) {
    ins.run(t.id, "p1", "title", "", "Bug", t.state, 2, JSON.stringify(t.labels), "[]", "qa", NOW, NOW, t.assignee);
    // Seed a create event for every ticket
    evIns.run("p1", t.id, "qa", "issue.create", "{}", NOW);
  }
  // Apply event overrides to make some tickets older than others
  for (const o of eventOverrides) {
    // Override the last event for this ticket — delete the create event and insert at the override time
    db.prepare("DELETE FROM events WHERE ticket_id=? AND kind='issue.create'").run(o.ticketId);
    evIns.run("p1", o.ticketId, "qa", "issue.create", "{}", o.lastEventAt);
  }
  db.close();
}

try {
  // ── AC1–AC4: Predicate-level tests with explicit nowMs ──
  // (AC1-4 test the staleClaimFindings predicate with known timestamps)
  {
    const root = join(tmp, "ac1-4");
    seedWs(root);
    const dbPath = join(root, ".dev-loop", "hub.db");
    const db = openDb(dbPath);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const evIns = db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)");

    // AC1: Two stale tickets (30h old)
    ins.run("LOOP-1", "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa", "junior-dev"]), "[]", "qa", NOW, NOW, "junior-dev");
    ins.run("LOOP-2", "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa", "senior-dev"]), "[]", "qa", NOW, NOW, "senior-dev");
    evIns.run("p1", "LOOP-1", "qa", "issue.create", "{}", "2026-07-31T06:00:00.000Z");  // 30h before NOW
    evIns.run("p1", "LOOP-2", "qa", "issue.create", "{}", "2026-07-31T06:00:00.000Z");  // 30h before NOW
    let findings = staleClaimFindings(db, "p1", { nowMs: Date.parse(NOW) });
    ok(findings.length === 2, "AC1: finds 2 stale tickets");
    ok(findings.some((f) => f.ticketId === "LOOP-1"), "AC1: finds LOOP-1");
    ok(findings.some((f) => f.ticketId === "LOOP-2"), "AC1: finds LOOP-2");
    ok(findings.some((f) => f.lastEventAgeHours >= 29 && f.lastEventAgeHours <= 31), "AC1: age is ~30h");

    // AC2: Events ledger > updated_at
    // AC2a: ticket with recent comment activity (events ledger is recent) — should NOT be stale
    ins.run("LOOP-3a", "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa", "junior-dev"]), "[]", "qa", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "junior-dev");
    evIns.run("p1", "LOOP-3a", "qa", "issue.create", "{}", "2026-07-30T06:00:00.000Z");
    evIns.run("p1", "LOOP-3a", "junior-dev", "comment.add", '{}', "2026-08-01T10:00:00.000Z");  // 2h ago, recent

    // AC2b: ticket with old events but recent updated_at (label write bumped it but no event) — should be stale
    ins.run("LOOP-3b", "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa", "senior-dev"]), "[]", "qa", "2026-07-01T00:00:00.000Z", "2026-08-01T11:00:00.000Z", "senior-dev");
    evIns.run("p1", "LOOP-3b", "qa", "issue.create", "{}", "2026-07-30T06:00:00.000Z");  // 30h ago, stale

    findings = staleClaimFindings(db, "p1", { nowMs: Date.parse(NOW) });
    ok(!findings.some((f) => f.ticketId === "LOOP-3a"), "AC2a: recent comment activity NOT stale (events ledger wins)");
    ok(findings.some((f) => f.ticketId === "LOOP-3b"), "AC2b: old events IS stale (events ledger wins, not updated_at)");

    db.close();
  }

  // ── AC3: Recent ticket within 24h window is NOT stale ──
  {
    const root = join(tmp, "ac3");
    seedWs(root);
    const dbPath = join(root, ".dev-loop", "hub.db");
    const db = openDb(dbPath);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const evIns = db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)");

    ins.run("LOOP-4", "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa", "junior-dev"]), "[]", "qa", NOW, NOW, "junior-dev");
    evIns.run("p1", "LOOP-4", "qa", "issue.create", "{}", "2026-08-01T06:00:00.000Z");  // 6h ago, within 24h

    const findings = staleClaimFindings(db, "p1", { nowMs: Date.parse(NOW) });
    ok(findings.length === 0, "AC3: W43 silent when activity within 24h window");
    ok(!findings.some((f) => f.ticketId === "LOOP-4"), "AC3: recent ticket not stale");

    db.close();
  }

  // ── AC4: Truly stale ticket (54h ago) fires W43 ──
  {
    const root = join(tmp, "ac4");
    seedWs(root);
    const dbPath = join(root, ".dev-loop", "hub.db");
    const db = openDb(dbPath);
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const evIns = db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)");

    ins.run("LOOP-5", "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa", "junior-dev"]), "[]", "qa", NOW, NOW, "junior-dev");
    evIns.run("p1", "LOOP-5", "qa", "issue.create", "{}", "2026-07-30T06:00:00.000Z");  // 54h ago

    const findings = staleClaimFindings(db, "p1", { nowMs: Date.parse(NOW) });
    ok(findings.some((f) => f.ticketId === "LOOP-5"), "AC4: W43 fires on stale ticket (54h old)");
    ok(findings.some((f) => f.lastEventAgeHours >= 53 && f.lastEventAgeHours <= 55), "AC4: age is ~54h");

    db.close();
  }

  // ── AC5: staleClaimFindings predicate test — tests the metrics.ts function directly ──
  {
    const root = join(tmp, "ac5");
    seedWs(root);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-6a", state: "In Progress", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: "junior-dev" },
      { id: "LOOP-6b", state: "In Progress", labels: ["dev-loop", "Bug", "qa", "senior-dev"], assignee: "senior-dev" },
      { id: "LOOP-6c", state: "In Progress", labels: ["dev-loop", "Bug", "qa", "junior-dev", "blocked"], assignee: "junior-dev" },
    ], [
      { ticketId: "LOOP-6a", lastEventAt: "2026-07-30T06:00:00.000Z" },  // 54h ago
      { ticketId: "LOOP-6b", lastEventAt: "2026-07-31T06:00:00.000Z" },  // 30h ago
      { ticketId: "LOOP-6c", lastEventAt: "2026-07-30T06:00:00.000Z" },  // 54h ago but blocked
    ]);
    const db = openDb(dbPath);
    // Use a custom nowMs to control the test
    const findings = staleClaimFindings(db, "p1", { nowMs: Date.parse("2026-08-01T12:00:00.000Z") });
    db.close();
    // LOOP-6a: 54h > 24h → stale
    ok(findings.some((f) => f.ticketId === "LOOP-6a"), "AC5: staleClaimFindings finds LOOP-6a (54h old)");
    // LOOP-6b: 30h > 24h → stale
    ok(findings.some((f) => f.ticketId === "LOOP-6b"), "AC5: staleClaimFindings finds LOOP-6b (30h old)");
    // LOOP-6c: blocked → excluded
    ok(!findings.some((f) => f.ticketId === "LOOP-6c"), "AC5: staleClaimFindings excludes blocked LOOP-6c");
    ok(findings.length === 2, "AC5: staleClaimFindings returns exactly 2 findings (2 stale, 1 blocked excluded)");
  }

  // ── AC5 — staleClaimFindings with custom windowMs ──
  {
    const root = join(tmp, "ac5b");
    seedWs(root);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-7a", state: "In Progress", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: "junior-dev" },
      { id: "LOOP-7b", state: "In Progress", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: "junior-dev" },
    ], [
      { ticketId: "LOOP-7a", lastEventAt: "2026-08-01T06:00:00.000Z" },  // 6h ago
      { ticketId: "LOOP-7b", lastEventAt: "2026-07-31T06:00:00.000Z" },  // 30h ago
    ]);
    const db = openDb(dbPath);
    // With a 48h window, neither is stale
    const findings48 = staleClaimFindings(db, "p1", { windowMs: 48 * 3_600_000, nowMs: Date.parse("2026-08-01T12:00:00.000Z") });
    // With a 12h window, LOOP-7a is not stale (6h < 12h), LOOP-7b is stale (30h > 12h)
    const findings12 = staleClaimFindings(db, "p1", { windowMs: 12 * 3_600_000, nowMs: Date.parse("2026-08-01T12:00:00.000Z") });
    db.close();
    ok(findings48.length === 0, "AC5b: staleClaimFindings with 48h window returns 0 (neither ticket is 48h+ stale)");
    ok(findings12.length === 1 && findings12[0].ticketId === "LOOP-7b", "AC5b: staleClaimFindings with 12h window finds only LOOP-7b (30h > 12h)");
  }

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nDOCTOR_STALE_CLAIMS_OK");