// doctor-stale-claims.ts — W43 regression: stale claim detection.
// Predicate arms (staleClaimFindings): events-ledger age, blocked exclusion, custom window.
// Rendered arms (doctorWorkspace): W16/W43 exclusivity in both directions, and the W43 line's
// content — count, oldest ticket id, and the >=48h day/hour formatting (LOOP-566).
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { staleClaimFindings } from "../src/metrics.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-w43-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const NOW = "2026-08-01T12:00:00.000Z";

// The rendered arms run through the real doctor path, which uses Date.now() for both the stale
// window and the liveness window — so their fixtures are stamped RELATIVE to now, not at NOW.
const agoIso = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

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

/**
 * A whole workspace the REAL doctor path can be run against: config + fires ledger + hub.db, all
 * stamped relative to now. `staleHours` is the age of the ticket's most recent events row (what
 * W43 measures); `fires[].hoursAgo` is how long ago that handle last fired (what W16 measures).
 * Returns the hub.db path for doctorWorkspace's `boardDb`.
 */
function seedRendered(
  root: string,
  tickets: Array<{ id: string; assignee: string | null; staleHours: number }>,
  fires: Array<{ agent: string; hoursAgo: number }>,
): string {
  seedWs(root);
  mkdirSync(join(root, ".dev-loop", "team"), { recursive: true });
  writeFileSync(
    join(root, ".dev-loop", "team", "fires.jsonl"),
    fires.map((f) => JSON.stringify({ agent: f.agent, ts: agoIso(f.hoursAgo) })).join("\n") + "\n",
  );
  const dbPath = join(root, ".dev-loop", "hub.db");
  const db = openDb(dbPath);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','loop','Loop','2026-01-01T00:00:00.000Z')").run();
  const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at,assignee) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const evIns = db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)");
  for (const t of tickets) {
    const at = agoIso(t.staleHours);
    // In Progress ownership keys on assignee alone in BOTH checks, so the label set only has to
    // stay non-blocked; it is deliberately not the carrier here.
    ins.run(t.id, "p1", "title", "", "Bug", "In Progress", 2, JSON.stringify(["dev-loop", "Bug", "qa"]), "[]", "qa", at, at, t.assignee);
    evIns.run("p1", t.id, "qa", "issue.create", "{}", at);
  }
  db.close();
  return dbPath;
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
    ok(findings48.length === 0, "predicate: staleClaimFindings with 48h window returns 0 (neither ticket is 48h+ stale)");
    ok(findings12.length === 1 && findings12[0].ticketId === "LOOP-7b", "predicate: staleClaimFindings with 12h window finds only LOOP-7b (30h > 12h)");
  }

  // ── AC3 — W16/W43 exclusivity, asserted on the RENDERED doctor output, both directions.
  // The predicate arms above cannot see this: staleClaimFindings is fire-free by design, so
  // whether W43 SPEAKS about a given ticket is decided one layer up (liveOwnerStaleClaims) and
  // is only observable in the lines doctorWorkspace prints.
  {
    // AC3a — owner with no fire inside the liveness window: W16 reports it, W43 is silent.
    const root = join(tmp, "ac3-dead-owner");
    const dbPath = seedRendered(
      root,
      [{ id: "LOOP-10", assignee: "junior-dev", staleHours: 30 }],
      [{ agent: "junior-dev", hoursAgo: 8 * 24 }],  // last fire 8d ago — outside W16's 7d window
    );
    const out = await capture(() => doctorWorkspace(loadWorkspace(root), { boardDb: dbPath }));
    ok(out.includes("[W16]"), "AC3a: dead owner + stale claim → W16 present");
    ok(out.includes("owner 'junior-dev'"), "AC3a: W16 names the dead owner");
    ok(!out.includes("[W43]"), "AC3a: dead owner + stale claim → W43 SILENT (W16 owns the report)");
  }
  {
    // AC3b — the inverse: same board, owner fired 1 minute ago. W43 speaks, W16 does not.
    const root = join(tmp, "ac3-live-owner");
    const dbPath = seedRendered(
      root,
      [{ id: "LOOP-11", assignee: "junior-dev", staleHours: 30 }],
      [{ agent: "junior-dev", hoursAgo: 1 / 60 }],  // last fire 1 minute ago — alive
    );
    const out = await capture(() => doctorWorkspace(loadWorkspace(root), { boardDb: dbPath }));
    ok(out.includes("[W43]"), "AC3b: live owner + stale claim → W43 present");
    ok(out.includes("LOOP-11"), "AC3b: W43 names the stalled ticket");
    ok(!out.includes("[W16]"), "AC3b: live owner + stale claim → W16 SILENT (W43 owns the report)");
  }

  // ── AC4 — the W43 renderer's own content: count, oldest ticket id, and the age formatting.
  {
    // AC4a — two stale claims, live owner: count is 2, `oldest` is the OLDER one, and >=48h
    // renders as days.
    const root = join(tmp, "ac4-days");
    const dbPath = seedRendered(
      root,
      [
        { id: "LOOP-12a", assignee: "junior-dev", staleHours: 50 },
        { id: "LOOP-12b", assignee: "junior-dev", staleHours: 30 },
      ],
      [{ agent: "junior-dev", hoursAgo: 1 / 60 }],
    );
    const out = await capture(() => doctorWorkspace(loadWorkspace(root), { boardDb: dbPath }));
    ok(out.includes("2 claimed ticket(s)"), "AC4a: W43 line carries the finding count");
    ok(out.includes("(oldest LOOP-12a, 2d)"), "AC4a: oldest is the 50h ticket and >=48h renders days (2d)");
    ok(!out.includes("oldest LOOP-12b"), "AC4a: the newer stale claim is not named as oldest");
  }
  {
    // AC4b — below the boundary renders hours.
    const root = join(tmp, "ac4-hours");
    const dbPath = seedRendered(
      root,
      [{ id: "LOOP-13", assignee: "junior-dev", staleHours: 30 }],
      [{ agent: "junior-dev", hoursAgo: 1 / 60 }],
    );
    const out = await capture(() => doctorWorkspace(loadWorkspace(root), { boardDb: dbPath }));
    ok(out.includes("1 claimed ticket(s)"), "AC4b: W43 line carries the finding count");
    ok(out.includes("(oldest LOOP-13, 30h)"), "AC4b: below 48h renders hours (30h), not days");
  }
  {
    // AC4c — the low side of the threshold. Together with AC4a (50h → `2d`) this BRACKETS the
    // switch between 47h and 50h, which is what a rendered arm can actually establish: the doctor
    // path reads a real clock, so a fixture stamped "exactly 48h ago" is 48.000…h by the time the
    // renderer sees it and passes under `>= 48` and `> 48` alike. Do not re-add an
    // exactly-48h arm claiming to pin `>=` against `>` — it pins nothing (LOOP-566 AC6, M3).
    const root = join(tmp, "ac4-boundary");
    const dbPath = seedRendered(
      root,
      [{ id: "LOOP-14", assignee: "junior-dev", staleHours: 47 }],
      [{ agent: "junior-dev", hoursAgo: 1 / 60 }],
    );
    const out = await capture(() => doctorWorkspace(loadWorkspace(root), { boardDb: dbPath }));
    ok(out.includes("(oldest LOOP-14, 47h)"), "AC4c: 47h is still the hours branch — the threshold sits between 47h and 50h");
  }

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nDOCTOR_STALE_CLAIMS_OK");
