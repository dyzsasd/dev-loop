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
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const r = spawnSync(cmd, args, { cwd: hubRoot, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
};

const tmp = mkdtempSync(join(tmpdir(), "dl-build-artifact-"));
try {
  // ── AC1: the publish/prepack build succeeds and emits BOTH compiled bin entry points ──
  const build = run("npm", ["run", "build"]);
  ok(build.code === 0, "npm run build → exit 0 (the publish/prepack build compiles dist/)");
  const distDir = join(hubRoot, "dist"), distCli = join(distDir, "cli.js"), distServer = join(distDir, "server.js"), distRunner = join(distDir, "run-agents.js");
  ok(existsSync(distCli) && existsSync(distServer), "dist/cli.js + dist/server.js emitted (the package's two bins)");
  ok(existsSync(distRunner), "dist/run-agents.js emitted (the built-in scheduler entry)");
  ok(existsSync(join(distDir, "plugin", "skills", "communication-agent", "SKILL.md")) && existsSync(join(distDir, "plugin", "references", "conventions.md")),
    "dist/plugin includes skills + references for npm-installed scheduler runs");

  // ── AC2/AC3: the compiled bins LOAD + RUN — proves the rewritten sibling .ts→.js imports resolve in the JS
  //    output, and the suite goes RED if the build breaks or a bin can't load. ──
  const ver = run(process.execPath, [distCli, "version"]);
  ok(ver.code === 0 && ver.stdout.trim() === pkgVersion, `compiled cli.js version → exit 0, == package.json (${pkgVersion})`);
  const db = join(tmp, "smoke.db");
  const seed = run(process.execPath, [distCli, "seed", "demo", "Demo", "DM"], { DEVLOOP_HUB_DB: db });
  ok(seed.code === 0, "compiled cli.js seed → exit 0 (compiled seed.js + db.js siblings load)");
  const doc = run(process.execPath, [distCli, "doctor"], { DEVLOOP_HUB_DB: db });
  ok(doc.code === 0 && /DOCTOR_OK/.test(doc.out), "compiled cli.js doctor → exit 0 + DOCTOR_OK (spawns compiled server.js; siblings resolve)");
  const runner = run(process.execPath, [distCli, "run", "--cli", "claude", "--once", "--dry-run", "--agents", "communication", "--root", repoRoot, "--data", tmp, "--hub-db", db, "--project", "demo", "--cwd", tmp]);
  ok(runner.code === 0 && /communication: claude -p '?<prompt:\d+ chars>'?/.test(runner.out), "compiled cli.js run → dry-run renders a scheduled claude fire");

  // ── installed-like layout: a COPY of dist/ OUTSIDE the repo, with NO config/ sibling (the package ships only
  //    `files:["dist/","README.md"]`). This is the exact `npm i -g dev-loop` shape; the two ENOENT-on-install bugs
  //    ONLY reproduce here (in-repo, `../../config` still resolves to the repo's real config/). ──
  const inst = join(tmp, "pkg"); // inst/dist/cli.js → here=inst/dist, hubDir=inst (no config/ sibling)
  cpSync(distDir, join(inst, "dist"), { recursive: true });
  const instCli = join(inst, "dist", "cli.js");
  const instRun = run(process.execPath, [instCli, "run", "--cli", "claude", "--once", "--dry-run", "--agents", "communication", "--data", tmp, "--hub-db", db, "--project", "demo", "--cwd", tmp]);
  ok(instRun.code === 0 && /communication: claude -p '?<prompt:\d+ chars>'?/.test(instRun.out),
    "installed cli.js run → finds bundled skills without --root");
  const promptsDir = join(tmp, "codex-prompts");
  const instPrompts = run(process.execPath, [instCli, "install-codex-prompts", "--dest", promptsDir, "--data", tmp]);
  ok(instPrompts.code === 0 && existsSync(join(promptsDir, "dev-loop-communication-agent.md")) && existsSync(join(promptsDir, "dev-loop-init.md")),
    "installed cli.js install-codex-prompts → writes Codex /prompts files from bundled skills");

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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? "\nBUILD_ARTIFACT_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
