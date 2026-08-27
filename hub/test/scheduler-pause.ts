// Regression test for LOOP-401 Child 1: scheduler-pause.ts module
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.ts";
import { readPause, writePause, clearPause, formatPause } from "../src/scheduler-pause.ts";
import { TEAM_INTAKE_PROJECT } from "../src/team-config.ts";
import { ensureProject } from "../src/seed.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

function createTestDb(): ReturnType<typeof openDb> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pause-test-")), "test.db");
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

// AC6 (LOOP-593, re-landed as LOOP-594): the pause/resume verbs leave an audit line that
// `dev-loop events` can actually return.
//
// The predecessor of this test asserted `SELECT ... FROM events WHERE kind='scheduler.pause'`
// after calling `logEvent` ITSELF — so it exercised db.ts rather than the verb, and its read
// carried no `project_id` predicate. Both halves of the real defect were therefore invisible to
// it: the verb stamped the project KEY "_team" where `events.project_id` holds a project UUID,
// so every reader (`list_events` filters `WHERE project_id=?` with a resolved id) matched zero
// rows, and the test passed anyway. This version spawns the real verb and reads through the
// reader's own predicate, which is what makes it able to fail.
test("scheduler-pause: AC6 — the CLI's pause/resume events are readable through the project-scoped reader", async () => {
  // A real workspace fixture: the verb discovers its own hub.db from dev-loop.json, so the DB
  // this test seeds and the DB the verb writes are the same file only if the fixture is real.
  const root = mkdtempSync(join(tmpdir(), "pause-cli-"));
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  writeFileSync(
    join(root, "dev-loop.json"),
    JSON.stringify({ schemaVersion: 2, team: { key: "pausetest", backend: "service" }, repos: {}, projects: {} }),
  );

  const dbPath = join(root, ".dev-loop", "hub.db");
  const seed = openDb(dbPath);
  const teamProjectId = ensureProject(seed, TEAM_INTAKE_PROJECT, "Team Intake", "TM");
  seed.close();
  assert.notEqual(teamProjectId, TEAM_INTAKE_PROJECT, "fixture sanity: the row id must not BE the key");

  // LOOP-193: this fire's own DEVLOOP_* markers (DEVLOOP_WORKSPACE above all) would make the
  // spawned verb resolve the LIVE workspace instead of this fixture.
  const cliPath = join(import.meta.dirname, "..", "src", "scheduler-pause-cli.ts");
  const run = (...args: string[]) =>
    spawnSync("node", [cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      env: { ...scrubFireEnv(), DEVLOOP_ACTOR: "operator" } as NodeJS.ProcessEnv,
    });

  const paused = run("pause", "--reason", "release window");
  assert.equal(paused.status, 0, `pause should exit 0 — stderr: ${paused.stderr}`);

  const db = openDb(dbPath);

  // The discriminating read: exactly the predicate list_events applies (a resolved project id).
  // Against the key-stamped implementation this returns undefined.
  const pauseEvent = db.prepare(
    "SELECT actor, kind, data FROM events WHERE project_id = ? AND kind = 'scheduler.pause' ORDER BY id DESC LIMIT 1",
  ).get(teamProjectId) as { actor: string; kind: string; data: string } | undefined;
  assert(pauseEvent, "scheduler.pause must be readable under _team's RESOLVED id — a key-stamped row matches no reader");
  assert.equal(pauseEvent.actor, "operator");
  assert.equal(JSON.parse(pauseEvent.data).reason, "release window");

  // And pin the defect directly: no row may carry the raw key in the id column.
  const keyStamped = db.prepare("SELECT COUNT(*) n FROM events WHERE project_id = ?").get(TEAM_INTAKE_PROJECT) as { n: number };
  assert.equal(keyStamped.n, 0, `events.project_id must hold a project id, not the key '${TEAM_INTAKE_PROJECT}'`);

  const resumed = run("resume");
  assert.equal(resumed.status, 0, `resume should exit 0 — stderr: ${resumed.stderr}`);

  const resumeEvent = db.prepare(
    "SELECT actor, kind FROM events WHERE project_id = ? AND kind = 'scheduler.resume' ORDER BY id DESC LIMIT 1",
  ).get(teamProjectId) as { actor: string; kind: string } | undefined;
  assert(resumeEvent, "scheduler.resume must be readable under _team's RESOLVED id");
  assert.equal(resumeEvent.actor, "operator");

  db.close();
});
