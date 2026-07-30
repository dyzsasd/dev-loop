// The scheduler's REAL (non --dry-run) execution path — previously 0% covered: every existing
// run-agents test passes --dry-run, so the spawn/env/log/timeout/drain/lock machinery that spends
// real API tokens in production never executed under test. A stub `claude` on DEVLOOP_CLAUDE_BIN
// stands in for the CLI: it records its env + argv, optionally sleeps, and marks completion.
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
  ok(openIdx >= 0 && /3× identical failures \(spend-limit\)/.test(brk.out), "P0-1a: 3 identical spend-limit failures trip the breaker (keyed on errorClass)");
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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_LIVE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
