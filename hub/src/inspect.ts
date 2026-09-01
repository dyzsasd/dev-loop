#!/usr/bin/env node
// inspect.ts — `dev-loop inspect`: one read-only, deterministic snapshot of a workspace's loop.
//
// The motivation is measured, not theoretical. Nine operator inspections of a live workspace in one
// day each cost roughly 100k tokens, and nearly all of it was raw material: a sub-agent ran a dozen
// commands, read run.log and the tail of every agent's runner-log, diffed git state, and only then
// judged. The judgement needs a few dozen lines of structured fact. This verb produces those lines,
// so the tokens buy the judgement instead of the transcript.
//
// Three properties make it worth having rather than a prompt:
//   - It calls NO model. Every number is read off disk or git; the only opinions are `warnings`, and
//     each is a fixed threshold over a named field, not an inference.
//   - It reuses the readers the product already ships (statusReport, metrics, doctor), so inspect
//     cannot disagree with `dev-loop status`, `metrics` or `doctor` about the same fact.
//   - Absent data is `null`, never 0 — the honest-null rule metrics already follows. "No ledger yet"
//     and "a ledger with no fires" are different answers and an operator acts differently on them.
//
// Scope is the WORKSPACE: one scheduler drives every enabled project, so "is this loop healthy" is a
// workspace question with per-project detail, not a per-project question.
//
// Exit code is always 0. This is a reading instrument, not a gate — `doctor` is the gate, and its
// codes appear here so one call answers "what is doctor saying" without paying for its prose.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_HANDLES, LANES } from "./agent-handles.ts";
import { openDb } from "./db.ts";
import { isMainEntry } from "./is-entry.ts";
import { ledgerSpanMs, readFireRows, staleClaimFindings, usdLabel, type FireRow, type StaleClaimFinding } from "./metrics.ts";
import { findProject } from "./seed.ts";
import { isSectionError, statusReport, type StatusReport } from "./status.ts";
import { deliveryProjects, effectiveRepo, type Workspace } from "./team-config.ts";
import { wsFireLedger, wsHubDb, wsStateRoot } from "./workspace.ts";

const MIN = 60_000;
const DAY_MS = 86_400_000;

/** Thresholds in ONE place: every `warnings` entry is a comparison against one of these. */
export const INSPECT_THRESHOLDS = {
  /** An `In Progress` ticket whose last event is older than this is a stalled claim. */
  staleClaimMs: 30 * MIN,
  /** One errorClass this many times for one agent inside the window is a pattern, not weather. */
  repeatedErrorClass: 3,
} as const;

export interface InspectWarning {
  kind: "stalled-claim" | "repeated-error-class" | "dead-lane" | "unpushed-commits" | "dirty-worktree";
  /** One line an operator can act on. The structured evidence sits beside it, never only inside it. */
  detail: string;
  evidence: Record<string, unknown>;
}

export interface InspectWorktree { path: string; branch: string | null; dirty: boolean | null; canonical: boolean }

export interface InspectRepo {
  ref: string;
  path: string;
  defaultBranch: string;
  branch: string | null;
  /** null when the repo has no remote — not 0, which would read as "up to date". */
  ahead: number | null;
  behind: number | null;
  dirty: boolean | null;
  dirtyFiles: number | null;
  worktrees: InspectWorktree[];
}

export interface InspectLane {
  lane: string;
  lastFireAt: string | null;
  lastResult: "ok" | "failed" | null;
  /** null = the ledger has no dimension for this lane, so its activity is UNKNOWN, not zero. */
  fires: number | null;
}

export interface InspectFires {
  windowMs: number;
  /** The ledger's ACTUAL span inside the window (W28): dividing by a fixed 7 invents a rate. */
  spanMs: number;
  total: number;
  successRate: number | null;
  usdPerDay: number | null;
  costUsd: number | null;
  byAgent: { agent: string; fires: number; costUsd: number | null }[];
  errorClasses: Record<string, number>;
  mostExpensive: { agent: string; ts: string; costUsd: number; durationMs: number | null } | null;
}

