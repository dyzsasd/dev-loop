// A consistent copy of a live SQLite board (LOOP-337, board-snapshot Child A).
//
// `bundle export --backup` claimed to take a live, WAL-checkpointed copy. Measured on node:sqlite /
// Node 23.6.0, it can instead emit an UNOPENABLE file with nothing detecting it:
//
//   probe                                                        | result
//   -------------------------------------------------------------|--------------------------------
//   db.exec("PRAGMA wal_checkpoint(TRUNCATE)") with a reader open | returns normally, THROWS NOTHING
//                                                                 | (reports {busy:1} — partial)
//   the surrounding catch / console.warn("checkpoint failed…")     | UNREACHABLE — exec does not raise
//   readFileSync(hub.db) after that partial checkpoint, reopened   | "database disk image is malformed"
//   readFileSync(hub.db) of a WAL db never checkpointed            | "no such table: t" — the schema
//                                                                 | itself is still in the WAL
//
// Two independent defects: a busy checkpoint is undetectable through `exec`, and `readFileSync` of a
// live SQLite main file is not an atomic read — writers advance the file mid-read, which no amount of
// checkpoint-hardening fixes.
//
// `VACUUM INTO` is the correct primitive: it writes a consistent snapshot INCLUDING WAL content,
// without a checkpoint and without blocking writers.
import { DatabaseSync } from "node:sqlite";
import { renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A consistent copy of a live SQLite board. Throws on any failure, leaving no artifact.
 *
 * R1 — a dedicated `{ readOnly: true }` connection. A `PRAGMA query_only=ON` connection is REFUSED
 *      by VACUUM INTO ("attempt to write a readonly database"), so the daemon's shared read
 *      connection cannot be reused; readOnly:true works and cannot mutate the board.
 * R2 — the destination is BOUND, never interpolated: `VACUUM INTO ?`. Keeps path quoting out of it.
 * R3 — write to a fresh temp path in the DESTINATION directory, then rename() into place. A
 *      non-empty target is refused ("file is not a database") and a zero-length one is silently
 *      overwritten, so writing straight to `dest` is not safe; rename(2) is atomic within a
 *      directory, so no reader ever sees a half-written file.
 * R4 — on any failure: throw, unlink the temp, leave NO artifact. Never degrade into a
 *      warning-plus-success — that degradation is the defect being fixed.
 */
export function snapshotBoardDb(srcPath: string, destPath: string): void {
  // Unique per call: two snapshots racing in one directory must not collide on the temp name.
  const tmp = join(dirname(destPath), `.board-snapshot-${process.pid}-${Math.trunc(performance.now() * 1000)}.tmp`);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(srcPath, { readOnly: true });        // R1
    // A BOUNDED wait, never an indefinite one. VACUUM INTO takes a read lock on the source, and a
    // concurrent writer can hold it — without a timeout this call can block for as long as that
    // writer runs, which turns a best-effort backup into a hang. 5s matches openDb's busy_timeout;
    // past that the caller's own posture decides (the cadence logs and moves on, the pre-verb copy
    // refuses), and either is better than waiting forever.
    try { db.exec("PRAGMA busy_timeout=5000"); } catch { /* older builds: the default applies */ }
    db.prepare("VACUUM INTO ?").run(tmp);                       // R2
    renameSync(tmp, destPath);                                  // R3
  } catch (e) {
    // R4 — no artifact survives a failure, including a temp file from a partial VACUUM.
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw new Error(`board snapshot failed (${srcPath} → ${destPath}): ${(e as Error)?.message ?? String(e)}`);
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

// ─── retention + listing (LOOP-338, Child B) ────────────────────────────────────────────────────
// The recurring artifact is deliberately the BOARD ONLY — one hub.db file. A bundle carries
// dev-loop.json + every referenced secret VALUE + the git deploy key, so writing that unattended,
// repeatedly, and retaining N generations is a new secret-at-rest surface with a growing blast
// radius (LOOP-210 / LOOP-162). Board-only is also the RIGHT artifact: the 2026-08-04 incident wiped
// a board inside an otherwise intact workspace. It satisfies "no secrets" BY CONSTRUCTION — this
// code path never reads a secret, so no later edit can regress it into leaking one.
import { existsSync, mkdirSync, readdirSync, statSync, chmodSync } from "node:fs";

export type SnapshotReason = string; // `cadence` | `pre-<verb>` | `manual`
export interface SnapshotFile { path: string; takenAt: string; bytes: number; reason: string }

// board-YYYYMMDDTHHMMSSZ-<reason>.db — the timestamp lives IN THE NAME on purpose: a restore or a
// plain file copy rewrites mtimes, so an mtime-ordered retention would silently reorder the
// generations and delete the wrong one.
const SNAP_RE = /^board-(\d{8}T\d{6}Z)-([A-Za-z0-9._-]+)\.db$/;

export function snapshotName(takenAt: Date, reason: SnapshotReason): string {
  const iso = takenAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `board-${iso}-${reason}.db`;
}

/** Generations in the directory, NEWEST FIRST, ordered by the EMBEDDED timestamp (never mtime). */
export function listSnapshots(dir: string): SnapshotFile[] {
  if (!existsSync(dir)) return [];
  const out: SnapshotFile[] = [];
  for (const f of readdirSync(dir)) {
    const m = SNAP_RE.exec(f);
    if (!m) continue; // anything else in the directory is not ours and is never pruned
    let bytes = 0;
    try { bytes = statSync(join(dir, f)).size; } catch { continue; }
    out.push({ path: join(dir, f), takenAt: m[1], bytes, reason: m[2] });
  }
  return out.sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.path.localeCompare(a.path));
}

/** Drop all but the newest `keep` generations. Returns the paths removed. keep<=0 removes nothing. */
export function pruneSnapshots(dir: string, keep: number): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const removed: string[] = [];
  for (const s of listSnapshots(dir).slice(keep)) {
    try { rmSync(s.path, { force: true }); removed.push(s.path); } catch { /* leave it; retention is best-effort */ }
  }
  return removed;
}

