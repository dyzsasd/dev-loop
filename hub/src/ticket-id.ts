// The canonical `<PREFIX>-<n>` ticket-id shape (§3 `ticketPrefix`) — ONE source, every reader (LOOP-264).
// Before this module the same shape lived in four hand-copied literals (push-guard, landing, merge-guard,
// and a DIVERGENT one in blocked-by) — and the divergence was not theoretical: blocked-by's copy accepted
// any hyphenated token, so `Blocked-by: LOOP-36 needs-ops-access` parsed `needs-ops-access` as a blocker id.
// A phantom id has no ticket row, so it can never reach a terminal state, and §9c's "unpark only when every
// edge is terminal" then makes that ticket permanently un-unparkable. Hence: one pattern, one file.
//
// The shape is UPPERCASE-canonical — a `[A-Z][A-Z0-9]*` prefix, a hyphen, then a digit sequence.
// The trailing `\d+` is the load-bearing half: it is what stops a hyphenated prose token from parsing as an
// id, and it holds for EVERY minted id by construction (`db.ts` nextTicketId: `${ticket_prefix}-${seq}`,
// and `seq` is an integer column).
//
// The prefix half is bounded only by `[A-Z][A-Z0-9]*` — deliberately NOT the `{1,9}` this module first
// carried. That bound was copied from push-guard's free-text scanner and is narrower than what the hub can
// actually mint, in both directions:
//   • MIN — `derivePrefix` (team-edit.ts) derives the prefix from the project key: a one-character key
//     yields a one-character prefix, so `X-1` is a real id that `[A-Z][A-Z0-9]{1,9}-\d+` rejects outright.
//   • MAX — the same function de-clashes by appending a counter, so an 8-char base can exceed 10 chars.
// A reader that rejects a legal id is not "strict", it is wrong: in blocked-by that silently drops a
// dependency edge, which is the same never-terminal-edge failure the phantom-id case causes, approached
// from the other side. So the shape is exactly the §3 spec clause: `/^[A-Z][A-Z0-9]*-\d+$/`.
//
// What keeps that shape TRUE rather than merely assumed is `TICKET_PREFIX_RE` below, enforced at the one
// INSERT that creates a project (`seed.ts` ensureProject). Before it, the field was genuinely unvalidated
// and out-of-shape prefixes were reachable — `--prefix` was passed through verbatim (lowercase, hyphens),
// and even the derive path could emit a digit-leading prefix from a key like `2fa`. Validating at the
// source is what lets every reader here stay narrow.
export const TICKET_ID_PATTERN = "[A-Z][A-Z0-9]*-\\d+";

// The prefix half on its own — the same source, so the validator and the id readers can never disagree
// about what a prefix is. Anchored and case-SENSITIVE: a prefix is stored uppercase or it is not valid.
export const TICKET_PREFIX_RE = /^[A-Z][A-Z0-9]*$/;

// True when `prefix` can appear in a canonical ticket id. Callers that mint or accept a ticket prefix
// MUST gate on this — see the note above `TICKET_ID_PATTERN`.
export function isCanonicalTicketPrefix(prefix: string): boolean {
  return TICKET_PREFIX_RE.test(prefix);
}

// A word-boundary scanner over FREE TEXT (commit subjects, branch names, PR bodies).
// Deliberately case-SENSITIVE: these readers scan prose that is full of lowercase hyphenated words, and
// widening them to match `abc-1` would invent ticket refs, not find them. Returns a FRESH RegExp per call —
// a shared `/g` instance carries `lastIndex` across call sites, which is a real cross-module bug source.
export function ticketIdScanRe(flags = ""): RegExp {
  return new RegExp(`\\b${TICKET_ID_PATTERN}\\b`, flags);
}

// Anchored, case-INSENSITIVE token test that returns the id in its canonical UPPERCASE form, or null.
// Case-insensitive on the way IN, canonical on the way OUT, so `LOOP-36` and `loop-36` are the same edge:
// a marker set keyed on the verbatim token lets `Unblocked-by: loop-36` silently fail to retire the edge
// `Blocked-by: LOOP-36` created. Canonicalizing UP (never down) is what keeps a consumer's
// `SELECT … WHERE id = ?` resolving: hub ticket rows are stored with the uppercase prefix, so the
// normalized id IS the row's id. A lowercase-prefix project cannot exist to contradict that — not as an
// assumption, but because `isCanonicalTicketPrefix` refuses one at the seeding INSERT.
export function canonicalTicketId(token: string): string | null {
  return new RegExp(`^${TICKET_ID_PATTERN}$`, "i").test(token) ? token.toUpperCase() : null;
}
