// P0-1a/P0-1b circuit breaker — extracted so tests can import it without triggering main().
// run-agents.ts is an entry-point (main() is unconditional) and cannot be imported by anything.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
import { createHash } from "node:crypto";
import { AGENT_HANDLES } from "./seed.ts";
export type Agent = (typeof AGENT_HANDLES)[number];

export type BreakerEntry = {
  key: string | null; streak: number; open: boolean;
  // WS-C review 4 (breaker persistence) — what a snapshot carries beyond the streak. All optional so the
  // three-field literal ({ key, streak, open }) tests and status.ts already build keeps compiling.
  openedAt?: number | null;        // ms epoch when `open` last flipped true
  lastFailureAt?: number | null;   // ms epoch of the last failure that fed this entry
  lastErrorClass?: string | null;  // the classifier's answer on that failure (null = unclassified: keyed on the tail)
  probeInFlight?: boolean;         // an OPEN entry whose probe fire has launched and not yet ended ⇒ "half-open"
  cooldownUntil?: number | null;   // the slot's next probe time as last rescheduled through intervalFor (agent entries)
};
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

// ─── LOOP-543 — "did this fire do any work?" ─────────────────────────────────────────────────────────
// The ledger recorded 274 consecutive opencode-lane fires that exited 0 in 4–11 s having produced
// nothing, every one of them carrying errorClass null. What "any work" means has to be answered from an
// observable the ledger already carries for EVERY lane, and only one qualifies: whether the process
// produced visible output. The 274 produced zero bytes; the 32 healthy fires that followed the outage
// produced real output over 677–1827 s.
//
// Three observables were rejected, each for a reason that would have made the fix wrong:
//   • bootBytes — a LANE CONSTANT, not an outcome. It is 0 on 345/345 opencode fires in the window,
//     the broken 274 and the healthy 32 alike, so it separates coding agents rather than successes
//     from failures. The ticket that filed this defect was itself filed on that misreading.
//   • durationMs — a genuinely fast fire is not a failed one; a threshold here is a guess.
//   • usage / turns — null on every un-instrumented lane, so absence is "unknown", never "idle".
//
// `interrupted` is excluded: the operator's own SIGINT leaves exactly this shape and is not an agent
// failure (LOOP-155). Exported so the derivation is testable — the run-agents call site cannot be.
//
// Querying them (LOOP-543 AC3). Rows written BEFORE this fix cannot be back-filled — they carry the
// suspectError flag and no class — so one command has to match both shapes:
//
//   jq -c 'select(.errorClass == "no-output" or (.suspectError == true and (.errorClass | not)))' \
//     .dev-loop/team/fires.jsonl
//
// Measured on the ledger that filed this ticket: 434 rows over the whole file, 274 inside the
// 2026-08-09T22:58Z–2026-08-10T18:21Z outage window, and 0 of the 32 healthy opencode fires that
// followed it — the control that makes the query evidence rather than a filter that matches
// everything. The second arm is history-only and stops accruing new rows once this ships.
export function producedNoWork(f: { exitCode: number; timedOut: boolean; interrupted: boolean; outputTail: string }): boolean {
  return !f.interrupted && f.exitCode === 0 && !f.timedOut && f.outputTail.trim() === "";
}

// The exit code such a fire is LEDGERED under. The child really did exit 0, so this is the fire's
// outcome and not the process's status byte — recorded, like "provider-env-missing"'s 4 and
// "spawn-failed"'s 1, because the ledger's job is to say what the fire achieved. It is load-bearing
// rather than cosmetic: breaker.record() returns at `exitCode === 0` BEFORE it ever reads errorClass,
// so the class alone would not arm the breaker. The process exit status is left untouched.
export const EXIT_NO_WORK = 7;

