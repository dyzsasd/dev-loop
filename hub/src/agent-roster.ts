// The agent roster + the group aliases the `run --agents` parser accepts, factored to ONE place so
// the scheduler (run-agents.ts) and the bundle-load validator (bundle.ts, LOOP-184) can never
// diverge. The roster's single source stays seed.ts AGENT_HANDLES (the "scheduler roster IS the seed
// roster" invariant, run-agents.ts §A2) — a group that named an agent the hub refuses would burn a
// fire; a bundle whose manifest named one would launch nothing.
import { AGENT_HANDLES } from "./seed.ts";

type Agent = (typeof AGENT_HANDLES)[number];

// Documented `--agents` set aliases (run-agents.ts --help): comma tokens expand through these.
//
// NULL-PROTOTYPE, deliberately (LOOP-269). Both readers look a caller-supplied token up as
// `AGENT_GROUPS[name]` — here at parseAgentSpec, and at run-agents.ts expandAgentSpec. On an ordinary
// object literal every `Object.prototype` key (`constructor`, `toString`, `__proto__`, `valueOf`,
// `hasOwnProperty`, `isPrototypeOf`) resolves truthy to an INHERITED value, and the `push(...)` spread
// that follows then throws `TypeError: Spread syntax requires ...iterable` instead of refusing. The
// fix belongs on the TABLE, not on each reader: an own-property check at one call site leaves the
// other — and the next one — open, whereas a table with no prototype has no inherited key to find.
// If you ever copy these entries into a plain object, you re-open the hole for that copy's readers.
export const AGENT_GROUPS: Record<string, Agent[]> = Object.assign(Object.create(null) as Record<string, Agent[]>, {
  core: ["pm", "qa", "senior-dev", "junior-dev", "sweep"],
  split: ["pm", "qa", "senior-dev", "junior-dev", "sweep"],
  legacy: ["pm", "qa", "dev", "sweep"],
  "single-dev": ["pm", "qa", "dev", "sweep"],
  outward: ["ops", "architect", "communication"],
  all: ["pm", "qa", "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"],
} satisfies Record<string, Agent[]>);

const AGENT_SET = new Set<string>(AGENT_HANDLES);

// Validate a comma-separated `--agents` spec against the roster + group aliases and return the
// expanded, de-duped agent list, or `null` if ANY token is unknown, the whole spec is empty, or a
// token could be read as a flag. Fail-closed by construction — every reject path returns null so a
// caller can refuse. A leading `-` is rejected EXPLICITLY (LOOP-184 AC2): the value flows into a
// `run --agents <spec>` argv element, and a `--force`/`-x` token must never smuggle an option there,
// even though the unknown-token check below would also catch it. Mirrors run-agents.ts
// expandAgentSpec (same expansion, same empty-token tolerance) minus its process-exiting die().
// TOTAL on its input (LOOP-269): no string makes it throw — every reject is a `null` return. A
// validator on a tamper boundary that refuses by crashing cannot say WHAT it refused, and the caller's
// `die()` (bundle.ts, naming `run.agents`) never runs. See AGENT_GROUPS above for how that is held.
export function parseAgentSpec(spec: string): Agent[] | null {
  if (typeof spec !== "string") return null;
  const out: Agent[] = [];
  for (const raw of spec.split(",")) {
    const name = raw.trim();
    if (!name) continue; // tolerate surrounding whitespace / a trailing comma, as the run parser does
    if (name.startsWith("-")) return null; // never readable as a flag in the run argv
    if (AGENT_GROUPS[name]) out.push(...AGENT_GROUPS[name]);
    else if (AGENT_SET.has(name)) out.push(name as Agent);
    else return null; // an unknown agent/group is tampering or corruption — refuse
  }
  return out.length ? [...new Set(out)] : null; // an all-empty spec ("" / "," / "   ") refuses
}
