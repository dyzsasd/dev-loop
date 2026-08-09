// LOOP-445 — the perFireUsd watchdog kills on a MODELED deadline; the class it ledgers must report
// what the fire MEASURABLY did.
//
// The defect, from this workspace's own ledger (2026-08-08, ceiling $20):
//   • 13:08  exit 126  turns 43  48.2 min  $4.34  2.53M cacheRead  → ledgered "budget-per-fire"
//   • 17:47  exit 126  turns 70  58.9 min  $5.97  5.93M cacheRead  → ledgered "budget-per-fire"
//   • 09:20  exit 126  turns  2  60.1 min  $0.00  0 tokens         → ledgered "budget-per-fire"
// The first two never approached the ceiling. The third never reached the provider at all — it is the
// exact shape the `stalled` watchdog exists to name, and it wore the budget label because
// classifyFireError short-circuited on `budgetKilled` ahead of every other arm, and because the stall
// watchdog is DISARMED on the claude lanes (effectiveStallMs = 0), leaving the budget timer as the only
// armed watchdog on the lane where all three of these fires ran.
//
// These assertions pin the CLASS against the numbers, so re-introducing the short-circuit fails here.
import { classifyFireError, PROVIDER_SCOPED_CLASSES } from "../src/breaker.ts";
// NB: usdLabel lives in metrics.ts, not run-agents.ts, deliberately — run-agents.ts calls main()
// unconditionally at import (LOOP-58 deleted its entry-point guard), so a test that imported the helper
// from there would launch the scheduler.
import { ratePerMsFor, profileDeadlines, usdLabel, type FireRow } from "../src/metrics.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const KILLED = true;
// The three rows above, as the classifier sees them. `tokens` sums every bucket; null ⇒ usage was never
// parsed (unknown), 0 ⇒ measured and empty.
const PRODUCTIVE = { ceilingUsd: 20, spentUsd: 4.3399645, totalTokens: 2_586_953 };
const PRODUCTIVE_2 = { ceilingUsd: 20, spentUsd: 5.9660025, totalTokens: 6_154_163 };
const WEDGED = { ceilingUsd: 20, spentUsd: 0, totalTokens: 0 };

// ── AC1 — a kill the meter does not confirm may not claim a measured breach ──────────────────────
for (const [label, ev] of [["13:08 ($4.34/$20)", PRODUCTIVE], ["17:47 ($5.97/$20)", PRODUCTIVE_2]] as const) {
  const cls = classifyFireError(126, false, "", false, false, KILLED, ev);
  ok(cls !== "budget-per-fire",
    `AC1: ${label} — a fire at ${Math.round((ev.spentUsd / ev.ceilingUsd) * 100)}% of its ceiling does NOT claim "budget-per-fire" (got ${JSON.stringify(cls)})`);
  ok(cls === "budget-deadline",
    `AC1: ${label} — it is classified "budget-deadline": killed by the model, not by the meter (got ${JSON.stringify(cls)})`);
}

// ── AC6 — the real budget path is NOT disarmed (LOOP-230 must survive this ticket) ───────────────
ok(classifyFireError(126, false, "", false, false, KILLED, { ceilingUsd: 20, spentUsd: 20.01, totalTokens: 9_000_000 }) === "budget-per-fire",
  "AC6: a fire measured OVER the ceiling is still \"budget-per-fire\" — LOOP-230's protection is intact");
ok(classifyFireError(126, false, "", false, false, KILLED, { ceilingUsd: 12, spentUsd: 12, totalTokens: 9_000_000 }) === "budget-per-fire",
  "AC6: spend EXACTLY at the ceiling is a breach (>=, not >) — the boundary belongs to the budget arm");

// ── AC1 (unknown spend) — an unparseable payload is an unknown, never a breach ───────────────────
ok(classifyFireError(126, false, "", false, false, KILLED, { ceilingUsd: 20, spentUsd: null, totalTokens: null }) === "budget-deadline",
  "AC1: spend UNKNOWN (usage unparseable) cannot be asserted as a breach — \"budget-deadline\"");
