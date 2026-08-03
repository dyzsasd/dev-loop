// Tests for hub/src/blocked-by.ts — canonical Blocked-by/Unblocked-by parser (LOOP-104).
// Each R2 decision from the dependency-graph design is named as a test.
import { liveBlockerIds, parseMarkerLines } from "../src/blocked-by.ts";
import { TICKET_ID_PATTERN, canonicalTicketId, ticketIdScanRe } from "../src/ticket-id.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const setEq = (a: Set<string>, b: string[]) => a.size === b.length && b.every((x) => a.has(x));
const bodies = (...b: string[]) => b.map((body) => ({ body }));

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
  const { live, hadReadFailure } = liveBlockerIds(bodies("Blocked-by: LOOP-36 LOOP-48 LOOP-51"));
  ok(setEq(live, ["LOOP-36", "LOOP-48", "LOOP-51"]),
    "R2 multi-id: 'Blocked-by: LOOP-36 LOOP-48 LOOP-51' → all three ids in live set (LOOP-50 shape)");
  ok(!hadReadFailure, "R2 multi-id: complete comment has hadReadFailure=false");
}
{
  // R2 Unblocked-by: X retires edge whose target is OPEN → excluded from live set
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-7", "Unblocked-by: LOOP-7"));
  ok(live.size === 0, "R2: Unblocked-by retires a live edge — live set is empty");
}
{
  // R2 Unblocked-by then re-Blocked-by: edge is restored
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-7", "Unblocked-by: LOOP-7", "Blocked-by: LOOP-7"));
  ok(setEq(live, ["LOOP-7"]), "R2: re-Blocked-by after Unblocked-by restores the edge");
}
{
  // R2 leading whitespace: single space before Blocked-by is still a marker
  const { live } = liveBlockerIds(bodies(" Blocked-by: LOOP-10"));
  ok(setEq(live, ["LOOP-10"]), "R2: single leading space before 'Blocked-by:' is recognized as a marker");
}
{
  // R2 case-insensitive keyword
  const { live } = liveBlockerIds(bodies("blocked-BY: LOOP-20"));
  ok(setEq(live, ["LOOP-20"]), "R2: mixed-case 'blocked-BY:' keyword is recognized");
}
{
  // R2 non-id trailing token ignored
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-36 LOOP-48 (metering)"));
  ok(setEq(live, ["LOOP-36", "LOOP-48"]),
    "R2: non-id token '(metering)' is ignored; only valid id tokens extracted");
}
{
  // R2 fail-safe: no marker → empty → treated as parked
  const { live, hadReadFailure } = liveBlockerIds(bodies("Just a normal comment"));
  ok(live.size === 0, "R2 fail-safe: no marker → empty live set (caller treats as parked)");
  ok(!hadReadFailure, "R2 fail-safe: complete comment with no markers has hadReadFailure=false");
}
{
  // empty body list → empty
  const { live, hadReadFailure } = liveBlockerIds([]);
  ok(live.size === 0, "fail-safe: empty comment list → empty live set");
  ok(!hadReadFailure, "fail-safe: empty comment list has hadReadFailure=false");
}
{
  // comma-separated ids on one line
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-1, LOOP-2, LOOP-3"));
  ok(setEq(live, ["LOOP-1", "LOOP-2", "LOOP-3"]), "R2: comma-separated ids are extracted");
}
{
  // mixed whitespace and comma separators
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-1,LOOP-2 LOOP-3"));
  ok(setEq(live, ["LOOP-1", "LOOP-2", "LOOP-3"]), "R2: mixed comma+space separators work");
}
{
  // REVERSED BY LOOP-264 (was: "ids are preserved as written"). That clause came from a PR-#142 review
  // thread whose premise — lowercase, hyphen-containing prefixes — this codebase's own canonical id
  // pattern contradicts, and keying the live set on the verbatim token is what let `Unblocked-by:`
  // silently fail to retire a case-different edge. Ids canonicalise UP; the uppercase id IS the row id.
  const events = parseMarkerLines(["Blocked-by: loop-1 LOOP-2"]);
  ok(events[0]?.ids[0] === "LOOP-1" && events[0]?.ids[1] === "LOOP-2",
    "R2 (LOOP-264): ids are CANONICALISED to uppercase — one edge, whatever case it was written in");
}
{
  // multi-comment ordering: later Blocked-by wins over earlier Unblocked-by
  const { live } = liveBlockerIds(bodies(
    "Blocked-by: LOOP-5 LOOP-6",
    "Unblocked-by: LOOP-5",
    "Blocked-by: LOOP-5",
  ));
  ok(setEq(live, ["LOOP-5", "LOOP-6"]), "ordering: later Blocked-by re-adds after Unblocked-by");
}
{
  // multi-line comment body — only marker lines count
  const { live } = liveBlockerIds(bodies("Here is context.\nBlocked-by: LOOP-99\nSee above."));
  ok(setEq(live, ["LOOP-99"]), "multi-line body: marker line is found even amid prose lines");
}
{
  // REVERSED BY LOOP-264 (was: "hyphenated prefix IDs are accepted"). Accepting any hyphenated token is
  // exactly what made `Blocked-by: LOOP-36 needs-ops-access` mint a phantom blocker. No prefix validator
  // exists, so the answer is ONE agreed shape (`<PREFIX>-<digits>`, ticket-id.ts) — not a wider parser.
  const { live } = liveBlockerIds(bodies("Blocked-by: FOO-BAR-1 baz-qux-42"));
  ok(live.size === 0,
    "P2 (LOOP-264): hyphenated-PREFIX tokens (FOO-BAR-1, baz-qux-42) are NOT ids — the shape ends in -<digits>");
}

