#!/usr/bin/env node
// `dev-loop status [--json] [--project <key>]` — ONE read model for whoever sits in the operator seat
// (WS-C C2: control the loop from any harness). Before this verb an operator had to call `hub status`,
// `doctor`, `metrics`, `queue` and `approvals` separately and stitch the picture together by hand; a
// non-Claude harness (Codex, opencode, a plain shell agent) has no `--append-system-prompt` brief to
// tell it which of those to read first. This verb is the answer to "what is the loop doing and what
// needs me?", as one JSON object with a fixed key set, or as a short text summary ending in a NEXT line.
//
// Design rules:
//   • READ-ONLY. Nothing here writes a file, a row, or an event.
//   • FAIL-SOFT PER SECTION. Every section is computed inside `section()`; one that throws reports
//     `{ error }` and never blocks the others — a corrupt ledger must not hide the decision queue.
//   • REUSE, DON'T RE-DERIVE. Fire numbers come from metrics.ts (fireMetrics/findConsecutiveFailures),
//     the queue from metrics.decisionQueue, pause state from scheduler-pause.ts, breaker state by
//     replaying the ledger through breaker.ts's own `record()`, daemon skew via daemon-lifecycle's
//     sameDaemonCode. Doctor is NOT re-implemented: `dev-loop doctor` stays the deep check; this is
//     the glance.
//   • THE IN-FLIGHT SIGNAL is the scheduler's own runner log (run-agents.ts writes
//     `===== <ISO> <cmd> cwd=<dir> =====` at spawn and `===== exit code=… =====` at exit; a spawn
//     failure writes `ERROR: …` and no exit marker). A header without a terminator, newer than the
//     live scheduler's own startedAt, IS a fire in flight. `dev-loop pause --drain` polls the same
//     reader, so the two verbs cannot disagree about what "drained" means.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace, wsFireLedger, wsHubDb, wsLockPath, wsStateRoot } from "./workspace.ts";
import { type Workspace } from "./team-config.ts";
import { openDb, STATES } from "./db.ts";
import { formatPause, readPause, type PauseState } from "./scheduler-pause.ts";
import { decisionItemEnteredAt, decisionQueue, findConsecutiveFailures, fireMetrics, readFireRows, type ConsecutiveFailure, type FireRow } from "./metrics.ts";
import { breaker, breakerStateAlive, readBreakerState, EXIT_NO_WORK, type Agent, type BreakerEntry, type BreakerPersistedState } from "./breaker.ts";
import { breakerStatePath, teamDirOf } from "./scheduler-build.ts";
import { pkgBuildCommit, pkgVersion } from "./paths.ts";
import { sameDaemonCode } from "./daemon-lifecycle.ts";
import { listProposals } from "./system-propose.ts";

// ─── the read model ───────────────────────────────────────────────────────────────────────────────
export interface SectionError { error: string }
export type Section<T> = T | SectionError;
export const isSectionError = (s: unknown): s is SectionError => !!s && typeof s === "object" && "error" in (s as object);