ok(classifyFireError(126, false, "", false, false, KILLED) === "budget-deadline",
  "AC1: a budget kill carrying NO evidence at all is modeled, not measured — \"budget-deadline\"");

// ── AC2 — zero tokens is the liveness arm's fire, whichever timer tripped first ──────────────────
ok(classifyFireError(126, false, "", false, false, KILLED, WEDGED) === "stalled",
  "AC2: 0 tokens + 0 spend over an hour ⇒ \"stalled\" — the budget arm does not get to claim a wedged fire");
// The discriminator must be TOKENS, not output bytes: on the deferred-echo lane every killed fire has an
// empty tail, so a bytes-based rule would have swept the $4.34 fire in with the wedged ones. This pair is
// the mutation guard — both rows below carry an empty tail and must classify differently.
ok(classifyFireError(126, false, "", false, false, KILLED, PRODUCTIVE) !== "stalled",
  "AC2: an empty output tail is NOT wedged when tokens were spent — claude buffers, so bytes cannot decide this");
// A fire that reached the provider and produced exactly one token is not wedged.
ok(classifyFireError(126, false, "", false, false, KILLED, { ceilingUsd: 20, spentUsd: 0, totalTokens: 1 }) === "budget-deadline",
  "AC2: 1 token is not 0 — the wedged rule is exact, not a threshold");
// A BILLED fire reached the provider whatever its token buckets say — every token field is individually
// optional on the adapters, so an all-null payload sums to 0 and would otherwise be called wedged.
ok(classifyFireError(126, false, "", false, false, KILLED, { ceilingUsd: 20, spentUsd: 3.5, totalTokens: 0 }) === "budget-deadline",
  "AC2: measured spend > 0 is never wedged, even with a 0 token sum (null token fields must not read as idle)");
// Unknown token count is not evidence of wedging.
ok(classifyFireError(126, false, "", false, false, KILLED, { ceilingUsd: 20, spentUsd: 3, totalTokens: null }) === "budget-deadline",
  "AC2: tokens UNKNOWN (null) is not \"stalled\" — null is an absence of measurement, 0 is a measurement");

// ── Precedence below the budget arm is untouched ─────────────────────────────────────────────────
ok(classifyFireError(125, false, "", true, false, false) === "stalled", "unchanged: the liveness arm still classifies a stall kill");
ok(classifyFireError(125, false, "", true, true, false) === "retry-loop", "unchanged: retry-loop still outranks stalled");
ok(classifyFireError(124, true, "", false, false, false) === "timeout", "unchanged: the wall-timeout arm");
ok(classifyFireError(1, false, "429 too many requests\n") === "rate-limit", "unchanged: the tail taxonomy");
ok(classifyFireError(0, false, "") === null, "unchanged: exit 0 is never a failure class");