/**
 * Take one generation and prune. Returns the artifact path.
 *
 * Pruning happens ONLY AFTER a successful write, so a failed snapshot can never delete a good older
 * generation — the failure mode that turns a backup system into a data-loss system.
 */
export function takeBoardSnapshot(opts: { dbPath: string; dir: string; keep: number; reason: SnapshotReason; now?: Date }): string {
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const dest = join(opts.dir, snapshotName(opts.now ?? new Date(), opts.reason));
  snapshotBoardDb(opts.dbPath, dest);
  try { chmodSync(dest, 0o600); } catch { /* best-effort on filesystems without POSIX modes */ }
  pruneSnapshots(opts.dir, opts.keep);
  return dest;
}

// ─── restore (LOOP-341, Child E) ────────────────────────────────────────────────────────────────
// A backup that has never been restored from is not a backup. Children A–D produce an artifact and
// warn about its absence; none of them proves it can be turned back into a board. The 2026-08-04
// recovery path was an improvised `sqlite3 .recover` run under pressure two hours after the loss,
// and it still lost 19 tickets and 79 comments permanently.
//
// This is the one child in the module that WRITES OVER a live board — the other four only read —
// which is why it is gated by the EXISTING destructive-guard token rather than a new mechanism, and
// why it takes its own `pre-restore` snapshot first.

// The tables doctor already treats as "carries the hub schema". Named here so a truncated or foreign
// file is refused BEFORE anything is overwritten, rather than discovered after.
const HUB_SCHEMA_TABLES = ["projects", "tickets", "documents", "actors", "events"] as const;

export interface RestoreVerification { ok: boolean; error?: string; tickets?: number; comments?: number }

/**
 * Verify a snapshot is a usable board WITHOUT touching anything. AC3: a truncated, corrupt or
 * non-SQLite file is refused with the existing board untouched, so this runs before every write.
 */
