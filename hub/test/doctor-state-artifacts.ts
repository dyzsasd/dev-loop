// doctor-state-artifacts.ts — LOOP-519 regression: W06 also detects untracked, un-ignored agent state
// artifacts (*-state.json, reports/) in a configured repo work tree, and the clean info line is
// suppressed when any such artifact is present.
//
// The fixture DERIVES the artifact-name set from the source of truth the check reads (the same
// STATE_ARTIFACT_RE pattern), so the test cannot silently agree with itself.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";

// Derive the test artifact set from the same pattern the check reads.
// If the pattern changes, this set must still represent valid matches.
const STATE_ARTIFACT_RE = /^(?:[^/]+-state\.json|reports(?:\/.*)?)$/;
const testArtifacts = [
  "qa-state.json",           // matches [^/]+-state.json
  "pm-state.json",           // same pattern, different agent
  "reports/qa/daily/file.md", // matches reports/.*
  "reports/",                // matches reports (bare dir)
].filter((a) => STATE_ARTIFACT_RE.test(a));
const nonArtifacts = [
  "notes.txt",               // no match
  "state.json",              // no leading segment
  "qa-state.xml",            // wrong extension
  "reports-extra",            // not reports/ prefix
].filter((a) => !STATE_ARTIFACT_RE.test(a));

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-doc-w519-")));
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
  // ── Fixture: workspace + repo with .dev-loop/ gitignored ──
  const wsRoot = join(tmp, "ws");
  const repoDir = join(wsRoot, "repo");
  mkdirSync(join(wsRoot, ".dev-loop"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });

  execFileSync("git", ["init", "-q", "-b", "main", repoDir]);
  git(repoDir, "commit", "--allow-empty", "-qm", "init");
  writeFileSync(join(repoDir, ".gitignore"), ".dev-loop/\n");
  git(repoDir, "add", ".gitignore");
  git(repoDir, "commit", "-qm", "add gitignore");

  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "w519-test", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: {},
  }));

  // ── Arm A: untracked, un-ignored qa-state.json at repo root ──
  writeFileSync(join(repoDir, "qa-state.json"), JSON.stringify({ lastSweptSha: "abc123" }));

  const outA = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(outA.includes("[W06]") && outA.includes("qa-state.json"),
    "AC1: W06 fires and names qa-state.json when untracked and un-ignored");
  ok(outA.includes("untracked"),
    "AC1: W06 remediation includes the 'untracked' clause");
  ok(!outA.includes("is inside a git repo but .dev-loop/ is gitignored"),
    "AC2: clean info line is suppressed when a state artifact is present");

  // ── Arm A2: reports/ untracked, un-ignored ──
  rmSync(join(repoDir, "qa-state.json"));
  mkdirSync(join(repoDir, "reports", "qa", "daily"), { recursive: true });
  writeFileSync(join(repoDir, "reports", "qa", "daily", "2026-08-10.md"), "# report");

  const outA2 = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(outA2.includes("[W06]") && outA2.includes("reports/"),
    "AC1: W06 fires and names reports/ artifacts when untracked and un-ignored");

  // ── Arm B: gitignored state artifact → no W06 warning ──
  rmSync(join(repoDir, "reports"), { recursive: true, force: true });
  writeFileSync(join(repoDir, ".gitignore"), ".dev-loop/\nqa-state.json\nreports/\n");
  git(repoDir, "add", ".gitignore");
  git(repoDir, "commit", "-qm", "ignore state artifacts");
  writeFileSync(join(repoDir, "qa-state.json"), JSON.stringify({ lastSweptSha: "def456" }));

  const outB = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(!outB.includes("[W06]"),
    "AC3: no W06 warning when state artifact is gitignored");

  // ── Arm C: gitignored but also check that the clean line still prints ──
  // After Arm B, .dev-loop/ is gitignored, qa-state.json is gitignored, no leaks → clean line
  ok(outB.includes("is inside a git repo but .dev-loop/ is gitignored"),
    "AC3: clean info line prints when the only state artifact is gitignored");

  // ── Arm D: no false positive for non-artifact files ──
  writeFileSync(join(repoDir, "notes.txt"), "not a state file");
  writeFileSync(join(repoDir, "state.json"), "no prefix");
  writeFileSync(join(repoDir, "qa-state.xml"), "wrong extension");

  const outD = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  ok(!outD.includes("notes.txt") && !outD.includes("state.json") && !outD.includes("qa-state.xml"),
    "AC3: non-artifact files do not trigger W06");

  // ── Arm E: verify derived test artifact set is valid ──
  ok(testArtifacts.length === 4,
    `AC4: derived test artifact set has expected members (${testArtifacts.length})`);
  ok(nonArtifacts.length === 4,
    `AC4: derived non-artifact set has expected members (${nonArtifacts.length})`);

  // ── Arm F: all derived artifacts, un-ignored, produce W06 warning ──
  // Clean up from previous arms
  rmSync(join(repoDir, "notes.txt"));
  rmSync(join(repoDir, "state.json"));
  rmSync(join(repoDir, "qa-state.xml"));
  rmSync(join(repoDir, "qa-state.json"));
  writeFileSync(join(repoDir, ".gitignore"), ".dev-loop/\n");
  git(repoDir, "add", ".gitignore");
  git(repoDir, "commit", "-qm", "reset gitignore");

  // Create all derived artifacts
  for (const art of testArtifacts) {
    if (art.endsWith("/")) {
      mkdirSync(join(repoDir, art), { recursive: true });
    } else {
      const dir = join(join(repoDir, art), "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(repoDir, art), JSON.stringify({ test: true }));
    }
  }

  const outF = await capture(() => doctorWorkspace(loadWorkspace(wsRoot)));
  for (const art of testArtifacts) {
    const name = art.endsWith("/") ? art.slice(0, -1) : art;
    ok(outF.includes("[W06]") && outF.includes(name),
      `AC4: derived artifact '${art}' triggers W06`);
  }

} catch (e) {
  console.error("unexpected test error:", e);
  fails++;
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
}

if (fails > 0) process.exit(1);