export interface InFlightFire { agent: string; project: string; startedAt: string; ageMs: number; logPath: string }
// `state`/`openedAt`/`lastFailureAt` come from both sources; `probeInFlight`/`cooldownUntil`/`lanes` only
// from the live file (a replay cannot know them — that is the point of the file).
export interface BreakerAgentEntry { agent: string; key: string | null; streak: number; open: boolean; state: BreakerPersistedState; openedAt: string | null; lastFailureAt: string | null; probeInFlight?: boolean; cooldownUntil?: string | null }
export interface BreakerProviderEntry { provider: string; errorClass: string; streak: number; open: boolean; state: BreakerPersistedState; openedAt: string | null; lastFailureAt: string | null; probeInFlight?: boolean; cooldownUntil?: string | null; lanes?: string[] }
export type BreakerSource = "live" | "replay";
export interface BreakersSection { source: BreakerSource; since: string; threshold: number; probeMs: number; agents: BreakerAgentEntry[]; providers: BreakerProviderEntry[]; anyOpen: boolean; note?: string }
export type SchedulerState = "stopped" | "running" | "paused" | "draining";
export interface SchedulerSection {
  state: SchedulerState;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lockPath: string;
  pause: (PauseState & { human: string }) | null;
  inFlight: InFlightFire[];
  breakers: BreakersSection;
}
export interface QueueTicket { kind: "ticket"; id: string; project: string; title: string; state: string; waitingOn: string | null; enteredAt: string; ageMs: number }
export interface QueueApproval { kind: "approval"; id: string; project: string; actionKey: string; ticketId: string | null; requestedBy: string | null; enteredAt: string; ageMs: number }
export interface DecisionQueueSection {
  total: number;
  humanBlocked: QueueTicket[];
  inReviewOperator: QueueTicket[];
  approvalRequests: QueueApproval[];
  proposals: { open: number; newest: string | null };
  oldest: QueueTicket | QueueApproval | null;
}
export interface RecentFire { ts: string; project: string; exitCode: number | null; errorClass: string | null; durationMs: number | null; costUsd: number | null; noop: boolean }
export interface FiresSection {
  windowMs: number;
  fires: number;
  failures: number;
  perAgent: Record<string, { recent: RecentFire[]; failStreak: number; lastTs: string | null }>;
  alerts: ConsecutiveFailure[]; // the W44 threshold (5 consecutive, within 24h) — a dead lane
}
export interface DaemonProject { key: string; running: boolean; pid: number | null; url: string | null; healthy: boolean | null; version: string | null; buildCommit: string | null; skew: boolean }
export interface DaemonSection { cli: { version: string; buildCommit: string | null }; projects: DaemonProject[] }
export interface BoardSection { byProject: Record<string, Record<string, number>>; totals: Record<string, number> }
export interface CostSection { windowMs: number; fires: number; costUsd: number | null; meteredFires: number; noopFires: number; noopShare: number | null; successRate: number | null }

export interface StatusReport {
  ok: true;
  generatedAt: string;
  workspace: { root: string; team: string; backend: string; mode: string; project: string | null };
  scheduler: Section<SchedulerSection>;
  decisionQueue: Section<DecisionQueueSection>;
  fires: Section<FiresSection>;
  daemon: Section<DaemonSection>;
  board: Section<BoardSection>;
  cost24h: Section<CostSection>;
  next: string;
}
/** The top-level key set, exported so the test and any harness pin the SAME contract. */
export const STATUS_KEYS = ["ok", "generatedAt", "workspace", "scheduler", "decisionQueue", "fires", "daemon", "board", "cost24h", "next"] as const;

const DAY_MS = 86_400_000;
const RECENT_PER_AGENT = 5;
const LOG_TAIL_BYTES = 64 * 1024;
const HEALTH_TIMEOUT_MS = 800;

function section<T>(fn: () => T): Section<T> {
  try { return fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
async function sectionAsync<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

// ─── scheduler: run lock ──────────────────────────────────────────────────────────────────────────
export interface RunLock { pid: number | null; startedAt: string | null; alive: boolean; path: string }
export function readRunLock(ws: Workspace): RunLock {
  const path = wsLockPath(ws, "run");
  if (!existsSync(path)) return { pid: null, startedAt: null, alive: false, path };
  let holder: { pid?: number; startedAt?: string } = {};
  try { holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; startedAt?: string }; } catch { /* unreadable = stale */ }
  const pid = typeof holder.pid === "number" ? holder.pid : null;
  return { pid, startedAt: holder.startedAt ?? null, alive: pid !== null && pidAlive(pid), path };
}

// ─── scheduler: in-flight fires from the runner logs ──────────────────────────────────────────────
const HEADER = /^===== (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) .* cwd=.* =====$/;
const TERMINATOR = /^(===== exit code=|ERROR: )/;

function readTail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

/** The last fire header in a runner log with NO terminator after it — the in-flight shape. */
export function openFireInLog(text: string): { startedAt: string } | null {
  const lines = text.split("\n");
  let header = -1, startedAt = "";
  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i]);
    if (m) { header = i; startedAt = m[1]; }
  }
  if (header === -1) return null;
  for (let i = header + 1; i < lines.length; i++) if (TERMINATOR.test(lines[i])) return null;
  return { startedAt };
}

/**
 * Every fire the scheduler has started and not yet finished, read from its runner logs
 * (`<ws>/.dev-loop/<project>/runner-logs/<agent>.log`). `sinceMs` bounds the header age: a fire
 * older than the live scheduler's own startedAt is a log a SIGKILLed scheduler left behind, not a
 * process. Callers that know the scheduler is dead should pass `Infinity` or skip the call — the
 * default is "anything in the last day", which is what `pause --drain` wants when no lock is readable.
 */
