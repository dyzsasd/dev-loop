#!/usr/bin/env node
// `dev-loop metrics` — the DETERMINISTIC team-KPI computation (director view, W5). Numbers come from
// code; narrative comes from the digest agent. Two sources, honestly scoped:
//   • fires.jsonl (ALL backends): fire counts, success rate, timeouts, suspectErrors, per-agent medians.
//   • the hub db (service backend only): board KPIs from `issue.transition` events — throughput (→Done),
//     accept rate = Done ÷ (Done + verify-fail Cancels, i.e. the §3 In Review→Canceled edge), blocked count.
//     On linear there is no local board mirror — the digest agent computes board numbers via MCP queries
//     at fire time, per the §22 digest contract; this CLI never guesses them.
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsFireLedger, resolveHubDbPath } from "./workspace.ts";
import { deliveryProjects, effectiveProject, resolveTodoDepthCap, type Workspace, type WsWarning } from "./team-config.ts";
import { AGENT_HANDLES } from "./seed.ts";
import { servableTodoDepth, servableBacklogDepth } from "./servable.ts"; // LOOP-329: the SAME tier predicate the queue uses
import { liveBlockerIds } from "./blocked-by.ts";
import { lessonsPaths } from "./lessons.ts";

// ─── fires.jsonl ──────────────────────────────────────────────────────────────
export interface FireUsage {
  source: "provider";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  currency: string | null;
}
export interface UsageAdapter {
  extraArgs: string[];
  parse(stdout: string): FireUsage | null;
  isError?(stdout: string): boolean;
  // Human-readable result text pulled from the structured output, for the operator echo (console + run.log).
  // Present only on a lane whose raw stdout is a single non-streamed blob (claude --output-format json): its
  // presence tells runAgent to DEFER the live echo and print this instead of the escaped JSON. Returns null
  // when the buffer cannot be parsed (truncation/crash), so the caller falls back to the raw buffer — a
  // killed fire still shows something, never zero output.
  resultText?(stdout: string): string | null;
}
export interface FireRow { ts: string; agent: string; project: string; codingAgent?: string; provider?: string; model?: string; effort?: string; durationMs?: number; exitCode?: number; timedOut?: boolean; suspectError?: boolean; interrupted?: boolean; errorClass?: string; bootBytes?: number; fireId?: string; usage?: FireUsage }
export interface FireMetrics {
  windowMs: number; fires: number; failures: number; timeouts: number; suspectErrors: number; interrupted: number;
  discardedFires: number;            // LOOP-219: fires that produced nothing (suspectError | interrupted)
  discardedCostUsd: number | null;   // their priced spend; null when nothing is priced at all
  byErrorClass: Record<string, number>;            // P0-1b taxonomy (spend-limit/rate-limit/auth/network/timeout/…); infra failures split from task failures
  successRate: number | null;                      // (fires - failures - suspect) / fires; null when no fires
  byAgent: Record<string, { fires: number; failures: number; medianMs: number | null; costUsd: number | null; costMeteredFires: number; usdPerFire: number | null }>;
  byProject: Record<string, { fires: number; failures: number }>;
  meteredFires: number;                            // fires carrying usage (coverage numerator)
  costMeteredFires: number;                        // fires at/after meteringOnsetTs whose usage.costUsd > 0
  costUsd: number | null;                          // summed costUsd over costMeteredFires rows; null when 0
  meteringOnsetTs: string | null;                  // earliest ts of any row carrying usage; null if ledger has no metered rows
}

// ─── usage aggregation (LOOP-125) ─────────────────────────────────────────────
export type UsageDimension = "agent" | "project" | "provider" | "model";
export interface UsageCell {
  fires: number;
  metered: number;                // fires carrying usage (coverage numerator for this cell)
  inputTokens: number | null;     // summed over metered; null when metered===0 or all rows omitted the field
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;         // summed over rows whose usage.costUsd!=null; null when costMetered===0
  discardedUsd: number | null;    // LOOP-219: the priced spend of fires that produced nothing
  discardedFires: number;
  costMetered: number;            // rows contributing a costUsd (money coverage)
  costPriced: number;             // rows with costUsd > 0 (excludes zero-cost rate-limit failures)
}
export interface UsageReport {
  windowMs: number;
  totalFires: number;             // all fires in window (metered or not)
  meteredFires: number;           // fires carrying usage (the coverage numerator "N of M")
  overall: UsageCell;
  byDimension?: Record<string, UsageCell>;  // present when a groupBy dimension is requested
}

export function readFireRows(ledgerPath: string): FireRow[] {
  if (!existsSync(ledgerPath)) return [];
  const rows: FireRow[] = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t) as FireRow); } catch { /* a torn line (crash mid-append) is skipped */ }
  }
  return rows;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function fireMetrics(ledgerPath: string, windowMs: number, nowMs = Date.now()): FireMetrics {
  const allRows = readFireRows(ledgerPath);
  // meteringOnsetTs: earliest ts of any row carrying usage across the full ledger.
  // Pre-onset rows carry no usage, so they're already excluded by `if (r.usage)` below;
  // this field makes the onset boundary visible in --json output.
  const meteringOnsetTs = allRows.reduce<string | null>(
    (min, r) => (r.usage ? (min === null || r.ts < min ? r.ts : min) : min), null);
  // LOOP-314: BOTH bounds. `ts >= cutoff` alone is a trailing-to-now window, so setting nowMs to a
  // past instant still admitted every later row and a "before" era silently contained the "after".
  // With the upper bound, [nowMs-windowMs, nowMs] is a genuine closed era — and for the default
  // nowMs=Date.now() the only rows it newly excludes are future-dated ones, which are corrupt anyway.
  const cutoff = nowMs - windowMs;
  const rows = allRows.filter((r) => { const t = Date.parse(r.ts); return t >= cutoff && t <= nowMs; });
  const byAgent: FireMetrics["byAgent"] = {};
  const byProject: FireMetrics["byProject"] = {};
  let failures = 0, timeouts = 0, suspect = 0, interrupted = 0;
  const byErrorClass: Record<string, number> = {};
  for (const r of rows) {
    const failed = (r.exitCode ?? 0) !== 0;
    if (failed) failures++;
    if (r.timedOut) timeouts++;
    if (r.suspectError) suspect++;
    if (r.interrupted) interrupted++;
    if (r.errorClass) byErrorClass[r.errorClass] = (byErrorClass[r.errorClass] ?? 0) + 1;
    const a = (byAgent[r.agent] ??= { fires: 0, failures: 0, medianMs: null, costUsd: null, costMeteredFires: 0, usdPerFire: null });
    a.fires++; if (failed) a.failures++;
    const p = (byProject[r.project || "(team)"] ??= { fires: 0, failures: 0 });
    p.fires++; if (failed) p.failures++;
  }
  for (const [agent, a] of Object.entries(byAgent)) {
    a.medianMs = median(rows.filter((r) => r.agent === agent && typeof r.durationMs === "number").map((r) => r.durationMs as number));
  }
  // LOOP-219 — every money surface summed costUsd over ALL metered rows, including fires that were
  // killed mid-flight and produced nothing, and then divided that inflated total by an outcome those
  // fires never generated (cost-per-accepted-change). The one metric built to expose inefficiency was
  // itself inflated by exactly the waste it exists to surface. A fire is DISCARDED iff it carries the
  // flag — read the flag, never re-derive kill-detection from clustering. Both flags qualify:
  // suspectError (exit 0, output looks like a failure) and interrupted (LOOP-155, the operator's own
  // stop). Neither produced a delivered increment; both cost real money.
  let meteredFires = 0, costMeteredFires = 0, costUsdAcc = 0, hasCost = false;
  let discardedFires = 0, discardedCostAcc = 0;
  for (const r of rows) {
    const discarded = !!(r.suspectError || r.interrupted);
    if (discarded) discardedFires++;
    if (r.usage) {
      meteredFires++;
      // costMeteredFires counts only rows with costUsd > 0 — zero-cost rate-limit failures (exitCode:1,
      // source:"provider", costUsd:0) have usage but no billable spend and must not inflate the denominator.
      if (r.usage.costUsd !== null && r.usage.costUsd > 0) {
        costMeteredFires++; costUsdAcc += r.usage.costUsd; hasCost = true;
        if (discarded) discardedCostAcc += r.usage.costUsd;
        const a = byAgent[r.agent];
        if (a) { a.costUsd = (a.costUsd ?? 0) + r.usage.costUsd; a.costMeteredFires++; }
      }
    }
  }
  for (const a of Object.values(byAgent)) {
    a.usdPerFire = a.costMeteredFires > 0 && a.costUsd !== null ? a.costUsd / a.costMeteredFires : null;
  }
  const fires = rows.length;
  // LOOP-155 — an operator-initiated stop is not an agent failure. `dev-loop run` forwards SIGINT to
  // its in-flight agents; each exits 0 with a trailing "Execution error", which the old classifier
  // bucketed as suspectError and then SUBTRACTED from the success rate. Every suspectError on the
  // board that found this was such a kill — 10 of 10, zero true positives — so the loop reported
  // itself 3.4 points sicker than it was, by exactly the amount the operator themselves caused, and
  // it had already put a phantom "failure pattern #3" into a retrospective.
  // Excluded from BOTH numerator and denominator: a discarded fire is not evidence either way.
  const scored = fires - interrupted;
  const successRate = scored > 0 ? (scored - failures - suspect) / scored : null;
  return { windowMs, fires, failures, timeouts, suspectErrors: suspect, interrupted, discardedFires,
    // null when NOTHING is priced (never a number we did not measure); a real 0.00 is legitimate.
    discardedCostUsd: costMeteredFires > 0 ? discardedCostAcc : null,
    byErrorClass, successRate, byAgent, byProject, meteredFires, costMeteredFires, costUsd: hasCost ? costUsdAcc : null, meteringOnsetTs };
}

// ─── rollingSpendUsd (LOOP-227) — enforcement spend total ────────────────────
// Counts killed/unpriced fires via an estimate rather than reading them as $0.
// A wall-killed fire omits usage.costUsd (the cost blob is truncated by SIGTERM before finalize
// parses it), so fireMetrics contributes $0 for that fire — exactly the runaway a ceiling must
// catch. This function must NEVER read unmeasured as $0.
//
// Fallback rate derivation: worst observed fire was $18.21 over ~60 min (a claude wall-hit):
// $18.21 / 3,600,000 ms ≈ 5.058e-6 $/ms ≈ $0.305/min ≈ $18.21/hr. Used when no same-profile
// (codingAgent, model) priced history exists in the window to derive a median rate.
const FALLBACK_RATE_PER_MS = 18.21 / 3_600_000; // ≈ 5.058e-6 $/ms (~$18.21/hr) conservative floor

