// P3b [coverage]: the single-writer WAL checkpoint (design daemon-multicli §P3). The daemon holds ONE
// long-lived writable connection for every agent op-API + human web-write, so its `-wal` is never
// auto-checkpointed and grows unbounded; a periodic checkpoint folds the log into the main DB.
//
// node:sqlite is SYNCHRONOUS on a single-threaded daemon, so the checkpoint must NEVER block the event
// loop. The fix (Codex review 2026-06-27): checkpoint on a DEDICATED `busy_timeout=0` connection — under a
// concurrent reader it returns immediately instead of stalling up to the writer's 5s busy_timeout. This
// suite asserts BOTH: (A) the happy path truncates `-wal` to 0 loss-free; (B) under a HELD read transaction
// the tick returns FAST (well under 5s) and never throws — the real failure mode the first version missed.
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

// ── (A) happy path: grow the WAL, one tick truncates it to 0, loss-free, repeatable ──
const db = openDb(PATH);
const projectId = ensureSeed(db, "walverify", "WAL Verify", "WAL");
for (let i = 0; i < 40; i++) createTicket(db, projectId, "pm", { title: `ticket ${i} — padding the write-ahead log`, type: "Feature" });
ok((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode === "wal", "openDb runs in WAL mode (the checkpoint precondition)");

const before = walSize(PATH);
ok(before > 0, `the -wal file grew with writes (${before} bytes) — there is a log to checkpoint`);
walCheckpointTick(db);
ok(walSize(PATH) === 0, `walCheckpointTick TRUNCATEd the -wal back to 0 (was ${before})`);
ok((db.prepare("SELECT count(*) c FROM tickets").get() as { c: number }).c === 40, "all 40 committed rows survived the checkpoint (loss-free)");

createTicket(db, projectId, "pm", { title: "post-checkpoint write re-grows the wal", type: "Bug" });
ok(walSize(PATH) > 0, "a write after the checkpoint re-grows the -wal (the connection stays live)");
walCheckpointTick(db);
ok(walSize(PATH) === 0, "a second tick truncates the -wal again (repeatable, the daemon's periodic model)");

// ── (B) the real failure mode: a HELD read transaction must NOT make the tick block the event loop ──
// Re-grow the WAL, then open a SECOND connection holding an open read transaction (a read mark on the WAL),
// then checkpoint on a DEDICATED busy_timeout=0 connection (mirroring startWalCheckpoint). It must return
// FAST (a blocking tick would wait the writer's 5s busy_timeout) and never throw.
for (let i = 0; i < 20; i++) createTicket(db, projectId, "pm", { title: `more wal padding ${i}`, type: "Feature" });
const reader = openDb(PATH);
reader.exec("BEGIN");
reader.prepare("SELECT count(*) FROM tickets").get(); // acquire the read mark; held until ROLLBACK
const ckDb = openDb(PATH);
ckDb.exec("PRAGMA busy_timeout=0"); // what startWalCheckpoint does
let threw = false;
const t0 = Date.now();
try { walCheckpointTick(ckDb); } catch { threw = true; }
const elapsed = Date.now() - t0;
ok(!threw, "under a held read txn the tick never throws (BUSY is a clean no-op)");
ok(elapsed < 2000, `the tick returned FAST under contention (${elapsed}ms ≪ the 5000ms busy_timeout a blocking checkpoint would wait) — non-blocking`);
ok((reader.prepare("SELECT count(*) c FROM tickets").get() as { c: number }).c === 61, "data intact under the contended checkpoint (40 + 1 + 20)");
reader.exec("ROLLBACK");
reader.close(); ckDb.close();

// ── (C) startWalCheckpoint opens its own connection from a path + returns an unref'd timer ──
const timer = startWalCheckpoint(PATH, 999_999);
ok(!!timer, "startWalCheckpoint(dbPath) returns a timer (opens its own dedicated connection)");
clearInterval(timer);

db.close();
clean(PATH);
console.log(fails === 0 ? "\nWAL_CHECKPOINT_OK" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
