#!/usr/bin/env node
// `dev-loop export-desktop-skill <agent> --project <key> [--out <dir>] [--zip]` (P2-12).
// Renders a SELF-CONTAINED Agent Skill (SKILL.md) for Claude Desktop from the canonical plugin
// SKILL + the load-bearing conventions sections + the project's config, so a human can run e.g.
// QA in Desktop (with the Linear connector + the Chrome extension) without the Claude Code plugin.
// Regenerate after any conventions/config change so the Desktop copy never drifts.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { tryResolveWorkspace } from "./workspace.ts";
import { toLegacyView } from "./team-config.ts";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)

// ---- args ----
const argv = process.argv.slice(2);
const agentArg = argv.find((a) => !a.startsWith("-"));
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);
const project = flag("--project") ?? process.env.DEVLOOP_PROJECT;
if (!agentArg || !project) {
  console.error("usage: dev-loop export-desktop-skill <agent> --project <key> [--team] [--out <dir>] [--zip]\n  e.g. dev-loop export-desktop-skill qa --project devplatform --team --zip");
  process.exit(2);
}
const agent = agentArg.replace(/-agent$/, ""); // accept "qa" or "qa-agent"
const outDir = resolve(flag("--out") ?? process.cwd());

// ---- resolve the plugin payload root (skills/ + references/) ----
const pluginRoot = (() => {
  for (const c of [process.env.DEVLOOP_PLUGIN_ROOT, process.env.CLAUDE_PLUGIN_ROOT, resolve(here, ".."), resolve(here, "..", "..")]) {
    if (c && existsSync(join(c, "skills")) && existsSync(join(c, "references"))) return c;
  }
  console.error("export-desktop-skill: could not find the plugin payload (skills/ + references/). Set DEVLOOP_PLUGIN_ROOT.");
  process.exit(1);
})();

const skillPath = join(pluginRoot, "skills", `${agent}-agent`, "SKILL.md");
if (!existsSync(skillPath)) { console.error(`export-desktop-skill: no skill at ${skillPath}`); process.exit(1); }

// ---- resolve + read the project config (schema v2 workspace first, else legacy projects.json) ----
// A discoverable workspace is authoritative; --team renders sibling-project context alongside the skill.
const ws = tryResolveWorkspace();
let p: Record<string, unknown> | undefined;
let cfgSource: string;
let teamContext = "";
if (ws) {
  p = toLegacyView(ws).projects[project] as Record<string, unknown> | undefined;
  cfgSource = `workspace '${ws.file.team.key}' (${ws.filePath})`;
  if (has("--team")) {
    const siblings = Object.keys(ws.file.projects).filter((k) => k !== project && k !== "_team");
    teamContext = `\n## Team context\n- **team**: ${ws.file.team.key} · **backend**: ${ws.file.team.backend}\n- **sibling projects**: ${siblings.length ? siblings.join(", ") : "(none)"}\n- This export is for **${project}** only; coordinate cross-project work through the team intake, not here.\n`;
  }
} else {
  const projectsJson = process.env.DEVLOOP_PROJECTS_JSON ?? join(process.env.DEVLOOP_DATA_DIR ?? join(homedir(), ".dev-loop"), "projects.json");
  const cfg = existsSync(projectsJson) ? (JSON.parse(readFileSync(projectsJson, "utf8")) as { projects?: Record<string, Record<string, unknown>> }) : { projects: {} };
  p = cfg.projects?.[project];
  cfgSource = projectsJson;
}
if (!p) { console.error(`export-desktop-skill: project '${project}' not in ${cfgSource}`); process.exit(1); }

// ---- parse the canonical SKILL frontmatter + body ----
const raw = readFileSync(skillPath, "utf8");
const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
const canonicalBody = (fm ? fm[2] : raw)
  // the one external ref the plugin uses — replace with a pointer to the inlined appendix.
  .replace(/`?\$\{CLAUDE_PLUGIN_ROOT\}\/references\/conventions\.md`?/g, "the **Conventions (inlined)** appendix at the end of this skill");

