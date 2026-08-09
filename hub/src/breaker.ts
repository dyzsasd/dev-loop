// P0-1a/P0-1b circuit breaker — extracted so tests can import it without triggering main().
// run-agents.ts is an entry-point (main() is unconditional) and cannot be imported by anything.
import { AGENT_HANDLES } from "./seed.ts";
export type Agent = (typeof AGENT_HANDLES)[number];

type BreakerEntry = { key: string | null; streak: number; open: boolean };
// LOOP-114 adds "session-limit". It is provider-scoped for the same reason the other three are: the
// cap belongs to the KEY, so when it is hit every agent on that provider fails identically, and the
// streak must accumulate per (provider, class) rather than per agent. It is kept DISTINCT from
// "spend-limit" because the remedies differ — a session limit states its own reset time and clears
// itself, while a spend limit needs a human to raise or refill something.
export const PROVIDER_SCOPED_CLASSES = new Set<string>(["spend-limit", "rate-limit", "auth", "session-limit"]);

// The fire-ledger provider dimension. Lives HERE rather than in run-agents.ts (which calls main()
// unconditionally, so nothing may import it — LOOP-58) precisely so the breaker can resolve a provider
// for an agent that has NOT yet completed a fire (LOOP-72). run-agents imports it back.
export function providerOf(profile: { codingAgent: string; model?: string }): string | null {
  if (profile.codingAgent === "opencode") {
    const m = profile.model;
    return m && m.includes("/") ? m.split("/")[0] : null;
  }
  return profile.codingAgent === "claude" ? "anthropic" : "openai";
}

// LOOP-445 — what a budget kill MEASURED, handed to the classifier so the class states a fact rather
// than which timer happened to fire. The perFireUsd watchdog kills on a MODELED wall-clock deadline
// (perFireUsd / ratePerMs) because mid-flight cost is not observable on every lane; the fire's real
// usage IS known by the time this runs (the adapter parses the buffer at finalize), so the label is
// decided there instead of being asserted at arm time.
//   • spentUsd — the fire's measured spend, null when the payload was unparseable/absent.
//   • totalTokens — measured tokens across every bucket, null when usage was never parsed. ZERO is a
//     measurement, not an absence: it is what a wedged fire records.
// Deliberately NOT part of this: output bytes. The deferred-echo lane (claude, `--output-format json`)
// buffers until exit, so a KILLED claude fire has an empty tail whether it did nothing or spent $4.34
// over 2.5M cache-read tokens — the three 2026-08-08 pm rows that motivated this all had `outputTail: ""`.
// Bytes cannot separate wedged from productive there; tokens can.
export interface BudgetKillEvidence { ceilingUsd?: number | null; spentUsd?: number | null; totalTokens?: number | null }

// A fire that consumed ZERO tokens is wedged — it never reached the provider — whichever watchdog
// noticed. This is the AC2 precedence: the liveness arm names the fire, the budget arm does not get to
// claim it just because its timer tripped first. It matters most on the claude lanes, where the stall
// watchdog is DISARMED by default (effectiveStallMs = 0 — claude buffers, so silence is not evidence),
// leaving the budget timer as the only armed watchdog and every wedged fire wearing its label.
function wedged(e?: BudgetKillEvidence): boolean {
  // A fire that was BILLED something reached the provider, whatever its token buckets say. Without this
  // guard a payload whose token fields are all null (they are individually optional on every adapter)
  // sums to 0 and would be called wedged while carrying a real cost — the same conflation of "measured
  // zero" with "not measured" that this ticket exists to remove, reintroduced one level down.
  if (typeof e?.spentUsd === "number" && e.spentUsd > 0) return false;
  return e?.totalTokens === 0;
}
// A breach is claimable only when the spend was MEASURED and reached the ceiling. Unknown spend is not
// a breach: it is an unknown, and the modeled class says so.
function measuredBreach(e?: BudgetKillEvidence): boolean {
  return typeof e?.spentUsd === "number" && typeof e?.ceilingUsd === "number" && e.spentUsd >= e.ceilingUsd;
}

