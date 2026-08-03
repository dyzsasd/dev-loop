// dev-loop hub daemon web UI — /usage dashboard (LOOP-126, design usage-surfaces Surface 2).
// Read-only, server-rendered, 127.0.0.1-only; mirrors /activity conventions (DL-2 doctrine).
// Reads fire.completed events via metrics.ts#fireRowsFromEvents → usageReport (no recomputation).
import { DatabaseSync } from "node:sqlite";
import { esc, href, countPill } from "./ui.ts";
import { fireRowsFromEvents, usageReport } from "../metrics.ts";
import type { UsageCell } from "../metrics.ts";

const DAY_MS = 86_400_000;
const WIN_MS = 30 * DAY_MS;

function card(inner: string): string { return `<section class="acard">${inner}</section>`; }
const metricRow = (k: string, v: string) =>
  `<div class="rlevel"><span class="rkey">${esc(k)}</span><span>${v}</span></div>`;

// Format a nullable number; null → em dash (never "0" for unmeasured, never "$0.00")
function fmtN(n: number | null): string { return n === null ? "—" : esc(String(n)); }
function fmtCost(n: number | null): string { return n === null ? "—" : `$${esc(n.toFixed(4))}`; }

// One cell of the usage/cost table — honest nulls per the design's null≠0 discipline
function cellRows(label: string, cell: UsageCell): string {
  const tok = cell.metered === 0
    ? `<span class="sub">— no metered fires</span>`
    : `${fmtN(cell.inputTokens)} in · ${fmtN(cell.outputTokens)} out`
      + ` · ${fmtN(cell.cacheReadTokens)} cache-r · ${fmtN(cell.cacheWriteTokens)} cache-w`;
  const cost = cell.costMetered === 0
    ? `<span class="sub">unavailable — ${esc(String(cell.fires))} fire${cell.fires === 1 ? "" : "s"}, none priced</span>`
    : `<b>${fmtCost(cell.costUsd)}</b> <span class="sub">${esc(String(cell.costMetered))} of ${esc(String(cell.fires))} priced</span>`;
  return metricRow(label, `<span class="sub">metered ${esc(String(cell.metered))} / ${esc(String(cell.fires))}</span>`)
    + metricRow("  tokens", tok)
    + metricRow("  cost", cost);
}

// GET /usage — usage & cost over the fire.completed event ledger (last 30d).
// `nowMs` is injected by the route handler so this function stays pure/testable.
export function usagePage(db: DatabaseSync, projectId: string, projectKey: string, nowMs: number): string {
  const sinceIso = new Date(nowMs - WIN_MS).toISOString();
  const rows = fireRowsFromEvents(db, projectId, sinceIso);

  const byAgent = usageReport(rows, WIN_MS, { groupBy: "agent", nowMs });
  const byProvider = usageReport(rows, WIN_MS, { groupBy: "provider", nowMs });

  const total = byAgent.totalFires;
  const metered = byAgent.meteredFires;
  const overall = byAgent.overall;

  // Coverage banner — the first-class "N of M" element (design §partial/missing-data posture)
  const bannerWarn = total > 0 && metered === 0;
  const banner = `<div class="tiles"><div class="tile${bannerWarn ? " tile-warn" : ""}"><span class="tile-v">${esc(String(metered))} / ${esc(String(total))}</span>`
    + `<span class="tile-l">fires with measured usage · 30d</span></div>`
    + `<div class="tile"><span class="tile-v">${fmtCost(overall.costUsd)}</span><span class="tile-l">cost · 30d</span></div>`
    + `</div>`;

  // Overall section
  const overallSection = `<h3>Overall — last 30 days</h3>`
    + (total === 0
      ? `<p class="empty">— no data</p>`
      : cellRows("overall", overall));

  // No-data state when nothing is metered (explicit, no zero-filled tables, no $0.00)
  const agentEntries = Object.entries(byAgent.byDimension ?? {});
  const agentSection = `<h3>By agent${countPill(agentEntries.length)}</h3>`
    + (metered === 0
      ? `<p class="empty">— no metered fires in the last 30 days</p>`
      : agentEntries.map(([k, cell]) => cellRows(k, cell as UsageCell)).join(""));

  const provEntries = Object.entries(byProvider.byDimension ?? {});
  const provSection = `<h3>By provider${countPill(provEntries.length)}</h3>`
    + (metered === 0
      ? `<p class="empty">— no metered fires in the last 30 days</p>`
      : provEntries.map(([k, cell]) => cellRows(k, cell as UsageCell)).join(""));

  // Spend summary (the --flow precursor: total cost + cost-per-fire when priced)
  const perFire = overall.costPriced > 0 && overall.costUsd !== null
    ? `$${esc((overall.costUsd / overall.costPriced).toFixed(4))} / priced fire`
    : "unavailable";
  const flowSection = `<h3>Spend summary</h3>`
    + metricRow("total cost · 30d", overall.costUsd === null
      ? `<span class="sub">unavailable — 0 of ${esc(String(total))} fires reported cost</span>`
      : `<b>${fmtCost(overall.costUsd)}</b>`)
    + metricRow("cost per fire", perFire)
    + metricRow("metered fires", `<b>${esc(String(metered))}</b> of ${esc(String(total))}`);

  return `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a>`
    + `<article class="apage"><h1>Usage — ${esc(projectKey)}</h1>`
    + banner
    + `<div class="agrid">`
    + card(overallSection)
    + card(agentSection)
    + card(provSection)
    + card(flowSection)
    + `</div>`
    + `</article>`;
}
