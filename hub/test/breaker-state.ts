// WS-C review 4 — breaker.json: the scheduler persists its breaker state, `dev-loop status` reads it LIVE
// instead of replaying the ledger, and a scheduler restart RESUMES an open breaker instead of silently
// closing it. Unit half: the singleton's snapshot / restore / persistence contract (breaker.ts is an
// importable leaf). Integration half: a real `dev-loop run` (fake failing CLI, --breaker 2) writes the
// file, a restart resumes it, --breaker-reset starts fresh, and an operator SIGTERM does not close it —
// the scheduler cannot be imported (main() is unconditional, LOOP-58), so it is driven as a subprocess
// the way team-scheduler.ts does.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { breaker, BREAKER_STATE_SCHEMA, breakerStateAlive, createBreakerPersistence, persistedKey, readBreakerState, writeBreakerState, type BreakerStateFile } from "../src/breaker.ts";
import { breakerStatePath, teamDirOf } from "../src/scheduler-build.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-breaker-state-")));
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-08-27T10:00:00.000Z");
const reset = (threshold = 3, probeMs = 60_000) => { breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear(); breaker.onEvent = undefined; breaker.onChange = undefined; breaker.threshold = threshold; breaker.probeMs = probeMs; };
const SCHED = { pid: 4242, startedAt: iso(T0 - 5000), stoppedAt: null };

