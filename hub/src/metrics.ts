#!/usr/bin/env node
// `dev-loop metrics` — the DETERMINISTIC team-KPI computation (director view, W5). Numbers come from
// code; narrative comes from the digest agent. Two sources, honestly scoped:
//   • fires.jsonl (ALL backends): fire counts, success rate, timeouts, suspectErrors, per-agent medians.
//   • the hub db (service backend only): board KPIs from `issue.transition` events — throughput (→Done),
//     accept rate = Done ÷ (Done + verify-fail Cancels, i.e. the §3 In Review→Canceled edge), blocked count.
//     On linear there is no local board mirror — the digest agent computes board numbers via MCP queries
//     at fire time, per the §22 digest contract; this CLI never guesses them.
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveWorkspace, wsFireLedger, wsHubDb } from "./workspace.ts";
import { deliveryProjects, type Workspace } from "./team-config.ts";

// ─── fires.jsonl ──────────────────────────────────────────────────────────────
export interface FireRow { ts: string; agent: string; project: string; durationMs?: number; exitCode?: number; timedOut?: boolean; suspectError?: boolean }
export interface FireMetrics {
  windowMs: number; fires: number; failures: number; timeouts: number; suspectErrors: number;
  successRate: number | null;                      // (fires - failures - suspect) / fires; null when no fires
  byAgent: Record<string, { fires: number; failures: number; medianMs: number | null }>;
  byProject: Record<string, { fires: number; failures: number }>;
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
  const cutoff = nowMs - windowMs;
  const rows = readFireRows(ledgerPath).filter((r) => Date.parse(r.ts) >= cutoff);
  const byAgent: FireMetrics["byAgent"] = {};
  const byProject: FireMetrics["byProject"] = {};
  let failures = 0, timeouts = 0, suspect = 0;
  for (const r of rows) {
    const failed = (r.exitCode ?? 0) !== 0;
    if (failed) failures++;
    if (r.timedOut) timeouts++;
    if (r.suspectError) suspect++;
    const a = (byAgent[r.agent] ??= { fires: 0, failures: 0, medianMs: null });
    a.fires++; if (failed) a.failures++;
    const p = (byProject[r.project || "(team)"] ??= { fires: 0, failures: 0 });
    p.fires++; if (failed) p.failures++;
  }
  for (const [agent, a] of Object.entries(byAgent)) {
    a.medianMs = median(rows.filter((r) => r.agent === agent && typeof r.durationMs === "number").map((r) => r.durationMs as number));
  }
  const fires = rows.length;
  const successRate = fires ? (fires - failures - suspect) / fires : null;
  return { windowMs, fires, failures, timeouts, suspectErrors: suspect, successRate, byAgent, byProject };
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

// ─── board KPIs (service backend — from `issue.transition` events) ───────────
export interface BoardMetrics {
  throughput: number;         // transitions → Done in the window
  verifyFails: number;        // In Review → Canceled (the §3 verify-fail close edge)
  acceptRate: number | null;  // Done ÷ (Done + verifyFails); null when both are 0
  blockedNow: number;         // open tickets currently carrying the `blocked` label
  qa: { bugsFiled: number; escaped: number; escapeRatio: number | null }; // escaped = incident/signal-labelled Bugs
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function boardMetrics(db: any, projectId: string, windowMs: number, nowMs = Date.now()): BoardMetrics {
  const cutoffIso = new Date(nowMs - windowMs).toISOString();
  const transitions = db.prepare(
    "SELECT data FROM events WHERE project_id=? AND kind='issue.transition' AND created_at>=?",
  ).all(projectId, cutoffIso) as { data: string }[];
  let done = 0, verifyFails = 0;
  for (const t of transitions) {
    try {
      const d = JSON.parse(t.data) as { from?: string; to?: string };
      if (d.to === "Done") done++;
      if (d.from === "In Review" && d.to === "Canceled") verifyFails++;
    } catch { /* skip */ }
  }
  const blockedNow = (db.prepare(
    "SELECT COUNT(*) c FROM tickets WHERE project_id=? AND state NOT IN ('Done','Canceled','Duplicate') AND labels LIKE '%\"blocked\"%'",
  ).get(projectId) as { c: number }).c;
  const bugs = db.prepare(
    "SELECT labels FROM tickets WHERE project_id=? AND type='Bug' AND created_at>=?",
  ).all(projectId, cutoffIso) as { labels: string }[];
  let escaped = 0;
  for (const b of bugs) if (/"incident"|"signal"/.test(b.labels)) escaped++;
  const qa = { bugsFiled: bugs.length, escaped, escapeRatio: bugs.length ? escaped / bugs.length : null };
  return { throughput: done, verifyFails, acceptRate: done + verifyFails ? done / (done + verifyFails) : null, blockedNow, qa };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseWindow(s: string): number {
  const m = s.trim().match(/^(\d+)(d|h)$/);
  if (!m) { console.error(`metrics: invalid --window '${s}' (use e.g. 7d, 24h)`); process.exit(2); }
  return Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

export async function metricsCli(argv = process.argv.slice(2)): Promise<number> {
  let windowMs = 7 * 86_400_000;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--window") windowMs = parseWindow(argv[++i] ?? "7d");
    else if (argv[i] === "--json") asJson = true;
    else if (argv[i] === "--help" || argv[i] === "-h") { console.log("usage: dev-loop metrics [--window 7d|24h|30d] [--json]  — team KPIs from fires.jsonl (+ hub board on service)"); return 0; }
  }
  const ws: Workspace = resolveWorkspace();
  const fires = fireMetrics(wsFireLedger(ws), windowMs);
  const out: Record<string, unknown> = { team: ws.file.team.key, windowDays: windowMs / 86_400_000, fires };

  if (ws.file.team.backend === "service" && existsSync(wsHubDb(ws))) {
    const { openDb } = await import("./db.ts");
    const { findProject } = await import("./seed.ts");
    const db = openDb(wsHubDb(ws));
    try {
      const board: Record<string, BoardMetrics> = {};
      const roll = { throughput: 0, verifyFails: 0, blockedNow: 0, bugsFiled: 0, escaped: 0 };
      for (const key of deliveryProjects(ws)) {
        const pid = findProject(db, key);
        if (!pid) continue;
        const m = boardMetrics(db, pid, windowMs);
        board[key] = m;
        roll.throughput += m.throughput; roll.verifyFails += m.verifyFails; roll.blockedNow += m.blockedNow;
        roll.bugsFiled += m.qa.bugsFiled; roll.escaped += m.qa.escaped;
      }
      out.board = board;
      out.teamRollup = { ...roll, acceptRate: roll.throughput + roll.verifyFails ? roll.throughput / (roll.throughput + roll.verifyFails) : null };
    } finally { db.close(); }
  } else {
    out.boardNote = "linear backend: board KPIs are computed by the digest agent via MCP queries (§22 digest contract); this CLI reports fire metrics only.";
  }

  if (asJson) { console.log(JSON.stringify(out, null, 2)); return 0; }
  const pct = (x: number | null) => x === null ? "—" : `${Math.round(x * 100)}%`;
  console.log(`team '${ws.file.team.key}' — last ${windowMs / 86_400_000}d`);
  console.log(`fires: ${fires.fires} (success ${pct(fires.successRate)}, ${fires.failures} failed, ${fires.timeouts} timeout, ${fires.suspectErrors} suspect)`);
  for (const [agent, a] of Object.entries(fires.byAgent))
    console.log(`  ${agent.padEnd(14)} ${String(a.fires).padStart(4)} fires  ${String(a.failures).padStart(3)} failed  median ${a.medianMs === null ? "—" : Math.round(a.medianMs / 1000) + "s"}`);
  if (out.teamRollup) {
    const r = out.teamRollup as { throughput: number; verifyFails: number; acceptRate: number | null; blockedNow: number; bugsFiled: number; escaped: number };
    console.log(`board: ${r.throughput} shipped, accept ${pct(r.acceptRate)} (${r.verifyFails} verify-fail), ${r.blockedNow} blocked open, QA bugs ${r.bugsFiled} (${r.escaped} escaped to prod)`);
  } else console.log(String(out.boardNote));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  metricsCli().then((c) => process.exit(c));
}
