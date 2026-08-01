// P2-12: `dev-loop export-desktop-skill <agent> --project <key>` renders a SELF-CONTAINED SKILL.md
// (no ${CLAUDE_PLUGIN_ROOT} ref, config + conventions inlined) so an agent can run in Claude Desktop.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";

const here = dirname(fileURLToPath(import.meta.url)); // hub/test
const src = join(here, "..", "src", "export-desktop-skill.ts");
const repoRoot = join(here, "..", ".."); // the source checkout: has skills/ + references/
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = mkdtempSync(join(tmpdir(), "dl-export-"));
const data = join(tmp, "data"); mkdirSync(data, { recursive: true });
writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { demo: {
  backend: "linear", mode: "live", autonomy: "full", linearTeam: "T", linearProject: "P",
  git: { landing: "pr", autoMerge: true, mergeChecks: ["Lint & Build"] },
  testEnv: { baseUrl: "https://dev.example.com", authConstraint: "protected pages need login" },
  reports: { sink: "linear", linearProject: "R" },
} } }));
const out = join(tmp, "out"); mkdirSync(out, { recursive: true });

// LOOP-240: cwd must be outside the workspace so CWD walk-up can't resolve the live dev-loop.json.
const r = spawnSync(process.execPath, [src, "qa", "--project", "demo", "--out", out], {
  encoding: "utf8",
  cwd: tmp,
  env: { ...scrubFireEnv(), DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
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
// LOOP-240: cwd must be outside the workspace so that tryResolveWorkspace can't supply a default project.
const noProj = spawnSync(process.execPath, [src, "qa"], { encoding: "utf8", cwd: tmp, env: scrubFireEnv() });
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
  env: { ...scrubFireEnv(), DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
});
const pmMd = rp.status === 0 ? readFileSync(join(out, "devloop-pm-demo", "SKILL.md"), "utf8") : "";
ok(rp.status === 0 && /intake\.mode.*passive/.test(pmMd) && /originate NOTHING/.test(pmMd), "a passive project's export inlines intake.mode + the §5a posture");

// LOOP-187: no --out from inside a git working tree → must NOT drop artifact into the source tree.
// Use a temp git repo as cwd so the test is hermetic: it IS inside a git tree but NOT inside the
// dev-loop workspace (no dev-loop.json upward), preventing tryResolveWorkspace from finding the live config.
{
  const gitCwd = mkdtempSync(join(tmpdir(), "dl-export-gitcwd-"));
  spawnSync("git", ["init", "-q", "-b", "main", gitCwd], { stdio: "ignore" });
  spawnSync("git", ["-C", gitCwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"], { stdio: "ignore" });
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { demo: {
    backend: "linear", mode: "live", autonomy: "full", linearTeam: "T", linearProject: "P",
    git: { landing: "pr" }, testEnv: { baseUrl: "https://dev.example.com" },
  } } }));
  const noOut = spawnSync(process.execPath, [src, "qa", "--project", "demo"], {
    encoding: "utf8",
    cwd: gitCwd, // inside a git tree but no dev-loop.json → workspace lookup fails → falls back to DEVLOOP_PROJECTS_JSON
    env: { ...scrubFireEnv(), DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
  });
  ok(noOut.status === 0, "no-out: exits 0 when cwd is git-tracked (LOOP-187)");
  ok((noOut.stdout + noOut.stderr).includes("dl-export-"), "no-out: message/path references the temp dir (LOOP-187)");
  // Verify nothing landed in the temp git cwd (the write went to a temp dir outside it)
  ok(!existsSync(join(gitCwd, "devloop-qa-demo")), "no-out: no devloop-qa-* artifact under the git cwd (LOOP-187)");
  // Explicit --out still writes to the given path, not a temp dir (AC4 — behavior unchanged)
  const withOut = spawnSync(process.execPath, [src, "qa", "--project", "demo", "--out", out], {
    encoding: "utf8",
    cwd: gitCwd,
    env: { ...scrubFireEnv(), DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
  });
  ok(withOut.status === 0 && existsSync(join(out, "devloop-qa-demo", "SKILL.md")), "no-out: explicit --out still writes to the given path (LOOP-187 AC4)");
}

console.log(fails === 0 ? "\nEXPORT_DESKTOP_SKILL_OK" : `\n${fails} FAILED — run: node hub/src/export-desktop-skill.ts <agent> --project <key>`);
process.exit(fails === 0 ? 0 : 1);
