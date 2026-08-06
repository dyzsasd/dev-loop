// LOOP-349: one definition of "not a scratch project", shared by the project switcher
// (daemon.ts), doctor counts (doctor.ts), and the project index (views/projects.ts).
// A future edit to the hiding rule touches ONE place rather than silently drifting.
//
// The predicate excludes rows where scratch:true is set in settings_json. A row whose
// settings_json is not valid JSON is treated as NOT scratch: the page stays up rather than
// crashing the index. json_valid guards json_extract, which would throw on unparseable input.
export const NOT_SCRATCH_SQL = `CASE WHEN json_valid(settings_json) THEN json_extract(settings_json,'$.scratch') ELSE NULL END IS NOT 1`;