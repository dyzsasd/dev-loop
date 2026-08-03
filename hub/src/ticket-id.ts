// The canonical `<PREFIX>-<n>` ticket-id shape (§3 `ticketPrefix`) — ONE source, every reader (LOOP-264).
// Before this module the same shape lived in four hand-copied literals (push-guard, landing, merge-guard,
// and a DIVERGENT one in blocked-by) — and the divergence was not theoretical: blocked-by's copy accepted
// any hyphenated token, so `Blocked-by: LOOP-36 needs-ops-access` parsed `needs-ops-access` as a blocker id.
// A phantom id has no ticket row, so it can never reach a terminal state, and §9c's "unpark only when every
// edge is terminal" then makes that ticket permanently un-unparkable. Hence: one pattern, one file.
//
// The shape is UPPERCASE-canonical — `[A-Z][A-Z0-9]{1,9}` prefix, then a hyphen, then a digit sequence.
// The trailing `\d+` is the load-bearing half: it is what stops a hyphenated prose token from parsing as an
// id. There is no ticket-prefix validator anywhere in `hub/src`, so the field is genuinely unvalidated —
// but the answer to an unvalidated field is ONE agreed shape, not two readers that disagree. Every prefix
// this hub has ever seeded (TEAM, LOOP, PX, W20PROJ, FIXTURE) is inside it.
export const TICKET_ID_PATTERN = "[A-Z][A-Z0-9]{1,9}-\\d+";

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
// normalized id IS the row's id. A hypothetical lowercase-prefix project is out of shape by construction —
// it would need a prefix validator to become reachable, not a wider parser here.
export function canonicalTicketId(token: string): string | null {
  return new RegExp(`^${TICKET_ID_PATTERN}$`, "i").test(token) ? token.toUpperCase() : null;
}
