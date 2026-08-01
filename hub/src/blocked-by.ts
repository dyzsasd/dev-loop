// Canonical Blocked-by / Unblocked-by marker parser (LOOP-104).
// Pure, no db. A marker line is a line whose first non-whitespace token (case-insensitive)
// is "Blocked-by:" or "Unblocked-by:". Leading whitespace is tolerated; a keyword that is
// not the line's first token is NOT a marker (keeps the prose-mention filter — stated, not accidental).
// Convention: a marker line carries ids only after the keyword; unrelated ids as prose on a marker
// line are treated as part of the marker. Authors should not mix marker lines with prose.
const MARKER_RE = /^\s*(blocked-by|unblocked-by):\s*(.*)/i;
// Ticket IDs are stored verbatim (case-sensitive DB lookup). Prefixes can be lowercase and can
// contain hyphens (e.g. "FOO-BAR-1" from a "FOO-BAR" prefix + seq 1). The pattern requires at
// least one letter-start segment followed by one or more hyphen-alphanumeric groups.
const ID_RE = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)+$/;

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
  const live = new Set<string>();
  for (const { body, partial } of comments) {
    if (partial) { hadReadFailure = true; continue; }
    for (const line of body.split(/\r?\n/)) {
      const m = MARKER_RE.exec(line);
      if (!m) continue;
      const kind = m[1].toLowerCase() === "blocked-by" ? "block" as const : "unblock" as const;
      const ids = extractIds(m[2]);
      for (const id of ids) {
        if (kind === "block") live.add(id);
        else live.delete(id);
      }
    }
  }
  return { live, hadReadFailure };
}