export interface InspectBoardProject {
  counts: Record<string, number>;
  staleClaims: { id: string; owner: string | null; state: string; ageMinutes: number }[];
  decisionQueue: number | null;
}

export interface InspectDoctorCode { code: string; severity: "error" | "warning"; message: string }

export interface InspectReport {
  generatedAt: string;
  windowMs: number;
  workspace: { root: string; team: string; backend: string; mode: string };
  scheduler: StatusReport["scheduler"];
  daemon: StatusReport["daemon"];
  board: Record<string, InspectBoardProject> | null;
  fires: InspectFires | null;
  breaker: { agents: unknown[]; providers: unknown[]; anyOpen: boolean } | null;
  doctor: InspectDoctorCode[] | null;
  repos: InspectRepo[];
  lanes: InspectLane[];
  warnings: InspectWarning[];
}

/** The top-level key set, exported so a consumer and the test pin the SAME contract. */
export const INSPECT_KEYS = [
  "generatedAt", "windowMs", "workspace", "scheduler", "daemon", "board",
  "fires", "breaker", "doctor", "repos", "lanes", "warnings",
] as const;

const git = (dir: string, args: string[]): string | null => {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};

/**
 * `git worktree list --porcelain` to one entry per tree.
 *
 * Written here rather than reused because neither existing reader returns a list: doctor's
 * checkInRepoWorktrees REPORTS (it emits W34 lines) and handoff-gate's worktreeForTicket answers
 * about a single ticket. This parses the same porcelain both of them do.
 */
function listWorktrees(repoDir: string): { path: string; branch: string | null }[] {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  if (out === null) return [];
  const trees: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9).trim(), branch: null }; trees.push(cur); }
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
  }
  return trees.slice(1); // the first record is the base clone itself
}

function repoSection(ws: Workspace): InspectRepo[] {
  const out: InspectRepo[] = [];
  // The canonical worktree shape is wsWorktree's: <workspace>/.dev-loop/wt/<ticket>/<repo-ref>.
  // Anything else is a tree some fire composed by hand — the class the old §7 path formula produced.
  const canonicalRoot = join(wsStateRoot(ws), "wt");
  for (const ref of Object.keys(ws.file.repos ?? {})) {
    const reg = effectiveRepo(ws, ref) as { defaultBranch?: string };
    const rel = (ws.file.repos[ref] as { path?: string } | undefined)?.path ?? ref;
    const path = join(ws.root, rel);
    const defaultBranch = reg.defaultBranch ?? "main";
    if (!existsSync(path)) {
      out.push({ ref, path, defaultBranch, branch: null, ahead: null, behind: null, dirty: null, dirtyFiles: null, worktrees: [] });
      continue;
    }
    const branch = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    // No remote means ahead/behind are unanswerable, not 0 — the same reading worktree reap and
    // push-guard take. A repo with no origin has nothing to be ahead OF.
    const hasRemote = git(path, ["remote", "get-url", "origin"]) !== null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (hasRemote && branch) {
      const counts = git(path, ["rev-list", "--left-right", "--count", `origin/${branch}...${branch}`]);
      const parts = counts?.split(/\s+/);
      if (parts?.length === 2) { behind = Number(parts[0]); ahead = Number(parts[1]); }
    }
    const porcelain = git(path, ["status", "--porcelain", "--untracked-files=no"]);
    const dirtyFiles = porcelain === null ? null : porcelain.split("\n").filter(Boolean).length;
    const worktrees = listWorktrees(path).map((w) => {
      const wtDirty = git(w.path, ["status", "--porcelain", "--untracked-files=no"]);
      return {
        path: w.path,
        branch: w.branch,
        dirty: wtDirty === null ? null : wtDirty.split("\n").filter(Boolean).length > 0,
        canonical: w.path.startsWith(canonicalRoot + "/"),
      };
    });
    out.push({ ref, path, defaultBranch, branch, ahead, behind, dirty: dirtyFiles === null ? null : dirtyFiles > 0, dirtyFiles, worktrees });
  }
  return out;
}

