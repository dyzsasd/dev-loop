// The ONE definition of "is this ticket a design parent?" (LOOP-344).
//
// §21a gives design-parent verification to PM — QA has no authority over design coherence — and the
// queue enforced that with a predicate defined inline in agentops.ts. It recognised TWO of §21a's
// three `Design:` pointer forms:
//
//   child body                       | reached pm.verify | reached qa.verify
//   ---------------------------------|-------------------|------------------
//   Design: parent <id>              | yes               | no
//   Design: hubDoc:design/<slug>      | NO  ← wrong       | yes ← wrong
//   Design: docs/design/<slug>.md     | NO  ← wrong       | yes ← wrong
//
// The two doc-pointer forms name the DOC, not the parent, so a reverse-link derivation that only
// looks for `parent <id>` resolves them to nothing and the parent falls through to QA. Two of the
// three documented forms routed to the wrong verifier.
//
// It lives in its own module because LOOP-345 keys an AUTHORIZATION decision on it inside
// ticketwrite.ts. Two copies of an authorization predicate is how a gate ends up enforcing something
// different from what the queue displays — which is exactly the inversion LOOP-345 describes: the
// layer that SHOWS the work refused the write, and the layer that PERMITS the write hid the work.
import type { DatabaseSync } from "node:sqlite";

/** The subset of a ticket this module needs. Structural, so both callers' row types satisfy it. */
export interface DesignParentTicket {
  id: string;
  description: string;
  state?: string;
}

// The states in which a ticket's work is over. Exported and consumed by agentops.ts rather than
// re-spelled there: this module already owns the board-wide row set (BOUND 4), and the ranking below
// keys an AUTHORIZATION decision on terminality — the same class of decision that put this predicate
// in one module in the first place. (ticketwrite.ts keeps its own, deliberately narrower set: it
// asks a different question — "may this state be MOVED OUT OF" — and answers it without `Duplicate`.)
export const TERMINAL_STATES = new Set(["Done", "Canceled", "Duplicate"]);

// A `Design:` pointer binds ONLY as a bare line whose first non-whitespace token is the keyword —
// the same rule `Blocked-by:`/`Unblocked-by:` follow (blocked-by.ts, asserted in its own suite), and
// the rule the sweep SKILL was corrected to state (LOOP-343). A ticket that merely QUOTES the marker
// while discussing it — inside backticks, mid-sentence — is not a design child. Without that
// anchoring, LOOP-296 (which quotes `Design: parent <id>` twice in prose) reads as a design child.
const DESIGN_POINTER_RE = /^[ \t]*Design:[ \t]*(.+?)[ \t]*$/im;

/** The pointer a child carries, or null. Exported for callers that want to report the form. */
export function designPointerOf(description: string): string | null {
  const m = DESIGN_POINTER_RE.exec(description ?? "");
  return m ? m[1] : null;
}

