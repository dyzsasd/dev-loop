// team-config.ts — schema v2 validation matrix (E01–E11), resolution API, and the toLegacyView compat view.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import {
  validateTeamFile, effectiveProject, effectiveRepo, reposOfProject, primaryRepo,
  referencingProjects, inferProjectForRepo, ownerOf, toLegacyView, normalizedRel,
  parseWorkspaceFile, WsValidationError, isTeamProject, deliveryProjects,
  agentInterfaceFor, DEFAULT_AGENT_INTERFACE, resolveDefaultBranchForPath,
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
// W01 discriminator: scratch:true suppresses the warning; an unmarked zero-repo project still warns (AC3/AC4)
{ const f = base(); f.projects.scratch1 = { repos: [], scratch: true }; ok(!validateTeamFile(f).warnings.some((w) => w.code === "W01" && w.path.includes("scratch1")), "W01 suppressed for scratch:true project"); }
{ const f = base(); f.projects.unmarked = { repos: [] }; ok(validateTeamFile(f).warnings.some((w) => w.code === "W01" && w.path.includes("unmarked")), "W01 still fires for an unmarked zero-repo project (discriminator preserved)"); }
// E08: scratch must be a boolean; string "false" is truthy but not true → E08 + W01 (P2 fix)
{ const f = base(); (f.projects as Record<string, unknown>).str_scratch = { repos: [], scratch: "false" }; const r = validateTeamFile(f); ok(r.errors.some((e) => e.code === "E08" && e.path.includes("scratch")), "E08: non-boolean scratch string is rejected"); ok(r.warnings.some((w) => w.code === "W01" && w.path.includes("str_scratch")), "W01 still fires when scratch is not boolean true"); }

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

// ── E19 + the mode/autonomy vocabulary (LOOP-408) ──────────────────────────────
// Three surfaces used to spell `autonomy` three ways; `guarded` was written by `team init` and read
// by nothing. These pin the ONE token set, the alias direction, and the fact that a typo is refused
// at the config boundary instead of resolving to a posture §12a does not define.
{
  const f = base(); f.team.autonomy = "fulll" as never;
  const e = validateTeamFile(f).errors.find((x) => x.code === "E19");
  ok(!!e && e.path === "team.autonomy", "E19: an unknown team.autonomy token is refused, at the exact path");
  ok(!!e && /ask\|full/.test(e.message), "E19: the message lists the legal tokens");
}
{
  const f = base(); f.projects.devplatform.mode = "dryrun" as never;
  const e = validateTeamFile(f).errors.find((x) => x.code === "E19");
  ok(!!e && e.path === "projects.devplatform.mode", "E19: an unknown project mode is refused, and the path names the project");
}
{ const f = base(); f.team.mode = "live"; f.team.autonomy = "full"; ok(!has(f, "E19"), "E19: the canonical tokens validate clean"); }
{ const f = base(); f.team.autonomy = "guarded"; ok(!has(f, "E19"), "E19: the legacy `guarded` alias still loads (no migration is forced on an existing workspace)"); }

