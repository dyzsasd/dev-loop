// P2-12: `dev-loop export-desktop-skill <agent> --project <key>` renders a SELF-CONTAINED SKILL.md
// (no ${CLAUDE_PLUGIN_ROOT} ref, config + conventions inlined) so an agent can run in Claude Desktop.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const here = dirname(fileURLToPath(import.meta.url)); // hub/test
const src = join(here, "..", "src", "export-desktop-skill.ts");
const repoRoot = join(here, "..", ".."); // the source checkout: has skills/ + references/
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = tmpRoot("dl-export-");
const data = join(tmp, "data"); mkdirSync(data, { recursive: true });
writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { demo: {
  backend: "linear", mode: "live", autonomy: "full", linearTeam: "T", linearProject: "P",
  git: { landing: "pr", autoMerge: true, mergeChecks: ["Lint & Build"] },
  testEnv: { baseUrl: "https://dev.example.com", authConstraint: "protected pages need login" },
  reports: { sink: "linear", linearProject: "R" },
} } }));
const out = join(tmp, "out"); mkdirSync(out, { recursive: true });

// LOOP-240: cwd outside the workspace blocks CWD walk-up; DEVLOOP_WORKSPACE sentinel blocks env-var resolution.
const r = spawnSync(process.execPath, [src, "qa", "--project", "demo", "--out", out], {
  encoding: "utf8",
  cwd: tmp,
  env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: "/dev/null/no-workspace", DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
});
ok(r.status === 0, "export exits 0");
const skillFile = join(out, "devloop-qa-demo", "SKILL.md");
ok(existsSync(skillFile), "writes devloop-qa-demo/SKILL.md");
const md = existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "";
ok(/^---\nname: devloop-qa-demo/.test(md), "frontmatter carries the skill name (Desktop trigger)");
ok(!/\$\{CLAUDE_PLUGIN_ROOT\}/.test(md), "no unresolved ${CLAUDE_PLUGIN_ROOT} ref (self-contained)");
ok(/## Conventions \(inlined/.test(md), "inlines the conventions appendix");
ok(/\n## 2\./.test(md) && /\n## 12b\./.test(md), "appendix includes the load-bearing sections (safety §2, landing §12b)");
ok(/dev\.example\.com/.test(md) && /landing.*:.*pr/.test(md), "inlines the project config facts (test env + landing)");
// LOOP-240: cwd outside the workspace + DEVLOOP_WORKSPACE sentinel — both axes blocked.
const noProj = spawnSync(process.execPath, [src, "qa"], { encoding: "utf8", cwd: tmp, env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: "/dev/null/no-workspace" } });
ok(noProj.status === 2 && /--project/.test(noProj.stderr ?? ""), "missing --project exits 2 with usage");

// A passive-intake project must carry its mode into the export — Desktop has no config access,
// so an un-inlined intake.mode would let an exported PM originate work the config forbids (§5a).
writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { demo: {
  backend: "linear", mode: "live", linearTeam: "T", linearProject: "P",
  intake: { mode: "passive" },
  testEnv: { baseUrl: "https://dev.example.com" },
} } }));
const rp = spawnSync(process.execPath, [src, "pm", "--project", "demo", "--out", out], {
  encoding: "utf8",
  cwd: tmp,
  env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: "/dev/null/no-workspace", DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
});
const pmMd = rp.status === 0 ? readFileSync(join(out, "devloop-pm-demo", "SKILL.md"), "utf8") : "";
ok(rp.status === 0 && /intake\.mode.*passive/.test(pmMd) && /originate NOTHING/.test(pmMd), "a passive project's export inlines intake.mode + the §5a posture");

// LOOP-187: no --out from inside a git working tree → must NOT drop artifact into the source tree.
// Use a temp git repo as cwd so the test is hermetic: it IS inside a git tree but NOT inside the
// dev-loop workspace (no dev-loop.json upward), preventing tryResolveWorkspace from finding the live config.
{
  const gitCwd = tmpRoot("dl-export-gitcwd-");
  spawnSync("git", ["init", "-q", "-b", "main", gitCwd], { stdio: "ignore" });
  spawnSync("git", ["-C", gitCwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { demo: {
    backend: "linear", mode: "live", autonomy: "full", linearTeam: "T", linearProject: "P",
    git: { landing: "pr" }, testEnv: { baseUrl: "https://dev.example.com" },
  } } }));
  // TMPDIR is redirected into this suite's own root. The branch under test is the one that CREATES a temp
  // directory as its deliverable — correctly, and production keeps doing exactly that — but the directory
  // is the operator's to collect, so nothing reaps it. Exercising it left one `dl-export-*` tree behind per
  // full-suite run, 17 of them on this machine, which tmp-root.ts cannot see because the mkdtemp lives in
  // hub/src. Pointing the CHILD's TMPDIR at a swept tree fixes the leak without touching the behaviour:
  // the assertion below still reads the `dl-export-` prefix, because the prefix is what changed nothing.
  const noOut = spawnSync(process.execPath, [src, "qa", "--project", "demo"], {
    encoding: "utf8",
    cwd: gitCwd, // inside a git tree but no dev-loop.json → workspace lookup fails → falls back to DEVLOOP_PROJECTS_JSON
    env: { ...scrubFireEnv(), TMPDIR: tmp, DEVLOOP_WORKSPACE: "/dev/null/no-workspace", DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
  });
  ok(noOut.status === 0, "no-out: exits 0 when cwd is git-tracked (LOOP-187)");
  ok((noOut.stdout + noOut.stderr).includes("dl-export-"), "no-out: message/path references the temp dir (LOOP-187)");
  // Verify nothing landed in the temp git cwd (the write went to a temp dir outside it)
  ok(!existsSync(join(gitCwd, "devloop-qa-demo")), "no-out: no devloop-qa-* artifact under the git cwd (LOOP-187)");
  // Explicit --out still writes to the given path, not a temp dir (AC4 — behavior unchanged)
  const withOut = spawnSync(process.execPath, [src, "qa", "--project", "demo", "--out", out], {
    encoding: "utf8",
    cwd: gitCwd,
    env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: "/dev/null/no-workspace", DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
  });
  ok(withOut.status === 0 && existsSync(join(out, "devloop-qa-demo", "SKILL.md")), "no-out: explicit --out still writes to the given path (LOOP-187 AC4)");
}