function firesSection(rows: FireRow[], windowMs: number, nowMs: number): InspectFires | null {
  if (!rows.length) return null; // no ledger at all means null, never a zeroed report
  const since = new Date(nowMs - windowMs).toISOString();
  const inWindow = rows.filter((r) => r.ts >= since);
  const costOf = (r: FireRow): number | null => r.usage?.costUsd ?? null;
  const metered = inWindow.map(costOf).filter((c): c is number => c !== null);
  const costUsd = metered.length ? metered.reduce((a, b) => a + b, 0) : null;
  const spanMs = ledgerSpanMs(inWindow, windowMs, nowMs);
  const byAgentMap = new Map<string, { fires: number; cost: number; metered: number }>();
  const errorClasses: Record<string, number> = {};
  let mostExpensive: InspectFires["mostExpensive"] = null;
  let failures = 0;
  for (const r of inWindow) {
    const e = byAgentMap.get(r.agent) ?? { fires: 0, cost: 0, metered: 0 };
    e.fires++;
    const c = costOf(r);
    if (c !== null) {
      e.cost += c;
      e.metered++;
      if (!mostExpensive || c > mostExpensive.costUsd) mostExpensive = { agent: r.agent, ts: r.ts, costUsd: c, durationMs: r.durationMs ?? null };
    }
    byAgentMap.set(r.agent, e);
    if (r.errorClass) { errorClasses[r.errorClass] = (errorClasses[r.errorClass] ?? 0) + 1; failures++; }
    else if ((r.exitCode ?? 0) !== 0) failures++;
  }
  return {
    windowMs,
    spanMs,
    total: inWindow.length,
    successRate: inWindow.length ? (inWindow.length - failures) / inWindow.length : null,
    // The ledger's real span, not a fixed divisor: a 3-hour-old ledger has no 7-day rate (W28).
    usdPerDay: costUsd !== null && spanMs > 0 ? (costUsd / spanMs) * DAY_MS : null,
    costUsd,
    byAgent: [...byAgentMap.entries()]
      .map(([agent, e]) => ({ agent, fires: e.fires, costUsd: e.metered ? e.cost : null }))
      .sort((a, b) => b.fires - a.fires),
    errorClasses,
    mostExpensive,
  };
}

function laneSection(rows: FireRow[], windowMs: number, nowMs: number): InspectLane[] {
  const since = new Date(nowMs - windowMs).toISOString();
  const inWindow = rows.filter((r) => r.ts >= since);
  // The ledger's `agent` field holds the ACTOR, not the lane: run-agents writes `laneActor(agent)`, so a
  // pm-groom fire is ledgered as `pm`. Matching a LANE name against it therefore finds nothing, ever —
  // and reporting that as `fires: 0` asserted something the ledger cannot answer. Measured on the live
  // browser-use ledger: run.log records 82 pm-lane fires (groom 21 + maintenance 44 + review 17) and the
  // ledger holds exactly `pm: 82`, with no lane name anywhere. Every `inspect` therefore raised five
  // dead-lane warnings against five lanes that were firing normally — in the one verb this batch added
  // FOR delegated inspection.
  // A lane keeps its row, but its activity reads null: unknown, not zero. The actor handles below it are
  // unaffected — those DO match, and their dead-lane check is the half that was ever true.
  const ledgerHasLane = new Set(inWindow.map((r) => r.agent));
  return [...AGENT_HANDLES, ...LANES].map((lane) => {
    const derivable = (AGENT_HANDLES as readonly string[]).includes(lane) || ledgerHasLane.has(lane);
    if (!derivable) return { lane, lastFireAt: null, lastResult: null, fires: null };
    const mine = inWindow.filter((r) => r.agent === lane).sort((a, b) => a.ts.localeCompare(b.ts));
    const last = mine[mine.length - 1];
    return {
      lane,
      lastFireAt: last?.ts ?? null,
      lastResult: last ? (last.errorClass || (last.exitCode ?? 0) !== 0 ? "failed" : "ok") : null,
      fires: mine.length,
    };
  });
}