export function classifyFireError(exitCode: number, timedOut: boolean, tail: string, stalled = false, retryLoop = false, budgetKilled = false, evidence?: BudgetKillEvidence, noWork = false): string | null {
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
  // LOOP-543 — ABOVE the exit-0 bail, BELOW every arm that names a real kill (a watchdog or the budget
  // arm already knows why the fire ended; "it did nothing" is what is left when nothing else answers).
  // Returning null here is what let 274 consecutive no-work fires read as successes, and the missing
  // bucket was the smaller half of it: recordFire hands this class to breaker.record, which treats
  // exit 0 as a RECOVERY — closing that agent's breaker and every provider breaker on its provider. So
  // the outage did not merely fail to trip the one mechanism built to cap cadence into an outage; each
  // of its fires actively re-armed the loop to keep firing at full rate.
  //
  // Agent-scoped deliberately — NOT added to PROVIDER_SCOPED_CLASSES. All 274 rows share one provider,
  // which is suggestive, but the outage's cause is 原因未查明 and provider-scoping would encode a causal
  // claim the evidence does not support. It costs nothing here: each affected lane ran a streak far past
  // the threshold on its own (qa 126, junior-dev 126, sweep 22), so every one of them trips regardless.
  if (noWork) return "no-output";
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
// Trip and recovery notify ONCE each (team comms when configured; console always). The state machine is
// in-memory and this object is its ONLY owner; since WS-C review 4 a snapshot of it is also persisted
// (`onChange` → breaker.json, see the persistence section below) so `dev-loop status` can read the live
// state instead of approximating it, and so a scheduler RESTART resumes an open breaker rather than
// silently closing it. Heterogeneous task failures never trip it — the key must repeat identically.
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
  // WS-C review 4 — the persistence subscriber. Called after EVERY state change (a fire end, a probe
  // launch, a reschedule); the subscriber decides what to do with it (createBreakerPersistence below
  // coalesces and writes). Never consulted for a decision: persistence subscribes, it does not own.
  onChange: undefined as ((reason: BreakerChangeReason) => void) | undefined,
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
  // `meta.interrupted` (LOOP-155): the operator's own SIGINT leaves the fire exiting 0, and exit 0 is what
  // record() reads as a RECOVERY. While the state lived only in memory that was harmless — the process
  // was exiting anyway — but a snapshot written at stop must not say CLOSED because the operator pressed
  // ^C, or the restart starts fresh: the "restart resets the safety" shape this persistence exists to
  // remove, one layer down. An interrupted fire is evidence of nothing; it only ends the probe it was.
  // `meta.at` is the fire's end time — status's replay passes the ledger row's ts so the timestamps it
  // reports are the fires', not the read's.
  record(agent: Agent, exitCode: number, errorClass: string | null | undefined, tail: string | undefined, provider?: string | null, meta?: { interrupted?: boolean; at?: number }): void {
    if (!this.threshold) return;
    if (provider !== undefined) this._agentProvider.set(agent, provider);
    const p = provider ?? this._agentProvider.get(agent);
    let changed = this._endProbe(agent, p);
    if (meta?.interrupted) { if (changed) this.onChange?.("record"); return; }
    const at = meta?.at ?? Date.now();
    if (exitCode === 0) {
      // Close per-agent breaker.
      const e = this.byAgent.get(agent) ?? { key: null, streak: 0, open: false };
      if (e.open) this.onEvent?.(agent, "close", e.key ?? "", e.streak);
      if (e.open || e.streak > 0 || e.cooldownUntil) changed = true;
      this.byAgent.set(agent, { key: null, streak: 0, open: false });
      // Close all open provider breakers for this agent's provider.
      if (p) {
        const prefix = `${p}:`;
        for (const [k, pe] of this.byProvider) {
          if (k.startsWith(prefix) && pe.open) {
            this.onEvent?.(agent, "close", k, pe.streak);
            this.byProvider.set(k, { key: null, streak: 0, open: false });
            changed = true;
          }
        }
      }
      if (changed) this.onChange?.("record"); // a healthy fire on a healthy lane changes nothing — no write
      return;
    }
    const lastLine = (tail ?? "").trimEnd().split("\n").pop()?.trim().slice(0, 160) ?? "";
    const key = errorClass ?? (lastLine || "(no-output)");
    // Provider-scoped classes accumulate per (provider, errorClass) across agents, not per agent.
    if (errorClass && PROVIDER_SCOPED_CLASSES.has(errorClass) && provider) {
      const pkey = `${provider}:${key}`;
      const pe = this.byProvider.get(pkey) ?? { key: null, streak: 0, open: false };
      if (key === pe.key) pe.streak++; else { pe.key = key; pe.streak = 1; }
      pe.lastFailureAt = at; pe.lastErrorClass = errorClass;
      if (!pe.open && pe.streak >= this.threshold) { pe.open = true; pe.openedAt = at; this.onEvent?.(agent, "open", `[provider=${provider}] ${key}`, pe.streak); }
      this.byProvider.set(pkey, pe);
      this.onChange?.("record");
      return; // don't also accumulate per-agent for provider-scoped classes
    }
    // Non-provider classes accumulate per agent (unchanged from P0-1a). A RESUMED entry carries the
    // persisted (hashed, §16) form of an unclassified key: the same tail failing again continues that
    // streak instead of restarting the count at 1, and the live line replaces the hash in memory.
    const e = this.byAgent.get(agent) ?? { key: null, streak: 0, open: false };
    if (key === e.key || (e.key !== null && e.key === persistedKey(key, errorClass))) { e.streak++; e.key = key; } else { e.key = key; e.streak = 1; }
    e.lastFailureAt = at; e.lastErrorClass = errorClass ?? null; e.cooldownUntil = null;
    if (!e.open && e.streak >= this.threshold) { e.open = true; e.openedAt = at; this.onEvent?.(agent, "open", key, e.streak); }
    this.byAgent.set(agent, e);
    this.onChange?.("record");
  },
  // A fire on this lane ended (however it ended): whatever probe was in flight on the agent's own entry
  // and on its provider's entries is over. Returns whether any flag was actually cleared.
  _endProbe(agent: Agent, provider: string | null | undefined): boolean {
    let changed = false;
    const e = this.byAgent.get(agent);
    if (e?.probeInFlight) { e.probeInFlight = false; changed = true; }
    if (provider) for (const [k, pe] of this.byProvider) if (k.startsWith(`${provider}:`) && pe.probeInFlight) { pe.probeInFlight = false; changed = true; }
    return changed;
  },
  // The scheduler calls this as it launches a fire for an agent whose breaker is OPEN — that fire IS the
  // probe (fireReasonFor tells the agent as much). Until it ends the open entries read "half-open" in the
  // snapshot. Returns whether anything was open to probe.
  markProbe(agent: Agent, provider?: string | null): boolean {
    if (!this.threshold) return false;
    let any = false;
    const e = this.byAgent.get(agent);
    if (e?.open) { e.probeInFlight = true; any = true; }
    const p = provider ?? this._agentProvider.get(agent);
    if (p) for (const [k, pe] of this.byProvider) if (k.startsWith(`${p}:`) && pe.open) { pe.probeInFlight = true; any = true; }
    if (any) this.onChange?.("probe");
    return any;
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
  // While open it also records the lane's next probe time as the agent entry's `cooldownUntil`: "when
  // does this lane try again" is the question an operator reading an OPEN breaker asks, and this seam
  // is the only place the answer is decided. Closed lanes are untouched (pure, as before).
  intervalFor(agent: Agent, baseMs: number, now = Date.now()): number {
    if (!this.isOpen(agent)) return baseMs;
    const ms = Math.max(baseMs, this.probeMs);
    const e = this.byAgent.get(agent) ?? { key: null, streak: 0, open: false };
    e.cooldownUntil = now + ms;
    this.byAgent.set(agent, e);
    this.onChange?.("reschedule");
    return ms;
  },
  // ─── WS-C review 4: the persisted shape ─────────────────────────────────────────────────────────
  // A pure projection of the maps above. §16: an UNCLASSIFIED failure's key is the fire's last output
  // line — credential-adjacent CLI output the ledger deliberately never writes (LOOP-62) — so it reaches
  // the file only as a short hash. Identity is what the file needs (the streak already counted the
  // repeats); the text is not.
  snapshot(scheduler: BreakerStateFile["scheduler"], reason: BreakerChangeReason | "start" | "stop", now = Date.now()): BreakerStateFile {
    const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    const stateOf = (e: BreakerEntry): BreakerPersistedState => (e.open ? (e.probeInFlight ? "half-open" : "open") : "closed");
    const reasonOf = (e: BreakerEntry): string | null => (e.key === null ? null : persistedKey(e.key, e.lastErrorClass));
    const base = (e: BreakerEntry): BreakerPersistedEntry => ({
      state: stateOf(e), consecutiveFailures: e.streak, openedAt: iso(e.openedAt), lastFailureAt: iso(e.lastFailureAt),
      lastErrorClass: e.lastErrorClass ?? null, lastReason: reasonOf(e), probeInFlight: !!e.probeInFlight, cooldownUntil: iso(e.cooldownUntil),
    });
    const agents: Record<string, BreakerPersistedAgent> = {};
    for (const [agent, e] of this.byAgent) if (e.open || e.streak > 0 || e.probeInFlight) agents[agent] = { ...base(e), provider: this._agentProvider.get(agent) ?? null };
    const providers: Record<string, BreakerPersistedProvider> = {};
    for (const [k, pe] of this.byProvider) {
      if (!(pe.open || pe.streak > 0)) continue;
      const i = k.indexOf(":");
      const provider = k.slice(0, i), errorClass = k.slice(i + 1);
      // A provider breaker has no slot of its own: its cooldown is the earliest next probe among the
      // lanes it caps (each lane reschedules itself through intervalFor above).
      let cooldown: number | null = null;
      for (const [a, ae] of this.byAgent) if (this._agentProvider.get(a) === provider && typeof ae.cooldownUntil === "number" && (cooldown === null || ae.cooldownUntil < cooldown)) cooldown = ae.cooldownUntil;
      providers[k] = { ...base(pe), provider, errorClass, cooldownUntil: iso(cooldown) };
    }
    const lanes: Record<string, string | null> = {};
    for (const [a, p] of this._agentProvider) lanes[a] = p;
    return { schema: BREAKER_STATE_SCHEMA, scheduler, threshold: this.threshold, probeMs: this.probeMs, agents, providers, lanes, updatedAt: new Date(now).toISOString(), reason };
  },
  // Restart semantics (WS-C review 4). An OPEN breaker is a safety the loop earned from N identical
  // failures; an operator restart is not evidence that anything recovered, so it must not close one
  // silently — that is exactly the "restart resets the safety" shape the LOOP-543 outage ran in (the
  // scheduler restarted inside a 19h no-work streak and every restart re-armed full cadence).
  //   • RESUMED: every open / half-open entry whose LAST evidence (lastFailureAt, else openedAt) is
  //     younger than the probe cadence. The previous scheduler would not have probed yet, so the new
  //     one inherits the open state; its first fire on that lane is the probe, and a failed probe keeps
  //     the lane at probe cadence instead of re-accumulating N failures at full cadence.
  //   • NOT resumed (stale): open entries older than the probe cadence. The old scheduler would have
  //     probed by now and nothing is known either way — the restart's first fire is that probe, and
  //     the lane starts fresh. Returned so the caller can say so in one line.
  //   • NEVER resumed: closed entries with a partial streak. A partial streak is evidence, not a
  //     safety; the restart's own fires re-accumulate it.
  // The NEW process's --breaker / --breaker-probe apply throughout (the file's are informational);
  // threshold 0 resumes nothing. Lane→provider mappings fill in only where boot seeding left a gap.
  restore(file: BreakerStateFile, now = Date.now()): BreakerRestoreResult {
    const out: BreakerRestoreResult = { resumed: [], stale: [] };
    if (!this.threshold) return out;
    for (const [a, p] of Object.entries(file.lanes ?? {})) this.seedProvider(a as Agent, p);
    const ageOf = (s: BreakerPersistedEntry): number => { const t = Date.parse(s.lastFailureAt ?? s.openedAt ?? file.updatedAt); return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY; };
    const entryOf = (s: BreakerPersistedEntry): BreakerEntry => ({
      key: s.lastReason, streak: s.consecutiveFailures, open: true, openedAt: parseMs(s.openedAt), lastFailureAt: parseMs(s.lastFailureAt),
      lastErrorClass: s.lastErrorClass, probeInFlight: false, cooldownUntil: null,
    });
    const consider = (kind: "agent" | "provider", name: string, s: BreakerPersistedEntry, apply: () => void) => {
      if (s.state === "closed") return;
      const ageMs = ageOf(s);
      const item = { kind, name, reason: s.lastReason, streak: s.consecutiveFailures, ageMs };
      if (ageMs < this.probeMs) { apply(); out.resumed.push(item); } else out.stale.push(item);
    };
    for (const [agent, s] of Object.entries(file.agents ?? {})) consider("agent", agent, s, () => { this.byAgent.set(agent as Agent, entryOf(s)); });
    for (const s of Object.values(file.providers ?? {})) consider("provider", `${s.provider}:${s.errorClass}`, s, () => { this.byProvider.set(`${s.provider}:${s.errorClass}`, entryOf(s)); });
    if (out.resumed.length) this.onChange?.("resume");
    return out;
  },
};
const parseMs = (s: string | null | undefined): number | null => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
// §16 — what an entry's key looks like ON DISK. A classified key is its errorClass and "(no-output)" is a
// constant; anything else is the fire's last output line — credential-adjacent CLI output the ledger
// deliberately never stores (LOOP-62) — and reaches the file only as a short hash. Identity is what the
// file needs (the streak already counted the repeats); the text is not. record() matches a resumed entry
// against this form, so a streak survives a restart. Idempotent on an already-persisted key.
export function persistedKey(key: string, errorClass: string | null | undefined): string {
  if (errorClass || key === "(no-output)" || /^\(unclassified tail #[0-9a-f]{8}\)$/.test(key)) return key;
  return `(unclassified tail #${createHash("sha256").update(key).digest("hex").slice(0, 8)})`;
}

// ─── WS-C review 4: breaker.json — persistence as a subscriber ───────────────────────────────────────
// Why a file at all: `dev-loop status` used to REPLAY the fire ledger through record() to guess at the
// state the scheduler holds in memory, and the guess is wrong in every way a replay can be (the threshold
// and probe flags are not in the ledger, probe timing is not reproducible, unclassified failures key on a
// tail the ledger never stores, a restart or a 90-day prune moves the replay's start). The scheduler is
// the only process that KNOWS; it writes what it knows, at most once per fire end, and status reads it.
//   schema      — bump when a field's meaning changes; a reader refuses any other version (⇒ replay).
//   scheduler   — pid + startedAt identify the writer; stoppedAt is set by the exit hook, so a file with
//                 stoppedAt:null and a dead pid is a crash, not a running loop (readers probe the pid).
//   threshold / probeMs — the writer's --breaker / --breaker-probe, the two things a replay had to assume.
//   agents / providers — only entries carrying state (open, half-open, or a partial streak).
//   lanes       — agent → provider as the scheduler resolved it; which lanes an open provider breaker caps.
export const BREAKER_STATE_SCHEMA = 1;
export type BreakerChangeReason = "record" | "probe" | "reschedule" | "resume";
export type BreakerPersistedState = "open" | "closed" | "half-open";
export interface BreakerPersistedEntry {
  state: BreakerPersistedState;
  consecutiveFailures: number;
  openedAt: string | null;
  lastFailureAt: string | null;
  lastErrorClass: string | null;
  lastReason: string | null;     // the streak key: the errorClass, "(no-output)", or a hash of an unclassified tail (§16)
  probeInFlight: boolean;
  cooldownUntil: string | null;  // next probe time (agent: its slot; provider: the earliest lane it caps)
}
export interface BreakerPersistedAgent extends BreakerPersistedEntry { provider: string | null }
export interface BreakerPersistedProvider extends BreakerPersistedEntry { provider: string; errorClass: string }
export interface BreakerStateFile {
  schema: number;
  scheduler: { pid: number; startedAt: string; stoppedAt: string | null };
  threshold: number;
  probeMs: number;
  agents: Record<string, BreakerPersistedAgent>;
  providers: Record<string, BreakerPersistedProvider>; // keyed "<provider>:<errorClass>" like byProvider
  lanes: Record<string, string | null>;
  updatedAt: string;
  reason: string;
}
export interface BreakerRestoreItem { kind: "agent" | "provider"; name: string; reason: string | null; streak: number; ageMs: number }
export interface BreakerRestoreResult { resumed: BreakerRestoreItem[]; stale: BreakerRestoreItem[] }

/** Atomic (tmp + rename) and owner-only (§16: it names failure classes and lanes, and sits beside secrets.env). Best-effort: never throws. */
export function writeBreakerState(path: string, file: BreakerStateFile): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    if (platform() !== "win32") { try { chmodSync(tmp, 0o600); } catch { /* best-effort */ } }
    renameSync(tmp, path);
    return true;
  } catch { return false; }
}

/** The file, or null when absent / torn / another schema. A `.tmp` a crashed writer left behind is never read: readers only ever see the last completed rename. */
export function readBreakerState(path: string): BreakerStateFile | null {
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as Partial<BreakerStateFile> | null;
    if (!f || f.schema !== BREAKER_STATE_SCHEMA) return null;
    if (typeof f.scheduler?.pid !== "number" || typeof f.scheduler?.startedAt !== "string") return null;
    if (!f.agents || typeof f.agents !== "object" || !f.providers || typeof f.providers !== "object") return null;
    return { ...f, threshold: typeof f.threshold === "number" ? f.threshold : 0, probeMs: typeof f.probeMs === "number" ? f.probeMs : 0, lanes: f.lanes && typeof f.lanes === "object" ? f.lanes : {}, updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : f.scheduler.startedAt, reason: typeof f.reason === "string" ? f.reason : "" } as BreakerStateFile;
  } catch { return null; }
}

