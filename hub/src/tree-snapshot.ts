// A pre-fire copy of the shared checkout's uncommitted work (LOOP-312), and the record of WHOSE it
// is (LOOP-320).
//
// The shared checkout is a mutable global. §7 isolates dev-tier writes into per-ticket worktrees, but
// QA/PM/senior fires all build, test and verify directly against `<workspace>/<repo>` — and a step as
// ordinary as "check out origin/main and diff" is a TREE WRITE that can destroy another fire's
// in-flight work. On 2026-08-04 that is exactly what happened: between fire 37 and fire 38 a
// `git checkout` discarded two verified, unlanded diffs. `git stash list` was empty, no event was
// written, and the only surviving copy was a pair of .patch files a human happened to extract by hand
// one fire earlier.
//
// Two consumers, opposite failure directions, ONE recorded fact:
//   • LOOP-312 (omission) — the patch, so discarded work is recoverable.
//   • LOOP-320 (commission) — the dirty-path SET, so a fire's ship commit can tell its own edits from
//     the ones that were already sitting in the tree. That set has to be captured at fire START:
//     a path-name heuristic cannot distinguish LOOP-294's `agentops.ts` edit from LOOP-105's own
//     `agentops.ts` edit, and the commit that motivated this carried BOTH in that one file.
//
// ZOD-FREE, and deliberately dependency-free beyond node builtins: run-agents.ts imports this at its
// preflight call site, and it is loaded by the LOOP-58 `--help` test with no dependency install. An
// import that transitively pulled `zod` (agentops → tooldefs) would break that test.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface TreeSnapshot {
  path: string;          // the .patch file
  files: string[];       // tracked paths dirty at capture time — LOOP-320 reads THIS
  hash: string;          // content hash of the patch; the key that makes re-runs idempotent
  reused: boolean;       // true ⇒ an identical snapshot already existed and nothing was written
}

const git = (repoRoot: string, args: string[]): string =>
  execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * The TRACKED modifications in a checkout, as porcelain paths.
 *
 * Untracked files are deliberately excluded. `git checkout` does not discard them, so they are not
 * the population at risk; including them would make every build-artifact-littered tree look dirty and
 * train the operator to ignore the warning.
 */
export function dirtyTrackedFiles(repoRoot: string): string[] {
  let out = "";
  try { out = git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]); }
  catch { return []; } // not a git repo, or git unavailable: nothing to protect, and never a hard failure
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // porcelain v1: XY <path>, and for renames `XY <old> -> <new>`. Take the path that exists NOW.
    const path = line.slice(3).trim();
    const arrow = path.lastIndexOf(" -> ");
    files.push(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
  return files.sort();
}

/** The patch that reproduces the tracked modifications against the tree's own HEAD. */
function trackedDiff(repoRoot: string): string {
  try { return git(repoRoot, ["diff", "HEAD", "--"]); } catch { return ""; }
}

const SNAP_RE = /^tree-([0-9a-f]{12})\.patch$/;

/** Existing snapshots in `dir`, by content hash. */
export function listTreeSnapshots(dir: string): Array<{ path: string; hash: string; mtimeMs: number }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; hash: string; mtimeMs: number }> = [];
  for (const f of readdirSync(dir)) {
    const m = SNAP_RE.exec(f);
    if (!m) continue;
    try { out.push({ path: join(dir, f), hash: m[1], mtimeMs: statSync(join(dir, f)).mtimeMs }); } catch { /* raced away */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Snapshot the checkout's uncommitted TRACKED work. Returns null when there is nothing to protect.
 *
 * Keyed by the patch's CONTENT HASH, so a loop that starts a fire every few minutes against an
 * unchanged dirty tree writes ONE file, not one per fire. Changing a tracked file changes the patch,
 * which changes the hash, which writes a new generation — the property that makes the directory a
 * history rather than a single overwritten file.
 */
export function snapshotDirtyTree(repoRoot: string, dir: string): TreeSnapshot | null {
  const files = dirtyTrackedFiles(repoRoot);
  if (!files.length) return null;              // clean, or untracked-only: nothing, and no warning
  const patch = trackedDiff(repoRoot);
  if (!patch.trim()) return null;              // e.g. mode-only churn git reports but cannot diff
  const hash = createHash("sha256").update(patch).digest("hex").slice(0, 12);
  const dest = join(dir, `tree-${hash}.patch`);
  if (existsSync(dest)) return { path: dest, files, hash, reused: true };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write via a temp + rename so a reader never sees a half-written patch, the same shape the board
  // snapshot uses. A patch that only half-exists is worse than none: `git apply` would take it.
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, patch, { mode: 0o600 });
  try { execFileSync("mv", [tmp, dest]); } catch { writeFileSync(dest, patch, { mode: 0o600 }); }
  return { path: dest, files, hash, reused: false };
}

// ─── the fire-start record (LOOP-320) ───────────────────────────────────────────────────────────
// LOOP-320 AC2 requires "written by this fire" to be decided from a fact recorded at fire START, not
// from a heuristic over paths or ticket ids. This is that fact: the set of paths that were ALREADY
// dirty when the run began. Anything in it that later turns up STAGED was not written by this fire.
export interface PreFireRecord { at: string; repoRoot: string; files: string[]; snapshot?: string }

export const preFireRecordPath = (dir: string): string => join(dir, "pre-fire-dirty.json");

export function writePreFireRecord(dir: string, rec: PreFireRecord): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(preFireRecordPath(dir), JSON.stringify(rec, null, 2), { mode: 0o600 });
}

export function readPreFireRecord(dir: string): PreFireRecord | null {
  const p = preFireRecordPath(dir);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as PreFireRecord;
    return Array.isArray(r?.files) ? r : null;
  } catch { return null; } // a corrupt record must not wedge the run; the guard treats it as absent
}

/**
 * The preflight, called once before the first fire launches.
 *
 * Best-effort by construction: a snapshot failure must never stop the loop from running. It is the
 * SHIP guard (LOOP-320) that is fail-closed, because that one prevents a wrong write rather than
 * merely preserving a copy.
 */
export function preflightTreeSnapshot(repoRoot: string, stateDir: string, log?: (m: string) => void): TreeSnapshot | null {
  try {
    const dir = join(stateDir, "tree-snapshots");
    const snap = snapshotDirtyTree(repoRoot, dir);
    writePreFireRecord(dir, {
      at: new Date().toISOString(),
      repoRoot,
      files: snap?.files ?? [],
      snapshot: snap?.path,
    });
    if (snap && !snap.reused) log?.(`[preflight] shared checkout has ${snap.files.length} uncommitted tracked file(s) — snapshot: ${snap.path}`);
    return snap;
  } catch (e) {
    log?.(`[preflight] tree snapshot skipped: ${(e as Error)?.message ?? String(e)}`);
    return null;
  }
}