/**
 * The ids that are design PARENTS on this board, derived from every §21a pointer form:
 *   • `Design: parent <id>`            — names the parent directly
 *   • `Design: hubDoc:design/<slug>`   — names the DOC; the parent is resolved through the doc slug
 *   • `Design: docs/design/<slug>.md`  — same, repo-file spelling
 *
 * For the two doc forms the parent is the ticket the board RECORDS as owning that slug: the one its
 * children NAME through `relatedTo`. That is a reverse link like the `parent <id>` case, just keyed
 * on the slug instead of on an id — and, because a design doc is LIVING (§21a), a slug redesigned
 * more than once has one parent per increment rather than one for all time.
 *
 * The doc-slug route used to be an INFERENCE — it read ownership of a design out of a ticket naming
 * that design in prose — and LOOP-372 bounded it on three sides rather than removing it. LOOP-379
 * removes it: the body scan is DELETED, not filtered, and the derivation is now §21a's mandatory
 * back-link. The residual the bounds could not reach was a live misroute, not a theoretical one —
 * LOOP-420 cited `hubDoc:design/project-config-projection` once, mid-prose, while explaining its own
 * root cause, and became the only design parent the queue believed existed on this board: it
 * surfaced in `pm.verify` and was excluded from `qa.verify`, leaving a merged increment invisible to
 * its own verifier. Its true owner, LOOP-399, names its doc nowhere and no prose route could reach
 * it. `isDesignParent` is not a display predicate — it decides pm/qa queue routing, the LOOP-345
 * close gate, and the LOOP-360 zero-commit handoff exemption — so an over-match hands ordinary code
 * tickets an authorization they were never meant to have, and an under-match hides real work.
 *
 * Why a link and not better prose (PM ruling, 2026-08-06, scored on the live 407-row board): a
 * position rule cannot separate a citation from a declaration — LOOP-420's citation sits at the head
 * of a line, the same position as the fixture that must resolve — and retiring the route entirely
 * removes LOOP-344's rescue of invisible parents with it. The back-link is a recorded fact rather
 * than a reading: the child→parent link is mandatory (conventions.md §21a) and the parent's
 * back-link is written in the same operation that spawns the children. Measured, this drops exactly
 * one ticket across 407 rows and that ticket is the false positive, while resolving all four slugs
 * that have open children to their correct owners.
 *
 * BOUND 4 — the row set is the WHOLE BOARD, and it is not a parameter (LOOP-378). Every link this
 * function walks is board-wide: a child in `Todo` resolves a parent that may be `Done`, and a slug's
 * candidate set may hold terminal and non-terminal tickets at once. So restricting the input does
 * not merely hide terminal rows from the answer — it CHANGES the answer for the rows that remain,
 * most sharply through BOUND 3, since whether a slug is contested is a property of the row set.
 * While the rows came in as an argument the callers disagreed: `opQueue` passed non-terminal rows
 * and the three `ticketwrite` gates passed all of them. Measured on this board with LOOP-372's fix
 * in place, the two views shared NOT ONE parent — 11 ids to `ticketwrite`, 1 to `opQueue`, disjoint
 * — and LOOP-379 was a design parent to the queue and not to the close gate. That is the precise
 * inversion LOOP-345 exists to prevent, in its own words: the layer that SHOWS the work refused the
 * write, and the layer that PERMITS the write hid the work. One predicate asked one question cannot
 * be enforced by convention at four call sites, so the query lives HERE and the parameter is gone;
 * a caller that wants a narrower view filters what it DISPLAYS, after the predicate, never what the
 * predicate derives from.
 */
export function designParentIds(db: DatabaseSync, projectId: string): Set<string> {
  return resolveDesignParents(db, projectId).parents;
}

/**
 * A child that is about to be INSERTED and is therefore not on the board yet. Ownership is derived
 * from the set of a slug's children, so the FIRST child of a design resolves against a slug that has
 * no children at all — `designOwnerOfSlug` would answer `null` for the one ticket whose own
 * `relatedTo` already names the parent. That is not a display miss: ticketwrite.ts keys `sensitive`
 * inheritance on the answer, so the first staged child of a `sensitive` design would be stored
 * without the label and left on the junior tier — LOOP-290's shape, which LOOP-296 exists to
 * prevent. The pending row is folded into the derivation instead of resolved by a second, private
 * rule beside it; one derivation is this module's whole reason to exist (LOOP-344).
 */
export interface PendingDesignChild { description: string; relatedTo: readonly string[] }

// The pending row needs an id to sit in the board set, and it does not have one yet — `insertTicket`
// allocates it after this runs. A NUL is not a legal ticket id on any backend, so this can never
// collide with a real row, and the row is a child of its own slug, so it is excluded from the
// candidate set before the id is ever compared.
const PENDING_ID = "\u0000pending";

/**
 * The ticket that owns doc slug `slug`, or null. The SAME derivation `designParentIds` uses —
 * exported so a caller that has a slug and wants its owner never re-derives one (LOOP-379).
 * ticketwrite.ts's `sensitive` inheritance did re-derive it, by scanning candidate bodies for the
 * slug text; under the back-link rule an owner need not name its own doc anywhere (LOOP-399 does
 * not), so that scan would have found nobody and the label would have stopped being inherited by
 * exactly the doc-pointer children LOOP-296 exists to protect.
 *
 * `pending` folds in a child that is not on the board yet — see `PendingDesignChild`.
 */
