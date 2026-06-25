// P3b [coverage]: the single-writer WAL checkpoint (design daemon-multicli §P3). The daemon holds ONE
// long-lived writable connection (`writeDb`) for every agent op-API + human web-write, so its `-wal` file
// is never auto-checkpointed by a closing connection and grows unbounded. `walCheckpointTick` runs
// `PRAGMA wal_checkpoint(TRUNCATE)` to fold the log into the main DB and truncate `-wal` back to zero.
// This builds a temp DB, grows the WAL with real writes, runs ONE tick, and asserts the `-wal` truncated +
// the data survived (the checkpoint folded it into the main DB) + the row count is intact. No network.
import { DatabaseSync } from "node:sqlite";
import { rmSync, statSync, existsSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { createTicket } from "../src/ticketwrite.ts";
import { walCheckpointTick, startWalCheckpoint } from "../src/daemon.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const walSize = (p: string): number => (existsSync(p + "-wal") ? statSync(p + "-wal").size : 0);

const PATH = "/tmp/dl-wal-checkpoint.db";
clean(PATH);

// ── grow the WAL with real writes on ONE long-lived connection (the daemon's single-writer model) ──
const db = openDb(PATH);
const projectId = ensureSeed(db, "walverify", "WAL Verify", "WAL");
for (let i = 0; i < 40; i++) createTicket(db, projectId, "pm", { title: `ticket ${i} — padding the write-ahead log`, type: "Feature" });
ok((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode === "wal", "openDb runs in WAL mode (the checkpoint precondition)");

const before = walSize(PATH);
const rowsBefore = (db.prepare("SELECT count(*) c FROM tickets").get() as { c: number }).c;
ok(before > 0, `the -wal file grew with writes (${before} bytes) — there is a log to checkpoint`);

// ── one checkpoint tick on the same long-lived connection (no concurrent reader holds the WAL) ──
walCheckpointTick(db);
const after = walSize(PATH);
ok(after === 0, `walCheckpointTick TRUNCATEd the -wal back to 0 (was ${before}, now ${after})`);

// ── the checkpoint is loss-free: it folds the log INTO the main DB, never drops committed rows ──
const rowsAfter = (db.prepare("SELECT count(*) c FROM tickets").get() as { c: number }).c;
ok(rowsAfter === rowsBefore && rowsAfter === 40, `all ${rowsAfter} committed rows survived the checkpoint (loss-free)`);

// ── a write AFTER the checkpoint re-grows the WAL, and a second tick truncates it again (repeatable) ──
createTicket(db, projectId, "pm", { title: "post-checkpoint write re-grows the wal", type: "Bug" });
ok(walSize(PATH) > 0, "a write after the checkpoint re-grows the -wal (the connection stays live)");
walCheckpointTick(db);
ok(walSize(PATH) === 0, "a second tick truncates the -wal again (repeatable, the daemon's periodic model)");

// ── best-effort: a tick never throws (the daemon must never crash on a busy checkpoint) ──
let threw = false;
try { walCheckpointTick(db); } catch { threw = true; }
ok(!threw, "walCheckpointTick never throws (best-effort — a BUSY checkpoint is a clean no-op)");

// ── startWalCheckpoint returns an unref'd timer (never keeps the process alive on its own) ──
const timer = startWalCheckpoint(db, 999_999);
ok(!!timer, "startWalCheckpoint returns a timer");
clearInterval(timer); // don't leak the interval

db.close();
clean(PATH);
console.log(fails === 0 ? "\nWAL_CHECKPOINT_OK" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
