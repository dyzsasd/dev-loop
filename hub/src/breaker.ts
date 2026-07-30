// P0-1a/P0-1b circuit breaker — extracted so tests can import it without triggering main().
// run-agents.ts is an entry-point (main() is unconditional) and cannot be imported by anything.
import { AGENT_HANDLES } from "./seed.ts";
type Agent = (typeof AGENT_HANDLES)[number];

type BreakerEntry = { key: string | null; streak: number; open: boolean };
export const PROVIDER_SCOPED_CLASSES = new Set<string>(["spend-limit", "rate-limit", "auth"]);

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