// ---- extract the load-bearing conventions sections ----
const conventions = readFileSync(join(pluginRoot, "references", "conventions.md"), "utf8");
const WANT = new Set(["0", "2", "3", "4", "5", "6", "8", "9", "10", "12", "12a", "12b", "12c", "22", "23"]);
const sections = conventions.split(/\n(?=## )/).filter((s) => {
  const m = s.match(/^## (\d+[a-z]?)\./);
  return m && WANT.has(m[1]);
});

// ---- project facts (only the ones the agent needs; skip secrets) ----
const j = (v: unknown): string => (v === undefined || v === null ? "—" : typeof v === "string" ? v : JSON.stringify(v));
const g = (p as { git?: Record<string, unknown> }).git ?? {};
const te = (p as { testEnv?: Record<string, unknown> }).testEnv ?? {};
const rep = (p as { reports?: Record<string, unknown> }).reports ?? {};
const intake = (p as { intake?: { mode?: string } }).intake ?? {};
const facts = [
  `- **backend**: ${j(p.backend ?? "linear")}  ·  **mode**: ${j(p.mode)}  ·  **autonomy**: ${j(p.autonomy)}  ·  **devSplit**: ${j(p.devSplit)}${intake.mode ? `  ·  **intake.mode**: ${j(intake.mode)}${intake.mode === "passive" ? " (§5a — originate NOTHING; respond to explicit needs-pm intake only)" : ""}` : ""}`,
  `- **Linear**: team ${j(p.linearTeam)} · project ${j(p.linearProject)} · firewall label \`dev-loop\` (scope EVERY query to it + the project)`,
  `- **test env**: ${j(te.baseUrl)}${te.testCommand ? ` · testCommand ${j(te.testCommand)}` : ""}`,
  te.notes ? `- **test-env notes**: ${j(te.notes)}` : "",
  te.authConstraint ? `- **auth constraint**: ${j(te.authConstraint)}` : "",
  `- **landing**: ${j(g.landing ?? "direct")}${g.autoMerge ? ` (autoMerge; mergeChecks ${j(g.mergeChecks)})` : ""}`,
  rep.sink === "linear" ? `- **reports**: published to the Linear project ${j(rep.linearProject)} (one rolling doc per agent; 点评 = an operator comment starting with the reviewToken)` : `- **reports**: machine-local files (this Desktop run may skip report writing)`,
].filter(Boolean).join("\n");

const Agent = agent.charAt(0).toUpperCase() + agent.slice(1);
const skillName = `devloop-${agent}-${project}`;
const rendered = `---
name: ${skillName}
description: >-
  Act as the dev-loop ${Agent} agent for the "${project}" project in Claude Desktop. Coordinates
  with the other dev-loop agents purely through Linear ticket state (scoped to the \`dev-loop\`
  label). Requires the Linear connector; ${agent === "qa" ? "and the Claude Chrome extension logged into the test env for browser checks." : "exercise the product per the project config below."}
---

# dev-loop ${Agent} — ${project} (Claude Desktop export)

> Self-contained export generated by \`dev-loop export-desktop-skill ${agent} --project ${project}\`.
> Desktop has no access to the plugin or \`projects.json\`, so the project config + the conventions
> sections this agent loads are inlined below. **Regenerate after any conventions/config change.**
> Prerequisites: the **Linear connector** (authorize the same workspace)${agent === "qa" ? ", and the **Claude Chrome extension** logged into the test env (for authed-UI checks)" : ""}.

## Project config (inlined)
${facts}
${teamContext}
## Agent instructions
${canonicalBody.trim()}

---

## Conventions (inlined — the sections this agent loads)
${sections.join("\n\n").trim()}
`;

// ---- write the skill folder (+ optional zip) ----
const folder = join(outDir, skillName);
mkdirSync(folder, { recursive: true });
writeFileSync(join(folder, "SKILL.md"), rendered);
console.log(`✓ wrote ${join(folder, "SKILL.md")} (${rendered.split("\n").length} lines)`);

if (has("--zip")) {
  const zipPath = join(outDir, `${skillName}.zip`);
  rmSync(zipPath, { force: true });
  const r = spawnSync("zip", ["-r", "-q", zipPath, skillName, "-x", "*.DS_Store"], { cwd: outDir, stdio: "inherit" });
  if (r.status === 0) console.log(`✓ zipped ${zipPath} — upload it in Claude Desktop → Settings → Capabilities → Skills`);
  else console.error(`(zip failed — the folder ${basename(folder)} is still usable; zip it manually)`);
}
