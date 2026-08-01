// Tests for hub/src/blocked-by.ts — canonical Blocked-by/Unblocked-by parser (LOOP-104).
// Each R2 decision from the dependency-graph design is named as a test.
import { liveBlockerIds, parseMarkerLines } from "../src/blocked-by.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const setEq = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));

// ── parseMarkerLines ──────────────────────────────────────────────────────────
{
  const events = parseMarkerLines(["Blocked-by: LOOP-1 LOOP-2 LOOP-3"]);
  ok(events.length === 1 && events[0].kind === "block" && events[0].ids.length === 3,
    "R2: multi-id line 'Blocked-by: A B C' yields one block event with all three ids");
  ok(events[0].ids.includes("LOOP-1") && events[0].ids.includes("LOOP-3"),
    "R2: all ids extracted from multi-id line");
}
{
  const events = parseMarkerLines(["Unblocked-by: LOOP-5"]);
  ok(events.length === 1 && events[0].kind === "unblock" && events[0].ids[0] === "LOOP-5",
    "R2: 'Unblocked-by: X' produces an unblock event with id X");
}
{
  // prose mention mid-sentence is NOT a marker
  const events = parseMarkerLines(["This is blocked by LOOP-1 in some cases"]);
  ok(events.length === 0, "R2: keyword not at line start is NOT a marker (mid-sentence)");
}
{
  // backtick prose
  const events = parseMarkerLines(["See `Blocked-by: LOOP-9` for reference"]);
  ok(events.length === 0, "R2: keyword inside backticks/mid-line is NOT a marker");
}

// ── liveBlockerIds ────────────────────────────────────────────────────────────
{
  // R2 multi-id: LOOP-50 shape
  const live = liveBlockerIds(["Blocked-by: LOOP-36 LOOP-48 LOOP-51"]);
  ok(setEq(live, ["LOOP-36", "LOOP-48", "LOOP-51"]),
    "R2 multi-id: 'Blocked-by: LOOP-36 LOOP-48 LOOP-51' → all three ids in live set (LOOP-50 shape)");
}
{
  // R2 Unblocked-by: X retires edge whose target is OPEN → excluded from live set
  const live = liveBlockerIds(["Blocked-by: LOOP-7", "Unblocked-by: LOOP-7"]);
  ok(live.size === 0, "R2: Unblocked-by retires a live edge — live set is empty");
}
{
  // R2 Unblocked-by then re-Blocked-by: edge is restored
  const live = liveBlockerIds(["Blocked-by: LOOP-7", "Unblocked-by: LOOP-7", "Blocked-by: LOOP-7"]);
  ok(setEq(live, ["LOOP-7"]), "R2: re-Blocked-by after Unblocked-by restores the edge");
}
{
  // R2 leading whitespace: single space before Blocked-by is still a marker
  const live = liveBlockerIds([" Blocked-by: LOOP-10"]);
  ok(setEq(live, ["LOOP-10"]), "R2: single leading space before 'Blocked-by:' is recognized as a marker");
}
{
  // R2 case-insensitive keyword
  const live = liveBlockerIds(["blocked-BY: LOOP-20"]);
  ok(setEq(live, ["LOOP-20"]), "R2: mixed-case 'blocked-BY:' keyword is recognized");
}
{
  // R2 non-id trailing token ignored
  const live = liveBlockerIds(["Blocked-by: LOOP-36 LOOP-48 (metering)"]);
  ok(setEq(live, ["LOOP-36", "LOOP-48"]),
    "R2: non-id token '(metering)' is ignored; only valid id tokens extracted");
}
{
  // R2 fail-safe: no marker → empty → treated as parked
  const live = liveBlockerIds(["Just a normal comment"]);
  ok(live.size === 0, "R2 fail-safe: no marker → empty live set (caller treats as parked)");
}
{
  // empty body list → empty
  const live = liveBlockerIds([]);
  ok(live.size === 0, "fail-safe: empty comment list → empty live set");
}
{
  // comma-separated ids on one line
  const live = liveBlockerIds(["Blocked-by: LOOP-1, LOOP-2, LOOP-3"]);
  ok(setEq(live, ["LOOP-1", "LOOP-2", "LOOP-3"]), "R2: comma-separated ids are extracted");
}
{
  // mixed whitespace and comma separators
  const live = liveBlockerIds(["Blocked-by: LOOP-1,LOOP-2 LOOP-3"]);
  ok(setEq(live, ["LOOP-1", "LOOP-2", "LOOP-3"]), "R2: mixed comma+space separators work");
}
{
  // P2 fix: ids are preserved as written — prefixes can be lowercase in the DB
  // (uppercasing would cause the case-sensitive ticket lookup to miss lowercase-prefix tickets)
  const events = parseMarkerLines(["Blocked-by: loop-1 LOOP-2"]);
  ok(events[0]?.ids[0] === "loop-1" && events[0]?.ids[1] === "LOOP-2",
    "R2: ids are preserved as written (no case normalization — DB lookup is case-sensitive)");
}
{
  // multi-comment ordering: later Blocked-by wins over earlier Unblocked-by
  const live = liveBlockerIds([
    "Blocked-by: LOOP-5 LOOP-6",
    "Unblocked-by: LOOP-5",
    "Blocked-by: LOOP-5",
  ]);
  ok(setEq(live, ["LOOP-5", "LOOP-6"]), "ordering: later Blocked-by re-adds after Unblocked-by");
}
{
  // multi-line comment body — only marker lines count
  const live = liveBlockerIds(["Here is context.\nBlocked-by: LOOP-99\nSee above."]);
  ok(setEq(live, ["LOOP-99"]), "multi-line body: marker line is found even amid prose lines");
}

{
  // P2 fix: hyphenated prefixes like FOO-BAR yield IDs like FOO-BAR-1; the regex must accept them
  const live = liveBlockerIds(["Blocked-by: FOO-BAR-1 baz-qux-42"]);
  ok(live.has("FOO-BAR-1") && live.has("baz-qux-42"),
    "P2: hyphenated prefix IDs (FOO-BAR-1, baz-qux-42) are accepted by the parser");
}

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nBLOCKED_BY_OK");
