// team-config.ts — schema v2 validation matrix (E01–E11), resolution API, and the toLegacyView compat view.
import {
  validateTeamFile, effectiveProject, effectiveRepo, reposOfProject, primaryRepo,
  referencingProjects, inferProjectForRepo, ownerOf, toLegacyView, normalizedRel,
  parseWorkspaceFile, WsValidationError, type TeamFile, type Workspace,
} from "../src/team-config.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// A minimal VALID team file, then mutate copies to trigger each error code.
const base = (): TeamFile => ({
  schemaVersion: 2,
  team: { key: "jinko-dev", backend: "linear", linearTeam: "Loop-1", deployPolicy: { dev: "auto", prod: "manual" } },
  repos: {
    portal: { path: "jinko-dev-platform", landing: "pr", deploy: { environments: { dev: { auto: true }, prod: { auto: false } } } },
  },
  projects: {
    devplatform: { linearProject: "DevPlatform", repos: [{ ref: "portal", role: "primary" }] },
  },
});

// codes(file) → the sorted set of error codes emitted.
const codes = (f: unknown): string[] => [...new Set(validateTeamFile(f).errors.map((e) => e.code))].sort();
const has = (f: unknown, code: string): boolean => validateTeamFile(f).errors.some((e) => e.code === code);

// ── happy path ──
ok(codes(base()).length === 0, "a valid team file yields zero errors");

// ── E01 schemaVersion ──
{ const f = base() as { schemaVersion: number }; f.schemaVersion = 1; ok(has(f, "E01"), "E01: schemaVersion !== 2"); }
ok(has(null, "E01"), "E01: non-object config");

// ── E02 team block ──
{ const f = base(); (f.team as { key: string }).key = "BadKey"; ok(has(f, "E02"), "E02: uppercase team.key"); }
{ const f = base(); (f.team as { backend: string }).backend = "sqlite"; ok(has(f, "E02"), "E02: bad backend"); }

// ── E09 linear needs linearTeam ──
{ const f = base(); delete (f.team as { linearTeam?: string }).linearTeam; ok(has(f, "E09"), "E09: linear backend without linearTeam"); }
{ const f = base(); f.team.backend = "service"; delete (f.team as { linearTeam?: string }).linearTeam; ok(!has(f, "E09"), "E09: service backend does NOT require linearTeam"); }

// ── E03 path escape ──
{ const f = base(); f.repos.portal.path = "/abs/path"; ok(has(f, "E03"), "E03: absolute repo path"); }
{ const f = base(); f.repos.portal.path = "../escape"; ok(has(f, "E03"), "E03: repo path escapes workspace"); }
{ const f = base(); f.repos.portal.path = "a/../../b"; ok(has(f, "E03"), "E03: repo path escapes via .. mid-path"); }
ok(normalizedRel("a/./b/../c") === "a/c", "normalizedRel collapses . and ..");
ok(normalizedRel("../x") === null && normalizedRel("/x") === null, "normalizedRel rejects escape/absolute");

// ── E04 unknown ref ──
{ const f = base(); f.projects.devplatform.repos = [{ ref: "ghost" }]; ok(has(f, "E04"), "E04: project references unknown repo ref"); }

// ── E05 shared repo needs owner (independent of enabled) ──
{
  const f = base();
  f.projects.agentapi = { linearProject: "AgentAPI", repos: [{ ref: "portal" }] };
  ok(has(f, "E05"), "E05: repo shared by 2 projects without owner");
  f.repos.portal.owner = "devplatform";
  ok(!has(f, "E05"), "E05: resolved once a valid owner is set");
  f.repos.portal.owner = "nobody";
  ok(has(f, "E05"), "E05: owner not among referrers");
  // must NOT flip based on enabled — a disabled referrer still counts (I2)
  f.repos.portal.owner = "devplatform";
  f.projects.agentapi.enabled = false;
  ok(!has(f, "E05") && referencingProjects(mkWs(f), "portal").length === 2, "E05: owner requirement ignores enabled toggling");
}

// ── E06 deployPolicy ceiling ──
{ const f = base(); f.repos.portal.deploy!.environments!.prod.auto = true; ok(has(f, "E06"), "E06: auto-deploy prod under manual ceiling"); }
{ const f = base(); f.team.deployPolicy = { dev: "manual" }; f.repos.portal.deploy!.environments!.dev.auto = true; ok(has(f, "E06"), "E06: dev ceiling manual + auto:true"); }

// ── E07 comms env-name discipline (I5) ──
{ const f = base(); f.team.comms = { provider: "lark", webhookEnv: "https://hook.example/x" as string }; ok(has(f, "E07"), "E07: webhookEnv is a URL, not an env name"); }
{ const f = base(); f.team.comms = { provider: "teams" as "slack", webhookEnv: "DEVLOOP_COMMS_WEBHOOK" }; ok(has(f, "E07"), "E07: bad provider"); }
{ const f = base(); f.team.comms = { provider: "slack", webhookEnv: "DEVLOOP_COMMS_WEBHOOK" }; ok(!has(f, "E07"), "E07: a proper provider + env name passes"); }

// ── E08 enabled/weight ──
{ const f = base(); (f.projects.devplatform as { weight: number }).weight = -1; ok(has(f, "E08"), "E08: negative weight"); }
{ const f = base(); (f.projects.devplatform as { enabled: unknown }).enabled = "yes"; ok(has(f, "E08"), "E08: non-boolean enabled"); }