// ── Round-3 review finding on PR #276 — a rejection is not a wedge ───────────────────────────────
//
// AC2 reads zero tokens as "the fire never reached the provider". That is an INFERENCE from an absence,
// and one thing produces the same absence while meaning the opposite: a provider REJECTION. A 429, an
// expired key, and a session cap are all answered before a token is billed, so they arrive with the
// wedged fire's exact numbers — zero tokens, zero cost.
//
// The consequence is operational, not cosmetic. "stalled" is not provider-scoped, so a rejection filed
// as a wedge accumulates only against the agent that happened to see it, while every sibling agent on
// the same exhausted key keeps firing at full cadence into the outage the provider breaker exists to
// stop. So these assertions pin the BREAKER SCOPE, not just the string.
{
  const REJECTED = { ceilingUsd: 20, spentUsd: 0, totalTokens: 0 }; // identical numbers to WEDGED — that is the point
  const rejections: [string, string][] = [
    ["429 too many requests\n", "rate-limit"],
    ["Error: overloaded_error\n", "rate-limit"],
    ["invalid api key · please run /login\n", "auth"],
    ["You've hit your session limit · resets 12:20am (Europe/Paris)\n", "session-limit"],
    ["credit balance too low\n", "spend-limit"],
  ];
  for (const [tail, want] of rejections) {
    const got = classifyFireError(126, false, tail, false, false, KILLED, REJECTED);
    ok(got === want,
      `PR#276 round 3: a budget kill whose tail says ${JSON.stringify(tail.trim().slice(0, 32))} is "${want}", not a wedge (got "${got}")`);
    ok(got !== null && PROVIDER_SCOPED_CLASSES.has(got),
      `PR#276 round 3: …and it keeps a PROVIDER-scoped class, so the sibling agents on that key are capped too (got "${got}")`);
  }

  // Mutation guard, the other direction: with NO evidence in the tail the wedge inference still stands.
  // Delete the wedge arm and this fails; delete the tail consultation and the block above fails.
  ok(classifyFireError(126, false, "", false, false, KILLED, REJECTED) === "stalled",
    "PR#276 round 3: an empty tail leaves zero tokens as the only evidence — still a wedge");
  ok(classifyFireError(126, false, "Wrote 3 files.\nDone.\n", false, false, KILLED, REJECTED) === "stalled",
    "PR#276 round 3: a tail with no provider-error evidence does not refute the wedge either");

  // The tail may only refute an INFERENCE, never override a MEASUREMENT. A fire that burned tokens was
  // not wedged, so nothing about it is in question: the deadline is why it ended.
  ok(classifyFireError(126, false, "429 too many requests\n", false, false, KILLED, PRODUCTIVE) === "budget-deadline",
    "PR#276 round 3: a kill that DID consume tokens is still the deadline's — a tail pattern does not hijack it");
  // AC6 must survive the new arm: a measured breach is a fact, and no tail string outranks it.
  ok(classifyFireError(126, false, "429 too many requests\n", false, false, KILLED, { ceilingUsd: 20, spentUsd: 20.01, totalTokens: 9_000_000 }) === "budget-per-fire",
    "PR#276 round 3: a MEASURED breach still classifies budget-per-fire whatever its tail says (AC6 survives)");

  // One derivation, asserted by RUNNING both paths rather than by re-stating the patterns: a copied
  // predicate would agree with itself here while the shipped path drifted.
  for (const [tail] of rejections) {
    ok(classifyFireError(126, false, tail, false, false, KILLED, REJECTED) === classifyFireError(1, false, tail),
      `PR#276 round 3: the budget arm and the ordinary failure path read ${JSON.stringify(tail.trim().slice(0, 24))} identically`);
  }
}

// ── AC3 — a watchdog-killed fire is a TRUNCATED sample, never a rate observation ─────────────────
const WINDOW = 7 * 86_400_000;
const NOW = Date.parse("2026-08-08T18:00:00.000Z");
const row = (o: Partial<FireRow> & { costUsd: number | null; durationMs: number; exitCode: number }): FireRow => ({
  ts: new Date(NOW - 3_600_000).toISOString(), agent: "pm", project: "loop",
  codingAgent: "claude", model: "claude-opus-5", durationMs: o.durationMs, exitCode: o.exitCode,
  usage: o.costUsd === null ? undefined : { source: "provider", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: o.costUsd, currency: "USD" },
});
const FALLBACK = 18.21 / 3_600_000;
const rate = (rows: FireRow[]) => ratePerMsFor(rows, "claude", "claude-opus-5", WINDOW, NOW);

// The ledger fixture the AC asks for: N killed $0 rows. Their quotient is exactly 0 — feeding those in is
// the loop the ticket names, where each kill manufactures the evidence for the next one.
const KILLED_ZEROS = Array.from({ length: 12 }, () => row({ costUsd: 0, durationMs: 3_600_000, exitCode: 126 }));
ok(rate(KILLED_ZEROS) === FALLBACK,
  "AC3: a profile whose rows are ALL killed $0 fires reads as UNPRICED (the conservative fallback), not as a measured rate");

// One real, completed fire must outrank any number of killed $0 rows — with the killed rows counted, the
// median of 12 zeros + 1 priced row is 0, which collapses to the fallback and buries the only real datum.
const PRICED = row({ costUsd: 6, durationMs: 1_200_000, exitCode: 0 }); // $6 / 20 min = 5e-6 $/ms
ok(Math.abs(rate([...KILLED_ZEROS, PRICED]) - 6 / 1_200_000) < 1e-12,
  `AC3: 12 killed $0 rows do not outvote ONE completed fire — the rate is the completed fire's (got ${rate([...KILLED_ZEROS, PRICED]).toExponential(3)}, want ${(6 / 1_200_000).toExponential(3)})`);

