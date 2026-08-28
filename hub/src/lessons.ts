// The team lessons library (design §5.1). One curated INDEX loaded on EVERY fire (hard budget), per-project
// shards loaded only by that project's delivery fires, and a cold archive that is never loaded. reflect is
// the only writer (a SKILL behavior); this module owns the PATHS and the BUDGET check doctor reports (W03).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { wsLessonsDir } from "./workspace.ts";
import type { Workspace, WsWarning } from "./team-config.ts";

// Fixed budgets so the per-fire lessons injection is a CONSTANT cost, independent of team size / history.
export const INDEX_MAX_LINES = 120;
export const INDEX_MAX_BYTES = 8 * 1024;
export const SHARD_MAX_LINES = 200;
export const SHARD_MAX_BYTES = 16 * 1024;

/**
 * The strategy doc's byte ceiling (LOOP-282).
 *
 * Defined HERE, beside the lessons budgets it is modelled on, and exported so the bill and doctor
 * share ONE authority. Two literals is how a budget and the thing that reports it drift.
 *
 * §20 R2 says "~20KB", and that applies to the ROLLABLE sections — the current-cycle strategy an
 * agent must actually re-read every fire. This budget covers the WHOLE resolved file, because the
 * whole file is what a §20 R2 reader loads: an archived section that has not been moved out to
 * `strategy-archive/` is a section a fire still pays for. So the number is set at 48 KB — well above
 * the ~20 KB of live strategy, with room for the surrounding structure, and far below the 114 KB
 * measured on 2026-08-05 that motivated this. It is a ceiling on NEGLECT, not a target.
 *
 * The measured problem it exists to catch: the strategy doc was the only per-fire agent input with
 * no budget and no doctor code — 114 KB, 14x the lessons INDEX cap W03 does enforce — and 20 rollup
 * passes did not bound it (+1,036 B/fire measured).
 */
export const STRATEGY_DOC_MAX_BYTES = 48 * 1024;
/**
 * The fraction of STRATEGY_DOC_MAX_BYTES at which checkStrategyDocBudget emits a soft advisory
 * line (below the hard W37 warn). Set at 80% so there is ~9.6 KB of warning band before the budget
 * is irrevocably blown — enough for roughly 9 fires at the measured grow rate of ~1,036 B/fire.
 * The doc's actual post-LOOP-350 size is 45.8 KB against a 48 KB budget, so the soft line fires at
 * ~38.4 KB — ~7.4 KB of headroom, roughly 7 fires, of advance notice.
 */
export const STRATEGY_DOC_WARN_FRACTION = 0.8;

export function lessonsPaths(ws: Workspace): { dir: string; index: string; archive: string; shard: (project: string) => string } {
  const dir = wsLessonsDir(ws);
  return { dir, index: join(dir, "INDEX.md"), archive: join(dir, "archive.md"), shard: (p: string) => join(dir, `${p}.md`) };
}

// The lessons text a fire loads: the INDEX always, plus this project's shard for a delivery fire.
export function lessonsForFire(ws: Workspace, project: string | null): string {
  const P = lessonsPaths(ws);
  const parts: string[] = [];
  if (existsSync(P.index)) parts.push(readFileSync(P.index, "utf8"));
  if (project && existsSync(P.shard(project))) parts.push(readFileSync(P.shard(project), "utf8"));
  return parts.join("\n\n");
}

// §14 layout: one `## <Section>` per role + `## Shared`. The agent-id → section-name map mirrors the
// init scaffold order in conventions §14. Lives HERE (the lessons authority) so the boot assembler
// (boot-prefix.ts) and the context bill (context-bill.ts) slice by ONE definition — the bill imports
// this module already, and importing boot-prefix from the bill would be a cycle.
export const LESSONS_SECTION: Record<string, string> = {
  pm: "PM", qa: "QA", dev: "Dev", "senior-dev": "senior-dev", "junior-dev": "junior-dev",
  sweep: "Sweep", reflect: "Reflect", ops: "Ops", architect: "Architect",
  communication: "Communication",
};

