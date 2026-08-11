// LOOP-476 — two ways a fire's usage row could state a partial observation as a complete one.
//
// 1. `opencodeAdapter.parse()` took the LAST `step_finish` as the fire's total. That is correct only if
//    opencode's per-event numbers are CUMULATIVE, which nobody had measured — the adapter said so itself
//    ("unverified — single-step sample only"). They are not: they are PER-TURN, so last-match reported one
//    turn as the whole fire. The fixture beside this file is the measurement, not an illustration.
// 2. The runner's stdout buffer is capped at 4 MiB. Past the cap the tail is dropped, and every complete
//    event before it still parses — so an overflowing fire kept reporting an EARLY-turn value as its total.
//    Summing makes that worse, not better: the prefix now understates by however much was dropped.
//
// Both feed `classifyFireError`'s budget arm (LOOP-445), which decides whether a killed fire is recorded as
// a real ceiling breach or as a modelled deadline. A number that is wrong by 44× is not a rounding error
// there — it is the difference between the two classes.
import { opencodeAdapter, makeStdoutCapture, usageFromCapture, MAX_FULL_STDOUT } from "../src/fire-usage.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "opencode-multistep.jsonl");
const stream = readFileSync(FIXTURE, "utf8");

// ── The fixture's own provenance ────────────────────────────────────────────────────────────────
// A hand-written fixture is what encoded the wrong shape in the first place (LOOP-14), so this file
// asserts the sample still carries the property it was captured to prove. If someone regenerates it
// from a synthetic monotone stream, these fail rather than silently re-opening the question.
const steps = stream.split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => JSON.parse(l) as { type: string; part?: { cost?: number; tokens?: { input: number; output: number; cache: { read: number; write: number } } } })
  .filter((e) => e.type === "step_finish");
ok(steps.length === 19, `fixture: a real 19-turn opencode fire (got ${steps.length} step_finish events)`);
const costs = steps.map((s) => s.part!.cost!);
const decreases = costs.slice(1).filter((c, i) => c < costs[i]!).length;
ok(decreases > 0,
  `fixture: cost DECREASES between consecutive turns ${decreases} time(s) — the property that proves the ` +
  "numbers are per-turn, since a cumulative counter cannot go down");
const inputs = steps.map((s) => s.part!.tokens!.input);
const reads = steps.map((s) => s.part!.tokens!.cache.read);
ok(inputs.slice(1).some((n, i) => n < inputs[i]!),
  "fixture: tokens.input DECREASES between turns too — a running input total could not");
ok(inputs[1]! < inputs[0]! && reads[1]! > reads[0]!,
  `fixture: turn 1 reports ${inputs[1]} input where turn 0 reported ${inputs[0]}, with the prefix now billed as ` +
  `cache.read (${reads[0]} → ${reads[1]}) — each event covers THAT turn, not the conversation so far`);

// ── AC2: parse() sums the turns ─────────────────────────────────────────────────────────────────
const expectedCost = costs.reduce((a, b) => a + b, 0);
const lastCost = costs[costs.length - 1]!;
const parsed = opencodeAdapter.parse(stream);
ok(parsed !== null, "parse: a real multi-step stream yields usage");
ok(near(parsed!.costUsd!, expectedCost),
  `AC2: costUsd is the SUM across all 19 turns ($${expectedCost.toFixed(9)}; got $${parsed!.costUsd!.toFixed(9)})`);
// The discriminating assertion: the old behaviour is a specific, available number, so this fails loudly
// if last-match ever returns — a plain "> 0" would pass under both implementations.
ok(!near(parsed!.costUsd!, lastCost),
  `AC2: …and NOT the last turn alone ($${lastCost.toFixed(9)} — 2.3% of the real spend, the pre-LOOP-476 row)`);
ok(parsed!.inputTokens === steps.reduce((a, s) => a + s.part!.tokens!.input, 0),
  `AC2: inputTokens summed across turns (${parsed!.inputTokens})`);
ok(parsed!.outputTokens === steps.reduce((a, s) => a + s.part!.tokens!.output, 0),
  `AC2: outputTokens summed across turns (${parsed!.outputTokens})`);
ok(parsed!.cacheReadTokens === steps.reduce((a, s) => a + s.part!.tokens!.cache.read, 0),
  `AC2: cacheReadTokens summed across turns (${parsed!.cacheReadTokens})`);
ok(opencodeAdapter.turns?.(stream) === 19, "turns() still counts the same 19 events the sum walks");