export function rollingSpendUsd(rows: FireRow[], windowMs: number, nowMs: number): number {
  const cutoff = nowMs - windowMs;                                   // LOOP-314: closed era, both bounds
  const inWindow = rows.filter((r) => { const t = Date.parse(r.ts); return t >= cutoff && t <= nowMs; });

  // Collect per-(codingAgent, model) rates from priced rows for median derivation
  const ratesByProfile: Record<string, number[]> = {};
  for (const r of inWindow) {
    if (r.usage != null && r.usage.costUsd !== null && typeof r.durationMs === "number" && r.durationMs > 0)
      (ratesByProfile[`${r.codingAgent ?? ""}/${r.model ?? ""}`] ??= []).push(r.usage.costUsd / r.durationMs);
  }

  let total = 0;
  for (const r of inWindow) {
    if (r.usage != null && r.usage.costUsd !== null) {
      total += r.usage.costUsd;
    } else {
      // Unpriced or killed fire: estimate duration × ratePerMs, never $0
      const rates = ratesByProfile[`${r.codingAgent ?? ""}/${r.model ?? ""}`];
      const ratePerMs = rates?.length ? (median(rates) ?? FALLBACK_RATE_PER_MS) : FALLBACK_RATE_PER_MS;
      total += (r.durationMs ?? 0) * ratePerMs;
    }
  }
  return total;
}

// ─── ratePerMsFor (LOOP-230) — per-profile $/ms for the in-flight perFireUsd watchdog ─────────────────────
// The perFireUsd watchdog (run-agents.ts, budget-ceiling Child 4) has no mid-flight cost signal — cost is
// known only post-hoc — so it kills at a wall-clock deadline: perFireUsd / ratePerMs. This returns that rate
// for ONE fire's (codingAgent, model): the median costUsd/durationMs over the window's priced same-profile
// rows — the SAME derivation rollingSpendUsd applies per row — falling back to FALLBACK_RATE_PER_MS when the
// profile has no priced history yet. NEVER returns 0 (a 0 rate ⇒ an infinite deadline ⇒ no enforcement at all).
export function ratePerMsFor(rows: FireRow[], codingAgent: string | null | undefined, model: string | null | undefined, windowMs: number, nowMs: number): number {
  const cutoff = nowMs - windowMs;
  const key = `${codingAgent ?? ""}/${model ?? ""}`;
  const rates: number[] = [];
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (t < cutoff || t > nowMs) continue;                            // LOOP-314: closed era, both bounds
    if (`${r.codingAgent ?? ""}/${r.model ?? ""}` !== key) continue;
    if (r.usage != null && r.usage.costUsd !== null && typeof r.durationMs === "number" && r.durationMs > 0)
      rates.push(r.usage.costUsd / r.durationMs);
  }
  const m = median(rates);
  return m != null && m > 0 ? m : FALLBACK_RATE_PER_MS; // 0/absent ⇒ the conservative floor, never an infinite deadline
}

// ─── checkBudget (LOOP-229) — doctor's budget-ceiling health line ─────────────────────────────────────────
// Mirrors checkLessonsBudget (W03, lessons.ts): a pure READ returning WsWarning[] for doctorWorkspace to
// surface. Never a hard-fail — a WsWarning prints as ⚠️ and keeps DOCTOR_OK (the AC: an unset workspace stays
// DOCTOR_OK with only this single nag). Best-effort: any ledger/read error yields [] (an informational health
// line must never break the gate). The rolling total is the estimate-augmented rollingSpendUsd (a killed fire
// counts, never $0 — INV-5), so doctor's number matches the launch gate and `dev-loop metrics`.
//   • dailyUsd UNSET ⇒ one nag naming the measured 7d burn, so the operator can size a ceiling (ruling #2).
//   • dailyUsd SET and 24h rolling spend is over it ⇒ a breach warning (the scheduler is refusing launches).
export function checkBudget(ws: Workspace): WsWarning[] {
  try {
    const dailyUsd = ws.file.team.budget?.dailyUsd;
    const rows = readFireRows(wsFireLedger(ws));
    const now = Date.now();
    if (dailyUsd == null) {
      const burnPerDay = rollingSpendUsd(rows, 7 * 86_400_000, now) / 7; // 7d avg daily burn (estimate-augmented)
      if (burnPerDay <= 0) return []; // no measured spend yet ⇒ nothing to size a ceiling from
      return [{ code: "W28", path: "team.budget.dailyUsd",
        message: `no daily budget ceiling set — the unattended loop bills ~$${burnPerDay.toFixed(2)}/day (measured, 7d avg) with no cap; set one: dev-loop team set team.budget.dailyUsd <n> (unset = OFF)` }];
    }
    const rolling = rollingSpendUsd(rows, 86_400_000, now);
    if (rolling > dailyUsd)
      return [{ code: "W28", path: "team.budget.dailyUsd",
        message: `budget BREACH — rolling 24h spend $${rolling.toFixed(2)} is over dailyUsd $${dailyUsd.toFixed(2)}; the scheduler is refusing launches until it drops below (raise the ceiling, or let the 24h window roll over)` }];
    return [];
  } catch { return []; }
}

// Rotation: keep the last `keepMs` of rows (default 90d). Called at scheduler start — unbounded
// append-forever growth was the fires.jsonl retention gap. Atomic rewrite; a torn line is dropped.
export function pruneFireLedger(ledgerPath: string, keepMs = 90 * 86_400_000, nowMs = Date.now()): void {
  try {
    if (!existsSync(ledgerPath) || statSync(ledgerPath).size === 0) return;
    const cutoff = nowMs - keepMs;
    const keep = readFireRows(ledgerPath).filter((r) => Date.parse(r.ts) >= cutoff);
    const tmp = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""));
    renameSync(tmp, ledgerPath);
  } catch { /* rotation is best-effort; never blocks the scheduler */ }
}

// usageReport — pure, deterministic aggregation over a FireRow slice. All three read surfaces
// (CLI, web /usage, digest) call this ONE function so numbers are never computed twice.
// Honest-null rules: a summed metric is null, NEVER 0, when metered===0 (no measurement at all).
// bootBytes is never read into any usage/cost field — this function never touches it.
// LOOP-268 — `b` is `number | null | undefined`, deliberately. A ledger row is parsed with a bare
// `JSON.parse(t) as FireRow` and zero runtime validation, so a `usage` object from a future schema
// version, a hand-edited/legacy line, or a third-party writer can be MISSING a key rather than
// carrying an explicit null. `a ?? 0` collapsed that absence to 0, which silently violates this
// function's own documented invariant ("null, NEVER 0, when unmetered") — the one contract the
// --usage flag's --help promises. Absent and null must mean the same thing: no measurement.
const sumNull = (a: number | null, b: number | null | undefined): number | null =>
  a === null && (b === null || b === undefined) ? null : (a ?? 0) + (b ?? 0);

function emptyCell(): UsageCell {
  return { fires: 0, metered: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, discardedUsd: null, discardedFires: 0, costMetered: 0, costPriced: 0 };
}

function addToCell(cell: UsageCell, r: FireRow): void {
  cell.fires++;
  const discarded = !!(r.suspectError || r.interrupted); // LOOP-219: read the flag, never re-derive it
  if (discarded) cell.discardedFires++;
  if (!r.usage) return;                                              // no measurement → only fires counter touched
  cell.metered++;
  cell.inputTokens = sumNull(cell.inputTokens, r.usage.inputTokens);
  cell.outputTokens = sumNull(cell.outputTokens, r.usage.outputTokens);
  cell.cacheReadTokens = sumNull(cell.cacheReadTokens, r.usage.cacheReadTokens);
  cell.cacheWriteTokens = sumNull(cell.cacheWriteTokens, r.usage.cacheWriteTokens);
  // LOOP-268: `!= null` (loose) — an ABSENT costUsd key is not a $0 fire, it is an unpriced one.
  if (r.usage.costUsd != null) {
    cell.costUsd = (cell.costUsd ?? 0) + r.usage.costUsd; cell.costMetered++;
    if (r.usage.costUsd > 0) cell.costPriced++;
    if (discarded) cell.discardedUsd = (cell.discardedUsd ?? 0) + r.usage.costUsd;
    else cell.discardedUsd = cell.discardedUsd ?? 0; // priced rows exist ⇒ 0.00 is a MEASURED zero
  }
}

export function usageReport(rows: FireRow[], windowMs: number, opts: { groupBy?: UsageDimension; nowMs?: number } = {}): UsageReport {
  const until = opts.nowMs ?? Date.now();
  const cutoff = until - windowMs;                                   // LOOP-314: closed era, both bounds
  const inWindow = rows.filter((r) => { const t = Date.parse(r.ts); return t >= cutoff && t <= until; });
  const overall = emptyCell();
  const dimMap: Record<string, UsageCell> | undefined = opts.groupBy ? {} : undefined;
  for (const r of inWindow) {
    addToCell(overall, r);
    if (dimMap !== undefined && opts.groupBy) {
      const key = (r[opts.groupBy] ?? "(unknown)") as string;
      const cell = (dimMap[key] ??= emptyCell());
      addToCell(cell, r);
    }
  }
  return {
    windowMs,
    totalFires: overall.fires,
    meteredFires: overall.metered,
    overall,
    ...(dimMap !== undefined ? { byDimension: dimMap } : {}),
  };
}

// fireRowsFromEvents — reconstruct FireRow[] from the project's fire.completed hub events.
// Used by Child B (the web /usage page) which reads the query_only db, not fires.jsonl.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fireRowsFromEvents(db: any, projectId: string, sinceIso: string): FireRow[] {
  const projectRow = db.prepare("SELECT key FROM projects WHERE id=?").get(projectId) as { key: string } | undefined;
  const projectKey = projectRow?.key ?? "";
  const events = db.prepare(
    "SELECT actor, created_at, data FROM events WHERE project_id=? AND kind='fire.completed' AND created_at>=? ORDER BY created_at",
  ).all(projectId, sinceIso) as { actor: string; created_at: string; data: string }[];
  const out: FireRow[] = [];
  for (const e of events) {
    try {
      const d = JSON.parse(e.data) as Partial<FireRow>;
      out.push({
        ts: e.created_at,
        agent: e.actor,
        project: projectKey,
        ...(d.codingAgent !== undefined ? { codingAgent: d.codingAgent } : {}),
        ...(d.provider !== undefined ? { provider: d.provider } : {}),
        ...(d.model !== undefined ? { model: d.model } : {}),
        ...(d.effort !== undefined ? { effort: d.effort } : {}),
        ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
        ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
        ...(d.timedOut !== undefined ? { timedOut: d.timedOut } : {}),
        ...(d.suspectError ? { suspectError: true } : {}),
        ...(d.errorClass !== undefined ? { errorClass: d.errorClass } : {}),
        ...(d.bootBytes !== undefined ? { bootBytes: d.bootBytes } : {}),
        ...(d.fireId !== undefined ? { fireId: d.fireId } : {}),
        ...(d.usage !== undefined ? { usage: d.usage } : {}),
      });
    } catch { /* skip malformed event data */ }
  }
  return out;
}

