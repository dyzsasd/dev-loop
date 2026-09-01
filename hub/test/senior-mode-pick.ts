// senior-mode-pick.ts — the `Mode:` marker is a LINE, not a first line.
//
// Measured on a live board: two senior-dev fires (15:01→15:06, 15:11→15:16) wrote nothing to the
// board, shipped no code and left no report, the agent explaining that the direct-code job it was
// launched for matched neither of its preconditions. Every 5 minutes, ~$1.42 a time, and invisible in
// `status` — a fire that does nothing still exits 0, so the no-op rate never counted it.
//
// seniorDevModePick read the marker as `description.trimStart().startsWith("Mode: …")`. Of 86 tickets
// on that board, 9 carried a marker and ZERO had it on the first line: every body written to
// references/ticket-templates.md opens with `## Context`, so the marker is always below it. The
// branch could not fire, so every pick fell through to the guess — `relatedTo.length > 0 ⇒
// directcode` — and JBU-13, a design parent whose relatedTo names a live sibling (JBU-8), was
// launched with the direct-code corpus forever. It is Urgent and blocks most of the senior backlog.
//
// The convention was never that strict: two-tier-dev.md says "a `Mode: design` / `Mode: direct-code`
// description LINE". The code was stricter than the spec, and the strict reading was unsatisfiable by
// the project's own templates.
import { realpathSync, rmSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { modeMarkerOf } from "../src/design-parent.ts";
import { seniorDevModePick } from "../src/servable.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-smp-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const db = openDb(join(tmp, "hub.db"));
const PID = "p1";
db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)").run(PID, "jbu", "n", "t");
let seq = 0;
/** A servable senior-dev Todo, as the board stores it. */
const add = (description: string, relatedTo: string[] = [], opts: { id?: string; state?: string; labels?: string[] } = {}): string => {
  const id = opts.id ?? `JBU-${++seq}`;
  db.prepare(
    "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at)"
    + " VALUES(?,?,?,?,'Feature',?,?,0,?,?,'pm',?,?)",
  ).run(id, PID, `t-${id}`, description, opts.state ?? "Todo", "senior-dev",
    JSON.stringify(opts.labels ?? ["dev-loop", "senior-dev"]), JSON.stringify(relatedTo),
    `2026-08-29T10:00:${String(seq).padStart(2, "0")}Z`, "t");
  return id;
};
const clear = () => db.prepare("DELETE FROM tickets WHERE project_id=?").run(PID);
// Every fixture below leaves exactly ONE servable senior-dev Todo, so the arm measures the ticket it
// names. Written after the first draft did not: two servable Todos are ranked by created_at, so the
// context ticket was picked and the headline assertion passed while never reading the marker at all.
// Context tickets are therefore parked in a state the servable filter excludes (Backlog / Canceled),
// which is also how they look on a real board.
const pick = () => seniorDevModePick(db, PID);

try {
  // ── The marker reader, on its own ────────────────────────────────────────────────────────────────
  ok(modeMarkerOf("## Context\nMode: design-and-delegate\nwhy this matters") === "design",
    "a marker below `## Context` is read — the shape every template produces");
  ok(modeMarkerOf("Mode: design") === "design", "…and one on the first line still is");
  ok(modeMarkerOf("## Context\nMode: direct-code\n") === "directcode", "direct-code likewise");
  ok(modeMarkerOf("  Mode: direct-code  \n") === "directcode", "surrounding whitespace does not hide it");
  ok(modeMarkerOf("## Context\nthe Mode: design decision was made earlier in the thread") === null,
    "a marker MENTIONED in prose is not a marker — the match is a whole line");
  ok(modeMarkerOf("## Context\nno marker here") === null, "a body that declares nothing declares nothing");

  // ── JBU-13's exact shape: marker under ## Context, relatedTo non-empty ───────────────────────────
  {
    clear();
    add("## Context\nRuntime design parent.\n", [], { id: "JBU-8", state: "Backlog" });
    add("## Context\nMode: design-and-delegate\n\n## Acceptance criteria\n- [ ] a design doc exists", ["JBU-8"], { id: "JBU-13" });
    ok(pick() === "design",
      `JBU-13's real shape — marker under ## Context, relatedTo ["JBU-8"] — picks design (got ${pick()})`);
  }

  // ── The other marker, same placement ─────────────────────────────────────────────────────────────
  {
    clear();
    add("## Context\nMode: direct-code\n\n## Acceptance criteria\n- [ ] the fix ships", []);
    ok(pick() === "directcode", `a direct-code marker under ## Context picks directcode (got ${pick()})`);
  }

  // ── No marker: the guess, and its direction ──────────────────────────────────────────────────────
  {
    clear();
    add("## Context\nplain work, no marker, no relations", []);
    ok(pick() === "design", `no marker + no relations ⇒ design, the normal complex path (got ${pick()})`);
  }
  {
    // The §21a escalation shape the convention names: relatedTo a CANCELED `review failed:`
    // predecessor. That — not "has any relation" — is what makes a ticket direct-code work.
    clear();
    add("## Context\njunior's attempt", [], { id: "JBU-90", state: "Canceled" });
    add("## Context\nreview failed: superseded by this follow-up", ["JBU-90"], { id: "JBU-91" });
    ok(pick() === "directcode", `no marker + a CANCELED predecessor ⇒ directcode (got ${pick()})`);
  }
  {
    // The case that broke JBU-13, with the marker removed so only the guess decides: relatedTo also
    // carries §4 splits and §15 coverage siblings, and a LIVE sibling is not an escalation.
    clear();
    add("## Context\na live sibling", [], { id: "JBU-8", state: "Backlog" });
    add("## Context\nsplit from JBU-8, no marker", ["JBU-8"], { id: "JBU-14" });
    ok(pick() === "design", `no marker + a LIVE relation ⇒ design, not directcode (got ${pick()})`);
  }

  // ── A design parent is a design however its relations look ──────────────────────────────────────
  {
    clear();
    add("## Context\nthe parent, marker stripped", [], { id: "JBU-20" });
    add("## Context\nDesign: parent JBU-20\nstaged child", ["JBU-20"], { id: "JBU-21", state: "Backlog" });
    add("## Context\nescalation-looking relation", ["JBU-99"], { id: "JBU-22", state: "Canceled" });
    ok(pick() === "design", `a ticket with staged children picks design via the shared predicate (got ${pick()})`);
  }

  // ── Nothing to pick ─────────────────────────────────────────────────────────────────────────────
  { clear(); ok(pick() === "design", "an empty board picks design"); }
} finally {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nSENIOR_MODE_PICK_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