// A single-turn fire is the case last-match got right, and summing must not change it.
{
  const one = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 10, output: 3, cache: { read: 1, write: 2 } }, cost: 0.25 } }),
  ].join("\n");
  const u = opencodeAdapter.parse(one)!;
  ok(u.costUsd === 0.25 && u.inputTokens === 10 && u.outputTokens === 3 && u.cacheReadTokens === 1 && u.cacheWriteTokens === 2,
    "AC2: a single-turn fire is unchanged — the sum of one turn is that turn");
}

// Absent is not zero: a lane whose events carry no `cost` reports UNKNOWN, never $0.00. LOOP-445's whole
// classification rests on being able to tell "measured nothing" from "did not measure".
{
  const noCost = [
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 5, output: 5 } } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 7, output: 2 } } }),
  ].join("\n");
  const u = opencodeAdapter.parse(noCost)!;
  ok(u.costUsd === null && u.currency === null, "AC2: no event carried a cost ⇒ costUsd null, NOT 0");
  ok(u.cacheReadTokens === null && u.cacheWriteTokens === null, "AC2: a bucket no event reported stays null, NOT 0");
  ok(u.inputTokens === 12 && u.outputTokens === 7, "AC2: …while the buckets that WERE reported still sum");
}
ok(opencodeAdapter.parse("") === null && opencodeAdapter.parse("not json\n{}") === null,
  "AC2: no usage-bearing event at all ⇒ null (an honest miss, not a zero-filled row)");

// ── AC3/AC4: a truncated capture is UNKNOWN, not its prefix ─────────────────────────────────────
{
  // 1600 bytes lands mid-way through the 5th line, so the prefix holds TWO complete step_finish events.
  // That is the shape that makes this defect dangerous: the survivors parse perfectly.
  const cap = 1600;
  const capture = makeStdoutCapture(cap);
  // Feed real turns until the cap drops bytes. The prefix therefore holds COMPLETE, parseable events —
  // which is exactly why the old code reported a number here instead of admitting the gap.
  const lines = stream.split("\n").filter(Boolean);
  for (const l of lines) capture.append(l + "\n");
  ok(capture.truncated(), `AC3: appending ${lines.length} real event lines past a ${cap}-byte cap marks the capture truncated`);
  ok(capture.text().length === cap, "AC3: …and the buffer holds exactly the cap's worth of prefix");

  // The two halves of the defect, asserted separately: the prefix IS parseable (so "null" cannot be
  // explained away as an empty buffer), and the shipped path returns null anyway.
  const prefixValue = opencodeAdapter.parse(capture.text());
  ok(prefixValue !== null && prefixValue.costUsd !== null && !near(prefixValue.costUsd, expectedCost),
    `AC4: the prefix alone still parses to a plausible-looking total ($${prefixValue?.costUsd?.toFixed(9)} of the ` +
    `real $${expectedCost.toFixed(9)}) — this is the number main records as the fire's spend`);
  ok(usageFromCapture(opencodeAdapter, capture) === null,
    "AC4: usageFromCapture returns null for a truncated capture — the prefix is never handed on as the fire's usage");
}

// The same thing at the real 4 MiB cap, driving a genuine overflow rather than a scaled-down stand-in.
{
  const capture = makeStdoutCapture();
  const chunk = stream.endsWith("\n") ? stream : stream + "\n";
  let appended = 0;
  while (appended <= MAX_FULL_STDOUT) { capture.append(chunk); appended += chunk.length; }
  ok(capture.truncated(), `AC4: a stream past the real ${MAX_FULL_STDOUT}-byte cap is truncated`);
  ok(capture.text().length === MAX_FULL_STDOUT, "AC4: …the buffer stops at the cap");
  ok(usageFromCapture(opencodeAdapter, capture) === null, "AC4: …and yields no usage at all");
}

// Not truncated ⇒ the capture is transparent: same answer as parsing the stream directly.
{
  const capture = makeStdoutCapture();
  capture.append(stream);
  ok(!capture.truncated(), "capture: a stream under the cap is NOT truncated");
  ok(near(usageFromCapture(opencodeAdapter, capture)!.costUsd!, expectedCost),
    "capture: an untruncated capture parses exactly as the raw stream does");
}

// A stream that ends EXACTLY at the cap lost nothing — reporting it unknown would discard a complete fire.
{
  const capture = makeStdoutCapture(16);
  capture.append("0123456789");
  capture.append("abcdef");
  ok(!capture.truncated() && capture.text() === "0123456789abcdef",
    "capture: filling the cap exactly is complete, not truncated (no byte was dropped)");
  capture.append("x");
  ok(capture.truncated(), "capture: the next byte after a full buffer IS a drop");
}

ok(usageFromCapture(null, makeStdoutCapture()) === null, "capture: an unstructured lane (no adapter) has no usage");

console.log(fails === 0 ? "\nopencode-usage: all assertions passed" : `\nopencode-usage: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
