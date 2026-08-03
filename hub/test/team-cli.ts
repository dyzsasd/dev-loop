// team init / import / repair + doctor workspace checks — integration via the real CLI entry points.
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
    ok(Array.isArray(stJson.permissions?.allow) && stJson.permissions.allow.includes("Bash(dev-loop *)") && stJson.permissions.allow.includes("Bash(kaizen *)"),
      "team init provisions .claude/settings.json permissions.allow: Bash(dev-loop *) + Bash(kaizen *) (LOOP-181)");
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
    ok(JSON.stringify(merged.permissions.allow) === '["Bash(git *)","Bash(dev-loop *)","Bash(kaizen *)"]',
      "both CLI rules are APPENDED to the existing allow list, in order, preserving Bash(git *) (LOOP-181)");
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

    // ── W23 (LOOP-181): a workspace provisioned before the `kaizen` bin — allows Bash(dev-loop *) but not
    //    Bash(kaizen *) — draws a warn-only doctor finding that NAMES the repair verb; DOCTOR_OK stays intact.
    const w23st = join(custom, ".claude", "settings.json");
    const rewind = readJson(w23st);
    rewind.permissions.allow = ["Bash(git *)", "Bash(dev-loop *)"]; // drop Bash(kaizen *): the pre-rename state
    writeFileSync(w23st, JSON.stringify(rewind, null, 2) + "\n");
    const w23 = run("server", ["doctor"], { cwd: custom });
    ok(/\[W23\]/.test(w23.out), "doctor warns W23 when settings.json allows dev-loop * but not kaizen *");
    ok(/team repair/.test(w23.out), "the W23 message names the `team repair` top-up verb");
    ok(/DOCTOR_OK/.test(w23.out) && !/DOCTOR_FAILED/.test(w23.out), "W23 is warn-only — the doctor verdict stays OK");
    // the inverse: once both rules are present, W23 is silent (no false positive)
    rewind.permissions.allow = ["Bash(git *)", "Bash(dev-loop *)", "Bash(kaizen *)"];
    writeFileSync(w23st, JSON.stringify(rewind, null, 2) + "\n");
    ok(!/\[W23\]/.test(run("server", ["doctor"], { cwd: custom }).out), "W23 is silent once Bash(kaizen *) is present (no false positive)");
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

    // Add 2 code commits to origin after the v1.2.3 tag (simulate merged-after-release work)
    writeFileSync(join(w18Clone, "src-fix1.ts"), "// code fix 1\n");
    gitW18(w18Clone, ["add", "src-fix1.ts"]);
    gitW18(w18Clone, ["commit", "-qm", "fix: code change 1"]);
    writeFileSync(join(w18Clone, "src-fix2.ts"), "// code fix 2\n");
    gitW18(w18Clone, ["add", "src-fix2.ts"]);
    gitW18(w18Clone, ["commit", "-qm", "fix: code change 2"]);
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
    ok(/2 code commit/.test(w18behind.out), "W18 names the code commit count (2 code commits behind)");
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

    // Case E (LOOP-151): doc-only commits behind the release → W18 SILENT, DOCTOR_OK holds
    {
      // Re-tag v1.2.3 at the current origin/main HEAD (the 2 code commits from Case A)
      const headE = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headE]);
      // Add doc-only commits (simulates PM doc-land, which should not trigger W18)
      mkdirSync(join(w18Clone, "docs"), { recursive: true });
      writeFileSync(join(w18Clone, "docs", "STRATEGY.md"), "# strategy\n");
      gitW18(w18Clone, ["add", "docs/STRATEGY.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: update strategy"]);
      writeFileSync(join(w18Clone, "docs", "NOTES.md"), "# notes\n");
      gitW18(w18Clone, ["add", "docs/NOTES.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: add notes"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18docOnly = run("server", ["doctor"], { cwd: w18Root, extra: { DEVLOOP_W18_PKG_JSON: w18PkgJson } });
      ok(!/\[W18\]/.test(w18docOnly.out), "W18 is silent when every commit since the release touches only docs/** (LOOP-151)");
      ok(/DOCTOR_OK/.test(w18docOnly.out), "DOCTOR_OK holds when all post-release commits are doc-only (LOOP-151)");
    }

    // Case F (LOOP-151): mixed doc + code commits → W18 fires with CODE-ONLY count, not total
    {
      // Re-tag v1.2.3 at the current origin/main HEAD (after the doc commits from Case E)
      const headF = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headF]);
      // Add 1 code commit + 2 doc commits (3 total, but only 1 is code-bearing)
      writeFileSync(join(w18Clone, "src-mixed.ts"), "// code change\n");
      gitW18(w18Clone, ["add", "src-mixed.ts"]);
      gitW18(w18Clone, ["commit", "-qm", "fix: code fix in mixed window"]);
      writeFileSync(join(w18Clone, "docs", "MORE.md"), "# more\n");
      gitW18(w18Clone, ["add", "docs/MORE.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: more strategy"]);
      writeFileSync(join(w18Clone, "docs", "EXTRA.md"), "# extra\n");
      gitW18(w18Clone, ["add", "docs/EXTRA.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: extra notes"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18mixed = run("server", ["doctor"], { cwd: w18Root, extra: { DEVLOOP_W18_PKG_JSON: w18PkgJson } });
      ok(/\[W18\]/.test(w18mixed.out), "W18 fires for mixed window: code commit present (LOOP-151)");
      ok(/1 code commit/.test(w18mixed.out), "W18 reports code-bearing count (1), not total (3) (LOOP-151)");
      ok(/\+2 doc-only/.test(w18mixed.out), "W18 mentions doc-only commits separately (+2 doc-only) (LOOP-151)");
      ok(/DOCTOR_OK/.test(w18mixed.out), "DOCTOR_OK holds for mixed commits (LOOP-151)");
    }

    // Case G (LOOP-167 §9.8 AC-1): code-behind > 0 → NEXT has release-readiness hint naming N
    // State after Case F: tag v1.2.3 at headF; origin/main has 1 code + 2 doc commits ahead → codeBehind=1
    // Set live mode so nextStep reaches the skewResult clause (dry-run check is higher priority)
    // Scrub DEVLOOP_HUB_DB so the doctor uses wsHubDb(ws), not the ambient fire hub.db (LOOP-167 hermeticity)
    const w18HubDbScrub = { DEVLOOP_W18_PKG_JSON: w18PkgJson, DEVLOOP_HUB_DB: "" };
    run("team", ["set", "team.mode", "live"], { cwd: w18Root });
    const w18nextBehind = run("server", ["doctor"], { cwd: w18Root, extra: w18HubDbScrub });
    ok(/NEXT:.*cut a release/.test(w18nextBehind.out), "NEXT carries release-readiness hint when code-behind > 0 (LOOP-167)");
    ok(/1 shipped-code commit/.test(w18nextBehind.out), "NEXT names the honest count N=1 (LOOP-167)");
    ok(/release-npm\.yml/.test(w18nextBehind.out), "NEXT names the dispatch action (LOOP-167)");
    ok(/DOCTOR_OK/.test(w18nextBehind.out), "DOCTOR_OK unaffected by the release-readiness NEXT hint (LOOP-167)");

    // Case H (LOOP-167 §9.8 AC-2): docs-only delta (honest count 0) → NO release-readiness NEXT line
    // Reset tag to current origin/main tip, add only doc commits → codeBehind=0
    {
      const headH = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headH]);
      writeFileSync(join(w18Clone, "docs", "LOOP167-A.md"), "# loop167 a\n");
      gitW18(w18Clone, ["add", "docs/LOOP167-A.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: LOOP-167 test doc A"]);
      writeFileSync(join(w18Clone, "docs", "LOOP167-B.md"), "# loop167 b\n");
      gitW18(w18Clone, ["add", "docs/LOOP167-B.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: LOOP-167 test doc B"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18nextDocOnly = run("server", ["doctor"], { cwd: w18Root, extra: w18HubDbScrub });
      ok(!/cut a release/.test(w18nextDocOnly.out), "no release-readiness NEXT when docs-only delta (codeBehind=0) (LOOP-167)");
      ok(/DOCTOR_OK/.test(w18nextDocOnly.out), "DOCTOR_OK holds for docs-only delta NEXT check (LOOP-167)");
    }

    // Case I (LOOP-167 §9.8 AC-3): unresolvable installed version → no NEXT hint, no added git calls
    // Reuses w18PkgNoTag (version "9.9.9") — no tag/release commit → vCommit null → skewResult null
    const w18nextNoVer = run("server", ["doctor"], { cwd: w18Root, extra: { DEVLOOP_W18_PKG_JSON: w18PkgNoTag, DEVLOOP_HUB_DB: "" } });
    ok(!/cut a release/.test(w18nextNoVer.out), "no release-readiness NEXT when version unresolvable (LOOP-167)");
    ok(/DOCTOR_OK/.test(w18nextNoVer.out), "DOCTOR_OK holds when version unresolvable — NEXT check adds no git calls (LOOP-167)");

    // Cases J–M (LOOP-191): skills/**/*.md and references/**/*.md count as code, not doc-only
    {
      // Seed hub/package.json in the test repo (mirrors real hub/package.json files); w18Clone is matchDir
      mkdirSync(join(w18Clone, "hub"), { recursive: true });
      writeFileSync(join(w18Clone, "hub", "package.json"), JSON.stringify({
        name: "@dyzsasd/dev-loop", version: "1.2.3",
        files: ["dist/", "skills/", "references/", "hooks/", "config/", ".claude-plugin/", "postinstall.cjs", "README.md"]
      }));
      gitW18(w18Clone, ["add", "hub/package.json"]);
      gitW18(w18Clone, ["commit", "-qm", "chore: seed hub/package.json for LOOP-191 tests"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const headLoopBase = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      const w18loop191env = { DEVLOOP_W18_PKG_JSON: w18PkgJson, DEVLOOP_HUB_DB: "" };

      // Case J (LOOP-191 AC-2): skills/**/*.md commit → W18 fires (packaged behavior, not doc-only)
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headLoopBase]);
      mkdirSync(join(w18Clone, "skills", "pm-agent"), { recursive: true });
      writeFileSync(join(w18Clone, "skills", "pm-agent", "SKILL.md"), "# PM agent skill\n");
      gitW18(w18Clone, ["add", "skills/pm-agent/SKILL.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs(governing): update pm skill"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18skills = run("server", ["doctor"], { cwd: w18Root, extra: w18loop191env });
      ok(/\[W18\]/.test(w18skills.out), "W18 fires when only commit changes skills/**/*.md (LOOP-191 AC-2)");
      ok(/1 code commit/.test(w18skills.out), "skills/**/*.md counts as a code commit (LOOP-191 AC-2)");
      ok(/DOCTOR_OK/.test(w18skills.out), "DOCTOR_OK holds for skills-only commit (LOOP-191)");

      // Case K (LOOP-191 AC-1): references/**/*.md commit → W18 fires
      const headJ = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headJ]);
      mkdirSync(join(w18Clone, "references"), { recursive: true });
      writeFileSync(join(w18Clone, "references", "conventions.md"), "# conventions\n");
      gitW18(w18Clone, ["add", "references/conventions.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs(governing): update conventions"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18refs = run("server", ["doctor"], { cwd: w18Root, extra: w18loop191env });
      ok(/\[W18\]/.test(w18refs.out), "W18 fires when only commit changes references/**/*.md (LOOP-191 AC-1)");
      ok(/1 code commit/.test(w18refs.out), "references/**/*.md counts as a code commit (LOOP-191 AC-1)");
      ok(/DOCTOR_OK/.test(w18refs.out), "DOCTOR_OK holds for references-only commit (LOOP-191)");

      // Case L (LOOP-191 AC-3 preserved): docs/** stays silent even with hub/package.json present
      const headK = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headK]);
      writeFileSync(join(w18Clone, "docs", "loop191.md"), "# loop191 doc\n");
      gitW18(w18Clone, ["add", "docs/loop191.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: loop191 doc-only test"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18docOnlyPost191 = run("server", ["doctor"], { cwd: w18Root, extra: w18loop191env });
      ok(!/\[W18\]/.test(w18docOnlyPost191.out), "docs-only stays silent with hub/package.json present (LOOP-191 AC-3 preserved)");
      ok(/DOCTOR_OK/.test(w18docOnlyPost191.out), "DOCTOR_OK holds when docs-only after LOOP-191 fix");

      // Case M (LOOP-191 AC-4): skills + docs mixed → 1 code commit, +1 doc-only (skills not in doc count)
      const headL = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", headL]);
      writeFileSync(join(w18Clone, "skills", "pm-agent", "SKILL.md"), "# updated pm skill\n");
      gitW18(w18Clone, ["add", "skills/pm-agent/SKILL.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs(governing): update pm skill again"]);
      writeFileSync(join(w18Clone, "docs", "loop191-extra.md"), "# extra\n");
      gitW18(w18Clone, ["add", "docs/loop191-extra.md"]);
      gitW18(w18Clone, ["commit", "-qm", "docs: extra loop191 doc"]);
      gitW18(w18Clone, ["push", "-qu", "origin", "main"]);
      const w18mixedPost191 = run("server", ["doctor"], { cwd: w18Root, extra: w18loop191env });
      ok(/\[W18\]/.test(w18mixedPost191.out), "W18 fires for skills+docs mixed window (LOOP-191 AC-4)");
      ok(/1 code commit/.test(w18mixedPost191.out), "skills commit counts as code; docs commit is doc-only (LOOP-191 AC-4)");
      ok(/\+1 doc-only/.test(w18mixedPost191.out), "doc-only note is +1 (only docs/); skills/ not counted as doc (LOOP-191 AC-4)");
      ok(/DOCTOR_OK/.test(w18mixedPost191.out), "DOCTOR_OK holds for skills+docs mixed window (LOOP-191)");
    }

    // Cases N-P (LOOP-203): stale tracking ref must not produce an unqualified "no skew" green.
    // State after Cases J-M: tag v1.2.3 at headL; origin/main is 2 commits ahead (1 code, 1 doc).
    {
      const trueHead = spawnSync("git", ["-C", w18Clone, "rev-parse", "origin/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      const tagCommit = spawnSync("git", ["-C", w18Clone, "rev-parse", "refs/tags/v1.2.3^{commit}"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
      const w18loop203env = { DEVLOOP_W18_PKG_JSON: w18PkgJson, DEVLOOP_HUB_DB: "" };

      // Case N (LOOP-203): stale tracking ref (rewound to tag commit) → no unqualified "no skew" ✅.
      // Simulates "last fetched at release": refs/remotes/origin/main points to the tag commit,
      // so behind=0 — but the real origin/main is 2 code commits ahead.
      // Fails on today's code (prints "✅ ... matches origin/main — no skew").
      gitW18(w18Clone, ["update-ref", "refs/remotes/origin/main", tagCommit]);
      const w18stale = run("server", ["doctor"], { cwd: w18Root, extra: w18loop203env });
      ok(!/matches origin\/\S+ — no skew/.test(w18stale.out),
        "stale tracking ref: no unqualified 'matches origin — no skew' ✅ (LOOP-203)");
      ok(/DOCTOR_OK/.test(w18stale.out), "DOCTOR_OK holds with stale tracking ref (LOOP-203)");

      // Case O (LOOP-203): advance ref to true head → W18 fires with honest count, NEXT cut a release.
      // Guards against "fixing" AC-1 by gutting the check entirely.
      gitW18(w18Clone, ["update-ref", "refs/remotes/origin/main", trueHead]);
      const w18advanced = run("server", ["doctor"], { cwd: w18Root, extra: w18loop203env });
      ok(/\[W18\]/.test(w18advanced.out),
        "advancing ref to true head: W18 fires with honest count (LOOP-203)");
      ok(/NEXT:.*cut a release/.test(w18advanced.out),
        "advancing ref to true head: NEXT cut a release still emits (LOOP-203)");
      ok(/DOCTOR_OK/.test(w18advanced.out),
        "DOCTOR_OK holds when ref advanced to true head (LOOP-203)");

      // Case P (LOOP-203): genuinely up-to-date ref (tag moved to tip) → qualified no-skew, no false alarm.
      gitW18(w18Clone, ["tag", "-f", "v1.2.3", trueHead]);
      const w18uptd = run("server", ["doctor"], { cwd: w18Root, extra: w18loop203env });
      ok(!/\[W18\]/.test(w18uptd.out),
        "genuinely up-to-date ref: no W18 warn (no false alarm) (LOOP-203)");
      ok(/no skew/.test(w18uptd.out),
        "genuinely up-to-date ref: qualified no-skew statement present (LOOP-203)");
      ok(/DOCTOR_OK/.test(w18uptd.out),
        "DOCTOR_OK holds for genuinely up-to-date ref (LOOP-203)");
    }
  }

  // ── W20: operator decision-queue stall; DOCTOR_OK stays; NEXT flips to decision (LOOP-74) ──
  // Service backend + hub.db required. Best-effort; never flips DOCTOR_OK.
  {
    // Workspace: service backend, no comms (so no-comms note fires), one project + one repo so NEXT reaches W20
    const w20Root = join(tmp, "w20");
    run("team", ["init", "--dir", w20Root, "--key", "w20-team", "--backend", "service"]);
    run("team", ["add-project", "w20proj"], { cwd: w20Root }); // auto-seeds hub.db row on service backend
    const w20Repo = join(w20Root, "git-repo");
    mkdirSync(w20Repo, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", w20Repo], { stdio: "ignore" });
    spawnSync("git", ["-C", w20Repo, "-c", "user.email=t@t", "-c", "user.name=t",
      "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
    run("team", ["add-repo", "w20repo", "--project", "w20proj", "--path", "git-repo"], { cwd: w20Root });
    run("team", ["set", "team.mode", "live"], { cwd: w20Root });
    const w20Db = join(w20Root, ".dev-loop", "hub.db");

    // Insert two decision-queue items: W20-HB (Human-Blocked, older) + W20-IR (In Review+operator, newer)
    spawnSync("node", ["-e",
      `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('w20proj').id;db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,null,0,'[]','[]','pm','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')").run('W20-HB',pid,'Needs human unblock','Human-Blocked');db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,'operator',0,'[]','[]','pm','2021-01-01T00:00:00.000Z','2021-01-01T00:00:00.000Z')").run('W20-IR',pid,'PR waiting approval','In Review');db.close()})`,
      w20Db
    ], { cwd: hubRoot, env: env(), encoding: "utf8" });

    // Case A (LOOP-74 test-a): non-empty queue, no team.comms → W20 fires + no-comms note, DOCTOR_OK holds, NEXT flips
    const w20a = run("server", ["doctor"], { cwd: w20Root });
    ok(/\[W20\]/.test(w20a.out), "W20 fires when operator decision queue is non-empty (LOOP-74)");
    ok(/2 waiting on you/.test(w20a.out), "W20 names the full queue count (LOOP-74)");
    ok(/W20-HB/.test(w20a.out), "W20 names the oldest item by ID — the Human-Blocked one (LOOP-74)");
    ok(/\(blocked\)/.test(w20a.out), "W20 labels a Human-Blocked ticket as 'blocked' (LOOP-74)");
    ok(/no out-of-band escalation path/.test(w20a.out), "W20 carries no-comms note when team.comms absent (LOOP-74)");
    ok(/DOCTOR_OK/.test(w20a.out), "W20 is warn-only — DOCTOR_OK still holds (LOOP-74)");
    ok(/NEXT:.*rule on the oldest decision.*W20-HB/.test(w20a.out), "NEXT flips to decision hint when queue non-empty (LOOP-74)");

    // Case B (LOOP-74 test-b): empty queue → no W20, DOCTOR_OK holds, NEXT does not mention decision
    spawnSync("node", ["-e",
      `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);db.prepare('DELETE FROM tickets').run();db.close()})`,
      w20Db
    ], { cwd: hubRoot, env: env(), encoding: "utf8" });
    const w20b = run("server", ["doctor"], { cwd: w20Root });
    ok(!/\[W20\]/.test(w20b.out), "no W20 when decision queue is empty (LOOP-74)");
    ok(/DOCTOR_OK/.test(w20b.out), "DOCTOR_OK holds when queue is empty (LOOP-74)");
    ok(!/rule on the oldest decision/.test(w20b.out), "NEXT does not flip to decision hint when queue is empty (LOOP-74)");

    // Case C (LOOP-74 test-c): non-empty queue WITH team.comms → W20 fires WITHOUT no-comms note
    {
      const w20c = join(tmp, "w20c");
      run("team", ["init", "--dir", w20c, "--key", "w20c-team", "--backend", "service", "--comms", "lark"]);
      run("team", ["add-project", "w20proj"], { cwd: w20c });
      const w20cRepo = join(w20c, "git-repo");
      mkdirSync(w20cRepo, { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main", w20cRepo], { stdio: "ignore" });
      spawnSync("git", ["-C", w20cRepo, "-c", "user.email=t@t", "-c", "user.name=t",
        "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
      run("team", ["add-repo", "w20repo", "--project", "w20proj", "--path", "git-repo"], { cwd: w20c });
      run("team", ["set", "team.mode", "live"], { cwd: w20c });
      const w20cDb = join(w20c, ".dev-loop", "hub.db");
      spawnSync("node", ["-e",
        `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('w20proj').id;db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,null,0,'[]','[]','pm','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')").run('W20-C1',pid,'Blocked with comms','Human-Blocked');db.close()})`,
        w20cDb
      ], { cwd: hubRoot, env: env(), encoding: "utf8" });
      const w20c_out = run("server", ["doctor"], { cwd: w20c });
      ok(/\[W20\]/.test(w20c_out.out), "W20 fires when queue non-empty with comms configured (LOOP-74)");
      ok(!/no out-of-band escalation path/.test(w20c_out.out), "no-comms note absent when team.comms IS configured (LOOP-74)");
      ok(/DOCTOR_OK/.test(w20c_out.out), "DOCTOR_OK holds with comms configured (LOOP-74)");
    }

    // Case D (LOOP-207): W20's age + "oldest" ordering come from the into-queue-state TRANSITION event,
    // never tickets.updated_at. Reuses the w20Root workspace (emptied in Case B). Two Human-Blocked items:
    // W20D-OLD entered the queue FIRST (transition 2020-06-01), W20D-NEW entered LATER (2021-06-01). Seed
    // the events rows directly, the way this fixture seeds tickets.
    spawnSync("node", ["-e",
      `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('w20proj').id;const ins=db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'Human-Blocked',null,0,'[]','[]','pm',?,?)");ins.run('W20D-OLD',pid,'Older by entry, bumped by a label repair','2020-06-01T00:00:00.000Z','2020-06-01T00:00:00.000Z');ins.run('W20D-NEW',pid,'Entered the queue later','2021-06-01T00:00:00.000Z','2021-06-01T00:00:00.000Z');const ev=db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES(?,?,'pm','issue.transition',?,?)");ev.run(pid,'W20D-OLD','{"from":"Todo","to":"Human-Blocked"}','2020-06-01T00:00:00.000Z');ev.run(pid,'W20D-NEW','{"from":"Todo","to":"Human-Blocked"}','2021-06-01T00:00:00.000Z');db.close()})`,
      w20Db
    ], { cwd: hubRoot, env: env(), encoding: "utf8" });

    const w20line = (s: string) => (s.split("\n").find((l) => l.includes("[W20]")) ?? "");
    const nextLine = (s: string) => (s.split("\n").find((l) => l.startsWith("NEXT:")) ?? "");

    // State A — control: both a (buggy) updated_at sort and the (correct) transition sort agree the
    // genuinely-older W20D-OLD is oldest, so doctor names it. This is the baseline the relabel must not move.
    const w20dA = run("server", ["doctor"], { cwd: w20Root });
    ok(/oldest W20D-OLD/.test(w20line(w20dA.out)), "W20 names the genuinely-oldest (earliest into-Human-Blocked) item (LOOP-207)");
    ok(/rule on the oldest decision W20D-OLD/.test(nextLine(w20dA.out)), "NEXT names the genuinely-oldest item (LOOP-207)");
    ok(/DOCTOR_OK/.test(w20dA.out), "W20 stays warn-only in Case D (LOOP-207)");

    // The single variable (the ticket's A→B): ONE Sweep-style label repair on the oldest item — it bumps
    // tickets.updated_at to a recent time and changes labels, but adds NO issue.transition (a relabel is not
    // a transition). A tickets.updated_at sort would now flip "oldest" to W20D-NEW; the transition anchor
    // must not. (Do NOT weaken this to a comment: save_comment leaves updated_at untouched and would pass
    // vacuously — the reset comes from save_issue writes: labels/priority/assignee/relatedTo.)
    spawnSync("node", ["-e",
      `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);db.prepare("UPDATE tickets SET labels=?, updated_at=? WHERE id=?").run('["needs-operator"]','2026-08-01T00:00:00.000Z','W20D-OLD');db.close()})`,
      w20Db
    ], { cwd: hubRoot, env: env(), encoding: "utf8" });

    // State B — after the relabel: W20 must STILL name W20D-OLD, and its age must still read in DAYS off the
    // 2020 transition (a buggy age-from-updated_at renders minutes, since updated_at is now recent). This is
    // the fails-before / passes-after arm: the pre-fix code flips both lines to W20D-NEW here.
    const w20dB = run("server", ["doctor"], { cwd: w20Root });
    ok(/oldest W20D-OLD "[^"]*" \d+d \(blocked\)/.test(w20line(w20dB.out)),
      "an unrelated label repair does NOT change WHICH item W20 names, nor reset its age to the bump (LOOP-207)");
    ok(!/oldest W20D-NEW/.test(w20line(w20dB.out)), "W20 does not flip to the later-entered item after a relabel (LOOP-207)");
    ok(/rule on the oldest decision W20D-OLD/.test(nextLine(w20dB.out)), "NEXT stays on the genuinely-oldest item after a relabel (LOOP-207)");
    ok(/2 waiting on you/.test(w20dB.out), "W20 count unchanged by the relabel (LOOP-207)");
    ok(/DOCTOR_OK/.test(w20dB.out), "W20 stays warn-only after the relabel (LOOP-207)");
  }

  // ── W22: landing stall detection; DOCTOR_OK stays; NEXT flips only on stall ──
  // Linear backend: doctorWorkspace IS the whole verdict (no hub.db check follows).
  {
    const nodeDir = dirname(process.execPath); // run() spawns `node` via PATH, so keep node's own dir on it
    const basePath = `${nodeDir}:/usr/bin:/bin`;
    const ghBinDir = join(tmp, "w22-gh-bin");
    mkdirSync(ghBinDir, { recursive: true });

    // Write and overwrite the fake gh binary for each case
    const writeGh = (body: string) => {
      writeFileSync(join(ghBinDir, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };

    // Workspace: linear backend with one qualifying repo (landing:"pr" + autoMerge)
    const w22Root = join(tmp, "w22");
    run("team", ["init", "--dir", w22Root, "--key", "w22-team", "--backend", "linear", "--linear-team", "W22T"]);
    run("team", ["add-project", "core"], { cwd: w22Root });
    // Repo path must exist on disk and be a git work-tree (or doctor fails on E02/W-repo-missing)
    const w22Repo = join(w22Root, "git-repo");
    mkdirSync(w22Repo, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", w22Repo], { stdio: "ignore" });
    spawnSync("git", ["-C", w22Repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
    // --remote provides the github.com URL; readLandingState extracts "fake-org/fake-repo" from it
    run("team", ["add-repo", "testrepo", "--project", "core", "--path", "git-repo",
      "--landing", "pr", "--auto-merge",
      "--remote", "https://github.com/fake-org/fake-repo.git"], { cwd: w22Root });
    // Set mode=live so nextStep reaches the stalledRepo check (dry-run check is higher priority)
    run("team", ["set", "team.mode", "live"], { cwd: w22Root });

    // Case A: stalled — open loop PR older than LANDING_STALL_DAYS, base checks unknown → threshold stall
    writeGh(`
case "$*" in
  *"--state open"*)
    echo '[{"number":1,"headRefName":"dev-loop/LOOP-X","createdAt":"2020-01-01T00:00:00Z","mergeableState":"BLOCKED"}]'
    ;;
  *"--state merged"*)
    echo '[]'
    ;;
  *)
    echo '[]'
    ;;
esac`);
    const w22stall = run("server", ["doctor"], { cwd: w22Root, extra: { PATH: `${ghBinDir}:${basePath}` } });
    ok(/\[W22\]/.test(w22stall.out), "W22 fires when a landing stall is detected");
    ok(/DOCTOR_OK/.test(w22stall.out), "W22 is warn-only — DOCTOR_OK still holds under a stall");
    ok(/NEXT:.*clear the landing stall.*fake-org\/fake-repo/.test(w22stall.out),
      "NEXT flips to clear-the-stall advice naming the stalled repo when W22 fires");

    // Case B: healthy — no open loop PRs
    writeGh(`
case "$*" in
  *"--state open"*)
    echo '[]'
    ;;
  *"--state merged"*)
    echo '[{"headRefName":"dev-loop/LOOP-Y","mergedAt":"2026-07-01T00:00:00Z"}]'
    ;;
  *)
    echo '[]'
    ;;
esac`);
    const w22healthy = run("server", ["doctor"], { cwd: w22Root, extra: { PATH: `${ghBinDir}:${basePath}` } });
    ok(!/\[W22\]/.test(w22healthy.out), "no W22 when landing is healthy (no open loop PRs)");
    ok(/DOCTOR_OK/.test(w22healthy.out), "DOCTOR_OK holds when landing is healthy");
    ok(!/clear the landing stall/.test(w22healthy.out), "NEXT does not flip to stall advice when landing is healthy");

    // Case C: unknown — gh auth failure → info line only, no W22 warn, DOCTOR_OK holds
    writeGh(`echo "gh: Not logged in. Use 'gh auth login' to authenticate." >&2\nexit 1`);
    const w22unknown = run("server", ["doctor"], { cwd: w22Root, extra: { PATH: `${ghBinDir}:${basePath}` } });
    ok(!/\[W22\]/.test(w22unknown.out), "no W22 warn when gh is unreachable (unknown state)");
    ok(/DOCTOR_OK/.test(w22unknown.out), "DOCTOR_OK holds under unknown landing state (gh auth failure)");
    ok(/landing:.*not a failure/.test(w22unknown.out), "unknown state emits an info line tagged 'not a failure'");

    // Case D: DEVLOOP_DOCTOR_NO_FORGE=1 — forge glance skipped, fake gh is NOT invoked
    // We use a gh that exits 1 with a sentinel; if doctor invokes it, the sentinel would appear.
    writeGh(`echo 'UNEXPECTED_GH_CALL' >&2\nexit 1`);
    const w22noForge = run("server", ["doctor"], { cwd: w22Root, extra: {
      PATH: `${ghBinDir}:${basePath}`,
      DEVLOOP_DOCTOR_NO_FORGE: "1",
    }});
    ok(!/UNEXPECTED_GH_CALL/.test(w22noForge.out),
      "DEVLOOP_DOCTOR_NO_FORGE=1: fake gh is NOT invoked — forge glance skipped entirely");
    ok(/DOCTOR_OK/.test(w22noForge.out), "DOCTOR_OK holds when forge glance is skipped via DEVLOOP_DOCTOR_NO_FORGE=1");
    ok(/landing check skipped/.test(w22noForge.out),
      "DEVLOOP_DOCTOR_NO_FORGE=1 emits an info line confirming the skip");

    // Case E: no qualifying repo — forge glance skipped, fake gh is NOT invoked
    const w22NoQual = join(tmp, "w22-noqual");
    run("team", ["init", "--dir", w22NoQual, "--key", "w22-nq", "--backend", "linear", "--linear-team", "NQ"]);
    run("team", ["add-project", "core"], { cwd: w22NoQual });
    const w22NoQualRepo = join(w22NoQual, "git-repo");
    mkdirSync(w22NoQualRepo, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", w22NoQualRepo], { stdio: "ignore" });
    spawnSync("git", ["-C", w22NoQualRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
    // NO --auto-merge → not a qualifying repo → W22 block skips entirely
    run("team", ["add-repo", "repo", "--project", "core", "--path", "git-repo",
      "--landing", "pr",
      "--remote", "https://github.com/fake-org/fake-repo.git"], { cwd: w22NoQual });
    writeGh(`echo 'UNEXPECTED_GH_CALL' >&2\nexit 1`);
    const w22NoQualDoc = run("server", ["doctor"], { cwd: w22NoQual, extra: { PATH: `${ghBinDir}:${basePath}` } });
    ok(!/UNEXPECTED_GH_CALL/.test(w22NoQualDoc.out),
      "no qualifying repo (no autoMerge): forge glance skipped, fake gh is NOT invoked");
    ok(/DOCTOR_OK/.test(w22NoQualDoc.out), "DOCTOR_OK holds with no qualifying repo");
  }

  // ── LOOP-188: §19 defaultBranch chain — W19 and W22 must query the resolved branch, not "main" ──
  // W19 regression: a workspace with team.git.defaultBranch="master" must warn about master ahead of
  // origin/master (not main). W22 regression: the day-0 red-base stall must fire when the resolved
  // branch (master) is red, and the W22 message must name master. Both were unreachable on non-main
  // repos before this fix — rev-list queried origin/main and the forge queried /commits/main/check-runs.
  {
    const nodeDir = dirname(process.execPath);
    const l188BasePath = `${nodeDir}:/usr/bin:/bin`;
    const l188GhBinDir = join(tmp, "l188-gh-bin");
    mkdirSync(l188GhBinDir, { recursive: true });
    const writeL188Gh = (body: string) => {
      writeFileSync(join(l188GhBinDir, "gh"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };

    // W19 with master: local master ahead of origin/master → W19 fires naming master
    const w19MRoot = join(tmp, "w19-master");
    const w19MOrigin = join(tmp, "w19-master-origin.git");
    mkdirSync(w19MOrigin, { recursive: true });
    const gitMaster = (dir: string, args: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    gitMaster(tmp, ["init", "--bare", "-q", "-b", "master", w19MOrigin]);
    run("team", ["init", "--dir", w19MRoot, "--key", "w19m-team", "--backend", "service"]);
    run("team", ["add-project", "core"], { cwd: w19MRoot });
    const w19MClone = join(w19MRoot, "clone");
    spawnSync("git", ["clone", "-q", w19MOrigin, w19MClone], { stdio: ["ignore", "pipe", "pipe"] });
    gitMaster(w19MClone, ["commit", "--allow-empty", "-qm", "baseline"]);
    gitMaster(w19MClone, ["push", "-qu", "origin", "master"]);
    run("team", ["add-repo", "repo", "--project", "core", "--path", "clone", "--landing", "pr", "--auto-merge"], { cwd: w19MRoot });
    run("team", ["set", "team.git.defaultBranch", "master"], { cwd: w19MRoot });
    // Local master 1 commit ahead of origin/master → W19 fires naming master
    gitMaster(w19MClone, ["commit", "--allow-empty", "-qm", "unpushed doc on master"]);
    const w19Mahead = run("server", ["doctor"], { cwd: w19MRoot });
    ok(/\[W19\]/.test(w19Mahead.out), "W19 fires when local master is ahead of origin/master (LOOP-188)");
    ok(/DOCTOR_OK/.test(w19Mahead.out), "W19 is warn-only on master branch (LOOP-188)");
    ok(/master/.test(w19Mahead.out.match(/\[W19\].*/)?.[0] ?? ""), "W19 line names master not main (LOOP-188)");

    // W22 day-0 red-base stall on master: fake gh returns red checks for /commits/master/ only.
    // PR is MERGEABLE and old (threshold stall is suppressed when base is green, so with the wrong
    // branch the unfixed code would see green main → not stalled → W22 silent — the discriminating case).
    const w22MRoot = join(tmp, "w22-master");
    run("team", ["init", "--dir", w22MRoot, "--key", "w22m-team", "--backend", "linear", "--linear-team", "W22M"]);
    run("team", ["add-project", "core"], { cwd: w22MRoot });
    const w22MRepo = join(w22MRoot, "git-repo");
    mkdirSync(w22MRepo, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "master", w22MRepo], { stdio: "ignore" });
    spawnSync("git", ["-C", w22MRepo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
    run("team", ["add-repo", "testrepo", "--project", "core", "--path", "git-repo",
      "--landing", "pr", "--auto-merge", "--merge-check", "Lint",
      "--remote", "https://github.com/fake-org/fake-repo.git"], { cwd: w22MRoot });
    run("team", ["set", "team.git.defaultBranch", "master"], { cwd: w22MRoot });
    run("team", ["set", "team.mode", "live"], { cwd: w22MRoot });
    // Fake gh: red Lint check only for /commits/master/check-runs; green for /commits/main/ (discriminating).
    // PR is MERGEABLE and old (2020) so the threshold stall fires on the BLOCKED-or-not-green axis —
    // but MERGEABLE+green would suppress it, so only the day-0 red path triggers on the correct branch.
    writeL188Gh(`
case "$*" in
  *"/commits/master/check-runs"*)
    echo '{"check_runs":[{"name":"Lint","conclusion":"failure"}]}'
    ;;
  *"/commits/main/check-runs"*)
    echo '{"check_runs":[{"name":"Lint","conclusion":"success"}]}'
    ;;
  *"--state open"*)
    echo '[{"number":1,"headRefName":"dev-loop/LOOP-X","createdAt":"2020-01-01T00:00:00Z","url":"https://github.com/fake-org/fake-repo/pull/1","mergeable":"MERGEABLE"}]'
    ;;
  *"--state merged"*)
    echo '[]'
    ;;
  *)
    exit 1
    ;;
esac`);
    const w22Mstall = run("server", ["doctor"], { cwd: w22MRoot, extra: { PATH: `${l188GhBinDir}:${l188BasePath}` } });
    ok(/\[W22\]/.test(w22Mstall.out), "W22 fires on day-0 red-base stall when defaultBranch=master (LOOP-188)");
    ok(/DOCTOR_OK/.test(w22Mstall.out), "W22 is warn-only on master stall (LOOP-188)");
    ok(/base 'master'/.test(w22Mstall.out), "W22 warn names master not main when team.git.defaultBranch=master (LOOP-188)");
  }

  // ═══ team.budget.{dailyUsd,perFireUsd} config keys (LOOP-226) ═══
  {
    const bws = join(tmp, "budget-ws");
    run("team", ["init", "--dir", bws, "--key", "bgt-team", "--backend", "service"]);

    // dailyUsd round-trip: set a positive number, read it back
    const bdSet = run("team", ["set", "team.budget.dailyUsd", "50"], { cwd: bws });
    ok(bdSet.code === 0, "team set team.budget.dailyUsd 50 exits 0 (AC1)");
    ok(/50/.test(bdSet.out), "team set team.budget.dailyUsd 50 prints the new value");
    const bdCfg = readJson(join(bws, "dev-loop.json"));
    ok(bdCfg.team.budget?.dailyUsd === 50, "dailyUsd=50 round-trips through dev-loop.json (AC1)");

    // dailyUsd null → stored as null (OFF/unset semantics)
    const bdNull = run("team", ["set", "team.budget.dailyUsd", "null"], { cwd: bws });
    ok(bdNull.code === 0, "team set team.budget.dailyUsd null exits 0 (AC1 null/OFF)");
    const bdCfgNull = readJson(join(bws, "dev-loop.json"));
    ok(bdCfgNull.team.budget?.dailyUsd === null, "dailyUsd null round-trips through dev-loop.json (AC1 OFF semantics)");

    // perFireUsd round-trip
    const bpSet = run("team", ["set", "team.budget.perFireUsd", "12"], { cwd: bws });
    ok(bpSet.code === 0, "team set team.budget.perFireUsd 12 exits 0 (AC1)");
    const bpCfg = readJson(join(bws, "dev-loop.json"));
    ok(bpCfg.team.budget?.perFireUsd === 12, "perFireUsd=12 round-trips through dev-loop.json (AC1)");

    // reject negative / zero / NaN for dailyUsd
    ok(run("team", ["set", "team.budget.dailyUsd", "-5"], { cwd: bws }).code !== 0, "dailyUsd negative rejected (AC2)");
    ok(run("team", ["set", "team.budget.dailyUsd", "0"], { cwd: bws }).code !== 0, "dailyUsd zero rejected (AC2)");
    ok(run("team", ["set", "team.budget.dailyUsd", "NaN"], { cwd: bws }).code !== 0, "dailyUsd NaN rejected (AC2)");
    // reject negative / zero / NaN for perFireUsd
    ok(run("team", ["set", "team.budget.perFireUsd", "-1"], { cwd: bws }).code !== 0, "perFireUsd negative rejected (AC2)");
    ok(run("team", ["set", "team.budget.perFireUsd", "0"], { cwd: bws }).code !== 0, "perFireUsd zero rejected (AC2)");
    ok(run("team", ["set", "team.budget.perFireUsd", "NaN"], { cwd: bws }).code !== 0, "perFireUsd NaN rejected (AC2)");
    // LOOP-245: hex/octal/binary numeric literals are rejected for both budget keys (silently accepted before fix)
    ok(run("team", ["set", "team.budget.dailyUsd", "0x10"], { cwd: bws }).code !== 0, "dailyUsd hex literal rejected (LOOP-245)");
    ok(run("team", ["set", "team.budget.dailyUsd", "0o17"], { cwd: bws }).code !== 0, "dailyUsd octal literal rejected (LOOP-245)");
    ok(run("team", ["set", "team.budget.dailyUsd", "0b101"], { cwd: bws }).code !== 0, "dailyUsd binary literal rejected (LOOP-245)");
    ok(run("team", ["set", "team.budget.perFireUsd", "0x64"], { cwd: bws }).code !== 0, "perFireUsd hex literal rejected (LOOP-245)");
    ok(run("team", ["set", "team.budget.perFireUsd", "0o17"], { cwd: bws }).code !== 0, "perFireUsd octal literal rejected (LOOP-245)");
    ok(run("team", ["set", "team.budget.perFireUsd", "0b101"], { cwd: bws }).code !== 0, "perFireUsd binary literal rejected (LOOP-245)");
    // Scientific notation is also rejected (non-plain-decimal; 1e2 would coerce to 100 but is not a plain decimal USD input)
    ok(run("team", ["set", "team.budget.perFireUsd", "1e2"], { cwd: bws }).code !== 0, "perFireUsd scientific notation rejected (LOOP-245)");
    ok(run("team", ["set", "team.budget.dailyUsd", "1e2"], { cwd: bws }).code !== 0, "dailyUsd scientific notation rejected (LOOP-245)");
    // file unchanged after rejections
    const bpCfgAfterRejects = readJson(join(bws, "dev-loop.json"));
    ok(bpCfgAfterRejects.team.budget?.perFireUsd === 12, "dev-loop.json unchanged after rejected set (AC2)");

    // validateTeamFile rejects a hand-broken budget value (E18)
    const { validateTeamFile } = await import(join(hubRoot, "src", "team-config.ts"));
    const bBroken = readJson(join(bws, "dev-loop.json"));
    bBroken.team.budget = { dailyUsd: -99 };
    const bErrs = validateTeamFile(bBroken).errors as { code: string; path: string }[];
    ok(bErrs.some((e) => e.code === "E18" && /dailyUsd/.test(e.path)), "validateTeamFile E18 on negative dailyUsd (hand-broken, AC2)");
    const bBroken2 = readJson(join(bws, "dev-loop.json"));
    bBroken2.team.budget = { perFireUsd: 0 };
    const bErrs2 = validateTeamFile(bBroken2).errors as { code: string; path: string }[];
    ok(bErrs2.some((e) => e.code === "E18" && /perFireUsd/.test(e.path)), "validateTeamFile E18 on zero perFireUsd (hand-broken, AC2)");
  }

  // ═══ LOOP-202: NEXT on DOCTOR_FAILED names the ❌ subject (verdict-blindness fix) ═══
  {
    // Case A: registered repo path missing on disk → ok:false in doctorWorkspace
    const l202Root = join(tmp, "l202-ws");
    run("team", ["init", "--dir", l202Root, "--key", "l202-team", "--backend", "service"]);
    run("team", ["add-project", "core", "--prefix", "L2A"], { cwd: l202Root });
    // add-repo WITHOUT creating the dir → path is registered but missing on disk
    run("team", ["add-repo", "myrepo", "--project", "core", "--path", "myrepo"], { cwd: l202Root });
    run("team", ["set", "team.mode", "live"], { cwd: l202Root });
    const l202a = run("server", ["doctor"], { cwd: l202Root, extra: { DEVLOOP_HUB_DB: "" } });
    ok(/DOCTOR_FAILED/.test(l202a.out), "LOOP-202 A: repo path missing → DOCTOR_FAILED");
    ok(!/NEXT: dev-loop run/.test(l202a.out), "LOOP-202 A: NEXT is not 'dev-loop run' when ok:false (verdict-blindness fix)");
    ok(/NEXT:.*myrepo/.test(l202a.out), "LOOP-202 A: NEXT names the failing repo ref");

    // Case B: §17 gitignore leak (hub.db inside a git repo, not gitignored) → ok:false in runDoctor
    const l202bRoot = join(tmp, "l202b-ws");
    run("team", ["init", "--dir", l202bRoot, "--key", "l202b-team", "--backend", "service"]);
    spawnSync("git", ["init", "-q", l202bRoot], { stdio: "ignore" });
    const l202b = run("server", ["doctor"], { cwd: l202bRoot, extra: { DEVLOOP_HUB_DB: "" } });
    ok(/DOCTOR_FAILED/.test(l202b.out), "LOOP-202 B: gitignore ❌ → DOCTOR_FAILED");
    ok(!/NEXT: dev-loop run/.test(l202b.out), "LOOP-202 B: NEXT is not 'dev-loop run' when hub.db not gitignored");

    // Case C (green control): a fully configured workspace still emits NEXT: dev-loop run
    const l202cRoot = join(tmp, "l202c-ws");
    run("team", ["init", "--dir", l202cRoot, "--key", "l202c-team", "--backend", "service"]);
    run("team", ["add-project", "core", "--prefix", "L2C"], { cwd: l202cRoot });
    run("seed", ["core", "Core", "L2C", join(l202cRoot, ".dev-loop", "hub.db")]);
    mkdirSync(join(l202cRoot, "repo"), { recursive: true });
    spawnSync("git", ["init", "-q", join(l202cRoot, "repo")], { stdio: "ignore" });
    spawnSync("git", ["-C", join(l202cRoot, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
    run("team", ["add-repo", "repo", "--project", "core", "--path", "repo"], { cwd: l202cRoot });
    run("team", ["set", "team.mode", "live"], { cwd: l202cRoot });
    const l202c = run("server", ["doctor"], { cwd: l202cRoot, extra: { DEVLOOP_HUB_DB: "" } });
    ok(/DOCTOR_OK/.test(l202c.out), "LOOP-202 C: healthy workspace → DOCTOR_OK");
    ok(/NEXT: dev-loop run/.test(l202c.out), "LOOP-202 C: NEXT stays 'dev-loop run' on DOCTOR_OK (green control)");
  }

  console.log(fails === 0 ? "\nTEAM_CLI_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