export function classifyFireError(exitCode: number, timedOut: boolean, tail: string, stalled = false, retryLoop = false, budgetKilled = false, evidence?: BudgetKillEvidence): string | null {
  if (budgetKilled) {
    // A MEASURED breach is a fact about the fire, so it outranks every inference below.
    // LOOP-445 AC1 — ships option (b): the kill still happens on the modeled deadline, but only a
    // MEASURED breach may wear "budget-per-fire". "budget-deadline" names a kill the model justified
    // and the meter did not, which is what a $4.34 fire against a $20 ceiling actually was.
    if (measuredBreach(evidence)) return "budget-per-fire";
    // The breach above is the ONLY measurement that answers "why did this fire end". Everything below
    // it is an inference from an absence, and one thing fills that absence with a fact: the tail. A
    // provider REJECTION (429, an expired key, a session cap) is answered before a token is billed, so
    // consult it before naming the kill after whichever timer fired. This is not cosmetic: neither
    // "stalled" nor "budget-deadline" is in PROVIDER_SCOPED_CLASSES, so a misfiled rejection
    // accumulates only against the one agent that saw it while every sibling on the same exhausted key
    // keeps firing at full cadence into the outage the breaker exists to stop.
    //
    // Rounds 3 and 4 gated this on the fire having measured NO work, which reads a rejection as
    // something only an idle fire can suffer. A multi-turn fire bills a token-bearing step, THEN meets
    // the 429 and retries against it until the deadline trips: usage is positive, the tail says
    // rate-limit, and the gate sent it to "budget-deadline" with the provider breaker disengaged —
    // this ticket's own defect class, one arm further down, for the third time. Work measured earlier
    // is not evidence about why the fire ENDED; only a measured breach is, and it is already above.
    const rejection = tailErrorClass(tail);
    if (rejection) return rejection;
    // LOOP-445 AC2 — zero tokens outranks the budget arm: with no rejection to explain them, zero
    // MEASURED tokens is a wedge. Unknown tokens is not — an unknown stays an unknown (AC1).
    if (wedged(evidence)) return "stalled";
    return "budget-deadline";
  }
  if (retryLoop) return "retry-loop"; // liveness watchdog kill — visible retry loop (output arriving but no new content)
  if (stalled) return "stalled"; // liveness watchdog kill — a hung provider call / silent retry loop, NOT a task failure
  if (timedOut) return "timeout";
  if (exitCode === 0) return null;
  return tailErrorClass(tail);
}

// The tail taxonomy. Extracted so the budget arm above consults THIS derivation rather than a second
// copy of the patterns: two copies drift, and a regression test written against a copy passes while the
// path it claims to cover is broken.
function tailErrorClass(tail: string): string | null {
  const t = tail.toLowerCase();
  // LOOP-114 — Claude Code emits "You've hit your session limit · resets 12:20am (Europe/Paris)".
  // It matched NOTHING: not "usage limit", not "rate limit". Every single non-timeout failure this
  // workspace had ever recorded was that one string (25 of 26), so the taxonomy was blind exactly
  // where its failures lived, the `errors:` line accounted for 1 of 26, and the LOOP-8 provider
  // breaker — which keys on errorClass — could never engage on any of them. Matched WITHOUT the
  // "· resets …" clause and case-insensitively (the tail is lowercased above), so it does not
  // depend on wording the provider may change.
  if (/session limit/.test(t)) return "session-limit";
  if (/spend limit|usage limit|monthly limit|credit balance too low|quota exceeded/.test(t)) return "spend-limit";
  if (/rate limit|too many requests|overloaded_error|\b429\b|\b529\b/.test(t)) return "rate-limit";
  if (/invalid api key|authentication_error|unauthorized|not logged in|please run \/login|oauth token|\b401\b/.test(t)) return "auth";
  if (/enotfound|econnrefused|econnreset|etimedout|eai_again|fetch failed|network error|socket hang up/.test(t)) return "network";
  return null;
}

