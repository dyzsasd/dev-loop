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

  // ── LOOP-361: a slug named at the END OF A SENTENCE is the same slug ─────────────────────────
  // `.` is legal INSIDE a slug, so it lives in the token's character class — and the lazy pattern
  // therefore refused to stop before a trailing full stop and captured `beta-mod.`. That equals no
  // child's slug, so a parent naming its doc at the end of an ordinary sentence resolved to nothing
  // and fell out of pm.verify into qa.verify — LOOP-344's inversion, returning through the body-slug
  // path. Triggering it needs no unusual input, only prose that ends a sentence.
  //
  // The three shapes are asserted TOGETHER because each one alone is passable by a wrong fix: the
  // end-of-sentence case alone is satisfied by stripping trailing dots, which then eats the dot in
  // `v1.2-module`; the dotted case alone is satisfied by doing nothing at all.
  mk("DP-P6a", "Design doc: hubDoc:design/alpha-mod (the module doc)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C6a", "Design: hubDoc:design/alpha-mod\n\nchild", "Todo", ["dev-loop"]);
  mk("DP-P6b", "The design lives at hubDoc:design/beta-mod.", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C6b", "Design: hubDoc:design/beta-mod\n\nchild", "Todo", ["dev-loop"]);
  mk("DP-P6c", "The dotted design is hubDoc:design/v1.2-module (in full)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
  mk("DP-C6c", "Design: hubDoc:design/v1.2-module\n\nchild", "Todo", ["dev-loop"]);
  for (const [p, shape] of [
    ["DP-P6a", "mid-sentence"], ["DP-P6b", "at the end of a sentence"], ["DP-P6c", "with a dot INSIDE the slug"],
  ] as const) {
    ok(inVerify("pm", p), `LOOP-361: a parent naming its doc ${shape} reaches pm.verify`);
    ok(!inVerify("qa", p), `LOOP-361: …and ${shape}, not qa.verify`);
  }

  // Both halves of the reverse link resolve through ONE token rule, so the pointer side is asserted
  // on the same shapes: a body that agrees with a pointer that is itself wrong still resolves
  // nothing. These check LITERAL slugs on purpose — `docSlugOf(a) === docSlugOf(b)` (above) cannot
  // discriminate here, because both sides share the predicate and a mutation corrupting them equally
  // keeps it green.
  for (const [ptr, want] of [
    ["hubDoc:design/beta-mod.", "beta-mod"],           // a full stop that ENDS the token is prose
    ["docs/design/beta-mod.", "beta-mod"],
    ["hubDoc:design/v1.2-module", "v1.2-module"],      // …a dot with slug after it is slug
    ["docs/design/v1.2-module.md", "v1.2-module"],
    ["hubDoc:design/widget-engine", "widget-engine"],  // LOOP-344: hyphenated slugs resolve in full
    ["docs/design/widget-engine.md", "widget-engine"], // …and the `.md` strip is unchanged
    ["docs/design/gadget-core.md", "gadget-core"],
  ] as const) {
    ok(docSlugOf(ptr) === want,
      `LOOP-361: docSlugOf(${JSON.stringify(ptr)}) → ${JSON.stringify(want)} (got ${JSON.stringify(docSlugOf(ptr))})`);
  }

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
  // ── LOOP-296: a designed child INHERITS its parent's `sensitive` label ───────────────────────
  // Three enforcement layers exist and all key on the LABEL — the write gate's re-tier,
  // servable.ts's queue defense, and doctor W21 + the Sweep digest. All three are correctly built,
  // and none is at fault: they share one input, and nothing guaranteed that input was written on a
  // CHILD. When the filer's judgement said no, all three went silent at once and the work routed to
  // the cheap tier. That happened on LOOP-290 — the one ticket editing an irreversible
  // cascade-delete guard.
  {
    const create = (id: string, desc: string, labels: string[], assignee: string | null) => {
      const r = agentOp("save_issue", db, pid, "dp", "senior-dev",
        { title: id, type: "Improvement", state: "Todo", description: desc, labels, ...(assignee ? { assignee } : {}) }) as OpResult;
      return r.body as { id: string; labels: string[]; assignee: string | null };
    };
    // A sensitive design parent, and a child staged under it WITHOUT the label — LOOP-290's shape.
    mk("DP-S1", "Mode: design\n\nthe sensitive module", "In Review", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"]);
    const child = create("child-of-sensitive", "Design: parent DP-S1\n\nimplements it", ["dev-loop"], "junior-dev");
    ok(child.labels.includes("sensitive"),
      `LOOP-296: the child INHERITS sensitive from its design parent (got ${JSON.stringify(child.labels)})`);
    // …and because inheritance runs BEFORE the tier logic, the existing re-tier escalates it in the
    // SAME write rather than leaving it on the junior tier until a backstop notices.
    ok(child.assignee === "senior-dev" || child.labels.includes("senior-dev"),
      `LOOP-296: …and the existing sensitive re-tier fires on it immediately (assignee ${child.assignee})`);

    // A child of a NON-sensitive parent is untouched — this inherits, it does not label everything.
    const plain = create("child-of-plain", "Design: parent DP-P1\n\nimplements it", ["dev-loop"], "junior-dev");
    ok(!plain.labels.includes("sensitive"), `LOOP-296: a child of a NON-sensitive parent is untouched (${JSON.stringify(plain.labels)})`);
    // A ticket with no design pointer at all is untouched.
    const orphan = create("no-pointer", "just a ticket", ["dev-loop"], "junior-dev");
    ok(!orphan.labels.includes("sensitive"), "LOOP-296: a ticket with no Design: pointer is untouched");
    // An explicit sensitive label is preserved, not duplicated.
    const explicit = create("explicit", "Design: parent DP-P1\n\nx", ["dev-loop", "sensitive"], null);
    ok(explicit.labels.filter((l) => l === "sensitive").length === 1,
      `LOOP-296: an explicit label is kept exactly once, never duplicated (${JSON.stringify(explicit.labels)})`);

    // The DOC-pointer forms inherit too — otherwise two of §21a's three forms would stay exposed,
    // which is the same shape LOOP-344 fixed one layer up.
    mk("DP-S2", "the doc-pointer design\n\nhubDoc:design/secure-thing is the doc", "In Review", ["dev-loop", "Bug", "qa", "sensitive"]);
    mk("DP-S2C", "Design: hubDoc:design/secure-thing\n\nexisting child so the parent resolves", "Todo", ["dev-loop"]);
    const docChild = create("doc-child", "Design: hubDoc:design/secure-thing\n\nimplements it", ["dev-loop"], "junior-dev");
    ok(docChild.labels.includes("sensitive"),
      `LOOP-296: a child using the hubDoc: pointer form inherits too (got ${JSON.stringify(docChild.labels)})`);
  }

  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDESIGN_PARENT_OK");
process.exit(fails ? 1 : 0);
