// LOOP-165 / LOOP-143 / LOOP-342 — the board READ paths stop answering a different question than
// the one they were asked.
//
// All three are the same failure mode on the same surface: a read that silently returns something
// other than what the caller requested, with exit 0, in a shape byte-indistinguishable from a
// correct answer. That is worse than an error, because the caller acts on it.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentOp, type OpResult } from "../src/agentops.ts";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-readpath-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const db = openDb(join(tmp, "hub.db"));
  ensureSeed(db, "rp", "ReadPath", "RP");
  const pid = findProject(db, "rp")!;
  const call = (op: string, args: Record<string, unknown>): OpResult =>
    agentOp(op as Parameters<typeof agentOp>[0], db, pid, "rp", "pm", args) as OpResult;

  // A board LARGER than the 250 cap — the condition under which the defect appears at all.
  const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,'Improvement','Backlog',3,'[]','[]','pm',?,?)");
  const TOTAL = 300;
  for (let i = 0; i < TOTAL; i++) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(); // ascending ⇒ i=0 is the STALEST
    ins.run(`RP-${i}`, pid, i === 7 ? "the needle ticket" : `filler ${i}`, "d", ts, ts);
  }

  // ── LOOP-342: 250 returned rows were byte-indistinguishable from a 250-ticket board ───────────
  {
    const bare = call("list_issues", {});
    ok(Array.isArray(bare.body) && (bare.body as unknown[]).length === 250,
      `LOOP-342: the default cap still applies (got ${(bare.body as unknown[]).length})`);
    const env = call("list_issues", { envelope: true }).body as { total: number; returned: number; hasMore: boolean; items: unknown[] };
    ok(env.total === TOTAL && env.returned === 250 && env.hasMore === true,
      `LOOP-342: envelope:true makes truncation detectable in-band — total ${env.total}, returned ${env.returned}, hasMore ${env.hasMore}`);
    // MUTATION CHECK for AC3: the assertion must depend on the SIGNAL, not merely on the row count.
    // With hasMore forced false the line above goes red, so it is not a tautology.
    ok(env.hasMore !== (env.total === env.returned), "LOOP-342: hasMore is derived from total vs returned, not hardcoded");
    const full = call("list_issues", { limit: 1000, envelope: true }).body as { hasMore: boolean; returned: number };
    ok(full.returned === TOTAL && full.hasMore === false, "LOOP-342: a caller that asks for everything is told there is no more");

    // The hidden rows are the STALEST — the population every census scan is looking for.
    const ids = (bare.body as Array<{ id: string }>).map((t) => t.id);
    ok(!ids.includes("RP-0"), "LOOP-342: the capped read really does hide the oldest rows (order is updated_at DESC)");
  }

  // ── LOOP-165: an unknown arg is REFUSED, not ignored ─────────────────────────────────────────
  {
    const r = call("list_issues", { zzz_bogus: "foo" });
    ok(r.status === 400 && /unknown argument 'zzz_bogus'/.test(JSON.stringify(r.body)),
      `LOOP-165: an unknown arg is a 400 naming the key, not a silent full board (got ${r.status})`);
    const many = call("list_issues", { nope: 1, alsoNope: 2 });
    ok(/unknown arguments/.test(JSON.stringify(many.body)), "LOOP-165: the message pluralises and names every offending key");
    ok(call("list_issues", { project: "rp" }).status === 200, "LOOP-165: `project` (the routing key every op carries) is never an unknown arg");

    // `q` is ACCEPTED as an alias — the CLI flag is spelled --q, so the op refusing the same spelling
    // would be a papercut. The filter must provably FILTER (a row-count assertion, not a smoke call).
    const unfiltered = (call("list_issues", { limit: 1000 }).body as unknown[]).length;
    const viaQ = (call("list_issues", { q: "needle", limit: 1000 }).body as unknown[]).length;
    const viaQuery = (call("list_issues", { query: "needle", limit: 1000 }).body as unknown[]).length;
    ok(viaQ === 1 && viaQuery === 1 && unfiltered === TOTAL,
      `LOOP-165: q and query both filter to the 1 matching row (q=${viaQ}, query=${viaQuery}, unfiltered=${unfiltered})`);
    ok(call("list_issues", { q: "zzzqqqxxx_no_such_string", limit: 1000 }).body instanceof Array
      && (call("list_issues", { q: "zzzqqqxxx_no_such_string", limit: 1000 }).body as unknown[]).length === 0,
      "LOOP-165: an impossible term returns ZERO rows — it used to return the entire board");
  }

  // ── LOOP-143: the event feed has an upper bound, so the cap is a PAGE SIZE not a ceiling ─────
  {
    const ev = db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)");
    for (let i = 0; i < 120; i++)
      ev.run(pid, "RP-1", "pm", "issue.update", "{}", new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString());

    ok(call("list_events", { until: "not-a-date" }).status === 400, "LOOP-143: a malformed `until` is refused, not ignored");
    ok(call("list_events", { bogusArg: 1 }).status === 400, "LOOP-143: an unknown arg is refused — `until` used to be dropped exactly this way");

    const page1 = call("list_events", { limit: 50, envelope: true }).body as { items: Array<{ created_at: string }>; hasMore: boolean; oldest: string };
    ok(page1.items.length === 50 && page1.hasMore === true, `LOOP-143: page 1 is bounded and reports hasMore (got ${page1.items.length}, hasMore ${page1.hasMore})`);
    // Walk BACKWARDS past the newest page — the thing that was impossible before.
    const page2 = call("list_events", { limit: 50, until: page1.oldest, envelope: true }).body as { items: Array<{ created_at: string }>; hasMore: boolean };
    ok(page2.items.length === 50, `LOOP-143: page 2 reaches rows OLDER than the newest page (got ${page2.items.length})`);
    ok(page2.items[0]!.created_at <= page1.oldest, "LOOP-143: …and every row on it is at or before page 1's oldest");
    ok(page1.items[0]!.created_at !== page2.items[0]!.created_at, "LOOP-143: the two pages are genuinely different rows");
    ok(call("list_events", { limit: 501 }).status === 400, "LOOP-143: the 500 per-call bound is unchanged — it was never the defect");
  }

  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nREAD_PATH_BOUNDS_OK");
process.exit(fails ? 1 : 0);