function boardSection(ws: Workspace, status: StatusReport, nowMs: number): Record<string, InspectBoardProject> | null {
  const dbPath = wsHubDb(ws);
  if (!existsSync(dbPath)) return null;
  const counts = isSectionError(status.board) ? {} : status.board.byProject;
  const queueTotal = isSectionError(status.decisionQueue) ? null : status.decisionQueue.total;
  const out: Record<string, InspectBoardProject> = {};
  let db;
  try { db = openDb(dbPath); } catch { return null; }
  try {
    for (const key of deliveryProjects(ws)) {
      const projectId = findProject(db, key); // the id, or null when the project has no board row yet
      const stale: StaleClaimFinding[] = projectId
        ? staleClaimFindings(db, projectId, { windowMs: INSPECT_THRESHOLDS.staleClaimMs, nowMs })
        : [];
      out[key] = {
        counts: counts[key] ?? {},
        staleClaims: stale.map((s) => ({ id: s.ticketId, owner: s.owner, state: s.state, ageMinutes: Math.round(s.lastEventAgeHours * 60) })),
        decisionQueue: queueTotal,
      };
    }
  } finally { try { db.close(); } catch { /* already closed */ } }
  return out;
}

/** Doctor's findings as CODES, not prose: the operator wants "what is doctor saying", not its essay. */
async function doctorSection(ws: Workspace): Promise<InspectDoctorCode[] | null> {
  try {
    const { doctorWorkspace } = await import("./doctor.ts");
    const found: InspectDoctorCode[] = [];
    const take = (severity: "error" | "warning") => (m: string) => {
      const code = /\[([WE]\d{2})\]/.exec(m)?.[1];
      if (code) found.push({ code, severity, message: m.replace(/\s+/g, " ").trim() });
    };
    await doctorWorkspace(ws, { out: { pass: () => {}, info: () => {}, warn: take("warning"), fail: take("error") } });
    return found;
  } catch { return null; }
}

function warningsFrom(
  repos: InspectRepo[], board: Record<string, InspectBoardProject> | null, fires: InspectFires | null,
  lanes: InspectLane[], rows: FireRow[], windowMs: number, nowMs: number,
): InspectWarning[] {
  const w: InspectWarning[] = [];
  for (const [project, b] of Object.entries(board ?? {}))
    for (const s of b.staleClaims)
      w.push({
        kind: "stalled-claim",
        detail: `${s.id} has been ${s.state} for ${s.ageMinutes}m with no event (owner ${s.owner ?? "unassigned"})`,
        evidence: { project, id: s.id, owner: s.owner, state: s.state, ageMinutes: s.ageMinutes },
      });

  // A repeated errorClass is a pattern; one occurrence is weather. Counted PER AGENT, because
  // "sweep timed out three times" and "three agents timed out once" call for different actions.
  const since = new Date(nowMs - windowMs).toISOString();
  const perAgentClass = new Map<string, number>();
  for (const r of rows)
    if (r.ts >= since && r.errorClass) {
      const k = `${r.agent} ${r.errorClass}`;
      perAgentClass.set(k, (perAgentClass.get(k) ?? 0) + 1);
    }
  for (const [k, count] of perAgentClass) {
    if (count < INSPECT_THRESHOLDS.repeatedErrorClass) continue;
    const [agent, errorClass] = k.split(" ");
    w.push({ kind: "repeated-error-class", detail: `${agent} hit '${errorClass}' ${count}x in the window`, evidence: { agent, errorClass, count } });
  }

  // A lane that never fired inside the window. Only meaningful once the ledger HAS fires: on an empty
  // ledger every lane is silent, and saying so fifteen times is noise rather than a finding.
  // `=== 0`, so a lane whose activity is UNKNOWN (null — the ledger records the actor, not the lane) is
  // skipped rather than reported as silent. Saying "it did not fire" about data that was never recorded
  // is the same error as saying it fifteen times on an empty ledger, which the guard above already avoids.
  if (fires && fires.total > 0)
    for (const l of lanes)
      if (l.fires === 0)
        w.push({ kind: "dead-lane", detail: `${l.lane} did not fire in the window`, evidence: { lane: l.lane, lastFireAt: l.lastFireAt } });

  for (const r of repos) {
    if ((r.ahead ?? 0) > 0)
      w.push({ kind: "unpushed-commits", detail: `${r.ref} is ${r.ahead} commit(s) ahead of origin/${r.branch}`, evidence: { repo: r.ref, branch: r.branch, ahead: r.ahead } });
    if (r.dirty)
      w.push({ kind: "dirty-worktree", detail: `${r.ref} has ${r.dirtyFiles} uncommitted tracked file(s)`, evidence: { repo: r.ref, path: r.path, files: r.dirtyFiles } });
    for (const t of r.worktrees.filter((t) => t.dirty))
      w.push({
        kind: "dirty-worktree",
        detail: `${r.ref} worktree ${t.branch ?? t.path} has uncommitted tracked files`,
        evidence: { repo: r.ref, path: t.path, branch: t.branch, canonical: t.canonical },
      });
  }
  return w;
}

