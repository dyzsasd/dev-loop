// LOOP-113 / LOOP-68 / LOOP-321 — three defects of OMISSION.
//
// None of these is a wrong answer. Each is a surface that enumerated some of its input and let the
// rest through by silence: three of eight board states, two of the event kinds that change a ticket,
// and a returned flag that was destructured and then never read. Silence reads as a decision, and in
// all three cases the thing left out was the consequential one.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMergeEligible, MERGE_ELIGIBILITY_STATES } from "../src/merge-guard.ts";
import { dependencyGraph } from "../src/dependency-graph.ts";
import { liveBlockerIds } from "../src/blocked-by.ts";
import { ticketPage } from "../src/views/ticket.ts";
import { openDb, STATES } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-omission-")));

try {
  // ── LOOP-113: every board state is ENUMERATED, not eligible by omission ───────────────────────
  {
    // The exhaustiveness check: db.ts is the declared single source of the legal state set, and the
    // guard's map must cover all of it. Adding a ninth state now fails HERE rather than silently
    // defaulting to merge-eligible, which is how Human-Blocked became mergeable in the first place.
    const missing = STATES.filter((s: string) => !MERGE_ELIGIBILITY_STATES.includes(s));
    ok(missing.length === 0, `LOOP-113: every db.ts state is enumerated in the guard${missing.length ? ` — missing: ${missing.join(", ")}` : ` (${STATES.length} states)`}`);

    ok(!isMergeEligible("Human-Blocked").eligible,
      "LOOP-113: Human-Blocked is NOT merge-eligible — it is the operator's decision queue itself");
    ok(/decision queue/.test(isMergeEligible("Human-Blocked").why),
      "LOOP-113: …and the map says WHY, so the next reader does not have to re-derive it");
    for (const s of ["In Review", "Canceled", "Duplicate"])
      ok(!isMergeEligible(s).eligible, `LOOP-113: ${s} still trips — the three original states are unchanged`);
    for (const s of ["Backlog", "Todo", "In Progress", "Done"])
      ok(isMergeEligible(s).eligible, `LOOP-113: ${s} stays merge-eligible — this widens the guard, it does not block normal work`);
    // §3.4's fail-open is preserved: an unrecognised state must never become a merge freeze.
    ok(isMergeEligible("SomeFutureState").eligible && /failing open/.test(isMergeEligible("SomeFutureState").why),
      "LOOP-113: an UNKNOWN state fails open with a stated reason (§3.4 — an outage must not freeze merges)");
  }

  // ── shared fixture for the two board-surface checks ──────────────────────────────────────────
  const db = openDb(join(tmp, "hub.db"));
  ensureSeed(db, "om", "Omission", "OM");
  const pid = findProject(db, "om")!;
  const T = "OM-1";
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t','d','Improvement','Todo','junior-dev',2,'[\"dev-loop\"]','[]','pm',?,?)")
    .run(T, pid, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  const ev = (kind: string, data: unknown, at: string, actor = "pm") =>
    db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,?,?,?,?)")
      .run(pid, T, actor, kind, JSON.stringify(data), at);
  ev("issue.create", {}, "2026-08-01T00:00:00.000Z");
  ev("issue.transition", { from: "Backlog", to: "Todo" }, "2026-08-01T01:00:00.000Z");
  // The §9c park and unpark — the two moves that were invisible.
  ev("issue.update", { labelsBefore: ["dev-loop"], labels: ["dev-loop", "blocked"] }, "2026-08-01T02:00:00.000Z");
  ev("issue.update", { labelsBefore: ["dev-loop", "blocked"], labels: ["dev-loop"] }, "2026-08-01T03:00:00.000Z");
  // A tier re-route, by assignee.
  ev("issue.update", { assignee: "senior-dev" }, "2026-08-01T04:00:00.000Z", "sweep");
  // An update carrying nothing an operator steers with — must render NOTHING, not an empty row.
  ev("issue.update", {}, "2026-08-01T05:00:00.000Z");

  // ── LOOP-68: the timeline shows the loop's most consequential moves ──────────────────────────
  {
    const html = ticketPage(db, pid, "om", T, false, { nowMs: Date.parse("2026-08-02T00:00:00.000Z") }) as unknown as string;
    const page = typeof html === "string" ? html : JSON.stringify(html);
    ok(/created this ticket/.test(page) && /moved/.test(page), "LOOP-68 control: create and transition still render");
    ok(/\+<span class="lbl">blocked<\/span>/.test(page), "LOOP-68: the §9c PARK renders — a label going on is an issue.update");
    ok(/−<span class="lbl">blocked<\/span>/.test(page), "LOOP-68: the §9c UNPARK renders — a ticket could sit parked six fires and show nothing");
    ok(/assignee → <b>senior-dev<\/b>/.test(page), "LOOP-68: a cross-tier re-route renders (Sweep's §21b repairs are issue.updates too)");
    const updateRows = (page.match(/tl-update/g) ?? []).length;
    ok(updateRows === 3, `LOOP-68: the EMPTY update renders nothing — a bare row is noise, not history (got ${updateRows} update rows, want 3)`);
    ok(!/comment\.add/.test(page), "LOOP-68: comment.add stays excluded — bodies are interleaved from the comments table, so selecting both would double-render");
  }

  // ── LOOP-321: a partial read is never reported as unpark-eligible ────────────────────────────
  {
    const B = "OM-2";
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'blocker','d','Bug','Done',2,'[]','[]','pm',?,?)")
      .run(B, pid, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    const P = "OM-3";
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'parked','d','Improvement','Todo',2,'[\"dev-loop\",\"blocked\"]','[]','pm',?,?)")
      .run(P, pid, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    const comment = (id: string, body: string) =>
      db.prepare("INSERT INTO comments(ticket_id,author,body,created_at) VALUES(?,?,?,?)").run(id, "pm", body, "2026-08-01T06:00:00.000Z");

    // Control: a complete read of a resolved blocker IS unpark-eligible.
    comment(P, `Blocked-by: ${B}`);
    const clean = dependencyGraph(db, pid) as { integrity: Record<string, { unparkEligible: boolean; hadReadFailure: boolean }> };
    ok(clean.integrity[P]?.unparkEligible === true,
      "LOOP-321 control: a COMPLETE read whose only blocker is Done is unpark-eligible");
    ok(clean.integrity[P]?.hadReadFailure === false, "LOOP-321: …and it reports no read failure");

    // The defect, tested at the layer where the signal EXISTS. `partial` is a property the caller
    // attaches to a comment record, not something in the body text — and dependency-graph's own read
    // is a bare `SELECT body FROM comments`, so today it cannot produce partial:true. That is worth
    // stating rather than dressing up: this fix is a GUARD on the decision path for the read layer
    // that will mark partial reads, plus the parser half asserted here directly.
    const partialParse = liveBlockerIds([{ body: `Blocked-by: ${B}` }, { body: "trunc", partial: true }]);
    ok(partialParse.hadReadFailure === true,
      "LOOP-321: liveBlockerIds RETURNS the read-failure flag — the value dependency-graph was discarding");
    ok(!partialParse.live.has("OM-9"),
      "LOOP-321: …and a partial comment's body is skipped, so a surviving marker cannot pose as a complete ledger");

    const graph = dependencyGraph(db, pid) as { integrity: Record<string, { unparkEligible: boolean; hadReadFailure: boolean }> };
    ok("hadReadFailure" in (graph.integrity[P] ?? {}),
      "LOOP-321: every integrity row now REPORTS its read completeness — the surface can no longer render a partial read as a complete one");
    ok(graph.integrity[P]?.hadReadFailure === false && graph.integrity[P]?.unparkEligible === true,
      "LOOP-321: a genuinely complete read is unaffected — this adds a gate, it does not park healthy work");
  }
  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nOMISSION_DEFECTS_OK");
process.exit(fails ? 1 : 0);
