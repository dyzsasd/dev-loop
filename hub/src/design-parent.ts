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
 * For the two doc forms the parent is the ticket the board RECORDS as owning that slug: the one
 * linked to every child of the slug through `relatedTo`. That is a reverse link like the
 * `parent <id>` case, just keyed on the slug instead of on an id.
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
 * The ticket that owns doc slug `slug`, or null. The SAME derivation `designParentIds` uses —
 * exported so a caller that has a slug and wants its owner never re-derives one (LOOP-379).
 * ticketwrite.ts's `sensitive` inheritance did re-derive it, by scanning candidate bodies for the
 * slug text; under the back-link rule an owner need not name its own doc anywhere (LOOP-399 does
 * not), so that scan would have found nobody and the label would have stopped being inherited by
 * exactly the doc-pointer children LOOP-296 exists to protect.
 */
export function designOwnerOfSlug(db: DatabaseSync, projectId: string, slug: string): string | null {
  return resolveDesignParents(db, projectId).ownerBySlug.get(slug) ?? null;
}

interface DesignParentRow extends DesignParentTicket { related_to?: string }

function resolveDesignParents(
  db: DatabaseSync,
  projectId: string,
): { parents: Set<string>; ownerBySlug: Map<string, string> } {
  const board = db.prepare("SELECT id, description, related_to FROM tickets WHERE project_id=?")
    .all(projectId) as unknown as DesignParentRow[];
  const out = new Set<string>();
  const ownerBySlug = new Map<string, string>();
  const onBoard = new Set(board.map((t) => t.id));
  const slugToChildren = new Map<string, string[]>();

  for (const t of board) {
    const ptr = designPointerOf(t.description ?? "");
    if (!ptr) continue;
    const asParent = /^parent\s+(\S+)/i.exec(unwrapCodeSpan(ptr));
    // BOUND 1 — the id a child names must be a ticket on THIS board. An unchecked id put `LOOP-2`,
    // which exists nowhere here, into an authorization set; a set of ids nobody can hold is a set
    // nobody can audit.
    if (asParent) { if (onBoard.has(asParent[1])) out.add(asParent[1]); continue; }
    // A doc pointer: normalise both spellings to the slug they share.
    const slug = docSlugOf(ptr);
    if (slug) slugToChildren.set(slug, [...(slugToChildren.get(slug) ?? []), t.id]);
  }

  // Resolve each doc slug to the ticket the board RECORDS as owning it: the one linked to EVERY
  // child of that slug through `relatedTo`, in either direction. §21a writes both sides — the child
  // carries `relatedTo:[<parent>]` at filing (mandatory, so it survives the parent closing) and the
  // parent back-links every child in one write — so ownership is read out of the link the process is
  // required to record, never out of a sentence.
  //
  // EVERY child, not any: a ticket that merely neighbours a design is commonly related to one of its
  // children. LOOP-420 is `relatedTo` LOOP-409 alone while the slug's children are LOOP-408/409/410,
  // and that is precisely the ticket this route used to return.
  if (slugToChildren.size) {
    const linked = relatedToAdjacency(board, onBoard);
    for (const [slug, children] of slugToChildren) {
      const childSet = new Set(children);
      const owners = board.filter((t) =>
        // A CHILD of this slug is not its own parent — it points AT the doc rather than owning it.
        !childSet.has(t.id)
        // BOUND 2 — a ticket that DECLARES a non-design mode is not a design parent, whatever its
        // links. §21a defines exactly two modes and `Mode: direct-code` is the ticket saying it is
        // code work; that is a stronger statement about the ticket than any link into it.
        && !declaresNonDesignMode(t.description ?? "")
        && children.every((c) => linked.get(t.id)?.has(c)));
      // BOUND 3 (LOOP-372, retained unchanged) — two tickets qualifying for one slug is an ambiguous
      // link and there is nothing left to break the tie with. Resolve it to NOBODY: returning both
      // would grant the gate to a ticket that is certainly wrong, and picking one by id order would
      // decide an authorization question by an accident of numbering.
      //
      // LOOP-372's BOUND 3a (rank declared designs, prefer the live one) is GONE, because its input
      // can no longer arise: it broke ties among tickets that NAMED a slug, and naming is no longer
      // how a candidate is found. A module designed twice — the lifecycle 3a existed for — now has
      // each design linked to its own children only, so neither covers the union and the slug
      // resolves to nobody rather than to the elder declaration. That is AC2 of LOOP-379 as ruled,
      // and it is stated here because it is a behaviour change no AC asserts.
      if (owners.length === 1) { out.add(owners[0].id); ownerBySlug.set(slug, owners[0].id); }
    }
  }
  return { parents: out, ownerBySlug };
}

/**
 * `relatedTo` as an UNDIRECTED adjacency. §18 makes the field append-only and the two sides are
 * written by different actors at different times, so a link recorded on one end only is the normal
 * case, not a corruption — reading it in one direction would make ownership depend on which write
 * happened to land.
 */
function relatedToAdjacency(board: readonly DesignParentRow[], onBoard: ReadonlySet<string>): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const join = (a: string, b: string) => {
    const set = adj.get(a) ?? new Set<string>();
    set.add(b);
    adj.set(a, set);
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
      join(t.id, other);
      join(other, t.id);
    }
  }
  return adj;
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