// THE SAFETY PROPERTY: `guarded` meant "ask first", so it resolves to `ask` and NEVER to `full`.
// The opposite mapping would hand every workspace minted before 1.15.1 standing authority to act
// without asking (§12a). Asserted on BOTH members so a mapping to `full` cannot pass either half.
{
  const f = base(); f.team.autonomy = "guarded";
  const eff = effectiveProject(mkWs(f), "devplatform");
  ok(eff.autonomy === "ask", "autonomy alias DIRECTION: team `guarded` resolves to `ask`");
  ok(eff.autonomy !== "full", "autonomy alias DIRECTION: `guarded` never resolves to `full` (it would grant act-without-asking)");
}
{
  const f = base(); f.team.autonomy = "full"; f.projects.devplatform.autonomy = "guarded";
  const eff = effectiveProject(mkWs(f), "devplatform");
  ok(eff.autonomy === "ask", "autonomy alias: a PROJECT-level `guarded` normalizes too, and still overrides a team `full`");
}
// export-desktop-skill renders the agent-facing autonomy line straight off toLegacyView, so this is
// the same value that reaches an agent's prose — the surface where `guarded` was visible before.
{
  const f = base(); f.team.autonomy = "guarded";
  const p = toLegacyView(mkWs(f)).projects.devplatform as { autonomy?: string };
  ok(p.autonomy === "ask", "toLegacyView (what export-desktop-skill renders) carries `ask`, never `guarded`");
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

// ── E17 per-agent timeout fields (fireTimeout / stallTimeout) ──
{ const f = base(); f.team.agents = { pm: { fireTimeout: "30m" } }; ok(codes(f).length === 0, "E17: fireTimeout '30m' is a valid duration"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "0" } }; ok(codes(f).length === 0, "E17: fireTimeout '0' (disable) is valid"); }
{ const f = base(); f.team.agents = { pm: { stallTimeout: "1h" } }; ok(codes(f).length === 0, "E17: stallTimeout '1h' is valid"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "1.5h" } }; ok(codes(f).length === 0, "E17: fireTimeout '1.5h' (decimal) is valid"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "30m", stallTimeout: "5m" } }; ok(codes(f).length === 0, "E17: both fields valid on the same agent"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "30 min" } }; ok(has(f, "E17"), "E17: '30 min' (space) is rejected"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "1hour" } }; ok(has(f, "E17"), "E17: '1hour' (no unit space) is rejected"); }
{ const f = base(); f.team.agents = { pm: { stallTimeout: "abc" } }; ok(has(f, "E17"), "E17: non-duration string is rejected"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "" } }; ok(has(f, "E17"), "E17: empty string is rejected (not a duration, not '0')"); }
{ const f = base(); (f.team as { agents?: unknown }).agents = { pm: { fireTimeout: 30 } }; ok(has(f, "E17"), "E17: a numeric fireTimeout is rejected (must be a string)"); }
{ const f = base(); (f.team as { agents?: unknown }).agents = "sweep"; ok(has(f, "E17"), "E17: a non-object agents block is rejected"); }
{ const f = base(); (f.team as { agents?: unknown }).agents = { pm: "fast" }; ok(has(f, "E17"), "E17: a non-object agent config entry is rejected"); }
// zero-valued duration spellings that parse to 0ms are rejected (would cause parseDuration to process.exit at fire time)
{ const f = base(); f.team.agents = { pm: { fireTimeout: "0ms" } }; ok(has(f, "E17"), "E17: '0ms' is rejected — zero-valued duration, not the disable sentinel"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "0.0" } }; ok(has(f, "E17"), "E17: '0.0' (minutes, rounds to 0) is rejected"); }
{ const f = base(); f.team.agents = { pm: { stallTimeout: "0s" } }; ok(has(f, "E17"), "E17: '0s' stallTimeout is rejected"); }
{ const f = base(); f.projects.devplatform.agents = { dev: { fireTimeout: "0ms" } }; ok(has(f, "E17"), "E17: project-scope '0ms' fireTimeout is also rejected"); }
// duration exceeding Node's 32-bit timer ceiling (~24.8d) is rejected (setTimeout coerces to 1ms → immediate kill)
{ const f = base(); f.team.agents = { pm: { fireTimeout: "30d" } }; ok(has(f, "E17"), "E17: '30d' exceeds 32-bit timer limit and is rejected"); }
{ const f = base(); f.team.agents = { pm: { stallTimeout: "25d" } }; ok(has(f, "E17"), "E17: '25d' exceeds 32-bit timer limit (just over) and is rejected"); }
{ const f = base(); f.team.agents = { pm: { fireTimeout: "24d" } }; ok(codes(f).length === 0, "E17: '24d' is within the 32-bit timer limit and is valid"); }
{ const f = base(); f.projects.devplatform.agents = { pm: { fireTimeout: "30d" } }; ok(has(f, "E17"), "E17: project-scope '30d' fireTimeout also rejected"); }
// error path must name the agent + field (WsError.path carries the dotted location)
{
  const f = base(); f.team.agents = { sweep: { fireTimeout: "bad" } };
  const paths = validateTeamFile(f).errors.filter((e) => e.code === "E17").map((e) => e.path);
  ok(paths.some((p) => /team\.agents\.sweep\.fireTimeout/.test(p)), "E17: error path names team.agents.<agent>.fireTimeout");
}
{
  const f = base(); f.team.agents = { "senior-dev": { stallTimeout: "nope" } };
  const paths = validateTeamFile(f).errors.filter((e) => e.code === "E17").map((e) => e.path);
  ok(paths.some((p) => /team\.agents\.senior-dev\.stallTimeout/.test(p)), "E17: error path names team.agents.<agent>.stallTimeout");
}
// project-level agents also validated
{ const f = base(); f.projects.devplatform.agents = { pm: { fireTimeout: "15m" } }; ok(codes(f).length === 0, "E17: project-level agents.pm.fireTimeout '15m' is valid"); }
{ const f = base(); f.projects.devplatform.agents = { pm: { fireTimeout: "bad" } }; ok(has(f, "E17"), "E17: project-level agents.pm.fireTimeout 'bad' is rejected"); }
{
  const f = base(); f.projects.devplatform.agents = { dev: { stallTimeout: "bad" } };
  const paths = validateTeamFile(f).errors.filter((e) => e.code === "E17").map((e) => e.path);
  ok(paths.some((p) => /projects\.devplatform\.agents\.dev\.stallTimeout/.test(p)), "E17: project-level error path names projects.<key>.agents.<agent>.stallTimeout");
}
// LOOP-103: cadence rejected at project scope (E17), allowed at team scope
{ const f = base(); f.projects.devplatform.agents = { pm: { cadence: "daily" } }; ok(has(f, "E17"), "E17: projects.<key>.agents.<a>.cadence is rejected at project scope"); }
// The fixture value is "1d", not "daily": LOOP-103's point is that cadence is legal at TEAM scope
// and illegal at PROJECT scope, and that distinction is unchanged. "daily" was never a cadence the
// scheduler could read — applyConfigCadence ignores it and runs the built-in default — so asserting
// it validated clean was asserting the LOOP-336 defect. Same intent, a value the read site accepts.
{ const f = base(); f.team.agents = { pm: { cadence: "1d" } }; ok(codes(f).length === 0, "E17: team.agents.<a>.cadence is allowed at team scope"); }
{
  const f = base(); f.projects.devplatform.agents = { pm: { cadence: "daily" } };
  const paths = validateTeamFile(f).errors.filter((e) => e.code === "E17").map((e) => e.path);
  ok(paths.some((p) => /projects\.devplatform\.agents\.pm\.cadence/.test(p)), "E17: project-scope cadence error path names projects.<key>.agents.<a>.cadence");
}

