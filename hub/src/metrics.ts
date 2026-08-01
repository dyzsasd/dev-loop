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
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsFireLedger, resolveHubDbPath } from "./workspace.ts";
import { deliveryProjects, type Workspace } from "./team-config.ts";
import { AGENT_HANDLES } from "./seed.ts";
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
export interface FireRow { ts: string; agent: string; project: string; codingAgent?: string; provider?: string; model?: string; effort?: string; durationMs?: number; exitCode?: number; timedOut?: boolean; suspectError?: boolean; errorClass?: string; bootBytes?: number; fireId?: string; usage?: FireUsage }
export interface FireMetrics {
  windowMs: number; fires: number; failures: number; timeouts: number; suspectErrors: number;
  byErrorClass: Record<string, number>;            // P0-1b taxonomy (spend-limit/rate-limit/auth/network/timeout/…); infra failures split from task failures
  successRate: number | null;                      // (fires - failures - suspect) / fires; null when no fires
  byAgent: Record<string, { fires: number; failures: number; medianMs: number | null }>;
  byProject: Record<string, { fires: number; failures: number }>;
  meteredFires: number;                            // fires carrying usage (coverage numerator)
  costMeteredFires: number;                        // fires whose usage.costUsd !== null
  costUsd: number | null;                          // summed costUsd; null when costMeteredFires===0
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
  costMetered: number;            // rows contributing a costUsd (money coverage)
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
  const cutoff = nowMs - windowMs;
  const rows = readFireRows(ledgerPath).filter((r) => Date.parse(r.ts) >= cutoff);
  const byAgent: FireMetrics["byAgent"] = {};
  const byProject: FireMetrics["byProject"] = {};
  let failures = 0, timeouts = 0, suspect = 0;
  const byErrorClass: Record<string, number> = {};
  for (const r of rows) {
    const failed = (r.exitCode ?? 0) !== 0;
    if (failed) failures++;
    if (r.timedOut) timeouts++;
    if (r.suspectError) suspect++;
    if (r.errorClass) byErrorClass[r.errorClass] = (byErrorClass[r.errorClass] ?? 0) + 1;
    const a = (byAgent[r.agent] ??= { fires: 0, failures: 0, medianMs: null });
    a.fires++; if (failed) a.failures++;
    const p = (byProject[r.project || "(team)"] ??= { fires: 0, failures: 0 });
    p.fires++; if (failed) p.failures++;
  }
  for (const [agent, a] of Object.entries(byAgent)) {
    a.medianMs = median(rows.filter((r) => r.agent === agent && typeof r.durationMs === "number").map((r) => r.durationMs as number));
  }
  let meteredFires = 0, costMeteredFires = 0, costUsdAcc = 0, hasCost = false;
  for (const r of rows) {
    if (r.usage) {
      meteredFires++;
      if (r.usage.costUsd !== null) { costMeteredFires++; costUsdAcc += r.usage.costUsd; hasCost = true; }
    }
  }
  const fires = rows.length;
  const successRate = fires ? (fires - failures - suspect) / fires : null;
  return { windowMs, fires, failures, timeouts, suspectErrors: suspect, byErrorClass, successRate, byAgent, byProject, meteredFires, costMeteredFires, costUsd: hasCost ? costUsdAcc : null };
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
const sumNull = (a: number | null, b: number | null): number | null =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

function emptyCell(): UsageCell {
  return { fires: 0, metered: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costMetered: 0 };
}

function addToCell(cell: UsageCell, r: FireRow): void {
  cell.fires++;
  if (!r.usage) return;                                              // no measurement → only fires counter touched
  cell.metered++;
  cell.inputTokens = sumNull(cell.inputTokens, r.usage.inputTokens);
  cell.outputTokens = sumNull(cell.outputTokens, r.usage.outputTokens);
  cell.cacheReadTokens = sumNull(cell.cacheReadTokens, r.usage.cacheReadTokens);
  cell.cacheWriteTokens = sumNull(cell.cacheWriteTokens, r.usage.cacheWriteTokens);
  if (r.usage.costUsd !== null) { cell.costUsd = (cell.costUsd ?? 0) + r.usage.costUsd; cell.costMetered++; }
}

export function usageReport(rows: FireRow[], windowMs: number, opts: { groupBy?: UsageDimension; nowMs?: number } = {}): UsageReport {
  const cutoff = (opts.nowMs ?? Date.now()) - windowMs;
  const inWindow = rows.filter((r) => Date.parse(r.ts) >= cutoff);
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

// ─── board KPIs (service backend — from `issue.transition` events) ───────────
export interface BoardMetrics {
  throughput: number;         // transitions → Done in the window
  verifyFails: number;        // In Review → Canceled (the §3 verify-fail close edge)
  acceptRate: number | null;  // Done ÷ (Done + verifyFails); null when both are 0
  blockedNow: number;         // open `blocked` tickets that are parked (need human attention)
  sequencedNow: number;       // open `blocked` tickets with a live Blocked-by edge (will self-unpark)
  qa: { bugsFiled: number; escaped: number; escapeRatio: number | null }; // escaped = incident/signal-labelled Bugs
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
  // Split blocked tickets into parked (attention-needed) vs sequenced (live dependency edge).
  const blockedTickets = db.prepare(
    "SELECT id FROM tickets WHERE project_id=? AND state NOT IN ('Done','Canceled','Duplicate') AND labels LIKE '%\"blocked\"%'",
  ).all(projectId) as { id: string }[];
  let blockedNow = 0, sequencedNow = 0;
  for (const { id } of blockedTickets) {
    if (hasLiveBlockerEdge(db, id)) sequencedNow++; else blockedNow++;
  }
  const bugs = db.prepare(
    "SELECT labels FROM tickets WHERE project_id=? AND type='Bug' AND created_at>=?",
  ).all(projectId, cutoffIso) as { labels: string }[];
  let escaped = 0;
  for (const b of bugs) if (/"incident"|"signal"/.test(b.labels)) escaped++;
  const qa = { bugsFiled: bugs.length, escaped, escapeRatio: bugs.length ? escaped / bugs.length : null };
  return { throughput: done, verifyFails, acceptRate: done + verifyFails ? done / (done + verifyFails) : null, blockedNow, sequencedNow, qa };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
function parseWindow(s: string): number {
  const m = s.trim().match(/^(\d+)(d|h)$/);
  if (!m) { console.error(`metrics: invalid --window '${s}' (use e.g. 7d, 24h)`); process.exit(2); }
  return Number(m[1]) * (m[2] === "d" ? 86_400_000 : 3_600_000);
}

// P1-3: the operator's decision queue as ONE queryable set — Human-Blocked ∪ In Review assigned to the
// operator. The daemon reminder pings it; the §22a digest carries it; this is the shared read.
export interface DecisionItem { id: string; title: string; state: string; updatedAt: string }
export function decisionQueue(db: import("node:sqlite").DatabaseSync, projectId: string): DecisionItem[] {
  return (db.prepare(
    "SELECT id,title,state,updated_at FROM tickets WHERE project_id=? AND (state='Human-Blocked' OR (state='In Review' AND assignee='operator')) ORDER BY updated_at",
  ).all(projectId) as { id: string; title: string; state: string; updated_at: string }[])
    .map((t) => ({ id: t.id, title: t.title, state: t.state, updatedAt: t.updated_at }));
}

// P1-4: owner-liveness — an owner label whose actor never fires strands its tickets forever (the field's
// MP-156: qa-owned In Review sat 4+ days because no qa agent exists in the roster and nothing noticed).
// A finding = an agent handle that OWNS open Todo/In Review tickets (labels carry the owner handle) but
// has NO fires.jsonl row inside the window. `manual` handles (agents.<h>.manual:true — the operator runs
// that role by hand) still surface, flagged manual:true, so the digest can say "awaiting a human <h>"
// instead of warning. Doctor renders these as W16; Sweep quotes them in the board-health digest.
export interface OwnerLivenessFinding { owner: string; openTickets: number; oldestUpdatedAt: string; lastFireTs: string | null; manual: boolean }
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
      "SELECT assignee, labels, state, updated_at FROM tickets WHERE project_id=? AND state IN ('Todo','In Review') ORDER BY updated_at",
    ).all(projectId) as { assignee: string | null; labels: string; state: string; updated_at: string }[];
    // Ownership rule: In Review → label only (the label names the verifier, not the implementer whose
    // assignee field still points at the dev who shipped it); Todo → union(assignee, label) so tickets
    // routed by assignee alone (no tier label) are not invisible to the liveness detector (LOOP-30).
    const mine = owned.filter((t) => {
      if (t.state === "In Review") {
        try { return (JSON.parse(t.labels) as string[]).includes(h); } catch { return false; }
      }
      if (t.assignee === h) return true;
      try { return (JSON.parse(t.labels) as string[]).includes(h); } catch { return false; }
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

function parseLessons(lessonsDir: string): KaizenReport["lessons"] {
  if (!existsSync(lessonsDir)) return { entries: 0, byMonth: {}, present: false };
  const files: string[] = [];
  try {
    const index = join(lessonsDir, "INDEX.md");
    if (existsSync(index)) files.push(index);
    for (const f of readdirSync(lessonsDir)) {
      if (f !== "INDEX.md" && f !== "archive.md" && f.endsWith(".md")) files.push(join(lessonsDir, f));
    }
  } catch { return { entries: 0, byMonth: {}, present: true }; }
  let entries = 0;
  const byMonth: Record<string, number> = {};
  for (const f of files) {
    let txt = "";
    try { txt = readFileSync(f, "utf8"); } catch { continue; }
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
  opts: { nowMs: number; windowMs?: number; lessonsDir?: string; ratchetSources?: { pkgJson: string; gauntletDoc: string } },
): KaizenReport {
  const windowMs = opts.windowMs ?? 7 * 86_400_000;
  // Stat 1 — self-filed → self-fixed
  const inList = AGENT_HANDLES.map(() => "?").join(",");
  const filed = db.prepare(
    `SELECT id, state FROM tickets WHERE project_id=? AND created_by IN (${inList})`,
  ).all(projectId, ...AGENT_HANDLES) as { id: string; state: string }[];
  const selfFiled = filed.length;
  const fixedRows = filed.filter((r) => r.state === "Done");
  const selfFixed = fixedRows.length;
  const totalDone = (db.prepare("SELECT COUNT(*) as n FROM tickets WHERE project_id=? AND state='Done'").get(projectId) as { n: number }).n;
  const fixedIds = fixedRows.map((r) => r.id);
  const selfFixRate = selfFiled > 0 ? selfFixed / selfFiled : null;
  const selfSlice = totalDone > 0 ? selfFixed / totalDone : null;
  // Stat 2 — lessons
  const lessons = opts.lessonsDir ? parseLessons(opts.lessonsDir) : { entries: 0, byMonth: {}, present: false };
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
    console.log(`verify-fails: — no verify-fails in the last ${Math.round(report.windowMs / 86_400_000)}d`);
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
    for (const key of deliveryProjects(ws)) {
      const pid = findProject(db, key);
      if (!pid) continue;
      const lessonsDir = lessonsPaths(ws).dir;
      const hubRoot = join(new URL(".", import.meta.url).pathname, "..");
      const pkgJson = join(hubRoot, "package.json");
      const gauntletDoc = join(ws.root, "docs", "design", "quality-gauntlet.md");
      const report = kaizenReport(db, pid, { nowMs: Date.now(), windowMs, lessonsDir, ratchetSources: { pkgJson, gauntletDoc } });
      if (asJson) { console.log(JSON.stringify(report, null, 2)); } else { renderKaizen(report); }
    }
  } finally { db.close(); }
  return 0;
}

// Service-backend board rollup: per-project board KPIs + the operator decision queue folded into
// `out` (1.8.1 quality-gauntlet drain: metricsCli CC 22 → collect/render phases).
async function collectBoardMetrics(ws: Workspace, windowMs: number, out: Record<string, unknown>, boardDb: string): Promise<void> {
  if (ws.file.team.backend === "service" && existsSync(boardDb)) {
    const { openDb } = await import("./db.ts");
    const { findProject } = await import("./seed.ts");
    const db = openDb(boardDb);
    try {
      const board: Record<string, BoardMetrics> = {};
      const roll = { throughput: 0, verifyFails: 0, blockedNow: 0, sequencedNow: 0, bugsFiled: 0, escaped: 0 };
      let sensitiveMistierCount = 0;
      const queue: Array<DecisionItem & { project: string }> = [];
      for (const key of deliveryProjects(ws)) {
        const pid = findProject(db, key);
        if (!pid) continue;
        const m = boardMetrics(db, pid, windowMs);
        board[key] = m;
        roll.throughput += m.throughput; roll.verifyFails += m.verifyFails; roll.blockedNow += m.blockedNow; roll.sequencedNow += m.sequencedNow;
        roll.bugsFiled += m.qa.bugsFiled; roll.escaped += m.qa.escaped;
        sensitiveMistierCount += sensitiveMistier(db, pid).length;
        queue.push(...decisionQueue(db, pid).map((t) => ({ ...t, project: key }))); // P1-3
      }
      out.board = board;
      out.teamRollup = { ...roll, acceptRate: roll.throughput + roll.verifyFails ? roll.throughput / (roll.throughput + roll.verifyFails) : null, sensitiveMistierCount };
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
export function renderHuman(ws: Workspace, windowMs: number, fires: ReturnType<typeof fireMetrics>, out: Record<string, unknown>, nowMs = Date.now()): void {
  const pct = (x: number | null) => x === null ? "—" : `${Math.round(x * 100)}%`;
  console.log(`team '${ws.file.team.key}' — last ${windowMs / 86_400_000}d`);
  console.log(`fires: ${fires.fires} (success ${pct(fires.successRate)}, ${fires.failures} failed, ${fires.timeouts} timeout, ${fires.suspectErrors} suspect)`);
  if (Object.keys(fires.byErrorClass).length) // P0-1b: infra failure classes split from task failures
    console.log(`errors: ${Object.entries(fires.byErrorClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(", ")}`);
  for (const [agent, a] of Object.entries(fires.byAgent))
    console.log(`  ${agent.padEnd(14)} ${String(a.fires).padStart(4)} fires  ${String(a.failures).padStart(3)} failed  median ${a.medianMs === null ? "—" : Math.round(a.medianMs / 1000) + "s"}`);
  if (out.teamRollup) {
    const r = out.teamRollup as { throughput: number; verifyFails: number; acceptRate: number | null; blockedNow: number; sequencedNow: number; bugsFiled: number; escaped: number };
    const landedCount = typeof out.landed === "number" ? out.landed : null;
    const landedStr = landedCount === null ? "unknown" : String(landedCount);
    console.log(`board: ${r.throughput} done, landed ${landedStr}, accept ${pct(r.acceptRate)} (${r.verifyFails} verify-fail), ${r.blockedNow} parked, ${r.sequencedNow} sequenced, QA bugs ${r.bugsFiled} (${r.escaped} escaped to prod)`);
    const dq = (out.decisionQueue ?? []) as Array<{ id: string; state: string; project: string; updatedAt: string }>;
    if (dq.length) {
      const lbl = (t: { id: string; state: string }) => `${t.id}[${t.state === "Human-Blocked" ? "blocked" : "approve"}]`;
      const age = (t: { updatedAt: string }) => fmtDur(nowMs - Date.parse(t.updatedAt));
      const oldest = dq[0]!;
      const items = dq.slice(0, 6).map((t) => `${lbl(t)} ${age(t)}`).join(", ");
      console.log(`decision queue (yours): ${dq.length}, oldest ${lbl(oldest)} waiting ${age(oldest)} — ${items}${dq.length > 6 ? ", …" : ""}`);
    }
  } else console.log(String(out.boardNote));
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

function renderCostCell(label: string, cell: UsageCell, indent = ""): void {
  if (cell.costMetered === 0) {
    console.log(`${indent}${label}: cost: unavailable — 0 of ${cell.fires} fires reported cost`);
    return;
  }
  console.log(`${indent}${label}: ${usd(cell.costUsd)}  [${cell.costMetered} of ${cell.fires} priced]`);
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

export function renderCost(report: UsageReport, byDim?: UsageDimension): void {
  const days = report.windowMs / 86_400_000;
  console.log(`cost — last ${days}d  (${report.meteredFires} of ${report.totalFires} fires metered)`);
  renderCostCell("overall", report.overall);
  if (report.byDimension) {
    const dim = byDim ?? "agent";
    for (const [k, cell] of Object.entries(report.byDimension))
      renderCostCell(`  ${dim}:${k}`, cell, "");
  }
}

export function renderFlow(report: UsageReport, throughput: number | null, boardNote: string | null): void {
  const days = report.windowMs / 86_400_000;
  const cell = report.overall;
  const cpa = cell.costUsd !== null && throughput !== null && throughput > 0
    ? usd(cell.costUsd / throughput) + "/accepted-change"
    : "unavailable";
  const perFire = cell.costUsd !== null && cell.fires > 0
    ? usd(cell.costUsd / cell.fires) + "/fire"
    : "unavailable";
  console.log(`flow — last ${days}d`);
  console.log(`cost: ${usd(cell.costUsd)}  (${cell.costMetered} of ${cell.fires} fires priced)`);
  console.log(`cost-per-accepted-change: ${cpa}`);
  console.log(`cost-per-fire: ${perFire}`);
  if (throughput !== null) console.log(`board throughput: ${throughput} →Done in window`);
  else console.log(boardNote ?? "board throughput: unavailable");
}

export async function metricsCli(argv = process.argv.slice(2)): Promise<number> {
  let windowMs = 7 * 86_400_000;
  let asJson = false;
  let context = false;
  let showUsage = false, showCost = false, showFlow = false, showKaizen = false;
  let byDim: UsageDimension | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--window") windowMs = parseWindow(argv[++i] ?? "7d");
    else if (argv[i] === "--json") asJson = true;
    else if (argv[i] === "--context") context = true;
    else if (argv[i] === "--usage") showUsage = true;
    else if (argv[i] === "--cost") showCost = true;
    else if (argv[i] === "--flow") showFlow = true;
    else if (argv[i] === "--kaizen") showKaizen = true;
    else if (argv[i] === "--by") {
      const dim = argv[++i] as UsageDimension;
      if (!["agent", "project", "provider", "model"].includes(dim)) {
        console.error(`metrics: invalid --by '${dim}' (use agent|project|provider|model)`);
        return 2;
      }
      byDim = dim;
    }
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: dev-loop metrics [--window 7d|24h|30d] [--json] [--context]\n" +
        "                        [--usage] [--cost] [--flow] [--kaizen] [--by agent|project|provider|model]\n" +
        "  default: team KPIs from fires.jsonl (+ hub board on service)\n" +
        "  --usage: token flow per group (metered N-of-M; null=unmeasured, never 0)\n" +
        "  --cost:  money (provider-reported costUsd only; 'unavailable' when none priced — never $0.00)\n" +
        "  --flow:  spend→outcome view: cost-per-accepted-change = costUsd÷throughput (service-only)\n" +
        "  --kaizen: self-improvement panel (board+ledger only; —=no data, never 0; composable with --window --json)\n" +
        "  --by:    grouping dimension for --usage/--cost (default: agent)\n" +
        "  --context: per-agent context bill (plugin-static, needs no workspace)");
      return 0;
    }
  }
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
    const report = usageReport(rows, windowMs, { groupBy, nowMs: Date.now() });
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
            if (pid) tp += boardMetrics(db, pid, windowMs).throughput;
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
      if (showFlow) {
        const c = report.overall;
        out.flow = {
          costUsd: c.costUsd,
          tokens: { inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens },
          throughput,
          costPerAccepted: c.costUsd !== null && throughput !== null && throughput > 0 ? c.costUsd / throughput : null,
          perFire: c.costUsd !== null && c.fires > 0 ? c.costUsd / c.fires : null,
          boardNote: flowBoardNote,
        };
      }
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    if (showUsage) renderUsage(report, groupBy);
    if (showCost) renderCost(report, groupBy);
    if (showFlow) renderFlow(report, throughput, flowBoardNote);
    return 0;
  }

  // ── default team-KPI path ─────────────────────────────────────────────────────
  const fires = fireMetrics(wsFireLedger(ws), windowMs);
  const out: Record<string, unknown> = { team: ws.file.team.key, windowDays: windowMs / 86_400_000, fires };

  await collectBoardMetrics(ws, windowMs, out, boardDb);

  if (asJson) { console.log(JSON.stringify(out, null, 2)); return 0; }
  renderHuman(ws, windowMs, fires, out, Date.now());
  return 0;
}

if (isMainEntry(import.meta.url)) {
  // exitCode (not process.exit): stdout to a PIPE is async on POSIX — a hard exit truncates a large
  // --context --json payload mid-flush. Nothing here holds the event loop open (the db is closed in
  // metricsCli's finally), so Node exits as soon as stdout drains.
  metricsCli().then((c) => { process.exitCode = c; });
}
