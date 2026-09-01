// WS-C C2 — `dev-loop status`: the ONE read model for any harness. Pins (a) the top-level key set
// (a harness scripts against it), (b) each section's reuse of the existing readers (queue, ledger,
// breaker replay, in-flight from runner logs, pause/drain state, daemon skew, board counts), (c)
// FAIL-SOFT: a section that cannot be computed reports {error} and never blocks its siblings, and
// (d) the CLI surface (--json, --project, text mode's NEXT line, the workspace-less one-liner).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { requestApproval } from "../src/approvals.ts";
import { writePause, clearPause } from "../src/scheduler-pause.ts";
import { resolveWorkspace, wsFireLedger, wsHubDb, wsLockPath, wsStateRoot } from "../src/workspace.ts";
import { STATUS_KEYS, inFlightFires, isSectionError, openFireInLog, renderStatus, statusReport } from "../src/status.ts";
import { writeProposal } from "../src/system-propose.ts";
import { BREAKER_STATE_SCHEMA, type BreakerStateFile } from "../src/breaker.ts";
import { breakerStatePath, teamDirOf } from "../src/scheduler-build.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(hubRoot, "src", "cli.ts");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-status-"));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string | undefined> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra } as NodeJS.ProcessEnv);
const cli = (args: string[], cwd: string, extra: Record<string, string | undefined> = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(extra), encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const SHA = "3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab";

// ── unit: the in-flight reader over the runner-log grammar run-agents.ts writes ──────────────────
{
  const header = (t: string) => `\n\n===== ${t} claude -p --model opus cwd=/x/y =====\n`;
  ok(openFireInLog(header(iso(NOW)) + "some output\n") !== null, "openFireInLog: a spawn header with no exit marker is IN FLIGHT");
  ok(openFireInLog(header(iso(NOW)) + "out\n===== exit code=0 signal=null =====\n") === null, "openFireInLog: the exit marker terminates it");
  ok(openFireInLog(header(iso(NOW)) + "\nERROR: spawn ENOENT\n") === null, "openFireInLog: a spawn failure's ERROR line terminates it too (no exit marker is ever written there)");
  ok(openFireInLog(header(iso(NOW - 60_000)) + "===== exit code=1 signal=null =====\n" + header(iso(NOW)) + "…")?.startedAt === iso(NOW), "openFireInLog: only the LAST header counts (appended log)");
  ok(openFireInLog("===== fire timeout after 30m: SIGTERM =====\n") === null, "openFireInLog: a watchdog marker is not a header");
}

try {
  // ── fixture: a service workspace + a project + queue items + a ledger + a live scheduler ───────
  const wsDir = join(tmp, "ws");
  const init = cli(["team", "init", "--dir", wsDir, "--key", "st-team", "--backend", "service", "--yes"], tmp);
  ok(init.code === 0, `fixture: team init (service) ok (${init.code}) ${init.err.slice(0, 200)}`);
  const ws = resolveWorkspace(wsDir);
  const state = wsStateRoot(ws);
  {
    const db = openDb(wsHubDb(ws));
    const pid = ensureSeed(db, "web", "Web", "WB");
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,state,assignee,waiting_on,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run("WB-1", pid, "Pick the pricing model", "Human-Blocked", "pm", "human-decision", "pm", iso(NOW - 2 * 3_600_000), iso(NOW - 2 * 3_600_000));
    ins.run("WB-2", pid, "Landed: CSV export", "In Review", "operator", null, "senior-dev", iso(NOW - 3_600_000), iso(NOW - 3_600_000));
    ins.run("WB-3", pid, "Todo thing", "Todo", null, null, "pm", iso(NOW), iso(NOW));
    ins.run("WB-4", pid, "Done thing", "Done", "dev", null, "pm", iso(NOW), iso(NOW));
    requestApproval(db, { projectId: pid, actionKey: `push:main:${SHA}`, requestedBy: "senior-dev", ticketId: "WB-3" });
    db.close();
  }
  // ledger: pm healthy, qa a dead lane on provider auth (×5 identical), sweep a no-op fire
  const rows: Record<string, unknown>[] = [
    { ts: iso(NOW - 50 * 60_000), agent: "pm", project: "web", codingAgent: "claude", provider: "anthropic", durationMs: 60_000, exitCode: 0, usage: { costUsd: 1.25 } },
    { ts: iso(NOW - 20 * 60_000), agent: "pm", project: "web", codingAgent: "claude", provider: "anthropic", durationMs: 90_000, exitCode: 0, usage: { costUsd: 0.75 } },
    { ts: iso(NOW - 10 * 60_000), agent: "sweep", project: "", codingAgent: "claude", provider: "anthropic", durationMs: 9_000, exitCode: 7, suspectError: true, errorClass: "no-output" },
  ];
  for (let i = 5; i >= 1; i--) rows.push({ ts: iso(NOW - i * 5 * 60_000), agent: "qa", project: "web", codingAgent: "opencode", provider: "openrouter", durationMs: 4_000, exitCode: 1, errorClass: "auth" });
  mkdirSync(dirname(wsFireLedger(ws)), { recursive: true });
  writeFileSync(wsFireLedger(ws), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // the scheduler: THIS process holds the run lock, started an hour ago
  mkdirSync(dirname(wsLockPath(ws, "run")), { recursive: true });
  writeFileSync(wsLockPath(ws, "run"), JSON.stringify({ pid: process.pid, team: "st-team", startedAt: iso(NOW - 3_600_000) }));
  // runner logs: pm is mid-fire (header, no footer); qa finished
  const logDir = join(state, "web", "runner-logs");
  mkdirSync(logDir, { recursive: true });
  const pmLog = join(logDir, "pm.log");
  writeFileSync(pmLog, `\n\n===== ${iso(NOW - 3 * 60_000)} claude -p cwd=${wsDir} =====\nworking…\n`);
  writeFileSync(join(logDir, "qa.log"), `\n\n===== ${iso(NOW - 5 * 60_000)} opencode run cwd=${wsDir} =====\n\n===== exit code=1 signal=null =====\n`);
  // a stale pre-restart log in another project must NOT count (older than the scheduler's start)
  mkdirSync(join(state, "_team", "runner-logs"), { recursive: true });
  writeFileSync(join(state, "_team", "runner-logs", "ops.log"), `\n\n===== ${iso(NOW - 5 * 3_600_000)} claude -p cwd=${wsDir} =====\n`);
  // a daemon runfile whose pid is dead
  writeFileSync(join(state, "daemon-web.json"), JSON.stringify({ project: "web", pid: 2147483000, url: "http://127.0.0.1:1", startedAt: iso(NOW), version: "0.0.1" }));
  // one open system proposal
  writeProposal(ws, { from: "reflect", fireId: "f-1", target: "skills/dev-agent/SKILL.md", title: "Tighten step 4", body: "Step 4 should …" }, NOW - 60_000);

  ok(inFlightFires(ws, { nowMs: NOW, sinceMs: NOW - 3_600_000 }).map((f) => `${f.agent}@${f.project}`).join(",") === "pm@web",
    "inFlightFires: the open pm header counts, qa's finished fire and the pre-restart ops log do not");

  // ── the report ──────────────────────────────────────────────────────────────────────────────────
  const r = await statusReport(ws, { nowMs: NOW });
  ok(JSON.stringify(Object.keys(r)) === JSON.stringify([...STATUS_KEYS]), `shape: top-level keys are exactly STATUS_KEYS (${Object.keys(r).join(",")})`);
  ok(r.ok === true && r.workspace.team === "st-team" && r.workspace.backend === "service", "workspace: team/backend from dev-loop.json");
  const s = r.scheduler;
  ok(!isSectionError(s), `scheduler: computed (${isSectionError(s) ? s.error : "ok"})`);
  if (!isSectionError(s)) {
    ok(s.running && s.pid === process.pid && s.state === "running", `scheduler: running from the live run lock (state=${s.state})`);
    ok(s.inFlight.length === 1 && s.inFlight[0].agent === "pm" && s.inFlight[0].project === "web" && Math.abs(s.inFlight[0].ageMs - 3 * 60_000) < 2000, "scheduler.inFlight: pm@web with its age from the header");
    const p = s.breakers.providers.find((x) => x.provider === "openrouter" && x.errorClass === "auth");
    ok(!!p && p.open && p.streak === 5, `scheduler.breakers: replay opens the openrouter:auth provider breaker at ×5 (${JSON.stringify(s.breakers.providers)})`);
    ok(s.breakers.anyOpen && s.breakers.since === iso(NOW - 3_600_000), "scheduler.breakers: replayed from the scheduler's own startedAt");
    ok(s.pause === null, "scheduler.pause: null when not paused");
  }
  const q = r.decisionQueue;
  ok(!isSectionError(q), "decisionQueue: computed");
  if (!isSectionError(q)) {
    ok(q.humanBlocked.length === 1 && q.humanBlocked[0].id === "WB-1" && q.humanBlocked[0].waitingOn === "human-decision" && q.humanBlocked[0].project === "web", "decisionQueue.humanBlocked: WB-1 with its waiting_on");
    ok(q.inReviewOperator.length === 1 && q.inReviewOperator[0].id === "WB-2" && q.inReviewOperator[0].waitingOn === null, "decisionQueue.inReviewOperator: WB-2 (waitingOn null outside Human-Blocked)");
    ok(q.approvalRequests.length === 1 && q.approvalRequests[0].actionKey === `push:main:${SHA}` && q.approvalRequests[0].ticketId === "WB-3", "decisionQueue.approvalRequests: the pending request with its key + ticket");
    ok(q.proposals.open === 1 && /tighten-step-4$/.test(q.proposals.newest ?? ""), `decisionQueue.proposals: the open system-inbox item counts (${q.proposals.newest})`);
    ok(q.total === 4 && q.oldest?.id === "WB-1", `decisionQueue: total 4, oldest by real wait is WB-1 (${q.oldest?.id})`);
  }
  const f = r.fires;
  ok(!isSectionError(f), "fires: computed");
  if (!isSectionError(f)) {
    ok(f.fires === 8 && f.failures === 6, `fires: 8 fires / 6 failed in 24h (${f.fires}/${f.failures})`);
    ok(f.perAgent.pm.recent.length === 2 && f.perAgent.pm.recent[0].costUsd === 0.75 && f.perAgent.pm.failStreak === 0, "fires.perAgent.pm: newest first, cost carried, no streak");
    ok(f.perAgent.qa.failStreak === 5 && f.perAgent.qa.recent.length === 5 && f.perAgent.qa.recent[0].errorClass === "auth", "fires.perAgent.qa: streak 5 via findConsecutiveFailures, recent capped at 5");
    ok(f.perAgent.sweep.recent[0].noop === true && f.perAgent.sweep.recent[0].project === "(team)", "fires.perAgent.sweep: exit 7 reads as noop; steward '' → (team)");
    ok(f.alerts.length === 1 && f.alerts[0].agent === "qa" && f.alerts[0].count === 5, "fires.alerts: the W44 dead-lane reader, reused");
  }
  const c = r.cost24h;
  ok(!isSectionError(c) && c.fires === 8 && c.costUsd === 2 && c.meteredFires === 2 && c.noopFires === 1 && c.noopShare === 1 / 8, `cost24h: fireMetrics numbers + no-op share (${JSON.stringify(c)})`);
  const d = r.daemon;
  ok(!isSectionError(d) && d.projects.length === 1 && d.projects[0].key === "web" && d.projects[0].running === false && d.projects[0].skew === false && typeof d.cli.version === "string", `daemon: a dead-pid runfile reads stopped, no skew claimed (${JSON.stringify(d)})`);
  const b = r.board;
  ok(!isSectionError(b) && b.byProject.web["Human-Blocked"] === 1 && b.byProject.web["In Review"] === 1 && b.byProject.web.Todo === 1 && b.byProject.web.Done === 1 && b.totals.Done === 1, "board: counts by state per project + totals");
  ok(/breaker OPEN on provider openrouter/.test(r.next), `next: the open provider breaker outranks the queue on the ladder (${r.next})`);
  const text = renderStatus(r);
  ok(/^dev-loop status — team 'st-team'/.test(text) && /scheduler: RUNNING/.test(text) && /in flight: pm@web/.test(text) && /WB-1 +Human-Blocked \(human-decision\)/.test(text) && /\nNEXT: /.test(text), "renderStatus: the text summary carries the same facts and ends with NEXT");

  // ── pause / drain state ─────────────────────────────────────────────────────────────────────────
  { const db = openDb(wsHubDb(ws)); writePause(db, "operator", "upgrade window", null, NOW); db.close(); }
  const r2 = await statusReport(ws, { nowMs: NOW });
  ok(!isSectionError(r2.scheduler) && r2.scheduler.state === "draining" && r2.scheduler.pause?.reason === "upgrade window", "scheduler.state: paused + a fire in flight = DRAINING");
  ok(/wait for the drain/.test(r2.next), `next: draining outranks everything but a dead scheduler (${r2.next})`);
  appendFileSync(pmLog, "\n===== exit code=0 signal=null =====\n");
  const r3 = await statusReport(ws, { nowMs: NOW });
  ok(!isSectionError(r3.scheduler) && r3.scheduler.state === "paused" && r3.scheduler.inFlight.length === 0, "scheduler.state: the fire's exit marker lands → PAUSED, nothing in flight");
  ok(/^dev-loop resume/.test(r3.next), `next: paused → resume (${r3.next})`);
  { const db = openDb(wsHubDb(ws)); clearPause(db); db.close(); }

  // ── WS-C review 4: the scheduler's own breaker.json beats the replay; a stale/dead/foreign one falls back ──
  const bpath = breakerStatePath(teamDirOf(state));
  const liveFile = (over: Partial<BreakerStateFile["scheduler"]> = {}): BreakerStateFile => ({
    schema: BREAKER_STATE_SCHEMA, scheduler: { pid: process.pid, startedAt: iso(NOW - 3_500_000), stoppedAt: null, ...over }, threshold: 3, probeMs: 120_000,
    agents: { sweep: { state: "half-open", consecutiveFailures: 7, openedAt: iso(NOW - 600_000), lastFailureAt: iso(NOW - 60_000), lastErrorClass: "no-output", lastReason: "no-output", probeInFlight: true, cooldownUntil: null, provider: "anthropic" } },
    providers: { "openrouter:auth": { state: "open", consecutiveFailures: 9, openedAt: iso(NOW - 900_000), lastFailureAt: iso(NOW - 120_000), lastErrorClass: "auth", lastReason: "auth", probeInFlight: false, cooldownUntil: iso(NOW + 90_000), provider: "openrouter", errorClass: "auth" } },
    lanes: { qa: "openrouter", "junior-dev": "openrouter", sweep: "anthropic" }, updatedAt: iso(NOW - 60_000), reason: "probe",
  });
  writeFileSync(bpath, JSON.stringify(liveFile()));
  const rl = await statusReport(ws, { nowMs: NOW });
  const lb = isSectionError(rl.scheduler) ? null : rl.scheduler.breakers;
  ok(lb?.source === "live" && lb.threshold === 3 && lb.probeMs === 120_000 && lb.since === iso(NOW - 3_500_000) && lb.note === undefined, `live: breaker.json from the lock-holder pid is the source, with the writer's own flags (${lb?.source}, threshold ${lb?.threshold})`);
  ok(lb?.agents.length === 1 && lb.agents[0].agent === "sweep" && lb.agents[0].state === "half-open" && lb.agents[0].open && lb.agents[0].streak === 7 && lb.agents[0].probeInFlight === true && lb.agents[0].key === "no-output",
    "live: the half-open sweep entry (×7, probe in flight) the replay could never know — the ledger holds one sweep no-op");
  const lp = lb?.providers[0];
  ok(lp?.provider === "openrouter" && lp.state === "open" && lp.streak === 9 && JSON.stringify(lp.lanes) === JSON.stringify(["junior-dev", "qa"]) && lp.cooldownUntil === iso(NOW + 90_000), `live: the provider entry carries the lanes it caps + its next probe (${JSON.stringify(lp)})`);
  ok(/breaker OPEN on provider openrouter \(auth ×9\)/.test(rl.next), `next: reads the live entries (${rl.next})`);
  const lt = renderStatus(rl);
  ok(/breakers \[live\]: OPEN provider openrouter:auth ×9 → junior-dev,qa \(next probe in 1m\) · OPEN sweep \(no-output\) ×7 \(probe in flight\)/.test(lt) && !/approximate/.test(lt),
    `renderStatus: live entries with lanes, next probe, probe-in-flight, and no replay caveat (${lt.split("\n").find((l) => /breakers/.test(l))})`);
  // A scheduler that STOPPED wrote this file on its own way out, together with `reason`. That is the last
  // statement the process made about itself, and it beats a replay — which cannot see half-open state,
  // probe timing or unclassified-failure identity, and which reaches back a fixed 24 h ACROSS scheduler
  // generations. Field case: a stopped workspace reported `streak provider anthropic:rate-limit ×3`
  // replayed from fires 15 h earlier under a previous scheduler, while the file recorded no provider
  // entries at all. So this case is `final`, not `replay` — it is served from the file, with a note
  // saying when the scheduler stopped. The three cases below stay `replay`: a dead writer may have been
  // cut off mid-write, a foreign writer is not ours, and an unknown schema cannot be read.
  writeFileSync(bpath, JSON.stringify(liveFile({ stoppedAt: iso(NOW - 1000) })));
  const rs = await statusReport(ws, { nowMs: NOW });
  const rsb = isSectionError(rs.scheduler) ? null : rs.scheduler.breakers;
  ok(rsb?.source === "final" && rsb.providers[0]?.streak === 9 && rsb.agents[0]?.state === "half-open",
    `stopped cleanly: the scheduler's OWN final state, not a replay (source=${rsb?.source}, provider streak ${rsb?.providers[0]?.streak})`);
  ok(typeof rsb?.note === "string" && /stopped at/.test(rsb.note) && !/approximate/.test(rsb.note),
    `stopped cleanly: the note says it is a recorded final state, not an approximation (${rsb?.note ?? "<none>"})`);
  // …but a fire ledgered AFTER the stop means the file no longer describes the state, and the replay is
  // right again. This is the one condition that can invalidate a cleanly stopped file.
  writeFileSync(bpath, JSON.stringify(liveFile({ stoppedAt: iso(NOW - 7_200_000) })));
  const rsf = await statusReport(ws, { nowMs: NOW });
  const rsfb = isSectionError(rsf.scheduler) ? null : rsf.scheduler.breakers;
  ok(rsfb?.source === "replay" && /after the breaker.json was written/.test(rsfb.note ?? ""),
    `stopped, then fires happened: back to the replay, and the note says why (source=${rsfb?.source}, note=${rsfb?.note?.slice(0, 80) ?? "<none>"})`);

  writeFileSync(bpath, JSON.stringify(liveFile({ pid: 2147483000 })));
  const rd = await statusReport(ws, { nowMs: NOW });
  ok(!isSectionError(rd.scheduler) && rd.scheduler.breakers.source === "replay", "stale (dead pid): the replay");
  // The run lock here is alive and names a different pid, so this file is FOREIGN before it is stale —
  // the lock is the authority on which process is the scheduler. What matters is that the caveat names
  // the reason that actually applied: the old note asserted "the scheduler wrote no live breaker.json"
  // for all four fallbacks, which was false in three of them.
  ok(!isSectionError(rd.scheduler) && /a pid the run lock does not vouch for/.test(rd.scheduler.breakers.note ?? "")
     && !/wrote no breaker\.json/.test(rd.scheduler.breakers.note ?? ""),
    `…and the caveat names the reason that applied, not a blanket claim (${isSectionError(rd.scheduler) ? "<err>" : (rd.scheduler.breakers.note ?? "<none>").slice(0, 90)})`);
  writeFileSync(bpath, JSON.stringify(liveFile({ pid: process.ppid })));
  const rf = await statusReport(ws, { nowMs: NOW });
  ok(!isSectionError(rf.scheduler) && rf.scheduler.breakers.source === "replay", "foreign (an alive pid that is not the lock holder): the replay — the lock names the scheduler");
  writeFileSync(bpath, JSON.stringify({ ...liveFile(), schema: BREAKER_STATE_SCHEMA + 1 }));
  const ru = await statusReport(ws, { nowMs: NOW });
  ok(!isSectionError(ru.scheduler) && ru.scheduler.breakers.source === "replay", "unknown schema: the replay");
  rmSync(bpath);
  const rt = renderStatus(await statusReport(ws, { nowMs: NOW }));
  ok(/breakers \[replay\]: OPEN provider openrouter:auth ×5 · streak sweep \(no-output\) ×1\n {2}\(approximate — replayed from the fire ledger/.test(rt), `renderStatus: the replay caveat prints under replayed entries (${rt.split("\n").find((l) => /breakers/.test(l))})`);
  // LOOP-155: an interrupted exit-0 row is not a recovery — the replay skips it, as the live breaker now does
  appendFileSync(wsFireLedger(ws), JSON.stringify({ ts: iso(NOW - 60_000), agent: "qa", project: "web", codingAgent: "opencode", provider: "openrouter", durationMs: 1_000, exitCode: 0, interrupted: true }) + "\n");
  const ri = await statusReport(ws, { nowMs: NOW });
  const rip = isSectionError(ri.scheduler) ? null : ri.scheduler.breakers.providers.find((p) => p.provider === "openrouter");
  ok(rip?.open === true && rip.streak === 5 && rip.lastFailureAt === iso(NOW - 5 * 60_000) && rip.openedAt === iso(NOW - 5 * 60_000), `replay: an interrupted exit-0 row does not close the openrouter:auth breaker (LOOP-155), and the timestamps are the fires' own (${JSON.stringify(rip)})`);

  // ── --project narrows; a dead scheduler reads stopped with nothing in flight ────────────────────
  const r4 = await statusReport(ws, { nowMs: NOW, project: "_team" });
  ok(!isSectionError(r4.board) && !("web" in r4.board.byProject) && !isSectionError(r4.decisionQueue) && r4.decisionQueue.humanBlocked.length === 0 && r4.workspace.project === "_team", "--project: board + queue narrowed to the named project");
  writeFileSync(wsLockPath(ws, "run"), JSON.stringify({ pid: 2147483001, startedAt: iso(NOW) }));
  writeFileSync(pmLog, `\n\n===== ${iso(NOW)} claude -p cwd=${wsDir} =====\n`); // an open header, but no live scheduler
  const r5 = await statusReport(ws, { nowMs: NOW });
  ok(!isSectionError(r5.scheduler) && r5.scheduler.state === "stopped" && r5.scheduler.inFlight.length === 0 && /^dev-loop run --background/.test(r5.next), `a dead lock pid → stopped, no phantom in-flight, NEXT = run (${r5.next})`);

  // ── FAIL-SOFT: a ledger that cannot be read degrades ONLY the ledger-backed sections ───────────
  rmSync(wsFireLedger(ws));
  mkdirSync(wsFireLedger(ws)); // EISDIR on read — a real failure, not a torn line
  const r6 = await statusReport(ws, { nowMs: NOW });
  ok(isSectionError(r6.scheduler) && isSectionError(r6.fires) && isSectionError(r6.cost24h) && /EISDIR|directory/i.test(r6.scheduler.error), "fail-soft: scheduler/fires/cost24h report {error} when the ledger is unreadable");
  ok(!isSectionError(r6.decisionQueue) && r6.decisionQueue.humanBlocked.length === 1 && !isSectionError(r6.board) && !isSectionError(r6.daemon) && typeof r6.next === "string" && r6.next.length > 0, "fail-soft: the queue, board and daemon sections are unaffected and NEXT still resolves");
  ok(JSON.stringify(Object.keys(r6)) === JSON.stringify([...STATUS_KEYS]), "fail-soft: the key set is stable even with errored sections");
  ok(/scheduler:\n {2}\(unavailable: /.test(renderStatus(r6)), "renderStatus: an errored section renders as one 'unavailable' line");
  rmSync(wsFireLedger(ws), { recursive: true, force: true });

  // ── the CLI ─────────────────────────────────────────────────────────────────────────────────────
  const j = cli(["status", "--json"], wsDir);
  ok(j.code === 0, `cli: status --json exits 0 (${j.code}) ${j.err.slice(0, 200)}`);
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(j.out); } catch { /* asserted below */ }
  ok(JSON.stringify(Object.keys(parsed)) === JSON.stringify([...STATUS_KEYS]), "cli: --json stdout is the report object with the pinned key set");
  const t = cli(["status"], wsDir);
  ok(t.code === 0 && /\nNEXT: /.test(t.out) && /decision queue: /.test(t.out), "cli: text mode ends with the NEXT line");
  const pr = cli(["status", "--json", "--project", "web"], wsDir);
  ok(pr.code === 0 && (JSON.parse(pr.out) as { workspace: { project: string } }).workspace.project === "web", "cli: --project rides into the report");
  ok(cli(["status", "--bogus"], wsDir).code === 2, "cli: an unknown flag is a usage error (2)");
  const bare = join(tmp, "bare"); mkdirSync(bare);
  const nows = cli(["status"], bare);
  ok(nows.code !== 0 && /no dev-loop\.json found from .* upward\./.test(nows.err) && !/\n\s+at /.test(nows.err), `cli: outside a workspace → one actionable line, no stack (${nows.err.split("\n")[0]?.slice(0, 80)})`);
  const att = cli(["status"], wsDir, { DEVLOOP_HUB_URL: "http://127.0.0.1:1" });
  ok(att.code === 2 && /WORKSPACE HOME/.test(att.err), "cli: status is a home-only verb — refused over attach");
  ok(!existsSync(join(wsDir, "hub.db")), "read-only: no stray hub.db was planted in the workspace root");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nSTATUS_OK");
process.exit(fails ? 1 : 0);
