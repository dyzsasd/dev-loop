// LOOP-344 + LOOP-345 — the design gate, on both layers, through ONE predicate.
//
// The defect was an INVERSION between two layers that answered the same question differently:
// opQueue put a design parent in pm.verify, while the write layer refused pm and allowed qa. So the
// only ordering the write layer permitted was the one that strands the children — and it stranded
// them silently, with rc=0.
//
// LOOP-344 is the routing half (two of §21a's three pointer forms reached the wrong verifier);
// LOOP-345 is the authorization half (R1 and R2, which must land together).
import { realpathSync, rmSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";

import { designParentIds, isDesignParent, designPointerOf, docSlugOf } from "../src/design-parent.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-designparent-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const db = openDb(join(tmp, "hub.db"));
  ensureSeed(db, "dp", "DesignParent", "DP");
  const pid = findProject(db, "dp")!;

  // LOOP-379 — `related` is the §21a back-link, and it is now what makes a doc-slug parent resolve.
  // Every fixture below that must come back as a parent carries it; the ones that must NOT are left
  // without it, which is the whole of the new rule. A forward reference is fine: the derivation reads
  // the column at query time, by which point every row exists.
  const mk = (id: string, desc: string, state: string, labels: string[], related: string[] = []) =>
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,'t',?,'Bug',?,2,?,?,'pm','t','t')")
      .run(id, pid, desc, state, JSON.stringify(labels), JSON.stringify(related));
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

  mk("DP-P2", "the module design\n\nhubDoc:design/widget-engine is the doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["DP-C2"]);
  mk("DP-C2", "Design: hubDoc:design/widget-engine\n\nchild", "Todo", ["dev-loop"]);

  mk("DP-P3", "the other design\n\ndocs/design/gadget-core.md is the doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["DP-C3"]);
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
  mk("DP-P6a", "Design doc: hubDoc:design/alpha-mod (the module doc)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["DP-C6a"]);
  mk("DP-C6a", "Design: hubDoc:design/alpha-mod\n\nchild", "Todo", ["dev-loop"]);
  mk("DP-P6b", "The design lives at hubDoc:design/beta-mod.", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["DP-C6b"]);
  mk("DP-C6b", "Design: hubDoc:design/beta-mod\n\nchild", "Todo", ["dev-loop"]);
  mk("DP-P6c", "The dotted design is hubDoc:design/v1.2-module (in full)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["DP-C6c"]);
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

  // ── PR #278 review (P1): R2 finds a parent's children through the SAME relation ───────────────
  // A parent owns a doc slug because its children NAME it (§21a's back-link), so it need not
  // mention the doc anywhere — LOOP-399, the parent this ticket was filed about, does not. R2 used
  // to find a parent's children by matching their slug against one scanned out of the PARENT'S
  // body, which finds NONE of them for exactly those parents: the strand check measured zero and pm
  // could close the parent over its Backlog children. §21a calls that ordering the non-recoverable
  // one — a Done parent gets no further gate, and Backlog is invisible to every dev pick-query.
  //
  // The fixture is the shape the body scan cannot see: the parent's description never contains the
  // slug, and only the links say the three belong together.
  mk("DP-P7", "a design parent whose body names its doc NOWHERE", "In Review",
    ["dev-loop", "Bug", "qa", "senior-dev"], ["DP-C7a", "DP-C7b"]);
  mk("DP-C7a", "Design: hubDoc:design/delta-mod\n\nstaged child", "Backlog", ["dev-loop"], ["DP-P7"]);
  mk("DP-C7b", "Design: hubDoc:design/delta-mod\n\nstaged child", "Backlog", ["dev-loop"], ["DP-P7"]);
  {
    ok(isDesignParent({ id: "DP-P7", description: "" }, designParentIds(db, pid)),
      "PR #278 P1: a parent that names its doc nowhere IS a design parent — the premise of the gap");
    const r = setState("pm", "DP-P7", "Done");
    const err = r.error;
    ok(r.ok === false && /still in Backlog/.test(err),
      `PR #278 P1: …and R2 refuses to close it over its staged children (got ${JSON.stringify(err.slice(0, 90))})`);
    ok(/DP-C7a/.test(err) && /DP-C7b/.test(err),
      "PR #278 P1: …naming BOTH — the gate reads the recorded link, not the parent's prose");
  }
  for (const c of ["DP-C7a", "DP-C7b"]) setState("pm", c, "Todo");
  ok(setState("pm", "DP-P7", "Done").ok === true,
    "PR #278 P1: once promoted the close goes through — R2 gained a case, it did not become a wall");

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
    mk("DP-S2", "the doc-pointer design\n\nhubDoc:design/secure-thing is the doc", "In Review", ["dev-loop", "Bug", "qa", "sensitive"], ["DP-S2C"]);
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
    mk("L372-P", "Mode: design\n\nDesign doc: hubDoc:design/quota-engine (v1)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L372-C"]);
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
    mk("L372-WO-P", "the wrapped doc's owner\n\nhubDoc:design/wrapped-only is the doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L372-WO-C"]);
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
    mk("L372-MODEX", "Mode: design-and-delegate\n\nDesign doc: hubDoc:design/prefix-mod (v1)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L372-MODEX-C"]);
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
    mk("L372-RANK-P", "Mode: design\n\nDesign doc: hubDoc:design/audit-trail (v1)", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L372-RANK-C"]);
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

  // ── LOOP-379: ownership is the §21a back-link, and prose is not read at all ───────────────────
  // The four arms assert TOGETHER, because each alone is passable by a wrong fix: (a) alone by
  // deleting the doc-slug route altogether, (b) alone by returning every related ticket, (c) alone by
  // keeping the old ranking, (d) alone by any of them.
  {
    const parents = (): Set<string> => designParentIds(db, pid);

    // (a) LOOP-420's exact shape, id and citation included — the live misroute this ticket exists to
    // end. It cites the slug once, mid-prose, while explaining its own root cause, and is relatedTo
    // ONE of the doc's three children. Before this it was the only design parent this board believed
    // existed: it surfaced in pm.verify and was excluded from qa.verify, so a merged increment sat
    // In Review invisible to its own verifier.
    mk("LOOP-408", "Design: hubDoc:design/project-config-projection\n\nvocabulary + writer surface", "Todo", ["dev-loop"]);
    mk("LOOP-409", "Design: hubDoc:design/project-config-projection\n\nthe reconciler", "Todo", ["dev-loop"]);
    mk("LOOP-410", "Design: hubDoc:design/project-config-projection\n\nthe doctor warning", "Todo", ["dev-loop"]);
    mk("LOOP-420", "## Root cause\n\nThe projection described in `hubDoc:design/project-config-projection` is\nwritten at seed time only.", "In Review", ["dev-loop", "Bug", "qa"], ["LOOP-409"]);
    // (b) LOOP-399's shape: it names the doc NOWHERE and is relatedTo every child. No prose route
    // could ever reach it, which is why the slug had no owner at all.
    mk("LOOP-399", "the projection design", "Done", ["dev-loop", "Improvement", "pm", "senior-dev"], ["LOOP-408", "LOOP-409", "LOOP-410"]);
    {
      const p = parents();
      ok(!p.has("LOOP-420"),
        "LOOP-379 (a): a ticket that CITES a slug in prose and is relatedTo only some of its children is not its parent");
      ok(p.has("LOOP-399"),
        "LOOP-379 (b): …and the ticket that names the slug NOWHERE but back-links every child IS its parent");
      ok(inVerify("qa", "LOOP-420") && !inVerify("pm", "LOOP-420"),
        "LOOP-379 (a): …so the citing Bug keeps its own qa verifier — the misroute that hid a merged increment");
    }
    // (c) BOUND 3, retained unchanged: two tickets linked to every child resolve to NOBODY. Picking
    // one by id order would settle an authorization question by an accident of numbering.
    mk("L379-TIE-C", "Design: hubDoc:design/tie-mod\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L379-TIE-1", "one owner", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L379-TIE-C"]);
    mk("L379-TIE-2", "the other owner", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L379-TIE-C"]);
    {
      const p = parents();
      ok(!p.has("L379-TIE-1") && !p.has("L379-TIE-2"),
        "LOOP-379 (c): two tickets linked to every child of one slug resolve to NEITHER — never silently both");
    }
    // (d) `Mode: design` still makes a ticket a design parent through isDesignParent with no
    // back-links at all. The marker route is independent of the slug route and this change does not
    // touch it — LOOP-344's rescue of invisible parents survives.
    mk("L379-MARKED", "Mode: design\n\nno children staged yet, no links anywhere", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    ok(isDesignParent({ id: "L379-MARKED", description: "Mode: design\n\nno children staged yet, no links anywhere" }, parents()),
      "LOOP-379 (d): a `Mode: design` ticket is still a design parent with no back-links at all");
    // The deletion itself, asserted where it can be seen: a body naming a slug contributes NOTHING.
    // This arm fails if BODY_SLUG_RE is restored.
    mk("L379-PROSE-C", "Design: hubDoc:design/prose-mod\n\nbuild it", "Todo", ["dev-loop"]);
    mk("L379-PROSE-P", "Design doc: hubDoc:design/prose-mod (the module doc) — named exactly as DP-P6a names its own", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    ok(!parents().has("L379-PROSE-P"),
      "LOOP-379: a body that names a slug and links to none of its children is not its parent — the body scan is gone, not bounded");
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
    mk("L378-DONE", "the ration design\n\nhubDoc:design/ration-engine is the doc", "Done", ["dev-loop", "Bug", "qa", "senior-dev"], ["L378-CHILD"]);
    mk("L378-OPEN", "also names hubDoc:design/ration-engine while explaining the fix", "In Review", ["dev-loop", "Bug", "qa"], ["L378-CHILD"]);
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

  // ── LOOP-378 BOUND 3a: a module designed TWICE keeps its live owner ───────────────────────────
  // The case the board-wide row set makes routine rather than rare (raised on PR #270). §21a's design
  // doc is a LIVING per-module document, so the SECOND design of a module produces two parents naming
  // one slug BY CONSTRUCTION: the first `Done`, the current one open. Both declare `Mode: design`, so
  // ranking on the declaration alone left them tied and BOUND 3 resolved the slug to NOBODY.
  //
  // WHERE THAT BITES, measured rather than assumed. Routing and the close gate do NOT notice: they go
  // through `isDesignParent`, which short-circuits on the ticket's own `Mode: design` body. The
  // consumer that reads `parentIds` MEMBERSHIP directly is LOOP-296's sensitive inheritance
  // (ticketwrite.ts) — so the failure is silent and specific: a child staged under the second design
  // of a SENSITIVE module stops inheriting `sensitive`, and with it the §21b senior re-tier. That is
  // LOOP-290's shape — the one ticket editing an irreversible cascade-delete guard — arriving through
  // the ranking instead of through the filer's judgement.
  //
  // So the arms below assert the predicate's membership and the inheriting write, NOT the routing:
  // an assertion on routing here would pass with the tie-break removed (the marker carries it) and
  // would be worth nothing.
  {
    const create = (title: string, desc: string, labels: string[], assignee: string | null) =>
      (agentOp("save_issue", db, pid, "dp", "senior-dev",
        { title, type: "Improvement", state: "Todo", description: desc, labels, ...(assignee ? { assignee } : {}) }) as OpResult)
        .body as { id: string; labels: string[]; assignee: string | null };

    mk("L378B-OLD", "Mode: design\n\nthe first cut of hubDoc:design/harvest-core", "Done", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"]);
    // LOOP-379: what makes the LIVE cut the owner is no longer that it outranks the Done one — it is
    // that it carries §21a's back-link to the doc's child and the finished cut does not. The
    // assertions below are unchanged; only the signal they rest on is.
    mk("L378B-NEW", "Mode: design\n\nthe second cut of hubDoc:design/harvest-core", "In Review", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"], ["L378B-CHILD"]);
    mk("L378B-CHILD", "Design: hubDoc:design/harvest-core\n\nan existing child, so the slug resolves at all", "Todo", ["dev-loop"]);

    const parents = designParentIds(db, pid);
    ok(parents.has("L378B-NEW"),
      "LOOP-378 BOUND 3a: the LIVE design parent owns the slug even though a Done parent names the same living doc");
    ok(!parents.has("L378B-OLD"),
      "LOOP-378 BOUND 3a: …and the finished one does not — a design that is over cannot own a doc that is still being built to");

    const child = create("child-of-second-design", "Design: hubDoc:design/harvest-core\n\nimplements the second cut", ["dev-loop"], "junior-dev");
    ok(child.labels.includes("sensitive"),
      `LOOP-378 BOUND 3a: a child of the SECOND design still inherits sensitive — the LOOP-296 path reads parentIds membership, which the tie had emptied (got ${JSON.stringify(child.labels)})`);
    ok(child.assignee === "senior-dev" || child.labels.includes("senior-dev"),
      `LOOP-378 BOUND 3a: …so the §21b senior re-tier still fires on it in the same write (assignee ${child.assignee})`);

    // The tier is scoped to DECLARED designs. A live ordinary ticket that merely MENTIONS the slug
    // must not win it just because the other candidate is terminal — that would be LOOP-372's
    // over-match re-entering through the ranking, and it is the same shape the L378-OPEN arm above
    // pins from the other side.
    mk("L378B-DONEOWNER", "Mode: design\n\nthe design of hubDoc:design/mill-core", "Done", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"], ["L378B-MCHILD"]);
    mk("L378B-MENTION", "an ordinary fix that mentions hubDoc:design/mill-core in passing", "In Review", ["dev-loop", "Bug", "qa"]);
    mk("L378B-MCHILD", "Design: hubDoc:design/mill-core\n\nbuild it", "Todo", ["dev-loop"]);
    const p2 = designParentIds(db, pid);
    ok(!p2.has("L378B-MENTION"),
      "LOOP-378 BOUND 3a: a live MENTION does not win the slug over a Done owner — LOOP-379: because a mention is no longer a candidate at all, not because it ranks lower");
    ok(!inVerify("pm", "L378B-MENTION") && inVerify("qa", "L378B-MENTION"),
      "LOOP-378 BOUND 3a: …so it stays an ordinary qa-owned Bug on both layers");

    // ── LOOP-379 — the residual above, DISCHARGED, and these two assertions are INVERTED ─────────
    // This fixture was pinned by LOOP-378 to make the fix visible rather than quiet, and it named the
    // reason its answer would change: "LOOP-379 owns the signal that would separate an owner from a
    // citer." That signal is now the §21a back-link, so the same three rows resolve the other way.
    //
    // A genuine second design filed WITHOUT the `Mode: design` line used to rank exactly as a
    // bystander did — nothing in either BODY tells the two apart — so the older declared parent kept
    // the slug and the live successor's children inherited the wrong parent's labels. Nothing in
    // either body tells them apart today either; the difference is that ownership is no longer read
    // out of a body. The successor staged the child, so it carries the link, so it owns the doc.
    mk("L378B-DECLARED-OLD", "Mode: design\n\nthe first cut of hubDoc:design/kiln-core", "Done", ["dev-loop", "Bug", "qa", "senior-dev"]);
    mk("L378B-UNDECLARED-NEW", "the second cut of hubDoc:design/kiln-core, filed without the mode line", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L378B-KCHILD"]);
    mk("L378B-KCHILD", "Design: hubDoc:design/kiln-core\n\nbuild it", "Todo", ["dev-loop"]);
    const p3 = designParentIds(db, pid);
    ok(p3.has("L378B-UNDECLARED-NEW"),
      "LOOP-379: a live UNDECLARED successor that back-links the child it staged DOES take the slug — the link is the signal the declaration could not be");
    ok(!p3.has("L378B-DECLARED-OLD"),
      "LOOP-379: …and the finished first cut, which links to none of the doc's current children, does not keep it");
    ok(inVerify("pm", "L378B-UNDECLARED-NEW") && !inVerify("qa", "L378B-UNDECLARED-NEW"),
      "LOOP-379: …and both layers agree on the NEW answer — a real design parent reaches its own verifier without having to declare a marker");
  }

  // ── LOOP-379 BOUND 3b: the undirected read degenerates as a slug gets SMALLER ─────────────────
  // `children.every(c => linked(t).has(c))` reads "is t related to every child", and it is satisfied
  // VACUOUSLY by any single neighbour when a slug has exactly ONE child. So LOOP-420's shape — a
  // ticket related to one child of a design it does not own — is excluded on a three-child slug and
  // comes straight back on a one-child slug, where "every" and "any" are the same quantifier. The
  // harm is not that the neighbour gains routing: it is that TWO candidates resolve to nobody under
  // BOUND 3, so the real parent LOSES the PM routing and the close gate it had.
  //
  // The tie is broken by the one edge §21a makes MANDATORY — the child's own `relatedTo:[<parent>]`,
  // written at filing. A neighbour is linked FROM itself; a parent is named BY its children. That is
  // a structural difference, not a preference, which is why it may decide an authorization question
  // where id order may not.
  {
    // Exactly one child, so `every` is `any`. The parent has not back-linked yet (the second write of
    // §21a step 5), which is the normal window this has to survive.
    mk("L379B-OWNER", "the press design, filed with no marker and no back-link yet", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"]);
    mk("L379B-CHILD", "Design: hubDoc:design/press-core\n\nbuild it", "Todo", ["dev-loop"], ["L379B-OWNER"]);
    // An ordinary neighbour: a coverage follow-up related to the child. §18 makes `relatedTo` a
    // general append-only kinship field, so this is a routine row, not a contrived one.
    mk("L379B-NEIGHBOUR", "a coverage follow-up for the work in the child", "In Review", ["dev-loop", "Bug", "qa"], ["L379B-CHILD"]);

    const p4 = designParentIds(db, pid);
    ok(p4.has("L379B-OWNER"),
      "LOOP-379 BOUND 3b: a one-child slug still resolves to the parent its child NAMES, though a neighbour is linked to that same child");
    ok(!p4.has("L379B-NEIGHBOUR"),
      "LOOP-379 BOUND 3b: …and the neighbour is not the parent — being linked to every child is `any` when there is one child");
    ok(inVerify("pm", "L379B-OWNER") && !inVerify("qa", "L379B-OWNER"),
      "LOOP-379 BOUND 3b: …so the parent keeps the PM routing the ambiguity would have taken from it");
    ok(inVerify("qa", "L379B-NEIGHBOUR") && !inVerify("pm", "L379B-NEIGHBOUR"),
      "LOOP-379 BOUND 3b: …and the neighbour stays an ordinary qa-owned Bug on both layers");

    // BOUND 3 is NARROWED, not removed. When the mandatory edge cannot separate the candidates —
    // the child names both — the slug still resolves to NOBODY rather than to whichever sorts first.
    mk("L379B-A", "one of two candidates for the kiln doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L379B-TIED"]);
    mk("L379B-B", "the other candidate for the kiln doc", "In Review", ["dev-loop", "Bug", "qa", "senior-dev"], ["L379B-TIED"]);
    mk("L379B-TIED", "Design: hubDoc:design/anvil-core\n\nbuild it", "Todo", ["dev-loop"], ["L379B-A", "L379B-B"]);
    const p5 = designParentIds(db, pid);
    ok(!p5.has("L379B-A") && !p5.has("L379B-B"),
      "LOOP-379 BOUND 3b: an ambiguity the mandatory edge cannot break still resolves to NOBODY — narrowing is not a tie-break by id order");
  }

  // ── LOOP-379: the FIRST child of a design, which resolves against a slug with no children ─────
  // Ownership is derived from the set of a slug's children, and `insertTicket` runs the lookup BEFORE
  // the row exists. For the first child of a design the slug therefore has no children at all, the
  // owner is nobody, and the `sensitive` inheritance LOOP-296 exists for goes silent — on the one
  // ticket where it decides the tier, since a design's first staged child is where the cheap tier is
  // chosen. The pending row is folded into the same derivation rather than resolved beside it.
  {
    const create = (title: string, desc: string, labels: string[], assignee: string | null, relatedTo: string[]) =>
      (agentOp("save_issue", db, pid, "dp", "senior-dev",
        { title, type: "Improvement", state: "Todo", description: desc, labels, relatedTo, ...(assignee ? { assignee } : {}) }) as OpResult)
        .body as { id: string; labels: string[]; assignee: string | null };

    // A sensitive design parent with NO children yet and no back-link — the state every design is in
    // at the moment its first child is filed.
    mk("L379F-PARENT", "the forge design, staged but not yet decomposed", "In Review", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"]);
    const first = create("first-child-of-forge", "Design: hubDoc:design/forge-core\n\nbuild the first slice",
      ["dev-loop"], "junior-dev", ["L379F-PARENT"]);
    ok(first.labels.includes("sensitive"),
      `LOOP-379: the FIRST doc-pointer child of a sensitive design inherits the label — the pending row is part of the derivation (got ${JSON.stringify(first.labels)})`);
    ok(first.assignee === "senior-dev" || first.labels.includes("senior-dev"),
      `LOOP-379: …so the §21b senior re-tier fires in the same write, instead of staging sensitive work on the junior tier (assignee ${first.assignee})`);

    // …and the SECOND child, filed once the first is on the board, resolves the same way. This is the
    // arm that would pass with the pending row ignored, so it is what makes the first assertion
    // discriminating rather than decorative.
    const second = create("second-child-of-forge", "Design: hubDoc:design/forge-core\n\nbuild the second slice",
      ["dev-loop"], "junior-dev", ["L379F-PARENT"]);
    ok(second.labels.includes("sensitive"),
      `LOOP-379: …and the second child, whose slug now has a child on the board, inherits identically (got ${JSON.stringify(second.labels)})`);

    // The pending row must not become a parent OF ITSELF: it is a child of its own slug, so it is
    // excluded from the candidate set before its synthetic id is ever compared.
    ok(!designParentIds(db, pid).has(first.id),
      "LOOP-379: …and the pending child is not resolved as its own slug's owner");
  }

  // ── LOOP-379: a doc REDESIGNED — ownership is per increment, not per slug lifetime ────────────
  // Raised on PR #278 as a P1, and it is the failure mode that arrives with AGE rather than with an
  // unusual shape. §21a defines the design doc as a LIVING per-module document, so a second increment
  // is the normal life of any doc that outlives its first feature — and the query reads the whole
  // board (BOUND 4), so `children` holds every child of every increment while each parent back-links
  // only the children IT staged. "Linked to every child" therefore fails for BOTH parents at once:
  // the slug resolves to NOBODY, which reads identically to "no design here".
  //
  // It is distinct from the first-child case above and reproduces AFTER that fix — the shape is an old
  // parent/child pair plus a new one, both complete. The two arms are the two consumers: predicate
  // membership (the routing/close gate) and the inheriting write (LOOP-296's `sensitive`, which is
  // where the tier is chosen). The second arm is what makes this a P1 rather than a display miss —
  // a child of the CURRENT design of a sensitive module silently lands on the junior tier.
  {
    const create = (title: string, desc: string, labels: string[], assignee: string | null, relatedTo: string[]) =>
      (agentOp("save_issue", db, pid, "dp", "senior-dev",
        { title, type: "Improvement", state: "Todo", description: desc, labels, relatedTo, ...(assignee ? { assignee } : {}) }) as OpResult)
        .body as { id: string; labels: string[]; assignee: string | null };

    // Increment 1, finished: parent and child link to each other and to nothing else.
    mk("L379I-P1", "the first cut of the loom design", "Done", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"], ["L379I-C1"]);
    mk("L379I-C1", "Design: hubDoc:design/loom-core\n\nthe first slice", "Done", ["dev-loop"], ["L379I-P1"]);
    // Increment 2, current: the same doc, redesigned. Nothing about either row is unusual.
    mk("L379I-P2", "the second cut of the loom design", "In Review", ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"], ["L379I-C2"]);
    mk("L379I-C2", "Design: hubDoc:design/loom-core\n\nthe second slice", "Todo", ["dev-loop"], ["L379I-P2"]);

    const p6 = designParentIds(db, pid);
    ok(p6.has("L379I-P2"),
      "LOOP-379 increments: the CURRENT design of a redesigned doc is its parent — a lifetime-wide `every` leaves the slug with no owner at all");
    ok(p6.has("L379I-P1"),
      "LOOP-379 increments: …and so is the finished one, which really did decompose a design — a doc has one parent per increment, not one for all time");

    // The consumer that made this a P1: the child of the CURRENT increment must still inherit.
    const next = create("third-slice-of-loom", "Design: hubDoc:design/loom-core\n\nthe third slice",
      ["dev-loop"], "junior-dev", ["L379I-P2"]);
    ok(next.labels.includes("sensitive"),
      `LOOP-379 increments: a new child of the current increment inherits sensitive from the parent IT names, however many increments the doc has had (got ${JSON.stringify(next.labels)})`);
    ok(next.assignee === "senior-dev" || next.labels.includes("senior-dev"),
      `LOOP-379 increments: …so the §21b senior re-tier fires, instead of staging sensitive work on the junior tier (assignee ${next.assignee})`);

    // A neighbour is still kept out on a redesigned doc — the increment is read off the child's own
    // mandatory link, so a ticket that links AT a child of any increment never becomes its owner.
    mk("L379I-NEIGHBOUR", "a coverage follow-up related to the second slice", "In Review", ["dev-loop", "Bug", "qa"], ["L379I-C2"]);
    ok(!designParentIds(db, pid).has("L379I-NEIGHBOUR"),
      "LOOP-379 increments: …and a neighbour linked to one increment's child is still not a parent — partitioning does not relax the direction");
  }

  // ── PR #278 review (P2): a child that names MORE than its parent still has one ────────────────
  // `relatedTo` is one general append-only field — §4 splits and §15 coverage siblings ride it too
  // — so a child's outgoing set grows over its life. A single-child design whose child later gains
  // one ordinary link named two eligible tickets, attributed to neither, and then lost the slug
  // outright: the undirected fallback saw both as linked to the only child and BOUND 3 resolved it
  // to nobody. The parent lost PM routing, the Backlog close protection and `sensitive` inheritance
  // because a follow-up had been filed.
  //
  // §21a records the parent edge on BOTH ends — the child links its parent at filing, the parent
  // back-links every child it staged — so the handshake is what a coverage link cannot fake.
  {
    mk("L379M-P", "the sole design of the mesh module", "In Review",
      ["dev-loop", "Bug", "qa", "sensitive", "senior-dev"], ["L379M-C"]);       // …and names its child back
    mk("L379M-COVERAGE", "a coverage follow-up", "Todo", ["dev-loop", "Bug", "qa"]);
    // The child names its parent AND the follow-up — the §15 shape, on the ONLY child of the slug.
    mk("L379M-C", "Design: hubDoc:design/mesh-mod\n\nthe only slice", "Backlog", ["dev-loop"],
      ["L379M-P", "L379M-COVERAGE"]);

    const pm2 = designParentIds(db, pid);
    ok(pm2.has("L379M-P"),
      "PR #278 P2: a child naming its parent AND a coverage sibling still resolves its parent — the mutual §21a link is the parent edge");
    ok(!pm2.has("L379M-COVERAGE"),
      "PR #278 P2: …and the sibling it also names is NOT a parent — the handshake is what separates them, not the count");
    // The consumer the leak reached: the close gate must still see the staged child.
    const r = setState("pm", "L379M-P", "Done");
    ok(r.ok === false && /still in Backlog/.test(r.error) && /L379M-C/.test(r.error),
      `PR #278 P2: …so R2 still refuses to close it over its one staged child (got ${JSON.stringify(r.error.slice(0, 90))})`);
  }

  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nDESIGN_PARENT_OK");
process.exit(fails ? 1 : 0);
