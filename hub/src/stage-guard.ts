#!/usr/bin/env node
// `dev-loop stage-guard` — refuse a ship commit that would sweep another fire's edits into it
// (LOOP-320).
//
// A fire that ships from the SHARED checkout stages whatever tracked edits happen to be in the
// working tree, including edits another fire left there, and commits them under its own ticket id.
// Nothing compared the staged file set against the fire's own scope, so `f1a6b70` (PR #176,
// LOOP-105) shipped sixteen files of which five belonged to LOOP-294 and LOOP-31 — and LOOP-31's
// code reached main with nobody verifying it.
//
// This is the COMMISSION direction of the shared-checkout hazard. LOOP-312 covers the DESTRUCTION
// direction (another fire's `git checkout` silently discarding uncommitted work). Same root — a
// mutable tree shared by concurrent fires with no per-fire ownership — opposite failure, and neither
// guard catches the other.
//
// The decision comes from a FACT RECORDED AT FIRE START (tree-snapshot.ts's pre-fire record), never
// from a heuristic over paths or ticket ids. AC2 is explicit about why: a path heuristic cannot tell
// LOOP-294's `hub/src/agentops.ts` edit from LOOP-105's own `hub/src/agentops.ts` edit, and the
// commit that motivated this ticket contains BOTH in that one file. The same-file case is the one a
// heuristic passes and must not.
//
// Sibling of push-guard.ts, and deliberately the same shape: read-only on git, run by the dev-agent
// ship sequence (§12), non-zero exit with a message naming the offending paths.
import { execFileSync } from "node:child_process";
import { isMainEntry } from "./is-entry.ts";
import { readPreFireRecord } from "./tree-snapshot.ts";
import { tryResolveWorkspace, wsStateRoot } from "./workspace.ts";
import { join } from "node:path";

export interface StageGuardResult {
  staged: string[];
  preexisting: string[];   // staged paths that were ALREADY dirty when the run began
  ok: boolean;
  reason?: string;
}

/**
 * Compare the staged set against the paths recorded as dirty at fire start.
 *
 * `preFireFiles === null` means NO record exists — an operator running the guard by hand, or a run
 * that predates the preflight. That is reported as ok with a note rather than refused: a guard that
 * blocks every commit whenever its input is missing gets disabled, and then it protects nothing.
 */
export function evaluateStaged(staged: string[], preFireFiles: string[] | null): StageGuardResult {
  if (preFireFiles === null) return { staged, preexisting: [], ok: true, reason: "no pre-fire record — guard not armed for this run" };
  const pre = new Set(preFireFiles);
  const preexisting = staged.filter((f) => pre.has(f));
  return { staged, preexisting, ok: preexisting.length === 0 };
}

export function stagedFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "diff", "--cached", "--name-only"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
  } catch { return []; }
}

function usage(): void {
  console.log(`dev-loop stage-guard [--repo <path>] [--override "<reason>"] [--json]

Refuses a commit whose STAGED set contains files that were already uncommitted in the shared
checkout when this run started — i.e. another fire's work, about to be committed under your ticket
id. Run it immediately before \`git commit\` in the ship sequence.

  --override "<reason>"  land them deliberately (a salvaged patch, e.g. LOOP-308/LOOP-311).
                         RECORDED, never silent: the reason is printed and written to the event log.
  --repo <path>          default: the workspace's primary repo checkout
  --json                 machine-readable result on stdout

Exit: 0 clean or overridden · 3 refused · 2 usage.

To fix a refusal without an override, unstage the paths it names:  git restore --staged <paths>`);
}

export function stageGuardCmd(argv = process.argv.slice(2)): number {
  let repo: string | undefined, override: string | undefined, asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); return 0; }
    else if (a === "--repo") repo = argv[++i];
    else if (a === "--override") override = argv[++i];
    else if (a === "--json") asJson = true;
    else { console.error(`dev-loop stage-guard: unknown flag '${a}'`); return 2; }
  }
  if (override !== undefined && !override.trim()) { console.error("dev-loop stage-guard: --override requires a reason (it is recorded, not a silent bypass)"); return 2; }

  const ws = tryResolveWorkspace();
  const repoRoot = repo ?? ws?.root ?? process.cwd();
  const stateDir = ws ? join(wsStateRoot(ws), "tree-snapshots") : join(repoRoot, ".dev-loop", "tree-snapshots");
  const rec = readPreFireRecord(stateDir);
  const res = evaluateStaged(stagedFiles(repoRoot), rec ? rec.files : null);

  if (asJson) console.log(JSON.stringify({ ...res, override: override ?? null }, null, 2));

  if (res.ok) {
    if (!asJson && res.reason) console.log(`stage-guard: ${res.reason}`);
    else if (!asJson) console.log(`stage-guard: OK — ${res.staged.length} staged file(s), none pre-existing`);
    return 0;
  }
  if (override !== undefined) {
    // Recorded, not silent. AC3: the legitimate case (deliberately landing a salvaged patch) must
    // leave a trail, so a later reader can tell an intentional carry from the accident this prevents.
    console.error(`stage-guard: OVERRIDDEN — ${res.preexisting.length} pre-existing file(s) will be committed under this ticket.`);
    console.error(`  reason: ${override}`);
    for (const f of res.preexisting) console.error(`  carried: ${f}`);
    return 0;
  }
  console.error(`stage-guard: REFUSED — ${res.preexisting.length} staged file(s) were already uncommitted in this checkout before this run started.`);
  console.error(`They are not this fire's work, and committing them attributes another ticket's changes to yours:`);
  for (const f of res.preexisting) console.error(`  ${f}`);
  console.error(`\nUnstage them:  git restore --staged ${res.preexisting.join(" ")}`);
  console.error(`Or, if you are deliberately landing a salvaged patch, re-run with --override "<why>" (recorded).`);
  return 3;
}

if (isMainEntry(import.meta.url)) process.exit(stageGuardCmd());
