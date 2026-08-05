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
