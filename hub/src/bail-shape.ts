// Canonical Bail-shape marker parser + vocabulary (Decision 1). Pure, no db — the exact shape of
// blocked-by.ts's canonical marker parser (LOOP-104/LOOP-264: one parser, no drift).
//
// When Dev blocks a ticket (§9) it writes a comment whose FIRST line is
//   `Bail-shape: <info-needed | decision-needed | scope-design | external-prereq | fix-exhausted>`
// The bail-shape LABEL of the same name (seed.ts §4 taxonomy) is DERIVED from that first line at the
// write choke point (ticketwrite.ts insertComment / updateTicketRow), so the machine-routable label
// and the human-readable comment CANNOT name different shapes — the comment is the single source, the
// label is its projection. This module is the ONE place the vocabulary is named and the line is
// parsed; every reader (the derivation, the W46 doctor check, the sweep backfill) folds this parser.

// The five bail-shapes. The LABEL name IS the bail-shape token (1:1), so this set is also the exact
// set of workflow labels the derivation manages. `external-prereq` was seeded first (§9c, W5); the
// other four are added by this decision. (external-code/external-access are `subtype` labels, NOT
// bail-shapes, and are never touched here.)
export const BAIL_SHAPES = ["info-needed", "decision-needed", "scope-design", "external-prereq", "fix-exhausted"] as const;
export type BailShape = (typeof BAIL_SHAPES)[number];
export const BAIL_SHAPE_SET: ReadonlySet<string> = new Set(BAIL_SHAPES);

// A Bail-shape line: the line's FIRST non-whitespace token (case-insensitive) is `Bail-shape:`,
// followed by one shape token. Leading whitespace tolerated; a keyword that is not the line's first
// token is NOT a marker (the prose-mention filter — stated, not accidental, like blocked-by.ts).
const BAIL_RE = /^\s*bail-shape:\s*([a-z][a-z-]*)/i;

// The bail-shape declared by ONE comment body: the first line matching `Bail-shape: <shape>` with a
// KNOWN shape. An unknown/misspelled token is skipped (keep scanning), and null means "no parseable
// bail-shape in this comment" — the fail-closed direction the W46 check and the notify gate rely on.
export function parseBailShape(body: string): BailShape | null {
  for (const line of body.split(/\r?\n/)) {
    const m = BAIL_RE.exec(line);
    if (!m) continue;
    const shape = m[1].toLowerCase();
    if (BAIL_SHAPE_SET.has(shape)) return shape as BailShape;
  }
  return null;
}

// The LATEST parseable bail-shape across a ticket's comment bodies (chronological order in, newest
// wins). One bail-shape per block comment is the convention; a re-block writes a fresh comment, so
// the newest parseable one is the current shape. null ⇒ no parseable Bail-shape comment exists.
export function latestBailShape(commentBodiesInOrder: string[]): BailShape | null {
  let latest: BailShape | null = null;
  for (const body of commentBodiesInOrder) {
    const s = parseBailShape(body);
    if (s) latest = s;
  }
  return latest;
}
