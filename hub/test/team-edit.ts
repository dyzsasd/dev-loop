// team-edit — `team set` whitelist, E09 tolerance (init --yes → repair → add-project), add-project
// auto-seed (service), add-repo --detect (deterministic, no LLM), the workspace fingerprint stamp
// (mock Linear, no live calls), and the doctor NEXT line across staged workspace states.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectRepoFacts, workflowJobNames } from "../src/team-edit.ts";
import { openDb } from "../src/db.ts";
import { confirmationToken, isScratchProject, isolationVerdict, TOKEN_PREFIX, commitBothHalves } from "../src/destructive-guard.ts";
import type { Workspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-team-edit-")));
const HOME = join(tmp, "home");
// scrubFireEnv, NOT ...process.env: inside an agent fire the environment carries
// DEVLOOP_WORKSPACE=<production workspace>, and workspace resolution prefers that env var over
// the cwd walk-up — so every mutator spawn here (add-project 'a.p.p'/'app'/'clash'/'real-one',
// team set, remove-project) wrote to the PRODUCTION dev-loop.json when this suite ran inside a
// fire (2026-08-04). Scrubbing restores the cwd-based resolution every fixture in this file
// was written against; CI has none of these vars, so CI behavior is byte-identical.
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra });
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
  // The doc pointer moved to the no-writer class (LOOP-135). `team.key` is genuinely create-time
  // only, so it now gets that answer instead — the assertion still proves the path is refused with
  // guidance, and the guidance is no longer "edit dev-loop.json directly".
  ok(badPath.code === 2 && /not an operator-settable path/.test(badPath.out) && /create-time only/.test(badPath.out),
    "team set rejects a non-whitelisted path and says why it cannot be changed");
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

  // ═══ add-repo existing-ref guard (LOOP-134) ═══
  // Re-running add-repo on an already-registered ref with field flags must refuse loudly.
  // This test would PASS against today's (pre-fix) code because the flags are silently dropped
  // and the command exits 0 — it pins team-edit.ts:322 (the else-if(o.owner) block).
  {
    const cfgBefore = readJson(join(lin, "dev-loop.json"));
    const rerun = run("team", ["add-repo", "webr", "--project", "web", "--landing", "direct", "--merge-check", "Brand New Check", "--test-cmd", "npm run something-else"], { cwd: lin });
    ok(rerun.code !== 0 && /already registered/.test(rerun.out) && /dev-loop team set/.test(rerun.out),
      "add-repo on an existing ref with field flags refuses non-zero and names the route (LOOP-134)");
    const cfgAfter = readJson(join(lin, "dev-loop.json"));
    ok(JSON.stringify(cfgBefore) === JSON.stringify(cfgAfter),
      "refused add-repo leaves dev-loop.json byte-identical (field flags were not applied)");

    // --owner is the one update-in-place exception: it works on an existing ref
    const ownerUpd = run("team", ["add-repo", "webr", "--project", "web", "--owner", "web"], { cwd: lin });
    ok(ownerUpd.code === 0 && readJson(join(lin, "dev-loop.json")).repos.webr.owner === "web",
      "add-repo --owner updates an existing repo's owner in place (the one update-in-place field)");

    // shared-repo re-registration (no field flags, just --project) still succeeds
    run("team", ["add-project", "web2", "--linear-project", "Web2"], { cwd: lin });
    const shared = run("team", ["add-repo", "webr", "--project", "web2"], { cwd: lin });
    ok(shared.code === 0 && /now shared by/.test(shared.out),
      "add-repo re-registration under a second project (no field flags) succeeds — the shared-repo flow");
  }

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
  // LOOP-301 flipped this contract deliberately: the clash is now caught BEFORE the config write,
  // so the old "config already written, seed it by hand" outcome is exactly the defect that was
  // fixed. What must still hold is that the clash is refused and named.
  const a3 = run("team", ["add-project", "clash", "--prefix", "APP"], { cwd: svc });
  ok(a3.code !== 0 && /already held by project 'a\.p\.p'/.test(a3.out),
    "an EXPLICIT clashing --prefix is refused and names the holder");
  ok(readJson(join(svc, "dev-loop.json")).projects.clash === undefined,
    "LOOP-301: the clashing add-project left NO project behind in dev-loop.json");

  // doctor's W08 NEXT rung still works — staged deliberately now (a config project with no hub row)
  // rather than harvested from the bug above.
  const svcCfg = readJson(join(svc, "dev-loop.json"));
  svcCfg.projects.clash = { repos: [] };
  writeFileSync(join(svc, "dev-loop.json"), JSON.stringify(svcCfg, null, 2) + "\n");
  const dSvc = run("server", ["doctor"], { cwd: svc });
  ok(/NEXT: dev-loop seed clash/.test(dSvc.out), "doctor NEXT picks up an unseeded config project (W08)");

  // ═══ add-project --scratch: marker + hub.db mirror + count exclusion (LOOP-220) ═══
  const scr = join(tmp, "scr");
  run("team", ["init", "--dir", scr, "--key", "scr-team", "--backend", "service"]);
  // add a scratch project and confirm config + hub row
  const scrAdd = run("team", ["add-project", "fixture", "--scratch"], { cwd: scr });
  ok(scrAdd.code === 0, "--scratch add-project exits 0");
  const scrJson = readJson(join(scr, "dev-loop.json"));
  ok(scrJson.projects.fixture?.scratch === true, "scratch:true written to dev-loop.json config (AC1)");
  const scrDbRows = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const r=db.prepare('SELECT settings_json FROM projects WHERE key=?').get('fixture');console.log(r?JSON.parse(r.settings_json).scratch:null);db.close()})`, join(scr, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/true/.test(scrDbRows.stdout.trim()), "settings_json.scratch=true written to hub.db row (AC1)");
  // doctor: no W01 for scratch project, and project count excludes it
  // Clear DEVLOOP_HUB_DB so the doctor uses the test workspace's hub.db, not the live fire's db.
  const scrDoctor = run("server", ["doctor"], { cwd: scr, extra: { DEVLOOP_HUB_DB: "" } });
  ok(!/W01.*fixture/.test(scrDoctor.out), "doctor produces no W01 warning for scratch project (AC2)");
  ok(/projects=1/.test(scrDoctor.out), "doctor hub.db project count excludes scratch project (counts only _team) (AC2)");
  ok(/0 repos, 0 projects/.test(scrDoctor.out), "doctor config count excludes scratch project (AC2)");
  // discriminator: add an unmarked zero-repo project and confirm W01 still fires
  run("team", ["add-project", "real-new"], { cwd: scr });
  const scrDoctor2 = run("server", ["doctor"], { cwd: scr, extra: { DEVLOOP_HUB_DB: "" } });
  ok(/W01.*real-new/.test(scrDoctor2.out), "W01 still fires for unmarked zero-repo project (AC3 discriminator)");

  // ═══ remove-project mutator (LOOP-221 Child B) ═══
  // Workspace: reuse `scr` (service backend; has 'fixture' scratch 0/0 project + 'real-new' 0/0 unmarked).
  // AC1: remove-project drops a 0-ticket/0-repo project from config + hub.db
  const rmOk = run("team", ["remove-project", "fixture"], { cwd: scr, extra: { DEVLOOP_HUB_DB: "" } });
  ok(rmOk.code === 0, "LOOP-221 AC1: remove-project exits 0 for 0-ticket/0-repo scratch project");
  const rmJson = readJson(join(scr, "dev-loop.json"));
  ok(!("fixture" in rmJson.projects), "LOOP-221 AC1: 'fixture' removed from dev-loop.json config");
  // Check hub.db row gone (inline SQLite query)
  const rmDbChk = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const r=db.prepare('SELECT id FROM projects WHERE key=?').get('fixture');console.log(r?'found':'gone');db.close()})`, join(scr, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/gone/.test(rmDbChk.stdout), "LOOP-221 AC1: 'fixture' hub.db row deleted");

  // AC1: refuse _team / reserved keys
  const rmTeam = run("team", ["remove-project", "_team"], { cwd: scr, extra: { DEVLOOP_HUB_DB: "" } });
  ok(rmTeam.code !== 0, "LOOP-221 AC1: remove-project refuses _team key");

  // AC1: refuse a project with repos (real-new has 0 repos but let's add one first via config)
  // Easier: create a fresh workspace with a project that has repos in config
  const rmWs = join(tmp, "rm-ws");
  run("team", ["init", "--dir", rmWs, "--key", "rm-team", "--backend", "service"]);
  run("team", ["add-project", "proj-with-repo"], { cwd: rmWs });
  // Manually add a repo to the config to trigger the repo-guard (no actual git repo needed for this guard)
  const rmCfg = readJson(join(rmWs, "dev-loop.json"));
  rmCfg.repos["some-repo"] = { path: "irrelevant" };  // register so config validates (LOOP-299)
  rmCfg.projects["proj-with-repo"].repos = [{ ref: "some-repo" }];
  writeFileSync(join(rmWs, "dev-loop.json"), JSON.stringify(rmCfg, null, 2) + "\n");
  // LOOP-305: 'proj-with-repo' is not scratch, so the isolation gate now fires FIRST. The token is added so
  // this arm keeps pinning the REPO guard (what it exists for) rather than passing on the isolation refusal.
  const rmRefused = run("team", ["remove-project", "proj-with-repo", "--i-understand-this-deletes-proj-with-repo"], { cwd: rmWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(rmRefused.code !== 0 && /has 1 repo\(s\) — pass --force/.test(rmRefused.out), 'LOOP-221 AC1/LOOP-299: refuses project with repos without --force (guard message)');
  // LOOP-281 AC2: the same guard in the OTHER direction. Only the refusal was pinned, so a repo guard that
  // refused unconditionally — ignoring --force entirely — passed the whole suite. The token rides along
  // because 'proj-with-repo' is not scratch and the two flags answer different questions (LOOP-305).
  const rmForced = run("team", ["remove-project", "proj-with-repo", "--force", "--i-understand-this-deletes-proj-with-repo"], { cwd: rmWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(rmForced.code === 0, `LOOP-281 AC2: --force bypasses the repo guard (got ${rmForced.code}: ${rmForced.out.replace(/\n/g, " | ").slice(0, 200)})`);
  ok(!("proj-with-repo" in readJson(join(rmWs, "dev-loop.json")).projects),
    "LOOP-281 AC2: 'proj-with-repo' gone from config after the --force bypass");

  // AC1: db-only key (key in hub but absent from config)
  const dbOnlyWs = join(tmp, "db-only-ws");
  run("team", ["init", "--dir", dbOnlyWs, "--key", "dbonly-team", "--backend", "service"]);
  run("team", ["add-project", "ghost"], { cwd: dbOnlyWs });
  // Remove from config manually but leave hub.db row
  const dbOnlyCfg = readJson(join(dbOnlyWs, "dev-loop.json"));
  delete dbOnlyCfg.projects.ghost;
  writeFileSync(join(dbOnlyWs, "dev-loop.json"), JSON.stringify(dbOnlyCfg, null, 2) + "\n");
  // LOOP-305: a db-only key reads as NON-scratch (config is the gate's only authority — fail closed), so the
  // token is required here too. That is the intended reading for a target whose config record is already gone.
  const dbOnlyRm = run("team", ["remove-project", "ghost", "--i-understand-this-deletes-ghost"], { cwd: dbOnlyWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(dbOnlyRm.code === 0, "LOOP-221 AC1: remove-project exits 0 for db-only key");
  ok(/db-only/.test(dbOnlyRm.out), "LOOP-221 AC1: remove-project notes the key was db-only");
  const dbOnlyChk = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const r=db.prepare('SELECT id FROM projects WHERE key=?').get('ghost');console.log(r?'found':'gone');db.close()})`, join(dbOnlyWs, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/gone/.test(dbOnlyChk.stdout), "LOOP-221 AC1: db-only 'ghost' hub.db row deleted");

  // ═══ remove-project --dry-run + unknown-flag rejection (LOOP-290 / LOOP-286 six ACs) ═══
  // The fixture deliberately trips BOTH guards (≥1 ticket AND ≥1 repo) so a preview has something real
  // to refuse, and so the zero-mutation assertions are meaningful — this is a project the live command
  // would cascade-delete.
  const dryWs = join(tmp, "dryrun-ws");
  run("team", ["init", "--dir", dryWs, "--key", "dry-team", "--backend", "service"]);
  run("team", ["add-project", "preview-me"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  const dryCfg0 = readJson(join(dryWs, "dev-loop.json"));
  // The repo must be REGISTERED, not just referenced: resolveWorkspace() re-validates the whole file, so a
  // dangling ref dies [E04] before removeProject ever runs — the command would then be refusing for a
  // config-validation reason, not because its repo guard fired. (A registry entry needs only a valid
  // workspace-relative path; no git repo is required for this guard, which reads the array length.)
  dryCfg0.repos = { ...(dryCfg0.repos ?? {}), "preview-repo": { path: "preview-repo" } };
  dryCfg0.projects["preview-me"].repos = [{ ref: "preview-repo" }];
  writeFileSync(join(dryWs, "dev-loop.json"), JSON.stringify(dryCfg0, null, 2) + "\n");
  const dryDb = join(dryWs, ".dev-loop", "hub.db");
  spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('preview-me')?.id;if(pid)for(const i of [1,2])db.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,created_by,created_at,updated_at)VALUES(?,?,'t','Bug','Todo',0,'[]','test','2026-01-01','2026-01-01')").run('dry-t'+i,pid);db.close()})`, dryDb], { cwd: hubRoot, env: env(), encoding: "utf8" });
  // The zero-mutation oracle: config project keys + hub.db projects/tickets row counts.
  const dbCounts = (p: string) => spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const o={p:db.prepare('SELECT count(*) c FROM projects').get().c,t:db.prepare('SELECT count(*) c FROM tickets').get().c};console.log(JSON.stringify(o));db.close()})`, p], { cwd: hubRoot, env: env(), encoding: "utf8" }).stdout.trim();
  const cfgKeys = (p: string) => JSON.stringify(Object.keys(readJson(p).projects ?? {}).sort());
  const dryCfgPath = join(dryWs, "dev-loop.json");
  const before = { cfg: cfgKeys(dryCfgPath), db: dbCounts(dryDb) };
  ok(/"t":2/.test(before.db), `LOOP-290: fixture seeded — the guard has something to refuse (${before.db})`);

  // AC1: --dry-run reports and mutates nothing
  const dr1 = run("team", ["remove-project", "preview-me", "--dry-run"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(dr1.code === 0, `LOOP-290 AC1: remove-project --dry-run exits 0 (got ${dr1.code}: ${dr1.out.slice(0, 200)})`);
  ok(/dry-run: remove-project 'preview-me' would:/.test(dr1.out), "LOOP-290 AC1: preview names the target and speaks in 'would'");
  ok(/config\s*: present/.test(dr1.out) && /2 ticket\(s\)/.test(dr1.out) && /repos\s*: 1/.test(dr1.out),
    `LOOP-290 AC1: preview reports config presence + ticket count + repo count (got: ${dr1.out.replace(/\n/g, " | ").slice(0, 300)})`);
  ok(/WOULD REFUSE/.test(dr1.out) && /needs --force/.test(dr1.out), "LOOP-290 AC1: preview reports that the guard WOULD REFUSE");
  ok(/REMOVE_PROJECT_DRYRUN_OK/.test(dr1.out), "LOOP-290 AC1: the dry-run sentinel is printed (mirrors REPAIR_DRYRUN_OK)");
  ok(cfgKeys(dryCfgPath) === before.cfg && dbCounts(dryDb) === before.db,
    `LOOP-290 AC1+AC5: --dry-run mutated NOTHING — config keys and hub.db projects/tickets counts identical (${before.db} → ${dbCounts(dryDb)})`);

  // AC2: --dry-run --force previews the force path, still zero mutation
  // LOOP-305: the token is added so this arm still reaches WOULD PROCEED and keeps pinning that the preview
  // NAMES what --force is overriding. Without it the isolation gate would (correctly) refuse — which is a
  // different behaviour, pinned by its own arm below.
  const dr2 = run("team", ["remove-project", "preview-me", "--dry-run", "--force", "--i-understand-this-deletes-preview-me"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(dr2.code === 0 && /WOULD PROCEED/.test(dr2.out),
    `LOOP-290 AC2: --dry-run --force previews the FORCE path as WOULD PROCEED (got ${dr2.code}: ${dr2.out.replace(/\n/g, " | ").slice(0, 300)})`);
  ok(/--force overrides: 2 ticket\(s\)/.test(dr2.out), "LOOP-290 AC2: the preview still names what --force is overriding");
  ok(cfgKeys(dryCfgPath) === before.cfg && dbCounts(dryDb) === before.db,
    `LOOP-290 AC2+AC5: --dry-run --force mutated NOTHING (${before.db} → ${dbCounts(dryDb)})`);

  // AC6: a typo one keystroke from the real flag must NOT fall through to the live cascade.
  for (const bad of ["--dryrun", "--dry_run", "--forse"]) {
    const t = run("team", ["remove-project", "preview-me", bad], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
    ok(t.code !== 0 && /unknown option/.test(t.out),
      `LOOP-290 AC6: '${bad}' is rejected as an unknown option, not silently ignored (got ${t.code})`);
    ok(cfgKeys(dryCfgPath) === before.cfg && dbCounts(dryDb) === before.db,
      `LOOP-290 AC6: '${bad}' mutated nothing`);
  }

  // Preservation: a dry-run errors exactly where the live command errors (checks precede the branch).
  ok(run("team", ["remove-project", "_team", "--dry-run"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } }).code !== 0,
    "LOOP-290: --dry-run of a reserved key still errors (reserved check precedes the dry-run branch)");
  ok(run("team", ["remove-project", "no-such-proj", "--dry-run"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } }).code !== 0,
    "LOOP-290: --dry-run of an unknown key still errors (not-found check precedes the dry-run branch)");

  // AC3: without --dry-run behaviour is unchanged — the guard still refuses, then --force still deletes.
  // LOOP-305: token added to both — these two arms pin the ticket-count guard and the --force override,
  // and must keep reaching them now that the isolation gate stands in front.
  const liveRefuse = run("team", ["remove-project", "preview-me", "--i-understand-this-deletes-preview-me"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(liveRefuse.code !== 0 && /2 ticket\(s\)/.test(liveRefuse.out),
    `LOOP-290 AC3: live path unchanged — still refuses with the same ticket-count message (got ${liveRefuse.code})`);
  ok(cfgKeys(dryCfgPath) === before.cfg && dbCounts(dryDb) === before.db, "LOOP-290 AC3: a refused live run mutates nothing either");
  const liveForce = run("team", ["remove-project", "preview-me", "--force", "--i-understand-this-deletes-preview-me"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(liveForce.code === 0, `LOOP-290 AC3: live --force still executes the removal (got ${liveForce.code}: ${liveForce.out.slice(0, 200)})`);
  // This is what makes every zero-mutation assertion above meaningful: the same command WITHOUT --dry-run
  // really does destroy this fixture, so "counts identical" was not vacuously true.
  ok(cfgKeys(dryCfgPath) !== before.cfg && dbCounts(dryDb) !== before.db,
    `LOOP-290 AC3: the live cascade DID mutate — the dry-run's zero-mutation proof is not vacuous (${before.db} → ${dbCounts(dryDb)})`);

  // The REPO guard on its own (zero tickets, one repo). Covered explicitly because this diff rewrote that
  // guard's expression from `inConfig && (repos ?? []).length > 0` to the hoisted `repoCount > 0`, and the
  // pre-existing LOOP-221 case for it asserts only `code !== 0 && /repo/` against a workspace whose repo ref
  // is unregistered — so it passes on the [E04] config-validation error and never reaches the guard at all.
  run("team", ["add-project", "repo-only"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  const roCfg = readJson(dryCfgPath);
  roCfg.repos = { ...(roCfg.repos ?? {}), "ro-repo": { path: "ro-repo" } };
  roCfg.projects["repo-only"].repos = [{ ref: "ro-repo" }];
  writeFileSync(dryCfgPath, JSON.stringify(roCfg, null, 2) + "\n");
  const roBefore = { cfg: cfgKeys(dryCfgPath), db: dbCounts(dryDb) };
  // LOOP-305: token added so the repo guard really is previewed/enforced ON ITS OWN — without it the
  // isolation refusal would also be in the output and the arm would no longer isolate what it names.
  const roDry = run("team", ["remove-project", "repo-only", "--dry-run", "--i-understand-this-deletes-repo-only"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(roDry.code === 0 && /repos\s*: 1/.test(roDry.out) && /WOULD REFUSE \(1 repo\(s\)/.test(roDry.out),
    `LOOP-290: the repo guard is previewed on its own — 0 tickets, 1 repo → WOULD REFUSE (1 repo(s)) (got: ${roDry.out.replace(/\n/g, " | ").slice(0, 300)})`);
  ok(!/needs --i-understand-this-deletes/.test(roDry.out),
    "LOOP-305: with the token supplied the preview reports ONLY the repo guard — no stale 'needs <token>' line");
  const roLive = run("team", ["remove-project", "repo-only", "--i-understand-this-deletes-repo-only"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(roLive.code !== 0 && /has 1 repo\(s\) — pass --force/.test(roLive.out),
    `LOOP-290: the LIVE repo guard still refuses with its original message (got ${roLive.code}: ${roLive.out.replace(/\n/g, " | ").slice(0, 200)})`);
  ok(cfgKeys(dryCfgPath) === roBefore.cfg && dbCounts(dryDb) === roBefore.db, "LOOP-290: neither the repo-guard preview nor its refusal mutated anything");

  // AC4: usage/help documents --dry-run
  const rmUsage = run("team", ["remove-project"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(rmUsage.code !== 0 && /--dry-run/.test(rmUsage.out), "LOOP-290 AC4: the usage string documents --dry-run");
  ok(/--dry-run/.test(run("team", ["--help"], { cwd: dryWs, extra: { DEVLOOP_HUB_DB: "" } }).out),
    "LOOP-290 AC4: `team --help` documents --dry-run for remove-project");

  // ═══ LOOP-305 (LOOP-302 ①): the isolation gate — a naming token, not --force ═══
  // The 2026-08-04 incident: `--force` was added to get past the recoverability guard's refusal and
  // cascade-deleted 301 live tickets. `--force` answers "is this recoverable?"; nobody was ever asked
  // "did you mean THIS project?". These arms pin the second question, and — via the scratch arm — pin that
  // the answer is a GATE and not a blanket refusal.

  // (a) unit: the three exports, on a hand-built Workspace (no fs, the module is pure).
  const wsOf = (projects: Record<string, { scratch?: boolean }>) =>
    ({ file: { projects } } as unknown as Workspace);
  ok(confirmationToken("loop") === "--i-understand-this-deletes-loop",
    "LOOP-305 AC1: confirmationToken embeds the target key, so a runbook copy-paste cannot name another project");
  ok(isScratchProject(wsOf({ s: { scratch: true } }), "s") === true
    && isScratchProject(wsOf({ s: {} }), "s") === false,
    "LOOP-305 AC1: isScratchProject reads projects.<key>.scratch === true from CONFIG");
  ok(isScratchProject(wsOf({ other: { scratch: true } }), "dbonly") === false,
    "LOOP-305 AC1: a key ABSENT from config (db-only) reads as NON-scratch — fail closed");
  const vNon = isolationVerdict(wsOf({ p: {} }), "p", ["--force"]);
  ok(vNon.refusal !== null && vNon.scratch === false && vNon.tokenPresent === false,
    "LOOP-305 AC2: --force alone does NOT satisfy the isolation gate");
  ok(/--i-understand-this-deletes-p/.test(vNon.refusal ?? "") && /--force does NOT grant this/.test(vNon.refusal ?? ""),
    "LOOP-305 AC2: the refusal names the required token AND states that --force does not grant it");
  ok(isolationVerdict(wsOf({ p: {} }), "p", [confirmationToken("p")]).refusal === null,
    "LOOP-305 AC3: the exact token allows a non-scratch target");
  ok(isolationVerdict(wsOf({ p: { scratch: true } }), "p", []).refusal === null,
    "LOOP-305 AC3 discriminator: a scratch project needs NO token — the gate is not 'refuse everything'");
  // The startsWith trap, at the unit level: a token that merely BEGINS with the required one is not it.
  ok(isolationVerdict(wsOf({ p: {} }), "p", [`${TOKEN_PREFIX}p-and-more`, `${TOKEN_PREFIX}anything`]).refusal !== null,
    "LOOP-305 AC4: tokenPresent is an EXACT argv match — a prefix-shaped lookalike does not satisfy the gate");

  // (b) end-to-end, on a fixture that trips BOTH guards (2 tickets + 1 repo) so 'both reasons' is real.
  const isoWs = join(tmp, "iso-ws");
  run("team", ["init", "--dir", isoWs, "--key", "iso-team", "--backend", "service"]);
  run("team", ["add-project", "real-one"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  run("team", ["add-project", "scratchy", "--scratch"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  const isoCfgPath = join(isoWs, "dev-loop.json");
  const isoCfg0 = readJson(isoCfgPath);
  isoCfg0.repos = { ...(isoCfg0.repos ?? {}), "iso-repo": { path: "iso-repo" } };
  isoCfg0.projects["real-one"].repos = [{ ref: "iso-repo" }];
  writeFileSync(isoCfgPath, JSON.stringify(isoCfg0, null, 2) + "\n");
  const isoDb = join(isoWs, ".dev-loop", "hub.db");
  spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('real-one')?.id;if(pid)for(const i of [1,2])db.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,created_by,created_at,updated_at)VALUES(?,?,'t','Bug','Todo',0,'[]','test','2026-01-01','2026-01-01')").run('iso-t'+i,pid);db.close()})`, isoDb], { cwd: hubRoot, env: env(), encoding: "utf8" });
  const isoBefore = { cfg: cfgKeys(isoCfgPath), db: dbCounts(isoDb) };
  ok(/"t":2/.test(isoBefore.db), `LOOP-305: fixture seeded — the live command really would cascade here (${isoBefore.db})`);

  // AC2: --force WITHOUT the token refuses, and nothing is written.
  const isoForceNoToken = run("team", ["remove-project", "real-one", "--force"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(isoForceNoToken.code !== 0,
    `LOOP-305 AC2: --force with no token REFUSES on a non-scratch project (got ${isoForceNoToken.code})`);
  ok(/--i-understand-this-deletes-real-one/.test(isoForceNoToken.out) && /--force does NOT grant this/.test(isoForceNoToken.out),
    `LOOP-305 AC2: the refusal names the token and denies that --force grants it (got: ${isoForceNoToken.out.replace(/\n/g, " | ").slice(0, 300)})`);
  ok(cfgKeys(isoCfgPath) === isoBefore.cfg && dbCounts(isoDb) === isoBefore.db,
    `LOOP-305 AC2: the refused run mutated NOTHING (${isoBefore.db} → ${dbCounts(isoDb)})`);

  // AC4: a token naming a DIFFERENT project gets its own message, never the generic 'unknown option'.
  for (const badTok of ["--i-understand-this-deletes-scratchy", "--i-understand-this-deletes-real-one-x", `${TOKEN_PREFIX}anything`]) {
    const t = run("team", ["remove-project", "real-one", "--force", badTok], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
    ok(t.code !== 0 && /names a different project than 'real-one'/.test(t.out) && !/unknown option/.test(t.out),
      `LOOP-305 AC4: '${badTok}' dies as a wrong-project token, not 'unknown option' (got ${t.code}: ${t.out.replace(/\n/g, " | ").slice(0, 200)})`);
    ok(cfgKeys(isoCfgPath) === isoBefore.cfg && dbCounts(isoDb) === isoBefore.db, `LOOP-305 AC4: '${badTok}' mutated nothing`);
  }

  // AC5: the preview reports the isolation line and BOTH refusal reasons, and mutates nothing.
  const isoDry = run("team", ["remove-project", "real-one", "--dry-run"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(isoDry.code === 0, `LOOP-305 AC5: --dry-run on a non-scratch project still exits 0 (got ${isoDry.code})`);
  ok(/isolation\s*: NOT scratch — needs --i-understand-this-deletes-real-one/.test(isoDry.out),
    `LOOP-305 AC5: the preview prints the isolation line (got: ${isoDry.out.replace(/\n/g, " | ").slice(0, 400)})`);
  ok(/WOULD REFUSE \(not a scratch project; needs --i-understand-this-deletes-real-one\)/.test(isoDry.out)
    && /WOULD REFUSE \(2 ticket\(s\); needs --force\)/.test(isoDry.out),
    `LOOP-305 AC5: BOTH refusal reasons are reported — an operator who satisfies one must not be ambushed by the other (got: ${isoDry.out.replace(/\n/g, " | ").slice(0, 400)})`);
  ok(cfgKeys(isoCfgPath) === isoBefore.cfg && dbCounts(isoDb) === isoBefore.db,
    "LOOP-305 AC5: the preview mutated NOTHING (cfg keys + hub.db projects/tickets counts identical)");
  // …and with the token supplied the preview says so, instead of demanding what it already has.
  const isoDryTok = run("team", ["remove-project", "real-one", "--dry-run", "--i-understand-this-deletes-real-one"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(/isolation\s*: NOT scratch — --i-understand-this-deletes-real-one present/.test(isoDryTok.out)
    && !/not a scratch project; needs/.test(isoDryTok.out),
    `LOOP-305 AC5: with the token present the preview reports it, and drops the isolation refusal (got: ${isoDryTok.out.replace(/\n/g, " | ").slice(0, 400)})`);

  // AC3 discriminator, end to end: a scratch project is removed with NO token at all.
  const isoScratch = run("team", ["remove-project", "scratchy"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(isoScratch.code === 0 && !("scratchy" in readJson(isoCfgPath).projects),
    `LOOP-305 AC3: a scratch:true project is removed with NO token (got ${isoScratch.code}: ${isoScratch.out.replace(/\n/g, " | ").slice(0, 200)})`);
  // ══ LOOP-327: settable paths for projects.<key>.scratch + team.agents.<a>.* ══════════════════
  {
    const ws327 = join(tmp, "ws327");
    run("team", ["init", "--dir", ws327, "--key", "w327", "--backend", "service", "--yes"]);
    run("team", ["add-project", "p327", "--prefix", "PZ7"], { cwd: ws327 });
    // scratch on an EXISTING project — before LOOP-327 only creation-time --scratch could write it,
    // so a lost marker (the 2026-08-04 recovery) was unrepairable through mutators.
    const sScr = run("team", ["set", "projects.p327.scratch", "true"], { cwd: ws327 });
    ok(sScr.code === 0 && readJson(join(ws327, "dev-loop.json")).projects.p327.scratch === true,
      `LOOP-327: projects.<key>.scratch is settable on an existing project (got ${sScr.code})`);
    // team-scope agent launch config — the gap that let _team sweep fall back to the built-in model.
    run("team", ["set", "team.agents.sweep.codingAgent", "opencode"], { cwd: ws327 });
    const sMod = run("team", ["set", "team.agents.sweep.model", "openrouter/deepseek/deepseek-v4-flash"], { cwd: ws327 });
    const cfg327b = readJson(join(ws327, "dev-loop.json"));
    ok(sMod.code === 0 && cfg327b.team.agents?.sweep?.model === "openrouter/deepseek/deepseek-v4-flash" && cfg327b.team.agents?.sweep?.codingAgent === "opencode",
      `LOOP-327: team.agents.<a>.{codingAgent,model} are settable (got: ${JSON.stringify(cfg327b.team.agents?.sweep)})`);
    ok(cfg327b.team.agents?.sweep?.cadence === undefined || typeof cfg327b.team.agents?.sweep === "object",
      "LOOP-327: existing team.agents keys survive the merge (block-walk, not replace)");
    const sBad = run("team", ["set", "team.agents.sweep.cadenc", "5m"], { cwd: ws327 });
    ok(sBad.code !== 0, "LOOP-327: an unknown team.agents leaf is still refused (whitelist holds)");
    const sBadEnum = run("team", ["set", "team.agents.sweep.codingAgent", "gemini"], { cwd: ws327 });
    ok(sBadEnum.code !== 0, "LOOP-327: codingAgent outside {claude,codex,opencode} is refused");
  }

  // ══ LOOP-307 (LOOP-302 ③): a deleted project leaves a tombstone; no silent resurrection ══════
  {
    const ws307 = join(tmp, "ws307");
    run("team", ["init", "--dir", ws307, "--key", "w307", "--backend", "service", "--yes"]);
    const db307 = join(ws307, ".dev-loop", "hub.db");
    run("team", ["add-project", "ghost", "--scratch", "--prefix", "GH1"], { cwd: ws307 });
    {
      const d = openDb(db307);
      const pid = (d.prepare("SELECT id FROM projects WHERE key='ghost'").get() as { id: string }).id;
      for (const i of [1, 2]) d.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(`GH1-${i}`, pid, "t", "Bug", "Todo", 0, "[]", "[]", "test", "2026-01-01", "2026-01-01");
      d.close();
    }
    const rm307 = run("team", ["remove-project", "ghost", "--force"], { cwd: ws307, extra: { DEVLOOP_ACTOR: "qa-307" } });
    ok(rm307.code === 0, `LOOP-307 setup: scratch project with 2 tickets removed via --force (got ${rm307.code}: ${rm307.out.replace(/\n/g, " | ").slice(0, 200)})`);
    {
      const d = openDb(db307);
      const tomb = d.prepare("SELECT removed_by, ticket_count, verb FROM removed_projects WHERE key='ghost'").get() as { removed_by: string; ticket_count: number; verb: string } | undefined;
      d.close();
      ok(!!tomb && tomb.ticket_count === 2 && tomb.removed_by === "qa-307" && tomb.verb === "remove-project",
        `LOOP-307: the tombstone rode the cascade's transaction — actor + destroyed count + verb recorded (got: ${JSON.stringify(tomb)})`);
    }
    // AC1 — a re-seed of the removed key REFUSES, naming the removal's facts + the explicit action.
    const res1 = run("cli", ["seed", "ghost", "Ghost", "GH1"], { cwd: ws307 });
    ok(res1.code !== 0 && /was removed on .+ by qa-307 \(2 ticket\(s\) destroyed, via remove-project\)/.test(res1.out) && /DEVLOOP_ALLOW_RESURRECT=1/.test(res1.out),
      `LOOP-307 AC1: re-seed of a removed key refuses with the removal's facts (got ${res1.code}: ${res1.out.replace(/\n/g, " | ").slice(0, 260)})`);
    {
      const d = openDb(db307);
      ok((d.prepare("SELECT count(*) c FROM projects WHERE key='ghost'").get() as { c: number }).c === 0, "LOOP-307 AC1: the refused re-seed created NO project row");
      d.close();
    }
    // AC4 — doctor W29: config lists the removed key (hand-restored, the 2026-08-04 divergence
    // shape), hub.db has no row but a tombstone. Warn-only: DOCTOR_OK must hold.
    const cfg307 = readJson(join(ws307, "dev-loop.json"));
    cfg307.projects["ghost"] = { repos: [] };
    writeFileSync(join(ws307, "dev-loop.json"), JSON.stringify(cfg307, null, 2) + "\n");
    const doc307 = run("server", ["doctor"], { cwd: ws307 });
    ok(/\[W29\] projects\.ghost: .*REMOVED on .+ by qa-307 \(2 ticket\(s\) destroyed/.test(doc307.out),
      `LOOP-307 AC4: doctor W29 names the tombstoned divergence with its facts (got: ${(doc307.out.match(/\[W29\][^\n]*/) ?? ["no W29 line"])[0].slice(0, 220)})`);
    ok(/\[W08\] projects\.ghost/.test(doc307.out), "LOOP-307 AC4: W08 still covers the no-hub-row gap alongside W29");
    ok(/DOCTOR_OK/.test(doc307.out), "LOOP-307 AC4: W29 is warn-only — DOCTOR_OK holds");
    delete cfg307.projects["ghost"];
    writeFileSync(join(ws307, "dev-loop.json"), JSON.stringify(cfg307, null, 2) + "\n");
    // AC2 — DEVLOOP_ALLOW_RESURRECT=1 proceeds AND clears the tombstone (a second resurrection
    // must not be silently pre-approved).
    const res2 = run("cli", ["seed", "ghost", "Ghost", "GH1"], { cwd: ws307, extra: { DEVLOOP_ALLOW_RESURRECT: "1" } });
    ok(res2.code === 0, `LOOP-307 AC2: resurrection with the env token succeeds (got ${res2.code}: ${res2.out.replace(/\n/g, " | ").slice(0, 200)})`);
    {
      const d = openDb(db307);
      ok((d.prepare("SELECT count(*) c FROM removed_projects WHERE key='ghost'").get() as { c: number }).c === 0,
        "LOOP-307 AC2: the tombstone row is GONE after an approved resurrection");
      ok((d.prepare("SELECT count(*) c FROM projects WHERE key='ghost'").get() as { c: number }).c === 1, "LOOP-307 AC2: the project row exists again");
      d.close();
    }
    // AC3 — a key that was never removed seeds normally (the guard is not "refuse all creates").
    const res3 = run("cli", ["seed", "fresh307", "Fresh", "FR7"], { cwd: ws307 });
    ok(res3.code === 0, `LOOP-307 AC3: a never-removed key seeds normally (got ${res3.code})`);
    // AC5 — the tombstone is written in the SAME transaction as the cascade: force the db half to
    // fail and assert NO removed_projects row was left behind (rides LOOP-306's commitBothHalves).
    {
      const failDb = join(tmp, "ws307-fail.db");
      const d = openDb(failDb);
      let threw: Error | null = null;
      try {
        commitBothHalves({
          configPath: join(tmp, "ws307-fail-cfg.json"), configText: null, db: d,
          dbWork: () => {
            d.prepare("INSERT OR REPLACE INTO removed_projects(key,removed_at,removed_by,ticket_count,verb) VALUES ('doomed','2026-01-01','t',5,'remove-project')").run();
            throw new Error("injected db failure");
          },
        });
      } catch (e) { threw = e as Error; }
      ok(!!threw && /injected db failure/.test(threw.message), "LOOP-307 AC5: the injected failure propagates");
      ok((d.prepare("SELECT count(*) c FROM removed_projects").get() as { c: number }).c === 0,
        "LOOP-307 AC5: the tombstone rolled back WITH the cascade — no row survives a failed removal");
      d.close();
    }
  }

  const isoScratchDry = run("team", ["remove-project", "iso-nonexistent", "--dry-run"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(isoScratchDry.code !== 0, "LOOP-305: an unknown key still errors before the gate (precedence unchanged)");

  // ═══ LOOP-306 (LOOP-302 ②): the two halves commit together, and no line claims a write that did not happen ═══
  // End-to-end over the REAL ten-statement cascade. Each arm destroys its own fixture, so each gets a
  // fresh workspace. `sql()` is the same inline-node shape the arms above use, kept local to this block.
  const sql = (dbPath: string, body: string) =>
    spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);${body};db.close()})`, dbPath],
      { cwd: hubRoot, env: env(), encoding: "utf8" });
  // A victim project with rows in the cascade tables that are deleted BEFORE the failure point, so a
  // rollback is observable as data rather than only as an exit code.
  const halvesWs = (name: string) => {
    const w = join(tmp, name);
    run("team", ["init", "--dir", w, "--key", `${name.slice(0, 12)}-tm`, "--backend", "service"]);
    run("team", ["add-project", "victim"], { cwd: w, extra: { DEVLOOP_HUB_DB: "" } });
    const dbp = join(w, ".dev-loop", "hub.db");
    const pid = sql(dbp, `const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('victim').id;` +
      `for(const i of [1,2])db.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,created_by,created_at,updated_at)VALUES(?,?,'t','Bug','Todo',0,'[]','test','2026-01-01','2026-01-01')").run('vt'+i,pid);` +
      `db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at)VALUES('vc1','vt1','test','b','2026-01-01')").run();` +
      `console.log(pid)`).stdout.trim();
    return { ws: w, cfg: join(w, "dev-loop.json"), db: dbp, pid };
  };
  // The oracle: the config bytes + the victim's OWN rows in the cascade tables the failure straddles.
  // Scoped to `pid`, not global counts: `add-project` seeds a full label taxonomy per project, so a global
  // `labels` count is dominated by the sibling `_team` project's rows and would read as "not deleted" on a
  // perfectly successful cascade. The project id is captured at fixture time because the row that carries
  // it is itself deleted by statement 10.
  const halvesState = (f: { cfg: string; db: string; pid: string }) => ({
    bytes: readFileSync(f.cfg, "utf8"),
    rows: sql(f.db, `const pid=${JSON.stringify(f.pid)};console.log(JSON.stringify({` +
      `p:db.prepare('SELECT count(*) c FROM projects WHERE id=?').get(pid).c,` +
      `t:db.prepare('SELECT count(*) c FROM tickets WHERE project_id=?').get(pid).c,` +
      `c:db.prepare('SELECT count(*) c FROM comments WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id=?)').get(pid).c,` +
      `l:db.prepare('SELECT count(*) c FROM labels WHERE project_id=?').get(pid).c}))`).stdout.trim(),
  });

  // ── AC1 + AC4: a failure PART WAY THROUGH the cascade rolls back the statements already run, and the
  //    config half is restored. The fault is injected as a BEFORE DELETE trigger on `tickets` (statement 9
  //    of 10), chosen because a trigger survives openDb's `CREATE TABLE IF NOT EXISTS` schema re-exec —
  //    dropping a table would simply be re-created out from under the test. Statements 1–8 (through
  //    `comments`) have really run when the abort fires, so "rolled back" is a claim about data.
  const hA = halvesWs("halves-db-fail");
  sql(hA.db, `db.exec("CREATE TRIGGER dl306_boom BEFORE DELETE ON tickets BEGIN SELECT RAISE(ABORT,'injected cascade failure'); END")`);
  const hABefore = halvesState(hA);
  // Labels are not seeded by hand: `add-project` already provisions the project's full taxonomy, which is
  // what statement 3 of the cascade deletes. Asserting it is non-zero keeps the rollback claim honest.
  ok(/"t":2/.test(hABefore.rows) && /"c":1/.test(hABefore.rows) && !/"l":0/.test(hABefore.rows),
    `LOOP-306: fixture seeded across the cascade tables the failure straddles (${hABefore.rows})`);
  const hARun = run("team", ["remove-project", "victim", "--force", "--i-understand-this-deletes-victim"], { cwd: hA.ws, extra: { DEVLOOP_HUB_DB: "" } });
  const hAAfter = halvesState(hA);
  ok(hARun.code !== 0, `LOOP-306 AC4: a db-half failure exits non-zero (got ${hARun.code})`);
  ok(!/removed project/.test(hARun.out),
    `LOOP-306 AC4: NO 'removed project' line is printed for a removal that did not happen (got: ${hARun.out.replace(/\n/g, " | ").slice(0, 300)})`);
  ok(hAAfter.bytes === hABefore.bytes,
    "LOOP-306 AC4: the config half is restored to its original BYTES after the db half failed");
  ok(hAAfter.rows === hABefore.rows,
    `LOOP-306 AC1: the whole cascade rolled back — statements 1–8 are undone, not left applied (${hABefore.rows} → ${hAAfter.rows})`);

  // ── AC3: the config half fails, the db half would have succeeded. The WORKSPACE DIRECTORY is made
  //    read-only, not the file: an atomic write is tmp-create + rename, and a rename over a 0444 file in a
  //    writable directory succeeds — so `chmod 0444 dev-loop.json` would not exercise this arm at all.
  const hB = halvesWs("halves-cfg-fail");
  const hBBefore = halvesState(hB);
  chmodSync(hB.ws, 0o555);
  const hBRun = run("team", ["remove-project", "victim", "--force", "--i-understand-this-deletes-victim"], { cwd: hB.ws, extra: { DEVLOOP_HUB_DB: "" } });
  chmodSync(hB.ws, 0o755);
  const hBAfter = halvesState(hB);
  ok(hBRun.code !== 0, `LOOP-306 AC3: a config-half failure exits non-zero (got ${hBRun.code})`);
  ok(!/removed project/.test(hBRun.out),
    `LOOP-306 AC3: NO 'removed project' line — the incident's exact symptom was this line for a file that had not changed (got: ${hBRun.out.replace(/\n/g, " | ").slice(0, 300)})`);
  ok(hBAfter.bytes === hBBefore.bytes, "LOOP-306 AC3: the config file is unchanged");
  ok(hBAfter.rows === hBBefore.rows,
    `LOOP-306 AC3: hub.db is unchanged — the db half never ran (${hBBefore.rows} → ${hBAfter.rows})`);

  // ── AC6 discriminator: the happy path still removes both halves and prints both lines. Without this the
  //    three arms above are satisfied by a command that refuses everything.
  const hC = halvesWs("halves-happy");
  const hCBefore = halvesState(hC);
  const hCRun = run("team", ["remove-project", "victim", "--force", "--i-understand-this-deletes-victim"], { cwd: hC.ws, extra: { DEVLOOP_HUB_DB: "" } });
  const hCAfter = halvesState(hC);
  ok(hCRun.code === 0, `LOOP-306 AC6: the happy path still exits 0 (got ${hCRun.code}: ${hCRun.out.replace(/\n/g, " | ").slice(0, 200)})`);
  ok(/removed project 'victim' from dev-loop\.json/.test(hCRun.out) && /removed project 'victim' from hub\.db/.test(hCRun.out),
    "LOOP-306 AC6: both success lines print once both halves are durable");
  ok(!("victim" in JSON.parse(hCAfter.bytes).projects), "LOOP-306 AC6: the config half really applied");
  ok(/"p":1/.test(hCBefore.rows) && hCAfter.rows === `{"p":0,"t":0,"c":0,"l":0}`,
    `LOOP-306 AC6: the db cascade really applied across every scoped table (${hCBefore.rows} → ${hCAfter.rows})`);

  // AC3: token + --force proceeds — and this is what makes every zero-mutation assertion above non-vacuous.
  const isoGo = run("team", ["remove-project", "real-one", "--force", "--i-understand-this-deletes-real-one"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(isoGo.code === 0, `LOOP-305 AC3: token + --force executes the removal (got ${isoGo.code}: ${isoGo.out.slice(0, 200)})`);
  ok(cfgKeys(isoCfgPath) !== isoBefore.cfg && dbCounts(isoDb) !== isoBefore.db,
    `LOOP-305 AC3: the gated cascade DID run — the refusals above were blocking a real deletion (${isoBefore.db} → ${dbCounts(isoDb)})`);

  // AC4/usage: the usage string and `team --help` document the token, and say --force is not it.
  const isoUsage = run("team", ["remove-project"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(isoUsage.code !== 0 && /--i-understand-this-deletes-<key>/.test(isoUsage.out), "LOOP-305: the usage string documents the token");
  const isoHelp = run("team", ["--help"], { cwd: isoWs, extra: { DEVLOOP_HUB_DB: "" } }).out;
  ok(/--i-understand-this-deletes-<key>/.test(isoHelp) && /--force does NOT/.test(isoHelp),
    "LOOP-305: `team --help` documents the token and no longer sells --force as the blanket 'safety guard' bypass");

  // team repair --reap: project reap (dry-run lists scratch 0/0; spares non-zero)
  const reapWs = join(tmp, "reap-ws");
  run("team", ["init", "--dir", reapWs, "--key", "reap-team", "--backend", "service"]);
  run("team", ["add-project", "to-reap", "--scratch"], { cwd: reapWs, extra: { DEVLOOP_HUB_DB: "" } });
  run("team", ["add-project", "real-proj"], { cwd: reapWs, extra: { DEVLOOP_HUB_DB: "" } }); // not scratch → spared
  run("team", ["add-project", "with-ticket", "--scratch"], { cwd: reapWs, extra: { DEVLOOP_HUB_DB: "" } });
  // seed a ticket into 'with-ticket' project via direct SQL so the ticket-guard fires
  spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('with-ticket')?.id;if(pid)db.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,created_by,created_at,updated_at)VALUES(?,?,'t','Bug','Todo',0,'[]','test','2026-01-01','2026-01-01')").run('tid-1',pid);db.close()})`, join(reapWs, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  // dry-run: lists 'to-reap', spares 'real-proj' and 'with-ticket'
  const dryReap = run("team", ["repair", "--reap", "--dry-run"], { cwd: reapWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(dryReap.code === 0, "LOOP-221 AC2: repair --reap --dry-run exits 0");
  ok(/to-reap.*would be reaped/.test(dryReap.out.replace(/\n/g, " ")), "LOOP-221 AC2: dry-run lists scratch 0/0 project 'to-reap'");
  ok(!/real-proj.*would be reaped/.test(dryReap.out), "LOOP-221 AC2: dry-run spares unmarked 'real-proj'");
  ok(!/with-ticket.*would be reaped/.test(dryReap.out), "LOOP-221 AC2: dry-run spares scratch 'with-ticket' that has tickets");
  ok(/kept/.test(dryReap.out) || /ticket/.test(dryReap.out), "LOOP-221 AC2: dry-run notes 'with-ticket' is kept due to tickets");
  // verify dry-run didn't actually remove anything
  const dryReapCfg = readJson(join(reapWs, "dev-loop.json"));
  ok("to-reap" in dryReapCfg.projects, "LOOP-221 AC2: dry-run did not remove 'to-reap' from config");
  // apply: removes 'to-reap', leaves others
  const applyReap = run("team", ["repair", "--reap"], { cwd: reapWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(applyReap.code === 0, "LOOP-221 AC2: repair --reap exits 0");
  ok(/reaped/.test(applyReap.out) && /to-reap/.test(applyReap.out), "LOOP-221 AC2: apply reports 'to-reap' reaped");
  const applyReapCfg = readJson(join(reapWs, "dev-loop.json"));
  ok(!("to-reap" in applyReapCfg.projects), "LOOP-221 AC2: 'to-reap' gone from config after apply");
  ok("real-proj" in applyReapCfg.projects, "LOOP-221 AC2: 'real-proj' still in config (spared)");
  // LOOP-305 AC6: 'real-proj' is the exact shape a widened candidate filter would sweep up — NON-scratch,
  // zero tickets, zero repos. It must survive an APPLIED reap, and its hub.db row with it. The reap now
  // routes this decision through the shared isolation gate, so the invariant no longer rests on one filter.
  const reapDbChk = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const r=db.prepare('SELECT id FROM projects WHERE key=?').get('real-proj');console.log(r?'found':'gone');db.close()})`, join(reapWs, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/found/.test(reapDbChk.stdout),
    "LOOP-305 AC6: an APPLIED `repair --reap` never reaps a non-scratch 0-ticket 0-repo project — its hub.db row survives too");
  ok("with-ticket" in applyReapCfg.projects, "LOOP-221 AC2: 'with-ticket' still in config (has tickets)");
  // hub.db: 'to-reap' row gone
  const applyReapDbChk = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const r=db.prepare('SELECT id FROM projects WHERE key=?').get('to-reap');console.log(r?'found':'gone');db.close()})`, join(reapWs, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  ok(/gone/.test(applyReapDbChk.stdout), "LOOP-221 AC2: 'to-reap' hub.db row deleted after apply");

  // ═══ LOOP-280: remove-project / repair --reap FAIL CLOSED on an unreadable hub.db ═══
  // A present-but-unopenable hub.db (busy past busy_timeout / corrupt / permission denied) means the
  // ticket count is UNKNOWN. Both mutators must refuse/skip — never silently treat the project as
  // 0-ticket and discard its config entry, orphaning live tickets behind a fabricated "0-ticket" success.
  const fcWs = join(tmp, "failclosed-ws");
  run("team", ["init", "--dir", fcWs, "--key", "fc-team", "--backend", "service"]);
  run("team", ["add-project", "victim", "--scratch"], { cwd: fcWs, extra: { DEVLOOP_HUB_DB: "" } });
  const fcDb = join(fcWs, ".dev-loop", "hub.db");
  // seed a LIVE ticket into 'victim' BEFORE corrupting the db (a fail-OPEN bug would orphan exactly this)
  spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);const pid=db.prepare('SELECT id FROM projects WHERE key=?').get('victim')?.id;if(pid)db.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,created_by,created_at,updated_at)VALUES(?,?,'t','Bug','Todo',0,'[]','test','2026-01-01','2026-01-01')").run('vt-1',pid);db.close()})`, fcDb], { cwd: hubRoot, env: env(), encoding: "utf8" });
  // control (healthy db): remove-project correctly refuses because the guard reads tc=1
  const fcControl = run("team", ["remove-project", "victim"], { cwd: fcWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(fcControl.code !== 0 && /ticket/.test(fcControl.out), "LOOP-280 control: healthy db refuses remove-project with a live ticket");
  // LOOP-281 AC3: a refusal must also WRITE NOTHING. Exit code + message alone stay green even if the guard
  // died AFTER the config half had already been rewritten — the 2026-08-04 shape, where the CLI printed a
  // result that disagreed with what the two stores actually held.
  ok("victim" in readJson(join(fcWs, "dev-loop.json")).projects,
    "LOOP-281 AC3: the refused remove-project leaves the config entry intact");
  {
    const d = openDb(fcDb);
    const row = d.prepare("SELECT id FROM projects WHERE key='victim'").get() as { id: string } | undefined;
    // Counted through the project row that must still exist; if the row were gone this reads 0 and the
    // assertion below fails, which is the correct signal either way.
    const tc = (d.prepare("SELECT count(*) c FROM tickets WHERE project_id=(SELECT id FROM projects WHERE key='victim')").get() as { c: number }).c;
    d.close();
    ok(!!row, "LOOP-281 AC3: the refused remove-project leaves the hub.db projects row intact");
    ok(tc === 1, `LOOP-281 AC3: the refused remove-project leaves the project's ticket row intact (got ${tc})`);
  }
  // corrupt hub.db so openDb() throws; drop the WAL/shm sidecars so there is no recovery path
  for (const sfx of ["-wal", "-shm"]) rmSync(fcDb + sfx, { force: true });
  writeFileSync(fcDb, Buffer.from("this is not a sqlite database ".repeat(16)));
  // AC1: remove-project must REFUSE (fail closed) and leave the config entry intact
  const fcRm = run("team", ["remove-project", "victim"], { cwd: fcWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(fcRm.code !== 0, "LOOP-280 AC1: remove-project refuses when hub.db is present but unreadable");
  ok(/could not be opened|unreadable|verify/.test(fcRm.out), "LOOP-280 AC1: refusal names the unverifiable-db cause (not a false 'not found')");
  ok("victim" in readJson(join(fcWs, "dev-loop.json")).projects, "LOOP-280 AC1: 'victim' survives in config after the refused remove-project");
  // AC2: repair --reap must SKIP (fail closed), never reap + print a fabricated "0-ticket 0-repo" success
  const fcReapOut = run("team", ["repair", "--reap"], { cwd: fcWs, extra: { DEVLOOP_HUB_DB: "" } }).out.replace(/\n/g, " ");
  ok(!/victim.*reaped/.test(fcReapOut), "LOOP-280 AC2: repair --reap does NOT reap 'victim' on an unreadable db");
  ok(/victim.*(unreadable|could not verify|skipping)/.test(fcReapOut), "LOOP-280 AC2: repair --reap skips 'victim' loudly (unverifiable ticket count)");
  ok("victim" in readJson(join(fcWs, "dev-loop.json")).projects, "LOOP-280 AC2: 'victim' survives in config after the skipped reap");
  // AC4: --force still deliberately bypasses on remove-project, even with an unreadable db
  const fcForce = run("team", ["remove-project", "victim", "--force"], { cwd: fcWs, extra: { DEVLOOP_HUB_DB: "" } });
  ok(fcForce.code === 0, "LOOP-280 AC4: --force still removes 'victim' from config despite the unreadable db");
  ok(!("victim" in readJson(join(fcWs, "dev-loop.json")).projects), "LOOP-280 AC4: 'victim' gone from config after --force");

  // ══ LOOP-281: the cascade itself, pinned on a READABLE db — and pinned as SCOPED ═════════════
  // LOOP-280's --force arm runs against a deliberately corrupted hub.db, so it structurally cannot read a
  // single row count: the ten statements removeProject() runs were asserted nowhere. Dropping or mis-scoping
  // any one of them left rows keyed to a project id that no longer exists and passed the entire suite.
  //
  // Two properties, and the bystander project is why the second is checkable: "count WHERE project=victim is
  // 0" is ALSO satisfied by a DELETE that lost its WHERE clause and emptied the table for every project. The
  // bystander's rows must survive byte-for-byte, so BOTH "deleted too little" and "deleted too much" are red.
  //
  // Child rows are counted by their OWN key (ticket_id / doc_id), never through a join back to tickets or
  // documents: after the cascade those parents are gone, so a join-based count reads 0 for orphans that are
  // still sitting in the table — it would report success for precisely the failure being tested.
  //
  // Invocation is the POST-LOOP-302 form: 'cascade-victim' is NOT scratch, so the isolation gate requires the
  // naming token in addition to --force (LOOP-305 — the two flags answer different questions).
  {
    const casWs = join(tmp, "cascade-ws");
    run("team", ["init", "--dir", casWs, "--key", "cas-team", "--backend", "service", "--yes"]);
    const casDb = join(casWs, ".dev-loop", "hub.db");
    run("team", ["add-project", "cascade-victim", "--prefix", "CV"], { cwd: casWs });
    run("team", ["add-project", "cascade-bystander", "--prefix", "CB"], { cwd: casWs });

    // Seed one row into every table the cascade touches, for BOTH projects.
    const seed = (key: string, tag: string): string => {
      const d = openDb(casDb);
      const pid = (d.prepare("SELECT id FROM projects WHERE key=?").get(key) as { id: string }).id;
      d.prepare("INSERT INTO tickets(id,project_id,title,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(`${tag}-1`, pid, "t", "Bug", "Todo", 0, "[]", "[]", "test", "2026-01-01", "2026-01-01");
      d.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES (?,?,?,?,?)")
        .run(`${tag}-c1`, `${tag}-1`, "test", "body", "2026-01-01");
      d.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)")
        .run(pid, `${tag}-1`, "test", "issue.create", "{}", "2026-01-01");
      d.prepare("INSERT INTO documents(id,project_id,kind,slug,title,status,current_version,archived,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(`${tag}-d1`, pid, "design", `${tag}-slug`, "T", "draft", 0, 0, "test", "2026-01-01", "2026-01-01");
      d.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`${tag}-dv1`, `${tag}-d1`, 1, "b", "draft", "", 0, "test", "2026-01-01");
      d.prepare("INSERT INTO channels(id,project_id,provider,config_ref,channel_ref,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(`${tag}-ch1`, pid, "slack", "SLACK_BOT_TOKEN_ENV", "C123", 1, "2026-01-01", "2026-01-01");
      d.prepare("INSERT INTO channel_messages(id,channel_id,project_id,direction,body,created_at) VALUES (?,?,?,?,?,?)")
        .run(`${tag}-cm1`, `${tag}-ch1`, pid, "outbound", "m", "2026-01-01");
      d.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,created_at) VALUES (?,?,?,?,?)")
        .run(`${tag}-mm1`, pid, "ticket", `${tag}-1`, "2026-01-01");
      d.close();
      return pid;
    };
    const victimPid = seed("cascade-victim", "CV");
    const bystanderPid = seed("cascade-bystander", "CB");

    const counts = (pid: string, tag: string): Record<string, number> => {
      const d = openDb(casDb);
      const n = (sql: string, ...a: string[]): number => (d.prepare(sql).get(...a) as { c: number }).c;
      const out = {
        projects: n("SELECT count(*) c FROM projects WHERE id=?", pid),
        tickets: n("SELECT count(*) c FROM tickets WHERE project_id=?", pid),
        comments: n("SELECT count(*) c FROM comments WHERE ticket_id=?", `${tag}-1`),
        events: n("SELECT count(*) c FROM events WHERE project_id=?", pid),
        documents: n("SELECT count(*) c FROM documents WHERE project_id=?", pid),
        document_versions: n("SELECT count(*) c FROM document_versions WHERE doc_id=?", `${tag}-d1`),
        channels: n("SELECT count(*) c FROM channels WHERE project_id=?", pid),
        channel_messages: n("SELECT count(*) c FROM channel_messages WHERE project_id=?", pid),
        labels: n("SELECT count(*) c FROM labels WHERE project_id=?", pid),
        mirror_map: n("SELECT count(*) c FROM mirror_map WHERE project_id=?", pid),
      };
      d.close();
      return out;
    };

    const victimBefore = counts(victimPid, "CV");
    const bystanderBefore = counts(bystanderPid, "CB");
    // Every table must actually carry a row before the cascade, or a "0 after" assertion proves nothing.
    const emptyBefore = Object.entries(victimBefore).filter(([, v]) => v === 0).map(([k]) => k);
    ok(emptyBefore.length === 0, `LOOP-281 AC1 setup: every cascade table seeded for the victim (empty: ${emptyBefore.join(",") || "none"})`);

    const casRm = run("team", ["remove-project", "cascade-victim", "--force", "--i-understand-this-deletes-cascade-victim"], { cwd: casWs });
    ok(casRm.code === 0, `LOOP-281 AC1: remove-project --force + token exits 0 on a READABLE db (got ${casRm.code}: ${casRm.out.replace(/\n/g, " | ").slice(0, 220)})`);

    const victimAfter = counts(victimPid, "CV");
    const leftBehind = Object.entries(victimAfter).filter(([, v]) => v !== 0).map(([k, v]) => `${k}=${v}`);
    ok(leftBehind.length === 0, `LOOP-281 AC1: the cascade leaves NO rows for the removed project (orphans: ${leftBehind.join(" ") || "none"})`);

    const bystanderAfter = counts(bystanderPid, "CB");
    const collateral = Object.keys(bystanderBefore)
      .filter((k) => bystanderBefore[k] !== bystanderAfter[k])
      .map((k) => `${k}: ${bystanderBefore[k]}→${bystanderAfter[k]}`);
    ok(collateral.length === 0, `LOOP-281 AC1: the cascade is SCOPED — the bystander project is untouched (changed: ${collateral.join(" ") || "none"})`);
  }

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

  // Regression (LOOP-5): trigger filtering — workflow_call/workflow_dispatch-only workflows must produce [] (no PR check context)
  const wfCall = [
    "name: Reusable", "on:", "  workflow_call:", "    inputs:", "      tag: { type: string }", "jobs:",
    "  quality:", "    name: Quality Gate", "    runs-on: ubuntu-latest", "    steps:", "      - run: npm run quality",
  ].join("\n");
  ok(JSON.stringify(workflowJobNames(wfCall)) === "[]", "workflowJobNames: workflow_call-only workflow is excluded (no PR check context)");
  const wfDispatch = [
    "name: Release", "on:", "  workflow_dispatch:", "    inputs:", "      dry_run: { type: boolean }", "jobs:",
    "  release:", '    name: "Tag and publish"', "    runs-on: ubuntu-latest", "    steps:", "      - run: npm publish",
  ].join("\n");
  ok(JSON.stringify(workflowJobNames(wfDispatch)) === "[]", "workflowJobNames: workflow_dispatch-only workflow is excluded (no PR check context)");

  // Regression (LOOP-5): matrix expansion — ${{ matrix.node }} expands to static values from the job's matrix
  const wfMatrix = [
    "name: Test", "on:", "  push:", "    branches: [main]", "  pull_request:", "jobs:",
    "  test:",
    '    name: "Test (Node ${{ matrix.node }})"',
    "    runs-on: ubuntu-latest",
    "    strategy:",
    "      fail-fast: false",
    "      matrix:",
    '        node: ["23.6.0", "24"]',
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: node --version",
  ].join("\n");
  const matrixNames = workflowJobNames(wfMatrix);
  ok(JSON.stringify(matrixNames) === '["Test (Node 23.6.0)","Test (Node 24)"]', "workflowJobNames: matrix job name is expanded to its static values");
  ok(!matrixNames.some(n => n.includes("${{")) , "workflowJobNames: no unexpanded ${{ }} expressions survive in the output");
  ok(!matrixNames.some(n => n === "test"), "workflowJobNames: the raw job key does not appear when a display name is set");

  const fix = join(tmp, "fixture-repo");
  mkdirSync(join(fix, ".github", "workflows"), { recursive: true });
  writeFileSync(join(fix, "package.json"), JSON.stringify({ name: "fix", scripts: { typecheck: "tsc --noEmit", build: "vite build", test: "vitest" } }));
  writeFileSync(join(fix, ".github", "workflows", "ci.yml"), wf);
  const facts = detectRepoFacts(fix);
  ok(facts.build?.typecheck === "npm run typecheck" && facts.build?.build === "npm run build", "detectRepoFacts maps package.json scripts to runner commands");
  writeFileSync(join(fix, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  ok(detectRepoFacts(fix).build?.build === "pnpm run build", "detectRepoFacts picks the runner from the lockfile (pnpm)");
  rmSync(join(fix, "pnpm-lock.yaml"));

  // LOOP-16 regressions: emit guard + subdirectory scan
  // (a) test+quality-only — the :350 guard no longer requires typecheck/build to be present
  const fixTQ = join(tmp, "tq-only");
  mkdirSync(fixTQ);
  writeFileSync(join(fixTQ, "package.json"), JSON.stringify({ scripts: { test: "node --test", quality: "node src/quality.ts" } }));
  const factsTQ = detectRepoFacts(fixTQ);
  ok(factsTQ.build?.test === "npm run test" && factsTQ.build?.quality === "npm run quality"
    && factsTQ.build?.typecheck === undefined && factsTQ.build?.build === undefined,
    "detectRepoFacts: test+quality-only package.json emits build block (guard no longer requires typecheck/build)");

  // (a) no matching scripts at all → out.build stays absent
  const fixNoGates = join(tmp, "no-gates");
  mkdirSync(fixNoGates);
  writeFileSync(join(fixNoGates, "package.json"), JSON.stringify({ scripts: { start: "node dist/index.js" } }));
  ok(detectRepoFacts(fixNoGates).build === undefined,
    "detectRepoFacts: no matching scripts → out.build stays absent");

  // (b) nested-single-package: no root package.json, exactly one subdir with scripts
  const fixNested = join(tmp, "nested-single");
  const fixNestedHub = join(fixNested, "hub");
  mkdirSync(fixNestedHub, { recursive: true });
  writeFileSync(join(fixNestedHub, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "vite build", quality: "node quality.ts" } }));
  const factsNested = detectRepoFacts(fixNested);
  ok(factsNested.build?.typecheck === "cd hub && npm run typecheck" && factsNested.build?.build === "cd hub && npm run build",
    "detectRepoFacts: no root package.json + single nested candidate → gates prefixed with cd <subdir>");
  // runner chosen from lockfile beside the nested package.json
  writeFileSync(join(fixNestedHub, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  ok(detectRepoFacts(fixNested).build?.typecheck === "cd hub && pnpm run typecheck",
    "detectRepoFacts: nested candidate — runner from lockfile beside nested package.json (pnpm)");
  rmSync(join(fixNestedHub, "pnpm-lock.yaml"));

  // (b) nested-ambiguous: two subdirs with scripts → emit nothing
  const fixAmb = join(tmp, "nested-ambiguous");
  mkdirSync(join(fixAmb, "pkg-a"), { recursive: true });
  mkdirSync(join(fixAmb, "pkg-b"), { recursive: true });
  writeFileSync(join(fixAmb, "pkg-a", "package.json"), JSON.stringify({ scripts: { build: "tsc -b" } }));
  writeFileSync(join(fixAmb, "pkg-b", "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  ok(detectRepoFacts(fixAmb).build === undefined,
    "detectRepoFacts: two nested candidates → ambiguous, no build block emitted");

  // (b) root-wins-over-nested: root package.json present → subdirs not consulted
  const fixRootWins = join(tmp, "root-wins");
  mkdirSync(join(fixRootWins, "sub"), { recursive: true });
  writeFileSync(join(fixRootWins, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
  writeFileSync(join(fixRootWins, "sub", "package.json"), JSON.stringify({ scripts: { build: "webpack" } }));
  const factsRootWins = detectRepoFacts(fixRootWins);
  ok(factsRootWins.build?.typecheck === "npm run typecheck" && factsRootWins.build?.build === undefined,
    "detectRepoFacts: root package.json wins — subdir package.json not consulted");

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

  // ═══ LOOP-100: defaultBranch detection + --default-branch flag ═══
  // Fixture: a git repo initialized with 'master' as the default branch (non-main)
  const masterSrc = join(tmp, "master-src-100");
  mkdirSync(masterSrc, { recursive: true });
  writeFileSync(join(masterSrc, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  for (const gitArgs of [
    ["init", "-b", "master"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  ]) spawnSync("git", gitArgs, { cwd: masterSrc });

  // --detect on a clone of masterSrc infers defaultBranch:"master" via origin/HEAD
  const detMaster = run("team", ["add-repo", "det-master", "--project", "web", "--path", "det-master-repo", "--detect", "--remote", masterSrc], { cwd: lin });
  ok(detMaster.code === 0, "LOOP-100: add-repo --detect with a master-branch remote exits 0");
  ok(readJson(join(lin, "dev-loop.json")).repos["det-master"].defaultBranch === "master",
    "LOOP-100: --detect infers defaultBranch:\"master\" from a repo with master as default");

  // --detect --default-branch develop: explicit flag beats detection
  const detMasterExplicit = run("team", ["add-repo", "det-master-x", "--project", "web", "--path", "det-master-repo-x", "--detect", "--remote", masterSrc, "--default-branch", "develop"], { cwd: lin });
  ok(detMasterExplicit.code === 0, "LOOP-100: add-repo --detect --default-branch develop exits 0");
  ok(readJson(join(lin, "dev-loop.json")).repos["det-master-x"].defaultBranch === "develop",
    "LOOP-100: explicit --default-branch develop beats detection (not master)");

  // --default-branch on an already-registered ref must update in place (PM amendment)
  const detBranchUpdate = run("team", ["add-repo", "det", "--project", "web", "--default-branch", "trunk"], { cwd: lin });
  ok(detBranchUpdate.code === 0, "LOOP-100: --default-branch on an existing ref exits 0 (update in place)");
  ok(readJson(join(lin, "dev-loop.json")).repos.det.defaultBranch === "trunk",
    "LOOP-100: --default-branch persists on an already-registered ref (PM amendment — existing-ref path)");

  // Negative: fix fixture has no git remote → defaultBranch absent (backward-compat)
  ok(detectRepoFacts(fix).defaultBranch === undefined,
    "LOOP-100: detectRepoFacts returns no defaultBranch for a dir with no git origin");

  // Negative: clone of an empty (unborn) remote reports HEAD branch: (unknown) — must NOT persist that sentinel
  const emptyRemote = join(tmp, "empty-remote-100");
  mkdirSync(emptyRemote, { recursive: true });
  spawnSync("git", ["init", "--bare"], { cwd: emptyRemote });
  const cloneOfEmpty = join(tmp, "clone-of-empty-100");
  spawnSync("git", ["clone", emptyRemote, cloneOfEmpty]);
  ok(detectRepoFacts(cloneOfEmpty).defaultBranch === undefined,
    "LOOP-100: detectRepoFacts returns no defaultBranch for a clone of an unborn remote (guards against '(unknown)' sentinel)");

  // LOOP-17 regressions: doctor nudge for repos with no configured build gates
  // (state 1) no build block + detectable gates → nudge appears, DOCTOR_OK maintained
  const ungatedDir = join(lin, "ungated-repo");
  mkdirSync(ungatedDir);
  writeFileSync(join(ungatedDir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node --test" } }));
  run("team", ["add-repo", "ungated", "--project", "web", "--path", "ungated-repo", "--landing", "pr"], { cwd: lin });
  const dUngated = run("server", ["doctor"], { cwd: lin });
  ok(/repo 'ungated' has no build gates configured/.test(dUngated.out) && /typecheck\/test/.test(dUngated.out),
    "LOOP-17: no-build-block + detectable gates → doctor nudge names the detected gates");
  ok(/dev-loop team add-repo ungated --detect/.test(dUngated.out),
    "LOOP-17: nudge names the add-repo --detect fix");
  ok(/DOCTOR_OK/.test(dUngated.out),
    "LOOP-17: nudge is informational — DOCTOR_OK is still printed");

  // (state 2) no build block + no detectable scripts → doctor stays silent (no noise for docs-only repos)
  const emptyDir = join(lin, "empty-repo");
  mkdirSync(emptyDir);
  run("team", ["add-repo", "nogate", "--project", "web", "--path", "empty-repo", "--landing", "pr"], { cwd: lin });
  const dNoGate = run("server", ["doctor"], { cwd: lin });
  ok(!/repo 'nogate' has no build gates/.test(dNoGate.out),
    "LOOP-17: no-build-block + nothing detectable → doctor stays silent (no false-positive nudge)");

  // (state 3) the pre-existing quality-gauntlet nudge (build.test but no build.quality) keeps working
  // The 'det' repo has build.test (via --detect on fix) but no build.quality — the existing nudge fires.
  ok(/repo 'det' has a test gate but no quality gate/.test(dNoGate.out),
    "LOOP-17: pre-existing quality-gauntlet nudge still fires for repo with test but no quality gate");
  ok(!/repo 'det' has no build gates/.test(dNoGate.out),
    "LOOP-17: no-build-block nudge does NOT fire for 'det' (it has a build block — two nudges are mutually exclusive)");

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

  // ── set-model (1.8): the one-command model switch ────────────────────────────────────────────
  {
    const sm1 = run("team", ["set-model", "junior-dev", "google-vertex/gemini-3.6-flash", "--project", "web"], { cwd: lin });
    ok(sm1.code === 0 && /agents\.junior-dev\.model = google-vertex\/gemini-3\.6-flash/.test(sm1.out),
      `set-model writes the per-agent model (got ${sm1.code}: ${sm1.out.trim().split("\n")[0]})`);
    const smCfg = readJson(join(lin, "dev-loop.json"));
    ok(smCfg.projects.web.agents?.["junior-dev"]?.model === "google-vertex/gemini-3.6-flash",
      "the model lands in projects.<key>.agents.<agent>.model");
    const sm2 = run("team", ["set-model", "pm", "m2", "--project", "web", "--effort", "max"], { cwd: lin });
    const smCfg2 = readJson(join(lin, "dev-loop.json"));
    ok(sm2.code === 0 && smCfg2.projects.web.agents?.pm?.model === "m2" && smCfg2.projects.web.agents?.pm?.effort === "max",
      "--effort rides along");
    ok(/restart the scheduler/.test(sm1.out), "the restart pointer is printed (stop && run --background)");
    const sm3 = run("team", ["set-model", "nobody", "m", "--project", "web"], { cwd: lin });
    ok(sm3.code !== 0 && /unknown agent 'nobody'/.test(sm3.out), "an unknown agent handle is refused");
    const sm4 = run("team", ["set-model", "ignored", "opus", "--team-default", "--coding-agent", "claude"], { cwd: lin });
    const smCfg4 = readJson(join(lin, "dev-loop.json"));
    ok(sm4.code === 0 && smCfg4.team.codingAgentDefaults?.claude?.model === "opus",
      "--team-default writes team.codingAgentDefaults.<cli>.model");
  }

  // ═══ projects.<k>.strategyDoc — repo-relative file path, validated, doctor W17 ═══
  {
    // round-trip: set + read back
    const sdSet = run("team", ["set", "projects.web.strategyDoc", "docs/STRATEGY.md"], { cwd: lin });
    ok(sdSet.code === 0 && readJson(join(lin, "dev-loop.json")).projects.web.strategyDoc === "docs/STRATEGY.md",
      "team set projects.<k>.strategyDoc writes a plain-string repo-relative path");
    // --help summary contains strategyDoc
    const help = run("team", ["set", "--help"], { cwd: lin });
    ok(/strategyDoc/.test(help.out), "team set --help lists strategyDoc in the settable-paths summary");
    // absolute path rejected
    const sdAbs = run("team", ["set", "projects.web.strategyDoc", "/abs/path/STRATEGY.md"], { cwd: lin });
    ok(sdAbs.code === 2 && /repo-relative/.test(sdAbs.out), "team set rejects an absolute strategyDoc path");
    // Linear URL rejected
    const sdLin = run("team", ["set", "projects.web.strategyDoc", "https://linear.app/foo/document/bar"], { cwd: lin });
    ok(sdLin.code === 2 && /repo-relative file path/.test(sdLin.out), "team set rejects a Linear document URL for strategyDoc");
    // add-project --strategy-doc sets it at creation; absolute path also rejected there
    const sdCreate = run("team", ["add-project", "strategy-proj", "--strategy-doc", "docs/STRATEGY.md"], { cwd: lin });
    ok(sdCreate.code === 0 && readJson(join(lin, "dev-loop.json")).projects["strategy-proj"]?.strategyDoc === "docs/STRATEGY.md",
      "add-project --strategy-doc sets strategyDoc at creation");
    const sdCreateAbs = run("team", ["add-project", "bad-proj", "--strategy-doc", "/abs/STRATEGY.md"], { cwd: lin });
    ok(sdCreateAbs.code === 2 && /repo-relative/.test(sdCreateAbs.out), "add-project --strategy-doc rejects an absolute path");
    // doctor W17: a project with repos but no strategyDoc
    // Use doctor.ts directly (not server.ts) — doctor.ts has no @modelcontextprotocol/sdk dependency
    // so it works in worktrees where node_modules may not be installed.
    const cfgLin = readJson(join(lin, "dev-loop.json"));
    delete cfgLin.projects.web.strategyDoc;
    writeFileSync(join(lin, "dev-loop.json"), JSON.stringify(cfgLin, null, 2) + "\n");
    const dW17Fire = run("doctor", [], { cwd: lin });
    ok(/\[W17\]/.test(dW17Fire.out) && /strategyDoc/.test(dW17Fire.out), "doctor W17 fires when a project has repos but no strategyDoc");
    // set strategyDoc → W17 goes silent
    run("team", ["set", "projects.web.strategyDoc", "docs/STRATEGY.md"], { cwd: lin });
    const dW17Clear = run("doctor", [], { cwd: lin });
    ok(!/\[W17\] projects\.web:/.test(dW17Clear.out), "doctor W17 is silent once strategyDoc is set");
  }

  // ── LOOP-288 / LOOP-301 / LOOP-135: the add-project write path ───────────────────────────────
  // One config key with two write paths had two validation contracts (`--weight 0x64` wrote 100
  // while `team set` on the same key refused it), and `--prefix` was not looked at until AFTER
  // dev-loop.json had been mutated — so a rejected prefix left a project the same command could no
  // longer complete. Both assert on the FILE, not on the message: an assertion on the message alone
  // passes against the old code, which also printed an error — after writing.
  {
    const gws = join(tmp, "guards-ws");
    const gcfg = join(gws, "dev-loop.json");
    const initG = run("team", ["init", "--dir", gws, "--key", "guards", "--backend", "service", "--yes"], { cwd: tmp });
    ok(initG.code === 0, `guards fixture: service workspace created (${initG.code})`);
    const hash = () => createHash("sha256").update(readFileSync(gcfg)).digest("hex");

    // (a) LOOP-288 — every non-plain-decimal literal is refused, and NOTHING is written.
    for (const lit of ["0x64", "0o144", "0b1100100", "1e2"]) {
      const before = hash();
      const r = run("team", ["add-project", `w-${lit}`, "--prefix", "WGT", "--weight", lit], { cwd: gws });
      ok(r.code !== 0, `LOOP-288: --weight ${lit} exits non-zero (${r.code})`);
      ok(hash() === before, `LOOP-288: --weight ${lit} writes NOTHING to dev-loop.json`);
      ok(/plain decimal/.test(r.out), `LOOP-288: --weight ${lit} gives the same answer \`team set\` gives`);
    }
    // Plain decimals are unchanged.
    const wOk = run("team", ["add-project", "wgood", "--prefix", "WGOOD", "--weight", "2.5"], { cwd: gws });
    ok(wOk.code === 0 && readJson(gcfg).projects.wgood?.weight === 2.5, "LOOP-288: a plain-decimal --weight still writes the same value");

    // (b) LOOP-301 — an out-of-shape --prefix is refused BEFORE the config write.
    const beforeShape = hash();
    const badShape = run("team", ["add-project", "shop", "--prefix", "loop"], { cwd: gws });
    ok(badShape.code !== 0, `LOOP-301: an out-of-shape --prefix exits non-zero (${badShape.code})`);
    ok(hash() === beforeShape, "LOOP-301: dev-loop.json is byte-unchanged after the rejection");
    ok(readJson(gcfg).projects.shop === undefined, "LOOP-301: no half-created project is left behind");
    // …and the SAME command can still complete afterwards — the point of the whole ticket.
    const retry = run("team", ["add-project", "shop", "--prefix", "SHOP"], { cwd: gws });
    ok(retry.code === 0 && readJson(gcfg).projects.shop !== undefined, "LOOP-301: the retry with a valid prefix succeeds (no 'already exists' wedge)");

    // (c) LOOP-301 — a CLASHING prefix is caught in the same place, on a service backend.
    const beforeClash = hash();
    const clash = run("team", ["add-project", "shop2", "--prefix", "SHOP"], { cwd: gws });
    ok(clash.code !== 0 && /already held by/.test(clash.out), `LOOP-301: a clashing --prefix is refused (${clash.code})`);
    ok(hash() === beforeClash, "LOOP-301: a clashing --prefix writes nothing either");

    // (d) LOOP-135 — no refusal on this path may tell the operator to hand-edit dev-loop.json.
    const HAND_EDIT = /edit dev-loop\.json/i;
    const dup = run("team", ["add-project", "shop", "--prefix", "SHOP3"], { cwd: gws });
    ok(dup.code !== 0 && !HAND_EDIT.test(dup.out), "LOOP-135: the duplicate-key refusal no longer says 'edit dev-loop.json'");
    const unsettable = run("team", ["set", "projects.shop.strategyDoc.nope", "x"], { cwd: gws });
    ok(unsettable.code !== 0 && !HAND_EDIT.test(unsettable.out), "LOOP-135: `team set`'s unsettable-path refusal no longer says 'edit dev-loop.json'");
    ok(/no operator-settable writer exists/.test(unsettable.out), "LOOP-135: it states plainly that no writer exists rather than implying a route");
    const otherMutator = run("team", ["set", "repos.rr.remote", "git@x:y.git"], { cwd: gws });
    ok(/team add-repo/.test(otherMutator.out) && !HAND_EDIT.test(otherMutator.out), "LOOP-135: a path another mutator owns names that exact command");

    // (e) LOOP-301 — a config-only project (no hub row) gets the recovery that actually applies.
    const cfgOnly = readJson(gcfg);
    cfgOnly.projects.orphan = { repos: [] };
    writeFileSync(gcfg, JSON.stringify(cfgOnly, null, 2) + "\n");
    const orphanDup = run("team", ["add-project", "orphan", "--prefix", "ORPH"], { cwd: gws });
    ok(/dev-loop seed orphan/.test(orphanDup.out), "LOOP-301: a config project with NO hub row is told to `dev-loop seed`, not to 'tune it'");
  }

  // ── LOOP-255: the remote-show-origin fallback finally gets exercised ─────────────────────────
  // LOOP-100 added defaultBranch detection with two rungs: `git symbolic-ref refs/remotes/origin/HEAD`
  // first, falling back to parsing `HEAD branch:` out of `git remote show origin`. All eight of its
  // tests drive it through `add-repo --detect --remote <url>`, which runs `git clone` — and clone
  // ALWAYS populates refs/remotes/origin/HEAD. So every existing test takes the symbolic-ref rung and
  // the fallback has never been executed by the suite.
  //
  // It is not a dead path: a repo created with `git remote add` + `git fetch` (rather than clone)
  // never gets origin/HEAD, which is a plausible onboarding shape — `add-repo --detect` against an
  // already-existing local checkout. Behaviour was verified correct by hand when the ticket was
  // filed; this is the coverage, so a refactor cannot silently delete the rung.
  {
    const fbRoot = join(tmp, "loop255");
    const originDir = join(fbRoot, "origin.git");
    const checkout = join(fbRoot, "checkout");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    const g = (dir: string, ...args: string[]) =>
      spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

    // A bare origin whose HEAD is a NON-default name, so a passing test cannot be explained by a
    // hardcoded "main"/"master" guess.
    spawnSync("git", ["init", "--bare", "-q", "-b", "trunk", originDir], { encoding: "utf8" });
    // Seed it through a throwaway clone, then build the real checkout WITHOUT clone.
    const seedDir = join(fbRoot, "seed");
    spawnSync("git", ["clone", "-q", originDir, seedDir], { encoding: "utf8" });
    g(seedDir, "commit", "--allow-empty", "-qm", "base");
    g(seedDir, "push", "-q", "origin", "trunk");

    spawnSync("git", ["init", "-q", "-b", "trunk", checkout], { encoding: "utf8" });
    g(checkout, "remote", "add", "origin", originDir);
    g(checkout, "fetch", "-q", "origin");

    // The precondition the whole ticket rests on: this checkout has NO origin/HEAD, so the first
    // rung cannot answer. Asserted, not assumed — if a future git starts setting it on fetch, this
    // test would otherwise silently go back to covering the rung it already covers.
    const sym = g(checkout, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    ok(sym.status !== 0,
      "LOOP-255 precondition: a remote-add + fetch checkout has NO refs/remotes/origin/HEAD (the symbolic-ref rung cannot answer)");

    const facts = detectRepoFacts(checkout);
    ok(facts.defaultBranch === "trunk",
      `LOOP-255: the 'git remote show origin' fallback reads the real HEAD branch (got ${JSON.stringify(facts.defaultBranch)}, want "trunk")`);

    // And the control: the SAME helper on a cloned checkout still answers from the fast first rung.
    const cloned = join(fbRoot, "cloned");
    spawnSync("git", ["clone", "-q", originDir, cloned], { encoding: "utf8" });
    ok(g(cloned, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").status === 0,
      "LOOP-255 control: a CLONED checkout does have origin/HEAD — which is why the fallback was never exercised");
    ok(detectRepoFacts(cloned).defaultBranch === "trunk",
      "LOOP-255 control: both rungs agree on the same repo");
  }

  console.log(fails === 0 ? "\nTEAM_EDIT_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  mockLinear.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