export function designOwnerOfSlug(
  db: DatabaseSync,
  projectId: string,
  slug: string,
  pending?: PendingDesignChild,
): string | null {
  return resolveDesignParents(db, projectId, pending).ownerBySlug.get(slug) ?? null;
}

/**
 * The children `parentId` staged — the SAME relation the ownership derivation reads, inverted
 * (PR #278 review, P1).
 *
 * LOOP-345's R2 refuses to close a design parent whose staged children still sit in `Backlog`, and
 * it decided childhood by matching the child's slug against a slug read out of the PARENT'S OWN
 * DESCRIPTION. Under the back-link rule that predicate is no longer the same relation the parent
 * was derived from: a parent now owns a slug because its children NAME it, so a parent that
 * mentions its doc nowhere — LOOP-399 is one, and it is the case this ticket exists to fix — is a
 * design parent whose children the body scan cannot find. R2 would then measure ZERO stranded
 * children for exactly the parents the new derivation admits, and PM could close one over a
 * Backlog child. §21a calls that out as the non-recoverable ordering: a `Done` parent with children
 * still in `Backlog` gets no further gate, and Backlog is invisible to every dev pick-query.
 *
 * So childhood is read here, off the links, in the same pass that decides parenthood — the rule the
 * rest of this module is built on (LOOP-344): a gate that re-derives its own half of a shared
 * predicate is how the two halves come to enforce different things.
 *
 * A child is attributed to the parent it NAMES (`relatedTo`, mandatory at filing) where it names
 * one, and otherwise to the slug's sole owner. That second clause is what keeps R2's protection
 * whole for the non-conformant child LOOP-296's fixtures pin — one filed without its own link,
 * which no increment can claim — while a slug with SEVERAL owners leaves it to nobody, which is
 * BOUND 3's own posture for an ambiguity no recorded edge resolves.
 */
export function designChildrenOf(db: DatabaseSync, projectId: string, parentId: string): Set<string> {
  return resolveDesignParents(db, projectId).childrenByParent.get(parentId) ?? new Set<string>();
}

interface DesignParentRow extends DesignParentTicket { related_to?: string }