// ─── P0-1a failure-streak circuit breaker ────────────────────────────────────────────────────────────
// The field incident: a spent subscription turned every fire into the same ~2s failure for 48 hours while
// the scheduler kept full cadence — zero backoff, zero signal, two days of zero throughput discovered by
// reading metrics after the fact. The breaker watches recordFire: N consecutive fires of ONE agent failing
// with the SAME key (errorClass, else the last output line) trip that agent's slot down to a probe cadence;
// each probe fire IS the recovery check — the first success closes the breaker and restores normal cadence.
// Trip and recovery notify ONCE each (team comms when configured; console always). In-memory by design:
// a scheduler restart re-probes at full cadence, which is itself a fresh signal. Heterogeneous task
// failures never trip it — the key must repeat identically.
// P0-1b: spend-limit/rate-limit/auth are PROVIDER properties — when one key is exhausted every agent on it
// fails identically. The failure streak therefore accumulates per (provider, errorClass) across agents;
// tripping the provider breaker caps every agent on that provider immediately without re-accumulation.
export const breaker = {
  threshold: 5,          // --breaker <n>; 0 disables
  probeMs: 60 * 60_000,  // --breaker-probe <dur>
  byAgent: new Map<Agent, BreakerEntry>(),
  byProvider: new Map<string, BreakerEntry>(), // key = "${provider}:${errorClass}" for PROVIDER_SCOPED_CLASSES
  _agentProvider: new Map<Agent, string | null>(), // cached provider per agent (updated in record())
  onEvent: undefined as ((agent: Agent, ev: "open" | "close", key: string, streak: number) => void) | undefined,
  // LOOP-72 — the cold-start window. `_agentProvider` was populated ONLY by a completed fire, so an
  // agent that had not yet fired since scheduler start was invisible to an open provider breaker and
  // made one full-cadence fire into a provider already known to be exhausted. It bit widest for the
  // long-cadence agents (sweep 30m, ops 10m, reflect 1d), which are most often still unfired when a
  // breaker trips. Seeding at scheduler boot closes it WITHOUT breaker.ts importing run-agents.ts:
  // the scheduler already resolves every selected agent's launch profile at boot to print its
  // `launch=` line, so it hands the resolution in rather than the breaker reaching out for it.
  seedProvider(agent: Agent, provider: string | null): void {
    if (!this._agentProvider.has(agent)) this._agentProvider.set(agent, provider);
  },
  record(agent: Agent, exitCode: number, errorClass: string | null | undefined, tail: string | undefined, provider?: string | null): void {
    if (!this.threshold) return;
    if (provider !== undefined) this._agentProvider.set(agent, provider);
    if (exitCode === 0) {
      // Close per-agent breaker.
      const e = this.byAgent.get(agent) ?? { key: null, streak: 0, open: false };
      if (e.open) this.onEvent?.(agent, "close", e.key ?? "", e.streak);
      this.byAgent.set(agent, { key: null, streak: 0, open: false });
      // Close all open provider breakers for this agent's provider.
      const p = provider ?? this._agentProvider.get(agent);
      if (p) {
        const prefix = `${p}:`;
        for (const [k, pe] of this.byProvider) {
          if (k.startsWith(prefix) && pe.open) {
            this.onEvent?.(agent, "close", k, pe.streak);
            this.byProvider.set(k, { key: null, streak: 0, open: false });
          }
        }
      }
      return;
    }
    const lastLine = (tail ?? "").trimEnd().split("\n").pop()?.trim().slice(0, 160) ?? "";
    const key = errorClass ?? (lastLine || "(no-output)");
    // Provider-scoped classes accumulate per (provider, errorClass) across agents, not per agent.
    if (errorClass && PROVIDER_SCOPED_CLASSES.has(errorClass) && provider) {
      const pkey = `${provider}:${key}`;
      const pe = this.byProvider.get(pkey) ?? { key: null, streak: 0, open: false };
      if (key === pe.key) pe.streak++; else { pe.key = key; pe.streak = 1; }
      if (!pe.open && pe.streak >= this.threshold) { pe.open = true; this.onEvent?.(agent, "open", `[provider=${provider}] ${key}`, pe.streak); }
      this.byProvider.set(pkey, pe);
      return; // don't also accumulate per-agent for provider-scoped classes
    }
    // Non-provider classes accumulate per agent (unchanged from P0-1a).
    const e = this.byAgent.get(agent) ?? { key: null, streak: 0, open: false };
    if (key === e.key) e.streak++; else { e.key = key; e.streak = 1; }
    if (!e.open && e.streak >= this.threshold) { e.open = true; this.onEvent?.(agent, "open", key, e.streak); }
    this.byAgent.set(agent, e);
  },
  isOpen(agent: Agent): boolean {
    if (this.byAgent.get(agent)?.open) return true;
    const provider = this._agentProvider.get(agent);
    if (provider) {
      const prefix = `${provider}:`;
      for (const [k, pe] of this.byProvider) if (k.startsWith(prefix) && pe.open) return true;
    }
    return false;
  },
  // The one seam every slot-rescheduling site goes through: open ⇒ the probe cadence (never faster).
  intervalFor(agent: Agent, baseMs: number): number { return this.isOpen(agent) ? Math.max(baseMs, this.probeMs) : baseMs; },
};

