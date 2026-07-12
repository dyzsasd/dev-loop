// dev-loop hub daemon web UI — the agent reports views (F1 split of daemonviews.ts).
// DL-10: read-only, FILESYSTEM source — the §22 reports tree is machine-local markdown, separate
// from the hub DB. Strict segment validation defeats path traversal before any fs access.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { devloopDataDir } from "../paths.ts";
import { esc, href, renderMarkdown } from "./ui.ts";

// Resolve the reports root: DEVLOOP_REPORTS_DIR if set, else the FIRST EXISTING of a few candidates
// (the on-disk layout varies — both <data>/<project>/reports and a flat <data>/reports exist in the
// wild); falls back to the AC-formula path for the empty state.
const REPORT_DATED: Record<string, RegExp> = { daily: /^\d{4}-\d{2}-\d{2}$/, weekly: /^\d{4}-W\d{2}$/, monthly: /^\d{4}-\d{2}$/ };
export function reportsRoot(projectKey: string): string {
  if (process.env.DEVLOOP_REPORTS_DIR) return process.env.DEVLOOP_REPORTS_DIR;
  const bases = [devloopDataDir(), process.env.CLAUDE_PLUGIN_DATA].filter(Boolean) as string[]; // 1.0: the legacy Claude-plugin data dir is no longer scanned
  const candidates = bases.flatMap((b) => [join(b, projectKey, "reports"), join(b, "reports")]);
  for (const c of candidates) { try { if (statSync(c).isDirectory()) return c; } catch { /* not here */ } }
  return candidates[0]; // AC-formula path; may not exist → empty state at read time
}
const lsSubdirs = (p: string): string[] => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
// Only the §22 dated-report files for the level — this inherently EXCLUDES *.review.md / *.review.acted.
const lsDated = (p: string, level: string): string[] => { const re = REPORT_DATED[level]; try { return re ? readdirSync(p).filter((f) => f.endsWith(".md") && re.test(f.slice(0, -3))).sort().reverse() : []; } catch { return []; } };

// GET /reports — agents + their dated reports (daily is the must-have; weekly/monthly when present).
// F2: projectKey scopes the report links + back link to /p/<key>/ via href().
export function reportsIndexPage(root: string, projectKey: string): string {
  const agents = lsSubdirs(root).sort();
  const sections = agents.map((agent) => {
    const levels = ["daily", "weekly", "monthly"].map((level) => {
      const files = lsDated(join(root, agent, level), level);
      if (!files.length) return "";
      const items = files.map((f) => { const d = f.slice(0, -3); return `<a class="lbl" href="${esc(href(projectKey, `/reports/${encodeURIComponent(agent)}/${level}/${encodeURIComponent(d)}`))}">${esc(d)}</a>`; }).join(" ");
      return `<div class="rlevel"><span class="rkey">${esc(level)}</span>${items}</div>`;
    }).filter(Boolean).join("");
    return levels ? `<section class="ragent"><h3>${esc(agent)}</h3>${levels}</section>` : "";
  }).filter(Boolean).join("");
  return `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a><article class="detail"><h1>Reports</h1>`
    + (sections || `<p class="empty">No reports found yet under <code>${esc(root)}</code>.</p>`) + `</article>`;
}
// GET /reports/<agent>/<level>/<date> — one report, read-only. "badpath" → 400 (traversal/garbage), null → 404.
export function reportPage(root: string, projectKey: string, agent: string, level: string, date: string): { html: string } | "badpath" | null {
  // strict segment validation defeats path traversal BEFORE any fs access: agent is a single safe name
  // (no `.`/`/`/`..`), level is one of the three, date matches the §22 grammar for that level.
  if (!/^[A-Za-z0-9_-]+$/.test(agent) || !(level in REPORT_DATED) || !REPORT_DATED[level].test(date)) return "badpath";
  const file = resolve(root, agent, level, `${date}.md`);
  if (!file.startsWith(resolve(root) + sep)) return "badpath"; // defense-in-depth: the resolved path must stay within root
  let body: string; try { body = readFileSync(file, "utf8"); } catch { return null; }
  return { html: `<a class="back" href="${esc(href(projectKey, "/reports"))}">← reports</a> · <a class="back" href="${esc(href(projectKey, "/"))}">board</a>`
    + `<article class="detail"><div class="card-top"><span class="id">${esc(agent)}</span><span class="badge">${esc(level)}</span></div>`
    + `<h1>${esc(date)}</h1><div class="doc">${renderMarkdown(body)}</div></article>` };
}
