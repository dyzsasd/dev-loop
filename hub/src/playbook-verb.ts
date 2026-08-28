#!/usr/bin/env node
// `dev-loop playbook <agent> <job>` — the PULL half of job-scoped delivery (job-scoped prompts,
// docs/design/job-scoped-prompts.md; Option B mid-fire escape hatch).
//
// A pushed fire for (agent, job) loads its constant segment from the boot corpus: skills/_constitution.md
// (VERBATIM) + the marked job span in the agent's SKILL + the shared playbooks that span pulls. This verb
// prints the BYTE-IDENTICAL slice on demand, so an agent that hits a genuine same-fire obligation (e.g.
// pm's [reflect-proposal] deferred-findings triage) can read the next job's playbook without a new fire.
//
// It reuses assembleJobCorpus() — the SAME function the push path calls — so a pushed and a pulled
// playbook can never drift (the "one authority" invariant, matching `dev-loop conventions`). Default OFF:
// nothing auto-invokes it; its cost (a broken cache prefix for the rest of the fire) is self-limiting.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { pluginRoot, jobsOf } from "./context-bill.ts";
import { assembleJobCorpus } from "./boot-prefix.ts";
import { tryResolveWorkspace, wsStateRoot } from "./workspace.ts";
import { deliveryProjects } from "./team-config.ts";

function usage(): void {
  console.log(`dev-loop playbook <agent> <job> [--root <dir>] [--json]

The job-scoped slice ONE (agent, job) fire loads, on demand — the PULL half of job-scoped delivery.
Prints skills/_constitution.md (the resident kernel) + the agent SKILL's <job> span + the shared
playbooks that span pulls, BYTE-IDENTICAL to what a pushed fire's boot corpus carries.

  <agent>    the agent handle (pm, …) — reads skills/<agent>-agent/SKILL.md
  <job>      one of the jobs the SKILL declares (its <!-- job:<job>:begin --> markers)
  --root     the plugin payload root (default: resolved next to this module)
  --json     { agent, job, bytes, hash, text }

A mid-fire escape hatch (design Option B), default OFF — nothing points a fire here automatically.`);
}

export function playbookCmd(argv = process.argv.slice(2)): number {
  let root: string | undefined, asJson = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--root") root = argv[++i];
    else if (a === "--json") asJson = true;
    else if (a.startsWith("-")) { console.error(`dev-loop playbook: unknown flag '${a}'`); return 2; }
    else positional.push(a);
  }
  const [agent, job] = positional;
  if (!agent || !job) { console.error("dev-loop playbook: <agent> and <job> are both required"); usage(); return 2; }

  const r = root ?? pluginRoot();
  const skillPath = join(r, "skills", `${agent}-agent`, "SKILL.md");
  if (!existsSync(skillPath)) { console.error(`dev-loop playbook: no SKILL for agent '${agent}' (${skillPath})`); return 1; }
  // The SKILL is the source of truth for which jobs an agent has — refuse an unknown one, naming the valid set.
  const jobs = jobsOf(readFileSync(skillPath, "utf8"));
  if (!jobs.includes(job)) {
    console.error(`dev-loop playbook: agent '${agent}' declares no job '${job}' — valid jobs: ${jobs.join(", ") || "(none)"}`);
    return 1;
  }
  // Resolve THIS fire's workspace lessons so the pulled slice carries the SAME §14 lessons + cheat the
  // pushed corpus does (one authority ⇒ pushed ≡ pulled byte-for-byte). Best-effort: no workspace ⇒ no
  // lessons (the cheat block still ships — it comes from the SKILL, no workspace needed). The fire env's
  // DEVLOOP_PROJECT names the exact project shard; fall back to the first delivery project.
  let dataDir: string | undefined, project: string | undefined;
  const ws = tryResolveWorkspace();
  if (ws) { dataDir = wsStateRoot(ws); project = process.env.DEVLOOP_PROJECT?.trim() || deliveryProjects(ws)[0]; }
  const corpus = assembleJobCorpus(r, agent, job, dataDir, project);
  if (!corpus) { console.error(`dev-loop playbook: could not assemble the '${job}' slice for '${agent}' (a pulled playbook file may be missing)`); return 1; }

  if (asJson) { console.log(JSON.stringify({ agent, job, bytes: corpus.bytes, hash: corpus.hash, text: corpus.text }, null, 2)); return 0; }
  console.log(corpus.text);
  // The accounting goes to stderr so `dev-loop playbook pm verify > slice.md` stays clean for piping.
  console.error(`\n[playbook] ${agent}/${job}: ${corpus.bytes} B, hash ${corpus.hash} — byte-identical to the pushed job corpus`);
  return 0;
}

// process.exitCode, NOT process.exit() — the whole output is the slice (tens of KB); process.exit()
// discards whatever is still queued for an async stdio target and would truncate a pipe (LOOP-346).
if (isMainEntry(import.meta.url)) process.exitCode = playbookCmd();