// ── E10 duplicate path / linearProjectId ──
{ const f = base(); f.repos.mirror = { path: "jinko-dev-platform" }; ok(has(f, "E10"), "E10: two refs at the same path"); }
{
  const f = base();
  f.projects.devplatform.linearProjectId = "abc";
  f.projects.other = { linearProjectId: "abc", repos: [{ ref: "portal", role: "primary" }] };
  f.repos.portal.owner = "devplatform"; // avoid E05 masking
  ok(has(f, "E10"), "E10: two projects claiming one linearProjectId");
}

// ── E11 reserved names / charset ──
for (const bad of ["team", "lessons", "wt", "locks", "hub.db"]) {
  const f = base(); f.projects[bad] = { repos: [{ ref: "portal" }] }; f.repos.portal.owner = "devplatform";
  ok(has(f, "E11"), `E11: reserved project key '${bad}'`);
}
{ const f = base(); f.repos["_bad"] = { path: "x" }; ok(has(f, "E11"), "E11: repo ref with leading underscore"); }
{ const f = base(); f.projects["_team"] = { repos: [{ ref: "portal" }] }; f.repos.portal.owner = "devplatform"; ok(!has(f, "E11"), "E11: _team is the permitted reserved intake project key"); }

// ── W01/W02 warnings (not errors) ──
{ const f = base(); f.repos.orphan = { path: "orphan-dir" }; ok(validateTeamFile(f).warnings.some((w) => w.code === "W02"), "W02: registered repo referenced by nobody"); }
{ const f = base(); f.projects.empty = { repos: [] }; ok(validateTeamFile(f).warnings.some((w) => w.code === "W01"), "W01: project with zero repos"); }

// ── parseWorkspaceFile throws WsValidationError on bad JSON / bad schema ──
try { parseWorkspaceFile("{not json", "/x/dev-loop.json"); ok(false, "parseWorkspaceFile throws on bad JSON"); }
catch (e) { ok(e instanceof WsValidationError, "parseWorkspaceFile throws WsValidationError on bad JSON"); }
try { parseWorkspaceFile(JSON.stringify({ schemaVersion: 9 }), "/x/dev-loop.json"); ok(false, "throws on bad schema"); }
catch (e) { ok(e instanceof WsValidationError && (e as WsValidationError).errors.length > 0, "parseWorkspaceFile throws WsValidationError with codes on bad schema"); }

// ── resolution API ──
function mkWs(f: TeamFile): Workspace { return { root: "/ws", filePath: "/ws/dev-loop.json", file: f, warnings: [] }; }
{
  const f = base();
  f.projects.agentapi = { linearProject: "AgentAPI", repos: [{ ref: "portal" }] };
  f.repos.portal.owner = "devplatform";
  const ws = mkWs(f);

  ok(effectiveRepo(ws, "portal").absPath === "/ws/jinko-dev-platform", "effectiveRepo absolutizes path against root");
  ok(primaryRepo(ws, "devplatform") === "/ws/jinko-dev-platform", "primaryRepo returns the primary repo abs path");
  ok(reposOfProject(ws, "agentapi").length === 1, "reposOfProject lists refs");
  ok(referencingProjects(ws, "portal").sort().join(",") === "agentapi,devplatform", "referencingProjects lists all referrers");

  const infPortal = inferProjectForRepo(ws, "portal");
  ok(infPortal.kind === "ambiguous" && infPortal.candidates.length === 2, "inferProjectForRepo: shared repo → ambiguous");
  f.repos.solo = { path: "solo-dir" };
  f.projects.devplatform.repos.push({ ref: "solo" });
  ok(inferProjectForRepo(ws, "solo").kind === "unique", "inferProjectForRepo: single-referrer → unique");
  f.repos.lonely = { path: "lonely-dir" };
  ok(inferProjectForRepo(ws, "lonely").kind === "none", "inferProjectForRepo: no referrer → none");

  ok(ownerOf(ws, "portal") === "devplatform", "ownerOf: explicit owner");
  ok(ownerOf(ws, "solo") === "devplatform", "ownerOf: sole referrer");
  try { ownerOf(ws, "lonely"); ok(false, "ownerOf throws on zero referrers"); } catch { ok(true, "ownerOf throws on a zero-referrer repo"); }
}

// ── effectiveProject: behavior fields resolve project ∥ team ──
{
  const f = base();
  f.team.mode = "live"; f.team.autonomy = "full"; f.team.docSystem = "backend";
  f.projects.devplatform.mode = "dry-run"; // project override
  const ws = mkWs(f);
  const eff = effectiveProject(ws, "devplatform");
  ok(eff.mode === "dry-run", "effectiveProject: project mode overrides team");
  ok(eff.autonomy === "full" && eff.docSystem === "backend" && eff.backend === "linear", "effectiveProject: unset fields fall back to team; backend stamped");
}

// ── toLegacyView: the compat shape every existing consumer reads ──
{
  const f = base();
  f.projects.devplatform.devSplit = true;
  const ws = mkWs(f);
  const legacy = toLegacyView(ws);
  const p = legacy.projects.devplatform as Record<string, unknown>;
  ok(p.backend === "linear", "toLegacyView stamps team backend onto each project");
  ok(p.repoPath === "/ws/jinko-dev-platform", "toLegacyView sets repoPath to the abs primary repo");
  ok(Array.isArray(p.repos) && (p.repos as { path: string }[])[0].path === "/ws/jinko-dev-platform", "toLegacyView repos[].path is absolute");
  ok((p.repos as { landing?: string }[])[0].landing === "pr", "toLegacyView carries the registry's physical fields into repos[]");
  ok(p.devSplit === true && p.enabled === true && p.weight === 1, "toLegacyView carries devSplit + enabled/weight defaults");
  ok(p.linearTeam === "Loop-1", "toLegacyView stamps team linearTeam");
}

console.log(fails === 0 ? "\nTEAM_CONFIG_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
