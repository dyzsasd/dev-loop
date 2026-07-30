// The memory behind the stall watchdog's retry-loop detector (run-agents.ts): does the child's
// output keep introducing GENUINELY NEW lines, or is it repeating itself? We answer that by
// remembering the lines recently seen — and "recently" is the whole point.
//
// The first cut (LOOP-7) used a plain Set that stopped adding at 200 entries and never evicted:
//
//     if (!seenLines.has(l)) { lastNewContentAt = now; if (seenLines.size < 200) seenLines.add(l); }
//
// Its own comment called it a "bounded rolling set", but it did not roll — it FROZE on the first
// 200 distinct lines. Once frozen, every line emitted afterwards was absent from the frozen prefix,
// so it read as new content forever. The production failure that left inert (LOOP-23): a real
// opencode fire streams thousands of distinct tool lines and saturates the 200 within seconds; when
// the provider later starts returning 429 and the CLI loops on a verbatim "rate limit exceeded,
// retrying in 2s…", that line is not in the frozen prefix, so each repeat refreshed lastNewContentAt
// and the watchdog never tripped — the fire burned its full timeout producing nothing.
//
// makeSeenLineWindow is the fix: a bounded set that EVICTS THE OLDEST entry on overflow (FIFO), so
// it always holds the most-recent `cap` distinct lines instead of a frozen prefix. Why it cannot
// degrade the way the frozen prefix did: the window follows the output forward, so a loop that
// begins at ANY point — after 200 distinct lines or after a million — has its repeating line inside
// the window at the moment it starts. The first occurrence is new (once); every repeat is then
// recognised as already-seen, so lastNewContentAt stops advancing and the watchdog trips. During a
// genuine loop no NEW distinct lines arrive, so nothing evicts the looping line — detection is
// stable however long the loop runs. And memory stays O(cap): the set never exceeds `cap` entries no
// matter how much unique output the fire streams — the exact property the 200-cap protected, now
// kept WITHOUT the freeze. (A plain FIFO, not an LRU: a genuine retry loop emits no new distinct
// lines, so there is nothing to keep "warm" — recency of eviction only matters while new content is
// arriving, which is precisely when the fire is healthy and we do not want to trip.)
export const RETRY_LOOP_LINE_WINDOW = 200;

export interface SeenLineWindow {
  /** Record `line`; return true iff it is GENUINELY NEW (was not already in the window). */
  markNew(line: string): boolean;
  /** Current entry count — never exceeds the window cap (the bounded-memory invariant). */
  readonly size: number;
}

export function makeSeenLineWindow(cap: number = RETRY_LOOP_LINE_WINDOW): SeenLineWindow {
  // A JS Set iterates in insertion order, so its first key is always the oldest entry — an O(1) FIFO
  // queue for free. On overflow we drop that oldest key before inserting the newcomer.
  const seen = new Set<string>();
  return {
    markNew(line: string): boolean {
      if (seen.has(line)) return false;
      if (seen.size >= cap) seen.delete(seen.values().next().value as string);
      seen.add(line);
      return true;
    },
    get size(): number { return seen.size; },
  };
}
