// doctor-build-commit.ts — LOOP-250 regression: W18 uses the build-commit stamp when present
// instead of inferring what code is running from the version STRING.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-doc-w250-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const capture = async (fn: () => Promise<unknown>): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

function buildFixture(): { wsRoot: string; tagCommit: string; headCommit: string } {
  const wsRoot = join(tmp, "ws");
  const repoDir = join(wsRoot, "repo");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main", repoDir], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "tag", "v1.0.0", "HEAD"], { stdio: "ignore" });
  const tagCommit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // The behind-commit must be CODE-BEARING: W18 counts packaged-path commits only (LOOP-151),
  // and an --allow-empty commit touches no path, so codeBehind stays 0 and W18 never fires —
  // the original fixture made Arms B/C unpassable by construction (masked while main's CI was
  // red at the audit step, 2026-08-04).
  writeFileSync(join(repoDir, "src-fix.ts"), "// code change after tag\n");
  execFileSync("git", ["-C", repoDir, "add", "src-fix.ts"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix: after tag"], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "branch", "origin/main", "HEAD"], { stdio: "ignore" });
  const headCommit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w250-test", backend: "service" },
    repos: { repo: { path: "repo", landing: "pr", remote: "https://github.com/dyzsasd/dev-loop" } },
    projects: {},
  }));
  return { wsRoot, tagCommit, headCommit };
}

try {
  const { wsRoot, tagCommit, headCommit } = buildFixture();
  const ws = loadWorkspace(wsRoot);

  // Inject a fake package.json so W18 reads it
  const pkgDir = join(tmp, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  const pkgJsonPath = join(pkgDir, "package.json");
  process.env.DEVLOOP_W18_PKG_JSON = pkgJsonPath;

  // ── Arm A: source build at HEAD (stamp === HEAD) → no W18 ──
  writeFileSync(pkgJsonPath, JSON.stringify({
    name: "@dyzsasd/dev-loop", version: "1.0.0",
    repository: "https://github.com/dyzsasd/dev-loop",
  }));
  writeFileSync(join(pkgDir, "build-commit.json"), JSON.stringify({ commit: headCommit }));
  // Also create hub/package.json so code-pathspec resolution works
  mkdirSync(join(pkgDir, "hub"), { recursive: true });
  writeFileSync(join(pkgDir, "hub", "package.json"), JSON.stringify({ files: ["dist/"] }));

  const out1 = await capture(() => doctorWorkspace(ws, {}));
  ok(!out1.includes("[W18]"), "Arm A: source build at HEAD — no W18 warning");

  // ── Arm B: source build behind origin (stamp === tag) → W18 fires ──
  writeFileSync(join(pkgDir, "build-commit.json"), JSON.stringify({ commit: tagCommit }));

  const out2 = await capture(() => doctorWorkspace(ws, {}));
  ok(out2.includes("[W18]"), "Arm B: source build behind origin — W18 fires");

  // ── Arm C: no stamp (npm install), tag behind → W18 fires (regression guard) ──
  try { rmSync(join(pkgDir, "build-commit.json")); } catch {}

  const out3 = await capture(() => doctorWorkspace(ws, {}));
  ok(out3.includes("[W18]"), "Arm C: npm install behind — W18 fires (regression guard)");

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  delete process.env.DEVLOOP_W18_PKG_JSON;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) process.exit(1);