// The scheduler's REAL (non --dry-run) execution path — previously 0% covered: every existing
// run-agents test passes --dry-run, so the spawn/env/log/timeout/drain/lock machinery that spends
// real API tokens in production never executed under test. A stub `claude` on DEVLOOP_CLAUDE_BIN
// stands in for the CLI: it records its env + argv, optionally sleeps, and marks completion.
import { spawnSync, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";
import { RETRY_LOOP_LINE_WINDOW } from "../src/seen-lines.ts";
import { EXIT_NO_WORK } from "../src/breaker.ts";      // LOOP-543: the outcome code a fire that produced nothing is ledgered under
import { openDb } from "../src/db.ts";                 // LOOP-144: seed servable rows to drive the queue-depth gate
import { findProject } from "../src/seed.ts";
import { insertTicket } from "../src/ticketwrite.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = tmpRoot("dl-run-live-");
try {
  const data = join(tmp, "data");
  const repo = join(tmp, "repo");
  const stubOut = join(tmp, "stub-out");
  for (const d of [data, repo, stubOut]) mkdirSync(d, { recursive: true });
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { demo: { repoPath: repo } } }));

  const stub = join(tmp, "stub-claude");
  writeFileSync(stub, `#!/bin/sh
rec="$STUB_OUT/rec-$$.txt"
{ echo "ACTOR=$DEVLOOP_ACTOR"; echo "PROJECT=$DEVLOOP_PROJECT"; echo "SPLIT=$DEVLOOP_DEV_SPLIT"; echo "NARGS=$#"; } > "$rec"
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
echo "COMPLETED" >> "$rec"
exit 0
`);
  chmodSync(stub, 0o755);

  const common = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "demo", "--cwd", repo, "--cli", "claude", "--agents", "pm"];
  const runLive = (args: string[], env: Record<string, string> = {}, timeout = 90_000) => {
    const r = spawnSync("node", ["src/run-agents.ts", ...args], {
      cwd: hubRoot, encoding: "utf8", timeout,
      env: { ...scrubFireEnv(), DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: stubOut, DEVLOOP_RUN_DIR: tmp, ...env },
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const recs = () => readdirSync(stubOut).filter((f) => f.startsWith("rec-")).map((f) => readFileSync(join(stubOut, f), "utf8"));
  const clearRecs = () => { for (const f of readdirSync(stubOut)) rmSync(join(stubOut, f)); };

  // ── 1. --once real fire: the stub actually spawns and receives per-fire identity env ──
  const once = runLive(["--once", ...common]);
  const r1 = recs();
  ok(once.code === 0, `--once real fire exits 0 (got ${once.code})`);
  ok(r1.length === 1 && /ACTOR=pm\n/.test(r1[0]) && /PROJECT=demo\n/.test(r1[0]),
    "the spawned CLI received DEVLOOP_ACTOR=pm + DEVLOOP_PROJECT=demo in its env");
  ok(r1.length === 1 && /COMPLETED/.test(r1[0]), "the fire ran to completion");
  ok(existsSync(join(data, "demo", "runner-logs", "pm.log")), "per-agent runner log was written");
  // Stream-lifecycle regression (field report P2-4, ×103): the stub prints nothing + exits 0, i.e. the
  // suspectError path — finalize's footer/suspect writes used to land on a stream the close handler had
  // already ended, losing the file tail of every fire as "write after end".
  ok(!/write after end/.test(once.out), "no 'runner-log write failed (write after end)' — finalize owns the stream end");
  const pmLog = readFileSync(join(data, "demo", "runner-logs", "pm.log"), "utf8");
  ok(/===== exit code=0/.test(pmLog), "the exit footer reaches the log file (used to be lost after end)");
  ok(/===== suspectError:/.test(pmLog), "the suspectError marker reaches the log file (used to be lost after end)");
  clearRecs();

  // ── 2. --max-fires drain: the Nth fire COMPLETES (the old stop() SIGINT'd the fire it just launched) ──
  const drain = runLive(["--max-fires", "1", "--stagger", "0", ...common], { STUB_SLEEP: "2" });
  const r2 = recs();
  ok(drain.code === 0 && /draining active fires/.test(drain.out), `--max-fires drains and exits 0 (got ${drain.code})`);
  ok(r2.length === 1 && /COMPLETED/.test(r2[0]),
    "the in-flight fire ran to completion during drain (was: SIGINT'd milliseconds after launch)");
  clearRecs();

  // ── 3. fire timeout: a wedged child is SIGTERM'd, the slot recovers, the loop exits by drain ──
  const t0 = Date.now();
  const timeoutRun = runLive(["--max-fires", "1", "--stagger", "0", "--fire-timeout", "1s", ...common], { STUB_SLEEP: "600" }, 60_000);
  const r3 = recs();
  ok(/fire exceeded 1s — SIGTERM/.test(timeoutRun.out), "a wedged fire logs the timeout escalation");
  ok(r3.length === 1 && !/COMPLETED/.test(r3[0]), "the wedged child was actually killed (no completion marker)");
  ok(Date.now() - t0 < 30_000, "the timeout path completes promptly (slot is not held for the child's full sleep)");
  clearRecs();

  // ── 4. run lock: a live holder blocks a second scheduler; a stale lock is taken over ──
  writeFileSync(join(tmp, "run-demo.lock"), JSON.stringify({ pid: process.pid, startedAt: "now" })); // alive: this test process
  const locked = runLive(["--max-fires", "1", "--stagger", "0", ...common]);
  ok(locked.code === 2 && /already running \(pid/.test(locked.out),
    "a second `dev-loop run` for the same project refuses to start while the lock holder is alive");
  writeFileSync(join(tmp, "run-demo.lock"), JSON.stringify({ pid: 99999999, startedAt: "then" })); // dead pid: stale
  const stale = runLive(["--max-fires", "1", "--stagger", "0", ...common]);
  ok(stale.code === 0 && /taking over stale run lock/.test(stale.out),
    "a stale lock (dead pid) is taken over and the run proceeds");
  ok(!existsSync(join(tmp, "run-demo.lock")), "the lock is released on exit");

  // ── 5. P1 telemetry: a real fire against a HUB-SEEDED project writes a fire.completed event ──
  const hubDb = join(tmp, "hub2.db");
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { tel: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "tel", "Tel Project", "TELX", hubDb], { cwd: hubRoot, encoding: "utf8" });
  const telCommon = ["--root", repoRoot, "--data", data, "--hub-db", hubDb, "--project", "tel", "--cwd", repo, "--cli", "claude", "--agents", "sweep", "--once"];
  const tel = runLive(telCommon);
  ok(tel.code === 0, `telemetry fire exits 0 (got ${tel.code})`);
  const rows = execFileSync("node", ["--input-type=module", "-e",
    `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${hubDb}'); const pid=findProject(db,'tel'); const r=db.prepare("SELECT actor,data FROM events WHERE project_id=? AND kind='fire.completed'").all(pid); process.stdout.write(JSON.stringify(r));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
  const events = JSON.parse(rows) as { actor: string; data: string }[];
  ok(events.length === 1 && events[0].actor === "sweep", "P1: one fire.completed event, attributed to the fired agent");
  const d = events.length ? JSON.parse(events[0].data) as Record<string, unknown> : {};
  // The stub prints nothing and exits 0 — deliberately, per §1 above, since its silence is what drives the
  // suspectError stream-lifecycle regression. LOOP-543 reclassifies exactly that fire: an exit-0 fire with an
  // empty tail produced no observable work, so the LEDGERED outcome is EXIT_NO_WORK rather than the child's
  // status byte (the same convention provider-env-missing's 4 and spawn-failed's 1 already follow). The
  // assertion's subject is the field SET fire.completed carries; pinning the symbol keeps it a contract check
  // rather than a magic number, and asserting 0 here would re-assert the behaviour this ticket removed.
  ok(d.codingAgent === "claude" && typeof d.durationMs === "number" && d.exitCode === EXIT_NO_WORK && d.timedOut === false,
    "P1: fire.completed carries codingAgent + durationMs + exitCode + timedOut");
  // LOOP-58 (was covered by run-agents.ts's now-removed recordFire import): the fire.completed event carries
  // the per-fire UUID fireId, asserted here on a REAL fire rather than a direct recordFire() call.
  ok(typeof d.fireId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.fireId as string),
    `LOOP-58: fire.completed event carries the per-fire UUID fireId (got ${JSON.stringify(d.fireId)})`);

  // ── 5b. P0-1b errorClass: a spend-limit-shaped failure is classified in the ledger/event ──
  const stubFail = join(tmp, "stub-claude-fail");
  writeFileSync(stubFail, `#!/bin/sh
echo "You've hit your monthly spend limit · raise it at claude.ai/settings/usage" >&2
exit 1
`);
  chmodSync(stubFail, 0o755);
  const telFail = runLive(telCommon, { DEVLOOP_CLAUDE_BIN: stubFail });
  ok(telFail.code === 1, `spend-limit fire propagates exit 1 (got ${telFail.code})`);
  const rows2 = execFileSync("node", ["--input-type=module", "-e",
    `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${hubDb}'); const pid=findProject(db,'tel'); const r=db.prepare("SELECT data FROM events WHERE project_id=? AND kind='fire.completed'").all(pid); process.stdout.write(JSON.stringify(r));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
  const datas = (JSON.parse(rows2) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  ok(datas.some((x) => x.errorClass === "spend-limit" && x.exitCode === 1),
    "P0-1b: the spend-limit failure carries errorClass:'spend-limit' in fire.completed");

  // ── 5c. P0-1a breaker: 3 identical failures trip to probe cadence; the first success closes ──
  // A counter stub fails with the SAME spend-limit line for runs 1-3, succeeds from run 4 — the exact
  // field shape (identical fast failures) followed by recovery (limit reset). Timeline @1s cadence,
  // probe 3s, max-fires 6: f1..f3 fail → OPEN → one probe wait → f4 succeeds → CLOSED → f5,f6 normal.
  const cnt = join(tmp, "flaky-count");
  const stubFlaky = join(tmp, "stub-claude-flaky");
  writeFileSync(stubFlaky, `#!/bin/sh
n=$(cat "$CNT_FILE" 2>/dev/null || echo 0); n=$((n+1)); printf '%s' "$n" > "$CNT_FILE"
if [ "$n" -le 3 ]; then echo "You've hit your monthly spend limit · raise it at claude.ai/settings/usage" >&2; exit 1; fi
echo "recovered run $n"
exit 0
`);
  chmodSync(stubFlaky, 0o755);
  const bt0 = Date.now();
  const brk = runLive([
    "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub4.db"), "--project", "demo", "--cwd", repo,
    "--cli", "claude", "--agents", "sweep", "--interval", "sweep=1s", "--stagger", "0",
    "--breaker", "3", "--breaker-probe", "3s", "--max-fires", "6",
  ], { DEVLOOP_CLAUDE_BIN: stubFlaky, CNT_FILE: cnt }, 120_000);
  // LOOP-175: spend-limit is provider-scoped (claude → anthropic), so OPEN/CLOSE name the provider blast radius.
  const openIdx = brk.out.indexOf("breaker OPEN: provider anthropic (spend-limit)");
  const closeIdx = brk.out.indexOf("breaker CLOSED: provider anthropic (spend-limit)");
  ok(openIdx >= 0 && /3× identical failures.*tripped by sweep/.test(brk.out), "P0-1a: 3 identical spend-limit failures trip the breaker (keyed on errorClass)");
  ok(closeIdx > openIdx, "P0-1a: the first successful probe fire closes the breaker (recovery notice after the open)");
  ok(readFileSync(cnt, "utf8") === "6", `P0-1a: all 6 fires ran — the breaker paces, it never strands the slot (got ${readFileSync(cnt, "utf8")})`);
  ok(brk.out.split("breaker OPEN").length === 2 && brk.out.split("breaker CLOSED").length === 2, "P0-1a: trip and recovery notify exactly ONCE each");
  ok(Date.now() - bt0 >= 3_000, "P0-1a: the probe wait actually elapsed (open slot ran slower than base cadence)");

  // ── 7. Process-group kill: a watchdog kill reaps all descendants, not just the direct child ──
  // The stub spawns a long-sleeping grandchild and writes its PID to a file.  After the fire-timeout
  // watchdog fires (and with detached:true signals the whole process group), the grandchild must be dead.
  const gcPidFile = join(tmp, "grandchild-pid");
  const stubGrandchild = join(tmp, "stub-grandchild");
  writeFileSync(stubGrandchild, `#!/bin/sh
sleep 600 &
echo $! > "$GRANDCHILD_PID_FILE"
echo "grandchild spawned"
sleep 600
`);
  chmodSync(stubGrandchild, 0o755);
  const gcRun = runLive(["--max-fires", "1", "--stagger", "0", "--fire-timeout", "2s", ...common],
    { DEVLOOP_CLAUDE_BIN: stubGrandchild, GRANDCHILD_PID_FILE: gcPidFile }, 30_000);
  const gcPid = existsSync(gcPidFile) ? readFileSync(gcPidFile, "utf8").trim() : "";
  ok(gcPid !== "", "grandchild stub wrote its PID");
  const gcAlive = spawnSync("kill", ["-0", gcPid]).status;
  ok(gcAlive !== 0, `grandchild (pid ${gcPid}) was reaped by the process-group kill`);

  // ── 8. Scheduler survives the group kill (it is NOT in the child's process group) ──
  // The fire-timeout run above proves it: if SIGTERM/SIGKILL had hit the scheduler, it would have
  // exited with a signal (code null), not code 0.
  ok(gcRun.code === 0, `scheduler survived the group kill of its fire (exit ${gcRun.code})`);

  // ── 9. Retry-loop detection: output keeps arriving but no NEW content → errorClass "retry-loop" ──
  // A stub that prints the same line every 0.5 s simulates a 429 retry loop that keeps the silence
  // watchdog from tripping. The liveness watchdog should detect the lack of new content and kill the
  // fire with errorClass "retry-loop" (not "stalled").
  const retryDb = join(tmp, "hub-retry.db");
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { tel: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "tel", "Tel Project", "TELX", retryDb], { cwd: hubRoot, encoding: "utf8" });
  const stubRetry = join(tmp, "stub-retry-loop");
  writeFileSync(stubRetry, `#!/bin/sh
while true; do
  echo "rate limit exceeded, retrying in 2s..."
  sleep 0.5
done
`);
  chmodSync(stubRetry, 0o755);
  const retryCommon = ["--root", repoRoot, "--data", data, "--hub-db", retryDb, "--project", "tel", "--cwd", repo, "--cli", "claude", "--agents", "sweep", "--once"];
  const retryRun = runLive([...retryCommon, "--stall-timeout", "3s"], { DEVLOOP_CLAUDE_BIN: stubRetry }, 60_000);
  ok(/retry-loop/.test(retryRun.out), "retry-loop watchdog fires when output keeps arriving but contains no new content");
  ok(!/stalled/.test(retryRun.out.replace(/silent retry loop/, "")), "retry-loop case does NOT report 'stalled' (distinct classification)");
  // Verify the errorClass reaches the fire ledger
  const retryRows = execFileSync("node", ["--input-type=module", "-e",
    `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${retryDb}'); const pid=findProject(db,'tel'); const r=db.prepare("SELECT data FROM events WHERE project_id=? AND kind='fire.completed'").all(pid); process.stdout.write(JSON.stringify(r));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
  const retryData = (JSON.parse(retryRows) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  ok(retryData.some((x) => x.errorClass === "retry-loop"), "retry-loop errorClass reaches the fire.completed ledger event");
  // Verify fireMetrics still parses retry-loop in byErrorClass — it is a free-form string dimension, so
  // no code change is needed; this assertion guards against a future whitelist regression.
  const metricsLedger = join(tmp, "fires-retry.jsonl");
  writeFileSync(metricsLedger, JSON.stringify({ ts: new Date().toISOString(), agent: "sweep", project: "tel", exitCode: 125, timedOut: false, errorClass: "retry-loop", durationMs: 5000 }) + "\n");
  const metricsOut = execFileSync("node", ["--input-type=module", "-e",
    `import {fireMetrics} from './src/metrics.ts'; process.stdout.write(JSON.stringify(fireMetrics('${metricsLedger}', 86400000)));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
  const metricsJson = JSON.parse(metricsOut) as { byErrorClass?: Record<string, number> };
  ok(typeof metricsJson.byErrorClass?.["retry-loop"] === "number",
    "retry-loop appears under byErrorClass in fireMetrics (free-form dimension — dev-loop metrics --json still parses)");

  // ── 10. Retry-loop detection survives a SATURATED line set (LOOP-23 regression) ──
  // Test 9 proves the mechanism from the first byte (the seen-set never fills). This proves the
  // REQUIREMENT: a fire that first streams far more distinct lines than the detector's window bound,
  // THEN enters a repeating loop, is STILL killed with errorClass "retry-loop". Against PR #27's
  // frozen-at-200 Set the loop's line is never in the frozen prefix, so every repeat counts as new
  // content and the fire is never killed — it hits the fire-timeout instead — so this test FAILS on
  // #27 (the regression proof); against the rolling window it trips at the first stall check (~15s).
  const satDb = join(tmp, "hub-saturated.db");
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { sat: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "sat", "Saturated Project", "SATX", satDb], { cwd: hubRoot, encoding: "utf8" });
  const distinctBeforeLoop = RETRY_LOOP_LINE_WINDOW * 3 + 50; // ≥ 3× the window bound, per the AC
  const stubSaturate = join(tmp, "stub-saturated-loop");
  writeFileSync(stubSaturate, `#!/bin/sh
i=0
while [ $i -lt ${distinctBeforeLoop} ]; do echo "distinct startup tool line $i saturating the window"; i=$((i+1)); done
while true; do
  echo "rate limit exceeded, retrying in 2s..."
  sleep 0.5
done
`);
  chmodSync(stubSaturate, 0o755);
  const satCommon = ["--root", repoRoot, "--data", data, "--hub-db", satDb, "--project", "sat", "--cwd", repo, "--cli", "claude", "--agents", "sweep", "--once"];
  // --fire-timeout caps the #27 regression case so it exits at 30s instead of hanging; the rolling
  // window trips the retry-loop watchdog well before that (first stall check ~15s).
  const satRun = runLive([...satCommon, "--stall-timeout", "3s", "--fire-timeout", "30s"], { DEVLOOP_CLAUDE_BIN: stubSaturate }, 60_000);
  ok(/retry-loop/.test(satRun.out), "retry-loop is detected AFTER the seen-line window saturated (the frozen-200 detector missed this)");
  const satRows = execFileSync("node", ["--input-type=module", "-e",
    `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${satDb}'); const pid=findProject(db,'sat'); const r=db.prepare("SELECT data FROM events WHERE project_id=? AND kind='fire.completed'").all(pid); process.stdout.write(JSON.stringify(r));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
  const satData = (JSON.parse(satRows) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  ok(satData.some((x) => x.errorClass === "retry-loop"), "the saturated-then-looping fire records errorClass \"retry-loop\" in the ledger");
  // LOOP-346 — the class must reach the HUMAN too, not only the ledger. `satRun.out` is captured
  // through a PIPE, and `process.exit()` discards whatever is still queued for an async stdio target:
  // the ledger row was written correctly while this line was dropped, so a captured run read as
  // though the fire ended silently. It survived only when the pipe happened to drain first, which is
  // why it passed on CI and failed on a loaded workstation. Assert the line itself, not just the row.
  ok(/sweep: exit .*\(retry-loop\)/.test(satRun.out),
    "LOOP-346: the fire's exit line reaches CAPTURED stdout carrying the class — process.exit() must not drop it");

  // ── 11. No false positive: genuinely-new content then quiet trips "stalled", never "retry-loop" ──
  // The rolling window must never turn slow-but-healthy output into a false loop. A fire that emits
  // genuinely-new distinct lines and then goes silent must classify as "stalled" (silence), never
  // "retry-loop": `looping` requires !silent, so once output stops the watchdog sees silence, not a loop.
  const slowDb = join(tmp, "hub-slow.db");
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { slow: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "slow", "Slow Project", "SLOWX", slowDb], { cwd: hubRoot, encoding: "utf8" });
  const stubSlow = join(tmp, "stub-slow-healthy");
  writeFileSync(stubSlow, `#!/bin/sh
i=0
while [ $i -lt 5 ]; do echo "healthy progress step $i (genuinely new content)"; i=$((i+1)); sleep 0.3; done
sleep 600
`);
  chmodSync(stubSlow, 0o755);
  const slowCommon = ["--root", repoRoot, "--data", data, "--hub-db", slowDb, "--project", "slow", "--cwd", repo, "--cli", "claude", "--agents", "sweep", "--once"];
  const slowRun = runLive([...slowCommon, "--stall-timeout", "3s"], { DEVLOOP_CLAUDE_BIN: stubSlow }, 60_000);
  ok(/stalled/.test(slowRun.out) && !/retry-loop/.test(slowRun.out.replace(/silent retry loop/g, "")),
    "genuinely-new-then-quiet fire classifies as stalled, never retry-loop");
  const slowRows = execFileSync("node", ["--input-type=module", "-e",
    `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${slowDb}'); const pid=findProject(db,'slow'); const r=db.prepare("SELECT data FROM events WHERE project_id=? AND kind='fire.completed'").all(pid); process.stdout.write(JSON.stringify(r));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
  const slowData = (JSON.parse(slowRows) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  ok(slowData.some((x) => x.errorClass === "stalled") && !slowData.some((x) => x.errorClass === "retry-loop"),
    "the slow-but-healthy fire records \"stalled\", never \"retry-loop\"");

  // ── 6. R1 change-gate: on a quiet board, a gated agent fires ONCE then skips (no re-spawn) ──
  const gateDb = join(tmp, "hub3.db");
  const gateData = join(tmp, "gate-data"); const gateOut = join(tmp, "gate-out");
  mkdirSync(gateData, { recursive: true }); mkdirSync(gateOut, { recursive: true });
  writeFileSync(join(gateData, "projects.json"), JSON.stringify({ projects: { gate: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "gate", "Gate Project", "GATEX", gateDb], { cwd: hubRoot, encoding: "utf8" });
  // LOOP-32: the interval is now a parameter (default 1s) so gated tests can use 3s to eliminate the
  // startup-race: with 1s interval, if Node startup exceeds 1s the 2nd tick fires before the gate state
  // is written from fire 1 (intermittent on loaded CI / Node 23.6.0). At 3s there is >2s margin.
  // LOOP-32: DEVLOOP_PROJECTS_JSON is explicitly pinned to the test's projects.json so a dev-loop session
  // environment (where DEVLOOP_PROJECTS_JSON points to the real workspace) can't override readProjects().
  // Without this, backend comes back undefined (gate project not in real config) → gateActive=false.
  const runLoop = (extra: string[], outDir: string, sleepSec: string, agent = "pm", interval = "1s"): number => {
    const child = spawn("node", ["src/run-agents.ts", "--root", repoRoot, "--data", gateData, "--hub-db", gateDb, "--project", "gate", "--cwd", repo, "--cli", "claude", "--agents", agent, "--interval", `${agent}=${interval}`, "--stagger", "0", ...extra],
      { cwd: hubRoot, stdio: "ignore", env: { ...scrubFireEnv(), DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: outDir, DEVLOOP_RUN_DIR: tmp, DEVLOOP_PROJECTS_JSON: join(gateData, "projects.json") } });
    spawnSync("sleep", [sleepSec]);          // let it tick for the window
    child.kill("SIGTERM");
    spawnSync("sleep", ["1"]);               // let it drain/exit
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return readdirSync(outDir).filter((f) => f.startsWith("rec-")).length;
  };
  const gatedFires = runLoop(["--change-gate"], gateOut, "4.2", "pm", "3s");
  ok(gatedFires === 1, `change-gate: pm fires once then skips on a quiet board (fired ${gatedFires}× @3s interval)`);
  const openOut = join(tmp, "open-out"); mkdirSync(openOut, { recursive: true });
  try { rmSync(join(gateData, "gate", "scheduler-gate.json")); } catch { /* fresh */ }
  // LOOP-32: use --max-fires 3 so the loop exits after exactly 3 fires (deterministic); the old
  // wall-clock window ("6.5s") was fragile on loaded CI — startup overhead on Node 23.6.0 caused
  // only 2 fires to fit, failing the >= 3 assertion intermittently.
  spawnSync("node", ["src/run-agents.ts", "--root", repoRoot, "--data", gateData, "--hub-db", gateDb, "--project", "gate", "--cwd", repo, "--cli", "claude", "--agents", "pm", "--interval", "pm=1s", "--stagger", "0", "--max-fires", "3"],
    { cwd: hubRoot, stdio: "ignore", timeout: 30_000, env: { ...scrubFireEnv(), DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: openOut, DEVLOOP_RUN_DIR: tmp, DEVLOOP_PROJECTS_JSON: join(gateData, "projects.json") } });
  const ungatedFires = readdirSync(openOut).filter((f) => f.startsWith("rec-")).length;
  ok(ungatedFires === 3, `no gate: pm fires on every tick (exactly ${ungatedFires}/3 with --max-fires 3)`);

  // ── 6a. R1a review-tier TTL: pm/qa do their best work on a QUIET board (lens rotation / coverage
  //    expansion), so an unchanged key only DEFERS them — once the quiet-board TTL elapses since the
  //    last fire, the gate lets ONE through, which re-arms it. dev tier keeps the pure gate. ──
  const gateFile = join(gateData, "gate", "scheduler-gate.json");
  const seedOut = join(tmp, "seed-out"); mkdirSync(seedOut, { recursive: true });
  runLoop(["--change-gate"], seedOut, "4.2", "pm", "3s");        // re-seed pm gate state (deleted above); 4.2s window ensures the 3s-interval tick fires and writes the gate file
  {
    const st = JSON.parse(readFileSync(gateFile, "utf8")) as Record<string, { key: string; firedAt: number }>;
    ok(typeof st.pm === "object" && typeof st.pm.key === "string" && typeof st.pm.firedAt === "number",
      "gate state records the change-key + firedAt (the R1a TTL anchor)");
    st.pm.firedAt = Date.now() - 5 * 60 * 60_000;              // past the default 4h TTL; the board stays quiet
    writeFileSync(gateFile, JSON.stringify(st));
  }
  const ttlOut = join(tmp, "ttl-out"); mkdirSync(ttlOut, { recursive: true });
  const ttlFires = runLoop(["--change-gate"], ttlOut, "4.2", "pm", "3s");
  ok(ttlFires === 1, `change-gate TTL: a pm past the quiet-board TTL fires ONCE then re-arms (fired ${ttlFires}×)`);

  // ── 6b. legacy state (pre-TTL bare key string) reads as firedAt:0 ⇒ the next pm review fire runs ──
  {
    const st = JSON.parse(readFileSync(gateFile, "utf8")) as Record<string, { key: string; firedAt: number }>;
    writeFileSync(gateFile, JSON.stringify({ pm: st.pm.key }));  // the pre-TTL on-disk shape
  }
  const legacyOut = join(tmp, "legacy-out"); mkdirSync(legacyOut, { recursive: true });
  const legacyFires = runLoop(["--change-gate"], legacyOut, "4.2", "pm", "3s");
  ok(legacyFires === 1, `change-gate TTL: a pre-TTL bare-string gate state lets the next pm fire run (fired ${legacyFires}×)`);

  // ── 6c. --change-gate-ttl 0 = defer forever: the pure gate applies to pm too ──
  {
    const st = JSON.parse(readFileSync(gateFile, "utf8")) as Record<string, { key: string; firedAt: number }>;
    st.pm.firedAt = Date.now() - 5 * 60 * 60_000;
    writeFileSync(gateFile, JSON.stringify(st));
  }
  const ttl0Out = join(tmp, "ttl0-out"); mkdirSync(ttl0Out, { recursive: true });
  const ttl0Fires = runLoop(["--change-gate", "--change-gate-ttl", "0"], ttl0Out, "4.2", "pm", "3s");
  ok(ttl0Fires === 0, `--change-gate-ttl 0 keeps the pure gate for pm (fired ${ttl0Fires}×, expected 0)`);

  // ── 6d. the dev tier keeps the PURE gate: an aged senior-dev entry still skips ──
  // LOOP-144: the dev-tier queue-depth gate now skips a senior-dev fire whose servable slice is empty, so this
  // change-gate test must give senior-dev real work first — otherwise it never fires and never seeds the gate
  // entry the aging assertion below depends on. (The queue-gate itself is exercised in §6e.)
  { const gdb = openDb(gateDb); const gpid = findProject(gdb, "gate");
    insertTicket(gdb, gpid as string, "pm", { title: "sd change-gate work", description: "", type: "Improvement",
      state: "Todo" as never, assignee: "senior-dev", priority: 3, labels: ["dev-loop", "senior-dev"],
      duplicateOf: null, relatedTo: [] }, { title: "sd change-gate work", type: "Improvement" }); gdb.close(); }
  const sdSeedOut = join(tmp, "sd-seed-out"); mkdirSync(sdSeedOut, { recursive: true });
  const sdSeed = runLoop(["--change-gate"], sdSeedOut, "4.2", "senior-dev", "3s");
  ok(sdSeed === 1, `senior-dev under the gate fires once on first run (fired ${sdSeed}×)`);
  {
    const st = JSON.parse(readFileSync(gateFile, "utf8")) as Record<string, { key: string; firedAt: number }>;
    st["senior-dev"].firedAt = Date.now() - 5 * 60 * 60_000;    // aged far past the TTL — must NOT matter
    writeFileSync(gateFile, JSON.stringify(st));
  }
  const sdOut = join(tmp, "sd-out"); mkdirSync(sdOut, { recursive: true });
  const sdFires = runLoop(["--change-gate"], sdOut, "4.2", "senior-dev", "3s");
  ok(sdFires === 0, `the dev tier keeps the PURE gate — an aged senior-dev entry still skips (fired ${sdFires}×, expected 0)`);

  // ── 6e. LOOP-144 dev-tier queue-depth gate: an EMPTY servable slice skips the launch (distinct reason logged,
  //    never a silent skip); an own In Progress row STILL fires (the Step-0 orphan-resume path — the assertion
  //    that stops this optimisation from becoming a starvation bug). Fresh project so the empty-slice case is
  //    deterministic, independent of §6's gate-project state. ──────────────────────────────────────────────────
  const qgDb = join(tmp, "qgate.db"); const qgData = join(tmp, "qgate-data"); mkdirSync(qgData, { recursive: true });
  writeFileSync(join(qgData, "projects.json"), JSON.stringify({ projects: { qg: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "qg", "Queue Gate", "QGATE", qgDb], { cwd: hubRoot, encoding: "utf8" });
  const runQg = (outDir: string): { fires: number; out: string } => {
    mkdirSync(outDir, { recursive: true });
    // Redirect the scheduler's stdout/stderr to a FILE, not a pipe: this test blocks the event loop on
    // spawnSync("sleep"), so async pipe "data" callbacks would never fire — a file descriptor is written by the
    // kernel regardless of the parent's event loop, exactly like the rec-* fire files this harness already reads.
    const logFile = join(outDir, "sched.log"); const fd = openSync(logFile, "w");
    const child = spawn("node", ["src/run-agents.ts", "--root", repoRoot, "--data", qgData, "--hub-db", qgDb, "--project", "qg", "--cwd", repo, "--cli", "claude", "--agents", "senior-dev", "--interval", "senior-dev=3s", "--stagger", "0", "--change-gate"],
      { cwd: hubRoot, stdio: ["ignore", fd, fd], env: { ...scrubFireEnv(), DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: outDir, DEVLOOP_RUN_DIR: tmp, DEVLOOP_PROJECTS_JSON: join(qgData, "projects.json") } });
    spawnSync("sleep", ["4.2"]);
    child.kill("SIGTERM"); spawnSync("sleep", ["1"]); try { child.kill("SIGKILL"); } catch { /* already gone */ }
    closeSync(fd);
    return { fires: readdirSync(outDir).filter((f) => f.startsWith("rec-")).length, out: readFileSync(logFile, "utf8") };
  };
  // (a) empty servable slice ⇒ NO fire, and a DISTINCT reason logged (a silent skip is indistinguishable from a crash)
  const qgEmpty = runQg(join(tmp, "qg-empty"));
  ok(qgEmpty.fires === 0, `LOOP-144: senior-dev with an empty servable slice does NOT fire (fired ${qgEmpty.fires}×, expected 0)`);
  ok(/\[senior-dev\] skipped: queue empty \(0 servable Todo, 0 In Progress(, 0 In Review)?\)/.test(qgEmpty.out),
    "LOOP-144: the queue-empty skip logs a distinct, non-silent reason (not a change-gate skip)");
  // (b) own In Progress ⇒ STILL fires — orphan-resume preserved (the load-bearing anti-starvation assertion)
  { const qdb = openDb(qgDb); const qpid = findProject(qdb, "qg");
    insertTicket(qdb, qpid as string, "pm", { title: "sd wip", description: "", type: "Improvement",
      state: "In Progress" as never, assignee: "senior-dev", priority: 3, labels: ["dev-loop", "senior-dev"],
      duplicateOf: null, relatedTo: [] }, { title: "sd wip", type: "Improvement" }); qdb.close(); }
  const qgWip = runQg(join(tmp, "qg-wip"));
  ok(qgWip.fires >= 1, `LOOP-144: senior-dev with an own In Progress row STILL fires — orphan-resume preserved (fired ${qgWip.fires}×, expected ≥1)`);

  // ── 7. LOOP-85: the opencode lane END-TO-END on a REAL fire (a stub `opencode` streaming JSONL). The two
  //    defects the ticket escalated are structural, so only a real fire proves them: (a) operator-visible
  //    output SURVIVES — opencode STREAMS its --format json events, and because opencodeAdapter has no
  //    resultText the runner never defers the echo, so the readable lines reach console + run.log as they
  //    arrive (LOOP-14 routed opencode into the structured branch and suppressed the whole stream); (b) the
  //    tail-regex suspectError fallback is KEPT, additive to the adapter's structured isError. ──
  const ocStub = join(tmp, "stub-opencode");
  const ocDb = join(tmp, "hub-oc.db");
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { oc: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "oc", "OC Project", "OCX", ocDb], { cwd: hubRoot, encoding: "utf8" });
  const ocCommon = ["--root", repoRoot, "--data", data, "--hub-db", ocDb, "--project", "oc", "--cwd", repo, "--cli", "opencode", "--agents", "sweep", "--once"];
  const ocSweepLog = join(data, "oc", "runner-logs", "sweep.log");
  const latestFireData = (): Record<string, unknown> => {
    const rows = execFileSync("node", ["--input-type=module", "-e",
      `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${ocDb}'); const pid=findProject(db,'oc'); const r=db.prepare("SELECT data FROM events WHERE project_id=? AND kind='fire.completed' ORDER BY rowid DESC LIMIT 1").all(pid); process.stdout.write(JSON.stringify(r));`],
      { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
    const arr = JSON.parse(rows) as { data: string }[];
    return arr.length ? (JSON.parse(arr[0].data) as Record<string, unknown>) : {};
  };
  const ocFire = (body: string) => {
    writeFileSync(ocStub, `#!/bin/sh\n${body}\n`);
    chmodSync(ocStub, 0o755);
    rmSync(ocSweepLog, { force: true }); // fresh log per fire — the output-survival assertion reads only THIS fire
    const run = runLive(ocCommon, { DEVLOOP_OPENCODE_BIN: ocStub });
    return { run, data: latestFireData(), log: existsSync(ocSweepLog) ? readFileSync(ocSweepLog, "utf8") : "" };
  };

  // 7a. happy multi-line JSONL fire: output survives (console + run.log) AND usage is captured from part.tokens.
  const happy = ocFire([
    `echo '{"type":"step_start","part":{"type":"step-start"}}'`,
    `echo '{"type":"text","part":{"type":"text","text":"hello from opencode."}}'`,
    `echo '{"type":"step_finish","part":{"type":"step-finish","cost":0,"tokens":{"total":123,"input":111,"output":12,"cache":{"read":4,"write":2}}}}'`,
    `exit 0`,
  ].join("\n"));
  ok(happy.run.code === 0, `LOOP-85: opencode --format json fire exits 0 (got ${happy.run.code})`);
  ok(/hello from opencode\./.test(happy.run.out), "LOOP-85 AC: the readable line activity reaches the CONSOLE echo live (stream not suppressed)");
  ok(/hello from opencode\./.test(happy.log) && /step_finish/.test(happy.log), "LOOP-85 AC: the JSONL line activity reaches run.log (multi-line buffer) — output survives on the JSONL lane");
  ok(happy.data.codingAgent === "opencode", "LOOP-85: fire.completed attributes the opencode lane");
  {
    const u = happy.data.usage as Record<string, unknown> | undefined;
    ok(!!u && u.source === "provider" && u.inputTokens === 111 && u.outputTokens === 12, "LOOP-85 AC: fire.completed.usage captured end-to-end from the real JSONL stream (input 111 / output 12)");
    ok(!!u && u.cacheReadTokens === 4 && u.cacheWriteTokens === 2 && u.costUsd === 0 && u.currency === "USD", "LOOP-85 AC: cache split + cost captured from part.tokens.cache / part.cost");
    ok(!happy.data.suspectError, "LOOP-85: a healthy opencode fire is NOT flagged suspectError (no false positive)");
  }

  // 7b. TRUNCATED stream: the final usage line is cut mid-JSON. Earlier readable output STILL survives in
  //     run.log, usage degrades to null (honest miss, never a partial row), and the fire does not crash.
  const truncated = ocFire([
    `echo '{"type":"text","part":{"type":"text","text":"line one visible"}}'`,
    `printf '{"type":"step_finish","part":{"tokens":{"inp'`,
    `exit 0`,
  ].join("\n"));
  ok(truncated.run.code === 0, "LOOP-85 AC: a truncated-stream fire still exits normally (parse is best-effort, non-fatal)");
  ok(/line one visible/.test(truncated.log), "LOOP-85 AC: on a TRUNCATED buffer the earlier readable lines still survive in run.log");
  ok(truncated.data.usage === undefined, "LOOP-85 AC: a truncated usage line → NO usage field (honest miss, not a partial/wrong row)");

  // 7c. suspectError fallback KEPT: exit-0 opencode fire printing "Execution error" → flagged via the
  //     tail-regex (NOT the adapter's isError — that owns only the structured signal). This is the exact
  //     regression the ticket escalated: LOOP-14's wiring replaced the tail-regex, so this recorded healthy.
  const execErr = ocFire(`echo 'Execution error'\nexit 0`);
  ok(execErr.data.suspectError === true, "LOOP-85 AC: exit-0 opencode fire emitting 'Execution error' → suspectError (tail-regex fallback kept)");
  // 7d. empty output (exit 0) → suspectError via the empty-output arm.
  const empty = ocFire(`exit 0`);
  ok(empty.data.suspectError === true, "LOOP-85 AC: exit-0 opencode fire with NO output → suspectError (empty-output arm)");
  // 7e. a structured type:"error" event (exit 0) → suspectError via the adapter's isError, additively.
  const structErr = ocFire([
    `echo '{"type":"step_start","part":{"type":"step-start"}}'`,
    `echo '{"type":"error","part":{"message":"provider 429 quota"}}'`,
    `exit 0`,
  ].join("\n"));
  ok(structErr.data.suspectError === true, "LOOP-85 AC: exit-0 opencode fire streaming a type:'error' event → suspectError (adapter isError, on top of the tail-regex)");

  // ── 8. WS-A C4 review 1: the codex lane on a REAL fire (a stub `codex` on DEVLOOP_CODEX_BIN). Three
  //    contracts: (a) EVERY codex fire carries --skip-git-repo-check (it only lifts codex's non-git-cwd
  //    startup refusal; a steward's cwd is the workspace root) and, on the SAFE default, NO
  //    --dangerously-bypass-approvals-and-sandbox; (b) a codex fire that prints NOTHING and exits 0 is
  //    ledgered EXIT_NO_WORK / "no-output" — the LOOP-543 arm stays honest on this lane; (c) the honest
  //    LIMIT of that arm: a real SAFE fire whose write-shaped tool calls were refused still streams its JSONL
  //    and exits 0, so it records as a SUCCESS. (c) is the reason doctor W45 and the scheduler-start NOTICE
  //    exist; pinning it here keeps the docs from claiming the breaker catches a dead SAFE lane. ──
  const cxStub = join(tmp, "stub-codex");
  const cxDb = join(tmp, "hub-cx.db");
  const cxArgv = join(tmp, "codex-argv.txt");
  writeFileSync(join(data, "projects.json"), JSON.stringify({ projects: { cx: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "cx", "CX Project", "CXX", cxDb], { cwd: hubRoot, encoding: "utf8" });
  const cxCommon = ["--root", repoRoot, "--data", data, "--hub-db", cxDb, "--project", "cx", "--cwd", repo, "--cli", "codex", "--agents", "sweep", "--once"];
  const cxFireData = (): Record<string, unknown> => {
    const rows = execFileSync("node", ["--input-type=module", "-e",
      `import {openDb} from './src/db.ts'; import {findProject} from './src/seed.ts'; const db=openDb('${cxDb}'); const pid=findProject(db,'cx'); const r=db.prepare("SELECT data FROM events WHERE project_id=? AND kind='fire.completed' ORDER BY rowid DESC LIMIT 1").all(pid); process.stdout.write(JSON.stringify(r));`],
      { cwd: hubRoot, encoding: "utf8", env: { ...scrubFireEnv() } });
    const arr = JSON.parse(rows) as { data: string }[];
    return arr.length ? (JSON.parse(arr[0].data) as Record<string, unknown>) : {};
  };
  const cxFire = (body: string, extraArgs: string[] = []) => {
    // The stub records its argv one-per-line (the flag contract is read from what codex would have SEEN),
    // drains stdin (the prompt rides `codex exec -`), then runs the body.
    writeFileSync(cxStub, `#!/bin/sh\nprintf '%s\\n' "$@" > "$CX_ARGV"\ncat >/dev/null\n${body}\n`);
    chmodSync(cxStub, 0o755);
    rmSync(cxArgv, { force: true });
    const run = runLive([...cxCommon, ...extraArgs], { DEVLOOP_CODEX_BIN: cxStub, CX_ARGV: cxArgv });
    const argv = existsSync(cxArgv) ? readFileSync(cxArgv, "utf8").split("\n") : [];
    return { run, data: cxFireData(), argv };
  };
  // 8a. the SAFE default: a silent exit-0 fire. Flags + the LOOP-543 classification.
  const cxSilent = cxFire("exit 0");
  ok(cxSilent.argv[0] === "exec" && cxSilent.argv.includes("--skip-git-repo-check"),
    "C4 review 1: a SAFE codex fire still carries --skip-git-repo-check (the flag is independent of the sandbox choice)");
  ok(!cxSilent.argv.includes("--dangerously-bypass-approvals-and-sandbox"),
    "C4 review 1: a SAFE codex fire carries NO --dangerously-bypass-approvals-and-sandbox");
  ok(/dev-loop run: NOTICE codex sandbox=safe \(default\) for sweep/.test(cxSilent.run.out) && /doctor W45/.test(cxSilent.run.out),
    "C4 review 1: a REAL run on the default prints the one-line scheduler-start NOTICE naming doctor W45");
  ok(cxSilent.data.codingAgent === "codex" && cxSilent.data.exitCode === EXIT_NO_WORK && cxSilent.data.errorClass === "no-output",
    `LOOP-543 on the codex lane: a stub codex that prints nothing and exits 0 is ledgered EXIT_NO_WORK / "no-output" (got exit ${cxSilent.data.exitCode}, class ${cxSilent.data.errorClass})`);
  // 8b. --codex-unsafe: the bypass flag rides, adjacent to --skip-git-repo-check (the pre-WS-A shape).
  const cxUnsafe = cxFire("exit 0", ["--codex-unsafe"]);
  const bypassAt = cxUnsafe.argv.indexOf("--dangerously-bypass-approvals-and-sandbox");
  ok(bypassAt >= 0 && cxUnsafe.argv[bypassAt + 1] === "--skip-git-repo-check",
    "C4 review 1: --codex-unsafe restores --dangerously-bypass-approvals-and-sandbox immediately before --skip-git-repo-check");
  ok(/dev-loop run: codex sandbox=bypass \(--codex-unsafe\) for sweep/.test(cxUnsafe.run.out) && !/NOTICE codex sandbox/.test(cxUnsafe.run.out),
    "C4 review 1: an explicit posture prints the plain start line, not the NOTICE");
  // 8c. THE LIMIT, pinned: a SAFE fire whose tool calls were refused still streams codex's JSONL and exits 0.
  //     The ledger records a success — exit 0, no errorClass, no suspectError. Nothing in the fire-record
  //     path can tell this apart from a fire that landed work, which is exactly why W45 warns from CONFIG.
  const cxRefused = cxFire([
    `echo '{"type":"thread.started","thread_id":"t1"}'`,
    `echo '{"type":"item.completed","item":{"type":"agent_message","text":"I could not commit: the sandbox denied the write and no approval path exists."}}'`,
    `echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}'`,
    `exit 0`,
  ].join("\n"));
  ok(cxRefused.data.exitCode === 0 && cxRefused.data.errorClass === undefined && !cxRefused.data.suspectError,
    `C4 review 1 (the honest limit): a SAFE codex fire that streamed JSONL and exited 0 after its writes were refused records as a SUCCESS (exit ${cxRefused.data.exitCode}, class ${cxRefused.data.errorClass}) — the breaker cannot see a dead SAFE lane; doctor W45 can`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_LIVE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
