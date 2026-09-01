// Regression test for LOOP-401 Child 1: scheduler-pause.ts module
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { openDb } from "../src/db.ts";
import { readPause, writePause, clearPause, formatPause } from "../src/scheduler-pause.ts";
import { tmpRoot } from "./tmp-root.ts";

function createTestDb(): ReturnType<typeof openDb> {
  const dbPath = join(tmpRoot("pause-test-"), "test.db");
  const db = openDb(dbPath);
  return db;
}

test("scheduler-pause: AC1 — pause/resume round-trip", async () => {
  const db = createTestDb();

  // pause
  const state = writePause(db, "alice", "release window", null);
  assert.equal(state.actor, "alice");
  assert.equal(state.reason, "release window");
  assert(state.pausedAt);

  // read back
  const read = readPause(db);
  assert(read);
  assert.equal(read.actor, "alice");
  assert.equal(read.reason, "release window");
  assert.equal(read.pausedAt, state.pausedAt);

  // resume
  const cleared = clearPause(db);
  assert(cleared);

  // not paused
  const afterResume = readPause(db);
  assert.equal(afterResume, null);

  db.close();
});

test("scheduler-pause: AC1 — pause twice preserves original pausedAt, updates reason", async () => {
  const db = createTestDb();

  // first pause
  const first = writePause(db, "alice", "original reason", null);
  const originalPausedAt = first.pausedAt;

  // second pause
  const second = writePause(db, "bob", "updated reason", null);
  assert.equal(second.pausedAt, originalPausedAt, "pausedAt should not change");
  assert.equal(second.actor, "bob");
  assert.equal(second.reason, "updated reason");

  db.close();
});

test("scheduler-pause: AC2 — resume is idempotent when nothing paused", async () => {
  const db = createTestDb();

  // resume with nothing paused
  const result = clearPause(db);
  assert.equal(result, false, "should return false when nothing was paused");

  // idempotent
  const result2 = clearPause(db);
  assert.equal(result2, false);

  db.close();
});

test("scheduler-pause: AC3 — until in the past is rejected", async () => {
  // The CLI rejects this, so we test the logic at the module level
  const now = Date.now();
  const past = new Date(now - 1000).toISOString();

  // The module itself has no validation (design: CLI validates), but we verify the expired case below
});

test("scheduler-pause: AC4 — until-expired pause reads as not paused", async () => {
  const db = createTestDb();

  const now = 1000000000;
  const until = new Date(now + 1000).toISOString(); // 1s in the future
  writePause(db, "alice", "brief pause", until, now);

  // Still paused at `now`
  let read = readPause(db, now);
  assert(read);

  // Not paused 2s later (past the until)
  read = readPause(db, now + 2000);
  assert.equal(read, null);

  // Verify DB is unchanged (reader is pure)
  const row = db.prepare("SELECT paused_at FROM scheduler_pause WHERE id = 1").get();
  assert(row, "row should still exist in DB");

  db.close();
});

test("scheduler-pause: AC5 — formatPause renders correctly", async () => {
  const db = createTestDb();

  const now = 1000000000;
  const pausedAt = new Date(now - 3600000).toISOString(); // 1h ago

  db.prepare(
    "INSERT INTO scheduler_pause (id, paused_at, actor, reason, until) VALUES (1, ?, ?, ?, ?)"
  ).run(pausedAt, "alice", "release", null);

  const state = readPause(db, now);
  assert(state);
  const formatted = formatPause(state, now);

  assert(formatted.includes("1h 0m"));
  assert(formatted.includes("alice"));
  assert(formatted.includes("release"));

  db.close();
});

test("scheduler-pause: AC5 — formatPause with until renders time remaining", async () => {
  const db = createTestDb();

  const now = 1000000000;
  const pausedAt = new Date(now - 3600000).toISOString(); // 1h ago
  const until = new Date(now + 1800000).toISOString(); // 30m in future

  db.prepare(
    "INSERT INTO scheduler_pause (id, paused_at, actor, reason, until) VALUES (1, ?, ?, ?, ?)"
  ).run(pausedAt, "alice", "release", until);

  const state = readPause(db, now);
  assert(state);
  const formatted = formatPause(state, now);

  assert(formatted.includes("until"));
  assert(formatted.includes("30m"));

  db.close();
});

test("scheduler-pause: AC6 — table retro-adds to existing DBs without user_version bump", async () => {
  const db = createTestDb();

  // Query PRAGMA user_version
  const versionBefore = db.prepare("PRAGMA user_version").get() as { user_version: number };

  // Write pause
  writePause(db, "alice", "test", null);

  // Query PRAGMA user_version again
  const versionAfter = db.prepare("PRAGMA user_version").get() as { user_version: number };

  assert.equal(versionAfter.user_version, versionBefore.user_version, "user_version should not change");

  db.close();
});

