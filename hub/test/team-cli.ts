// team init / import / repair + doctor workspace checks — integration via the real CLI entry points.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
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

  // ── idempotency + validation refusal ──
  const i2 = run("team", ["init", "--dir", lin, "--key", "lin-team", "--backend", "linear", "--linear-team", "Loop-1"]);
  ok(i2.code === 0 && /already exists/.test(i2.out), "re-init is idempotent (exit 0, no clobber)");
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

  // ── team repair re-registers the index ──
  rmSync(join(HOME, "workspaces.json"), { force: true });
  writeFileSync(join(svc, "dev-loop.json"), JSON.stringify(svcCfg, null, 2)); // restore a valid file
  const rep = run("team", ["repair"], { cwd: svc });
  ok(rep.code === 0 && /REPAIR_OK/.test(rep.out), "team repair exits 0");
  ok(readJson(join(HOME, "workspaces.json"))["svc-team"] === realpathSync(svc), "repair re-registers the workspace index");

  console.log(fails === 0 ? "\nTEAM_CLI_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