// Extract `## <name>` sections from a lessons file, preserving file order: the agent's own section
// (+ `## Dev` for the split tiers) + `## Shared` — §0a step 4. Missing sections are skipped silently
// (a young lessons file may not carry every heading yet).
export function lessonsSlice(text: string, agent: string): string {
  const want = new Set<string>(["Shared"]);
  const own = LESSONS_SECTION[agent];
  if (own) want.add(own);
  if (agent === "senior-dev" || agent === "junior-dev") want.add("Dev");
  const ls = text.split("\n");
  if (ls.length && ls[ls.length - 1] === "") ls.pop();
  const out: string[] = [];
  let keep = false;
  for (const l of ls) {
    const m = /^## (.+?)\s*$/.exec(l);
    if (m) keep = want.has(m[1]);
    if (keep) out.push(l);
  }
  return out.join("\n");
}

// The lessons text ONE fire actually receives in its boot corpus (WS-A A4): the INDEX + this project's
// shard (the same two files lessonsForFire loads), sliced to the agent's sections. `bytes` is what the
// context bill charges when a workspace resolves — the delivered count, not the W03 cap.
export function lessonsSliceForFire(ws: Workspace, agent: string, project: string | null): { text: string; bytes: number; lines: number } {
  const text = lessonsSlice(lessonsForFire(ws, project), agent);
  const lines = text ? text.split("\n").length : 0;
  return { text, bytes: Buffer.byteLength(text, "utf8"), lines };
}

function budgetOf(path: string): { lines: number; bytes: number } | null {
  if (!existsSync(path)) return null;
  try { const t = readFileSync(path, "utf8"); return { lines: t.split("\n").length, bytes: statSync(path).size }; }
  catch { return null; }
}

// W03 — report (never fail) when the INDEX or any shard exceeds its budget; reflect should demote/downshift.
export function checkLessonsBudget(ws: Workspace): WsWarning[] {
  const P = lessonsPaths(ws);
  const out: WsWarning[] = [];
  // LOOP-272 AC(C) — W03 polices the byte budget of the §0a PUSH path (ON by default since WS-A; before
  // that it was OFF and, until LOOP-272, unreachable from config at all). A green or absent W03 therefore read as
  // "the push-path budget is honoured" when in truth NOTHING WAS EVER PUSHED. Doctor cannot see a
  // fire's env or flag, so it resolves from CONFIG ONLY — `opts.assembleBoot` is invisible here and
  // depending on it would make doctor's answer depend on how a fire happened to be launched.
  // WS-A (2026-08-27): the corpus is ON by default — `team.bootCorpus:false` is the explicit opt-out.
  const corpusEnabled = ws.file.team?.bootCorpus !== false;
  const modeNote = corpusEnabled ? "" : " (note: team.bootCorpus is OFF — this budget governs the §0a PUSH path, which is not delivering; the INDEX still costs on the pull read)";
  const idx = budgetOf(P.index);
  if (idx && (idx.lines > INDEX_MAX_LINES || idx.bytes > INDEX_MAX_BYTES))
    out.push({ code: "W03", path: "lessons/INDEX.md", message: `lessons INDEX over budget (${idx.lines} lines / ${idx.bytes} B; limit ${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} B) — reflect should demote entries to shards/archive${modeNote}` });
  for (const key of Object.keys(ws.file.projects)) {
    const s = budgetOf(P.shard(key));
    if (s && (s.lines > SHARD_MAX_LINES || s.bytes > SHARD_MAX_BYTES))
      out.push({ code: "W03", path: `lessons/${key}.md`, message: `lessons shard '${key}' over budget (${s.lines} lines / ${s.bytes} B; limit ${SHARD_MAX_LINES} lines / ${SHARD_MAX_BYTES} B) — reflect should archive old entries${modeNote}` });
  }
  // The invariant: an ABSENT W03 must not read as "the push budget is honoured". When the corpus is
  // off, say so once — the over-budget checks above stay, because an oversized INDEX costs on the
  // pull read too, so silencing them would trade one wrong reading for another.
  if (!corpusEnabled)
    out.push({ code: "W03", path: "team.bootCorpus", message: `§0a boot corpus is OFF (team.bootCorpus:false) — fires run in PULL mode and the push-path byte budget below is not being delivered against. Turn it back on with: dev-loop team set team.bootCorpus true (or remove the key — ON is the default)` });
  return out;
}
