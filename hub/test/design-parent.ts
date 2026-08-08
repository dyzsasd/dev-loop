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
    const ids = designParentIds(db, pid);
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

  // ── LOOP-372: the doc-slug route OVER-matched — a mention is not ownership ────────────────────
  // LOOP-344 made the parent side reachable through the doc slug; it did so with an UNANCHORED body
  // scan, while the child side was deliberately anchored to a bare line. Reading the two halves of
  // one line two different ways classified 19 of this board's 352 tickets as design parents when 5
  // were design tickets — and `isDesignParent` decides pm/qa routing, the LOOP-345 close gate and
  // the LOOP-360 zero-commit handoff exemption, so nine ordinary code tickets held all three.
  //
  // Asserted directly on the predicate rather than through the queue: it is the shared input to
  // three gates, and each gate's own routing is already covered above.
  {
    const parents = (): Set<string> => designParentIds(db, pid);

    // The three-ticket fixture from the ticket: an owner, a child, and a bystander that merely
    // quotes the doc in a sentence. Before the fix all THREE came back as parents.
    mk("L372-P", "Mode: design\n\nDesign doc: hubDoc:design/quota-engine (v1)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    mk("L372-C", "Design: hubDoc:design/quota-engine\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-U", "## Root cause\n\nThe regression traces to hubDoc:design/quota-engine, which the\nprevious fire cited while explaining the failure.", "In Review", ["dev-loop", "Bug", "qa"]);
    {
      const p = parents();
      ok(p.has("L372-P"), "LOOP-372: the design's OWNER still resolves through the doc-slug route");
      ok(!p.has("L372-U"), "LOOP-372: a bystander that merely MENTIONS the doc in prose is not its parent");
      ok(!p.has("L372-C"), "LOOP-372: …and the child that points AT the doc is not its parent either");
      // The routing consequence, since that is what the over-match actually cost: two consecutive
      // fires sent a qa-labelled Bug to PM's verify queue and QA handed the close away.
      ok(inVerify("qa", "L372-U") && !inVerify("pm", "L372-U"),
        "LOOP-372: …so the bystander keeps its own qa verifier instead of being re-routed to PM");
    }

    // The sharp case: the natural markdown spelling of a pointer. `docSlugOf` refused the capture
    // (it starts with a backtick) so the ticket failed the CHILD test, and the unanchored body scan
    // then found the same token and passed it the PARENT test — one line, read two ways.
    //
    // The live shape, and it is load-bearing: the wrapped child has a SIBLING whose pointer parses,
    // so the slug has children whichever way the wrapped one is read. Without the sibling the slug
    // has no children at all before the fix, the parent branch never runs, and the fixture passes
    // against the very defect it is meant to catch. Neither ticket has a `Mode: design` owner
    // either — with one, these would pass on the RANKING and could not see the child rule go.
    mk("L372-BT-SIB", "Design: hubDoc:design/ledger-core\n\nsibling, pointer parses either way", "Todo", ["dev-loop"]);
    mk("L372-BT-C", "Design: `hubDoc:design/ledger-core` (§5). Parent: L372-NOBODY.\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-PL-C", "Design: hubDoc:design/plain-core\n\nbuild it", "Todo", ["dev-loop"]);
    {
      const p = parents();
      ok(!p.has("L372-BT-C"), "LOOP-372: a child whose pointer is BACKTICK-wrapped is not the parent of the doc it points at");
      ok(!p.has("L372-PL-C"), "LOOP-372: …nor is one whose pointer parses — the rule is the `Design:` line, not whether it parses");
      ok(!p.has("L372-BT-SIB"), "LOOP-372: …nor the sibling that shares the slug");
      // Decided deliberately, per the ticket: the wrapped form BINDS as a child rather than binding
      // to nothing on either side. The strip lives beside the `.md` strip and both sides read it.
      ok(docSlugOf("`hubDoc:design/ledger-core`") === "ledger-core",
        `LOOP-372: the wrapped pointer resolves to the same slug as the bare one (got ${JSON.stringify(docSlugOf("`hubDoc:design/ledger-core`"))})`);
      ok(docSlugOf("**`docs/design/ledger-core.md`**") === "ledger-core",
        "LOOP-372: …in the repo-file spelling too, through emphasis as well as the code span");
      ok(docSlugOf("hubDoc:design/ledger-core") === "ledger-core",
        "LOOP-372: …and the bare form is untouched by the strip");
    }
    // "Regardless of whether the pointer parses" needs a pointer that still does NOT parse once the
    // code span is stripped, or the claim rides on the strip and the rule itself is never exercised.
    // The repo-file form is `$`-anchored, so a trailing section reference — the spelling three live
    // children use — leaves it unparseable while the line plainly names the slug. It is a CHILD of
    // that slug either way; that is the rule, and it is not a statement about parsing.
    mk("L372-UP-SIB", "Design: docs/design/shelf-core.md\n\nsibling whose pointer parses", "Todo", ["dev-loop"]);
    mk("L372-UP-C", "Design: docs/design/shelf-core.md (§5). Parent: L372-NOBODY.\n\nbuild it", "Todo", ["dev-loop"]);
    ok(docSlugOf("docs/design/shelf-core.md (§5). Parent: L372-NOBODY.") === null,
      "LOOP-372: (the pointer genuinely does not parse — otherwise the next assertion proves nothing)");
    ok(!parents().has("L372-UP-C"),
      "LOOP-372: a `Design:` line that NAMES the slug makes its ticket a child even when the pointer form does not parse");
    // Binding it means the wrapped child is REACHABLE as a child, not merely excluded as a parent —
    // the difference between the form meaning something and the form meaning nothing. Asserted on a
    // slug whose ONLY child is wrapped: if the form did not bind, the slug would have no children
    // and its owner would resolve to nobody.
    mk("L372-WO-C", "Design: `hubDoc:design/wrapped-only`\n\nthe only child, wrapped", "Todo", ["dev-loop"]);
    mk("L372-WO-P", "the wrapped doc's owner\n\nhubDoc:design/wrapped-only is the doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    ok(parents().has("L372-WO-P"),
      "LOOP-372: a wrapped pointer BINDS as a child, so its doc's owner resolves through the reverse link");

    // A ticket that DECLARES a non-design mode is not a design parent, whatever its prose says.
    // §21a defines exactly two modes; `Mode: direct-code` is the ticket stating it is code work.
    mk("L372-MODE-C", "Design: hubDoc:design/cache-tier\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-MODE", "Mode: direct-code\n\nSupersedes L372-X. Parent design: L372-Y · `hubDoc:design/cache-tier`, Layer 1.", "In Review", ["dev-loop", "Improvement", "pm"]);
    ok(!parents().has("L372-MODE"),
      "LOOP-372: a `Mode: direct-code` ticket naming a doc is code work by its own declaration, not that doc's parent");
    // The two mode reads must not contradict each other: the disqualifier reads any bare `Mode:`
    // line, `isDesignModeBody` reads only the top of the body, and a body that one calls a design
    // must never be one the other throws out. Asserted on a marker `isDesignModeBody` accepts by
    // prefix, which is exactly where the two rules can drift apart.
    mk("L372-MODEX-C", "Design: hubDoc:design/prefix-mod\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-MODEX", "Mode: design-and-delegate\n\nDesign doc: hubDoc:design/prefix-mod (v1)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    ok(parents().has("L372-MODEX"),
      "LOOP-372: a body `isDesignModeBody` accepts is never thrown out by the non-design-mode disqualifier");

    // Two tickets naming one slug is an AMBIGUOUS link. Returning both would hand the gate to a
    // ticket that is certainly wrong; picking one by id order would settle an authorization question
    // by an accident of numbering. It resolves to nobody.
    mk("L372-AMB-C", "Design: hubDoc:design/router-mesh\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-AMB-1", "we adopted hubDoc:design/router-mesh here", "In Review", ["dev-loop", "Bug", "qa"]);
    mk("L372-AMB-2", "and hubDoc:design/router-mesh is cited here too", "In Review", ["dev-loop", "Bug", "qa"]);
    {
      const p = parents();
      ok(!p.has("L372-AMB-1") && !p.has("L372-AMB-2"),
        "LOOP-372: two tickets naming one slug with nothing to separate them resolve to NEITHER — never silently both");
    }
    // …but a `Mode: design` declaration among them settles it, deterministically and without
    // REQUIRING the marker (which would un-fix LOOP-344 — see DP-P2/DP-P6b above, still green).
    mk("L372-RANK-C", "Design: hubDoc:design/audit-trail\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-RANK-P", "Mode: design\n\nDesign doc: hubDoc:design/audit-trail (v1)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    mk("L372-RANK-U", "the fix is written back into hubDoc:design/audit-trail §8", "In Review", ["dev-loop", "Bug", "qa"]);
    {
      const p = parents();
      ok(p.has("L372-RANK-P"), "LOOP-372: a declared design OUTRANKS a mention of the same slug");
      ok(!p.has("L372-RANK-U"), "LOOP-372: …and the mention loses rather than joining it");
    }

    // The body scan reads EVERY occurrence. First-match-only hid a ticket naming a second doc, so
    // the tie-break could not see that a link was contested at all.
    mk("L372-MULTI-C", "Design: hubDoc:design/shard-map\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L372-MULTI-1", "follows hubDoc:design/quota-engine and also hubDoc:design/shard-map", "In Review", ["dev-loop", "Bug", "qa"]);
    mk("L372-MULTI-2", "hubDoc:design/shard-map is named here as well", "In Review", ["dev-loop", "Bug", "qa"]);
    {
      const p = parents();
      ok(!p.has("L372-MULTI-1") && !p.has("L372-MULTI-2"),
        "LOOP-372: a slug named SECOND in a body still counts as a candidate, so the contest is seen and neither wins");
    }

    // An id no ticket on this board holds is not an authorization subject. `LOOP-2` reached the live
    // set this way — a parent nobody can hold and nobody can audit.
    mk("L372-GHOST-C", "Design: parent L372-NOSUCH\n\nbuild it", "Todo", ["dev-loop"]);
    ok(!parents().has("L372-NOSUCH"),
      "LOOP-372: a `Design: parent <id>` naming no ticket on this board is not returned");
    ok(parents().has("DP-P1"),
      "LOOP-372: …while a `parent <id>` that DOES name a real ticket still resolves (the check bounds the route, it does not remove it)");
  }

  // ── LOOP-378: the two layers agree, because the predicate owns its row set ────────────────────
  // The predicate used to take its rows as an ARGUMENT, and the callers disagreed: opQueue passed
  // non-terminal rows, the three ticketwrite gates passed all of them. Every link the derivation
  // walks is board-wide, so that did not narrow the answer — it CHANGED it, through BOUND 3, since
  // whether a slug is CONTESTED is a property of the row set. Measured on the live board the two
  // views shared not one parent (11 vs 1, disjoint).
  //
  // The fixture is the smallest shape that separates them: one slug, two candidate owners, one of
  // them terminal.
  //   • all rows          → 2 candidates → BOUND 3 → the slug resolves to NOBODY.
  //   • non-terminal rows → 1 candidate  → the survivor resolves as its parent.
  // So the survivor is a design parent to the queue and an ordinary qa-owned Bug to the close gate:
  // pm.verify shows work that the write layer will only let qa close. That is LOOP-345's inversion
  // arriving through the argument instead of through a second copy of the code.
  //
  // Asserted through BOTH layers on purpose. A predicate-only assertion cannot see a caller pass the
  // wrong rows — which is the entire defect — so this drives opQueue's routing and the real
  // In Review → Done write path, and checks they say the SAME thing.
  {
    mk("L378-DONE", "the ration design\n\nhubDoc:design/ration-engine is the doc", "Done", ["dev-loop", "Bug", "qa", "senior-dev"]);
    mk("L378-OPEN", "also names hubDoc:design/ration-engine while explaining the fix", "In Review", ["dev-loop", "Bug", "qa"]);
    mk("L378-CHILD", "Design: hubDoc:design/ration-engine\n\nbuild it", "Todo", ["dev-loop"]);

    // Layer 1 — the queue. The contest is visible board-wide, so L378-OPEN is NOT a design parent
    // and routes to its qa owner. Under the old opQueue row set the terminal candidate vanished,
    // L378-OPEN won the slug uncontested, and it routed to pm.verify instead.
    ok(!inVerify("pm", "L378-OPEN"),
      "LOOP-378: the queue does not call a ticket a design parent on a contest only its row set hid");
    ok(inVerify("qa", "L378-OPEN"),
      "LOOP-378: …it reaches its qa owner's verify queue, as an ordinary Bug");

    // Layer 2 — the write gate, driven through the real save_issue path. It must reach the same
    // verdict: not a design parent ⇒ the §21a close rule does not fire and the qa owner may close.
    ok(setState("pm", "L378-OPEN", "Done").ok === false,
      "LOOP-378: the close gate agrees it is not a design parent — pm does not inherit a design parent's close right over it");
    ok(setState("qa", "L378-OPEN", "Done").ok === true,
      "LOOP-378: …and its qa owner closes it normally, so both layers answer one question one way");

    // The other direction: a slug uncontested in EVERY row set still resolves, so the fix bounds the
    // divergence without costing a real parent its routing. DP-P2's owner is terminal-free.
    ok(inVerify("pm", "DP-P2") && !inVerify("qa", "DP-P2"),
      "LOOP-378: an uncontested design parent is unaffected — this removes a disagreement, not the route");
  }

  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDESIGN_PARENT_OK");
process.exit(fails ? 1 : 0);
