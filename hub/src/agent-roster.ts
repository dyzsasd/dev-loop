// The agent roster + the group aliases the `run --agents` parser accepts, factored to ONE place so
// the scheduler (run-agents.ts) and the bundle-load validator (bundle.ts, LOOP-184) can never
// diverge. The roster's single source stays seed.ts AGENT_HANDLES (the "scheduler roster IS the seed
// roster" invariant, run-agents.ts §A2) — a group that named an agent the hub refuses would burn a
// fire; a bundle whose manifest named one would launch nothing.
//
// Job-scoped prompts (docs/design/job-scoped-prompts.md): a GROUP may now list pm/qa LANE tokens
// (pm-maintenance, …, qa-hunt) instead of the bare pm/qa actor, so the DEFAULT run job-boots the two
// highest-frequency agents. A lane is a scheduler fire unit that EXECUTES as its owning actor
// (laneActor: pm-* → pm, qa-* → qa) — it is NOT a seed-roster actor, so the doctor roster and the
// seeded actor rows are unchanged. The bare `pm`/`qa` tokens stay VALID as explicit `--agents` inputs
// (the whole-role classic boot / comparison), they are just no longer in the default groups.
import { AGENT_HANDLES } from "./seed.ts";
import { LANE_SET, type Lane } from "./agent-handles.ts";

type Agent = (typeof AGENT_HANDLES)[number];
// What a group entry / a resolved --agents token may be: a real agent OR a pm/qa lane (a scheduler
// fire unit). Structurally identical to run-agents.ts SchedKey, which reads the SAME table.
type SchedKey = Agent | Lane;

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
//
// pm/qa expand to their LANES (job-scoped prompts): pm → pm-maintenance/pm-groom/pm-review, qa →
// qa-maintenance/qa-hunt. Every fire in a default run therefore job-boots. `outward`/`dev` are actor
// tokens (dev has no lanes; ops/architect/communication are single-job real agents that job-boot as
// themselves via realAgentJob in run-agents.ts).
const PM_LANE_TOKENS = ["pm-maintenance", "pm-groom", "pm-review"] as const;
const QA_LANE_TOKENS = ["qa-maintenance", "qa-hunt"] as const;
export const AGENT_GROUPS: Record<string, SchedKey[]> = Object.assign(Object.create(null) as Record<string, SchedKey[]>, {
  core: [...PM_LANE_TOKENS, ...QA_LANE_TOKENS, "senior-dev", "junior-dev", "sweep"],
  split: [...PM_LANE_TOKENS, ...QA_LANE_TOKENS, "senior-dev", "junior-dev", "sweep"],
  legacy: [...PM_LANE_TOKENS, ...QA_LANE_TOKENS, "dev", "sweep"],
  "single-dev": [...PM_LANE_TOKENS, ...QA_LANE_TOKENS, "dev", "sweep"],
  outward: ["ops", "architect", "communication"],
  all: [...PM_LANE_TOKENS, ...QA_LANE_TOKENS, "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"],
} satisfies Record<string, SchedKey[]>);

const AGENT_SET = new Set<string>(AGENT_HANDLES);

// Validate a comma-separated `--agents` spec against the roster + group aliases + the pm/qa lanes, and
// return the expanded, de-duped key list, or `null` if ANY token is unknown, the whole spec is empty, or
// a token could be read as a flag. Fail-closed by construction — every reject path returns null so a
// caller can refuse. A leading `-` is rejected EXPLICITLY (LOOP-184 AC2): the value flows into a
// `run --agents <spec>` argv element, and a `--force`/`-x` token must never smuggle an option there,
// even though the unknown-token check below would also catch it. Mirrors run-agents.ts
// expandAgentSpec (same expansion — bare agents, groups, AND lane tokens — same empty-token tolerance)
// minus its process-exiting die().
// TOTAL on its input (LOOP-269): no string makes it throw — every reject is a `null` return. A
// validator on a tamper boundary that refuses by crashing cannot say WHAT it refused, and the caller's
// `die()` (bundle.ts, naming `run.agents`) never runs. See AGENT_GROUPS above for how that is held.
export function parseAgentSpec(spec: string): SchedKey[] | null {
  if (typeof spec !== "string") return null;
  const out: SchedKey[] = [];
  for (const raw of spec.split(",")) {
    const name = raw.trim();
    if (!name) continue; // tolerate surrounding whitespace / a trailing comma, as the run parser does
    if (name.startsWith("-")) return null; // never readable as a flag in the run argv
    if (AGENT_GROUPS[name]) out.push(...AGENT_GROUPS[name]);
    else if (AGENT_SET.has(name)) out.push(name as Agent);
    else if (LANE_SET.has(name)) out.push(name as Lane); // a bare pm/qa lane token is a valid explicit input (parity with expandAgentSpec)
    else return null; // an unknown agent/group/lane is tampering or corruption — refuse
  }
  return out.length ? [...new Set(out)] : null; // an all-empty spec ("" / "," / "   ") refuses
}
