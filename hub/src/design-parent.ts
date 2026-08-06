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
 * For the two doc forms the parent is the open ticket carrying the SAME pointer with a `Mode: design`
 * body — i.e. the design ticket the children were staged under. That is a reverse link like the
 * `parent <id>` case, just keyed on the slug instead of on an id.
 *
 * The doc-slug route is an INFERENCE — it reads ownership of a design out of a ticket naming that
 * design in prose — so it is bounded on three sides (LOOP-372). Measured on this board before those
 * bounds, it returned 19 parents of which 5 were design tickets; nine were ordinary Bugs and
 * Improvements that merely mentioned a doc, and three of those nine were design CHILDREN inverted
 * into the parent role. `isDesignParent` is not a display predicate — it decides pm/qa queue
 * routing, the LOOP-345 close gate, and the LOOP-360 zero-commit handoff exemption — so an
 * over-match hands ordinary code tickets an authorization they were never meant to have.
 */
export function designParentIds(db: DatabaseSync, projectId: string, rows?: DesignParentTicket[]): Set<string> {
  const open = rows ?? (db.prepare("SELECT id, description, state FROM tickets WHERE project_id=?")
    .all(projectId) as unknown as DesignParentTicket[]);
  const out = new Set<string>();
  const onBoard = new Set(open.map((t) => t.id));
  const slugToChildren = new Map<string, string[]>();

  for (const t of open) {
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

  // Resolve each doc slug to the ticket that OWNS that design: the one whose BODY names the same
  // slug and which is not itself a child of it.
  //
  // Crucially this does NOT require a `Mode: design` body. That was my first implementation and it
  // failed its own fixture: the whole point of LOOP-344 is that these parents are invisible, and the
  // reason they are invisible is that they carry neither `Mode: design` NOR a `parent <id>` reverse
  // link — only a `qa` label inherited from their type. Requiring the marker would have "fixed" only
  // the parents that were already being routed correctly. So the marker RANKS candidates below; it
  // never gates them.
  if (slugToChildren.size) {
    const bodyOf = new Map(open.map((t) => [t.id, t.description ?? ""]));
    const candidates = new Map<string, string[]>();
    for (const t of open) {
      const body = t.description ?? "";
      // BOUND 2 — a ticket that DECLARES a non-design mode is not a design parent, whatever its
      // prose mentions. §21a defines exactly two modes and `Mode: direct-code` is the ticket saying
      // it is code work; that is a stronger statement about the ticket than any sentence in it.
      if (declaresNonDesignMode(body)) continue;
      const ownPtr = designPointerOf(body);
      for (const slug of docSlugsOfBody(body)) {
        if (!slugToChildren.has(slug)) continue;
        // A CHILD of this slug is not its parent — it points AT the doc rather than owning it.
        // Asserted on the LINE, not on whether the line parses: a pointer the pointer-side rule
        // rejects still says "I am a child of this doc", and reading the same line two ways is what
        // put LOOP-278/279/323 in the parent role.
        if (ownPtr && pointerNames(ownPtr, slug)) continue;
        candidates.set(slug, [...(candidates.get(slug) ?? []), t.id]);
      }
    }
    for (const [, cands] of candidates) {
      // Rank, then require a UNIQUE winner. `Mode: design` is the one candidate-ranking signal that
      // is a declaration rather than a mention.
      const marked = cands.filter((id) => isDesignModeBody(bodyOf.get(id) ?? ""));
      const winners = marked.length ? marked : cands;
      // BOUND 3 — two tickets naming one slug is an ambiguous link, and the inference has nothing
      // left to break the tie with. Resolve it to NOBODY: returning both would grant the gate to a
      // ticket that is certainly wrong, and picking one by id order would decide an authorization
      // question by an accident of numbering.
      if (winners.length === 1) out.add(winners[0]);
    }
  }
  return out;
}

/** A `Design:` line NAMES this slug — whether or not the pointer form parses. */
function pointerNames(pointer: string, slug: string): boolean {
  return docSlugOf(pointer) === slug || docSlugsOfBody(pointer).has(slug);
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

// ONE slug-token rule, shared by the pointer side (docSlugOf) and the body side (docSlugsOfBody) —
// so the two can never resolve different slugs from the same doc name. That divergence IS LOOP-344's
// defect, and keeping the rule in two places is how it came back (LOOP-361).
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

// A design PARENT's own body may name its doc anywhere (the slug line, a `doc:` reference), not as a
// `Design:` pointer — that pointer is the CHILD's marker. Scan for the same slug shapes in the body,
// through the same SLUG_TOKEN rule the pointer side uses.
//
// EVERY occurrence, not the first: a body naming two docs used to resolve only the earlier one, so a
// ticket could not be seen naming the slug it was being weighed for — and the tie-break above needs
// to see every ticket that names a slug in order to know the link is contested at all.
const BODY_SLUG_RE = new RegExp(`(?:hubDoc:design/|docs/design/)(${SLUG_TOKEN})`, "gi");

function docSlugsOfBody(description: string): Set<string> {
  const out = new Set<string>();
  // `matchAll` clones the regex but SEEDS the clone with this one's `lastIndex`, so a global regex
  // shared at module scope carries state between calls the moment anything `exec`s it. Reset rather
  // than rely on nothing ever doing so.
  BODY_SLUG_RE.lastIndex = 0;
  for (const m of (description ?? "").matchAll(BODY_SLUG_RE)) out.add(stripMdSuffix(m[1]));
  return out;
}

export function isDesignModeBody(description: string): boolean {
  return (description ?? "").trimStart().startsWith("Mode: design");
}

/** The shared predicate. `parentIds` comes from designParentIds() for the same board. */
export function isDesignParent(t: DesignParentTicket, parentIds: Set<string>): boolean {
  return isDesignModeBody(t.description ?? "") || parentIds.has(t.id);
}