function resolveDesignParents(
  db: DatabaseSync,
  projectId: string,
  pending?: PendingDesignChild,
): { parents: Set<string>; ownerBySlug: Map<string, string>; childrenByParent: Map<string, Set<string>> } {
  const rows = db.prepare("SELECT id, description, related_to FROM tickets WHERE project_id=?")
    .all(projectId) as unknown as DesignParentRow[];
  const out = new Set<string>();
  const ownerBySlug = new Map<string, string>();
  // The inverse of the ownership read — see `designChildrenOf`. The pending row is deliberately NOT
  // recorded: it has no id yet and is not on the board, and the only consumer asks which BOARD rows
  // a parent stranded.
  const childrenByParent = new Map<string, Set<string>>();
  const recordChild = (parent: string, child: string) => {
    if (child === PENDING_ID) return;
    const set = childrenByParent.get(parent) ?? new Set<string>();
    set.add(child);
    childrenByParent.set(parent, set);
  };
  const onBoard = new Set(rows.map((t) => t.id));
  const slugToChildren = new Map<string, string[]>();

  for (const t of rows) {
    const ptr = designPointerOf(t.description ?? "");
    if (!ptr) continue;
    const asParent = /^parent\s+(\S+)/i.exec(unwrapCodeSpan(ptr));
    // BOUND 1 — the id a child names must be a ticket on THIS board. An unchecked id put `LOOP-2`,
    // which exists nowhere here, into an authorization set; a set of ids nobody can hold is a set
    // nobody can audit.
    if (asParent) {
      if (onBoard.has(asParent[1])) { out.add(asParent[1]); recordChild(asParent[1], t.id); }
      continue;
    }
    // A doc pointer: normalise both spellings to the slug they share.
    const slug = docSlugOf(ptr);
    if (slug) slugToChildren.set(slug, [...(slugToChildren.get(slug) ?? []), t.id]);
  }

  // The pending child joins the derivation for EVERY slug it points at, not only a slug with no
  // children yet. It answers two questions the board alone cannot: a design's FIRST child resolves
  // against a slug with no children, and a child of a LATER increment resolves against the parent it
  // NAMES rather than against the slug's whole history (below). It is added to the board so the
  // adjacency sees the link it declares, and kept out of the fallback's `children.every` set — that
  // quantifier is a CONSTRAINT, so a child filed without its own `relatedTo` (non-conformant, but the
  // shape LOOP-296's fixtures pin) would otherwise un-own its slug for the duration of its own insert
  // and stop inheriting a label it inherits today. The fold stays additive by construction.
  const board: DesignParentRow[] = [...rows];
  let pendingSlug: string | null = null;
  if (pending) {
    const ptr = designPointerOf(pending.description ?? "");
    const slug = ptr && !/^parent\s+\S+/i.test(unwrapCodeSpan(ptr)) ? docSlugOf(ptr) : null;
    if (slug !== null) {
      pendingSlug = slug;
      board.push({ id: PENDING_ID, description: pending.description, related_to: JSON.stringify(pending.relatedTo) });
      onBoard.add(PENDING_ID);
      if (!slugToChildren.has(slug)) slugToChildren.set(slug, []);
    }
  }

  // Resolve each doc slug to the ticket(s) the board RECORDS as owning it. §21a writes both sides of
  // the link — the child carries `relatedTo:[<parent>]` at filing (mandatory, so it survives the
  // parent closing) and the parent back-links every child it staged in one write — so ownership is
  // read out of the link the process is required to record, never out of a sentence.
  //
  // A slug has one owner PER INCREMENT, because a design doc is a living document (§21a) and each
  // increment is decomposed by its own parent. The primary read is the child's own mandatory link:
  // a child names its parent, so the children partition themselves and a ticket that merely
  // neighbours a design never appears — LOOP-420 is `relatedTo` LOOP-409 while the slug's children
  // are LOOP-408/409/410, but no child of that slug names LOOP-420, and that is precisely the ticket
  // this route used to return.
  if (slugToChildren.size) {
    const { linked, declared } = relatedToAdjacency(board, onBoard);
    for (const [slug, children] of slugToChildren) {
      // Every child of the slug INCLUDING the row being inserted, whose own `relatedTo` is the only
      // record of which increment it belongs to. `children` (board rows only) stays separate because
      // the fallback below is a quantifier over it.
      const pendingHere = pendingSlug === slug ? PENDING_ID : null;
      const allChildren = pendingHere ? [...children, pendingHere] : children;
      const childSet = new Set(allChildren);
      const eligible = (t: DesignParentRow) =>
        // A CHILD of this slug is not its own parent — it points AT the doc rather than owning it.
        !childSet.has(t.id)
        // BOUND 2 — a ticket that DECLARES a non-design mode is not a design parent, whatever its
        // links. §21a defines exactly two modes and `Mode: direct-code` is the ticket saying it is
        // code work; that is a stronger statement about the ticket than any link into it.
        && !declaresNonDesignMode(t.description ?? "");
      const candidates = board.filter(eligible);
      const candidateIds = new Set(candidates.map((t) => t.id));

      // OWNERSHIP IS PER INCREMENT, NOT PER SLUG LIFETIME (PR #278 review, P1).
      // `children` is every ticket that has EVER carried a pointer to this slug, because the query
      // deliberately reads the whole board (BOUND 4). §21a defines the design doc as a LIVING
      // per-module document, so a second increment is the normal life of any doc that outlives its
      // first feature — and each parent back-links only the children IT staged. Asking one ticket to
      // be linked to every child the slug ever had therefore fails for BOTH parents once a doc is
      // redesigned: `owners` is empty, the slug resolves to nobody, and the consumers read that as
      // "no design here" — a new child stops inheriting `sensitive` (ticketwrite.ts) and stays on the
      // junior tier. That is LOOP-290's shape again, arriving through the doc's second increment, and
      // it reproduces after the first-child fix (an old parent/child pair plus a new one yields no
      // owner at all).
      //
      // The increment is read off the ONE edge §21a makes MANDATORY at filing — the child's own
      // `relatedTo:[<parent>]`. A child names its parent, and that naming is what makes a parent, so
      // a slug has as many owners as it has increments and each owns exactly the children that name
      // it. A child naming two eligible candidates names neither (BOUND 3 at the child level), which
      // is what keeps an ordinary neighbour out: a neighbour is linked FROM itself, never named BY
      // the child.
      const declaredParentOf = (c: string): string | null => {
        const named = [...(declared.get(c) ?? [])].filter((id) => candidateIds.has(id));
        return named.length === 1 ? named[0] : null;
      };
      const ownerOfChild = new Map<string, string>();
      for (const c of allChildren) {
        const p = declaredParentOf(c);
        if (p) ownerOfChild.set(c, p);
      }
      const declaredOwners = new Set(ownerOfChild.values());

      // The undirected lifetime read is RETAINED as the fallback for a slug no child of which names
      // an eligible candidate — the parent's back-link is a second write, and a child filed without
      // its own link is the shape LOOP-296's fixtures pin. It keeps BOUND 3 exactly as LOOP-372 left
      // it, and it runs over the BOARD's children only: `[].every()` is vacuously true, so a
      // pending-only slug would otherwise hand ownership to every candidate on the board at once.
      const undirected = children.length
        ? candidates.filter((t) => children.every((c) => linked.get(t.id)?.has(c))).map((t) => t.id)
        : [];
      // BOUND 3 (LOOP-372) — two tickets qualifying for one slug is an ambiguous link. Resolve it to
      // NOBODY: returning both would grant the gate to a ticket that is certainly wrong, and picking
      // one by id order would decide an authorization question by an accident of numbering.
      //
      // LOOP-372's BOUND 3a (rank declared designs, prefer the live one) is GONE, because its input
      // can no longer arise: it broke ties among tickets that NAMED a slug, and naming is no longer
      // how a candidate is found.
      //
      // BOUND 3b — the narrowing that separates a parent from a neighbour is now the DERIVATION
      // itself, not a tie-break applied after it: `declaredParentOf` reads the mandatory child→parent
      // edge, so an arbitrary neighbour (linked FROM itself, named BY nobody) never becomes a
      // candidate owner in the first place. That matters most as a slug gets SMALLER — the fallback's
      // `children.every` is satisfied VACUOUSLY by any single neighbour when a slug has exactly one
      // child, which is why the fallback runs only where no child names anyone.
      //
      // Measured on the live 407-row board, the mandatory edge loses nothing and recovers three slugs
      // the undirected read alone could not resolve — `merge-freshness-gate` → LOOP-149 (the parent
      // this ticket was filed about: LOOP-277 is linked to all three children but named by none of
      // them), `design-gate-close` → LOOP-310, `decision-queue-observability` → LOOP-49.
      //
      // EVERY owner is a design parent — a redesigned module has one per increment, and each really
      // did decompose a design. The single-owner rule survives only where it answers a question that
      // must have ONE answer: `ownerBySlug`, whose consumer inherits `sensitive` from the parent of
      // the child being written (ticketwrite.ts). With a pending child that answer is the parent the
      // child ITSELF names, which is well-defined however many increments the doc has had; without
      // one, a contested slug still resolves to NOBODY rather than to whichever sorts first.
      //
      // BOUND 3 still governs the UNDIRECTED fallback unchanged — two tickets each linked to every
      // child is an ambiguity no recorded edge resolves, so it resolves to NOBODY. It does not govern
      // the declared read, where several owners is not an ambiguity but the doc's own history: the
      // children partition themselves, and no child is claimed twice.
      const owners = declaredOwners.size
        ? [...declaredOwners]
        : (undirected.length === 1 ? undirected : []);
      for (const id of owners) out.add(id);
      // The same attribution, inverted for R2's strand check (`designChildrenOf`). A child that
      // names nobody falls to the slug's SOLE owner — which is every single-increment slug, so the
      // gate keeps the reach it had — and to nobody once the doc has been designed twice, because
      // then no recorded edge says which increment stranded it.
      const soleOwner = owners.length === 1 ? owners[0] : null;
      for (const c of allChildren) {
        const p = ownerOfChild.get(c) ?? soleOwner;
        if (p) recordChild(p, c);
      }
      const owner = pendingHere && ownerOfChild.has(pendingHere)
        ? ownerOfChild.get(pendingHere)!
        : (owners.length === 1 ? owners[0] : null);
      if (owner !== null) ownerBySlug.set(slug, owner);
    }
  }
  return { parents: out, ownerBySlug, childrenByParent };
}