// ── E18 budget validation — unknown keys ──
{ const f = base(); (f.team as unknown as Record<string, unknown>).budget = { dailyUSD: 50 }; ok(has(f, "E18"), "E18: misspelled budget key dailyUSD (capital USD) is rejected"); }
{ const f = base(); (f.team as unknown as Record<string, unknown>).budget = { dailyUsd: 50, extraKey: 1 }; ok(has(f, "E18"), "E18: unknown extra budget key is rejected"); }
{ const f = base(); (f.team as unknown as Record<string, unknown>).budget = { dailyUsd: 50, perFireUsd: 5 }; ok(!has(f, "E18"), "E18: known keys dailyUsd + perFireUsd are valid"); }

// ── E18 team.backup validation (LOOP-339) ──
// The cadence is the only thing standing between this board and the next cascade delete, so a
// malformed value has to be REFUSED at load rather than silently disabling it. Each case below is a
// value that would otherwise read as "backups are on" while producing nothing.
const bk = (v: unknown) => { const f = base(); (f.team as unknown as Record<string, unknown>).backup = v; return f; };
ok(!has(bk({ everyHours: 6, keep: 10, dir: "/snaps" }), "E18"), "E18: a fully-specified backup block is valid");
ok(!has(bk({}), "E18"), "E18: an empty backup block is valid — every field has a shipped default");
ok(!has(bk({ everyHours: 0 }), "E18"), "E18: everyHours 0 is VALID — it is the documented way to disable the cadence");
ok(has(bk(null), "E18"), "E18: backup must be an object, not null");
ok(has(bk([]), "E18"), "E18: …nor an array");
ok(has(bk("6h"), "E18"), "E18: …nor a string");
ok(has(bk({ everyHour: 6 }), "E18"), "E18: a misspelled key (everyHour) is rejected rather than silently ignored");
ok(has(bk({ everyHours: -1 }), "E18"), "E18: a negative everyHours is rejected");
ok(has(bk({ everyHours: "6" }), "E18"), "E18: a stringly-typed everyHours is rejected");
ok(has(bk({ everyHours: Number.NaN }), "E18"), "E18: NaN everyHours is rejected — it would resolve to a disabled cadence that reads as enabled");
ok(has(bk({ keep: 0 }), "E18"), "E18: keep 0 is rejected — a retention that keeps zero generations deletes its own output");
ok(has(bk({ keep: 2.5 }), "E18"), "E18: a fractional keep is rejected");
ok(has(bk({ keep: -3 }), "E18"), "E18: a negative keep is rejected");
ok(has(bk({ dir: "" }), "E18"), "E18: an empty dir is rejected");
ok(has(bk({ dir: "   " }), "E18"), "E18: …as is a whitespace-only dir, which would resolve to the cwd");
ok(has(bk({ dir: 7 }), "E18"), "E18: a non-string dir is rejected");