// ── PM BINDING AC: read integrity (partial/truncated source) ──────────────────
{
  // A comment marked partial=true is a "could not read" signal; the result must carry
  // hadReadFailure=true — distinct from "no markers found" (hadReadFailure=false, empty live set).
  // Regression test: feed a truncated payload and assert the unreadable outcome is returned.
  const { live, hadReadFailure } = liveBlockerIds([{ body: "Blocked-by: LOOP-36 LOOP-48", partial: true }]);
  ok(hadReadFailure === true,
    "BINDING AC read-integrity: partial comment yields hadReadFailure=true (not silently empty)");
  ok(live.size === 0,
    "BINDING AC read-integrity: partial comment body is skipped; live set stays empty (not trusted)");
}
{
  // Partial retirement test: some ids retired, some not — with a partial comment, the whole result
  // is untrustworthy (hadReadFailure=true) even if non-partial comments have live edges.
  const { live, hadReadFailure } = liveBlockerIds([
    { body: "Blocked-by: LOOP-56 LOOP-57" },
    { body: "Unblocked-by: LOOP-56", partial: true },  // retirement itself is unreadable
  ]);
  ok(hadReadFailure === true, "partial retirement: hadReadFailure=true when Unblocked-by comment is partial");
  // LOOP-56 is still in the live set because the partial unblock was skipped (fail-safe preserves it)
  ok(live.has("LOOP-56") && live.has("LOOP-57"),
    "partial retirement: non-partial Blocked-by edges are preserved; partial Unblocked-by is skipped");
}
{
  // AC-B (PM binding): stated decision on indented markers — leading whitespace IS tolerated (zero
  // indented markers on today's corpus, but the rule is explicit and non-accidental per design R2).
  const { live } = liveBlockerIds(bodies("  Blocked-by: LOOP-30", "Normal comment"));
  ok(live.has("LOOP-30"), "AC-B: indented Blocked-by line (2 spaces) IS a marker (R2 explicit rule)");
}
{
  // AC-A (PM binding): partial retirement shape — some edges retired, ≥1 stays live → stays sequenced.
  // LOOP-50 realistic shape.
  const { live, hadReadFailure } = liveBlockerIds(bodies(
    "Blocked-by: LOOP-36 LOOP-48 LOOP-51",
    "Unblocked-by: LOOP-36",
    "Unblocked-by: LOOP-48",
    "Blocked-by: LOOP-54 LOOP-55 LOOP-56 LOOP-57",
    "Unblocked-by: LOOP-54",
    "Unblocked-by: LOOP-55",
  ));
  ok(!hadReadFailure, "AC-A: complete reads have no read failure");
  ok(setEq(live, ["LOOP-51", "LOOP-56", "LOOP-57"]),
    "AC-A: partial retirement — {LOOP-56,LOOP-57,LOOP-51} remain live after partial retirements");
  ok(live.size > 0, "AC-A: partial retirement leaves non-empty set (ticket stays sequenced, not parked)");
}