/**
 * `relatedTo` read TWICE off one pass, because the two readings answer different questions:
 *
 *  • `linked` — UNDIRECTED. §18 makes the field append-only and the two sides are written by
 *    different actors at different times, so a link recorded on one end only is the normal case, not
 *    a corruption; reading only one direction would make ownership depend on which write landed.
 *  • `declared` — DIRECTED, keyed on the ticket that WROTE the link: `declared.get(child)` is the
 *    set the child itself names. §21a makes exactly this direction mandatory at filing, which is
 *    what lets BOUND 3b separate a parent from a neighbour when the undirected read finds both.
 *
 * One pass, one set of bounds: two traversals of the same column is how the two halves of a rule
 * drift apart (LOOP-344).
 */
function relatedToAdjacency(
  board: readonly DesignParentRow[],
  onBoard: ReadonlySet<string>,
): { linked: Map<string, Set<string>>; declared: Map<string, Set<string>> } {
  const linked = new Map<string, Set<string>>();
  const declared = new Map<string, Set<string>>();
  const join = (m: Map<string, Set<string>>, a: string, b: string) => {
    const set = m.get(a) ?? new Set<string>();
    set.add(b);
    m.set(a, set);
  };
  for (const t of board) {
    let related: unknown;
    // A malformed cell is one ticket's links lost, never the whole derivation: the column is JSON
    // text and this predicate gates authorization for the entire board.
    try { related = JSON.parse(t.related_to ?? "[]"); } catch { continue; }
    if (!Array.isArray(related)) continue;
    for (const other of related) {
      // BOUND 1 (retained) — an id must name a ticket on THIS board. An unchecked id put `LOOP-2`,
      // which exists nowhere here, into an authorization set; a set of ids nobody can hold is a set
      // nobody can audit.
      if (typeof other !== "string" || !onBoard.has(other)) continue;
      join(linked, t.id, other);
      join(linked, other, t.id);
      join(declared, t.id, other);
    }
  }
  return { linked, declared };
}