export function inFlightFires(ws: Workspace, opts: { nowMs?: number; sinceMs?: number } = {}): InFlightFire[] {
  const now = opts.nowMs ?? Date.now();
  const since = opts.sinceMs ?? now - DAY_MS;
  const root = wsStateRoot(ws);
  const out: InFlightFire[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const project of dirs) {
    const logDir = join(root, project, "runner-logs");
    let logs: string[] = [];
    try { logs = readdirSync(logDir).filter((f) => f.endsWith(".log")); } catch { continue; }
    for (const f of logs) {
      const logPath = join(logDir, f);
      let open: { startedAt: string } | null = null;
      try { open = openFireInLog(readTail(logPath, LOG_TAIL_BYTES)); } catch { continue; }
      if (!open) continue;
      const startedMs = Date.parse(open.startedAt);
      if (!Number.isFinite(startedMs) || startedMs < since) continue;
      out.push({ agent: f.slice(0, -".log".length), project, startedAt: open.startedAt, ageMs: Math.max(0, now - startedMs), logPath });
    }
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

// ─── scheduler: breaker state — the live file, else a replay ─────────────────────────────────────
// The scheduler persists its breaker singleton to `<ws>/.dev-loop/team/breaker.json` on every change
// (WS-C review 4, breaker.ts). That file IS the state, and it is used when its writer is the live
// scheduler: the recorded pid answers a zero-signal probe, the file is not marked stopped, and — when the
// run lock is readable — that pid is the lock holder. Otherwise (a scheduler from a build older than the
// file, a crash, a pid the lock does not vouch for) the read falls back to REPLAYING the ledger through
// breaker.ts's own record() and says so in `source`. The replay is an approximation, and the ways it can
// disagree with the process are why the file exists: the scheduler's --breaker / --breaker-probe are not in
// the ledger (defaults assumed); probe timing and the half-open state are not reproducible; an unclassified
// failure keys on an output tail the ledger deliberately never stores (`(no-output)` here, so distinct
// tails read as one streak); interrupted fires never fed the breaker (skipped here too, LOOP-155); and a
// scheduler restart or the 90-day ledger prune (metrics.pruneFireLedger) moves the replay's start.
export const REPLAY_NOTE = "approximate — replayed from the fire ledger because the scheduler wrote no live breaker.json (older build, or not running): --breaker/--breaker-probe assumed at their defaults; half-open state, next-probe time and unclassified-failure identity are not reproducible";
export function replayBreakers(rows: FireRow[], sinceMs: number): BreakersSection {
  const b = { ...breaker, byAgent: new Map<Agent, BreakerEntry>(), byProvider: new Map<string, BreakerEntry>(), _agentProvider: new Map<Agent, string | null>(), onEvent: undefined, onChange: undefined };
  const replay = rows.filter((r) => Date.parse(r.ts) >= sinceMs && !r.interrupted).sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  for (const r of replay) b.record(r.agent as Agent, r.exitCode ?? 1, r.errorClass ?? null, undefined, r.provider ?? null, { at: Date.parse(r.ts) });
  const iso = (ms: number | null | undefined): string | null => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const state = (e: BreakerEntry): BreakerPersistedState => (e.open ? "open" : "closed");
  const agents: BreakerAgentEntry[] = [...b.byAgent.entries()].filter(([, e]) => e.streak > 0).map(([agent, e]) => ({ agent, key: e.key, streak: e.streak, open: e.open, state: state(e), openedAt: iso(e.openedAt), lastFailureAt: iso(e.lastFailureAt) }));
  const providers: BreakerProviderEntry[] = [...b.byProvider.entries()].filter(([, e]) => e.streak > 0).map(([k, e]) => {
    const i = k.indexOf(":");
    return { provider: k.slice(0, i), errorClass: k.slice(i + 1), streak: e.streak, open: e.open, state: state(e), openedAt: iso(e.openedAt), lastFailureAt: iso(e.lastFailureAt) };
  });
  return { source: "replay", since: new Date(sinceMs).toISOString(), threshold: b.threshold, probeMs: b.probeMs, agents, providers, anyOpen: agents.some((a) => a.open) || providers.some((p) => p.open), note: REPLAY_NOTE };
}

/** The scheduler's own breaker.json, when its writer is the live scheduler; null ⇒ the caller replays. */
export function liveBreakers(ws: Workspace, lock: RunLock): BreakersSection | null {
  const f = readBreakerState(breakerStatePath(teamDirOf(wsStateRoot(ws))));
  if (!f || !breakerStateAlive(f)) return null;
  if (lock.alive && lock.pid !== f.scheduler.pid) return null; // a live lock names the scheduler; a file another pid wrote is not its state
  const agents: BreakerAgentEntry[] = Object.entries(f.agents).map(([agent, e]) => ({ agent, key: e.lastReason, streak: e.consecutiveFailures, open: e.state !== "closed", state: e.state, openedAt: e.openedAt, lastFailureAt: e.lastFailureAt, probeInFlight: e.probeInFlight, cooldownUntil: e.cooldownUntil }));
  const providers: BreakerProviderEntry[] = Object.values(f.providers).map((e) => ({
    provider: e.provider, errorClass: e.errorClass, streak: e.consecutiveFailures, open: e.state !== "closed", state: e.state, openedAt: e.openedAt, lastFailureAt: e.lastFailureAt,
    probeInFlight: e.probeInFlight, cooldownUntil: e.cooldownUntil, lanes: Object.entries(f.lanes).filter(([, p]) => p === e.provider).map(([a]) => a).sort(),
  }));
  return { source: "live", since: f.scheduler.startedAt, threshold: f.threshold, probeMs: f.probeMs, agents, providers, anyOpen: agents.some((a) => a.open) || providers.some((p) => p.open) };
}

function schedulerSection(ws: Workspace, rows: FireRow[], nowMs: number): SchedulerSection {
  const lock = readRunLock(ws);
  const running = lock.alive;
  const sinceMs = running && lock.startedAt ? Date.parse(lock.startedAt) : nowMs - DAY_MS;
  // With no live scheduler nothing is in flight by definition — a header without a footer is then a
  // log a killed scheduler left behind, which `run` will overwrite on its next fire.
  const inFlight = running ? inFlightFires(ws, { nowMs, sinceMs }) : [];
  let pause: SchedulerSection["pause"] = null;
  const dbPath = wsHubDb(ws);
  if (existsSync(dbPath)) {
    const db = openDb(dbPath);
    try { const p = readPause(db, nowMs); if (p) pause = { ...p, human: formatPause(p, nowMs) }; } finally { db.close(); }
  }
  const state: SchedulerState = !running ? "stopped" : pause ? (inFlight.length ? "draining" : "paused") : "running";
  return { state, running, pid: running ? lock.pid : null, startedAt: running ? lock.startedAt : null, lockPath: lock.path, pause, inFlight, breakers: liveBreakers(ws, lock) ?? replayBreakers(rows, sinceMs) };
}

// ─── decision queue ───────────────────────────────────────────────────────────────────────────────
function decisionQueueSection(ws: Workspace, project: string | null, nowMs: number): DecisionQueueSection {
  const out: DecisionQueueSection = { total: 0, humanBlocked: [], inReviewOperator: [], approvalRequests: [], proposals: { open: 0, newest: null }, oldest: null };
  const dbPath = wsHubDb(ws);
  if (existsSync(dbPath)) {
    const db = openDb(dbPath);
    try {
      const projects = (db.prepare("SELECT id, key FROM projects ORDER BY key").all() as { id: string; key: string }[]).filter((p) => !project || p.key === project);
      const nowIso = new Date(nowMs).toISOString();
      for (const p of projects) {
        for (const item of decisionQueue(db, p.id, nowIso)) {
          const enteredAt = decisionItemEnteredAt(db, item);
          const ageMs = Math.max(0, nowMs - Date.parse(enteredAt));
          if (item.kind === "approval") {
            out.approvalRequests.push({ kind: "approval", id: item.id, project: p.key, actionKey: item.actionKey, ticketId: item.ticketId, requestedBy: item.requestedBy, enteredAt, ageMs });
            continue;
          }
          const waitingOn = (db.prepare("SELECT waiting_on FROM tickets WHERE id=?").get(item.id) as { waiting_on: string | null } | undefined)?.waiting_on ?? null;
          const t: QueueTicket = { kind: "ticket", id: item.id, project: p.key, title: item.title, state: item.state, waitingOn: item.state === "Human-Blocked" ? waitingOn : null, enteredAt, ageMs };
          (item.state === "Human-Blocked" ? out.humanBlocked : out.inReviewOperator).push(t);
        }
      }
    } finally { db.close(); }
  }
  const byAge = <T extends { ageMs: number }>(xs: T[]) => xs.sort((a, b) => b.ageMs - a.ageMs);
  byAge(out.humanBlocked); byAge(out.inReviewOperator); byAge(out.approvalRequests);
  const open = listProposals(ws, { status: "open" });
  out.proposals = { open: open.length, newest: open[0]?.id ?? null };
  const all: (QueueTicket | QueueApproval)[] = [...out.humanBlocked, ...out.inReviewOperator, ...out.approvalRequests];
  out.total = all.length + open.length;
  out.oldest = byAge(all)[0] ?? null;
  return out;
}

// ─── fires + cost ─────────────────────────────────────────────────────────────────────────────────
function firesSection(rows: FireRow[], project: string | null, nowMs: number): FiresSection {
  const windowMs = DAY_MS;
  const inWindow = rows.filter((r) => { const t = Date.parse(r.ts); return t >= nowMs - windowMs && t <= nowMs && (!project || r.project === project); });
  const byAgent = new Map<string, FireRow[]>();
  for (const r of inWindow) { const l = byAgent.get(r.agent) ?? []; l.push(r); byAgent.set(r.agent, l); }
  const perAgent: FiresSection["perAgent"] = {};
  for (const [agent, list] of [...byAgent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const desc = list.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const recent: RecentFire[] = desc.slice(0, RECENT_PER_AGENT).map((r) => ({
      ts: r.ts, project: r.project || "(team)", exitCode: r.exitCode ?? null, errorClass: r.errorClass ?? null,
      durationMs: r.durationMs ?? null, costUsd: r.usage?.costUsd ?? null, noop: r.exitCode === EXIT_NO_WORK,
    }));
    // The same streak reader W44 uses, at threshold 1 so the number is the streak itself.
    const streak = findConsecutiveFailures(desc, 1, windowMs, nowMs).find((f) => f.agent === agent)?.count ?? 0;
    perAgent[agent] = { recent, failStreak: streak, lastTs: desc[0]?.ts ?? null };
  }
  return {
    windowMs, fires: inWindow.length, failures: inWindow.filter((r) => (r.exitCode ?? 0) !== 0 || r.timedOut).length,
    perAgent, alerts: findConsecutiveFailures(inWindow, 5, windowMs, nowMs),
  };
}

function costSection(ledger: string, rows: FireRow[], nowMs: number): CostSection {
  const windowMs = DAY_MS;
  const fm = existsSync(ledger) ? fireMetrics(ledger, windowMs, nowMs) : null;
  const inWindow = rows.filter((r) => { const t = Date.parse(r.ts); return t >= nowMs - windowMs && t <= nowMs; });
  const noopFires = inWindow.filter((r) => r.exitCode === EXIT_NO_WORK).length;
  return {
    windowMs, fires: fm?.fires ?? 0, costUsd: fm?.costUsd ?? null, meteredFires: fm?.costMeteredFires ?? 0,
    noopFires, noopShare: inWindow.length ? noopFires / inWindow.length : null, successRate: fm?.successRate ?? null,
  };
}

// ─── daemon ───────────────────────────────────────────────────────────────────────────────────────
interface RunInfo { project?: string; pid?: number; url?: string; version?: string; buildCommit?: string | null }
async function healthOf(url: string, key: string): Promise<{ version?: string; buildCommit?: string | null } | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), HEALTH_TIMEOUT_MS);
    const r = await fetch(`${url}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(t));
    if (r.status !== 200) return null;
    const b = (await r.json().catch(() => null)) as { ok?: boolean; project?: string; version?: string; buildCommit?: string | null } | null;
    if (!b || b.ok !== true || b.project !== key) return null;
    return { version: b.version, buildCommit: b.buildCommit };
  } catch { return null; }
}
async function daemonSection(ws: Workspace, project: string | null): Promise<DaemonSection> {
  const root = wsStateRoot(ws);
  const cli = { version: pkgVersion(), buildCommit: pkgBuildCommit() };
  let files: string[] = [];
  try { files = readdirSync(root).filter((f) => /^daemon-.+\.json$/.test(f)).sort(); } catch { files = []; }
  const projects = await Promise.all(files.map(async (f): Promise<DaemonProject | null> => {
    const key = f.slice("daemon-".length, -".json".length);
    if (project && key !== project) return null;
    let info: RunInfo = {};
    try { info = JSON.parse(readFileSync(join(root, f), "utf8")) as RunInfo; } catch { /* unreadable runfile */ }
    const pid = typeof info.pid === "number" ? info.pid : null;
    const running = pid !== null && pidAlive(pid);
    const url = info.url ?? null;
    const live = running && url ? await healthOf(url, key) : null;
    const version = live?.version ?? info.version ?? null;
    const buildCommit = live?.buildCommit ?? info.buildCommit ?? null;
    // W36's question: is the code the daemon is RUNNING the code the CLI on disk is? (LOOP-250)
    const skew = running && version !== null && !sameDaemonCode(cli.version, cli.buildCommit, version, buildCommit);
    return { key, running, pid: running ? pid : null, url, healthy: running ? live !== null : null, version, buildCommit, skew };
  }));
  return { cli, projects: projects.filter((p): p is DaemonProject => p !== null) };
}

// ─── board ────────────────────────────────────────────────────────────────────────────────────────
function boardSection(ws: Workspace, project: string | null): BoardSection {
  const out: BoardSection = { byProject: {}, totals: Object.fromEntries(STATES.map((s) => [s, 0])) };
  const dbPath = wsHubDb(ws);
  if (!existsSync(dbPath)) return out;
  const db = openDb(dbPath);
  try {
    const rows = db.prepare("SELECT p.key AS key, t.state AS state, COUNT(*) AS n FROM tickets t JOIN projects p ON p.id = t.project_id GROUP BY p.key, t.state ORDER BY p.key").all() as { key: string; state: string; n: number }[];
    for (const r of rows) {
      if (project && r.key !== project) continue;
      out.byProject[r.key] ??= Object.fromEntries(STATES.map((s) => [s, 0]));
      out.byProject[r.key][r.state] = r.n;
      out.totals[r.state] = (out.totals[r.state] ?? 0) + r.n;
    }
  } finally { db.close(); }
  return out;
}

// ─── NEXT — one line, doctor's precedence ladder in miniature ─────────────────────────────────────
// 1. cannot run (scheduler down) · 2. cannot fire (draining / paused / breaker open / dead lane) ·
// 3. the operator is the loop's only unscalable resource (oldest decision, then proposals) ·
// 4. day-2 drift (daemon skew / stopped daemon) · 5. nothing needs you.
export function nextLine(r: Omit<StatusReport, "next">): string {
  const s = r.scheduler, q = r.decisionQueue, f = r.fires, d = r.daemon;
  if (!isSectionError(s)) {
    if (!s.running) return "dev-loop run --background  (no scheduler is running for this workspace)";
    if (s.state === "draining") return `wait for the drain — ${s.inFlight.length} fire(s) still in flight (${s.inFlight.map((x) => `${x.agent}@${x.project} ${formatAge(x.ageMs)}`).join(", ")}); \`dev-loop status\` again, or \`dev-loop pause --drain\` to block on it`;
    if (s.state === "paused") return `dev-loop resume  (${s.pause?.human ?? "paused"})`;
    const openP = s.breakers.providers.find((p) => p.open);
    if (openP) return `breaker OPEN on provider ${openP.provider} (${openP.errorClass} ×${openP.streak}) — fix the provider (key/quota), the loop re-probes on its own; \`dev-loop doctor\` for W13`;
    const openA = s.breakers.agents.find((a) => a.open);
    if (openA) return `breaker OPEN for ${openA.agent} (${openA.key ?? "?"} ×${openA.streak}) — read .dev-loop/<project>/runner-logs/${openA.agent}.log and fix the cause`;
  }
  if (!isSectionError(f) && f.alerts.length) {
    const a = f.alerts[0];
    return `dead lane: ${a.agent} failed ${a.count}× in a row (${a.errorClass}) — read its runner log, then \`dev-loop pause --reason "<why>"\` if it is burning budget`;
  }
  if (!isSectionError(q)) {
    const o = q.oldest;
    if (o && o.kind === "approval") return `rule on approval ${o.id} (${formatAge(o.ageMs)}, ${o.actionKey}): dev-loop approve --request ${o.id} --note "<why>"  |  dev-loop revoke ${o.id}`;
    if (o) return `rule on ${o.id} (${formatAge(o.ageMs)}, ${o.state}${o.waitingOn ? ` · ${o.waitingOn}` : ""}): dev-loop ticket ${o.id}, then the ruling grammar in references/operator-rulings.md`;
    if (q.proposals.open) return `review ${q.proposals.open} open system proposal(s): dev-loop system list --status open`;
  }
  if (!isSectionError(d)) {
    const skewed = d.projects.find((p) => p.skew);
    if (skewed) return `DEVLOOP_PROJECT=${skewed.key} dev-loop daemon up  (daemon runs v${skewed.version}, CLI is v${d.cli.version} — W36 build skew)`;
    const down = d.projects.find((p) => !p.running || p.healthy === false);
    if (down) return `DEVLOOP_PROJECT=${down.key} dev-loop daemon up  (daemon ${down.running ? "unhealthy" : "stopped"})`;
  }
  return "nothing needs you — the loop is running; `dev-loop doctor` for the deep check";
}

