// The agent roster, as a ZERO-IMPORT leaf.
//
// The roster's single source has always been seed.ts (the "scheduler roster IS the seed roster"
// invariant, run-agents.ts §A2), but seed.ts pulls in workspace.ts → team-config.ts, so the schema
// validator could not read the roster it must validate against without closing an import cycle
// (team-config → seed → workspace → team-config). Splitting the bare list into this leaf lets every
// layer — schema, seeder, scheduler, bundle validator — share ONE definition with no cycle.
//
// seed.ts re-exports AGENT_HANDLES / STEWARD_HANDLES so existing importers are unaffected.

export const AGENT_HANDLES = ["pm", "qa", "dev", "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"] as const;

// The team-scope STEWARD roles (M4): the scheduler fires these once for the whole team (project
// `_team`), and the D1 hub project-override matrix (agentops.resolveProjectOverride) lets exactly
// these actors cross project boundaries server-side.
export const STEWARD_HANDLES = ["sweep", "ops", "reflect", "communication"] as const;

export const AGENT_HANDLE_SET: ReadonlySet<string> = new Set<string>(AGENT_HANDLES);

// ── job-lanes (job-scoped prompts, docs/design/job-scoped-prompts.md) ─────────────────────────────────
// A LANE is a SCHEDULER fire unit — its own cadence + model + which job playbook loads — mirroring how
// the dev split made senior-dev/junior-dev fire units, EXCEPT a lane keeps actor identity of a REAL agent
// (same owner label, same board slice); it is NOT a new actor. So the lanes live HERE (the roster leaf the
// scheduler reads) but are deliberately NOT in AGENT_HANDLES: the seeder creates no actor row for them,
// DEVLOOP_ACTOR is never a lane, and the doctor roster is unchanged. Both pm and qa are split into lanes;
// a lane fires as its owning actor (pm-* → pm, qa-* → qa).
export const PM_LANES = ["pm-maintenance", "pm-groom", "pm-review"] as const;
export type PmLane = (typeof PM_LANES)[number];
export const PM_LANE_SET: ReadonlySet<string> = new Set<string>(PM_LANES);
export const isPmLane = (s: string): s is PmLane => PM_LANE_SET.has(s);
// The actor every pm lane fires as (always `pm`) — the KEY difference from the dev split.
export const PM_LANE_ACTOR: Record<PmLane, "pm"> = { "pm-maintenance": "pm", "pm-groom": "pm", "pm-review": "pm" };
// The job(s) a lane may run, in gate-priority order (pm-maintenance tries verify, then unblock).
export const PM_LANE_JOBS: Record<PmLane, readonly string[]> = {
  "pm-maintenance": ["verify", "unblock"], // Job A then Job B — both mechanical, one shared `queue` read
  "pm-groom": ["groom"],                   // Job B2 — design-ish backlog→spec shaping
  "pm-review": ["review"],                 // Job C — product ideation, change-gated
};

// qa job-lanes — the pm PoC applied to QA. qa-maintenance (mechanical, cheaper class) runs verify then
// unblock; qa-hunt (judgment-scaffold, stronger class) runs the change-gated bughunt battery. Both fire
// as actor `qa`.
export const QA_LANES = ["qa-maintenance", "qa-hunt"] as const;
export type QaLane = (typeof QA_LANES)[number];
export const QA_LANE_SET: ReadonlySet<string> = new Set<string>(QA_LANES);
export const isQaLane = (s: string): s is QaLane => QA_LANE_SET.has(s);
export const QA_LANE_ACTOR: Record<QaLane, "qa"> = { "qa-maintenance": "qa", "qa-hunt": "qa" };
export const QA_LANE_JOBS: Record<QaLane, readonly string[]> = {
  "qa-maintenance": ["verify", "unblock"], // Job A then Job B — both mechanical, one shared board read
  "qa-hunt": ["bughunt"],                  // Job C — bug-hunt battery, change-gated
};

// ── the unified lane surface every scheduler branch keys on ───────────────────────────────────────────
// One membership test / actor map / job map over BOTH pm and qa lanes, so the dispatch code (expandAgentSpec,
// runAgent, the two tick loops) has a single `isLane`/`LANE_ACTOR`/`LANE_JOBS` to consult instead of a pm-only
// branch and a parallel qa-only branch that could drift.
export const LANES = [...PM_LANES, ...QA_LANES] as const;
export type Lane = PmLane | QaLane;
export const LANE_SET: ReadonlySet<string> = new Set<string>(LANES);
export const isLane = (s: string): s is Lane => LANE_SET.has(s);
export const LANE_ACTOR: Record<Lane, "pm" | "qa"> = { ...PM_LANE_ACTOR, ...QA_LANE_ACTOR };
export const LANE_JOBS: Record<Lane, readonly string[]> = { ...PM_LANE_JOBS, ...QA_LANE_JOBS };
