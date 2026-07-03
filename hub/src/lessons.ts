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

function budgetOf(path: string): { lines: number; bytes: number } | null {
  if (!existsSync(path)) return null;
  try { const t = readFileSync(path, "utf8"); return { lines: t.split("\n").length, bytes: statSync(path).size }; }
  catch { return null; }
}

// W03 — report (never fail) when the INDEX or any shard exceeds its budget; reflect should demote/downshift.
export function checkLessonsBudget(ws: Workspace): WsWarning[] {
  const P = lessonsPaths(ws);
  const out: WsWarning[] = [];
  const idx = budgetOf(P.index);
  if (idx && (idx.lines > INDEX_MAX_LINES || idx.bytes > INDEX_MAX_BYTES))
    out.push({ code: "W03", path: "lessons/INDEX.md", message: `lessons INDEX over budget (${idx.lines} lines / ${idx.bytes} B; limit ${INDEX_MAX_LINES} lines / ${INDEX_MAX_BYTES} B) — reflect should demote entries to shards/archive` });
  for (const key of Object.keys(ws.file.projects)) {
    const s = budgetOf(P.shard(key));
    if (s && (s.lines > SHARD_MAX_LINES || s.bytes > SHARD_MAX_BYTES))
      out.push({ code: "W03", path: `lessons/${key}.md`, message: `lessons shard '${key}' over budget (${s.lines} lines / ${s.bytes} B; limit ${SHARD_MAX_LINES} lines / ${SHARD_MAX_BYTES} B) — reflect should archive old entries` });
  }
  return out;
}
