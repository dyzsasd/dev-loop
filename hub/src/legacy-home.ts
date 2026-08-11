// legacy-home.ts — LOOP-473 (design/state-locality, invariant I3): does a home-anchored
// `~/.dev-loop` tree still hold state that only the retiring seam can reach?
//
// `devloopHome()` (paths.ts) defaults to `join(homedir(), ".dev-loop")`, and its two derived
// resolvers — `devloopDataDir()` and `hubDbPath()` — are read from ~25 call sites. Removing that
// default is two lines; the hazard is what the removal ORPHANS. On the machine this was written
// against, the legacy root held a populated `hub.db` (52 tickets, 125 comments), a v1
// `projects.json`, five root-level `<agent>-state.json` files, and three project state dirs — all
// of it reachable ONLY through the home default, and none of it visible to any workspace.
//
// So the removal is sequenced behind a migration (`dev-loop team import`), and this module is how
// that sequencing becomes observable instead of remembered: it answers "is there still state
// behind the seam?" as a fact derived from disk, which doctor reports as E20.
//
// It takes the root as a PARAMETER and never calls homedir() itself. That is what makes it
// fixture-testable — a check that can only be exercised against the developer's real home
// directory is a check whose passing arm nobody can write.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What a legacy root holds. Every field is evidence a reader can check by hand. */
export interface LegacyHomeState {
  /** The root that was inspected. */
  root: string;
  /** A root-level `hub.db` — a whole board reachable only through the home default. */
  hubDb: boolean;
  /** The v1 `projects.json` config the 1.0 workspace schema replaced. */
  projectsJson: boolean;
  /** Root-level `<agent>-state.json` files, sorted. */
  stateFiles: string[];
  /** Sub-directories that hold resolvable per-project state, sorted. */
  projectDirs: string[];
}

/** `<agent>-state.json` at the root — the per-agent runtime state a fire reads and rewrites. */
const STATE_FILE_RE = /^[a-z][a-z0-9-]*-state\.json$/;

/**
 * Does `dir` hold state a reader would resolve, as opposed to reconstructible scratch?
 *
 * A project directory containing ONLY `wt/` is NOT state: worktrees are enumerated from
 * `git worktree list` (absolute paths recorded in `.git/worktrees`), so `worktree reap` covers
 * every root including legacy ones, and no resolver walks the data dir to find them. Counting
 * them would make E20 fire on a root holding nothing but reconstructible directories.
 */
function holdsState(dir: string): boolean {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }
  return entries.some((e) =>
    e === "hub.db" || e === "reports" || e === "lessons" || STATE_FILE_RE.test(e));
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Inspect a legacy home root.
 *
 * Returns `null` when the root does not exist or holds no resolvable state — an empty or
 * worktrees-only `~/.dev-loop` is not a migration hazard, and reporting it would train the
 * operator to ignore the code.
 */
export function legacyHomeState(root: string): LegacyHomeState | null {
  if (!isDir(root)) return null;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }

  const hubDb = entries.includes("hub.db");
  const projectsJson = entries.includes("projects.json");
  const stateFiles = entries.filter((e) => STATE_FILE_RE.test(e)).sort();
  const projectDirs = entries
    .filter((e) => !e.startsWith(".") && isDir(join(root, e)) && holdsState(join(root, e)))
    .sort();

  if (!hubDb && !projectsJson && !stateFiles.length && !projectDirs.length) return null;
  return { root, hubDb, projectsJson, stateFiles, projectDirs };
}

/** One line naming what was found, for the E20 message. Order is stable, so output is diffable. */
export function describeLegacyHome(s: LegacyHomeState): string {
  const parts: string[] = [];
  if (s.hubDb) parts.push("hub.db (a whole board)");
  if (s.projectsJson) parts.push("projects.json (v1 config)");
  if (s.stateFiles.length) parts.push(`${s.stateFiles.length} root state file(s): ${s.stateFiles.join(", ")}`);
  if (s.projectDirs.length) parts.push(`${s.projectDirs.length} project state dir(s): ${s.projectDirs.join(", ")}`);
  return parts.join("; ");
}

/**
 * The E20 check. Takes the root explicitly (never homedir()) so both arms are testable.
 *
 * E-code, not W: once the home default is gone, every byte named here becomes unreachable to the
 * product. That is a data-loss precondition, not a hygiene nag, and doctor's contract is that ❌
 * blocks an unattended run while a W-code does not.
 */
export function checkLegacyHome(root: string, fail: (m: string) => void): void {
  const s = legacyHomeState(root);
  if (!s) return;
  fail(`[E20] a home-anchored dev-loop tree at ${s.root} still holds state reachable only through the retiring \`~/.dev-loop\` default — ${describeLegacyHome(s)}. Nothing in any workspace accounts for it, so removing the home fallback (LOOP-473) would orphan it. Migrate it into a workspace first: dev-loop team import --into <workspace-root> --project <key> (run it with --dry-run first; it copies and leaves the legacy tree unmodified), then remove ${s.root} once the runtime is re-pointed.`);
}
