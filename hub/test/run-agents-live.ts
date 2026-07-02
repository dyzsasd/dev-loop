// The scheduler's REAL (non --dry-run) execution path — previously 0% covered: every existing
// run-agents test passes --dry-run, so the spawn/env/log/timeout/drain/lock machinery that spends
// real API tokens in production never executed under test. A stub `claude` on DEVLOOP_CLAUDE_BIN
// stands in for the CLI: it records its env + argv, optionally sleeps, and marks completion.
import { spawnSync, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

  // ── 6. R1 change-gate: on a quiet board, a gated agent fires ONCE then skips (no re-spawn) ──
  const gateDb = join(tmp, "hub3.db");
  const gateData = join(tmp, "gate-data"); const gateOut = join(tmp, "gate-out");
  mkdirSync(gateData, { recursive: true }); mkdirSync(gateOut, { recursive: true });
  writeFileSync(join(gateData, "projects.json"), JSON.stringify({ projects: { gate: { repoPath: repo, backend: "service" } } }));
  execFileSync("node", ["src/seed.ts", "gate", "Gate Project", "GATEX", gateDb], { cwd: hubRoot, encoding: "utf8" });
  const runLoop = (extra: string[], outDir: string, sleepSec: string): number => {
    const child = spawn("node", ["src/run-agents.ts", "--root", repoRoot, "--data", gateData, "--hub-db", gateDb, "--project", "gate", "--cwd", repo, "--cli", "claude", "--agents", "pm", "--interval", "pm=1s", "--stagger", "0", ...extra],
      { cwd: hubRoot, stdio: "ignore", env: { ...process.env, DEVLOOP_CLAUDE_BIN: stub, STUB_OUT: outDir, DEVLOOP_RUN_DIR: tmp } });
    spawnSync("sleep", [sleepSec]);          // let it tick for the window
    child.kill("SIGTERM");
    spawnSync("sleep", ["1"]);               // let it drain/exit
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return readdirSync(outDir).filter((f) => f.startsWith("rec-")).length;
  };
  const gatedFires = runLoop(["--change-gate"], gateOut, "4.2");
  ok(gatedFires === 1, `change-gate: pm fires once then skips on a quiet board (fired ${gatedFires}× in ~4s @1s interval)`);
  const openOut = join(tmp, "open-out"); mkdirSync(openOut, { recursive: true });
  try { rmSync(join(gateData, "gate", "scheduler-gate.json")); } catch { /* fresh */ }
  const ungatedFires = runLoop([], openOut, "4.2");
  ok(ungatedFires >= 3, `no gate: pm fires every interval (fired ${ungatedFires}× in ~4s @1s interval)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_LIVE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
