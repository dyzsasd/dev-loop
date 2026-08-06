#!/usr/bin/env node
// `dev-loop conventions --agent <a>` — the PULL-mode selective read (LOOP-237, LOOP-228 Lever 1).
//
// The §0a corpus had exactly one delivery path: PUSH, appended to the prompt by
// `assembleBootCorpus`. That path is a net loss on cost — it ships the whole union on every fire
// whether the agent reads it or not, and conventions is 75% of context at a measured $4.79/fire.
//
// This is the other half: the SAME config-pruned slice, delivered on demand. An agent that needs
// §12c reads §12c; an agent that needs nothing pays nothing. Nothing about the push path changes,
// and the runner directive that points agents here defaults OFF, so a fire's prompt is byte-identical
// to today unless a team turns it on.
//
// The slice is computed from the SAME functions the boot corpus and the context bill use —
// `parseSectionsLine` for the agent's declared anchors, `CONDITIONAL_SECTIONS` for the config prune,
// `conventionsUnionText` for the span math. Three definitions of "this agent's conventions slice"
// is how a compression win silently regrows somewhere it is not being measured.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { splitSkill, parseSectionsLine } from "./context-bill.ts";
import { CONDITIONAL_SECTIONS, conventionsUnionText } from "./boot-prefix.ts";
import { tryResolveWorkspace } from "./workspace.ts";
import { effectiveRepo, effectiveProject, deliveryProjects, type Workspace } from "./team-config.ts";

export interface ConventionsSlice {
  agent: string;
  anchors: string[];      // every anchor the agent's SKILL declares
  pruned: string[];       // those dropped because the feature is off in this workspace
  kept: string[];         // anchors + always-read, minus pruned
  text: string;
  bytes: number;
  effectiveSpans: number;
}

/** The repo fact objects the CONDITIONAL_SECTIONS predicates read, for a project. */
function reposOf(ws: Workspace, key: string): Record<string, unknown>[] {
  const p = ws.file.projects[key];
  return (p?.repos ?? []).map((r) => {
    try { return effectiveRepo(ws, r.ref) as unknown as Record<string, unknown>; } catch { return null; }
  }).filter((x): x is Record<string, unknown> => x !== null);
}

/**
 * The config-pruned conventions slice for one agent, in THIS workspace.
 *
 * `pruned` is decided by the same predicates the boot corpus uses, over the same repo facts — so a
 * span that is off for a fire is off here, and a span that is kept is kept. A drift between the two
 * would mean an agent reading conventions that its own fire was told not to have.
 */
export function conventionsSlice(root: string, agent: string, ws: Workspace | null, projectKey?: string): ConventionsSlice {
  const skillRaw = readFileSync(join(root, "skills", `${agent}-agent`, "SKILL.md"), "utf8");
  const sec = parseSectionsLine(splitSkill(skillRaw.replace(/^---\n[\s\S]*?\n---\n/, "")).prose);
  if (sec.errors.length) throw new Error(`${agent}: malformed Sections line — ${sec.errors.join("; ")}`);

  // Resolve the project the same way a fire would: the named one, else the first delivery project.
  const key = projectKey ?? (ws ? deliveryProjects(ws)[0] : undefined);
  const cfg = ws && key ? (effectiveProject(ws, key) as unknown as Record<string, unknown>) : undefined;
  const backend = (ws?.file.team.backend as string) ?? "service";
  const groups = ws && key ? [reposOf(ws, key)] : [[]];
  const repos = groups.flat();
  const maxPerProject = groups.reduce((m, g) => Math.max(m, g.length), 0);

  const pruned = sec.anchors.filter((a) => CONDITIONAL_SECTIONS[a] && !CONDITIONAL_SECTIONS[a].active(cfg, backend, repos, maxPerProject));
  const conv = conventionsUnionText(readFileSync(join(root, "references", "conventions.md"), "utf8"), sec.anchors, new Set(pruned));
  return {
    agent,
    anchors: [...sec.anchors],
    pruned,
    kept: sec.anchors.filter((a) => !pruned.includes(a)),
    text: conv.text,
    bytes: conv.bytes,
    effectiveSpans: conv.effectiveSpans,
  };
}

function usage(): void {
  console.log(`dev-loop conventions --agent <agent> [--project <key>] [--root <dir>] [--json]

The config-pruned §0a conventions slice for ONE agent, on demand — the PULL half of the delivery
path. Prints always-read + the agent's cited spans, minus every span whose feature is off in this
workspace.

  --agent    required; the agent handle (pm, qa, senior-dev, junior-dev, sweep, …)
  --project  which project's config decides the prune (default: the first delivery project)
  --json     { agent, anchors, pruned, kept, bytes, effectiveSpans, text }

The prune uses the SAME predicates the boot corpus uses, so a span that is off for a fire is off
here too — a drift would mean an agent reading conventions its own fire was told not to have.`);
}

export function conventionsCmd(argv = process.argv.slice(2)): number {
  let agent = "", project: string | undefined, root: string | undefined, asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--agent") agent = argv[++i] ?? "";
    else if (a === "--project") project = argv[++i];
    else if (a === "--root") root = argv[++i];
    else if (a === "--json") asJson = true;
    else { console.error(`dev-loop conventions: unknown flag '${a}'`); return 2; }
  }
  if (!agent) { console.error("dev-loop conventions: --agent <agent> is required"); usage(); return 2; }
  const ws = tryResolveWorkspace();
  const r = root ?? ws?.root ?? process.cwd();
  let slice: ConventionsSlice;
  try { slice = conventionsSlice(r, agent, ws, project); }
  catch (e) { console.error(`dev-loop conventions: ${(e as Error).message}`); return 1; }
  if (asJson) { console.log(JSON.stringify(slice, null, 2)); return 0; }
  console.log(slice.text);
  // The accounting goes to stderr so `dev-loop conventions --agent x > slice.md` stays clean.
  console.error(`\n[conventions] ${slice.agent}: ${slice.effectiveSpans} span(s), ${slice.bytes} B${slice.pruned.length ? ` (config-pruned: ${slice.pruned.map((a) => `§${a}`).join(" ")})` : ""}`);
  return 0;
}

// process.exitCode, NOT process.exit() — this verb's whole output is the slice, which is tens of KB,
// and process.exit() DISCARDS whatever is still queued for an async stdio target. Piping it
// (`dev-loop conventions --agent x > slice.md`) would truncate mid-JSON. That is LOOP-346 exactly,
// and it bit this verb the first time I ran it. Setting exitCode lets node exit once stdout drains.
if (isMainEntry(import.meta.url)) process.exitCode = conventionsCmd();