// ── LOOP-201: export-desktop-skill reads landing from a v2 workspace, not a .git sub-object ───────────
// A v2 workspace puts repo facts (landing/autoMerge/mergeChecks) in repos.<ref>, not on the project.
// The buggy code read (p as {git?}).git.landing — always {} → always "direct". The fix reads
// p.repos (already resolved by toLegacyView through effectiveRepo). Must fail on origin/main; pass here.
{
  const wsDir = tmpRoot("dl-export-loop201-");
  const repoDir = join(wsDir, "the-repo"); mkdirSync(repoDir, { recursive: true });
  spawnSync("git", ["init", "-b", "main", repoDir], { stdio: "ignore" });
  writeFileSync(join(wsDir, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "t201", backend: "linear", linearTeam: "T201" },
    repos: { "dev-loop": { path: "the-repo", landing: "pr", autoMerge: true, mergeChecks: ["Test (Node 23.6.0)", "Test (Node 24)"] } },
    projects: { "loop": { repos: [{ ref: "dev-loop", role: "primary" }] } },
  }));
  const wsOut = join(wsDir, "out"); mkdirSync(wsOut, { recursive: true });
  const envWs = { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsDir, DEVLOOP_PLUGIN_ROOT: repoRoot };
  const rWs = spawnSync(process.execPath, [src, "qa", "--project", "loop", "--out", wsOut], { encoding: "utf8", cwd: wsDir, env: envWs });
  const wsMd = rWs.status === 0 && existsSync(join(wsOut, "devloop-qa-loop", "SKILL.md"))
    ? readFileSync(join(wsOut, "devloop-qa-loop", "SKILL.md"), "utf8") : "";
  ok(rWs.status === 0, "LOOP-201: workspace export exits 0");
  ok(/\*\*landing\*\*: pr/.test(wsMd),
    "LOOP-201 AC1: landing renders 'pr', not the buggy constant 'direct'");
  ok(/\*\*landing\*\*:.*autoMerge/.test(wsMd),
    "LOOP-201 AC1: autoMerge annotation is on the landing line (not just in conventions text)");
  ok(/mergeChecks.*Test.*Node/.test(wsMd),
    "LOOP-201 AC1: mergeChecks list present");
  ok(!/\*\*landing\*\*: direct/.test(wsMd),
    "LOOP-201 AC1: the literal '**landing**: direct' does NOT appear");

  // AC3: a repo with no landing set → "direct" default preserved
  writeFileSync(join(wsDir, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "t201b", backend: "linear", linearTeam: "T201B" },
    repos: { "r": { path: "the-repo" } },
    projects: { "p": { repos: [{ ref: "r", role: "primary" }] } },
  }));
  const rDef = spawnSync(process.execPath, [src, "qa", "--project", "p", "--out", wsOut], { encoding: "utf8", cwd: wsDir, env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsDir, DEVLOOP_PLUGIN_ROOT: repoRoot } });
  const defMd = rDef.status === 0 && existsSync(join(wsOut, "devloop-qa-p", "SKILL.md"))
    ? readFileSync(join(wsOut, "devloop-qa-p", "SKILL.md"), "utf8") : "";
  ok(rDef.status === 0, "LOOP-201 AC3: a repo with no landing set exports without error");
  ok(/\*\*landing\*\*: direct/.test(defMd),
    "LOOP-201 AC3: no-landing repo → 'direct' default is preserved");

  // AC4: empty repos[] → "direct", no throw
  writeFileSync(join(wsDir, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "t201c", backend: "linear", linearTeam: "T201C" },
    repos: {}, projects: { "w20proj": { repos: [] } },
  }));
  const rEmpty = spawnSync(process.execPath, [src, "qa", "--project", "w20proj", "--out", wsOut], { encoding: "utf8", cwd: wsDir, env: { ...scrubFireEnv(), DEVLOOP_WORKSPACE: wsDir, DEVLOOP_PLUGIN_ROOT: repoRoot } });
  ok(rEmpty.status === 0, "LOOP-201 AC4: empty repos[] exports without throwing");
  const emptyMd = rEmpty.status === 0 && existsSync(join(wsOut, "devloop-qa-w20proj", "SKILL.md"))
    ? readFileSync(join(wsOut, "devloop-qa-w20proj", "SKILL.md"), "utf8") : "";
  ok(/\*\*landing\*\*: direct/.test(emptyMd),
    "LOOP-201 AC4: empty repos[] renders 'direct' (documented default)");
}

console.log(fails === 0 ? "\nEXPORT_DESKTOP_SKILL_OK" : `\n${fails} FAILED — run: node hub/src/export-desktop-skill.ts <agent> --project <key>`);
process.exit(fails === 0 ? 0 : 1);
