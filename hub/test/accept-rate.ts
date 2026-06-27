// DL-79 — /activity acceptance-rate metric: Done ÷ (Done + verify-fail Cancels), 7d + 30d windows, <50% flag,
// neutral empty-state. A pure unit test of activityPage (daemonviews.ts): synthesize issue.transition events in
// a temp SoR db, call the renderer with an injected nowMs (no daemon, no network), and assert the rendered HTML
// fragment for each AC. A verify-fail Cancel is precisely an In Review → Canceled transition (the §3 verify-fail
// close+follow-up always leaves that edge); an ordinary Cancel (Todo/Backlog → Canceled) must NOT count toward
// the denominator. Deterministic: events are placed at controlled created_at relative to a fixed nowMs anchor.
import { openDb } from "../src/db.ts";
import { activityPage } from "../src/daemonviews.ts";
import { rmSync } from "node:fs";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
type DB = ReturnType<typeof openDb>;
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const isoOf = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const T = Date.parse("2026-06-20T12:00:00Z"); // fixed nowMs anchor (injected → pure/testable, AC4)

function seedDb(path: string): DB {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  return db;
}
const trans = (db: DB, from: string, to: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
    .run(JSON.stringify({ from, to }), isoOf(ms));
const done = (db: DB, ms: number) => trans(db, "In Review", "Done", ms);
const verifyFail = (db: DB, ms: number) => trans(db, "In Review", "Canceled", ms); // §3 verify-fail close edge

// ── healthy (≥50%): 3 Done + 1 verify-fail (all in 7d) → 75%, no warning ──
{
  const db = seedDb("/tmp/dl-ar-healthy.db");
  done(db, T - 1 * DAY); done(db, T - 2 * DAY); done(db, T - 3 * DAY);
  verifyFail(db, T - 4 * DAY);
  const html = activityPage(db, "p", "k", T);
  ok(html.includes("Acceptance rate"), "DL-79 AC1: an acceptance-rate section renders on /activity");
  ok(html.includes("75%"), "DL-79 AC1/AC2: rate = Done ÷ (Done+verify-fail) = 3/4 = 75%");
  ok(html.includes("Done 3 · verify-fail 1"), "DL-79 AC2: raw counts shown for audit (Done 3 · verify-fail 1)");
  ok(!html.includes('class="warn"'), "DL-79 AC3: a healthy (≥50%) rate carries NO <50% warning flag");
  db.close();
}

// ── two windows (AC1 "existing window(s)"): 7d differs from 30d, both render ──
// 7d: 2 Done + 2 fail = 50% (boundary → NOT flagged); 30d adds a Done 10d ago → 3 Done + 2 fail = 60%.
{
  const db = seedDb("/tmp/dl-ar-windows.db");
  done(db, T - 1 * DAY); done(db, T - 2 * DAY);
  verifyFail(db, T - 3 * DAY); verifyFail(db, T - 4 * DAY);
  done(db, T - 10 * DAY); // inside 30d, outside 7d → lifts only the 30d numerator
  const html = activityPage(db, "p", "k", T);
  ok(html.includes("50%"), "DL-79 AC1: 7d window rate = 2/4 = 50% (boundary, not flagged)");
  ok(html.includes("60%"), "DL-79 AC1: 30d window rate = 3/5 = 60% (a 30d-only Done lifts it) — both windows render");
  ok(!html.includes('class="warn"'), "DL-79 AC3: exactly 50% is the break-even, NOT < 50% → no flag");
  db.close();
}

// ── <50% flag: 1 Done + 3 verify-fail (all in 7d) → 25%, warning state ──
{
  const db = seedDb("/tmp/dl-ar-low.db");
  done(db, T - 1 * DAY);
  verifyFail(db, T - 2 * DAY); verifyFail(db, T - 3 * DAY); verifyFail(db, T - 4 * DAY);
  const html = activityPage(db, "p", "k", T);
  ok(html.includes("25%"), "DL-79 AC1: rate = 1/4 = 25%");
  ok(html.includes('class="warn"'), "DL-79 AC3: a <50% rate is flagged with a visible warning state");
  ok(html.includes("Done 1 · verify-fail 3"), "DL-79 AC2: raw counts shown (Done 1 · verify-fail 3)");
  db.close();
}

// ── only In Review→Canceled counts: an ordinary Cancel (Todo/Backlog→Canceled) is excluded ──
{
  const db = seedDb("/tmp/dl-ar-ordinary.db");
  done(db, T - 1 * DAY);
  trans(db, "Todo", "Canceled", T - 2 * DAY);    // ordinary cancel — NOT a verify-fail
  trans(db, "Backlog", "Canceled", T - 3 * DAY); // ditto
  const html = activityPage(db, "p", "k", T);
  ok(html.includes("100%") && html.includes("Done 1 · verify-fail 0"),
    "DL-79 AC1: only In Review→Canceled is a verify-fail; Todo/Backlog→Canceled excluded (rate 1/1 = 100%)");
  db.close();
}

// ── empty-state: no Done and no verify-fail → neutral "no data", no fake 0%, no divide-by-zero ──
{
  const db = seedDb("/tmp/dl-ar-empty.db");
  trans(db, "Todo", "In Progress", T - 1 * DAY); // activity, but nothing Done and nothing verify-failed
  const html = activityPage(db, "p", "k", T);
  ok(html.includes("Acceptance rate") && html.includes("no data"), "DL-79 AC3: zero-denominator window → neutral 'no data'");
  ok(!/\d%/.test(html), "DL-79 AC3: empty-state shows no numeric rate (no fake 0%, no divide-by-zero)");
  db.close();
}

// ── a malformed event row is skipped, never breaks the metric (AC4 / DL-17 AC5) ──
{
  const db = seedDb("/tmp/dl-ar-malformed.db");
  done(db, T - 1 * DAY);
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
    .run("{not json", isoOf(T - 2 * DAY));
  const html = activityPage(db, "p", "k", T);
  ok(html.includes("100%") && html.includes("Done 1 · verify-fail 0"), "DL-79 AC4: a malformed event row is skipped, never breaks the metric");
  db.close();
}

console.log(fails === 0 ? "\nACCEPT_RATE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
