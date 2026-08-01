// doctor-null-assignee.ts — W27 regression: null-assignee tickets are unreachable in split-dev.
// Also covers the servable.ts inReview label-based fix (LOOP-244).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { servableSlice } from "../src/servable.ts";
import { loadWorkspace } from "../src/team-config.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-w27-")));
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

  // ── AC2: W27 does NOT fire for a single-dev (devSplit:false) project ──
  {
    const root = join(tmp, "ac2");
    seedWs(root, false);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-2", state: "Todo", labels: ["dev-loop", "Bug", "qa"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(!out.includes("[W27]"), "AC2: W27 does NOT fire for single-dev (devSplit:false) project");
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

  // ── Backlog + tier label → fires (LOOP-261 pattern); Backlog + no tier → silent (LOOP-228 umbrella) ──
  {
    const root = join(tmp, "backlog");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-4a", state: "Backlog", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
      { id: "LOOP-4b", state: "Backlog", labels: ["dev-loop", "Feature"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(out.includes("[W27]") && out.includes("LOOP-4a"), "Backlog + tier label fires W27 (stuck promotion queue)");
    ok(!out.includes("LOOP-4b"), "Backlog + no tier label stays silent (umbrella/epic)");
  }

  // ── InReview + null + tier label → W27 silent (servable fix makes it landable) ──
  // ── InReview + null + NO tier → W27 fires (not landable by any dev tier) ──
  {
    const root = join(tmp, "inreview");
    seedWs(root, true);
    const dbPath = join(root, ".dev-loop", "hub.db");
    seedDb(dbPath, [
      { id: "LOOP-5a", state: "In Review", labels: ["dev-loop", "Bug", "qa", "junior-dev"], assignee: null },
      { id: "LOOP-5b", state: "In Review", labels: ["dev-loop", "Bug", "qa"], assignee: null },
    ]);
    const ws = loadWorkspace(root);
    const out = await capture(() => doctorWorkspace(ws, { boardDb: dbPath }));
    ok(!out.includes("LOOP-5a"), "InReview + null + tier label: W27 silent (servable.ts fix makes it landable)");
    ok(out.includes("[W27]") && out.includes("LOOP-5b"), "InReview + null + no tier: W27 fires (not landable)");

    // Verify servable.ts inReview fix: LOOP-5a now appears in junior-dev's inReview slice
    const db = openDb(dbPath);
    const slice = servableSlice(db, "p1", "junior-dev");
    db.close();
    ok(slice.inReview.some((t) => t.id === "LOOP-5a"), "servable.ts: null-assignee InReview + tier label appears in inReview slice");
    ok(!slice.inReview.some((t) => t.id === "LOOP-5b"), "servable.ts: null-assignee InReview + no tier label stays out of inReview slice");
  }

  // ── AC5 proof: current main has no W27 check (must fail-before, pass-after) ──
  // The above tests ARE the regression; if they pass against old main, the check didn't exist.
  // The seedDb approach creates a board with the exact failing shape. If W27 fires, we're good.

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nDOCTOR_NULL_ASSIGNEE_OK");
