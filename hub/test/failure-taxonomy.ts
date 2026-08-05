// LOOP-114 + LOOP-72 — the failure taxonomy's hole, and the breaker's cold-start window.
//
// Both live in breaker.ts because nothing may import run-agents.ts (main() is unconditional,
// LOOP-58). classifyFireError and providerOf moved there so they are testable at all — the defects
// below both shipped precisely because the code that had them could not be exercised directly.
import { classifyFireError, providerOf, breaker, PROVIDER_SCOPED_CLASSES, type Agent } from "../src/breaker.ts";

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

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nFAILURE_TAXONOMY_OK");
process.exit(fails ? 1 : 0);
