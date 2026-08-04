// Union of every DEVLOOP fire-marker env var that cli-agentops.ts's cooperative guard checks,
// PLUS the workspace-resolution vars a fire sets. Any one of these leaking into a test
// subprocess via { ...process.env } causes exit-4 false failures when the suite runs inside a
// real agent fire (LOOP-6, LOOP-32, LOOP-45, LOOP-156) — and DEVLOOP_WORKSPACE is worse than a
// false failure: workspace resolution prefers it over the cwd walk-up, so a mutator spawn aimed
// at a tmpdir fixture writes to the PRODUCTION dev-loop.json instead (2026-08-04: add-project
// fixtures 'real-one'/'a.p.p'/'app'/'clash' landed in the live config through exactly this).
// Callers spread the result of scrubFireEnv() first, then apply their own fixture overrides on
// top — explicit overrides always win.
export const FIRE_MARKER_VARS = [
  "DEVLOOP_PROJECTS_JSON",
  "DEVLOOP_PROJECT",
  "DEVLOOP_ACTOR",
  "DEVLOOP_HUB_DB",
  "DEVLOOP_WORKSPACE",
  "DEVLOOP_DEV_SPLIT",
  "DEVLOOP_TEAM_SCOPE",
  "DEVLOOP_DATA_DIR",
  "DEVLOOP_RUN_DIR",
  "DEVLOOP_PLUGIN_ROOT",
  "DEVLOOP_FIRE_ID",
  "DEVLOOP_HUB_PORT",
] as const;

export function scrubFireEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const k of FIRE_MARKER_VARS) delete env[k];
  return env;
}
