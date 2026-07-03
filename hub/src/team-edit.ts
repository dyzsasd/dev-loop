#!/usr/bin/env node
// `dev-loop team add-project` / `add-repo` / `set` — the DETERMINISTIC, VALIDATED config mutators the
// operator skills call to persist (design impl §10). The skills (add-project/add-repo, run in a coding
// CLI) do the discovery / interview / backend MCP writes; the actual dev-loop.json edit goes through here
// so a config is NEVER hand-edited into an invalid state — every write re-validates the whole file first.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "./workspace.ts";
import { validateTeamFile, referencingProjects, type TeamFile, type Workspace } from "./team-config.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop team: ${msg}`); process.exit(code); }

// Load the workspace, apply a mutation to a deep copy of the file, validate, and write on success.
function mutate(apply: (file: TeamFile, ws: Workspace) => void): Workspace {
  const ws = resolveWorkspace();
  const file: TeamFile = JSON.parse(JSON.stringify(ws.file));
  apply(file, ws);
  const { errors } = validateTeamFile(file);
  if (errors.length) die("the edit would make dev-loop.json invalid:\n" + errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join("\n"), 1);
  writeFileSync(ws.filePath, JSON.stringify(file, null, 2) + "\n");
  return { ...ws, file };
}

// ── add-project ───────────────────────────────────────────────────────────────
export function addProject(argv: string[]): number {
  const [key, ...rest] = argv;
  if (!key || key.startsWith("--")) die("usage: dev-loop team add-project <key> [--linear-project <name>] [--linear-project-id <id>] [--test-url <url>] [--dev-split] [--weight <n>] [--enabled true|false]");
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--linear-project") o.linearProject = next();
    else if (a === "--linear-project-id") o.linearProjectId = next();
    else if (a === "--test-url") o.testUrl = next();
    else if (a === "--dev-split") o.devSplit = true;
    else if (a === "--weight") o.weight = next();
    else if (a === "--enabled") o.enabled = next();
    else die(`unknown option '${a}'`);
  }
  const ws = mutate((file) => {
    if (file.projects[key]) die(`project '${key}' already exists — use \`dev-loop team set project ${key} …\` or edit dev-loop.json`);
    const p: TeamFile["projects"][string] = { repos: [] };
    if (o.linearProject) p.linearProject = o.linearProject as string;
    if (o.linearProjectId) p.linearProjectId = o.linearProjectId as string;
    if (o.testUrl) p.testEnv = { baseUrl: o.testUrl as string };
    if (o.devSplit) p.devSplit = true;
    if (o.weight !== undefined) p.weight = Number(o.weight);
    if (o.enabled !== undefined) p.enabled = o.enabled === "true" || o.enabled === true;
    file.projects[key] = p;
  });
  console.log(`added project '${key}' to ${ws.filePath} (0 repos — add one with \`dev-loop team add-repo\`)`);
  return 0;
}

// ── add-repo ──────────────────────────────────────────────────────────────────
export function addRepo(argv: string[]): number {
  const [ref, ...rest] = argv;
  if (!ref || ref.startsWith("--")) die("usage: dev-loop team add-repo <ref> --project <key> [--path <rel>] [--role primary|docs] [--remote <url>] [--owner <proj>] [--landing pr|direct] [--auto-merge] [--merge-check <name>]... [--typecheck-cmd <c>] [--build-cmd <c>] [--deploy-style <s>] [--ops-check <url>]...");
  const o: Record<string, unknown> = { mergeChecks: [] as string[], opsChecks: [] as string[] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i] ?? die(`${a} requires a value`);
    if (a === "--project") o.project = next();
    else if (a === "--path") o.path = next();
    else if (a === "--role") o.role = next();
    else if (a === "--remote") o.remote = next();
    else if (a === "--owner") o.owner = next();
    else if (a === "--landing") o.landing = next();
    else if (a === "--auto-merge") o.autoMerge = true;
    else if (a === "--merge-check") (o.mergeChecks as string[]).push(next());
    else if (a === "--typecheck-cmd") o.typecheck = next();
    else if (a === "--build-cmd") o.build = next();
    else if (a === "--deploy-style") o.deployStyle = next();
    else if (a === "--ops-check") (o.opsChecks as string[]).push(next());
    else die(`unknown option '${a}'`);
  }
  const project = o.project as string | undefined;
  if (!project) die("--project <key> is required (which project references this repo)");

  const ws = mutate((file) => {
    if (!file.projects[project]) die(`project '${project}' does not exist — add it first with \`dev-loop team add-project ${project}\``);
    // Registry entry: create if new; if the ref already exists we're only adding a reference from another project.
    if (!file.repos[ref]) {
      if (!o.path) die(`repo '${ref}' is not registered yet — pass --path <workspace-relative-path>`);
      const entry: TeamFile["repos"][string] = { path: o.path as string };
      if (o.remote) entry.remote = o.remote as string;
      if (o.owner) entry.owner = o.owner as string;
      if (o.landing) entry.landing = o.landing as "pr" | "direct";
      if (o.autoMerge) entry.autoMerge = true;
      if ((o.mergeChecks as string[]).length) entry.mergeChecks = o.mergeChecks as string[];
      if (o.typecheck || o.build) entry.build = { ...(o.typecheck ? { typecheck: o.typecheck as string } : {}), ...(o.build ? { build: o.build as string } : {}) };
      if (o.deployStyle) entry.deploy = { style: o.deployStyle as string, environments: {} };
      if ((o.opsChecks as string[]).length) entry.ops = { checks: o.opsChecks as string[] };
      file.repos[ref] = entry;
    } else if (o.owner) {
      file.repos[ref].owner = o.owner as string; // updating owner on an existing shared repo
    }
    // Project reference edge.
    const refs = file.projects[project].repos ?? (file.projects[project].repos = []);
    if (!refs.some((r) => r.ref === ref)) refs.push({ ref, ...(o.role ? { role: o.role as string } : {}) });
  });
  const shared = referencingProjects(ws, ref);
  console.log(`registered repo '${ref}'${o.path ? ` (${o.path})` : ""} under project '${project}'${shared.length > 1 ? ` — now shared by ${shared.join(", ")} (owner: ${ws.file.repos[ref].owner ?? "?"})` : ""}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "add-project") process.exit(addProject(rest));
  if (sub === "add-repo") process.exit(addRepo(rest));
  console.error("usage: team-edit add-project|add-repo …"); process.exit(2);
}