// ─── the aggregate ────────────────────────────────────────────────────────────────────────────────
export async function statusReport(ws: Workspace, opts: { project?: string | null; nowMs?: number } = {}): Promise<StatusReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const project = opts.project ?? null;
  const ledger = wsFireLedger(ws);
  // The ledger is read ONCE and shared; a torn ledger degrades every ledger-backed section to {error}
  // identically rather than three different ways.
  const rowsS = section(() => (existsSync(ledger) ? readFireRows(ledger) : []));
  const rows = isSectionError(rowsS) ? null : rowsS;
  const withRows = <T>(fn: (rows: FireRow[]) => T): Section<T> => (rows === null ? { error: (rowsS as SectionError).error } : section(() => fn(rows)));
  const base = {
    ok: true as const,
    generatedAt: new Date(nowMs).toISOString(),
    workspace: { root: ws.root, team: ws.file.team.key, backend: ws.file.team.backend, mode: ws.file.team.mode ?? "live", project },
    scheduler: withRows((r) => schedulerSection(ws, r, nowMs)),
    decisionQueue: section(() => decisionQueueSection(ws, project, nowMs)),
    fires: withRows((r) => firesSection(r, project, nowMs)),
    daemon: await sectionAsync(() => daemonSection(ws, project)),
    board: section(() => boardSection(ws, project)),
    cost24h: withRows((r) => costSection(ledger, r, nowMs)),
  };
  return { ...base, next: nextLine(base) };
}