// ── E08 repos.<ref>.ciIrrelevantPaths (LOOP-335) ──
// This list decides whether a PR is EXEMPTED from a staleness trip, so a malformed entry silently
// widens what gets merged without re-verification. Refused at load, where every other repo fact is.
const cip = (v: unknown) => { const f = base(); (f.repos.portal as unknown as Record<string, unknown>).ciIrrelevantPaths = v; return f; };
ok(!has(cip(["docs/STRATEGY.md", "docs/strategy-archive/"]), "E08"), "E08: a well-formed ciIrrelevantPaths is valid");
ok(!has(cip([]), "E08"), "E08: an empty list is valid — it simply exempts nothing");
ok(has(cip("docs/STRATEGY.md"), "E08"), "E08: a bare string (not an array) is rejected");
ok(has(cip([1]), "E08"), "E08: a non-string element is rejected");
ok(has(cip([""]), "E08"), "E08: an empty-string element is rejected");
ok(has(cip(["   "]), "E08"), "E08: …as is a whitespace-only one");
ok(has(cip(["/etc/passwd"]), "E08"), "E08: an absolute path is rejected — entries are repo-relative");
ok(has(cip(["../outside/x.md"]), "E08"), "E08: a '..' traversal is rejected");
ok(has(cip(["docs/**/*.md"]), "E08"), "E08: a glob is rejected — a glob language is a second thing to get wrong");

// ── AC1: defaultBranch resolution — effectiveRepo fallback chain + resolveDefaultBranchForPath ──
{
  const mkWsDb = (overrides: Partial<ReturnType<typeof base>["team"]>, repoOverrides?: Record<string, unknown>): Workspace => {
    const f = base();
    Object.assign(f.team, overrides);
    if (repoOverrides) Object.assign(f.repos.portal, repoOverrides);
    return mkWs(f);
  };

  // per-repo override wins
  ok(effectiveRepo(mkWsDb({}, { defaultBranch: "master" }), "portal").defaultBranch === "master",
    "AC1: repos[].defaultBranch 'master' → resolved to 'master'");

  // top-level git.defaultBranch fallback
  {
    const f = base();
    (f.team as { git?: { defaultBranch?: string } }).git = { defaultBranch: "trunk" };
    ok(effectiveRepo(mkWs(f), "portal").defaultBranch === "trunk",
      "AC1: team.git.defaultBranch 'trunk' → resolved when no per-repo override");
  }

  // per-repo wins over team-level
  {
    const f = base();
    (f.team as { git?: { defaultBranch?: string } }).git = { defaultBranch: "trunk" };
    f.repos.portal.defaultBranch = "master";
    ok(effectiveRepo(mkWs(f), "portal").defaultBranch === "master",
      "AC1: per-repo 'master' beats team.git.defaultBranch 'trunk'");
  }

  // neither present → "main" (backward compat, AC7)
  ok(effectiveRepo(mkWsDb({}), "portal").defaultBranch === "main",
    "AC1/AC7: no defaultBranch anywhere → falls back to 'main' (backward compat)");

  // resolveDefaultBranchForPath: by absPath
  {
    const f = base();
    f.repos.portal.defaultBranch = "release";
    const ws = mkWs(f);
    ok(resolveDefaultBranchForPath(ws, "/ws/jinko-dev-platform") === "release",
      "resolveDefaultBranchForPath: returns the branch for a registered absPath");
    ok(resolveDefaultBranchForPath(ws, "/ws/unregistered-dir") === undefined,
      "resolveDefaultBranchForPath: returns undefined for an unregistered dir (caller must fail loud)");
  }
}