// Killed rows carrying a REAL cost are excluded too: their cost is a lower bound and their duration is
// when the axe fell, so the quotient is not this profile's rate in either direction.
const KILLED_PRICED = row({ costUsd: 4.34, durationMs: 2_892_000, exitCode: 126 }); // the 13:08 fire: ~1.5e-6 $/ms
ok(Math.abs(rate([PRICED, KILLED_PRICED]) - 6 / 1_200_000) < 1e-12,
  "AC3: a killed fire that DID spend is still excluded — a truncated sample is not a rate at either end");
for (const exit of [124, 125, 126]) {
  ok(rate([row({ costUsd: 0, durationMs: 3_600_000, exitCode: exit })]) === FALLBACK,
    `AC3: exit ${exit} (watchdog kill) is excluded from the rate median`);
}
// Guard the other direction: an ORDINARY failure is NOT a watchdog kill and must still count.
ok(Math.abs(rate([row({ costUsd: 6, durationMs: 1_200_000, exitCode: 1 })]) - 6 / 1_200_000) < 1e-12,
  "AC3: exit 1 (an ordinary task failure) still counts — the exclusion is watchdog kills only, not all failures");

// ── The two review findings on PR #276 — the same defect class, one layer up in the DISPLAY ──────────
//
// AC3 above removed killed rows from the rate median. That created a profile whose priced rows all became
// ineligible, and the operator-facing display had a SECOND, independent notion of "priced" that still
// counted them — so `dev-loop metrics --cost` printed a hardcoded fallback deadline under the word
// "measured". Reporting a model as a measurement is precisely what this ticket exists to stop, so the
// provenance now comes from the same derivation as the rate.
{
  const killedOnly = [
    row({ costUsd: 4.34, durationMs: 2_892_000, exitCode: 126 }),
    row({ costUsd: 5.97, durationMs: 3_534_000, exitCode: 126 }),
  ];
  const pd = profileDeadlines(killedOnly, 20, WINDOW, NOW).find((d) => d.model === "claude-opus-5");
  ok(pd !== undefined && pd.rateMeasured === false,
    "PR#276: a profile whose ONLY priced rows are watchdog kills reports its deadline as FALLBACK, not measured");
  ok(pd !== undefined && Math.abs(pd.usdPerHour - FALLBACK * 3_600_000) < 1e-9,
    "PR#276: ...and the rate it displays IS the fallback — the label and the number describe the same thing");
  // The other direction: an eligible sample must still be labelled measured, or the fix is just "always false".
  const pdOk = profileDeadlines([PRICED], 20, WINDOW, NOW).find((d) => d.model === "claude-opus-5");
  ok(pdOk !== undefined && pdOk.rateMeasured === true && Math.abs(pdOk.usdPerHour - 5e-6 * 3_600_000) < 1e-9,
    "PR#276: a profile with a real eligible sample is still labelled measured, at its own measured rate");
}

// The kill message states the fire's own spend. `toFixed(2)` renders every sub-cent amount as "$0.00" —
// the string that means "this fire spent nothing", which is the same conflation between a measured zero
// and an unmeasured one. Both the ceiling and the spend go through one precision-preserving helper.
ok(usdLabel(0.0001) !== "0.00" && Number(usdLabel(0.0001)) === 0.0001,
  "PR#276: a sub-cent MEASURED spend keeps its precision — it must never render as $0.00");
ok(usdLabel(0.002) !== "0.00" && Number(usdLabel(0.002)) === 0.002,
  "PR#276: a sub-cent ceiling ($0.002, the fixture's own value) keeps its precision too");
ok(usdLabel(0) === "0", "PR#276: a genuine zero still reads as zero");
ok(usdLabel(4.34) === "4.34" && usdLabel(20) === "20.00",
  "PR#276: cent-or-larger amounts keep the two-decimal money rendering operators read");

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nBUDGET_CLASSIFICATION_OK");
process.exit(fails ? 1 : 0);