// ─── the per-fire budget watchdog's deadline (LOOP-230 / LOOP-297) ───────────
// Lives HERE, beside ratePerMsFor — its only input — rather than in run-agents.ts, so the surface that
// DISPLAYS the armed deadline and the watchdog that ENFORCES it are the same function and cannot drift
// (LOOP-297 AC2). run-agents.ts imports it; nothing may import run-agents.ts (it calls main()
// unconditionally, LOOP-58), which is exactly why the display had no way to reuse the enforcer before.
//
// Provenance of the default (LOOP-230 AC4), from the observed distribution: the worst runaway was
// $18.21 over ~60 min, a NORMAL fire costs pm $6.43 / senior $7.46, so $12.00 sits above the priciest
// normal fire (1.61x) and below the runaway.
// AND — the part the dollar figure hides (LOOP-297 AC4) — the MECHANISM ACTS IN TIME, not dollars:
// $12.00 divided by each profile's measured $/hr arms at ~28-61 min depending on profile. For the
// pricier opus profiles that is INSIDE the 60-min wall, so the budget ceiling, not `fireTimeout`, is
// what actually bounds those fires. That conversion moves as the ledger moves; nothing printed it,
// so no operator could answer "how long may a senior-dev fire run today?" from any command.
export const DEFAULT_PER_FIRE_USD = 12.00;
export const RATE_WINDOW_MS = 7 * 86_400_000; // window for the per-profile $/ms median

export function perFireDeadline(
  ceilingUsd: number | null,
  rows: FireRow[] | null,
  codingAgent: string | null | undefined,
  model: string | null | undefined,
  nowMs: number,
): { deadlineMs: number; ratePerMs: number } | null {
  if (ceilingUsd == null || !(ceilingUsd > 0)) return null;   // unset/invalid => no watchdog
  try {
    const ratePerMs = ratePerMsFor(rows ?? [], codingAgent, model, RATE_WINDOW_MS, nowMs);
    const budgetMs = ceilingUsd / ratePerMs;                  // ms of runtime whose estimated spend == the ceiling
    // Bounds are deliberately ASYMMETRIC. Past the 32-bit setTimeout limit (LOOP-260) the ceiling is
    // unreachable inside any real fire, so nothing arms and the wall timeout owns it. Below 1ms it
    // CLAMPS rather than disarming: that ceiling is crossed instantly, so killing at once IS its meaning.
    if (!Number.isFinite(budgetMs) || budgetMs > 2_147_483_647) return null;
    return { deadlineMs: Math.max(1, budgetMs), ratePerMs };
  } catch { return null; }                                    // any read error => fail open, never break a launch
}

// LOOP-297 — the profiles present in the window, with the deadline each one's ceiling actually arms.
export interface ProfileDeadline { codingAgent: string; model: string; usdPerHour: number; deadlineMinutes: number | null; priced: boolean; fires: number }
export function profileDeadlines(rows: FireRow[], ceilingUsd: number | null, windowMs: number, nowMs: number): ProfileDeadline[] {
  const cutoff = nowMs - windowMs;
  const seen = new Map<string, { codingAgent: string; model: string; fires: number; priced: number }>();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (t < cutoff || t > nowMs) continue;
    const codingAgent = r.codingAgent ?? "";
    const model = r.model ?? "";
    const k = `${codingAgent}/${model}`;
    const e = seen.get(k) ?? { codingAgent, model, fires: 0, priced: 0 };
    e.fires++;
    if (r.usage != null && r.usage.costUsd != null && r.usage.costUsd > 0 && typeof r.durationMs === "number" && r.durationMs > 0) e.priced++;
    seen.set(k, e);
  }
  const out: ProfileDeadline[] = [];
  for (const e of seen.values()) {
    const d = perFireDeadline(ceilingUsd, rows, e.codingAgent, e.model, nowMs);
    const ratePerMs = d?.ratePerMs ?? ratePerMsFor(rows, e.codingAgent, e.model, RATE_WINDOW_MS, nowMs);
    out.push({
      codingAgent: e.codingAgent || "(unset)",
      model: e.model || "(cli default)",
      usdPerHour: ratePerMs * 3_600_000,
      deadlineMinutes: d ? d.deadlineMs / 60_000 : null,
      priced: e.priced > 0,
      fires: e.fires,
    });
  }
  return out.sort((a, b) => b.fires - a.fires);
}

// ─── board KPIs (service backend — from `issue.transition` events) ───────────
export interface BoardMetrics {
  throughput: number;         // transitions → Done in the window (board-wide; LOOP-42's contract, unchanged)
  verifyFails: number;        // In Review → Canceled (the §3 verify-fail close edge)
  acceptRate: number | null;  // LOOP-98: In Review→Done ÷ ALL In Review exits; null when there are none
  inReviewExits: Record<string, number>; // LOOP-98: every In Review exit edge, keyed by destination state
  blockedNow: number;         // parked tickets needing human attention (Human-Blocked ∪ blocked-label w/o live edge)
  sequencedNow: number;       // open `blocked` tickets with a live Blocked-by edge (will self-unpark)
  historyFloor: string | null; // LOOP-313: earliest `events` row for the project — null when there are none
  historyIncomplete: boolean;  // LOOP-313: true when the floor is INSIDE the window (aggregates are partial)
  qa: { bugsFiled: number; escaped: number | null; escapeRatio: number | null }; // LOOP-122: null = unmeasurable
  // LOOP-329 — the BACKLOG side per tier, which no surface reported. Without it a tier with capacity
  // and nothing it may pull is invisible, and PM re-derived it by hand on every fire.
  tiers?: { cap: number; todo: TierDepth; backlog: TierDepth };
}

export type TierDepth = { total: number; "senior-dev": number; "junior-dev": number; dev: number };

// ─── shared parked-split (LOOP-31) — per-backend human-park population ─────
// Returns the ticket IDs that are "parked" (need human attention):
//   • Human-Blocked state tickets (the operator park, service backend)
//   • blocked-label tickets without a live Blocked-by edge (Dev bail parks)
// A ticket that is BOTH Human-Blocked AND edge-sequenced counts as parked
// (a human is the gate; the edge is not what is holding it).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parkedSplit(db: any, projectId: string): { parkedIds: string[]; sequencedNow: number } {
  const humanBlocked = db.prepare(
    "SELECT id FROM tickets WHERE project_id=? AND state='Human-Blocked'",
  ).all(projectId) as { id: string }[];
  const blockedTickets = db.prepare(
    "SELECT id FROM tickets WHERE project_id=? AND state NOT IN ('Done','Canceled','Duplicate') AND labels LIKE '%\"blocked\"%'",
  ).all(projectId) as { id: string }[];
  const parked = new Set<string>();
  for (const { id } of humanBlocked) parked.add(id);
  let sequencedNow = 0;
  for (const { id } of blockedTickets) {
    if (parked.has(id)) continue; // already parked via Human-Blocked state
    if (hasLiveBlockerEdge(db, id)) sequencedNow++;
    else parked.add(id);
  }
  return { parkedIds: [...parked], sequencedNow };
}

const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]);

