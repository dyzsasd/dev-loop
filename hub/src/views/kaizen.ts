// dev-loop hub daemon web UI — /kaizen self-improvement panel (LOOP-206, design kaizen-panel Surface 2).
// Read-only, server-rendered, 127.0.0.1-only; mirrors /usage conventions (DL-2 doctrine).
// Reads kaizenReport from metrics.ts — one computation, two surfaces; they can never disagree.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { esc, href } from "./ui.ts";
import { kaizenReport } from "../metrics.ts";
import { devloopDataDir } from "../paths.ts";

// Resolve the lessons directory (reportsRoot-style — no workspace object needed in views).
// Falls back to devloopDataDir()/lessons; DEVLOOP_LESSONS_DIR overrides for tests.
function kaizenLessonsDir(): string {
  if (process.env.DEVLOOP_LESSONS_DIR) return process.env.DEVLOOP_LESSONS_DIR;
  return join(devloopDataDir(), "lessons");
}

// Ratchet sources resolved relative to this file's location (hub/src/views/kaizen.ts):
// hub/package.json is two dirs up; docs/design/quality-gauntlet.md is three dirs up.
const _viewsDir = fileURLToPath(new URL(".", import.meta.url));
const _hubDir = join(_viewsDir, "..");
const _repoRoot = join(_viewsDir, "..", "..", "..");
const _pkgJson = join(_hubDir, "..", "package.json");
const _gauntletDoc = join(_repoRoot, "docs", "design", "quality-gauntlet.md");

function card(inner: string): string { return `<section class="acard">${inner}</section>`; }
function metricRow(k: string, v: string): string {
  return `<div class="rlevel"><span class="rkey">${esc(k)}</span><span>${v}</span></div>`;
}
function fmtPct(n: number | null): string { return n === null ? "—" : `${Math.round(n * 100)}%`; }

// GET /kaizen — the self-improvement evidence surface. `nowMs` injected by the route for purity.
export function kaizenPage(db: DatabaseSync, projectId: string, projectKey: string, nowMs: number): string {
  const lessonsDir = kaizenLessonsDir();
  const report = kaizenReport(db, projectId, {
    nowMs,
    lessonsDir: existsSync(lessonsDir) ? lessonsDir : undefined,
    ratchetSources: { pkgJson: _pkgJson, gauntletDoc: _gauntletDoc },
  });
  const si = report.selfImprovement;

  // Header line — only when showHeaderLine (selfFixed >= 1); suppressed when no self-fix yet (operator ruling)
  const headerLine = report.showHeaderLine
    ? `<p class="kaizen-header"><em>It ships software. Then it improves the shipping.</em></p>`
    : `<p class="empty">— the loop hasn't filed and fixed its own issues yet</p>`;

  // Stat 1 — self-filed → self-fixed
  const selfFixedLinksRaw = si.fixedIds.slice(0, 20).map(
    (id) => `<a href="${esc(href(projectKey, `/ticket/${encodeURIComponent(id)}`))}">` + esc(id) + `</a>`
  ).join(" ");
  const selfFixedLinks = si.fixedIds.length > 20
    ? selfFixedLinksRaw + `<span class="sub"> … showing latest 20 of ${esc(String(si.fixedIds.length))}</span>`
    : selfFixedLinksRaw;
  const stat1Body = si.selfFiled === 0
    ? `<p class="empty">— the loop hasn't filed its own issues yet</p>`
    : si.selfFixed === 0
      ? `<p class="empty">— ${esc(String(si.selfFiled))} self-filed, none fixed yet</p>`
      : metricRow("self-filed", `<b>${esc(String(si.selfFiled))}</b>`)
        + metricRow("self-fixed", `<b>${esc(String(si.selfFixed))}</b>`)
        + metricRow("self-fix rate", `<b>${fmtPct(si.selfFixRate)}</b> (${esc(String(si.selfFixed))} of ${esc(String(si.selfFiled))})`)
        + metricRow("of all Done", `${fmtPct(si.selfSlice)} <span class="sub">(${esc(String(si.selfFixed))} loop-filed of ${esc(String(si.totalDone))} total Done)</span>`)
        + (selfFixedLinks ? `<div class="rlevel"><span class="rkey">fixed tickets</span><span class="sub">${selfFixedLinks}</span></div>` : "");
  const stat1 = `<h3>Self-improvement</h3>`
    + headerLine
    + stat1Body;

  // Stat 2 — lessons curve
  const ls = report.lessons;
  const stat2 = `<h3>Lessons</h3>`
    + (!ls.present
      ? `<p class="empty">— no lessons recorded yet (0 entries)</p>`
      : ls.entries === 0
        ? `<p class="empty">— lessons dir present, 0 bullet entries yet</p>`
        : metricRow("total lessons", `<b>${esc(String(ls.entries))}</b>`)
          + Object.entries(ls.byMonth).sort().reverse().slice(0, 6).map(
            ([mo, n]) => metricRow(mo, esc(String(n)))
          ).join(""));

  // Stat 3 — quality ratchet trajectory
  const rt = report.ratchet;
  const stat3 = `<h3>Quality ratchet</h3>`
    + (rt.current === null
      ? `<p class="empty">— quality gate threshold not configured</p>`
      : metricRow("current threshold", `<b>CRAP-${esc(String(rt.current))}</b>`)
          + (rt.history === null
            ? metricRow("history", `see <code>${esc(rt.source)}</code>`)
            : metricRow("trajectory", rt.history.map((h) => `${esc(String(h.value))} <span class="sub">(${esc(h.version)})</span>`).join(" → ") + ` → <b>${esc(String(rt.current))}</b>`)));

  // Stat 4 — §17 proposals (filed vs applied proxy, labelled as proxy)
  const ev = report.evolution;
  const stat4 = `<h3>§17 self-evolution</h3>`
    + (ev.filed === 0
      ? `<p class="empty">— no §17 proposals filed yet</p>`
      : metricRow("proposals filed", `<b>${esc(String(ev.filed))}</b>`)
          + metricRow("applied (proxy)", `<b>${esc(String(ev.appliedProxy))}</b> <span class="sub">proposals that reached Done — a proxy; §17 application is an operator git edit with no board signal</span>`));

  // Stat 5 — verify-fail total + class breakdown (class permanently "not yet recorded")
  const vf = report.verifyFail;
  const stat5 = `<h3>Verify-fail class</h3>`
    + (vf.totalInWindow === 0
      ? `<p class="empty">— no verify-fails in the last ${esc(String(Math.round(report.windowMs / 86_400_000)))} days</p>`
      : metricRow("total (in window)", `<b>${esc(String(vf.totalInWindow))}</b>`)
          + metricRow("class breakdown", `<span class="sub">not yet recorded (no Verify-fail-class: marker emitted yet)</span>`));

  return `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a>`
    + `<article class="apage"><h1>Kaizen — ${esc(projectKey)}</h1>`
    + `<div class="agrid">`
    + card(stat1)
    + card(stat2)
    + card(stat3)
    + card(stat4)
    + card(stat5)
    + `</div>`
    + `</article>`;
}
