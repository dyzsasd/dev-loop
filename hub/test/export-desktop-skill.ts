// P2-12: `dev-loop export-desktop-skill <agent> --project <key>` renders a SELF-CONTAINED SKILL.md
// (no ${CLAUDE_PLUGIN_ROOT} ref, config + conventions inlined) so an agent can run in Claude Desktop.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const r = spawnSync(process.execPath, [src, "qa", "--project", "demo", "--out", out], {
  encoding: "utf8",
  env: { ...process.env, DEVLOOP_PLUGIN_ROOT: repoRoot, DEVLOOP_PROJECTS_JSON: join(data, "projects.json") },
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
const noProj = spawnSync(process.execPath, [src, "qa"], { encoding: "utf8" });
ok(noProj.status === 2 && /--project/.test(noProj.stderr ?? ""), "missing --project exits 2 with usage");

console.log(fails === 0 ? "\nEXPORT_DESKTOP_SKILL_OK" : `\n${fails} FAILED — run: node hub/src/export-desktop-skill.ts <agent> --project <key>`);
process.exit(fails === 0 ? 0 : 1);
