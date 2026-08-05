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