// True if the ticket has at least one Blocked-by: marker comment referencing a ticket still open.
// Delegates to liveBlockerIds (canonical multi-id + Unblocked-by-aware parser).
// Fail-safe: no marker → empty set → false (counts as parked, the safe under-report direction).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasLiveBlockerEdge(db: any, ticketId: string): boolean {
  // P2 fix: secondary sort by rowid (insertion order) makes ordering deterministic when two
  // comments share a millisecond-resolution created_at timestamp (rapid or concurrent writes).
  const comments = db.prepare("SELECT body FROM comments WHERE ticket_id=? ORDER BY created_at, rowid").all(ticketId) as { body: string }[];
  const { live, hadReadFailure } = liveBlockerIds(comments);
  // If any comment was partially read, we can't trust the live set — treat as sequenced (safe direction).
  if (hadReadFailure) return true;
  if (live.size === 0) return false;
  for (const id of live) {
    const row = db.prepare("SELECT state FROM tickets WHERE id=?").get(id) as { state: string } | undefined;
    if (row && !TERMINAL.has(row.state)) return true;
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function boardMetrics(db: any, projectId: string, windowMs: number, nowMs = Date.now(), opts: { escapeSourceConfigured?: boolean } = {}): BoardMetrics {
  const cutoffIso = new Date(nowMs - windowMs).toISOString();
  const untilIso = new Date(nowMs).toISOString();                    // LOOP-314: closed era, both bounds
  const transitions = db.prepare(
    "SELECT data FROM events WHERE project_id=? AND kind='issue.transition' AND created_at>=? AND created_at<=?",
  ).all(projectId, cutoffIso, untilIso) as { data: string }[];
  // LOOP-98 — `throughput` and `acceptRate` are DIFFERENT populations and the code used one count for
  // both. `done` is board-wide (every `→ Done`, whatever the source state) and is correct for
  // throughput, its actual job; reused as an ACCEPT numerator it counts work nothing ever verified.
  // The denominator was `done + verifyFails`, where verifyFails is only `In Review → Canceled` — so
  // two of four In Review exit edges were missing. Both errors push the same way, so they compound:
  // 86.5% shown vs 75.0% true on the board that found this.
  //
  // The denominator is derived as "every transition whose `from` is In Review", NEVER a hard-coded
  // list of destinations: a new exit target added later must widen it, not silently shrink it.
  let done = 0, verifyFails = 0;
  const inReviewExits: Record<string, number> = {};
  for (const t of transitions) {
    try {
      const d = JSON.parse(t.data) as { from?: string; to?: string };
      if (d.to === "Done") done++;
      if (d.from === "In Review") {
        const to = d.to ?? "(unknown)";
        inReviewExits[to] = (inReviewExits[to] ?? 0) + 1;
        if (to === "Canceled") verifyFails++;
      }
    } catch { /* skip */ }
  }
  const reviewExitTotal = Object.values(inReviewExits).reduce((a, b) => a + b, 0);
  const acceptRate = reviewExitTotal ? (inReviewExits["Done"] ?? 0) / reviewExitTotal : null;

  // Split blocked tickets into parked (attention-needed) vs sequenced (live dependency edge).
  // Uses shared parkedSplit which also counts Human-Blocked state tickets (LOOP-31).
  const { parkedIds, sequencedNow } = parkedSplit(db, projectId);
  const blockedNow = parkedIds.length;
  const bugs = db.prepare(
    "SELECT labels FROM tickets WHERE project_id=? AND type='Bug' AND created_at>=? AND created_at<=?",
  ).all(projectId, cutoffIso, untilIso) as { labels: string }[];
  // LOOP-122 — `escaped` counts `incident`/`signal` labels, and BOTH are written only by agents
  // (ops, communication) that may not run at all. On a loop running neither, the field is 0 by
  // construction and renders as "0 escaped to prod" — a confident production-quality claim from a
  // measurement that cannot exist. null means "no measurement exists"; a real 0 keeps its meaning.
  // Same contract LOOP-42 set for `landed`: unknown renders as unknown, NEVER as 0-as-healthy.
  const escapeSource = opts.escapeSourceConfigured ?? true;
  let escapedCount = 0;
  for (const b of bugs) if (/"incident"|"signal"/.test(b.labels)) escapedCount++;
  const escaped = escapeSource ? escapedCount : null;
  const qa = {
    bugsFiled: bugs.length,
    escaped,
    escapeRatio: escaped !== null && bugs.length ? escaped / bugs.length : null,
  };

  // LOOP-313 — every windowed aggregate here is computed over `events`, and that table can begin
  // LATER than the window (the 2026-08-04 cascade delete took every board-mutation row with it, so
  // "6 done · 30d" printed on a board holding 174 Done tickets). Expose the floor so no surface has
  // to guess whether a number it is about to print covers the window it labels.
  const floorRow = db.prepare(
    "SELECT MIN(created_at) AS floor FROM events WHERE project_id=?",
  ).get(projectId) as { floor: string | null } | undefined;
  const historyFloor = floorRow?.floor ?? null;
  const historyIncomplete = historyFloor !== null && Date.parse(historyFloor) > nowMs - windowMs;

  return { throughput: done, verifyFails, acceptRate, inReviewExits, blockedNow, sequencedNow, historyFloor, historyIncomplete, qa };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseWindow(s: string): number {
  const m = s.trim().match(/^(\d+)(d|h)$/);
  if (!m) { console.error(`metrics: invalid --window '${s}' (use e.g. 7d, 24h)`); process.exit(2); }
  return Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

// P1-3: the operator's decision queue as ONE queryable set — Human-Blocked ∪ In Review assigned to the
// operator. The daemon reminder pings it; the §22a digest carries it; this is the shared read.
// `enteredAt` (LOOP-108) is the transition INTO the queue state — the operator's real wait. It is
// optional on the interface because decisionQueue() itself does not compute it (one extra query per
// row); collectBoardMetrics fills it in. Renderers must prefer it and fall back to updatedAt.
export interface DecisionItem { id: string; title: string; state: string; updatedAt: string; enteredAt?: string }
export function decisionQueue(db: import("node:sqlite").DatabaseSync, projectId: string): DecisionItem[] {
  return (db.prepare(
    "SELECT id,title,state,updated_at FROM tickets WHERE project_id=? AND (state='Human-Blocked' OR (state='In Review' AND assignee='operator')) ORDER BY updated_at",
  ).all(projectId) as { id: string; title: string; state: string; updated_at: string }[])
    .map((t) => ({ id: t.id, title: t.title, state: t.state, updatedAt: t.updated_at }));
}

// LOOP-207: "waiting since" for a decision-queue item — the newest issue.transition INTO the ticket's
// current queue-state (Human-Blocked, or In Review-for-operator), from the events ledger; issue.create
// then the tickets row's created_at as fallbacks when it was never transitioned in (seeded/imported).
// This is the SAME question daemon-notifiers.ts:89-94 (the reminder age) and views/activity.ts HIST_SQL
// answer — modeled on that reader, deliberately NOT tickets.updated_at, so an unrelated later write (a
// Sweep label repair, §9c edge re-pointing) cannot change a parked item's reported age or the "oldest"
// ordering. `state` is the item's current queue-state (from decisionQueue), the daemon-notifiers `approval`
// discriminator; the ledger idiom keys on the globally-unique ticket_id, so no projectId is needed.
export function decisionEnteredAt(db: import("node:sqlite").DatabaseSync, ticketId: string, state: string): string {
  const rows = db.prepare(
    "SELECT data, created_at FROM events WHERE ticket_id=? AND kind='issue.transition' ORDER BY id DESC",
  ).all(ticketId) as { data: string; created_at: string }[];
  for (const e of rows) {
    let to: string | undefined;
    try { to = (JSON.parse(e.data) as { to?: string }).to; } catch { /* skip a malformed ledger row */ }
    if (to === state) return e.created_at;
  }
  const created = (db.prepare(
    "SELECT created_at FROM events WHERE ticket_id=? AND kind='issue.create' ORDER BY id DESC",
  ).get(ticketId) as { created_at: string } | undefined)?.created_at;
  if (created) return created;
  const row = (db.prepare("SELECT created_at FROM tickets WHERE id=?").get(ticketId) as { created_at: string } | undefined)?.created_at;
  return row ?? new Date(0).toISOString();
}

// P1-4: owner-liveness — an owner label whose actor never fires strands its tickets forever (the field's
// MP-156: qa-owned In Review sat 4+ days because no qa agent exists in the roster and nothing noticed).
// A finding = an agent handle that OWNS open Todo/In Review tickets (labels carry the owner handle) but
// has NO fires.jsonl row inside the window. `manual` handles (agents.<h>.manual:true — the operator runs
// that role by hand) still surface, flagged manual:true, so the digest can say "awaiting a human <h>"
// instead of warning. Doctor renders these as W16; Sweep quotes them in the board-health digest.
export interface OwnerLivenessFinding { owner: string; openTickets: number; oldestUpdatedAt: string; lastFireTs: string | null; manual: boolean }
/**
 * Agents that FIRED in the window and left no report (LOOP-28, §22).
 *
 * §22 states the contract plainly — "every agent leaves a durable, human-readable trail of what it
 * did" — and the README sells the reports tree as a core value prop. Measured in this workspace:
 * 7 of 21 fires left no trail, and nothing noticed. A fire with no report is an invisible hole in
 * the operator's only record of what the loop did.
 *
 * DISTINCT from ownerLiveness (W16), which reports an owner whose actor NEVER FIRES — that is a
 * routing problem. This one reports an agent that fires and produces no record, which is a trail
 * problem, and an agent with zero fires is deliberately not this check's business.
 *
 * Best-effort throughout: a missing ledger, a missing reports tree or an unreadable directory
 * produces no finding and never throws. A doctor check that can fail is a doctor check that gets
 * removed.
 */
export interface ReportTrailFinding { agent: string; fires: number; expectedDir: string; windowDays: number }

export function reportTrailGaps(
  ledgerPath: string,
  reportsRootDir: string,
  opts: { windowMs?: number; nowMs?: number; handles?: readonly string[] } = {},
): ReportTrailFinding[] {
  const windowMs = opts.windowMs ?? 7 * 86_400_000;
  const nowMs = opts.nowMs ?? Date.now();
  const since = new Date(nowMs - windowMs).toISOString();
  const handles = opts.handles ?? AGENT_HANDLES;
  let rows: ReturnType<typeof readFireRows>;
  try { rows = readFireRows(ledgerPath); } catch { return []; }

  // The days each agent actually fired, so the check asks "was there a report for a day this agent
  // worked?" rather than "is the directory non-empty?" — an agent with one stale report from a month
  // ago has still left this window's fires untraced.
  const firedDays = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.ts || r.ts < since) continue;
    if (!firedDays.has(r.agent)) firedDays.set(r.agent, new Set());
    firedDays.get(r.agent)!.add(r.ts.slice(0, 10));
  }

  const out: ReportTrailFinding[] = [];
  for (const h of handles) {
    const days = firedDays.get(h);
    if (!days?.size) continue;                       // zero fires in the window is W16's business
    // §22's tree is <reports>/<handle>-agent/daily/<YYYY-MM-DD>.md. The `-agent` suffix is the
    // mapping, and getting it wrong would make every agent look untraced.
    const dir = join(reportsRootDir, `${h}-agent`, "daily");
    let present: Set<string>;
    try { present = new Set(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))); }
    catch { present = new Set(); }                   // no tree yet ⇒ nothing reported, which IS the finding
    if ([...days].some((d) => present.has(d))) continue;
    out.push({ agent: h, fires: [...rows].filter((r) => r.agent === h && r.ts >= since).length, expectedDir: dir, windowDays: Math.round(windowMs / 86_400_000) });
  }
  return out;
}

export function ownerLiveness(
  db: import("node:sqlite").DatabaseSync, projectId: string, ledgerPath: string,
  opts: { windowMs?: number; nowMs?: number; manualHandles?: Set<string>; handles?: readonly string[] },
): OwnerLivenessFinding[] {
  const windowMs = opts.windowMs ?? 7 * 86_400_000;
  const nowMs = opts.nowMs ?? Date.now();
  const handles = opts.handles ?? AGENT_HANDLES;
  const rows = readFireRows(ledgerPath);
  const lastFire = new Map<string, string>();
  for (const r of rows) if (!lastFire.has(r.agent) || r.ts > (lastFire.get(r.agent) ?? "")) lastFire.set(r.agent, r.ts);
  const out: OwnerLivenessFinding[] = [];
  for (const h of handles) {
    const owned = db.prepare(
      "SELECT assignee, labels, state, updated_at FROM tickets WHERE project_id=? AND state IN ('Todo','In Review','In Progress') ORDER BY updated_at",
    ).all(projectId) as { assignee: string | null; labels: string; state: string; updated_at: string }[];
    // Ownership rules — ONE statement of them, for the whole owned set (LOOP-30 + LOOP-102):
    //   Todo        → union(assignee, label): tickets routed by assignee alone (no tier label) must
    //                 not be invisible to the detector (LOOP-30).
    //   In Review   → label only: the label names the VERIFIER, while assignee still points at the
    //                 dev who shipped it.
    //   In Progress → assignee only: a claim is held by the actor that moved it, never by a label.
    //                 This is the state whose ONLY recovery is the claimant firing again, so a dead
    //                 claimant strands it hardest — and it was the one open state W16 could not see.
    //   blocked     → EXCLUDED in every state: every serving path filters the label out
    //                 (agentops.ts opQueue and todoDepth both do), so W16's remedy — "re-owner them,
    //                 or mark the role manual" — is a no-op for a blocked ticket: re-owning it makes
    //                 no router serve it. Counting them inflated the number by ~26% with work the
    //                 fix could not release.
    //   Human-Blocked → deliberately NOT in the set. It is a park awaiting a HUMAN, not owner
    //                 stranding, and it already has its own surface in the operator decision queue
    //                 (W20). Do not "fix" it into the set.
    const mine = owned.filter((t) => {
      let labels: string[] = [];
      try { labels = JSON.parse(t.labels) as string[]; } catch { labels = []; }
      if (labels.includes("blocked")) return false;
      if (t.state === "In Review") return labels.includes(h);
      if (t.state === "In Progress") return t.assignee === h;
      return t.assignee === h || labels.includes(h);
    });
    if (!mine.length) continue;
    const last = lastFire.get(h) ?? null;
    const alive = last !== null && nowMs - Date.parse(last) <= windowMs;
    if (alive) continue;
    out.push({ owner: h, openTickets: mine.length, oldestUpdatedAt: mine[0].updated_at, lastFireTs: last, manual: opts.manualHandles?.has(h) ?? false });
  }
  return out;
}

