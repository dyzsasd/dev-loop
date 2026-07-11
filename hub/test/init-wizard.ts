// `dev-loop init` wizard (2026-07 review, init P1) — non-TTY --yes must be end-to-end on service
// (valid config, hub rows seeded, permissions provisioned, doctor NEXT = add-repo), resume mode never
// re-inits, and the linear --yes path survives via the E09 warning instead of bricking.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-init-wizard-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { ...process.env, DEVLOOP_HOME: HOME };
  // The wizard resolves everything from --dir; an ambient identity from THIS suite's shell must not leak
  // in. Deletes run BEFORE the extra spread so test 7 can leak an identity DELIBERATELY.
  delete e.DEVLOOP_WORKSPACE; delete e.DEVLOOP_TEAM; delete e.DEVLOOP_PROJECT; delete e.DEVLOOP_HUB_DB;
  return { ...e, ...extra } as Record<string, string>;
};
// input defaults to "" so the child's stdin is a CLOSED pipe (never a TTY, never this suite's stdin).
const run = (args: string[], opts: { extra?: Record<string, string>; input?: string; entry?: string } = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", `${opts.entry ?? "init-wizard"}.ts`), ...args],
    { cwd: tmp, env: env(opts.extra), encoding: "utf8", input: opts.input ?? "" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const hubKeys = (wsDir: string): string[] => {
  const r = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);console.log(JSON.stringify(db.prepare('SELECT key FROM projects ORDER BY key').all().map(r=>r.key)));db.close()})`, join(wsDir, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  try { return JSON.parse(r.stdout.trim()); } catch { return []; }
};

try {
  // ── 1. non-TTY --yes → an end-to-end service workspace ──
  const acme = join(tmp, "acme");
  const r1 = run(["--dir", acme, "--yes"]);
  ok(r1.code === 0, "init --yes exits 0");
  const cfg = readJson(join(acme, "dev-loop.json"));
  ok(cfg.schemaVersion === 2 && cfg.team.backend === "service" && cfg.team.key === "acme", "defaults: service backend, team key from the dir name");
  ok(cfg.team.mode === "dry-run" && cfg.team.autonomy === "guarded" && cfg.team.deployPolicy.prod === "manual" && cfg.team.reports.sink === "files", "init defaults: dry-run / guarded / prod manual / files");
  ok(!!cfg.projects.acme, "--yes creates the default first project");
  const keys = hubKeys(acme);
  ok(keys.includes("_team") && keys.includes("acme"), "hub rows seeded: the _team intake row + the auto-seeded project");
  const st = readJson(join(acme, ".claude", "settings.json"));
  ok(Array.isArray(st.permissions?.allow) && st.permissions.allow.includes("Bash(dev-loop *)"), "the Claude permissions entry is provisioned (D8)");
  ok(/DOCTOR_OK/.test(r1.out), "doctor verdict is OK");
  ok(/NEXT: dev-loop team add-repo/.test(r1.out), "doctor NEXT = add-repo (project exists, no repos yet)");
  ok(/hub start/.test(r1.out) && /127\.0\.0\.1:8787/.test(r1.out), "epilogue names `hub start` + the local board URL");
  ok(/run --once --dry-run/.test(r1.out), "epilogue names the dry-run preview");
  ok(/optional:\s+dev-loop install-claude-plugin/.test(r1.out) && !/Linear MCP/.test(r1.out), "on service the plugin is an OPTIONAL note and no Linear MCP step appears (D8 CLI-first)");

  // ── 2. resume mode: never re-inits, prints NEXT ──
  const before = readFileSync(join(acme, "dev-loop.json"), "utf8");
  const r2 = run(["--dir", acme, "--yes"]);
  ok(r2.code === 0 && /resume mode/.test(r2.out), "re-running init on an existing workspace resumes instead of re-initing");
  ok(/NEXT: /.test(r2.out), "resume prints the doctor NEXT line");
  ok(readFileSync(join(acme, "dev-loop.json"), "utf8") === before, "resume leaves dev-loop.json byte-stable (--yes mutates nothing on resume)");
  const r2b = run(["--dir", acme]); // non-TTY resume WITHOUT --yes: read-only, so no gate applies
  ok(r2b.code === 0 && /NEXT: /.test(r2b.out), "non-TTY resume without --yes still prints NEXT");

  // ── 3. a FRESH non-TTY init without --yes refuses (creating a workspace must be intentional) ──
  const r3 = run(["--dir", join(tmp, "noyes")]);
  ok(r3.code === 2 && /--yes/.test(r3.out) && !existsSync(join(tmp, "noyes", "dev-loop.json")), "fresh non-TTY init without --yes exits 2 and creates nothing");

  // ── 4. linear --yes survives via the E09 warning path ──
  const lin = join(tmp, "lin");
  const r4 = run(["--dir", lin, "--backend", "linear", "--yes"]);
  ok(r4.code === 0, "linear --yes exits 0 (E09 deferral, not a brick)");
  const linCfg = readJson(join(lin, "dev-loop.json"));
  ok(linCfg.team.backend === "linear" && !(linCfg.team.linearTeam ?? "").trim(), "linear --yes leaves linearTeam blank to fill later");
  ok(/E09/.test(r4.out) && /DOCTOR_OK/.test(r4.out), "doctor reports E09 as a warning with an OK verdict");
  ok(/NEXT: dev-loop team set team\.linearTeam/.test(r4.out), "NEXT points at filling team.linearTeam");
  ok(Object.keys(linCfg.projects).length === 0, "--yes creates no placeholder project on linear (backend onboarding owns it)");
  ok(/Linear MCP/.test(r4.out) && /install-claude-plugin/.test(r4.out), "the plugin/MCP steps live in the linear epilogue");

  // ── 5. the interactive flow (forced via DEVLOOP_INIT_INTERACTIVE; prompts driven over the pipe) ──
  // Answers: team key (Enter=default) · backend (Enter=service) · create project? (Enter=yes) ·
  // project key (Enter=default) · repo path (Enter=skip). Surplus newlines are harmless; a closed
  // stdin mid-question falls back to the default instead of hanging.
  const inter = join(tmp, "inter");
  const r5 = run(["--dir", inter], { extra: { DEVLOOP_INIT_INTERACTIVE: "1" }, input: "\n".repeat(8) });
  ok(r5.code === 0, "interactive init (piped defaults) exits 0");
  const icfg = readJson(join(inter, "dev-loop.json"));
  ok(icfg.team.key === "inter" && !!icfg.projects.inter, "interactive Enter-through accepts the defaults (team key + first project)");
  ok(hubKeys(inter).includes("inter"), "the interactively created project is auto-seeded in hub.db");
  ok(/NEXT: dev-loop team add-repo/.test(r5.out), "the interactive run ends on the add-repo NEXT");

  // ── 5b. interactive with TYPED answers — the dropped-line regression: a piped stdin delivers every
  // line in one chunk, and readline emits the buffered lines BETWEEN two prompts; rl.question() would
  // silently discard them (the Enter-through case above can't catch that, defaults mask it).
  const typed = join(tmp, "typed");
  const r5b = run(["--dir", typed], { extra: { DEVLOOP_INIT_INTERACTIVE: "1" }, input: "widgets\nlinear\nAcme Team\nn\n" });
  ok(r5b.code === 0, "interactive init with typed answers exits 0");
  const tcfg = readJson(join(typed, "dev-loop.json"));
  ok(tcfg.team.key === "widgets" && tcfg.team.backend === "linear" && tcfg.team.linearTeam === "Acme Team",
    "every typed answer lands on its own question (key, backend, linear team — nothing dropped between prompts)");
  ok(Object.keys(tcfg.projects).length === 0, "answering 'n' declines the first-project offer");

  // ── 5c. the interactive repo offer COMPOSES `add-repo --detect` — a pre-existing repo dir with a
  // package.json must land registered with detected build gates (the skip path above never runs it).
  // Answers: key (Enter) · backend (Enter) · create project? (Enter=yes) · project key (Enter) · repo
  // path ("app" — exists, so no clone prompt).
  const withrepo = join(tmp, "withrepo");
  mkdirSync(join(withrepo, "app"), { recursive: true });
  writeFileSync(join(withrepo, "app", "package.json"), JSON.stringify({ name: "app", scripts: { typecheck: "tsc --noEmit", build: "vite build" } }));
  const r5c = run(["--dir", withrepo], { extra: { DEVLOOP_INIT_INTERACTIVE: "1" }, input: "\n\n\n\napp\n" });
  ok(r5c.code === 0, "interactive init with a repo answer exits 0");
  const rcfg = readJson(join(withrepo, "dev-loop.json"));
  ok(rcfg.repos.app?.path === "app" && rcfg.repos.app?.landing === "pr", "the offered repo is registered (path, landing:pr default)");
  ok(rcfg.repos.app?.build?.typecheck === "npm run typecheck" && rcfg.repos.app?.build?.build === "npm run build",
    "--detect mapped the package.json typecheck/build scripts to runner commands");
  ok((rcfg.projects.withrepo?.repos ?? []).some((r: { ref: string }) => r.ref === "app"), "the repo is referenced by the first project");
  ok(/detected \(deterministic, no LLM\)/.test(r5c.out), "the add-repo --detect report is printed");
  ok(/NEXT: dev-loop team set team\.mode live/.test(r5c.out), "with a project + repo wired, NEXT is the dry-run→live flip");

  // ── 6. the cli.ts route ──
  const r6 = run(["init", "--dir", join(tmp, "viacli"), "--yes"], { entry: "cli" });
  ok(r6.code === 0 && /DOCTOR_OK/.test(r6.out), "`dev-loop init` routes through cli.ts");

  // ── 7. a leaked shell identity must neither hijack nor crash the wizard — DEVLOOP_TEAM is outranked
  // by the wizard's own DEVLOOP_WORKSPACE pin, and a junk DEVLOOP_HUB_DB (the pathEnv 'undefined'
  // tripwire) reached hubDbPath() in the epilogue and aborted AFTER everything was written (Codex
  // review 2026-07-11). The wizard now drops both before composing.
  const leak = join(tmp, "leak");
  const r7 = run(["--dir", leak, "--yes"], { extra: { DEVLOOP_TEAM: "some-other-team", DEVLOOP_HUB_DB: join(tmp, "undefined", "hub.db") } });
  ok(r7.code === 0 && /DOCTOR_OK/.test(r7.out), "init --yes survives a leaked DEVLOOP_TEAM + junk DEVLOOP_HUB_DB");
  ok(r7.out.includes(join(leak, ".dev-loop", "hub.db")), "doctor checked THIS workspace's hub.db, not the leaked path");
  ok(hubKeys(leak).includes("leak"), "the auto-seeded project row landed in the workspace db despite the leak");

  console.log(fails === 0 ? "\nINIT_WIZARD_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
