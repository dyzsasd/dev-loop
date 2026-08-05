// LOOP-344 + LOOP-345 — the design gate, on both layers, through ONE predicate.
//
// The defect was an INVERSION between two layers that answered the same question differently:
// opQueue put a design parent in pm.verify, while the write layer refused pm and allowed qa. So the
// only ordering the write layer permitted was the one that strands the children — and it stranded
// them silently, with rc=0.
//
// LOOP-344 is the routing half (two of §21a's three pointer forms reached the wrong verifier);
// LOOP-345 is the authorization half (R1 and R2, which must land together).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";

import { designParentIds, isDesignParent, designPointerOf, docSlugOf } from "../src/design-parent.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-designparent-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const db = openDb(join(tmp, "hub.db"));
  ensureSeed(db, "dp", "DesignParent", "DP");
  const pid = findProject(db, "dp")!;

  const mk = (id: string, desc: string, state: string, labels: string[]) =>
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t',?,'Bug',?,2,?,'[]','pm','t','t')")
      .run(id, pid, desc, state, JSON.stringify(labels));
  const queue = (actor: string): { verify: Array<{ id: string }> } =>
    (agentOp("queue", db, pid, "dp", actor, {}) as OpResult).body as { verify: Array<{ id: string }> };
  const inVerify = (actor: string, id: string) => queue(actor).verify.some((t) => t.id === id);
  // Drive the gate through the REAL write path (save_issue), not updateTicketRow directly: the op
  // builds the full resolved field set, which is what the gate reads. Calling the internal helper
  // with a partial object tests a shape no caller produces.
  const setState = (actor: string, id: string, state: string): { ok: boolean; error: string } => {
    const r = agentOp("save_issue", db, pid, "dp", actor, { id, state }) as OpResult;
    const okr = r.status >= 200 && r.status < 300;
    return { ok: okr, error: okr ? "" : JSON.stringify(r.body) };
  };

  // ── LOOP-344: all THREE §21a pointer forms route the parent to PM ─────────────────────────────
  // Row 1 worked before; rows 2 and 3 named the DOC rather than the parent, resolved to nothing, and
  // sent their parents to QA. The parents carry a `qa` label (from their Bug type) and NO
  // `Mode: design` body — the exact shape that made this invisible.
  mk("DP-P1", "a design parent", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C1", "Design: parent DP-P1\n\nchild", "Todo", ["dev-loop"]);

  mk("DP-P2", "the module design\n\nhubDoc:design/widget-engine is the doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C2", "Design: hubDoc:design/widget-engine\n\nchild", "Todo", ["dev-loop"]);

  mk("DP-P3", "the other design\n\ndocs/design/gadget-core.md is the doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C3", "Design: docs/design/gadget-core.md\n\nchild", "Todo", ["dev-loop"]);

  for (const p of ["DP-P1", "DP-P2", "DP-P3"]) {
    ok(inVerify("pm", p), `LOOP-344: ${p} reaches pm.verify — §21a gives design-parent verification to PM`);
    ok(!inVerify("qa", p), `LOOP-344: …and NOT qa.verify — QA has no authority over design coherence`);
  }

  // An ordinary qa-owned Bug with no design pointer anywhere is untouched by all of this.
  mk("DP-ORD", "an ordinary bug", "In Review", ["dev-loop", "Bug", "qa"]);
  ok(inVerify("qa", "DP-ORD") && !inVerify("pm", "DP-ORD"),
    "LOOP-344: an ordinary qa-owned Bug still routes to QA — this widens the design case, it does not re-route everything");

  // The marker binds as a BARE LINE only (the rule Blocked-by:/Unblocked-by: already follow, and the
  // one LOOP-343 corrected the sweep SKILL to state). A ticket QUOTING the marker in prose is not a child.
  ok(designPointerOf("see `Design: parent DP-P1` for the shape") === null,
    "LOOP-344: a marker quoted inside backticks mid-sentence does NOT bind (the LOOP-296 false positive)");
  ok(designPointerOf("Design: parent DP-P1") === "parent DP-P1", "LOOP-344: a bare-line marker binds");
  ok(docSlugOf("hubDoc:design/widget-engine") === docSlugOf("docs/design/widget-engine.md"),
    "LOOP-344: both doc spellings normalise to the same slug");

  // ── LOOP-345 R1: PM may close a design parent ────────────────────────────────────────────────
  // Before: pm was REFUSED ("not the qa verifier-owner") and qa was ALLOWED — the layer that showed
  // the work refused the write, and the layer that permitted it hid the work.
  {
    // Promote DP-C1 out of Backlog first so R2 is not what we are measuring here.
    const r = setState("pm", "DP-P1", "Done");
    ok(r.ok === true, `LOOP-345 R1: 'pm' may close a design parent (got ${r.ok ? "ok" : r.error})`);
  }
  {
    const r = setState("qa", "DP-P2", "Done");
    ok(r.ok === false && /DESIGN PARENT/.test(r.error),
      "LOOP-345 R1: 'qa' may NOT — the type's qa owner label does not decide a design gate");
  }

  // ── LOOP-345 R2: …but not over children still in Backlog ─────────────────────────────────────
  // R1 without R2 would be strictly WORSE than the old behaviour: PM could close the parent AND
  // strand its children, where before PM simply could not close it.
  mk("DP-P4", "another design parent", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C4a", "Design: parent DP-P4\n\nstaged child", "Backlog", ["dev-loop"]);
  mk("DP-C4b", "Design: parent DP-P4\n\nstaged child", "Backlog", ["dev-loop"]);
  {
    const r = setState("pm", "DP-P4", "Done");
    const err = r.error;
    ok(r.ok === false && /still in Backlog/.test(err), `LOOP-345 R2: pm is refused while staged children sit in Backlog (got ${JSON.stringify(err.slice(0, 90))})`);
    ok(/DP-C4a/.test(err) && /DP-C4b/.test(err), "LOOP-345 R2: …and the refusal NAMES every stranded child, so the fix is one read away");
  }
  // Promote them, exactly as §21a's pass action prescribes, and the close goes through.
  for (const c of ["DP-C4a", "DP-C4b"]) setState("pm", c, "Todo");
  {
    const r = setState("pm", "DP-P4", "Done");
    ok(r.ok === true, `LOOP-345 R2: once every child is promoted, pm closes it (got ${r.ok ? "ok" : r.error})`);
  }

  // The operator is never gated by §21a routing.
  mk("DP-P5", "operator path", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C5", "Design: parent DP-P5\n\nstaged", "Backlog", ["dev-loop"]);
  ok(setState("operator", "DP-P5", "Done").ok === true,
    "LOOP-345: the operator is not gated by §21a routing");

  // And an ORDINARY ticket's existing gate is untouched — this adds a design rule, it does not
  // rewrite the ownership rule underneath it.
  ok(setState("junior-dev", "DP-ORD", "Done").ok === false,
    "LOOP-345: the existing owner gate still refuses a non-owner on an ordinary ticket");
  ok(setState("qa", "DP-ORD", "Done").ok === true,
    "LOOP-345: …and still allows its qa owner");

  // The two layers now agree, which is the whole point of sharing the predicate.
  {
    const rows = db.prepare("SELECT id, description, state FROM tickets WHERE project_id=?")
      .all(pid) as unknown as Array<{ id: string; description: string; state: string }>;
    const ids = designParentIds(db, pid, rows);
    ok(["DP-P1", "DP-P2", "DP-P3", "DP-P4", "DP-P5"].every((p) => isDesignParent({ id: p, description: "" }, ids)),
      "LOOP-344: every parent form resolves through the ONE shared predicate both layers call");
    ok(!isDesignParent({ id: "DP-ORD", description: "an ordinary bug" }, ids),
      "LOOP-344: …and an ordinary ticket does not");
  }
  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDESIGN_PARENT_OK");
process.exit(fails ? 1 : 0);