// ─── LOOP-175: provider-scoped breaker message formatting ────────────────────────────────────────────
// Provider-scoped events (rate-limit / spend-limit / auth) name the whole blast radius rather than
// the single tripping agent. Agent-scoped events keep the original per-agent wording unchanged.
// Accepts a pre-formatted probeDuration string so this module stays free of duration arithmetic.
export function formatBreakerMsg(
  agent: Agent,
  ev: "open" | "close",
  key: string,
  streak: number,
  probeDuration: string,
  agentProvider: ReadonlyMap<Agent, string | null>,
): string {
  // OPEN from a provider-scoped breaker: key = "[provider=X] errorClass"
  const openMatch = ev === "open" ? key.match(/^\[provider=([^\]]+)\] (.+)$/) : null;
  if (openMatch) {
    const [, provider, errorClass] = openMatch;
    const lanes = _affectedLanes(provider, agentProvider);
    return `breaker OPEN: provider ${provider} (${errorClass}) → ${lanes} on probe cadence ${probeDuration} after ${streak}× identical failures; tripped by ${agent}`;
  }
  // CLOSE from a provider-scoped breaker: key = "provider:errorClass" where errorClass ∈ PROVIDER_SCOPED_CLASSES
  if (ev === "close") {
    const colonIdx = key.indexOf(":");
    if (colonIdx !== -1) {
      const errorClass = key.slice(colonIdx + 1);
      if (PROVIDER_SCOPED_CLASSES.has(errorClass)) {
        const provider = key.slice(0, colonIdx);
        const lanes = _affectedLanes(provider, agentProvider);
        return `breaker CLOSED: provider ${provider} (${errorClass}) → ${lanes} resumed normal cadence (recovery by ${agent})`;
      }
    }
  }
  // Agent-scoped events: original wording, unchanged.
  return ev === "open"
    ? `breaker OPEN: ${agent} → probe cadence ${probeDuration} after ${streak}× identical failures (${key})`
    : `breaker CLOSED: ${agent} recovered (${key}) — normal cadence resumed`;
}

function _affectedLanes(provider: string, agentProvider: ReadonlyMap<Agent, string | null>): string {
  const agents = [...agentProvider.entries()].filter(([, p]) => p === provider).map(([a]) => a).sort();
  return agents.length ? agents.join(", ") : "ALL lanes";
}