// §21a's mode marker, read as a bare line like every other marker in this file. `isDesignModeBody`
// answers "does this ticket declare itself a design?"; this answers the sharper question "does it
// declare itself something else?" — which is not the negation, because most tickets declare nothing.
const MODE_MARKER_RE = /^[ \t]*Mode:[ \t]*(\S+)/im;

function declaresNonDesignMode(description: string): boolean {
  // Deferring to isDesignModeBody first is what makes the two provably unable to contradict each
  // other. They read the marker differently on purpose — one anchors at the top of the body, the
  // other takes any bare line — and a body both called "a design" and "not a design" would decide
  // an authorization question by which check ran first.
  if (isDesignModeBody(description)) return false;
  const m = MODE_MARKER_RE.exec(description ?? "");
  return !!m && !/^design/i.test(m[1]);
}

// ONE slug-token rule. It had two consumers — the pointer side (docSlugOf) and a body side — and the
// two resolving different slugs from the same doc name IS LOOP-344's defect; keeping the rule in two
// places is how it came back (LOOP-361). LOOP-379 deleted the body side, so the rule now has a single
// consumer; it is kept as one named constant because both pointer spellings still share it.
//
// Two properties have to hold at once, and each of the obvious one-liners holds only one of them:
//   • `.` is legal INSIDE a slug — `v1.2-module` must survive whole — so `.` cannot leave the class.
//   • a `.` that ENDS the token is sentence punctuation, not slug: `… hubDoc:design/beta-mod.` names
//     `beta-mod`. The old pattern captured `beta-mod.`, which matched no child's slug, so a parent
//     that named its doc at the end of a sentence was invisible (LOOP-361).
// Requiring the LAST character to be a non-dot slug char draws that line inside the pattern: a `.`
// with more slug characters after it is consumed as slug, a `.` with anything else after it is left
// behind for the prose. A trailing-dot strip applied afterwards would get today's cases right too,
// but it decides on `.` without looking at what follows, so it eats a dot the slug would have
// continued through the moment a slug is allowed to end in one.
//
// GREEDY, deliberately — both regressions this file records trace to a lazy quantifier and the
// guard that had to steer it. `\b` let the lazy `+?` stop at the first word boundary, splitting
// `hubDoc:design/widget-engine` into `widget` here while the child side resolved `widget-engine`
// (hence the hyphenated fixture slugs). Replacing `\b` with `(?![A-Za-z0-9._-])` fixed that but
// counted `.` as a slug character, so it then refused to let the match END before a full stop and
// drove the lazy `+?` PAST it — LOOP-361.
// Greedy plus a required non-dot tail needs no trailing guard at all: the match already runs to the
// last non-dot slug char, so the next character can only be a `.` or a non-slug character, and a
// guard asserting exactly that can never fire (verified by differential fuzz before removing it).
// Do NOT re-introduce a lazy quantifier here without restoring one.
const SLUG_TOKEN = "[A-Za-z0-9._-]*[A-Za-z0-9_-]";