export function verifySnapshot(path: string): RestoreVerification {
  if (!existsSync(path)) return { ok: false, error: `snapshot not found: ${path}` };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
    const missing = HUB_SCHEMA_TABLES.filter((t) => !present.has(t));
    if (missing.length) return { ok: false, error: `not a hub board — missing table(s): ${missing.join(", ")}` };
    const tickets = (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
    const comments = (db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
    return { ok: true, tickets, comments };
  } catch (e) {
    return { ok: false, error: `not a readable SQLite database: ${(e as Error)?.message ?? String(e)}` };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * Replace the live board with a snapshot. Throws on any refusal, having written nothing.
 *
 * AC5 — the restore is itself UNDOABLE: the current board is snapshotted as `pre-restore` before it
 * is overwritten, so restoring from the wrong generation is recoverable. That copy is taken through
 * the same primitive, so it inherits the same consistency guarantees.
 */
export function restoreBoard(opts: { from: string; dbPath: string; dir: string; keep: number }): { restored: string; preRestore: string | null; tickets: number; comments: number } {
  const v = verifySnapshot(opts.from);
  if (!v.ok) throw new Error(`refusing to restore: ${v.error}. The existing board is untouched.`);

  // The undo copy FIRST — before anything is overwritten. If the live board cannot be copied we
  // refuse rather than proceed: an un-undoable restore over a live board is the shape that turns a
  // recovery tool into a second incident.
  let preRestore: string | null = null;
  if (existsSync(opts.dbPath)) {
    const probe = verifySnapshot(opts.dbPath);
    if (probe.ok) preRestore = takeBoardSnapshot({ dbPath: opts.dbPath, dir: opts.dir, keep: opts.keep, reason: "pre-restore" });
    // An UNREADABLE live board is exactly what a restore is for — nothing to preserve, proceed.
  }

  // Land it through the same temp+rename shape the snapshot uses, so a reader never sees a
  // half-written board and a failure leaves the original in place.
  const tmp = `${opts.dbPath}.restore-${process.pid}`;
  try {
    snapshotBoardDb(opts.from, tmp);   // normalises + proves the copy one more time
    renameSync(tmp, opts.dbPath);
    // WAL/SHM from the OLD board would be replayed over the NEW file and corrupt it.
    for (const sfx of ["-wal", "-shm"]) { try { rmSync(`${opts.dbPath}${sfx}`, { force: true }); } catch { /* best-effort */ } }
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw new Error(`restore failed (${opts.from} → ${opts.dbPath}): ${(e as Error)?.message ?? String(e)}. The existing board is untouched.`);
  }
  return { restored: opts.dbPath, preRestore, tickets: v.tickets ?? 0, comments: v.comments ?? 0 };
}

// ─── the triggers (LOOP-339, Child C) ───────────────────────────────────────────────────────────
// AC1 of LOOP-303 is "a snapshot the operator does not have to remember to take". A verb nobody
// invokes is exactly the state that lost 19 tickets on 2026-08-04.
//
// TWO triggers, because they cover different loss modes:
//   • a CADENCE covers every loss mode, including the ones nobody predicted;
//   • a copy taken immediately BEFORE a destructive verb commits bounds the worst case to SECONDS
//     instead of up to `everyHours`. That is the trigger that would have turned the 2026-08-04 loss
//     into a five-minute restore.
//
// The timer follows startWalCheckpoint (daemon-notifiers.ts) exactly — it is the established
// precedent for a periodic maintenance timer on this db: its OWN connection (the shared read
// connection is PRAGMA query_only=ON, which VACUUM INTO refuses outright — measured), setInterval +
// unref so the timer never keeps the process alive, an env override for tests, and
// `everyHours: 0 ⇒ not started at all`, the same cadence<=0 ⇒ no-op posture every other notifier has.
export interface BoardSnapshotTimerOpts { dbPath: string; dir: string; keep: number; intervalMs: number; log?: (m: string) => void }

/**
 * A cadence tick is skipped when this directory already holds a generation from the CURRENT interval.
 *
 * More than one daemon can share one hub.db — a workspace with a `_team` daemon and a project daemon has
 * two, both holding `<workspace>/.dev-loop/hub.db` and both running this timer. They ticked a second
 * apart and wrote BYTE-IDENTICAL copies (measured: two pairs, same SHA-256, 1 s apart). The wasted disk
 * is bounded by `keep`, but the retention WINDOW is not: with every generation duplicated, `keep: 10`
 * retains five distinct points in time instead of ten — and the older generations are the whole reason
 * the cadence exists, since they are what makes `dev-loop board restore` undoable.
 *
 * Half the interval is the threshold rather than the whole of it: a tick that runs slightly early must
 * still be able to take its own generation, while a second writer inside the same window is refused.
 * Content is not compared — a duplicate is defined by TIME, so this also refuses two daemons whose
 * boards happen to differ by one row in the second between their ticks.
 */
export function cadenceDuplicateOf(dir: string, intervalMs: number, nowMs: number): string | null {
  if (!(intervalMs > 0)) return null;
  const newest = listSnapshots(dir).find((s) => s.reason === "cadence");
  if (!newest) return null;
  const takenMs = Date.parse(newest.takenAt.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
  if (!Number.isFinite(takenMs)) return null;
  return nowMs - takenMs < intervalMs / 2 ? newest.path : null;
}

export function boardSnapshotTick(opts: { dbPath: string; dir: string; keep: number; intervalMs?: number; log?: (m: string) => void }): string | null {
  try {
    const dup = cadenceDuplicateOf(opts.dir, opts.intervalMs ?? 0, Date.now());
    if (dup) {
      opts.log?.(`[daemon] board snapshot skipped: ${dup} already covers this interval (another daemon on the same hub.db took it)`);
      return null;
    }
    return takeBoardSnapshot({ dbPath: opts.dbPath, dir: opts.dir, keep: opts.keep, reason: "cadence" });
  } catch (e) {
    // Best-effort like every other daemon timer: a failed snapshot must never take the daemon down.
    // It is NOT silent — W-code coverage for a cadence that has stopped is Child D's job, and this
    // line is what an operator greps when it warns.
    opts.log?.(`[daemon] board snapshot FAILED: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
}

export function startBoardSnapshot(opts: BoardSnapshotTimerOpts): ReturnType<typeof setInterval> | null {
  if (!(opts.intervalMs > 0)) return null; // everyHours: 0 ⇒ disabled, not started at all
  const timer = setInterval(() => boardSnapshotTick({ ...opts, intervalMs: opts.intervalMs }), opts.intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * The pre-destructive-verb copy (LOOP-339 trigger 2), FAIL-CLOSED.
 *
 * Unlike the cadence timer this must NOT be best-effort: its entire purpose is to exist before an
 * irreversible write, so "the snapshot failed, proceeding anyway" would remove the only guarantee it
 * offers. Throws, and the destructive verb refuses.
 */
export function snapshotBeforeDestructive(opts: { dbPath: string; dir: string; keep: number; verb: string }): string | null {
  // The one carve-out, and it is narrow: if there is NO READABLE BOARD there is nothing to protect,
  // and refusing would wedge the operator's only escape. `team remove-project --force` exists
  // precisely to clean up config when the db is already broken (LOOP-280 AC4) — making that refuse
  // because an unreadable db cannot be copied would turn a recovery tool into a dead end.
  //
  // "Fail-closed" means: if there IS a board and we cannot copy it, refuse. Not: refuse when there
  // is nothing to copy.
  if (!existsSync(opts.dbPath)) return null;
  // `SELECT 1` is NOT a sufficient probe — it never touches the file's schema, so it succeeds on a
  // corrupt db that VACUUM INTO then rejects with "file is not a database". Reading sqlite_master is
  // what actually establishes "this is a readable SQLite database".
  try {
    const probe = new DatabaseSync(opts.dbPath, { readOnly: true });
    try { probe.prepare("SELECT COUNT(*) FROM sqlite_master").get(); } finally { probe.close(); }
  } catch { return null; } // unreadable/corrupt: nothing to snapshot, and the verb must stay usable
  return takeBoardSnapshot({ dbPath: opts.dbPath, dir: opts.dir, keep: opts.keep, reason: `pre-${opts.verb}` });
}

/** Resolve `team.backup.*` with the shipped defaults. everyHours 0 ⇒ the cadence is off. */
export function resolveBackupConfig(team: { backup?: { everyHours?: number; keep?: number; dir?: string } } | undefined, stateRoot: string): { intervalMs: number; keep: number; dir: string } {
  const b = team?.backup ?? {};
  const everyHours = typeof b.everyHours === "number" ? b.everyHours : 6;
  const keep = typeof b.keep === "number" ? b.keep : 10;
  return {
    intervalMs: Number(process.env.DEVLOOP_BOARD_SNAPSHOT_MS) || Math.max(0, everyHours) * 3_600_000,
    keep,
    dir: b.dir ?? join(stateRoot, "snapshots"),
  };
}