// ── snapshot: the persisted shape, and the file round trip ─────────────────────────────────────────
{
  reset();
  breaker.seedProvider("pm", "anthropic"); breaker.seedProvider("qa", "openrouter"); breaker.seedProvider("junior-dev", "openrouter");
  const TAIL = "Error: boom\nsk-live-secret-looking last line";
  for (let i = 0; i < 3; i++) breaker.record("pm", 1, null, TAIL, "anthropic", { at: T0 + i * 1000 });
  for (let i = 0; i < 3; i++) breaker.record("qa", 1, "auth", "401 unauthorized", "openrouter", { at: T0 + 3000 + i * 1000 });
  ok(breaker.isOpen("pm") && breaker.isOpen("qa") && breaker.isOpen("junior-dev"), "setup: pm (agent) and openrouter:auth (provider) breakers are OPEN");
  const s = breaker.snapshot(SCHED, "record", T0 + 10_000);
  ok(s.schema === BREAKER_STATE_SCHEMA && s.threshold === 3 && s.probeMs === 60_000 && s.updatedAt === iso(T0 + 10_000) && s.reason === "record" && s.scheduler.pid === 4242, "snapshot: schema, the writer's own threshold/probe, updatedAt, reason, scheduler identity");
  const pm = s.agents.pm;
  ok(pm?.state === "open" && pm.consecutiveFailures === 3 && pm.openedAt === iso(T0 + 2000) && pm.lastFailureAt === iso(T0 + 2000) && pm.lastErrorClass === null && pm.provider === "anthropic" && pm.probeInFlight === false && pm.cooldownUntil === null,
    `snapshot.agents.pm: open ×3, openedAt/lastFailureAt from the fires' own times (${JSON.stringify(pm)})`);
  ok(/^\(unclassified tail #[0-9a-f]{8}\)$/.test(pm?.lastReason ?? "") && !JSON.stringify(s).includes("secret-looking") && pm?.lastReason === persistedKey("sk-live-secret-looking last line", null),
    "§16: an unclassified failure's key (the fire's last output line) reaches the file only as a hash");
  const pa = s.providers["openrouter:auth"];
  ok(pa?.state === "open" && pa.consecutiveFailures === 3 && pa.provider === "openrouter" && pa.errorClass === "auth" && pa.lastReason === "auth" && pa.lastErrorClass === "auth" && pa.openedAt === iso(T0 + 5000),
    `snapshot.providers: keyed provider:errorClass, the class is its own reason (${JSON.stringify(pa)})`);
  ok(JSON.stringify(s.lanes) === JSON.stringify({ pm: "anthropic", qa: "openrouter", "junior-dev": "openrouter" }), "snapshot.lanes: agent → provider as the scheduler resolved it");
  // the reschedule seam records the next probe; a provider entry reports the earliest among its lanes
  ok(breaker.intervalFor("junior-dev", 10_000, T0 + 10_000) === 60_000 && breaker.intervalFor("qa", 10_000, T0 + 20_000) === 60_000, "intervalFor: open ⇒ probe cadence (unchanged contract)");
  const s2 = breaker.snapshot(SCHED, "reschedule", T0 + 20_000);
  ok(!("qa" in s2.agents) && !("junior-dev" in s2.agents), "snapshot: a lane capped only by a provider breaker gets no agent entry of its own (closed, streak 0)");
  ok(s2.providers["openrouter:auth"].cooldownUntil === iso(T0 + 70_000), `snapshot: a provider's cooldownUntil is the EARLIEST next probe among its lanes (${s2.providers["openrouter:auth"].cooldownUntil})`);
  ok(breaker.intervalFor("sweep", 7_000) === 7_000 && !breaker.byAgent.has("sweep"), "intervalFor: a closed lane is untouched — no entry, no write");
  // half-open: a probe in flight
  ok(breaker.markProbe("pm") && breaker.markProbe("junior-dev") && !breaker.markProbe("sweep"), "markProbe: true when something was open to probe (pm's own; junior-dev's provider), false otherwise");
  const s3 = breaker.snapshot(SCHED, "probe", T0 + 21_000);
  ok(s3.agents.pm.state === "half-open" && s3.agents.pm.probeInFlight && s3.providers["openrouter:auth"].state === "half-open", "snapshot: half-open = open with a probe in flight, on the agent and on the provider entry");
  breaker.record("pm", 1, null, TAIL, "anthropic", { at: T0 + 22_000 });
  const s4 = breaker.snapshot(SCHED, "record", T0 + 22_000);
  ok(s4.agents.pm.state === "open" && s4.agents.pm.consecutiveFailures === 4 && s4.agents.pm.lastFailureAt === iso(T0 + 22_000) && s4.agents.pm.openedAt === iso(T0 + 2000), "a failed probe: back to open, streak +1, openedAt unchanged");
  breaker.record("junior-dev", 0, null, "did work", "openrouter", { at: T0 + 23_000 });
  const s5 = breaker.snapshot(SCHED, "record", T0 + 23_000);
  ok(!("openrouter:auth" in s5.providers) && breaker.isOpen("pm") && !breaker.isOpen("qa"), "a successful probe closes the provider breaker (entry gone from the file); pm's own stays open");
  // round trip
  const path = join(tmp, "team", "breaker.json");
  ok(writeBreakerState(path, s5) && existsSync(path) && !existsSync(`${path}.${process.pid}.tmp`), "writeBreakerState: creates the dir, writes, renames — no tmp left behind");
  if (platform() !== "win32") ok((statSync(path).mode & 0o077) === 0, `writeBreakerState: owner-only 0600 (got ${(statSync(path).mode & 0o777).toString(8)})`);
  ok(JSON.stringify(readBreakerState(path)) === JSON.stringify(s5), "readBreakerState: byte-for-byte what was written");
  // atomicity: a crash mid-write leaves a .tmp; readers never see it
  writeFileSync(`${path}.99999.tmp`, '{"schema":1,"scheduler":{"pid":1,"sta');
  ok(readBreakerState(path)?.scheduler.pid === 4242, "a torn .tmp beside the file is ignored — a reader only ever sees the last completed rename");
  writeFileSync(path, '{"schema":1,"scheduler":{"pid":1,"sta');
  ok(readBreakerState(path) === null, "a torn breaker.json itself reads as absent (⇒ status replays, a restart starts fresh)");
  writeFileSync(path, JSON.stringify({ ...s5, schema: BREAKER_STATE_SCHEMA + 1 }));
  ok(readBreakerState(path) === null, "another schema version reads as absent");
  ok(readBreakerState(join(tmp, "nope.json")) === null, "no file reads as absent");
  // liveness
  const live = { ...s5, scheduler: { pid: process.pid, startedAt: iso(T0), stoppedAt: null } };
  ok(breakerStateAlive(live) && !breakerStateAlive({ ...live, scheduler: { ...live.scheduler, stoppedAt: iso(T0 + 1) } }) && !breakerStateAlive({ ...live, scheduler: { ...live.scheduler, pid: 2147483000 } }),
    "breakerStateAlive: not stopped AND the pid answers a zero-signal probe");
}

// ── restore: what a restart resumes ────────────────────────────────────────────────────────────────
{
  const NOW = T0 + 3_600_000;
  const entry = (state: "open" | "closed" | "half-open", streak: number, lastFailureAt: string, extra: Record<string, unknown> = {}) =>
    ({ state, consecutiveFailures: streak, openedAt: iso(NOW - 900_000), lastFailureAt, lastErrorClass: null, lastReason: "(unclassified tail #abcd1234)", probeInFlight: state === "half-open", cooldownUntil: null, ...extra });
  const file: BreakerStateFile = {
    schema: BREAKER_STATE_SCHEMA, scheduler: { pid: 1, startedAt: iso(T0), stoppedAt: iso(NOW - 5000) }, threshold: 5, probeMs: 3_600_000,
    agents: {
      pm: { ...entry("open", 6, iso(NOW - 30_000)), provider: "anthropic" },      // fresh ⇒ resumed
      sweep: { ...entry("open", 5, iso(NOW - 120_000)), provider: "anthropic" },  // older than the (new) probe cadence ⇒ stale
      ops: { ...entry("closed", 2, iso(NOW - 10_000)), provider: "anthropic" },   // a partial streak ⇒ never
    },
    providers: { "openrouter:auth": { ...entry("half-open", 9, iso(NOW - 10_000), { lastErrorClass: "auth", lastReason: "auth" }), provider: "openrouter", errorClass: "auth" } },
    lanes: { pm: "anthropic", qa: "openrouter", "junior-dev": "openrouter", sweep: "anthropic", ops: "anthropic" },
    updatedAt: iso(NOW - 5000), reason: "stop",
  };
  reset(3, 60_000); // the NEW process's flags decide: probe 60s is the freshness window
  const r = breaker.restore(file, NOW);
  ok(r.resumed.map((i) => i.name).sort().join(",") === "openrouter:auth,pm" && r.stale.map((i) => i.name).join(",") === "sweep",
    `restore: fresh open entries resume; an open entry older than the probe cadence is reported stale (resumed=${r.resumed.map((i) => i.name)}, stale=${r.stale.map((i) => i.name)})`);
  const rp = r.resumed.find((i) => i.name === "pm");
  ok(rp?.ageMs === 30_000 && rp.streak === 6 && rp.kind === "agent" && r.resumed.find((i) => i.name === "openrouter:auth")?.kind === "provider", "restore: each item carries kind, streak and the age of its last evidence for the one-line log");
  const pm = breaker.byAgent.get("pm");
  ok(breaker.isOpen("pm") && pm?.streak === 6 && pm.key === "(unclassified tail #abcd1234)" && pm.probeInFlight === false && pm.cooldownUntil === null && pm.openedAt === NOW - 900_000,
    "restore: pm is OPEN with its streak; the probe flag and cooldown are cleared (the restart's first fire is the probe)");
  ok(breaker.isOpen("qa") && breaker.isOpen("junior-dev"), "restore: the resumed provider breaker caps every lane the file maps to that provider — BEFORE any of them has fired (the LOOP-72 window, closed from the file)");
  ok(breaker.byProvider.get("openrouter:auth")?.probeInFlight === false && breaker.byProvider.get("openrouter:auth")?.open === true, "restore: a half-open entry resumes as open (the old probe died with the old process)");
  ok(!breaker.isOpen("sweep") && !breaker.byAgent.has("sweep") && !breaker.byAgent.has("ops"), "restore: the stale entry and the partial streak are not resumed");
  // the resumed streak continues when the same unclassified tail fails again (the hashed key matches)
  const same = "some unclassified last line";
  breaker.byAgent.get("pm")!.key = persistedKey(same, null); // as if the file had carried THIS tail's hash
  breaker.record("pm", 1, null, `lots of output\n${same}`, "anthropic", { at: NOW + 1000 });
  ok(breaker.byAgent.get("pm")?.streak === 7 && breaker.byAgent.get("pm")?.key === same && breaker.isOpen("pm"), `the same tail failing after a restart CONTINUES the resumed streak (×${breaker.byAgent.get("pm")?.streak}); the live line replaces the hash in memory`);
  breaker.record("pm", 1, null, "a different last line", "anthropic", { at: NOW + 2000 });
  ok(breaker.byAgent.get("pm")?.streak === 1 && breaker.isOpen("pm"), "a DIFFERENT failure restarts the count but the breaker stays open (only a success closes it — unchanged semantics)");
  breaker.record("pm", 0, null, "recovered", "anthropic", { at: NOW + 3000 });
  ok(!breaker.isOpen("pm"), "a success closes a resumed breaker like any other");
  reset(0);
  ok(breaker.restore(file, NOW).resumed.length === 0 && !breaker.isOpen("pm"), "restore: --breaker 0 (off) resumes nothing");
  reset(3, 60_000); breaker.seedProvider("pm", "openai");
  breaker.restore(file, NOW);
  ok(breaker._agentProvider.get("pm") === "openai" && breaker._agentProvider.get("qa") === "openrouter", "restore: the file's lanes fill gaps only — a provider the new boot resolved wins");
}

// ── LOOP-155: an interrupted fire is evidence of nothing ───────────────────────────────────────────
{
  reset(2, 60_000);
  breaker.record("pm", 1, null, "boom", "anthropic", { at: T0 }); breaker.record("pm", 1, null, "boom", "anthropic", { at: T0 + 1 });
  breaker.markProbe("pm");
  breaker.record("pm", 0, null, "Execution error", "anthropic", { interrupted: true, at: T0 + 2 });
  const e = breaker.byAgent.get("pm");
  ok(breaker.isOpen("pm") && e?.streak === 2 && e.probeInFlight === false, "LOOP-155: an INTERRUPTED exit-0 fire neither closes the breaker nor counts as a failure — it only ends the probe it was");
  breaker.record("pm", 7, "no-output", "", "anthropic", { interrupted: true, at: T0 + 3 });
  ok(breaker.isOpen("pm") && breaker.byAgent.get("pm")?.streak === 2, "LOOP-155: nor does an interrupted fire that happened to be classified — interrupted outranks the exit code both ways");
}

// ── createBreakerPersistence: coalesced writes, synchronous stop ───────────────────────────────────
{
  reset(2, 60_000);
  const path = join(tmp, "coalesce", "breaker.json");
  const queue: (() => void)[] = [];
  let clock = T0;
  const per = createBreakerPersistence({ path, pid: 777, startedAt: iso(T0 - 1), schedule: (fn) => { queue.push(fn); }, now: () => clock });
  const f0 = readBreakerState(path);
  ok(per.flush("start") && readBreakerState(path)?.reason === "start" && readBreakerState(path)?.scheduler.pid === 777 && readBreakerState(path)?.scheduler.stoppedAt === null && f0 === null,
    "persistence: flush('start') writes the scheduler identity immediately");
  breaker.record("qa", 0, null, "fine", "openrouter", { at: T0 });
  ok(queue.length === 0, "a healthy fire on a healthy lane schedules NO write");
  breaker.record("pm", 1, null, "boom", "anthropic", { at: T0 + 1 });
  breaker.record("pm", 1, null, "boom", "anthropic", { at: T0 + 2 }); // opens at 2
  clock = T0 + 3;
  breaker.intervalFor("pm", 1000, clock);
  ok(queue.length === 1, `record ×2 + the reschedule coalesce into ONE scheduled write (${queue.length})`);
  queue.shift()!();
  const f = readBreakerState(path);
  ok(f?.reason === "reschedule" && f.agents.pm.state === "open" && f.agents.pm.consecutiveFailures === 2 && f.agents.pm.cooldownUntil === iso(T0 + 3 + 60_000) && f.updatedAt === iso(T0 + 3),
    `…carrying the last reason and the whole state (${f?.reason}, cooldown ${f?.agents.pm?.cooldownUntil})`);
  breaker.markProbe("pm");
  ok(queue.length === 1, "a probe launch schedules a write");
  queue.shift()!();
  ok(readBreakerState(path)?.agents.pm.state === "half-open", "…and the file reads half-open while the probe runs");
  clock = T0 + 10;
  ok(per.stop() && readBreakerState(path)?.scheduler.stoppedAt === iso(T0 + 10) && readBreakerState(path)?.reason === "stop" && breaker.onChange === undefined,
    "stop(): a synchronous final write with stoppedAt (usable from a process 'exit' hook), then unsubscribed");
  breaker.record("pm", 1, null, "boom", "anthropic", { at: T0 + 11 });
  ok(queue.length === 0, "after stop() nothing is scheduled");
}

// ── integration: a real scheduler writes, resumes, resets, and survives an operator stop ───────────
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const runAgents = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd, env: env(extra), encoding: "utf8", timeout: 90_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const status = (cwd: string): any => { const r = spawnSync("node", [join(hubRoot, "src", "cli.ts"), "status", "--json"], { cwd, env: env(), encoding: "utf8" }); try { return JSON.parse(r.stdout); } catch { return null; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lineWith = (out: string, re: RegExp) => out.split("\n").find((l) => re.test(l)) ?? "(no such line)";

try {
  const ws = join(tmp, "ws");
  const init = team(["init", "--dir", ws, "--key", "brk-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
  ok(init.status === 0, `fixture: team init (${init.status}) ${(init.stderr ?? "").slice(0, 200)}`);
  mkdirSync(join(ws, "ra"), { recursive: true });
  team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
  team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);
  const failBin = join(tmp, "fail-claude.sh");
  writeFileSync(failBin, "#!/bin/sh\necho 'boom: provider is down'\nexit 1\n"); chmodSync(failBin, 0o755);
  const file = breakerStatePath(teamDirOf(join(ws, ".dev-loop")));
  const base = ["--agents", "pm", "--interval", "pm=1s", "--stagger", "0", "--breaker", "2"];

  // run 1: two identical failures trip the breaker; the scheduler persists it on every change and at stop
  const r1 = runAgents([...base, "--breaker-probe", "5s", "--max-fires", "2"], ws, { DEVLOOP_CLAUDE_BIN: failBin });
  ok(r1.code === 0 && /\[breaker\] breaker OPEN: pm/.test(r1.out), `run 1: --breaker 2 + two identical failures ⇒ OPEN (exit ${r1.code}) ${r1.code === 0 ? "" : r1.out.slice(-400)}`);
  const f1 = readBreakerState(file);
  ok(f1?.agents.pm?.state === "open" && f1.agents.pm.consecutiveFailures === 2 && f1.threshold === 2 && f1.probeMs === 5000 && f1.lanes.pm === "anthropic",
    `run 1: breaker.json says pm OPEN ×2 with the writer's own flags (${JSON.stringify(f1?.agents.pm)}, threshold ${f1?.threshold}, probe ${f1?.probeMs})`);
  ok(f1?.scheduler.stoppedAt !== null && f1?.reason === "stop" && !!f1 && !breakerStateAlive(f1), "run 1: the exit hook stamped stoppedAt — a reader can tell a stop from a crash");
  ok(!readFileSync(file, "utf8").includes("boom"), "run 1 (§16): the fire's output line never reaches the file — the unclassified key is a hash");
  if (platform() !== "win32") ok((statSync(file).mode & 0o077) === 0, "run 1: breaker.json is owner-only");
  ok(existsSync(join(ws, ".dev-loop", "team", "scheduler-build.json")), "run 1: breaker.json sits beside scheduler-build.json");

  // run 2: a restart RESUMES the open breaker (freshness judged by the NEW process's probe cadence)
  const r2 = runAgents([...base, "--breaker-probe", "60s", "--max-fires", "1"], ws, { DEVLOOP_CLAUDE_BIN: failBin });
  ok(r2.code === 0 && /breaker RESUMED from .*breaker\.json: pm \(\(unclassified tail #[0-9a-f]{8}\) ×2, last failure .* ago\)/.test(r2.out),
    `run 2: the restart resumes the OPEN breaker and says so in one line (${lineWith(r2.out, /breaker/)})`);
  ok(!/breaker OPEN: pm/.test(r2.out), "run 2: no fresh OPEN notice — it never closed");
  const f2 = readBreakerState(file);
  ok(f2?.agents.pm?.state === "open" && f2.agents.pm.consecutiveFailures === 3 && f2.scheduler.pid !== f1?.scheduler.pid,
    `run 2: the probe fire failed with the same tail ⇒ still OPEN, the streak continued to ×3 under the new pid (${JSON.stringify(f2?.agents.pm)})`);

  // run 3: --breaker-reset starts fresh
  const r3 = runAgents([...base, "--breaker-reset", "--max-fires", "1"], ws, { DEVLOOP_CLAUDE_BIN: failBin });
  ok(r3.code === 0 && /--breaker-reset — ignoring the persisted breaker state/.test(r3.out) && !/RESUMED/.test(r3.out), `run 3: --breaker-reset ignores the file and says so (${lineWith(r3.out, /breaker-reset/)})`);
  const f3 = readBreakerState(file);
  ok(f3?.agents.pm?.state === "closed" && f3.agents.pm.consecutiveFailures === 1, `run 3: one failure on a fresh breaker ⇒ closed ×1 (${JSON.stringify(f3?.agents.pm)})`);

  // run 4: an open entry older than the probe cadence is NOT resumed
  const stale: BreakerStateFile = { ...f3!, agents: { pm: { ...f3!.agents.pm, state: "open", consecutiveFailures: 5, openedAt: iso(Date.now() - 3_600_000), lastFailureAt: iso(Date.now() - 3_600_000) } } };
  writeBreakerState(file, stale);
  const r4 = runAgents([...base, "--breaker-probe", "5s", "--max-fires", "1"], ws, { DEVLOOP_CLAUDE_BIN: failBin });
  ok(r4.code === 0 && /breaker state not resumed for pm \(.*×5, last failure .* ago\) — older than the probe cadence 5s/.test(r4.out) && !/RESUMED/.test(r4.out),
    `run 4: a stale open entry is not resumed; one line says why (${lineWith(r4.out, /not resumed/)})`);
  ok(readBreakerState(file)?.agents.pm?.state === "closed", "run 4: that lane started fresh");

  // run 5: a LIVE scheduler — status reads the file (source live, half-open while the probe runs) and an
  // operator SIGTERM does not close the breaker (LOOP-155 on the team scheduler)
  const slowBin = join(tmp, "slow-claude.sh");
  writeFileSync(slowBin, "#!/bin/sh\ntrap 'echo interrupted; exit 0' INT TERM\necho started\nsleep 30 >/dev/null 2>&1 &\nwait $!\necho ok\nexit 0\n"); chmodSync(slowBin, 0o755);
  writeBreakerState(file, { ...stale, agents: { pm: { ...stale.agents.pm, openedAt: iso(Date.now() - 1000), lastFailureAt: iso(Date.now() - 1000) } } });
  const child = spawn("node", [join(hubRoot, "src", "run-agents.ts"), ...base, "--breaker-probe", "60s"], { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: slowBin }), stdio: ["ignore", "pipe", "pipe"] });
  let out5 = "";
  child.stdout.on("data", (d) => { out5 += d; }); child.stderr.on("data", (d) => { out5 += d; });
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let live: any = null;
  for (let i = 0; i < 80 && !live; i++) {
    await sleep(500);
    const s = status(ws);
    const b = s?.scheduler?.breakers;
    if (s?.scheduler?.pid === child.pid && b?.source === "live" && b.agents?.[0]?.state === "half-open") live = s;
  }
  ok(live !== null, `run 5: status reads the LIVE file from the running scheduler — source=live, pm half-open while its probe runs${live ? "" : ` (${out5.slice(-400)})`}`);
  if (live) {
    const b = live.scheduler.breakers;
    ok(b.threshold === 2 && b.probeMs === 60_000 && b.agents[0].streak === 5 && b.agents[0].probeInFlight === true && b.note === undefined && Math.abs(Date.parse(b.since) - Date.parse(live.scheduler.startedAt)) < 5000,
      `run 5: the live read carries the writer's flags, the resumed streak, the probe flag, no replay caveat, since ≈ the lock's startedAt (${JSON.stringify(b.agents[0])}, since ${b.since} vs lock ${live.scheduler.startedAt})`);
  }
  child.kill("SIGTERM");
  const code5 = await Promise.race([exited, sleep(25_000).then(() => "timeout" as const)]);
  ok(code5 === 0, `run 5: SIGTERM drains and exits 0 (${code5})${code5 === 0 ? "" : ` ${out5.slice(-400)}`}`);
  const f5 = readBreakerState(file);
  ok(f5?.agents.pm?.state === "open" && f5.agents.pm.consecutiveFailures === 5 && f5.scheduler.stoppedAt !== null,
    `run 5: the interrupted probe (exit 0 — OUR signal) did NOT close the breaker; the final snapshot says OPEN ×5 with stoppedAt (${JSON.stringify(f5?.agents.pm)})`);
  const rows = readFileSync(join(ws, ".dev-loop", "team", "fires.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { interrupted?: boolean; exitCode?: number; watchdog?: string | null });
  const last = rows[rows.length - 1];
  // The child's exit CODE is deliberately not asserted. It records who won the race between our forwarded
  // signal and the child installing its trap — under load the child dies ON the signal and exits non-zero,
  // which is still an operator stop. Pinning exitCode === 0 here asserted the child's cooperation, the very
  // thing LOOP-155's own comment says must not be the discriminator, and it is why this suite failed only
  // when the machine was busy. What the contract protects is the classification and its consequence: the
  // fire is flagged interrupted, no watchdog claimed it, and the breaker (asserted just above) learned
  // nothing from it.
  ok(last?.interrupted === true && last.watchdog === null,
    `run 5: the TEAM scheduler ledgers the killed fire as interrupted, whatever exit the child managed (${JSON.stringify(last)})`);
  const after = status(ws);
  ok(after?.scheduler?.breakers?.source === "replay" && typeof after.scheduler.breakers.note === "string", "run 5: with the scheduler gone the file is stale ⇒ status falls back to the replay and says so");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nBREAKER_STATE_OK");
process.exit(fails ? 1 : 0);