export async function inspectReport(ws: Workspace, opts: { windowMs?: number; nowMs?: number } = {}): Promise<InspectReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? DAY_MS;
  const status = await statusReport(ws, { nowMs });
  const ledger = wsFireLedger(ws);
  const rows = existsSync(ledger) ? readFireRows(ledger) : [];
  const repos = repoSection(ws);
  const board = boardSection(ws, status, nowMs);
  const fires = firesSection(rows, windowMs, nowMs);
  const lanes = laneSection(rows, windowMs, nowMs);
  const sched = status.scheduler;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowMs,
    workspace: { root: ws.root, team: ws.file.team.key, backend: ws.file.team.backend, mode: ws.file.team.mode ?? "live" },
    scheduler: sched,
    daemon: status.daemon,
    board,
    fires,
    breaker: isSectionError(sched) ? null : { agents: sched.breakers.agents, providers: sched.breakers.providers, anyOpen: sched.breakers.anyOpen },
    doctor: await doctorSection(ws),
    repos,
    lanes,
    warnings: warningsFrom(repos, board, fires, lanes, rows, windowMs, nowMs),
  };
}

const pct = (n: number | null): string => (n === null ? "-" : `${Math.round(n * 100)}%`);
const usd = (n: number | null): string => (n === null ? "unmetered" : `$${usdLabel(n)}`);