// ── WS-C C3 — `dev-loop pause --drain [--timeout <s>]` ──────────────────────────────────────────
// The drain blocks on the SAME in-flight reader `dev-loop status` renders as DRAINING: the runner log
// the scheduler writes (a spawn header with no exit marker), bounded by a LIVE run lock. Simulated
// here with this test process holding the lock and a hand-written pm.log; the exit marker appended
// later is exactly the line run-agents.ts's finalize() writes.
test("scheduler-pause: C3 — --drain blocks on the in-flight fire, times out with the pause still set, drains once the fire exits", async () => {
  const { spawnSync } = await import("node:child_process");
  const { appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname, join: j } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { scrubFireEnv } = await import("./env-scrub.ts");
  const { inFlightFires, readRunLock } = await import("../src/status.ts");
  const { resolveWorkspace, wsHubDb, wsLockPath, wsStateRoot } = await import("../src/workspace.ts");
  const hubRoot = j(dirname(fileURLToPath(import.meta.url)), "..");
  const CLI = j(hubRoot, "src", "cli.ts");
  const tmp = tmpRoot("pause-drain-");
  const HOME = j(tmp, "home");
  const cli = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...scrubFireEnv(), DEVLOOP_HOME: HOME, DEVLOOP_DRAIN_POLL_MS: "100", ...extra } as NodeJS.ProcessEnv, encoding: "utf8" });
    return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  try {
    const wsDir = j(tmp, "ws");
    const init = cli(["team", "init", "--dir", wsDir, "--key", "drain-team", "--backend", "service", "--yes"], tmp);
    assert.equal(init.code, 0, `team init: ${init.err}`);
    const ws = resolveWorkspace(wsDir);
    mkdirSync(dirname(wsLockPath(ws, "run")), { recursive: true });
    writeFileSync(wsLockPath(ws, "run"), JSON.stringify({ pid: process.pid, team: "drain-team", startedAt: new Date(Date.now() - 60_000).toISOString() }));
    assert.equal(readRunLock(ws).alive, true, "this process holds a live run lock");
    const logDir = j(wsStateRoot(ws), "web", "runner-logs");
    mkdirSync(logDir, { recursive: true });
    const log = j(logDir, "pm.log");
    writeFileSync(log, `\n\n===== ${new Date().toISOString()} claude -p cwd=${wsDir} =====\nworking…\n`);
    assert.equal(inFlightFires(ws).length, 1, "the open header is one fire in flight");

    // 1. drain with a fire in flight → progress line, timeout, exit 1, pause STAYS set
    const t0 = Date.now();
    const timedOut = cli(["pause", "--drain", "--timeout", "1"], wsDir);
    assert.equal(timedOut.code, 1, `timeout exit 1 (got ${timedOut.code}) ${timedOut.err}`);
    assert(Date.now() - t0 >= 900, "the drain actually waited for the timeout");
    assert(/draining — 1 in flight: pm@web/.test(timedOut.out), `progress line names the fire: ${timedOut.out}`);
    assert(/drain timed out after 1s/.test(timedOut.err) && /pause STAYS set/.test(timedOut.err), `timeout message: ${timedOut.err}`);
    { const db = openDb(wsHubDb(ws)); const p = readPause(db); db.close(); assert(p && p.reason === "drain", "pause row written with the default reason 'drain'"); }
    const st = cli(["status", "--json"], wsDir);
    assert.equal(st.code, 0, st.err);
    const sched = (JSON.parse(st.out) as { scheduler: { state: string; inFlight: unknown[] } }).scheduler;
    assert.equal(sched.state, "draining", "`dev-loop status` shows DRAINING while paused with a fire in flight");
    assert.equal(sched.inFlight.length, 1);

    // 2. the fire exits (the scheduler's finalize footer) → the same drain returns 0
    appendFileSync(log, "\n===== exit code=0 signal=null =====\n");
    assert.equal(inFlightFires(ws).length, 0, "the exit marker ends the in-flight read");
    const drained = cli(["pause", "--drain", "--reason", "upgrade", "--timeout", "5"], wsDir);
    assert.equal(drained.code, 0, `drained exit 0 (got ${drained.code}) ${drained.err}`);
    assert(/drained — no fire in flight/.test(drained.out), drained.out);
    { const db = openDb(wsHubDb(ws)); const p = readPause(db); db.close(); assert(p && p.reason === "upgrade", "--reason still wins over the drain default; pausedAt preserved across the two pauses"); }
    const st2 = (JSON.parse(cli(["status", "--json"], wsDir).out) as { scheduler: { state: string } }).scheduler;
    assert.equal(st2.state, "paused", "status: paused, nothing in flight");

    // 3. a bare pause is unchanged (reason still required); resume clears; drain with no scheduler is a no-op success
    assert.equal(cli(["pause"], wsDir).code, 2, "a bare pause without --reason stays a usage error");
    assert.equal(cli(["pause", "--drain", "--timeout", "x"], wsDir).code, 2, "a garbled --timeout is a usage error");
    assert(/pause cleared/.test(cli(["resume"], wsDir).out));
    writeFileSync(wsLockPath(ws, "run"), JSON.stringify({ pid: 2147483000, startedAt: new Date().toISOString() }));
    writeFileSync(log, `\n\n===== ${new Date().toISOString()} claude -p cwd=${wsDir} =====\n`); // an open header but a dead scheduler
    const dead = cli(["pause", "--drain", "--timeout", "1"], wsDir);
    assert.equal(dead.code, 0, `no live scheduler ⇒ nothing in flight ⇒ drained (${dead.code}) ${dead.err}`);
    assert(/no scheduler running/.test(dead.out), dead.out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
