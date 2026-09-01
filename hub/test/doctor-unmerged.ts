// doctor-unmerged.ts — W26 regression: doctorWorkspace warns (not fails) on unmerged paths in
// the shared checkout, and stays silent on a clean tree. (LOOP-215)
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-doc-w26-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const capture = async (fn: () => unknown): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  const wsRoot = join(tmp, "ws");
  const repoDir = join(wsRoot, "repo");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  git(repoDir, "commit", "--allow-empty", "-qm", "init");

  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w26-test", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: {},
  }));

  // ── clean checkout: W26 must be silent ──
  const out1 = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(!out1.includes("[W26]"), "clean checkout → no W26 warning");
  ok(!out1.includes("❌"), "clean checkout → no failures");

  // ── introduce unmerged paths via a conflicting merge ──
  // Create file on main
  writeFileSync(join(repoDir, "file.txt"), "base\n");
  git(repoDir, "add", "file.txt");
  git(repoDir, "commit", "-qm", "add file");

  // branch-a changes the file
  git(repoDir, "checkout", "-qb", "branch-a");
  writeFileSync(join(repoDir, "file.txt"), "branch-a edit\n");
  git(repoDir, "add", "file.txt");
  git(repoDir, "commit", "-qm", "branch-a edit");
  git(repoDir, "checkout", "-q", "main");

  // main also changes the file → merge will conflict
  writeFileSync(join(repoDir, "file.txt"), "main edit\n");
  git(repoDir, "add", "file.txt");
  git(repoDir, "commit", "-qm", "main edit");

  try { git(repoDir, "merge", "--no-ff", "branch-a"); } catch { /* conflict expected */ }

  // confirm the conflict markers landed
  const st = execFileSync("git", ["-C", repoDir, "status", "--short"], { encoding: "utf8" });
  ok(st.includes("UU"), "test setup: git confirms unmerged paths (UU status)");

  // W26 must fire as a warning, never a failure
  const out2 = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(out2.includes("[W26]"), "unmerged paths → W26 warning fires");
  ok(!out2.includes("❌"), "W26 is warn-only: no ❌ failures");

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) process.exit(1);
