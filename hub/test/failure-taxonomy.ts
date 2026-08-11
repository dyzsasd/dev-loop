// LOOP-114 + LOOP-72 — the failure taxonomy's hole, and the breaker's cold-start window.
//
// Both live in breaker.ts because nothing may import run-agents.ts (main() is unconditional,
// LOOP-58). classifyFireError and providerOf moved there so they are testable at all — the defects
// below both shipped precisely because the code that had them could not be exercised directly.
import { classifyFireError, providerOf, breaker, PROVIDER_SCOPED_CLASSES, producedNoWork, EXIT_NO_WORK, type Agent } from "../src/breaker.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── LOOP-114: the string every failure on this workspace actually carried ──────────────────────
// 25 of 26 failures were one of these two tails, and the taxonomy matched NEITHER: not "usage
// limit", not "rate limit". errorClass came back null, so the `errors:` line accounted for 1 of 26
// and the provider breaker — which keys on errorClass — could never engage.
const TAILS = [
  "You've hit your session limit · resets 12:20am (Europe/Paris)\n",
  "You've hit your session limit · resets 4:10am (Europe/Paris)\n",
  "you've hit your session limit\n",                 // no reset clause — must not depend on it
  "YOU'VE HIT YOUR SESSION LIMIT · RESETS 3:00AM\n", // different case
];
for (const tail of TAILS) {
  const cls = classifyFireError(1, false, tail);
  ok(cls === "session-limit", `LOOP-114: ${JSON.stringify(tail.slice(0, 44))} → session-limit (got ${JSON.stringify(cls)})`);
}
ok(PROVIDER_SCOPED_CLASSES.has("session-limit"),
  "LOOP-114 AC2: session-limit is provider-scoped — the cap belongs to the KEY, so every agent on it fails identically");

// The class must stay DISTINCT from spend-limit: the remedies differ (a session limit clears itself
// at a stated time; a spend limit needs a human to raise or refill something).
ok(classifyFireError(1, false, "credit balance too low\n") === "spend-limit", "LOOP-114: spend-limit is untouched");
ok(classifyFireError(1, false, "429 too many requests\n") === "rate-limit", "LOOP-114: rate-limit is untouched");
ok(classifyFireError(0, false, "session limit\n") === null, "LOOP-114: exit 0 is never a failure class, whatever the tail says");
ok(classifyFireError(1, true, "session limit\n") === "timeout", "LOOP-114: a timeout still outranks the tail match");

// ── LOOP-72: an agent that has never fired is still capped by an open provider breaker ─────────
{
  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  breaker.threshold = 5;
  const FIRED: Agent[] = ["pm", "qa", "senior-dev", "junior-dev", "sweep"];
  // The agent under test NEVER completes a fire — it is only seeded, exactly as the scheduler now
  // seeds every selected agent at boot from the launch profile it already resolves for its log line.
  breaker.seedProvider("reflect", providerOf({ codingAgent: "claude" }));
  for (const a of FIRED) breaker.record(a, 1, "session-limit", "session limit", "anthropic");
  ok(breaker.isOpen("pm"), "LOOP-72 control: the provider breaker is open for the agents that tripped it");
  ok(breaker.isOpen("reflect"),
    "LOOP-72: an agent with ZERO completed fires is capped immediately — no full-cadence fire into an exhausted provider");
  ok(breaker.intervalFor("reflect", 60_000) === breaker.probeMs,
    "LOOP-72: …and its slot drops to the probe cadence, which is the whole point");

  // The unaffected directions.
  breaker.seedProvider("architect", providerOf({ codingAgent: "opencode", model: "openrouter/deepseek/x" }));
  ok(!breaker.isOpen("architect"), "LOOP-72: an agent on a DIFFERENT provider is unaffected");
  breaker.seedProvider("ops", null); // a profile that resolves to no provider
  ok(!breaker.isOpen("ops"), "LOOP-72: an agent whose profile resolves to no provider is unaffected");

  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  breaker.threshold = 0; // --breaker 0
  breaker.seedProvider("pm", "anthropic");
  for (const a of FIRED) breaker.record(a, 1, "session-limit", "session limit", "anthropic");
  ok(!breaker.isOpen("pm"), "LOOP-72: --breaker 0 still disables everything");
  breaker.threshold = 5;
}

// seedProvider must never overwrite a provider learned from a REAL fire — the fire is ground truth.
{
  breaker._agentProvider.clear();
  breaker.record("pm", 0, null, "", "anthropic");
  breaker.seedProvider("pm", "openai");
  ok(breaker._agentProvider.get("pm") === "anthropic",
    "LOOP-72: a completed fire's provider wins over the boot seed — seeding fills a gap, it does not override");
}

// ── providerOf's contract, now that it has two callers ─────────────────────────────────────────
ok(providerOf({ codingAgent: "claude" }) === "anthropic", "providerOf: claude → anthropic");
ok(providerOf({ codingAgent: "codex" }) === "openai", "providerOf: codex → openai");
ok(providerOf({ codingAgent: "opencode", model: "openrouter/deepseek/v4" }) === "openrouter", "providerOf: opencode takes the model-string prefix");
ok(providerOf({ codingAgent: "opencode", model: "bare-model" }) === null, "providerOf: an opencode model with no prefix resolves to no provider");

