// Canonical Blocked-by / Unblocked-by marker parser (LOOP-104).
// Pure, no db. A marker line is a line whose first non-whitespace token (case-insensitive)
// is "Blocked-by:" or "Unblocked-by:". Leading whitespace is tolerated; a keyword that is
// not the line's first token is NOT a marker (keeps the prose-mention filter — stated, not accidental).
// Convention: a marker line carries ids only after the keyword; unrelated ids as prose on a marker
// line are treated as part of the marker. Authors should not mix marker lines with prose.
const MARKER_RE = /^\s*(blocked-by|unblocked-by):\s*(.*)/i;
// Case-insensitive: ticket prefixes can be lowercase (e.g. "foo-1") and are stored verbatim
// in the DB — do NOT uppercase IDs or the case-sensitive lookup in hasLiveBlockerEdge will miss them.
const ID_RE = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$/;

function extractIds(remainder: string): string[] {
  return remainder
    .split(/[\s,]+/)
    .filter((t) => ID_RE.test(t));
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

// Parse a ticket's comment bodies (chronological) into its live blocker id set.
// Fail-safe: no marker → empty set (caller treats as parked — the safe under-report direction).
export function liveBlockerIds(commentBodiesInOrder: string[]): Set<string> {
  const live = new Set<string>();
  for (const { kind, ids } of parseMarkerLines(commentBodiesInOrder)) {
    for (const id of ids) {
      if (kind === "block") live.add(id);
      else live.delete(id);
    }
  }
  return live;
}