// P4: sensitive mis-tier backstop — non-terminal tickets carrying `sensitive` AND assigned to the
// junior-dev tier (by assignee or label). Surfaced as doctor W21 and in the board-health rollup
// (design sensitive-routing §§3-4). Silent in single-dev projects (no senior-dev actor present).
export interface SensitiveMistierFinding { id: string; assignee: string | null; labels: string[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sensitiveMistier(db: any, projectId: string): SensitiveMistierFinding[] {
  const hasSenior = db.prepare("SELECT 1 FROM actors WHERE handle='senior-dev' AND active=1").get() !== undefined;
  if (!hasSenior) return [];
  const rows = db.prepare(
    "SELECT id, assignee, labels FROM tickets WHERE project_id=? AND state NOT IN ('Done','Canceled','Duplicate') AND labels LIKE '%\"sensitive\"%' AND (assignee='junior-dev' OR labels LIKE '%\"junior-dev\"%')",
  ).all(projectId) as { id: string; assignee: string | null; labels: string }[];
  return rows.map((r) => {
    let labels: string[] = [];
    try { labels = JSON.parse(r.labels) as string[]; } catch { /* leave empty */ }
    return { id: r.id, assignee: r.assignee, labels };
  });
}

// ─── kaizen panel ─────────────────────────────────────────────────────────────

export interface KaizenReport {
  windowMs: number;
  selfImprovement: {
    selfFiled: number; selfFixed: number; totalDone: number;
    selfFixRate: number | null;   // selfFixed/selfFiled, null if selfFiled===0
    selfSlice: number | null;     // selfFixed/totalDone, null if totalDone===0
    fixedIds: string[];
  };
  lessons: { entries: number; byMonth: Record<string, number>; present: boolean };
  ratchet: { current: number | null; history: Array<{ value: number; version: string }> | null; source: string };
  evolution: { filed: number; appliedProxy: number };
  verifyFail: { totalInWindow: number; byClass: null };
  showHeaderLine: boolean;        // selfFixed >= 1, computed once so both surfaces agree
}

// LOOP-266 — `projectKey` scopes the file set to what a fire for THAT project actually receives.
// This stat is rendered under a per-project `[key]` heading but was computed over EVERY `*.md` in
// the lessons dir, so a three-project workspace showed all three the same total and told a project
// with no shard that it had 8 lessons when 6 ever reach its fires. The authority is six lines away
// in lessons.ts: `lessonsForFire(ws, project)` loads INDEX.md plus that ONE project's shard.
// projectKey omitted ⇒ the old whole-directory behaviour, for callers with no project in hand.
function parseLessons(lessonsDir: string, projectKey?: string): KaizenReport["lessons"] {
  if (!existsSync(lessonsDir)) return { entries: 0, byMonth: {}, present: false };
  const files: string[] = [];
  try {
    const index = join(lessonsDir, "INDEX.md");
    if (existsSync(index)) files.push(index);
    if (projectKey !== undefined) {
      const shard = join(lessonsDir, `${projectKey}.md`);
      if (existsSync(shard)) files.push(shard);
    } else {
      for (const f of readdirSync(lessonsDir)) {
        if (f !== "INDEX.md" && f !== "archive.md" && f.endsWith(".md")) files.push(join(lessonsDir, f));
      }
    }
  } catch { return { entries: 0, byMonth: {}, present: false }; }
  let entries = 0;
  const byMonth: Record<string, number> = {};
  for (const f of files) {
    let txt = "";
    try { txt = readFileSync(f, "utf8"); } catch { return { entries: 0, byMonth: {}, present: false }; }
    for (const line of txt.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ")) continue;
      entries++;
      const m = /(\d{4}-\d{2})-\d{2}/.exec(trimmed);
      if (m) byMonth[m[1]] = (byMonth[m[1]] ?? 0) + 1;
    }
  }
  return { entries, byMonth, present: true };
}

function parseRatchet(pkgJsonPath: string, gauntletDocPath: string): KaizenReport["ratchet"] {
  let current: number | null = null;
  let pkgJson = "";
  try { pkgJson = readFileSync(pkgJsonPath, "utf8"); } catch { /* no package.json */ }
  if (pkgJson) {
    let scripts: Record<string, string> = {};
    try { scripts = (JSON.parse(pkgJson) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { /* ignore */ }
    const q = scripts["quality"] ?? "";
    const m = /--threshold\s+(\d+)/.exec(q);
    if (m) current = parseInt(m[1], 10);
  }
  let history: Array<{ value: number; version: string }> | null = null;
  let gauntletTxt = "";
  try { gauntletTxt = readFileSync(gauntletDocPath, "utf8"); } catch { /* no doc */ }
  if (gauntletTxt) {
    const m = /ratchet trajectory:\s*(.+)/i.exec(gauntletTxt);
    if (m) {
      const raw = m[1].replace(/\*+/g, "");  // strip markdown emphasis (** and *)
      const pairs: Array<{ value: number; version: string }> = [];
      const re = /(\d+)\s*\(([^)]+)\)/g;
      let pm: RegExpExecArray | null;
      while ((pm = re.exec(raw)) !== null) pairs.push({ value: parseInt(pm[1], 10), version: pm[2] });
      if (pairs.length) history = pairs;
    }
  }
  const source = gauntletDocPath;
  return { current, history, source };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function kaizenReport(
  db: any,
  projectId: string,
  opts: { nowMs: number; windowMs?: number; lessonsDir?: string; projectKey?: string; ratchetSources?: { pkgJson: string; gauntletDoc: string } },
): KaizenReport {
  const windowMs = opts.windowMs ?? 7 * 86_400_000;
  // Stat 1 — self-filed → self-fixed
  const inList = AGENT_HANDLES.map(() => "?").join(",");
  const filed = db.prepare(
    `SELECT id, state, updated_at FROM tickets WHERE project_id=? AND created_by IN (${inList})`,
  ).all(projectId, ...AGENT_HANDLES) as { id: string; state: string; updated_at: string }[];
  const selfFiled = filed.length;
  // P2 fix: sort Done rows by updated_at DESC so the first 20 in the report are the most recent.
  const fixedRows = filed.filter((r) => r.state === "Done").sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const selfFixed = fixedRows.length;
  const totalDone = (db.prepare("SELECT COUNT(*) as n FROM tickets WHERE project_id=? AND state='Done'").get(projectId) as { n: number }).n;
  const fixedIds = fixedRows.map((r) => r.id);
  const selfFixRate = selfFiled > 0 ? selfFixed / selfFiled : null;
  const selfSlice = totalDone > 0 ? selfFixed / totalDone : null;
  // Stat 2 — lessons
  // LOOP-266: scoped to the project the panel is rendered under, matching lessonsForFire.
  const lessons = opts.lessonsDir ? parseLessons(opts.lessonsDir, opts.projectKey) : { entries: 0, byMonth: {}, present: false };
  // Stat 3 — quality ratchet
  const ratchet = opts.ratchetSources
    ? parseRatchet(opts.ratchetSources.pkgJson, opts.ratchetSources.gauntletDoc)
    : { current: null, history: null, source: "" };
  // Stat 4 — §17 proposals (amended: trailing % to match real titles like "[reflect-proposal] ...")
  const evoRows = db.prepare(
    "SELECT state FROM tickets WHERE project_id=? AND title LIKE '[%-proposal]%'",
  ).all(projectId) as { state: string }[];
  const evolution = { filed: evoRows.length, appliedProxy: evoRows.filter((r) => r.state === "Done").length };
  // Stat 5 — verify-fail (reuse boardMetrics; byClass permanently null)
  const bm = boardMetrics(db, projectId, windowMs, opts.nowMs);
  const verifyFail = { totalInWindow: bm.verifyFails, byClass: null as null };
  const showHeaderLine = selfFixed >= 1;
  return { windowMs, selfImprovement: { selfFiled, selfFixed, totalDone, selfFixRate, selfSlice, fixedIds }, lessons, ratchet, evolution, verifyFail, showHeaderLine };
}

export function renderKaizen(report: KaizenReport): void {
  const pct = (x: number | null) => x === null ? "—" : `${Math.round(x * 100)}%`;
  const si = report.selfImprovement;
  if (report.showHeaderLine) console.log("It ships software. Then it improves the shipping.");
  // Stat 1
  if (si.selfFiled === 0) {
    console.log("self-improvement: — the loop hasn't filed its own issues yet");
  } else if (si.selfFixed === 0) {
    console.log(`self-improvement: ${si.selfFiled} self-filed, none fixed yet`);
  } else {
    console.log(`self-improvement: ${si.selfFixed}/${si.selfFiled} self-filed issues fixed (${pct(si.selfFixRate)}); ${pct(si.selfSlice)} of all ${si.totalDone} Done tickets`);
    const show = si.fixedIds.slice(0, 20);
    const more = si.fixedIds.length > 20 ? ` (showing latest 20 of ${si.fixedIds.length})` : "";
    console.log(`  fixed: ${show.join(", ")}${more}`);
  }
  // Stat 2
  if (!report.lessons.present) {
    console.log("lessons: — no lessons recorded yet (0 entries)");
  } else if (report.lessons.entries === 0) {
    console.log("lessons: 0 entries");
  } else {
    console.log(`lessons: ${report.lessons.entries} entries`);
    const months = Object.entries(report.lessons.byMonth).sort((a, b) => a[0].localeCompare(b[0]));
    if (months.length) console.log(`  by month: ${months.map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  // Stat 3
  if (report.ratchet.current === null) {
    console.log("quality ratchet: — quality gate threshold not configured");
  } else {
    const hist = report.ratchet.history;
    const histStr = hist ? hist.map((h) => `${h.value} (${h.version})`).join(" → ") : `see ${report.ratchet.source}`;
    console.log(`quality ratchet: current threshold ${report.ratchet.current} | trajectory: ${histStr}`);
  }
  // Stat 4
  if (report.evolution.filed === 0) {
    console.log("§17 proposals: — no §17 proposals filed yet");
  } else {
    console.log(`§17 proposals: ${report.evolution.filed} filed, ${report.evolution.appliedProxy} reached Done (proxy; §17 application is an operator git edit with no board signal)`);
  }
  // Stat 5
  if (report.verifyFail.totalInWindow === 0) {
    console.log(`verify-fails: — no verify-fails in the last ${fmtWindow(report.windowMs)}`);
  } else {
    console.log(`verify-fails: ${report.verifyFail.totalInWindow} in window`);
  }
  console.log("  verify-fail class: not yet recorded (no Verify-fail-class: marker emitted yet)");
}

// Extracted from metricsCli to keep its CC under the ratchet (CRAP-90 guard; kaizen body adds ~6 branches).
async function runKaizenCli(ws: Workspace, boardDb: string, windowMs: number, asJson: boolean): Promise<number> {
  if (ws.file.team.backend !== "service" || !existsSync(boardDb)) {
    console.error("metrics --kaizen: requires service backend with hub.db");
    return 1;
  }
  const { openDb } = await import("./db.ts");
  const { findProject } = await import("./seed.ts");
  const db = openDb(boardDb);
  try {
    const keys = deliveryProjects(ws);
    const hubRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const pkgJson = join(hubRoot, "package.json");
    // P2 fix: gauntlet doc lives at the repo root's docs/, one level above hub/
    const gauntletDoc = join(hubRoot, "..", "docs", "design", "quality-gauntlet.md");
    const lessonsDir = lessonsPaths(ws).dir;
    if (asJson) {
      // P1 fix (LOOP-95 Codex): collect all project reports into one JSON array so
      // --json output is a single parseable value regardless of project count.
      const reports: unknown[] = [];
      for (const key of keys) {
        const pid = findProject(db, key);
        if (!pid) continue;
        reports.push({ key, ...kaizenReport(db, pid, { nowMs: Date.now(), windowMs, lessonsDir, projectKey: key, ratchetSources: { pkgJson, gauntletDoc } }) });
      }
      console.log(JSON.stringify(reports, null, 2));
    } else {
      for (const key of keys) {
        const pid = findProject(db, key);
        if (!pid) continue;
        if (keys.length > 1) console.log(`\n[${key}]`);
        renderKaizen(kaizenReport(db, pid, { nowMs: Date.now(), windowMs, lessonsDir, projectKey: key, ratchetSources: { pkgJson, gauntletDoc } }));
      }
    }
  } finally { db.close(); }
  return 0;
}

// Service-backend board rollup: per-project board KPIs + the operator decision queue folded into
// `out` (1.8.1 quality-gauntlet drain: metricsCli CC 22 → collect/render phases).
// LOOP-122 — does an escape SIGNAL SOURCE exist at all? `escaped` counts the `incident` and `signal`
// labels, and both are written only by the ops and communication agents. Config presence is not the
// test — this workspace configures a cadence for both and runs neither, because neither is in the
// `core` run set. The ledger is the honest record of what actually ran in the window, so that is
// what decides whether a 0 means "measured, nothing escaped" or "nothing could ever have said so".
export function escapeSignalSourceRan(fires: { byAgent: Record<string, { fires: number }> }): boolean {
  return (fires.byAgent["ops"]?.fires ?? 0) > 0 || (fires.byAgent["communication"]?.fires ?? 0) > 0;
}

async function collectBoardMetrics(ws: Workspace, windowMs: number, out: Record<string, unknown>, boardDb: string, escapeSourceConfigured = true, nowMs = Date.now()): Promise<void> {
  if (ws.file.team.backend === "service" && existsSync(boardDb)) {
    const { openDb } = await import("./db.ts");
    const { findProject } = await import("./seed.ts");
    const db = openDb(boardDb);
    try {
      const board: Record<string, BoardMetrics> = {};
      const roll = { throughput: 0, verifyFails: 0, blockedNow: 0, sequencedNow: 0, bugsFiled: 0 };
      // LOOP-122: null-preserving across the rollup — one unmeasurable project makes the TEAM total
      // unmeasurable too. Summing it as 0 would re-introduce the exact reassuring-zero this fixes.
      let escapedRoll: number | null = null;
      // LOOP-98: the team accept rate is re-derived from the same In Review exit population, not from
      // the throughput/verifyFails pair (which are different populations — see boardMetrics).
      const exitsRoll: Record<string, number> = {};
      let historyIncompleteAny = false;
      let historyFloorMin: string | null = null;
      let sensitiveMistierCount = 0;
      const queue: Array<DecisionItem & { project: string }> = [];
      for (const key of deliveryProjects(ws)) {
        const pid = findProject(db, key);
        if (!pid) continue;
        const m = boardMetrics(db, pid, windowMs, nowMs, { escapeSourceConfigured });
        // LOOP-329 — the per-tier Todo/Backlog pair. Attached here rather than inside boardMetrics
        // because it needs the WORKSPACE (for the §5a cap), and boardMetrics takes only a db handle.
        if (effectiveProject(ws, key).devSplit ?? false) {
          m.tiers = { cap: resolveTodoDepthCap(ws, key), todo: servableTodoDepth(db, pid), backlog: servableBacklogDepth(db, pid) };
        }
        board[key] = m;
        roll.throughput += m.throughput; roll.verifyFails += m.verifyFails; roll.blockedNow += m.blockedNow; roll.sequencedNow += m.sequencedNow;
        roll.bugsFiled += m.qa.bugsFiled;
        if (m.qa.escaped !== null) escapedRoll = (escapedRoll ?? 0) + m.qa.escaped;
        for (const [to, n] of Object.entries(m.inReviewExits)) exitsRoll[to] = (exitsRoll[to] ?? 0) + n;
        if (m.historyIncomplete) historyIncompleteAny = true;
        if (m.historyFloor && (historyFloorMin === null || m.historyFloor < historyFloorMin)) historyFloorMin = m.historyFloor;
        sensitiveMistierCount += sensitiveMistier(db, pid).length;
        // LOOP-108: the wait is measured from the transition INTO the queue state, never from
        // tickets.updated_at — an unrelated later write (Sweep's own hygiene comment did exactly
        // this: 1h10m → 1m on LOOP-101) must not reset the operator's oldest-item age.
        queue.push(...decisionQueue(db, pid).map((t) => ({ ...t, project: key, enteredAt: decisionEnteredAt(db, t.id, t.state) })));
      }
      queue.sort((a, b) => (a.enteredAt ?? a.updatedAt).localeCompare(b.enteredAt ?? b.updatedAt)); // oldest WAIT first
      out.board = board;
      const exitTotal = Object.values(exitsRoll).reduce((a, b) => a + b, 0);
      out.teamRollup = {
        ...roll,
        escaped: escapedRoll,
        acceptRate: exitTotal ? (exitsRoll["Done"] ?? 0) / exitTotal : null,
        inReviewExits: exitsRoll,
        historyIncomplete: historyIncompleteAny,
        historyFloor: historyFloorMin,
        sensitiveMistierCount,
      };
      out.decisionQueue = queue;
    } finally { db.close(); }
  } else {
    out.boardNote = "linear backend: board KPIs are computed by the digest agent via MCP queries (§22 digest contract); this CLI reports fire metrics only.";
  }
  // Landing state (forge; all backends; best-effort) — LOOP-42 / design landing-observability §5.2.
  // Single reader invariant: only landing.ts touches the forge (§4); metrics never opens its own gh call.
  try {
    const { readLandingState } = await import("./landing.ts");
    const landingStates = await readLandingState(ws, { windowMs });
    out.landing = landingStates;
    const known = landingStates.filter((s) => s.mergedInWindow !== null).map((s) => s.mergedInWindow as number);
    out.landed = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
  } catch {
    out.landed = null;
    out.landing = [];
  }
}

const fmtDur = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)}d` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
};

// The default human render (asserted non-JSON by the 1.7.1 mutation-killer test).
// Exported so tests can call it directly with a fixed nowMs for deterministic age assertions (LOOP-73).
// P2 fix: format a window duration to human-readable, using hours for sub-day durations so
// `--window 1h` shows "last 1h" not "last 0d" and `--window 12h` shows "last 12h" not "last 1d".
function fmtWindow(ms: number): string {
  const h = ms / 3_600_000;
  if (h % 24 === 0) return `${h / 24}d`;
  return `${Math.round(h)}h`;
}

export function renderHuman(ws: Workspace, windowMs: number, fires: ReturnType<typeof fireMetrics>, out: Record<string, unknown>, nowMs = Date.now()): void {
  const pct = (x: number | null) => x === null ? "—" : `${Math.round(x * 100)}%`;
  console.log(`team '${ws.file.team.key}' — last ${fmtWindow(windowMs)}`);
  // LOOP-155: the interrupted count is NAMED as excluded — a redefined rate that does not say so is
  // a second way to mislead the same reader.
  const interruptedNote = fires.interrupted ? `, ${fires.interrupted} interrupted — excluded` : "";
  console.log(`fires: ${fires.fires} (success ${pct(fires.successRate)}, ${fires.failures} failed, ${fires.timeouts} timeout, ${fires.suspectErrors} suspect${interruptedNote})`);
  if (Object.keys(fires.byErrorClass).length) // P0-1b: infra failure classes split from task failures
    console.log(`errors: ${Object.entries(fires.byErrorClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ")}`);
  for (const [agent, a] of Object.entries(fires.byAgent))
    console.log(`  ${agent.padEnd(14)} ${String(a.fires).padStart(4)} fires  ${String(a.failures).padStart(3)} failed  median ${a.medianMs === null ? "—" : Math.round(a.medianMs / 1000) + "s"}`);
  if (out.teamRollup) {
    const r = out.teamRollup as { throughput: number; verifyFails: number; acceptRate: number | null; blockedNow: number; sequencedNow: number; bugsFiled: number; escaped: number | null; historyIncomplete?: boolean; historyFloor?: string | null };
    const landedCount = typeof out.landed === "number" ? out.landed : null;
    const landedStr = landedCount === null ? "unknown" : String(landedCount);
    // LOOP-122: `0 escaped to prod` is a production-quality claim; on a loop running neither agent
    // that can write the label it was 0 by construction. Follows LOOP-42's `landed unknown` shape.
    const escapeStr = r.escaped === null ? "escapes unmeasured — no ops/communication fire in window" : `${r.escaped} escaped to prod`;
    console.log(`board: ${r.throughput} done, landed ${landedStr}, accept ${pct(r.acceptRate)} (${r.verifyFails} verify-fail), ${r.blockedNow} parked, ${r.sequencedNow} sequenced, QA bugs ${r.bugsFiled} (${escapeStr})`);
    // LOOP-329: the Todo side alone cannot show a starved tier — 6/10 with 0 promotable reads
    // IDENTICAL to 6/10 with 60 waiting. Both numbers, or the line answers the wrong question.
    // Per PROJECT, because the §5a cap is per-project and summing two different caps would produce a
    // ratio that describes no real queue.
    for (const [key, b] of Object.entries((out.board ?? {}) as Record<string, BoardMetrics>)) {
      if (!b.tiers) continue;
      const t = b.tiers;
      console.log(`tiers[${key}]: ${(["senior-dev", "junior-dev"] as const).map((k) => `${k} ${t.todo[k]}/${t.cap} todo · ${t.backlog[k]} backlog`).join("  |  ")}`);
    }
    // LOOP-313: every figure on the line above is derived from `events`. When that table begins
    // INSIDE the window, the numbers do not cover the period they are labelled with — say so rather
    // than let "6 done · 30d" stand on a board holding 174 Done tickets.
    if (r.historyIncomplete && r.historyFloor)
      console.log(`  ⚠ incomplete history: the event ledger begins ${r.historyFloor.slice(0, 10)}, inside this window — every board figure above covers only that shorter period`);
    const dq = (out.decisionQueue ?? []) as Array<{ id: string; state: string; project: string; updatedAt: string; enteredAt?: string }>;
    if (dq.length) {
      const lbl = (t: { id: string; state: string }) => `${t.id}[${t.state === "Human-Blocked" ? "blocked" : "approve"}]`;
      // LOOP-108: enteredAt (the transition INTO the queue state) — updatedAt is bumped by EVERY
      // write, so an agent's own hygiene comment reset the operator's displayed wait to zero. The
      // sibling surface (/activity) already answered this from the event ledger; the two disagreed 42×.
      const age = (t: { updatedAt: string; enteredAt?: string }) => fmtDur(nowMs - Date.parse(t.enteredAt ?? t.updatedAt));
      const oldest = dq[0]!;
      const items = dq.slice(0, 6).map((t) => `${lbl(t)} ${age(t)}`).join(", ");
      console.log(`decision queue (yours): ${dq.length}, oldest ${lbl(oldest)} waiting ${age(oldest)} — ${items}${dq.length > 6 ? ", …" : ""}`);
    }
  } else console.log(String(out.boardNote));
  // Cost headline (LOOP-127): one honest line — NEVER $0.00, NEVER omitted.
  if (fires.meteredFires === 0) {
    console.log(`cost: unmetered — 0 of ${fires.fires} fires reported usage`);
  } else {
    const throughput = out.teamRollup ? (out.teamRollup as { throughput: number }).throughput : null;
    const perAccepted = fires.costUsd !== null && throughput != null && throughput > 0
      ? `  ($${(fires.costUsd / throughput).toFixed(4)}/accepted change)` : "";
    const costStr = fires.costUsd !== null
      ? `$${fires.costUsd.toFixed(4)} over ${fires.meteredFires} of ${fires.fires} metered fires${perAccepted}`
      : `unavailable — ${fires.meteredFires} of ${fires.fires} fires metered, none priced`;
    console.log(`cost: ${costStr}`);
  }
}

// ─── usage / cost / flow renderers (LOOP-125) — new flags; renderHuman left untouched ─────────────
const dash = (x: number | null) => x === null ? "—" : String(x);
const usd = (x: number | null) => x === null ? "unavailable" : `$${x.toFixed(4)}`;

function renderCell(label: string, cell: UsageCell, indent = ""): void {
  if (cell.metered === 0) {
    console.log(`${indent}${label}: no metered fires (${cell.fires} total)`);
    return;
  }
  const cov = `${cell.metered} of ${cell.fires} metered`;
  console.log(`${indent}${label}: in=${dash(cell.inputTokens)} out=${dash(cell.outputTokens)} cacheR=${dash(cell.cacheReadTokens)} cacheW=${dash(cell.cacheWriteTokens)}  [${cov}]`);
}

// LOOP-332 — `UsageCell` carries BOTH counts, correctly computed and correctly named in the type:
//   costMetered = rows contributing a costUsd (money COVERAGE — includes $0 rate-limit failures)
//   costPriced  = rows with costUsd > 0    (the rows that actually cost money)
// Every render site printed `costMetered` under the word "priced", so the coverage count was read as
// the priced count and the implied $/fire came out low ($3.88 off the screen vs $4.55 true).
// Choice: print BOTH and label each with its own word, rather than dropping one. The distance
// between them is itself the useful signal — it is exactly the zero-cost failure count.
// AC1: the per-fire rate is divided here rather than left to the reader, on the priced denominator.
function renderCostCell(label: string, cell: UsageCell, indent = ""): void {
  if (cell.costMetered === 0) {
    console.log(`${indent}${label}: cost: unavailable — 0 of ${cell.fires} fires reported cost`);
    return;
  }
  // AC4: costPriced can be 0 while costMetered > 0 (every row zero-cost). That is not $0.00/fire and
  // it is not a divide-by-zero — it is "no priced fire to divide by".
  const perFire = cell.costUsd !== null && cell.costPriced > 0
    ? `$${(cell.costUsd / cell.costPriced).toFixed(4)}/priced fire`
    : "—/priced fire";
  // LOOP-219: the gross total stays visible and unchanged — this ADDS the decomposition. The
  // per-agent gradient is the actionable half: discarded share is not spread evenly across tiers.
  const disc = cell.discardedUsd !== null && cell.costUsd !== null && cell.costUsd > 0
    ? `  discarded $${cell.discardedUsd.toFixed(4)} (${((cell.discardedUsd / cell.costUsd) * 100).toFixed(1)}%, ${cell.discardedFires} fires)`
    : "";
  console.log(`${indent}${label}: ${usd(cell.costUsd)}  ${perFire}  [${cell.costPriced} priced, ${cell.costMetered} metered, of ${cell.fires} fires]${disc}`);
}

export function renderUsage(report: UsageReport, byDim?: UsageDimension): void {
  const days = report.windowMs / 86_400_000;
  console.log(`usage — last ${days}d  (${report.meteredFires} of ${report.totalFires} fires metered)`);
  renderCell("overall", report.overall);
  if (report.byDimension) {
    const dim = byDim ?? "agent";
    for (const [k, cell] of Object.entries(report.byDimension))
      renderCell(`  ${dim}:${k}`, cell, "");
  }
}

export function renderCost(report: UsageReport, byDim?: UsageDimension, budget?: { dailyUsd: number; rollingUsd: number; windowUsd?: number }, deadlines?: { ceilingUsd: number; wallMinutes: number; rows: ProfileDeadline[] }): void {
  const days = report.windowMs / 86_400_000;
  console.log(`cost — last ${days}d  (${report.meteredFires} of ${report.totalFires} fires metered)`);
  renderCostCell("overall", report.overall);
  // LOOP-298 — this surface prints a REPORTING total and an ENFORCEMENT total two lines apart on
  // different bases, and the gate uses the one that was never labelled. `overall` sums provider-priced
  // rows and drops the rest; `rollingSpendUsd` deliberately ESTIMATES killed and unpriced fires, so a
  // ceiling cannot be evaded by exactly the fires most likely to have blown it. Both are correct.
  // Printing them adjacently without naming the difference is not: an operator sized headroom at
  // $205/day against a $500 ceiling while the scheduler was gating on $389/day — 41% vs 78%, same
  // screen, same command. Nothing computed changes here; the two bases are named, and the enforcement
  // basis is also shown over the REPORTED window so the two are finally comparable (AC2).
  console.log(`  ↑ reporting basis: provider-priced rows only — unpriced and killed fires are excluded`);
  if (budget) {
    const over = budget.rollingUsd > budget.dailyUsd;
    console.log(`  budget: rolling 24h $${budget.rollingUsd.toFixed(2)} / dailyUsd $${budget.dailyUsd.toFixed(2)} — ${over ? "OVER ceiling, launches refused" : "under ceiling"}`);
    if (budget.windowUsd !== undefined) {
      const perDay = days > 0 ? budget.windowUsd / days : budget.windowUsd;
      console.log(`  ↑ enforcement basis (what the launch gate counts): $${budget.windowUsd.toFixed(2)} over the same ${days}d = $${perDay.toFixed(2)}/day — unpriced and killed fires ESTIMATED, never $0`);
    }
  }
  if (report.byDimension) {
    const dim = byDim ?? "agent";
    for (const [k, cell] of Object.entries(report.byDimension))
      renderCostCell(`  ${dim}:${k}`, cell, "");
  }
  // LOOP-297 — the per-fire ceiling ships ON, and it is now the enforcer that decides whether a
  // launched fire survives. It is stated in DOLLARS while the mechanism acts in TIME, and the
  // conversion is a moving 7-day median per (codingAgent, model). Nothing printed it, so nobody
  // could answer "how long may a senior-dev fire run today?". These come from the same
  // perFireDeadline() the watchdog arms, so the display cannot drift from the enforcer.
  if (deadlines && deadlines.rows.length) {
    console.log(`  per-fire ceiling: $${deadlines.ceilingUsd.toFixed(2)} — the deadline it ARMS, by profile:`);
    for (const d of deadlines.rows) {
      const mins = d.deadlineMinutes === null ? "never (beyond the timer limit)" : `${d.deadlineMinutes.toFixed(1)} min`;
      const basis = d.priced ? "measured" : "FALLBACK rate — no priced history for this profile";
      // AC3: when the budget deadline lands inside the wall timeout, the ceiling — not fireTimeout —
      // is what actually bounds the fire. Legitimate, but it must be legible.
      const undercuts = d.deadlineMinutes !== null && deadlines.wallMinutes > 0 && d.deadlineMinutes < deadlines.wallMinutes
        ? `  ⚠ INSIDE the ${deadlines.wallMinutes} min wall — the budget, not fireTimeout, bounds this profile` : "";
      console.log(`    ${d.codingAgent}/${d.model}: $${d.usdPerHour.toFixed(2)}/hr → ${mins}  [${d.fires} fires, ${basis}]${undercuts}`);
    }
  }
}

export function renderFlow(report: UsageReport, throughput: number | null, boardNote: string | null): void {
  const days = report.windowMs / 86_400_000;
  const cell = report.overall;
  // LOOP-219 — cost-per-accepted-change divided GROSS spend (which includes fires killed mid-flight)
  // by an outcome those fires could not produce. Delivered spend is the honest numerator, and the
  // basis is NAMED on the line: an unlabelled ratio is what this ticket is about.
  const deliveredUsd = cell.costUsd !== null && cell.discardedUsd !== null ? cell.costUsd - cell.discardedUsd : cell.costUsd;
  const cpa = deliveredUsd !== null && throughput !== null && throughput > 0
    ? usd(deliveredUsd / throughput) + "/accepted-change (delivered spend ÷ throughput; discarded fires excluded)"
    : "unavailable";
  const perFire = cell.costUsd !== null && cell.costPriced > 0
    ? usd(cell.costUsd / cell.costPriced) + "/priced fire"
    : "unavailable";
  console.log(`flow — last ${days}d`);
  // LOOP-332 AC2/AC3: `cost-per-fire` divides by costPriced, so the coverage count printed here must
  // not be labelled "priced" — dividing the two numbers on screen has to land on the rate on screen.
  console.log(`cost: ${usd(cell.costUsd)} gross  (${cell.costPriced} priced, ${cell.costMetered} metered, of ${cell.fires} fires)`);
  if (cell.discardedUsd !== null) console.log(`  of which discarded (produced nothing): $${cell.discardedUsd.toFixed(4)} over ${cell.discardedFires} fires`);
  console.log(`cost-per-accepted-change: ${cpa}`);
  console.log(`cost-per-fire: ${perFire}`);
  if (throughput !== null) console.log(`board throughput: ${throughput} →Done in window`);
  else console.log(boardNote ?? "board throughput: unavailable");
}

interface MetricsOpts {
  windowMs: number; nowMs: number; asJson: boolean; context: boolean;
  showUsage: boolean; showCost: boolean; showFlow: boolean; showKaizen: boolean;
  byDim: UsageDimension | undefined;
}

// LOOP-314 — a CLOSED era. Every report here computed `cutoff = now - window` and filtered
// `ts >= cutoff`, so the only question askable was "the last N days ENDING NOW". That blocks any
// before/after across a change boundary: the "after" window always still contains the "before"
// fires, and on a board where one agent fires 14–37×/day a short soak is swamped by same-window
// pre-soak rows. The ledger keeps 90 days, so the rows were always there — only the query was
// missing. `[since, until]` maps onto the existing math as windowMs = until - since, nowMs = until;
// the upper bounds added at each filter site are what make that a real era rather than a relabel.
function parseIso(flag: string, raw: string | undefined): number | null {
  const t = Date.parse(raw ?? "");
  if (!raw || Number.isNaN(t)) { console.error(`metrics: invalid ${flag} '${raw ?? ""}' (use an ISO instant, e.g. 2026-08-01T00:00:00Z)`); return null; }
  return t;
}

const METRICS_HELP = `usage: dev-loop metrics [--window 7d|24h|30d | --since ISO [--until ISO]] [--json] [--context]
                        [--usage] [--cost] [--flow] [--kaizen] [--by agent|project|provider|model]
  default: team KPIs from fires.jsonl (+ hub board on service)
  --since/--until: a CLOSED era instead of a trailing-to-now window — the before/after query
                   (--until defaults to now; composable with --usage/--cost/--flow/--kaizen)
  --usage: token flow per group (metered N-of-M; null=unmeasured, never 0)
  --cost:  money (provider-reported costUsd only; 'unavailable' when none priced — never $0.00)
  --flow:  spend→outcome view: cost-per-accepted-change = costUsd÷throughput (service-only)
  --kaizen: self-improvement panel (board+ledger only; —=no data, never 0; composable with --window --json)
  --by:    grouping dimension for --usage/--cost (default: agent)
  --context: per-agent context bill (plugin-static, needs no workspace)`;

const USAGE_DIMENSIONS = ["agent", "project", "provider", "model"] as const;

// The boolean flags, as a TABLE. They were nine `else if` arms, which is nine branches in one
// function for no decision at all — and with --since/--until added, parseMetricsArgs hit CRAP 130.6
// against the ratchet's 90 and red-lined the merge check on a branch whose local `verify` was green.
// (That green-local/red-CI gap is LOOP-159, fixed alongside: `verify` now runs the ratchet too.)
const METRICS_BOOL_FLAGS: Record<string, keyof Pick<MetricsOpts, "asJson" | "context" | "showUsage" | "showCost" | "showFlow" | "showKaizen">> = {
  "--json": "asJson",
  "--context": "context",
  "--usage": "showUsage",
  "--cost": "showCost",
  "--flow": "showFlow",
  "--kaizen": "showKaizen",
};

// --since/--until resolve LAST so the two spellings cannot half-apply. --since alone means "from
// then until now"; --until alone would be ambiguous about how far back to reach, so it is refused
// rather than silently paired with the default 7d.
function resolveEra(windowMs: number, sinceMs: number | null, untilMs: number | null): { windowMs: number; nowMs: number } | number {
  if (untilMs !== null && sinceMs === null) { console.error("metrics: --until requires --since (a closed era needs both ends; use --window for a trailing window)"); return 2; }
  if (sinceMs === null) return { windowMs, nowMs: Date.now() };
  const until = untilMs ?? Date.now();
  if (until <= sinceMs) { console.error(`metrics: --until (${new Date(until).toISOString()}) must be after --since (${new Date(sinceMs).toISOString()})`); return 2; }
  return { windowMs: until - sinceMs, nowMs: until };
}

function parseMetricsArgs(argv: string[]): MetricsOpts | number {
  const flags = { asJson: false, context: false, showUsage: false, showCost: false, showFlow: false, showKaizen: false };
  let windowMs = 7 * 86_400_000;
  let sinceMs: number | null = null, untilMs: number | null = null;
  let byDim: UsageDimension | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const boolField = METRICS_BOOL_FLAGS[a];
    if (boolField) { flags[boolField] = true; continue; }
    switch (a) {
      case "--window": windowMs = parseWindow(argv[++i] ?? "7d"); continue;
      case "--since": { const t = parseIso("--since", argv[++i]); if (t === null) return 2; sinceMs = t; continue; }
      case "--until": { const t = parseIso("--until", argv[++i]); if (t === null) return 2; untilMs = t; continue; }
      case "--by": {
        const dim = argv[++i] as UsageDimension;
        if (!(USAGE_DIMENSIONS as readonly string[]).includes(dim)) { console.error(`metrics: invalid --by '${dim}' (use ${USAGE_DIMENSIONS.join("|")})`); return 2; }
        byDim = dim; continue;
      }
      case "--help": case "-h": console.log(METRICS_HELP); return 0;
      default: continue;
    }
  }
  const era = resolveEra(windowMs, sinceMs, untilMs);
  if (typeof era === "number") return era;
  return { ...era, ...flags, byDim };
}

export async function metricsCli(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseMetricsArgs(argv);
  if (typeof parsed === "number") return parsed;
  const { windowMs, nowMs, asJson, context, showUsage, showCost, showFlow, showKaizen, byDim } = parsed;
  // --context: the per-agent context bill (task #8 — SKILL prose + cheat sheet + the conventions
  // §-spans its Sections line cites + lessons caps). It lives under `metrics`, not `doctor`: the
  // bill is a director-view NUMBER over the plugin's static sources (skills/ + conventions.md) that
  // needs no workspace, hub db, or backend, while doctor's DOCTOR_OK contract stays a boolean health
  // gate over a workspace's system-of-record. Handled BEFORE resolveWorkspace() for exactly that
  // reason — the bill must print anywhere, including a machine with no team at all.
  if (context) {
    const { printContextBill } = await import("./context-bill.ts");
    return printContextBill(asJson);
  }
  const ws: Workspace = resolveWorkspace();
  // Route board reads through the DEVLOOP_HUB_DB ladder (LOOP-199). Own-db callers (hub.ts:21,29
  // wires DEVLOOP_HUB_DB=wsHubDb; team-init.ts:176 creates; bundle.ts:153 exports;
  // team-import.ts:230 writes) must NOT follow ambient env — they call wsHubDb(ws) directly.
  const boardDb = resolveHubDbPath(ws.root);

  if (showKaizen) return runKaizenCli(ws, boardDb, windowMs, asJson);

  // ── usage/cost/flow path (LOOP-125) ──────────────────────────────────────────
  if (showUsage || showCost || showFlow) {
    const rows = readFireRows(wsFireLedger(ws));
    const groupBy = byDim ?? "agent";
    const report = usageReport(rows, windowMs, { groupBy, nowMs: nowMs });
    // Budget-ceiling view (LOOP-229): shown only when a dailyUsd ceiling is set (so `--cost` is unchanged when
    // unset). Always the 24h rolling enforcement total (rollingSpendUsd — the same number the launch gate and
    // doctor use), independent of --window.
    const dailyUsd = ws.file.team.budget?.dailyUsd;
    // LOOP-298: windowUsd is the SAME enforcement basis (rollingSpendUsd) evaluated over the reported
    // window, so the reader can compare it against `overall` directly instead of against a 24h number.
    const budgetView = dailyUsd != null
      ? { dailyUsd, rollingUsd: rollingSpendUsd(rows, 86_400_000, nowMs), windowUsd: rollingSpendUsd(rows, windowMs, nowMs) }
      : undefined;
    let throughput: number | null = null;
    let flowBoardNote: string | null = null;
    if (showFlow) {
      if (ws.file.team.backend === "service" && existsSync(boardDb)) {
        const { openDb } = await import("./db.ts");
        const { findProject } = await import("./seed.ts");
        const db = openDb(boardDb);
        try {
          let tp = 0;
          for (const key of deliveryProjects(ws)) {
            const pid = findProject(db, key);
            if (pid) tp += boardMetrics(db, pid, windowMs, nowMs).throughput; // LOOP-314: honour the era
          }
          throughput = tp;
        } finally { db.close(); }
      } else {
        flowBoardNote = "linear backend: board throughput computed by digest agent via MCP queries";
      }
    }
    if (asJson) {
      const out: Record<string, unknown> = { windowDays: windowMs / 86_400_000 };
      if (showUsage || showCost) out.usage = report;
      if (showCost && budgetView) // budget is a cost surface — mirror renderCost (human --cost) exactly
        out.budget = { dailyUsd: budgetView.dailyUsd, rollingUsd: budgetView.rollingUsd, windowMs: 86_400_000, overCeiling: budgetView.rollingUsd > budgetView.dailyUsd,
          enforcementWindowUsd: budgetView.windowUsd, enforcementWindowMs: windowMs }; // LOOP-298: additive
      if (showFlow) {
        const c = report.overall;
        out.flow = {
          costUsd: c.costUsd,
          tokens: { inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens },
          throughput,
          costPerAccepted: c.costUsd !== null && throughput !== null && throughput > 0 ? c.costUsd / throughput : null,
          perFire: c.costUsd !== null && c.costPriced > 0 ? c.costUsd / c.costPriced : null,
          boardNote: flowBoardNote,
        };
      }
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    if (showUsage) renderUsage(report, groupBy);
    if (showCost) {
      // LOOP-297: the ceiling resolves exactly as run-agents resolves it, and the wall is the same
      // 60-min default the scheduler ships (opts.fireTimeoutMs) unless config overrides it per agent.
      const ceilingUsd = ws.file.team.budget?.perFireUsd ?? DEFAULT_PER_FIRE_USD;
      renderCost(report, groupBy, budgetView, { ceilingUsd, wallMinutes: 60, rows: profileDeadlines(rows, ceilingUsd, windowMs, nowMs) });
    }
    if (showFlow) renderFlow(report, throughput, flowBoardNote);
    return 0;
  }

  // ── default team-KPI path ─────────────────────────────────────────────────────
  const fires = fireMetrics(wsFireLedger(ws), windowMs);
  const out: Record<string, unknown> = { team: ws.file.team.key, windowDays: windowMs / 86_400_000, fires };

  await collectBoardMetrics(ws, windowMs, out, boardDb, escapeSignalSourceRan(fires), nowMs);

  if (asJson) { console.log(JSON.stringify(out, null, 2)); return 0; }
  renderHuman(ws, windowMs, fires, out, nowMs);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  // exitCode (not process.exit): stdout to a PIPE is async on POSIX — a hard exit truncates a large
  // --context --json payload mid-flush. Nothing here holds the event loop open (the db is closed in
  // metricsCli's finally), so Node exits as soon as stdout drains.
  metricsCli().then((c) => { process.exitCode = c; });
}