/** Is the writer still the running scheduler? Not stopped, and its pid answers a zero-signal probe (EPERM = exists, not ours). */
export function breakerStateAlive(f: BreakerStateFile): boolean {
  if (f.scheduler.stoppedAt) return false;
  if (!f.scheduler.pid || f.scheduler.pid <= 0) return false;
  try { process.kill(f.scheduler.pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

/**
 * Subscribe the singleton to a file. Writes are COALESCED: record() and the reschedule that follows it
 * in the same turn of the loop become one write, scheduled through `schedule` (setImmediate by default;
 * tests pass a synchronous one). `flush` writes now (scheduler start); `stop` writes the final snapshot
 * with stoppedAt set and unsubscribes — it is synchronous so a process 'exit' hook can call it.
 */
export function createBreakerPersistence(opts: { path: string; startedAt?: string; pid?: number; schedule?: (fn: () => void) => void; now?: () => number }): { path: string; flush(reason?: BreakerChangeReason | "start"): boolean; stop(): boolean } {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? new Date(now()).toISOString();
  const schedule = opts.schedule ?? ((fn) => { setImmediate(fn); });
  let pending: BreakerChangeReason | null = null;
  let stopped = false;
  const write = (reason: BreakerChangeReason | "start" | "stop", stoppedAt: string | null) => writeBreakerState(opts.path, breaker.snapshot({ pid, startedAt, stoppedAt }, reason, now()));
  breaker.onChange = (reason) => {
    if (stopped) return;
    const first = pending === null;
    pending = reason;
    if (first) schedule(() => { const r = pending ?? "record"; pending = null; if (!stopped) write(r, null); });
  };
  return {
    path: opts.path,
    flush: (reason = "start") => write(reason, null),
    stop: () => { stopped = true; breaker.onChange = undefined; return write("stop", new Date(now()).toISOString()); },
  };
}

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