// ── LOOP-82: the agents{} KEY is validated, not only its fields ────────────────────────────────
// A schema that checks a field's VALUE says nothing about whether the key it hangs off is real, so
// `junoir-dev` passed with zero errors AND zero warnings and then silently never applied — every
// read site looks the REAL name up. A WARNING, not an error: a config naming a retired agent must
// not lock the operator out of the commands that repair it (the E09 shape).
{
  const warnCodes = (f: unknown): string[] => validateTeamFile(f).warnings.map((w) => w.code);
  const warnAt = (f: unknown, path: string): boolean => validateTeamFile(f).warnings.some((w) => w.path === path);

  const typo = base();
  typo.team.agents = { "junoir-dev": { fireTimeout: "30m" } };
  ok(warnCodes(typo).includes("W04") && warnAt(typo, "team.agents.junoir-dev"),
    "LOOP-82: a typo'd team.agents.<name> key raises W04 naming the exact path");
  ok(!has(typo, "E17"), "LOOP-82: it stays a WARNING — an unknown agent name never hard-fails the config");
  ok(/junoir-dev/.test(validateTeamFile(typo).warnings.find((w) => w.code === "W04")?.message ?? ""),
    "LOOP-82: the warning quotes the offending name so the operator can find the typo");

  const good = base();
  good.team.agents = { "junior-dev": { fireTimeout: "30m" }, pm: { model: "claude-opus-5" } };
  ok(!warnCodes(good).includes("W04"), "LOOP-82: every real agent name is accepted silently");

  const projTypo = base();
  projTypo.projects.devplatform.agents = { "qaa": { model: "m" } };
  ok(warnAt(projTypo, "projects.devplatform.agents.qaa"), "LOOP-82: project-scope agent keys are checked on the same rule");
}

// ── LOOP-336: cadence is format-checked like its two siblings in the same E17 loop ─────────────
// A malformed cadence produced a clean `dev-loop doctor` and an agent silently running at its
// built-in default — the operator's intent discarded, with the only trace one console.warn line on
// a 51 MB run.log. The validator must accept exactly what applyConfigCadence accepts, nothing more.
{
  const withCadence = (v: unknown): TeamFile => {
    const f = base();
    f.team.agents = { sweep: { cadence: v as string } };
    return f;
  };
  const cadenceErr = (v: unknown): boolean =>
    validateTeamFile(withCadence(v)).errors.some((e) => e.path === "team.agents.sweep.cadence");

  for (const good of ["10m", "1h", "1d", "30s", "1.5h", "500ms"])
    ok(!cadenceErr(good), `LOOP-336: '${good}' is accepted (the read site accepts it)`);
  for (const bad of ["10min", "every 10 minutes", "", "-5m", "0m", "1000d"])
    ok(cadenceErr(bad), `LOOP-336: '${bad}' is refused (the read site ignores it and runs the default)`);
  ok(cadenceErr(600000 as unknown), "LOOP-336: a non-string cadence is refused too");

  // The pre-existing PROJECT-scope rule is untouched: cadence there is not honoured at all, and its
  // message must stay the 'set it under team.agents' guidance rather than a format complaint.
  const proj = base();
  proj.projects.devplatform.agents = { sweep: { cadence: "10m" } };
  const projErr = validateTeamFile(proj).errors.find((e) => e.path === "projects.devplatform.agents.sweep.cadence");
  ok(!!projErr && /not honoured in team mode/.test(projErr.message),
    "LOOP-336: a WELL-FORMED project-scope cadence still raises the original 'not honoured' E17, not a format error");
}

console.log(fails === 0 ? "\nTEAM_CONFIG_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
