// What build is orchestrating this loop? (LOOP-253)
//
// An upgrade has THREE axes on a self-hosting host, and only two were checked:
//
//   axis                          | checked by
//   ------------------------------|---------------------------------------------
//   the installed package         | pkgVersion() / bundle compatibility
//   a running daemon              | W28 (daemon version skew)
//   the running run-agents loop    | NOTHING  ← this
//
// The scheduler is a LONG-LIVED process. Node resolves and caches every module at import time and
// never reloads them, so a `npm i -g` ten hours into a run changes the installed tree and leaves the
// orchestrator executing the code it loaded at boot. Fixes that landed in that window — LOOP-144,
// LOOP-220, LOOP-175, LOOP-223 were the measured cases — are live for `doctor` (a fresh process every
// invocation) and dead for the loop. Doctor said DOCTOR_OK while the orchestrator ran code from
// before the fix.
//
// Recorded in its OWN file rather than inside scheduler.json. That file is typed
// `Record<agent, CursorMap>` and every consumer indexes it by agent handle; adding a process-identity
// key would make that type a lie for one reader's convenience. Same directory, same lifetime, honest
// types.
//
// Zero-import leaf beyond node builtins: run-agents.ts imports it, and run-agents is loaded by the
// LOOP-58 `--help` test with no dependency install.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export interface SchedulerBuild {
  version: string;      // the package version this process LOADED
  modulePath: string;   // the resolved tree it loaded from — two installs can share a version
  pid: number;
  startedAt: string;
}

/** The installed package version, read from the tree THIS module was loaded from. */
export function pkgVersionOf(root: string = join(here, "..")): string {
  try { return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0"; }
  catch { return "0.0.0"; }
}

export const schedulerBuildPath = (teamDir: string): string => join(teamDir, "scheduler-build.json");

/** Record this process's build identity. Best-effort: a failure must never stop the loop starting. */
export function writeSchedulerBuild(teamDir: string, now = new Date()): SchedulerBuild | null {
  const rec: SchedulerBuild = {
    version: pkgVersionOf(),
    modulePath: join(here, ".."),
    pid: process.pid,
    startedAt: now.toISOString(),
  };
  try {
    mkdirSync(teamDir, { recursive: true });
    const f = schedulerBuildPath(teamDir);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, f);
    return rec;
  } catch { return null; }
}

export function readSchedulerBuild(teamDir: string): SchedulerBuild | null {
  try {
    const r = JSON.parse(readFileSync(schedulerBuildPath(teamDir), "utf8")) as SchedulerBuild;
    return typeof r?.version === "string" && typeof r?.pid === "number" ? r : null;
  } catch { return null; }
}

/**
 * Is that recorded process still alive?
 *
 * `kill(pid, 0)` sends NO signal — it only asks whether the pid exists and is signallable. That is
 * the distinction the AC draws: this check must not spawn or signal the scheduler, and a
 * zero-signal existence probe does neither.
 *
 * A recycled pid is possible in principle. It would at worst mean reporting a stale record as live,
 * which is the same outcome as not checking at all — so the probe can only improve accuracy.
 */
export function schedulerAlive(rec: SchedulerBuild): boolean {
  try { process.kill(rec.pid, 0); return true; } catch { return false; }
}

export type SkewDirection = "older" | "newer";
export interface SchedulerSkew { running: string; installed: string; direction: SkewDirection; pid: number; startedAt: string }

/**
 * The skew, or null when there is nothing to report.
 *
 * DIRECTION-AWARE, per LOOP-252's AC: a scheduler running a NEWER build than the installed CLI is a
 * real and different situation — someone downgraded, or the loop was launched from a checkout — and
 * calling it "running old code" would send the reader to the wrong remedy.
 *
 * Compared on the version STRING, not on semver ordering: these are the same package, and a build
 * whose version differs at all is a different build. Ordering only decides the WORD, so it uses a
 * numeric-segment comparison and falls back to "older" when the shapes are not comparable — the
 * commoner case, and the one whose remedy (restart) is correct either way.
 */
export function schedulerSkew(rec: SchedulerBuild | null, installed: string): SchedulerSkew | null {
  if (!rec || rec.version === installed) return null;
  return { running: rec.version, installed, direction: cmpVersion(rec.version, installed) > 0 ? "newer" : "older", pid: rec.pid, startedAt: rec.startedAt };
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/), pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0), nb = Number(pb[i] ?? 0);
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return 0; // not comparable ⇒ caller says "older"
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/** Convenience for callers that only have the workspace state root. */
export const teamDirOf = (stateRoot: string): string => join(stateRoot, "team");

export function schedulerBuildExists(teamDir: string): boolean { return existsSync(schedulerBuildPath(teamDir)); }