// ─── text rendering ───────────────────────────────────────────────────────────────────────────────
const usd = (n: number | null): string => (n === null ? "unmetered" : `$${n.toFixed(2)}`);
export function renderStatus(r: StatusReport): string {
  const L: string[] = [];
  const err = (s: SectionError) => `  (unavailable: ${s.error})`;
  L.push(`dev-loop status — team '${r.workspace.team}' @ ${r.workspace.root} (backend ${r.workspace.backend}, mode ${r.workspace.mode}${r.workspace.project ? `, project ${r.workspace.project}` : ""})  ${r.generatedAt}`);
  const s = r.scheduler;
  if (isSectionError(s)) L.push("scheduler:", err(s));
  else {
    L.push(`scheduler: ${s.state.toUpperCase()}${s.running ? ` pid ${s.pid} since ${s.startedAt}` : ""}${s.pause ? ` — ${s.pause.human}` : ""}`);
    if (s.inFlight.length) L.push(`  in flight: ${s.inFlight.map((x) => `${x.agent}@${x.project} (${formatAge(x.ageMs)})`).join(", ")}`);
    const bk = s.breakers;
    const nowMs = Date.parse(r.generatedAt);
    const when = (e: { state: BreakerPersistedState; cooldownUntil?: string | null }): string => {
      if (e.state === "half-open") return " (probe in flight)";
      if (e.state !== "open" || !e.cooldownUntil) return "";
      const ms = Date.parse(e.cooldownUntil) - nowMs;
      return ms <= 0 ? " (next probe due)" : ` (next probe in ${formatAge(ms)})`;
    };
    const bs = [
      ...bk.providers.map((p) => `${p.open ? "OPEN" : "streak"} provider ${p.provider}:${p.errorClass} ×${p.streak}${p.open && p.lanes?.length ? ` → ${p.lanes.join(",")}` : ""}${when(p)}`),
      ...bk.agents.map((a) => `${a.open ? "OPEN" : "streak"} ${a.agent} (${a.key}) ×${a.streak}${when(a)}`),
    ];
    if (bs.length) L.push(`  breakers [${bk.source}]: ${bs.join(" · ")}`);
    if (bs.length && bk.source === "replay") L.push(`  (${bk.note})`);
  }
  const q = r.decisionQueue;
  if (isSectionError(q)) L.push("decision queue:", err(q));
  else {
    L.push(`decision queue: ${q.total}${q.total ? "" : " — nothing waits on you"}`);
    for (const t of [...q.humanBlocked, ...q.inReviewOperator]) L.push(`  ${t.id.padEnd(10)} ${t.state}${t.waitingOn ? ` (${t.waitingOn})` : ""}  ${formatAge(t.ageMs).padStart(4)}  ${t.title}`);
    for (const a of q.approvalRequests) L.push(`  approval ${a.id.slice(0, 8)}  ${a.actionKey}  from ${a.requestedBy ?? "?"}${a.ticketId ? ` (${a.ticketId})` : ""}  ${formatAge(a.ageMs)}`);
    if (q.proposals.open) L.push(`  system proposals open: ${q.proposals.open} (newest ${q.proposals.newest}) → dev-loop system list --status open`);
  }
  const f = r.fires, c = r.cost24h;
  if (isSectionError(f)) L.push("fires 24h:", err(f));
  else {
    const cost = isSectionError(c) ? "" : ` · ${usd(c.costUsd)} (${c.meteredFires} metered) · no-op ${c.noopShare === null ? "n/a" : `${Math.round(c.noopShare * 100)}%`}`;
    L.push(`fires 24h: ${f.fires} fires · ${f.failures} failed${cost}`);
    for (const [agent, a] of Object.entries(f.perAgent)) {
      const marks = a.recent.map((x) => (x.noop ? "noop" : x.exitCode === 0 ? "ok" : `fail(${x.errorClass ?? x.exitCode})`)).join(" ");
      L.push(`  ${agent.padEnd(14)} ${marks}${a.failStreak ? `  streak ${a.failStreak}` : ""}`);
    }
    for (const a of f.alerts) L.push(`  DEAD LANE: ${a.agent} ${a.count}× ${a.errorClass}`);
  }
  const d = r.daemon;
  if (isSectionError(d)) L.push("daemon:", err(d));
  else L.push(`daemon (cli v${d.cli.version}): ${d.projects.length ? d.projects.map((p) => `${p.key} ${p.running ? (p.healthy ? "RUNNING" : "UNHEALTHY") : "stopped"}${p.version ? ` v${p.version}` : ""}${p.skew ? " SKEW" : ""}`).join(" · ") : "no daemons started"}`);
  const b = r.board;
  if (isSectionError(b)) L.push("board:", err(b));
  else {
    const keys = Object.keys(b.byProject);
    if (!keys.length) L.push("board: no tickets");
    for (const k of keys) L.push(`board ${k}: ${STATES.filter((st) => b.byProject[k][st]).map((st) => `${st} ${b.byProject[k][st]}`).join(" · ") || "empty"}`);
  }
  L.push(`NEXT: ${r.next}`);
  return L.join("\n");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────
function usage(): void {
  console.log(`dev-loop status — the one read a harness needs: scheduler (pause/drain/breakers/in-flight), the
decision queue (Human-Blocked · In Review@operator · approval requests · open system proposals), fire
health, daemons (+ W36 build skew), board counts, 24h cost. Read-only; every section fails soft.

Usage: dev-loop status [--json] [--project <key>]
  --json            the full report object (keys: ${STATUS_KEYS.join(", ")})
  --project <key>   narrow the queue/fires/board/daemon sections to one project
Text mode ends with a NEXT line: the single most-blocking action, doctor's precedence ladder.
Reading rules + the ruling grammar: skills/operator-console/SKILL.md, references/operator-rulings.md.`);
}

export async function statusCli(argv = process.argv.slice(2)): Promise<number> {
  let json = false, project: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--project") { project = argv[++i] ?? ""; if (!project) { console.error("dev-loop status: --project requires a value"); return 2; } }
    else if (a === "--help" || a === "-h") { usage(); return 0; }
    else { console.error(`dev-loop status: unknown option '${a}'`); usage(); return 2; }
  }
  const ws = resolveWorkspace(); // WsNotFound → the cli-bootstrap one-liner (LOOP-283)
  const report = await statusReport(ws, { project });
  process.stdout.write((json ? JSON.stringify(report, null, 2) : renderStatus(report)) + "\n");
  return 0;
}

if (isMainEntry(import.meta.url)) {
  statusCli().then((c) => { process.exitCode = c; }, (e) => { console.error(`dev-loop status: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}
