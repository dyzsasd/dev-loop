// Cross-process advisory file locks (O_EXCL + liveness-checked stale takeover + a break-mutex so two
// racers can't both re-admit). Used by `with-repo-lock` to serialize base-clone mutations on a SHARED
// repo (fetch / worktree add / prune) across projects — worktrees themselves never need it (they are
// independent). This is the same algorithm the daemon lifecycle uses for its cold-start lock (DL-46/51);
// kept as a standalone, dependency-free module so any command can serialize on a path.
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

interface LockInfo { pid: number; at: string }
const readLock = (path: string): LockInfo | null => { try { return JSON.parse(readFileSync(path, "utf8")) as LockInfo; } catch { return null; } };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Acquire `lockPath`; returns an idempotent, ownership-checked release. Throws if a LIVE holder outlasts
// totalMs. A stale lock (holder dead, or older than staleMs, or unparseable `at`) is always broken.
export async function acquireLock(lockPath: string, opts: { totalMs?: number; staleMs?: number } = {}): Promise<() => void> {
  const totalMs = opts.totalMs ?? 60_000;
  const staleMs = opts.staleMs ?? 30_000;
  const breakFile = `${lockPath}.break`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + totalMs;
  const stamp = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const isStale = (h: LockInfo | null): boolean => {
    const age = h ? Date.now() - Date.parse(h.at) : Infinity;
    return !h || !isAlive(h.pid) || !(age <= staleMs); // NaN age → stale (never trust an unparseable lock)
  };
  for (;;) {
    try {
      writeFileSync(lockPath, stamp(), { flag: "wx" }); // O_CREAT|O_EXCL — exactly one creator wins
      let released = false;
      return () => { if (released) return; released = true; try { if (readLock(lockPath)?.pid === process.pid) unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      if (!isStale(readLock(lockPath))) {
        if (Date.now() >= deadline) { const h = readLock(lockPath); throw new Error(`could not acquire lock ${lockPath}${h ? ` (held by pid ${h.pid})` : ""} within ${totalMs}ms`); }
        await sleep(100); continue;
      }
      // Break a stale lock under a dedicated break-mutex so two racers can't both break + re-admit.
      try {
        writeFileSync(breakFile, stamp(), { flag: "wx" });
        try { if (isStale(readLock(lockPath))) { try { unlinkSync(lockPath); } catch { /* gone */ } } }
        finally { try { if (readLock(breakFile)?.pid === process.pid) unlinkSync(breakFile); } catch { /* released */ } }
      } catch (be) {
        if ((be as { code?: string }).code !== "EEXIST") throw be;
        // Another racer holds the break-mutex; clear a dead breaker, else wait it out briefly.
        if (isStale(readLock(breakFile))) { try { unlinkSync(breakFile); } catch { /* raced */ } }
        else await sleep(50);
      }
    }
  }
}

// Run `fn` while holding `lockPath`; always releases, even on throw.
export async function withLock<T>(lockPath: string, opts: { totalMs?: number; staleMs?: number }, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(lockPath, opts);
  try { return await fn(); } finally { release(); }
}
