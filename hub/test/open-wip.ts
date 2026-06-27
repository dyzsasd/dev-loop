// DL-89 — /activity "Open WIP — aging": per active state (In Progress / In Review; Human-Blocked only when
// populated), the currently-open tickets ordered oldest-first by time-in-current-state RIGHT NOW, each id + age,
// with stale flags (In Review > 2d = verify-lag; In Progress > 1d = possible-orphan). A pure unit test of
// activityPage (daemonviews.ts): seed ticket ROWS (current state) + their issue.create/issue.transition events in
// a temp SoR db, call the renderer with an injected nowMs (no daemon, no network), assert the rendered HTML per AC.
// Unlike the backward-looking "Time in stage" (cycle-stage.ts, events-only), this reads the tickets table for the
// open set — so each scenario seeds both a tickets row and its event history.
import { openDb } from "../src/db.ts";
import { activityPage } from "../src/daemonviews.ts";
import { rmSync } from "node:fs";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
type DB = ReturnType<typeof openDb>;
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const isoOf = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const T = Date.parse("2026-06-20T12:00:00Z"); // fixed nowMs anchor (injected → pure/testable)

function seedDb(path: string): DB {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  return db;
}
// a tickets ROW carrying the CURRENT state (the open-WIP query reads this), mirroring the cli-tickets seed shape.
const ticket = (db: DB, id: string, state: string) =>
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]',?,?,?)")
    .run(id, "p", "t-" + id, "d", "Bug", state, null, 3, JSON.stringify(["dev-loop", "Bug", "qa"]), "dev", isoOf(T - 40 * DAY), isoOf(T));
const create = (db: DB, tid: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',?,'dev','issue.create',?,?)")
    .run(tid, JSON.stringify({ type: "Bug", title: "t" }), isoOf(ms));
const move = (db: DB, tid: string, from: string, to: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',?,'dev','issue.transition',?,?)")
    .run(tid, JSON.stringify({ from, to }), isoOf(ms));
// the section renders between its own header and the "Recent activity" feed; slice it out so assertions bind here.
const wipOf = (html: string) => html.slice(html.indexOf("Open WIP"), html.indexOf("Recent activity"));

// ── (A) age = the LATEST into-state transition (not create); In-Review verify-lag fires past 2d; oldest-first ──
{
  const db = seedDb("/tmp/dl-wip-age.db");
  // Seed NEWEST-first (the un-ordered table scan returns insertion order), so the oldest-first ordering assertion
  // below genuinely exercises the sort — drop the sort and the rendered order would be DL-A2, DL-A1 and fail.
  // DL-A2 "fresh": entered In Review 1d ago → age 1d (< 2d → NO flag).
  ticket(db, "DL-A2", "In Review");
  create(db, "DL-A2", T - 5 * DAY);
  move(db, "DL-A2", "Todo", "In Progress", T - 4 * DAY);
  move(db, "DL-A2", "In Progress", "In Review", T - 1 * DAY);
  // DL-A1 "old": created 30d ago but only entered In Review 3d ago → age MUST be 3d (from the transition), not 30d.
  ticket(db, "DL-A1", "In Review");
  create(db, "DL-A1", T - 30 * DAY);
  move(db, "DL-A1", "Todo", "In Progress", T - 10 * DAY);
  move(db, "DL-A1", "In Progress", "In Review", T - 3 * DAY);   // into In Review = 3d ago (> 2d → verify-lag)
  const wip = wipOf(activityPage(db, "p", "k", T));
  const ir = wip.slice(wip.indexOf("In Review"));               // isolate the In Review block (last state here; no Human-Blocked)
  ok(wip.includes("Open WIP"), "DL-89 AC1: an 'Open WIP — aging' section renders on /activity");
  ok(ir.includes("3d 0h") && !wip.includes("30d"), "DL-89 AC2: age is the latest into-state transition (3d), NOT create (would be 30d)");
  ok(ir.includes("1d 0h"), "DL-89 AC1: the fresh In-Review ticket shows its 1d age");
  ok((wip.match(/verify-lag/g) || []).length === 1, "DL-89 AC3/AC5: the In-Review flag fires ONCE — only the > 2d ticket (DL-A1), not the 1d one (DL-A2)");
  ok(ir.indexOf("DL-A1") >= 0 && ir.indexOf("DL-A1") < ir.indexOf("DL-A2"), "DL-89 AC1: oldest-first — the 3d ticket sorts before the 1d ticket");
  db.close();
}

// ── (B) fallback to create when no into-state transition; In-Progress possible-orphan; empty state '— none' ──
{
  const db = seedDb("/tmp/dl-wip-fallback.db");
  // DL-B1: state In Progress with ONLY a create event (no transition into In Progress) → age falls back to create
  //        = 5d (> 1d → possible-orphan). If the fallback were missing, age would render "—" instead of "5d 0h".
  ticket(db, "DL-B1", "In Progress");
  create(db, "DL-B1", T - 5 * DAY);
  const wip = wipOf(activityPage(db, "p", "k", T));
  const ip = wip.slice(wip.indexOf("In Progress"), wip.indexOf("In Review"));
  const ir = wip.slice(wip.indexOf("In Review"));
  ok(ip.includes("DL-B1") && ip.includes("5d 0h"), "DL-89 AC2: with no into-state transition, age falls back to issue.create (5d), not '—'");
  ok(ip.includes("possible-orphan"), "DL-89 AC3: an In-Progress ticket past the threshold is flagged possible-orphan");
  ok(ir.includes("— none"), "DL-89 AC4: a state with no open tickets renders a neutral '— none', never a fake 0");
  ok(!wip.includes("Human-Blocked"), "DL-89 AC1: Human-Blocked is omitted when unpopulated (parking-state rule)");
  db.close();
}

// ── (C) Human-Blocked renders only when populated, and is NEVER flagged (a deliberate park) ──
{
  const db = seedDb("/tmp/dl-wip-hb.db");
  ticket(db, "DL-C1", "Human-Blocked");
  create(db, "DL-C1", T - 10 * DAY);
  move(db, "DL-C1", "Todo", "Human-Blocked", T - 4 * DAY);     // into Human-Blocked = 4d ago
  const wip = wipOf(activityPage(db, "p", "k", T));
  const hb = wip.slice(wip.indexOf("Human-Blocked"));
  ok(wip.includes("Human-Blocked") && hb.includes("DL-C1") && hb.includes("4d 0h"), "DL-89 AC1: Human-Blocked renders (with id + age) when populated");
  ok(!hb.includes("⚠"), "DL-89 AC3: a Human-Blocked ticket is never flagged stale (it is a deliberate park)");
  db.close();
}

console.log(fails === 0 ? "\nOPEN_WIP_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