// ── LOOP-264: the two reversed spec clauses, and the one-shape discipline ─────
// Each of the three below FAILS against 58b2eb0 (the shipped parser accepted any hyphenated token,
// keyed the live set on the verbatim token, and let four modules hand-copy the id shape).
{
  const events = parseMarkerLines(["Blocked-by: LOOP-36 needs-ops-access"]);
  ok(events.length === 1 && events[0].ids.length === 1 && events[0].ids[0] === "LOOP-36",
    `LOOP-264: a hyphenated PROSE token on a marker line is not an id — 'LOOP-36 needs-ops-access' ⇒ [LOOP-36] (got ${JSON.stringify(events[0]?.ids)})`);
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-36 needs-ops-access"));
  ok(setEq(live, ["LOOP-36"]),
    "LOOP-264: liveBlockerIds agrees — no phantom edge, so §9c can never see a never-terminal blocker");
}
{
  const { live } = liveBlockerIds(bodies("Blocked-by: LOOP-36", "Unblocked-by: loop-36"));
  ok(live.size === 0,
    `LOOP-264: retirement is CASE-SYMMETRIC — 'Unblocked-by: loop-36' retires 'Blocked-by: LOOP-36' (got ${JSON.stringify([...live])})`);
  const { live: live2 } = liveBlockerIds(bodies("Blocked-by: loop-36"));
  ok(setEq(live2, ["LOOP-36"]),
    "LOOP-264: ids canonicalise UP — a lowercase marker stores the uppercase row id a WHERE id=? resolves");
  ok(canonicalTicketId("loop-36") === "LOOP-36" && canonicalTicketId("needs-ops-access") === null && canonicalTicketId("LOOP-36") === "LOOP-36",
    "LOOP-264: canonicalTicketId — case-insensitive in, uppercase out, prose-token rejected");
}
{
  // The no-drift assertion (LOOP-144 discipline): the id shape must exist in exactly ONE source file.
  // A future hand-copied literal re-opens the exact divergence this ticket repaired, so grep for it.
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const readers = ["blocked-by.ts", "push-guard.ts", "landing.ts", "merge-guard.ts"];
  const copies = readers.filter((f) => readFileSync(join(srcDir, f), "utf8").includes("[A-Z][A-Z0-9]{1,9}"));
  ok(copies.length === 0,
    `LOOP-264: no reader hand-copies the id shape — all four go through ticket-id.ts (copies found: ${JSON.stringify(copies)})`);
  ok(readers.every((f) => readFileSync(join(srcDir, f), "utf8").includes("ticket-id.ts")),
    "LOOP-264: every id reader imports the shared pattern module");
  ok(ticketIdScanRe("g").flags === "g" && ticketIdScanRe("g") !== ticketIdScanRe("g"),
    "LOOP-264: ticketIdScanRe returns a FRESH RegExp per call (a shared /g instance carries lastIndex across call sites)");
  ok(new RegExp(`^${TICKET_ID_PATTERN}$`).test("W20PROJ-7") && !new RegExp(`^${TICKET_ID_PATTERN}$`).test("FOO-BAR-1"),
    "LOOP-264: the canonical shape admits every seeded prefix (W20PROJ) and rejects the hyphenated-prefix premise (FOO-BAR-1)");
}

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
else console.log("\nBLOCKED_BY_OK");