/** `<slug>.md` and `<slug>` name the same doc. Applied once, to both sides' captures. */
const stripMdSuffix = (slug: string): string => slug.replace(/\.md$/i, "");

// The natural markdown spelling of a pointer wraps the reference in a code span —
// ``Design: `hubDoc:design/<slug>` `` — and three real children are written that way. Unwrapped
// here, ONCE, beside the `.md` strip, so both sides read the same slug out of it (LOOP-344's
// one-definition rule).
//
// Before this, a wrapped pointer bound to NOTHING and the two halves of one line were read two
// different ways: the capture starts with a backtick so the pointer side refused it and the ticket
// was not a child — and then the body scan found the very same token and made the ticket the doc's
// PARENT. A child holding a correctly-written pointer came back as the parent of the doc it points
// at (LOOP-372). Binding it is the answer rather than special-casing it, because a form that binds
// on neither side is a form that silently means nothing.
const unwrapCodeSpan = (pointer: string): string => {
  const m = /^[*_]*`([^`]+)`/.exec(pointer.trim());
  return m ? m[1].trim() : pointer;
};

// The pointer side keeps its original anchoring exactly: `hubDoc:` matches a prefix of the pointer,
// `docs/design/` must span the whole of it. The `\.?` lets a pointer written at the end of a
// sentence resolve rather than fail the `$` — the same full stop the body side now steps over.
const HUB_POINTER_RE = new RegExp(`^hubDoc:design/(${SLUG_TOKEN})`, "i");
const FILE_POINTER_RE = new RegExp(`^docs/design/(${SLUG_TOKEN})\\.?$`, "i");

/** `hubDoc:design/<slug>` and `docs/design/<slug>.md` normalise to the same slug. */
export function docSlugOf(pointer: string): string | null {
  const p = unwrapCodeSpan(pointer);
  const hub = HUB_POINTER_RE.exec(p);
  if (hub) return stripMdSuffix(hub[1]);
  const file = FILE_POINTER_RE.exec(p);
  return file ? stripMdSuffix(file[1]) : null;
}

// LOOP-379 — there was a BODY_SLUG_RE / docSlugsOfBody pair here that scanned a ticket's prose for
// a doc slug, and it was how a design's owner used to be found. It is deleted rather than bounded a
// fourth time: ownership is now read from `relatedTo` (see designParentIds). Nothing in this module
// reads a description for a slug any more except the CHILD side's `Design:` pointer, which is a
// marker the child writes about itself. Restoring a body scan here re-opens LOOP-420.

export function isDesignModeBody(description: string): boolean {
  return (description ?? "").trimStart().startsWith("Mode: design");
}

/** The shared predicate. `parentIds` comes from designParentIds() for the same board. */
export function isDesignParent(t: DesignParentTicket, parentIds: Set<string>): boolean {
  return isDesignModeBody(t.description ?? "") || parentIds.has(t.id);
}
