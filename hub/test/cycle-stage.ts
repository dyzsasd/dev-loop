// DL-84 — /activity "Time in stage" breakdown: median residence in Todo (queue-wait) / In Progress (build) /
// In Review (verify-lag) over the recently-Done set, reconstructed from each ticket's issue.transition history.
// A pure unit test of activityPage (daemonviews.ts): synthesize issue.create + issue.transition events in a temp
// SoR db, call the renderer with an injected nowMs (no daemon, no network), assert the rendered HTML per AC.
// Covers the three AC7 cases — (a) a re-entered state SUMMED across intervals, (b) a skipped stage rendering "—",
// (c) a malformed-row skip + the empty-window "—" — plus the median across multiple tickets (even-n average).
// Deterministic: events placed at controlled created_at relative to a fixed nowMs anchor, inserted chronologically
// (the per-ticket hist query is ORDER BY id = insertion order).
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
const create = (db: DB, tid: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',?,'dev','issue.create',?,?)")
    .run(tid, JSON.stringify({ type: "Bug", title: "t" }), isoOf(ms));
const move = (db: DB, tid: string, from: string, to: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',?,'dev','issue.transition',?,?)")
    .run(tid, JSON.stringify({ from, to }), isoOf(ms));
// The stage section renders between the "Time in stage" header and the "Recent activity" feed; slice it out so
// assertions bind to the right stage. The three rows render in order: queue-wait (Todo), build (In Progress),
// verify-lag (In Review) — slice between consecutive keywords to isolate one stage's value.
const stageOf = (html: string) => html.slice(html.indexOf("Time in stage"), html.indexOf("Recent activity"));

// ── (a) re-entered state SUMMED: A reopens In Review→In Progress, so In Progress = 3d + 3d = 6d ──
{
  const db = seedDb("/tmp/dl-cs-reenter.db");
  create(db, "a", T - 29 * DAY);                            // → Todo
  move(db, "a", "Todo", "In Progress", T - 28 * DAY);       // Todo = 1d
  move(db, "a", "In Progress", "In Review", T - 25 * DAY);  // In Progress #1 = 3d
  move(db, "a", "In Review", "In Progress", T - 24 * DAY);  // In Review #1 = 1d  (verify-fail reopen)
  move(db, "a", "In Progress", "In Review", T - 21 * DAY);  // In Progress #2 = 3d → total 6d
  move(db, "a", "In Review", "Done", T - 19 * DAY);         // In Review #2 = 2d → total 3d; Done trailing (uncounted)
  const s = stageOf(activityPage(db, "p", "k", T));
  const todoV = s.slice(s.indexOf("queue-wait"), s.indexOf("build"));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  const irV = s.slice(s.indexOf("verify-lag"));
  ok(s.includes("Time in stage"), "DL-84 AC1: a 'Time in stage' section renders on /activity");
  ok(s.includes("queue-wait") && s.includes("build") && s.includes("verify-lag"),
    "DL-84 AC1/AC5: Todo=queue-wait, In Progress=build, In Review=verify-lag labels (In Review meaning is unambiguous)");
  ok(ipV.includes("6d 0h"), "DL-84 AC3: In Progress is SUMMED across re-entered intervals (3d + 3d = 6d), not last/first-wins");
  ok(irV.includes("3d 0h"), "DL-84 AC3: In Review summed across re-entered intervals (1d + 2d = 3d), Done trailing not counted");
  ok(todoV.includes("1d 0h"), "DL-84 AC3: Todo queue-wait = create→first-move = 1d");
  ok(todoV.includes("n 1<") && ipV.includes("n 1<") && irV.includes("n 1<"), "DL-84 AC2: each median shows the EXACT n it is computed over (n 1, pinned to the boundary not a prefix)");
  db.close();
}

// ── (b) skipped stage → "—": B goes Todo→In Progress→Done, never entering In Review ──
{
  const db = seedDb("/tmp/dl-cs-skip.db");
  create(db, "b", T - 10 * DAY);                            // → Todo
  move(db, "b", "Todo", "In Progress", T - 9 * DAY);        // Todo = 1d
  move(db, "b", "In Progress", "Done", T - 7 * DAY);        // In Progress = 2d; In Review NEVER entered
  const s = stageOf(activityPage(db, "p", "k", T));
  const todoV = s.slice(s.indexOf("queue-wait"), s.indexOf("build"));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  const irV = s.slice(s.indexOf("verify-lag"));
  ok(todoV.includes("1d 0h") && ipV.includes("2d 0h"), "DL-84 AC4: the stages the ticket actually had compute (Todo 1d, In Progress 2d)");
  ok(irV.includes("no data") && !todoV.includes("no data") && !ipV.includes("no data"),
    "DL-84 AC4: a skipped stage (In Review never entered) renders '—', not a fake 0");
  db.close();
}

// ── (c1) empty window → all three "—": activity exists but nothing reached Done ──
{
  const db = seedDb("/tmp/dl-cs-empty.db");
  move(db, "z", "Todo", "In Progress", T - 1 * DAY);        // activity, but no Done → no recently-Done ticket
  const s = stageOf(activityPage(db, "p", "k", T));
  const n = (s.match(/no data/g) || []).length;
  ok(n === 3, "DL-84 AC4: empty window (no recently-Done ticket) → all three stages render '—' (no data ×3), never a divide-by-zero");
  db.close();
}

// ── (c2) malformed row skipped, never breaks: a bad-JSON transition is dropped, valid stages still compute ──
{
  const db = seedDb("/tmp/dl-cs-malformed.db");
  create(db, "m", T - 12 * DAY);                            // → Todo
  move(db, "m", "Todo", "In Progress", T - 11 * DAY);       // Todo = 1d
  move(db, "m", "In Progress", "In Review", T - 8 * DAY);   // In Progress = 3d
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','m','dev','issue.transition',?,?)")
    .run("{not json", isoOf(T - 7 * DAY));                  // malformed → eventData {} → bounds the In Review interval, then state unknown
  move(db, "m", "In Review", "Done", T - 5 * DAY);          // valid Done → m IS in the recently-Done window
  const s = stageOf(activityPage(db, "p", "k", T));         // must not throw — the page renders
  const todoV = s.slice(s.indexOf("queue-wait"), s.indexOf("build"));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  const irV = s.slice(s.indexOf("verify-lag"));
  ok(todoV.includes("1d 0h") && ipV.includes("3d 0h"),
    "DL-84 AC4: a malformed event row is skipped, never breaks the metric — the valid stages still compute (Todo 1d, In Progress 3d)");
  ok(irV.includes("1d 0h"),
    "DL-84 AC4: the malformed row's timestamp still BOUNDS the prior In Review interval (1d); only the post-malformed segment with an undefined state is dropped");
  db.close();
}

// ── median across multiple tickets — even-n branch AND median≠mean: In Progress {1,2,4,9}d →
//    median = (2d + 4d)/2 = 3d, mean = 4d. Asserting 3d (and NOT 4d) discriminates a true median from a mean. ──
{
  const db = seedDb("/tmp/dl-cs-median.db");
  for (const [tid, ipDays] of [["p1", 1], ["p2", 2], ["p3", 4], ["p4", 9]] as const) {
    create(db, tid, T - 20 * DAY);
    move(db, tid, "Todo", "In Progress", T - 19 * DAY);             // Todo = 1d each
    move(db, tid, "In Progress", "In Review", T - (19 - ipDays) * DAY); // In Progress = ipDays
    move(db, tid, "In Review", "Done", T - (18 - ipDays) * DAY);    // In Review = 1d each
  }
  const s = stageOf(activityPage(db, "p", "k", T));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  ok(ipV.includes("3d 0h") && ipV.includes("n 4<") && !ipV.includes("4d 0h"),
    "DL-84 AC1/AC2: In Progress MEDIAN across 4 tickets {1,2,4,9}d = (2+4)/2 = 3d (even-n branch), NOT the mean 4d; n 4");
  db.close();
}

console.log(fails === 0 ? "\nCYCLE_STAGE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
