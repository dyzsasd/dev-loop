// doctor-git-tree-leaks.ts — LOOP-231 regression: W06 and the §17 db guard also scan every configured
// repo work tree (not just ws.root), and the reassuring "data home is outside any git repo" PASS is
// suppressed when a repo-local hub.db leak exists.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-doc-w231-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const capture = async (fn: () => Promise<unknown>): Promise<string> => {
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
    team: { key: "w231-test", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: {},
  }));

  // ── Arm A: root not a repo, repo IS a repo, un-ignored hub.db inside repo ──
  mkdirSync(join(repoDir, ".dev-loop"), { recursive: true });
  writeFileSync(join(repoDir, ".dev-loop", "hub.db"), "fake db content");
  writeFileSync(join(repoDir, ".dev-loop", "hub.db-wal"), "fake wal content");

  const out1 = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(out1.includes("[W06]") && out1.includes("repo 'repo'"),
    "W06 fires and names the repo tree when un-ignored hub.db sits inside a configured repo");

  // Clean up repo-level hub.db for Arm B
  rmSync(join(repoDir, ".dev-loop"), { recursive: true, force: true });

  // ── Arm B: repo with fully gitignored .dev-loop/ → clean ──
  mkdirSync(join(repoDir, ".dev-loop"), { recursive: true });
  writeFileSync(join(repoDir, ".dev-loop", "hub.db"), "fake db content");
  writeFileSync(join(repoDir, ".gitignore"), ".dev-loop/\n");

  const out2 = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(!out2.includes("[W06]"),
    "clean: no W06 warning when repo .dev-loop/ is gitignored");

  // ── LOOP-328: the rule is present but the DIRECTORY does not exist ──────────────────────────
  // `.dev-loop/` is a gitignore DIRECTORY rule, and `git check-ignore` can only match one when it
  // can establish the path IS a directory — which it cannot for a path that is not on disk. Arm B
  // above only ever probed with the directory present, so the false positive was invisible: W06
  // fired on a repo whose .gitignore already carried the rule, in exactly the window right after
  // the leaked directory was cleaned up. Three arms, because a fix that just stops warning is
  // indistinguishable from a fix that stopped detecting.
  rmSync(join(repoDir, ".dev-loop"), { recursive: true, force: true });
  const outAbsent = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(!outAbsent.includes("[W06]"),
    "LOOP-328: rule present + directory ABSENT ⇒ no W06 (the false positive)");

  mkdirSync(join(repoDir, ".dev-loop"), { recursive: true });
  writeFileSync(join(repoDir, ".dev-loop", "hub.db"), "fake db content");
  const outPresent = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(!outPresent.includes("[W06]"),
    "LOOP-328: rule present + directory PRESENT ⇒ still no W06 (unchanged)");

  writeFileSync(join(repoDir, ".gitignore"), "node_modules/\n"); // rule REMOVED
  const outNoRule = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(outNoRule.includes("[W06]"),
    "LOOP-328: rule MISSING ⇒ W06 still fires — detection did not regress");
} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

if (fails > 0) process.exit(1);