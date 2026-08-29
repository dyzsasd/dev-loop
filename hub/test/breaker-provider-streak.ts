// A provider breaker counts CONSECUTIVE failures, so a success on that provider must end the run.
//
// The per-provider reset used to be gated on `pe.open`, while the per-agent reset beside it was
// unconditional. A sub-threshold streak therefore never returned to zero: it accumulated for the
// scheduler's whole life and the breaker eventually tripped on failures that were never consecutive.
// Field evidence (jinko-browser-use, 2026-08-29): `dev-loop status` reported
// `streak provider anthropic:rate-limit ×3` from three fires at 2026-08-28T23:52Z with ~178 mostly
// successful fires after them — the ×3 was a lifetime count rendered as `consecutiveFailures`.
//
// Unit-level: breaker.ts is an importable leaf, and the singleton's record() is the whole contract.
import { breaker } from "../src/breaker.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const reset = (threshold = 3) => {
  breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
  breaker.onEvent = undefined; breaker.onChange = undefined;
  breaker.threshold = threshold; breaker.probeMs = 60_000;
};
// A rate-limit failure and a clean fire on the same (agent, provider) pair.
const fail = (agent = "pm", provider = "anthropic") => breaker.record(agent as never, 1, "rate-limit", "429 rate limited", provider, { at: Date.now() });
const pass = (agent = "pm", provider = "anthropic") => breaker.record(agent as never, 0, null, "", provider, { at: Date.now() });
const entry = (k = "anthropic:rate-limit") => breaker.byProvider.get(k);

// 1. The defect itself: failures separated by a success are not a streak.
reset();
fail(); pass(); fail();
ok((entry()?.streak ?? 0) === 1, `two failures split by a success count as 1, not 2 (streak ${entry()?.streak ?? 0})`);

// 2. The live symptom: failures scattered across a long run must never TRIP the breaker. The assertion
//    is on the `open` event, not on the end state — a trailing success masks the trip in the end state
//    (the old gate reset an entry once it was open), but by then the lane has already been halted.
reset(3);
const trips: string[] = [];
breaker.onEvent = (_agent, kind, key) => { if (kind === "open") trips.push(key); };
for (let i = 0; i < 3; i++) { fail(); pass(); }
ok(trips.length === 0, `three NON-consecutive failures at threshold 3 never open the breaker (${trips.length} trip(s): ${trips.join(", ") || "none"})`);
ok((entry()?.streak ?? 0) === 0, `…and the streak is back to 0 after the last success (streak ${entry()?.streak ?? 0})`);
breaker.onEvent = undefined;

// 3. The guard against over-correcting: a real consecutive run must still trip it.
reset(3);
fail(); fail(); fail();
ok(entry()?.open === true, "three CONSECUTIVE failures still open the breaker — the fix does not disarm it");
ok((entry()?.streak ?? 0) === 3, `…with the streak at the threshold (streak ${entry()?.streak ?? 0})`);

// 4. A success still closes an OPEN provider breaker, and announces it exactly once.
reset(2);
const events: string[] = [];
breaker.onEvent = (agent, kind, key, streak) => { events.push(`${agent}/${kind}/${key}/${streak}`); };
fail(); fail();
ok(entry()?.open === true, "setup: the breaker is open at threshold 2");
pass();
ok(entry()?.open === false && (entry()?.streak ?? 0) === 0, "a success closes the open provider breaker");
ok(events.filter((e) => e.includes("/close/")).length === 1, `the close event fires once (${events.filter((e) => e.includes("/close/")).length})`);

// 5. …and a success on a DIFFERENT provider does not clear this one — the reset is provider-scoped.
reset(3);
fail("pm", "anthropic"); fail("pm", "anthropic");
pass("qa", "openrouter");
ok((entry()?.streak ?? 0) === 2, `a success on another provider leaves the streak alone (streak ${entry()?.streak ?? 0})`);

// 6. A success on a provider that already has nothing recorded writes nothing — the file is not churned.
reset(3);
let writes = 0;
breaker.onChange = () => { writes++; };
pass();
ok(writes === 0, `a healthy fire on a clear provider triggers no persistence write (${writes})`);

// 7. …but the success that CLEARS a sub-threshold streak does write, or the reset would not survive a restart.
reset(3);
fail();
writes = 0;
breaker.onChange = () => { writes++; };
pass();
ok(writes === 1, `the success that clears a sub-threshold streak is persisted (${writes} write)`);

console.log(fails === 0 ? "\nBREAKER_PROVIDER_STREAK_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