// ── LOOP-543 — a fire that produced nothing is not a success ────────────────────────────────────
// The defect: classifyFireError returned null for every exit-0 fire, so 274 consecutive opencode
// fires that ran 4–11 s and emitted zero bytes were ledgered as successes, and recordFire handed
// that exit 0 to breaker.record — which reads it as a RECOVERY and closes the breaker.
{
  // AC1 — the no-work fire now carries a class.
  ok(classifyFireError(0, false, "", false, false, false, undefined, true) === "no-output",
    "LOOP-543 AC1: exit 0 with no work → 'no-output', not null");
  ok(classifyFireError(0, false, "", false, false, false, undefined, false) === null,
    "LOOP-543: the noWork flag is what decides it — the SAME empty tail without it stays null");

  // AC2 — the classification is derived from what the fire DID, never from bootBytes. This is the
  // assertion that would have caught the premise this ticket was originally filed on: bootBytes is 0
  // on 345/345 opencode fires, healthy and broken alike, so a fix keyed on it would fail here.
  // A healthy opencode fire: bootBytes 0, 2_527_537 ms, 103 turns, real output.
  const healthyOpencodeTail = "hub/test/legacy-home.ts\n25 assertions passed\n";
  ok(producedNoWork({ exitCode: 0, timedOut: false, interrupted: false, outputTail: healthyOpencodeTail }) === false,
    "LOOP-543 AC2: a normally-run opencode fire (bootBytes 0, real duration, real output) is NOT no-work");
  ok(classifyFireError(0, false, healthyOpencodeTail, false, false, false, undefined,
      producedNoWork({ exitCode: 0, timedOut: false, interrupted: false, outputTail: healthyOpencodeTail })) === null,
    "LOOP-543 AC2: …and it classifies HEALTHY — the fix cannot mistake the opencode lane for an outage");

  // The derivation's own arms, each pinned against the one input that flips it.
  ok(producedNoWork({ exitCode: 0, timedOut: false, interrupted: false, outputTail: "   \n\t\n" }) === true,
    "LOOP-543: whitespace-only output is no output");
  ok(producedNoWork({ exitCode: 0, timedOut: false, interrupted: true, outputTail: "" }) === false,
    "LOOP-543: an operator SIGINT leaves the same empty shape and is NOT charged to the agent (LOOP-155)");
  ok(producedNoWork({ exitCode: 1, timedOut: false, interrupted: false, outputTail: "" }) === false,
    "LOOP-543: a non-zero exit already has a class path — no-work is the exit-0 defect only");
  ok(producedNoWork({ exitCode: 0, timedOut: true, interrupted: false, outputTail: "" }) === false,
    "LOOP-543: a timeout names why the fire ended; no-work does not get to claim it");

  // Precedence: every arm that names a REAL cause outranks no-work.
  ok(classifyFireError(0, true, "", false, false, false, undefined, true) === "timeout",
    "LOOP-543: timeout outranks no-output");
  ok(classifyFireError(0, false, "", true, false, false, undefined, true) === "stalled",
    "LOOP-543: the stall watchdog outranks no-output");
  ok(classifyFireError(0, false, "", false, true, false, undefined, true) === "retry-loop",
    "LOOP-543: the retry-loop watchdog outranks no-output");
  ok(classifyFireError(0, false, "rate limit\n", false, false, true, { ceilingUsd: 20, spentUsd: null, totalTokens: null }, true) === "rate-limit",
    "LOOP-543: a budget kill's provider rejection outranks no-output");

  // AC1's other half: the class alone cannot arm the breaker, because breaker.record returns at
  // exitCode === 0 before it reads the class. This is why the ledgered exit code has to move too.
  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  breaker.threshold = 5;
  for (let i = 0; i < 6; i++) breaker.record("qa", 0, "no-output", "", "openrouter");
  ok(breaker.isOpen("qa") === false,
    "LOOP-543: exit 0 + a class does NOT trip the breaker — record() returns before reading errorClass");
  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  for (let i = 0; i < 6; i++) breaker.record("qa", EXIT_NO_WORK, "no-output", "", "openrouter");
  ok(breaker.isOpen("qa") === true,
    `LOOP-543: ledgered under EXIT_NO_WORK (${EXIT_NO_WORK}) the streak trips the breaker — the loop stops firing full-cadence into the outage`);

  // …and the inverse the 19.5 h window actually exhibited: a no-work fire recorded as exit 0
  // CLOSES a breaker that a real failure had legitimately opened.
  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  for (let i = 0; i < 5; i++) breaker.record("qa", 1, "network", "fetch failed", "openrouter");
  ok(breaker.isOpen("qa") === true, "LOOP-543: (setup) a real failure streak opens the breaker");
  breaker.record("qa", 0, null, "", "openrouter");
  ok(breaker.isOpen("qa") === false,
    "LOOP-543: a no-work fire ledgered as exit 0 RE-ARMS the loop — it does not merely fail to trip the breaker, it resets one");
  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  breaker.threshold = 5;
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nFAILURE_TAXONOMY_OK");
process.exit(fails ? 1 : 0);
