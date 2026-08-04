import { canonicalTicketId } from "./ticket-id.ts";

// Canonical Blocked-by / Unblocked-by marker parser (LOOP-104).
// Pure, no db. A marker line is a line whose first non-whitespace token (case-insensitive)
// is "Blocked-by:" or "Unblocked-by:". Leading whitespace is tolerated; a keyword that is
// not the line's first token is NOT a marker (keeps the prose-mention filter — stated, not accidental).
// Convention: a marker line carries ids only after the keyword; unrelated ids as prose on a marker
// line are treated as part of the marker. Authors should not mix marker lines with prose.
const MARKER_RE = /^\s*(blocked-by|unblocked-by):\s*(.*)/i;
// The id shape is NOT defined here — it is the one canonical `<PREFIX>-<n>` pattern (`ticket-id.ts`),
// shared with push-guard / landing / merge-guard so the loop cannot hold two disagreeing definitions
// (LOOP-264; the LOOP-144 no-drift discipline). Two clauses this module states explicitly, because a
// reviewer has already reopened both:
//   • A hyphenated prose token is NOT an id. The canonical shape ends in `-<digits>`, so
//     `Blocked-by: LOOP-36 needs-ops-access` yields ["LOOP-36"] and never a phantom edge — a phantom
//     has no ticket row, so it can never go terminal, and §9c would leave the ticket un-unparkable.
//   • Membership is CASE-NORMALISED, not verbatim: ids are matched case-insensitively and canonicalised
//     to uppercase, so `Unblocked-by: loop-36` retires the edge `Blocked-by: LOOP-36` opened. Verbatim
//     keying silently splits one edge into two. The DB-lookup concern this answers head-on: hub rows
//     carry the uppercase prefix, so the canonical (upper) id IS the row id a consumer's
//     `SELECT … WHERE id = ?` resolves (`metrics.ts` hasLiveBlockerEdge) — canonicalise UP, never down.
function extractIds(remainder: string): string[] {
  const ids: string[] = [];
  for (const token of remainder.split(/[\s,]+/)) {
    const id = canonicalTicketId(token);
    if (id) ids.push(id);
  }
  return ids;
}

export function parseMarkerLines(commentBodiesInOrder: string[]): { kind: "block" | "unblock"; ids: string[] }[] {
  const events: { kind: "block" | "unblock"; ids: string[] }[] = [];
  for (const body of commentBodiesInOrder) {
    for (const line of body.split(/\r?\n/)) {
      const m = MARKER_RE.exec(line);
      if (!m) continue;
      const kind: "block" | "unblock" = m[1].toLowerCase() === "blocked-by" ? "block" : "unblock";
      const ids = extractIds(m[2]);
      if (ids.length) events.push({ kind, ids });
    }
  }
  return events;
}

// Result type that distinguishes "no markers found" from "source could not be fully read".
// hadReadFailure: true when any source comment was marked partial/truncated — the live set is
// untrustworthy and callers must NOT treat it as authoritative (do not unpark or unblock on it).
export interface BlockerParseResult {
  live: Set<string>;
  hadReadFailure: boolean;
}

// Parse a ticket's comment bodies (chronological) into its live blocker id set.
// Fail-safe: no marker → empty set (caller treats as parked — the safe under-report direction).
// Read integrity: a partial/truncated comment sets hadReadFailure=true; its body is skipped so
// surviving markers from a partial read cannot be mistaken for a complete dependency ledger.
export function liveBlockerIds(
  comments: Array<{ body: string; partial?: boolean }>,
): BlockerParseResult {
  let hadReadFailure = false;
  const readable: string[] = [];
  for (const { body, partial } of comments) {
    if (partial) { hadReadFailure = true; continue; }
    readable.push(body);
  }
  // Fold the SAME events parseMarkerLines produces — this function used to re-implement the marker walk,
  // which is precisely the drift this module exists to remove (LOOP-264): two copies of the walk meant a
  // fix to the id shape or the prose filter could land in one reader and miss the other.
  const live = new Set<string>();
  for (const { kind, ids } of parseMarkerLines(readable)) {
    for (const id of ids) {
      if (kind === "block") live.add(id);
      else live.delete(id);
    }
  }
  return { live, hadReadFailure };
}
