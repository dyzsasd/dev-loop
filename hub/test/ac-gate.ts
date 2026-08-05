// LOOP-198 — the COMPLETENESS axis of acceptance.
//
// The board already gates the IDENTITY axis: LOOP-157 refuses a two-hop In Review→Done self-accept,
// because a builder tier cannot verify its own work. Nothing gated completeness.
//
// LOOP-153 listed three deliverables. B and C landed; A did not — and it went Done anyway. The
// consequence compounded: SIGINT-killed fires stayed subtracted from successRate, and the
// reported-vs-true gap grew from 3.4 points to 6.7 with every operator restart, permanently, for
// every consumer of that number. The unchecked box was sitting in the ticket body, in a
// machine-readable format, at the moment of the transition.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";
import { parseAcBoxes, waiverReason, acCompletenessRejection } from "../src/ac-gate.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-acgate-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const THREE = "## Acceptance criteria\n\n- [x] **AC1** — the first thing\n- [x] **AC2** — the second\n- [ ] **AC3** — the third, which did not land\n";
const ALL_DONE = THREE.replace("- [ ] **AC3**", "- [x] **AC3**");

try {
  // ── the parser ────────────────────────────────────────────────────────────────────────────────
  ok(parseAcBoxes(THREE).length === 3, "LOOP-198: three checkboxes parse");
  ok(parseAcBoxes(THREE).filter((b) => !b.checked).length === 1, "LOOP-198: …one of them unchecked");
  ok(parseAcBoxes("no boxes here at all").length === 0, "LOOP-198 AC1: a body with NO checkboxes parses to zero — no opinion");
  ok(parseAcBoxes("  - [X] upper-case X counts\n* [ ] a star bullet counts").length === 2,
    "LOOP-198: indentation, `*` bullets and an upper-case X are all recognised");

  // ── the waiver ────────────────────────────────────────────────────────────────────────────────
  ok(waiverReason(["AC-waived: AC3 — deferred to LOOP-999, agreed with PM"]) !== null,
    "LOOP-198 AC3: a waiver WITH a reason is accepted");
  ok(waiverReason(["AC-waived: AC3"]) === null,
    "LOOP-198 AC3: a waiver with NO reason is refused — that is the silent close wearing a marker");
  ok(waiverReason(["AC-waived: 3 —   "]) === null, "LOOP-198 AC3: …and a blank reason likewise");
  ok(waiverReason(["discussion of the AC-waived: x — y format mid-sentence"]) === null,
    "LOOP-198: a marker QUOTED mid-sentence does not waive — it must be a bare line, like every other marker here");

  // ── the gate ─────────────────────────────────────────────────────────────────────────────────
  const gate = (description: string, opts: { actor?: string; toState?: string; fromState?: string; comments?: string[]; enabled?: boolean } = {}) =>
    acCompletenessRejection({
      id: "T-1", description, toState: opts.toState ?? "Done", fromState: opts.fromState ?? "In Review",
      actor: opts.actor ?? "qa", commentBodies: opts.comments ?? [], enabled: opts.enabled ?? true,
    });

  ok(gate(ALL_DONE) === null, "LOOP-198 AC4: all boxes checked ⇒ allowed");
  ok(gate("a body with no acceptance criteria") === null, "LOOP-198 AC4: no checkboxes ⇒ allowed");
  const refused = gate(THREE);
  ok(refused !== null, "LOOP-198 AC2/AC4: one unchecked ⇒ REFUSED");
  ok(/AC3/.test(refused ?? "") && /did not land/.test(refused ?? ""),
    `LOOP-198 AC2: …naming the unchecked AC's TEXT (${refused?.slice(0, 120)})`);
  ok(/AC-waived/.test(refused ?? ""), "LOOP-198 AC2: …and the override mechanism");
  ok(/^verify gate:/.test(refused ?? ""), "LOOP-198 AC2: …in the same shape as the existing gates");
  ok(gate(THREE, { comments: ["AC-waived: AC3 — deferred to LOOP-999, agreed with PM"] }) === null,
    "LOOP-198 AC4: unchecked + a valid waiver ⇒ allowed");
  ok(gate(THREE, { comments: ["AC-waived: AC3"] }) !== null,
    "LOOP-198 AC4: …but unchecked + a reasonless waiver is still refused");

  // AC4's scope guard: this must never fire on a transition other than → Done.
  for (const to of ["Todo", "In Progress", "In Review", "Canceled", "Human-Blocked"]) {
    ok(gate(THREE, { toState: to }) === null, `LOOP-198 AC4: the gate never fires on → ${to}`);
  }
  ok(gate(THREE, { fromState: "Done" }) === null, "LOOP-198: …nor on a Done → Done no-op write");
  ok(gate(THREE, { actor: "operator" }) === null,
    "LOOP-198: the operator is exempt — the console IS the human ruling this gate stands in for");

  // OPT-IN, and AC5's measurement is why. Run over this board's 276 Done rows: 253 carry at least
  // one checkbox and 247 of those would have been REFUSED — many with every box unchecked (7/7,
  // 9/9), zero with a waiver. That is not 247 incomplete tickets; it is the convention. The boxes are
  // written and never ticked, so an unchecked box carries no completeness signal here, and a gate on
  // it refuses ~98% of closes. That is a wall, not a gate, and its first product is a reflex waiver
  // on every ticket — strictly worse than no gate. The mechanism ships; enforcement waits on the
  // convention.
  ok(gate(THREE, { enabled: false }) === null,
    "LOOP-198 AC5: the gate is INERT unless team.intake.acCompletenessGate is true");
  ok(acCompletenessRejection({ id: "T", description: THREE, toState: "Done", fromState: "In Review", actor: "qa", commentBodies: [] }) === null,
    "LOOP-198 AC5: …and `enabled` absent means off — a caller that never heard of this flag cannot be broken by it");

  // ── through the REAL write path ──────────────────────────────────────────────────────────────
  // The predicate passing proves nothing about whether the gate is wired.
  {
    const db = openDb(join(tmp, "hub.db"));
    ensureSeed(db, "ac", "AC Gate", "AC");
    const pid = findProject(db, "ac")!;
    const mk = (id: string, description: string) =>
      db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t',?,'Bug','In Review','qa',2,'[\"dev-loop\",\"Bug\",\"qa\"]','[]','pm','t','t')")
        .run(id, pid, description);
    const close = (id: string): { ok: boolean; error: string } => {
      const r = agentOp("save_issue", db, pid, "ac", "qa", { id, state: "Done" }) as OpResult;
      const good = r.status >= 200 && r.status < 300;
      return { ok: good, error: good ? "" : JSON.stringify(r.body) };
    };

    // This fixture has no workspace, so the flag resolves to its default (off) — which is the
    // shipped posture, and worth asserting as the wiring test's own subject: the gate must not fire
    // for a caller that never opted in.
    mk("AC-1", THREE);
    ok(close("AC-1").ok,
      "LOOP-198: with the flag unset, an unchecked ticket closes through the REAL save_issue path — shipped inert");
    mk("AC-2", ALL_DONE);
    ok(close("AC-2").ok, "LOOP-198: …as does a fully-checked one");
    db.close();
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nAC_GATE_OK");
process.exit(fails ? 1 : 0);