export function renderInspect(r: InspectReport): string {
  const L: string[] = [];
  L.push(`# inspect - ${r.workspace.team} @ ${r.workspace.root}`);
  L.push(`window ${Math.round(r.windowMs / MIN)}m | ${r.generatedAt} | backend ${r.workspace.backend} | mode ${r.workspace.mode}`);

  L.push("", "## scheduler");
  if (isSectionError(r.scheduler)) L.push(`unavailable: ${r.scheduler.error}`);
  else {
    L.push(`state ${r.scheduler.state}${r.scheduler.pid ? ` (pid ${r.scheduler.pid}, since ${r.scheduler.startedAt})` : ""}${r.scheduler.pause ? ` - paused: ${r.scheduler.pause.human}` : ""}`);
    L.push(r.scheduler.inFlight.length
      ? r.scheduler.inFlight.map((f) => `in flight: ${f.agent} on ${f.project} for ${Math.round(f.ageMs / 1000)}s`).join("\n")
      : "in flight: none");
  }

  L.push("", "## fires");
  if (!r.fires) L.push("no fire ledger yet");
  else {
    L.push(`${r.fires.total} fire(s) | success ${pct(r.fires.successRate)} | ${usd(r.fires.costUsd)} over a ${Math.round(r.fires.spanMs / MIN)}m span | ${r.fires.usdPerDay === null ? "unmetered" : `$${usdLabel(r.fires.usdPerDay)}/day`}`);
    for (const a of r.fires.byAgent) L.push(`  ${a.agent}: ${a.fires} fire(s), ${usd(a.costUsd)}`);
    const ec = Object.entries(r.fires.errorClasses);
    if (ec.length) L.push(`  errorClass: ${ec.map(([k, v]) => `${k} x${v}`).join(", ")}`);
    if (r.fires.mostExpensive) L.push(`  most expensive: ${r.fires.mostExpensive.agent} ${usd(r.fires.mostExpensive.costUsd)} at ${r.fires.mostExpensive.ts}`);
  }

  L.push("", "## board");
  if (!r.board) L.push("no board db");
  else for (const [k, b] of Object.entries(r.board)) {
    L.push(`${k}: ${Object.entries(b.counts).map(([s, n]) => `${s}=${n}`).join(" ") || "(empty)"} | decision queue ${b.decisionQueue ?? "?"}`);
    for (const s of b.staleClaims) L.push(`  stalled claim: ${s.id} ${s.state} ${s.ageMinutes}m (${s.owner ?? "unassigned"})`);
  }

  L.push("", "## repos");
  for (const repo of r.repos) {
    L.push(`${repo.ref} @ ${repo.branch ?? "?"}: ahead ${repo.ahead ?? "n/a"}, behind ${repo.behind ?? "n/a"}, ${repo.dirty === null ? "unreadable" : repo.dirty ? `${repo.dirtyFiles} dirty` : "clean"}`);
    for (const t of repo.worktrees) L.push(`  worktree ${t.branch ?? t.path}${t.dirty ? " (dirty)" : ""}${t.canonical ? "" : " - NON-CANONICAL PATH"}`);
  }

  L.push("", "## lanes");
  // Three states, not two: fired, silent, and NOT DERIVABLE. The last one is the five job lanes, whose
  // fires the ledger files under their actor — printing them beside the genuinely silent ones would put
  // a claim about missing data in the same sentence as a measurement.
  const silent = r.lanes.filter((l) => l.fires === 0).map((l) => l.lane);
  const unknown = r.lanes.filter((l) => l.fires === null).map((l) => l.lane);
  for (const l of r.lanes.filter((l) => (l.fires ?? 0) > 0)) L.push(`${l.lane}: ${l.fires} fire(s), last ${l.lastResult} at ${l.lastFireAt}`);
  if (silent.length) L.push(`no fire in the window: ${silent.join(", ")}`);
  if (unknown.length) L.push(`not derivable from the ledger (fires are recorded under the lane's actor): ${unknown.join(", ")}`);

  L.push("", "## doctor");
  L.push(r.doctor === null ? "unavailable" : r.doctor.length ? r.doctor.map((d) => `${d.severity === "error" ? "FAIL" : "warn"} ${d.code}`).join(" ") : "no codes");

  L.push("", "## warnings");
  L.push(r.warnings.length ? r.warnings.map((w) => `- [${w.kind}] ${w.detail}`).join("\n") : "none");
  return L.join("\n");
}

const USAGE = `dev-loop inspect - one read-only snapshot of this workspace's loop (no model calls)

Usage: dev-loop inspect [--window <dur>] [--json]

  --window <dur>   how far back to read the fire ledger (default 1d; e.g. 30m, 2h)
  --json           structured output; the human render is the default

Always exits 0 - it reports, it does not gate. \`dev-loop doctor\` is the gate.`;

export async function inspectCli(argv: string[], ws: Workspace): Promise<number> {
  let windowMs = DAY_MS;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--window") {
      const raw = argv[++i] ?? "";
      const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw.trim());
      if (!m) { console.error(`dev-loop inspect: --window must look like 30m / 2h / 1d (got '${raw}')`); return 2; }
      const mult = { ms: 1, s: 1000, m: MIN, h: 60 * MIN, d: DAY_MS }[m[2] ?? "m"]!;
      windowMs = Number(m[1]) * mult;
    } else if (a === "--help" || a === "-h") { console.log(USAGE); return 0; }
    else { console.error(`dev-loop inspect: unknown option '${a}'`); return 2; }
  }
  const report = await inspectReport(ws, { windowMs });
  console.log(asJson ? JSON.stringify(report, null, 2) : renderInspect(report));
  return 0;
}

if (isMainEntry(import.meta.url)) {
  const { resolveWorkspace } = await import("./workspace.ts");
  const { WsNotFound } = await import("./workspace.ts");
  let ws: Workspace;
  try { ws = resolveWorkspace(); }
  catch (e) {
    if (e instanceof WsNotFound) { console.error(`dev-loop inspect: ${(e as Error).message}`); process.exit(1); }
    throw e;
  }
  process.exit(await inspectCli(process.argv.slice(2), ws));
}
