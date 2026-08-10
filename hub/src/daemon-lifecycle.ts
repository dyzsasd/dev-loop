// dev-loop hub daemon — the per-project process-lifecycle / supervisor subsystem (DL-74 extraction).
//
// DL-41: idempotent per-project daemon lifecycle (up | ensure | down | status). A thin, additive wrapper
// around the foreground boot that lives in `daemon.ts` (this module's sibling): `up` resolves the project
// (cwd or DEVLOOP_PROJECT), picks a fixed-default localhost port, and spawns `daemon.ts` detached so the web UI
// survives the launching shell; `down`/`status` operate on a machine-local runfile. Designed so the DL-42
// SessionStart hook can call `up` unconditionally: a non-service / unresolved project is a clean no-op +
// exit 0, and a second `up` never double-starts. The foreground boot path (`npm run daemon`) is NOT touched
// by any of this — daemon.ts's own top-level dispatch routes a lifecycle subcommand here before its
// foreground `if` is reached. This module has NO top-level side effects (pure declarations), so importing
// it is always safe (server.ts delegates `dev-loop-hub daemon <sub>` to it; daemon.ts imports the dispatch).
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer as netCreateServer } from "node:net";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, renameSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";
import { loadProjectsConfig, resolveProjectFromCwd } from "./resolve-project.ts";
import { findCompatibleNode } from "./node-runtime.ts";
import { devloopProjectsPath, hubDbPath, pkgVersion, pkgBuildCommit, pkgBuildCommitFresh } from "./paths.ts";
import { tryResolveWorkspace, wsStateRoot, wsHubDb } from "./workspace.ts";

interface RunInfo { project: string; pid: number; port: number; host: string; url: string; startedAt: string; version?: string; buildCommit?: string | null; actor?: string; entryPath?: string; }
// LOOP-250: returns true when the running daemon runs the same code as the installed CLI.
// Version equality is not sufficient for source builds (same v1.14.0, different commit).
// Both present + both match = same code; either absent → fall back to version-only (npm install semantics).
export function sameDaemonCode(installedVer: string, installedCommit: string | null | undefined, runningVer: string | undefined, runningCommit: string | null | undefined): boolean {
  if ((runningVer ?? "") !== installedVer) return false;
  if (installedCommit && runningCommit) return installedCommit === runningCommit;
  return true;
}
// semver direction: returns true when a comes strictly before b (a < b). Unparseable strings → false (treat as equal).
function semverBefore(a: string, b: string): boolean {
  const pa = a.match(/^(\d+)\.(\d+)\.(\d+)/), pb = b.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d !== 0) return d < 0; }
  return false;
}
// Direction-aware version status suffix for daemon status output.
export function formatVersionStatus(runningVer: string, runningCommit: string | null | undefined, cliVer: string, cliCommit: string | null | undefined, key: string): string {
  if (sameDaemonCode(cliVer, cliCommit, runningVer, runningCommit)) return "";
  if (runningVer === "?" || runningVer === cliVer) {
    return ` — running OLD code (commit differs); run \`DEVLOOP_PROJECT=${key} dev-loop daemon up\` to restart`;
  }
  if (semverBefore(cliVer, runningVer))
    return ` — daemon is NEWER than this CLI (v${runningVer} > v${cliVer}) — this CLI is stale; do NOT run \`dev-loop daemon up\``;
  return ` — running OLD code v${runningVer}, CLI is v${cliVer}; run \`DEVLOOP_PROJECT=${key} dev-loop daemon up\` to restart`;
}
const DEFAULT_DAEMON_PORT = 8787;
const AUTOSTART_LABEL = "com.dyzsasd.dev-loop.daemon";
const PROBE_WARN_GAP = 8;   // warn when the probe walked more than 8 ports above the start (AC-B5)
const REAP_SCAN_PORTS = 128; // wider than the 64-port allocation band so the reaper sees beyond it (AC-B2)

// The runfile lives next to the hub DB (machine-local, never committed — ~/.dev-loop by default), one
// file per project so distinct projects never clobber each other. DEVLOOP_RUN_DIR overrides for tests.
function lcDbPath(): string { return hubDbPath(); }
function lcRunDir(): string { return process.env.DEVLOOP_RUN_DIR ?? dirname(lcDbPath()); }
function lcRunfile(key: string): string { return join(lcRunDir(), `daemon-${key}.json`); }
function lcNode(): string { return findCompatibleNode([process.execPath]) ?? process.execPath; }
function lcDaemonEntry(): string {
  const ext = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
  return fileURLToPath(new URL(`./daemon${ext}`, import.meta.url));
}
function lcReadRun(key: string): RunInfo | null {
  try { return JSON.parse(readFileSync(lcRunfile(key), "utf8")) as RunInfo; } catch { return null; }
}
function lcWriteRun(info: RunInfo): void {
  mkdirSync(lcRunDir(), { recursive: true });
  const f = lcRunfile(info.project), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2));
  renameSync(tmp, f); // atomic replace (§11 atomic-write discipline) — a partial write never yields invalid JSON
}
function lcRemoveRun(key: string): void { try { unlinkSync(lcRunfile(key)); } catch { /* already gone */ } }

// DL-46: a per-project cold-start lock. Two near-simultaneous `up`s otherwise both spawn a daemon, and the
// loser's health probe is answered by the WINNER on the SAME url — so both believe they started and both
// write the runfile (last-writer-wins records the loser's now-dead pid, orphaning the live winner; `down`
// then can't stop it). Serializing cold start under an O_EXCL lock (the §18 file-lock discipline) makes the
// second `up` wait, then re-read the runfile INSIDE the lock and find the winner already healthy → clean
// no-op, no second spawn, no write. Stale-lock recovery (holder dead, or older than staleMs) guarantees a
// crashed `up` never deadlocks the next one. DL-51: that stale-break is itself serialized under a break-mutex
// (see lcAcquireLock) so concurrent breakers can't re-admit a 2nd cold start by clobbering a fresh lock.
interface LockInfo { pid: number; at: string; }
function lcLockfile(key: string): string { return join(lcRunDir(), `daemon-${key}.lock`); }
function lcReadLockAt(path: string): LockInfo | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as LockInfo; } catch { return null; }
}
function lcReadLock(key: string): LockInfo | null { return lcReadLockAt(lcLockfile(key)); }
// staleMs MUST exceed daemonUp's worst-case in-lock hold (lcStop ≤3s + lcWaitHealthy ≤8s + probing ≈ ≤15s)
// so a legitimately-busy live holder is never broken, AND stay well under totalMs so stale-recovery wins
// before a waiter's own acquire deadline fires (else a pid-reused stale lock is breakable only at the exact
// instant the waiter gives up). 30s/60s gives ~2× margin on each side.
async function lcAcquireLock(key: string, totalMs = 60000, staleMs = 30000): Promise<() => void> {
  const lf = lcLockfile(key);
  const bf = `${lf}.break`; // DL-51: a dedicated O_EXCL break-mutex that serializes stale-lock breaking (below)
  mkdirSync(lcRunDir(), { recursive: true });
  const deadline = Date.now() + totalMs;
  const stamp = (): string => JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  // Stale ⇔ holder gone, or older than staleMs (a crashed `up`, or a dead holder whose pid got recycled).
  // `!(age <= staleMs)` (not `age > staleMs`) so a missing/corrupt `at` → NaN → stale (never trust an
  // unparseable lock to be fresh). A dead pid reads stale immediately (no need to wait out staleMs).
  const isStale = (h: LockInfo | null): boolean => {
    const age = h ? Date.now() - Date.parse(h.at) : Infinity;
    return !h || !lcIsAlive(h.pid) || !(age <= staleMs);
  };
  // Throw once we've waited out totalMs on a LIVE holder/breaker. A stale lock is always broken (the break
  // path below is never deadline-gated), so a recoverable stale lock present at the deadline is cleared and
  // acquired, not reported as a hard failure (preserving the pre-DL-51 break-past-the-deadline behavior).
  const checkDeadline = (): void => {
    if (Date.now() < deadline) return;
    const h = lcReadLock(key);
    throw new Error(`could not acquire daemon cold-start lock for '${key}'${h ? ` (held by pid ${h.pid})` : ""}`);
  };
  for (;;) {
    try {
      // `wx` = O_CREAT|O_EXCL|O_WRONLY — the OS guarantees exactly one creator wins (atomic, race-free).
      // This wx-create is the SINGLE arbiter of who acquires: the stale-break below only ever REMOVES a
      // stale lock so a wx-create can proceed — it never itself grants ownership — so two racers can never
      // both acquire, even if both decide to break.
      writeFileSync(lf, stamp(), { flag: "wx" });
      let released = false;
      // Ownership-checked release: only remove the lock if it's still OURS. If our hold somehow outlived
      // staleMs and another `up` broke + re-took it, deleting unconditionally would clobber the NEW owner's
      // lock and re-admit a concurrent cold start — so re-read and unlink only when the pid is still ours.
      return () => { if (released) return; released = true; try { if (lcReadLock(key)?.pid === process.pid) unlinkSync(lf); } catch { /* already gone */ } };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;            // a real fs error, not "held"
      if (!isStale(lcReadLock(key))) { checkDeadline(); await new Promise((r) => setTimeout(r, 100)); continue; } // live, fresh `up` — wait
      // DL-51 — break a stale lock under a dedicated O_EXCL break-mutex. Breaking lf directly is a TOCTOU that
      // re-admits a 2nd cold start (the DL-46 orphan): two `up`s both read the OLD lock stale; one breaks it and
      // wx-creates a FRESH lock, and the other's path-keyed remove (which cannot say "only if STILL the stale
      // one") then clobbers that VALID lock. Under the mutex exactly ONE racer breaks at a time and re-confirms
      // staleness while holding it: while `lf` exists nobody can wx-create over it and only the mutex-holder
      // removes it, so this read→remove only ever deletes a STILL-stale lock; a fresh lock is left intact. The
      // top-of-loop wx-create stays the SOLE arbiter of acquisition, so a break can never itself admit a second.
      try {
        writeFileSync(bf, stamp(), { flag: "wx" });                       // sole breaker
        try { if (isStale(lcReadLock(key))) { try { unlinkSync(lf); } catch { /* already gone */ } } }
        // Ownership-checked release (mirrors the lf release): only unlink bf if it's still OURS, so we never
        // clobber a mutex a racer legitimately re-took (the same hazard the lf release guards against).
        finally { try { if (lcReadLockAt(bf)?.pid === process.pid) unlinkSync(bf); } catch { /* already released */ } }
      } catch (be) {
        if ((be as { code?: string }).code !== "EEXIST") throw be;
        // Another racer holds the break-mutex: clear a dead/stale breaker (a crash mid-break can't wedge the
        // next `up`); wait out a live breaker (it holds the mutex for only a couple of fs ops).
        if (isStale(lcReadLockAt(bf))) { try { unlinkSync(bf); } catch { /* already gone */ } }
        else { checkDeadline(); await new Promise((r) => setTimeout(r, 100)); }
      }
      // loop: the stale lock (if any) is now gone → the wx-create at the top arbitrates the single acquirer.
    }
  }
}

function lcIsAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}
// Stop a pid gracefully: SIGTERM, wait up to graceMs, then escalate to SIGKILL so a wedged/slow daemon
// is never leaked. Shared by `down` and `up`'s reclaim + failed-spawn paths (one shutdown semantics).
async function lcStop(pid: number, graceMs = 3000): Promise<void> {
  if (!lcIsAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && lcIsAlive(pid)) await new Promise((r) => setTimeout(r, 100));
  if (lcIsAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ } }
}
function lcTryBind(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const s = netCreateServer();
    s.once("error", () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}
// Returns { port, exhausted } — exhausted:true when the entire probe band is occupied (AC-B5 amendment:
// the give-up fallback is indistinguishable from success on the return value alone; callers use `exhausted`
// to emit the loud remediation warning BEFORE the bind attempt surfaces EADDRINUSE).
async function lcFreePort(start: number, host: string, tries = 64): Promise<{ port: number; exhausted: boolean }> {
  for (let i = 0; i < tries; i++) {
    const p = start + i;
    if (p > 65535) break;
    if (await lcTryBind(p, host)) return { port: p, exhausted: false };
  }
  return { port: start, exhausted: true }; // give up — callers emit the remediation warning, then the daemon surfaces EADDRINUSE loudly
}
async function lcProbe(url: string, key: string, timeoutMs = 1000): Promise<boolean> {
  return !!(await lcHealthInfo(url, key, timeoutMs));
}
// Like lcProbe but returns the health body (version/actor) on success, null otherwise — so `up` can
// detect a daemon still running PRE-UPGRADE code (version ≠ this CLI's) and restart it (D1). Without
// this, an `npm i -g` upgrade never takes effect on a running detached daemon until reboot / manual down.
// LOOP-317: `pid` is carried through. The payload has always included it; dropping it here is what let
// a caller confirm "a daemon for MY project is on this port" while the process answering was not the
// one it just spawned.
async function lcHealthInfo(url: string, key: string, timeoutMs = 1000): Promise<{ version?: string; buildCommit?: string | null; actor?: string; entryPath?: string; pid?: number } | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${url}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(t));
    if (r.status !== 200) return null;
    const b = (await r.json().catch(() => null)) as { ok?: boolean; project?: string; version?: string; buildCommit?: string | null; actor?: string; entryPath?: string; pid?: number } | null;
    if (!b || b.ok !== true || b.project !== key) return null; // confirm it's OUR project on that port, not a stranger
    return { version: b.version, buildCommit: b.buildCommit, actor: b.actor, entryPath: b.entryPath, pid: b.pid };
  } catch { return null; }
}
async function lcWaitHealthy(url: string, key: string, totalMs = 8000): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await lcProbe(url, key, 800)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
// Like lcWaitHealthy but returns "dead" the moment the child is no longer alive, so a bind-race
// loser (EADDRINUSE → immediate child exit) is detected in ≤150ms instead of 8s. LOOP-76.
/**
 * Is the process answering /api/health someone OTHER than the child we just spawned? (LOOP-317)
 *
 * Exported so the decision is testable without standing up a daemon — the surrounding `up` path
 * needs a real spawn, a real port and a real bind race to reach it, and a test that has to reproduce
 * a race to check a comparison is a test that will one day pass for the wrong reason.
 *
 * An ABSENT pid accepts: an older daemon predating this field must not read as foreign, or every
 * upgrade wedges. The field has shipped in /api/health all along, so that window is narrow.
 */
export function foreignListener(answeringPid: number | undefined, ourPid: number | undefined): boolean {
  return answeringPid !== undefined && ourPid !== undefined && answeringPid !== ourPid;
}

async function lcWaitHealthyOrDead(url: string, key: string, pid: number, totalMs = 8000): Promise<"healthy" | "dead" | "timeout"> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await lcProbe(url, key, 800)) return "healthy";
    if (!lcIsAlive(pid)) return "dead";
    await new Promise((r) => setTimeout(r, 150));
  }
  return "timeout";
}
// Resolve the project key like the MCP server / DL-13 launcher: explicit DEVLOOP_PROJECT wins; else
// match cwd against the configured repo paths. null ⇒ unresolved (the caller no-ops, never guesses).
function lcResolveKey(): string | null {
  const explicit = process.env.DEVLOOP_PROJECT?.trim();
  if (explicit) return explicit; // parity with server.ts:22 — a present-but-empty/whitespace value is NOT a key
  const cfg = loadProjectsConfig();
  return cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null;
}

// Bind DEVLOOP_RUN_DIR / DEVLOOP_HUB_DB to the active workspace before a bare daemon verb reads the
// runfile store — closing the seam where `hub status` lists a daemon the bare verbs can't reach
// (LOOP-152 defect 2). Fills in only what is UNSET; an explicit caller-supplied value is honored
// (the LOOP-117 shape: doctor.ts:63 — never hub.ts:wireEnv which overwrites unconditionally).
// Falls back cleanly when no workspace resolves (bare-machine / test with explicit env).
function resolveDaemonContext(): void {
  if (process.env.DEVLOOP_RUN_DIR && process.env.DEVLOOP_HUB_DB) return;
  const ws = tryResolveWorkspace();
  if (!ws) return;
  if (!process.env.DEVLOOP_RUN_DIR) process.env.DEVLOOP_RUN_DIR = wsStateRoot(ws);
  if (!process.env.DEVLOOP_HUB_DB) process.env.DEVLOOP_HUB_DB = wsHubDb(ws);
}

export async function daemonUpForKey(key: string): Promise<number> {
  // Serveable ⇔ seeded in the hub DB. A non-service / unknown project is never in the hub ⇒ clean no-op.
  const dbPath = lcDbPath();
  let serveable = false;
  try { const probe = openDb(dbPath); try { serveable = !!findProject(probe, key); } finally { probe.close(); } } catch { serveable = false; }
  if (!serveable) { console.log(`[daemon] up: '${key}' is not a service-backend hub project (not seeded) — nothing to start.`); return 0; }

  const host = "127.0.0.1"; // §16 localhost-only
  // Fast path (lock-free): a healthy daemon is already running ⇒ no-op without taking the lock. This is the
  // common case (the DL-42 hook fires `up` on every pane, but the daemon is usually already up), so routine
  // `up`s never serialize on the lock — only an actual cold start does.
  const pre = lcReadRun(key);
  if (pre && lcIsAlive(pre.pid)) {
    const info = await lcHealthInfo(pre.url, key);
    if (info && sameDaemonCode(pkgVersion(), pkgBuildCommit(), info.version, info.buildCommit)) {
      console.log(`[daemon] up: already running for '${key}' → ${pre.url} (pid ${pre.pid})`);
      return 0;
    }
    if (info && info.version && semverBefore(pkgVersion(), info.version)) {
      // Running daemon is NEWER than this CLI — refuse to downgrade it.
      const runningFrom = info.entryPath ?? pre.entryPath ?? "(unknown tree)";
      process.stderr.write(`[daemon] up: '${key}' daemon is NEWER than this CLI (v${info.version} > v${pkgVersion()}) — this CLI is stale; refusing to downgrade\n  running daemon: ${runningFrom}\n  this caller:    ${lcDaemonEntry()}\n`);
      return 1;
    }
    if (info) console.log(`[daemon] up: '${key}' is running old code (v${info.version || "?"} < v${pkgVersion()}) — restarting to pick up the upgrade`);
    // else: bound but unhealthy — fall through to the locked cold-start path, which stops + respawns it.
  }
  // DL-46: serialize cold start under the per-project lock — the second concurrent `up` waits here, then
  // re-reads the runfile below and no-ops on the winner (no second spawn, no last-writer-wins runfile race).
  let release: () => void;
  try { release = await lcAcquireLock(key); }
  catch (e) { console.error(`[daemon] up: ${(e as Error).message}`); return 1; }
  try {
    const existing = lcReadRun(key);
    if (existing && lcIsAlive(existing.pid)) {
      const info = await lcHealthInfo(existing.url, key);
      if (info && sameDaemonCode(pkgVersion(), pkgBuildCommit(), info.version, info.buildCommit)) { console.log(`[daemon] up: already running for '${key}' → ${existing.url} (pid ${existing.pid})`); return 0; }
      if (info && info.version && semverBefore(pkgVersion(), info.version)) {
        const runningFrom = info.entryPath ?? existing.entryPath ?? "(unknown tree)";
        process.stderr.write(`[daemon] up: '${key}' daemon is NEWER than this CLI (v${info.version} > v${pkgVersion()}) — this CLI is stale; refusing to downgrade\n  running daemon: ${runningFrom}\n  this caller:    ${lcDaemonEntry()}\n`);
        return 1;
      }
      // Either not answering /api/health (a bound-but-wedged daemon) OR running old code — stop it
      // (SIGTERM→SIGKILL) so we cleanly restart on its port rather than no-op onto a dead / stale process.
      await lcStop(existing.pid);
    }
    // port: explicit env override > recorded (stable across restarts) > fixed default 8787.
    // For an explicit port we spawn once and trust it (user pinned it deliberately). For the auto case
    // we retry across the port space: lcFreePort's probe and the daemon's real bind are not atomic
    // (TOCTOU), so a concurrent cold start for another workspace can steal the same port between the
    // probe and the spawn. On child death before healthy we move to the next candidate. LOOP-76.
    const envPort = process.env.DEVLOOP_DAEMON_PORT ? Number(process.env.DEVLOOP_DAEMON_PORT) : 0;

    // Spawn the daemon ENTRY POINT — the foreground boot lives in daemon.ts/daemon.js (this module's
    // sibling), so resolve it relative to here. TypeScript's import rewriter does not touch string
    // literals inside new URL(...), so choose the extension at runtime: .ts in a source checkout, .js in
    // the published npm package. This is the npm-installed daemon-start regression guard.
    const node = lcNode();
    const self = lcDaemonEntry();
    mkdirSync(lcRunDir(), { recursive: true });

    const startPort = envPort > 0 ? envPort : (existing?.port || DEFAULT_DAEMON_PORT);
    const maxTries = envPort > 0 ? 1 : 64;
    // Port-probe warning (AC-B5/B6): scan before spawning so the operator sees the remedy BEFORE the bind.
    // The pre-probe and the spawn loop are intentionally separate — lcFreePort is NOT atomic with the
    // actual bind (TOCTOU), so the spawn loop below still handles port conflicts correctly.
    if (envPort === 0) {
      const probe = await lcFreePort(startPort, host, maxTries);
      if (probe.exhausted) {
        // AC-B6: distinct louder line when the entire band is occupied
        process.stderr.write(`[daemon] up: port band ${startPort}..${startPort + maxTries - 1} fully occupied (${maxTries} ports checked) — run 'dev-loop daemon reap' to remove stale orphan daemons\n`);
      } else if (probe.port - startPort > PROBE_WARN_GAP) {
        process.stderr.write(`[daemon] up: port walked to ${probe.port} (${probe.port - startPort} above start ${startPort}) — run 'dev-loop daemon reap' to remove stale orphan daemons\n`);
      }
    }
    for (let i = 0; i < maxTries; i++) {
      const port = startPort + i;
      if (port > 65535) break;
      if (envPort === 0 && !(await lcTryBind(port, host))) continue; // skip definitely-bound ports
      const url = `http://${host}:${port}`;
      const logFd = openSync(join(lcRunDir(), `daemon-${key}.log`), "a");
      const child = spawn(node, [self], {
        detached: true,                                   // survive the launching session (DL-42 hook)
        stdio: ["ignore", logFd, logFd],
        // Pin DEVLOOP_ACTOR=operator (D5): `up` is often invoked from an agent fire's env (the SessionStart
        // hook, an inherited scheduler fire) where DEVLOOP_ACTOR=<agent>. Without pinning, the daemon adopts
        // that actor — silently mis-attributing human writes and mis-gating publish (operator-only). The
        // daemon is operator-owned infrastructure regardless of who happened to trigger `up`.
        // Pin DEVLOOP_ACTOR=operator (D5 — same class for DEVLOOP_FIRE_ID, LOOP-75):
        // `up` is often invoked from a fire's env inheriting DEVLOOP_FIRE_ID; the daemon is operator-owned
        // infrastructure, not a fire — it must never claim a stale fire id (silently-wrong attribution is
        // worse than absent: analytics would attribute all daemon-internal events to one arbitrary fire).
        env: { ...process.env, DEVLOOP_ACTOR: "operator", DEVLOOP_FIRE_ID: "", DEVLOOP_NODE: node, DEVLOOP_PROJECT: key, DEVLOOP_DAEMON_PORT: String(port), DEVLOOP_HUB_DB: dbPath },
      });
      child.unref();
      closeSync(logFd);
      if (!child.pid) { console.error("[daemon] up: failed to spawn the daemon process."); return 1; }
      const result = envPort > 0
        ? ((await lcWaitHealthy(url, key)) ? "healthy" : "timeout")
        : await lcWaitHealthyOrDead(url, key, child.pid);
      if (result === "healthy") {
        const started = await lcHealthInfo(url, key); // record what actually came up (version/actor) for `status` + upgrade detection
        // LOOP-317 — HEALTH AT A URL IS NOT PROOF THAT OUR CHILD IS SERVING IT.
        //
        // The root cause of the orphan this suite exists to catch: lcTryBind and the child's real bind
        // are not atomic (the TOCTOU the comment above already names), so another cold start — or a
        // survivor of a previous `down` — can hold this port. Our child then dies with EADDRINUSE
        // while `lcProbe(url)` answers HEALTHY from the OTHER process. The project key matched,
        // because it is the same project. We would then write OUR (dying) pid into the runfile while
        // the live listener is someone else's process: the runfile records a pid that is not the
        // listener, `down` kills the wrong thing, and the real daemon is orphaned.
        //
        // Measured shape, CI run 30920347062 trial 5: the runfile pid was not the live listener, and
        // `down` left :8787 serving for the full 4s waitGone deadline.
        //
        // So: require the ANSWERING pid to be the child we spawned. Absent pid ⇒ accept, because an
        // older daemon predating this field must not be treated as foreign (it would wedge every
        // upgrade); the field has shipped in /api/health all along, so that window is narrow.
        if (foreignListener(started?.pid, child.pid)) {
          await lcStop(child.pid); // our child lost the bind race — never leave it running
          if (envPort > 0) {
            console.error(`[daemon] up: port ${port} is served by another daemon for '${key}' (pid ${started?.pid}), not the one just spawned — refusing to record a runfile that would orphan it.`);
            return 1;
          }
          continue; // auto-port: walk to the next candidate rather than record a foreign listener
        }
        lcWriteRun({ project: key, pid: child.pid, port, host, url, startedAt: new Date().toISOString(), version: started?.version ?? pkgVersion(), buildCommit: started?.buildCommit ?? null, actor: started?.actor ?? "operator", entryPath: started?.entryPath ?? self });
        console.log(`[daemon] up: started '${key}' → ${url} (pid ${child.pid})`);
        return 0;
      }
      await lcStop(child.pid); // never leak a slow/wedged child — escalate to SIGKILL if SIGTERM doesn't take
      if (result === "dead") continue; // child exited before healthy (EADDRINUSE bind race) — try next port
      // "timeout": daemon spawned but never answered — not a bind race, a real startup failure
      console.error(`[daemon] up: spawned daemon for '${key}' did not become healthy at ${url} (see ${join(lcRunDir(), `daemon-${key}.log`)}).`);
      return 1;
    }
    console.error(`[daemon] up: could not bind a port for '${key}' — exhausted ${maxTries} candidate(s) from ${startPort}.`);
    return 1;
  } finally {
    release();
  }
}

async function daemonUp(): Promise<number> {
  resolveDaemonContext();
  const key = lcResolveKey();
  if (!key) { console.log("[daemon] up: no project resolved from cwd and DEVLOOP_PROJECT is unset — nothing to start."); return 0; }
  return daemonUpForKey(key);
}

// The exact set `up-all` will start, and the workspace it came from. Exported so AC3 — "a project
// belonging to a DIFFERENT workspace is not started" — can be asserted without spawning daemons.
// The binding arrives purely as env (DEVLOOP_WORKSPACE) + cwd, i.e. what launchd hands the process.
export function upAllServiceKeys(): { workspace: string | null; keys: string[] } {
  resolveDaemonContext();
  const ws = tryResolveWorkspace();
  const cfg = loadProjectsConfig();
  const entries = Object.entries(cfg?.projects ?? {}) as Array<[string, { backend?: string }]>;
  return { workspace: ws?.root ?? null, keys: entries.filter(([, p]) => p.backend === "service").map(([key]) => key) };
}

async function daemonUpAll(): Promise<number> {
  const { workspace, keys: serviceKeys } = upAllServiceKeys();
  if (!serviceKeys.length) {
    console.log(`[daemon] up-all: no backend:"service" projects configured in ${devloopProjectsPath()}.`);
    return 0;
  }
  console.log(`[daemon] up-all: starting ${serviceKeys.length} service project(s) of workspace ${workspace ?? "(unresolved)"}: ${serviceKeys.join(", ")}`);
  let code = 0;
  for (const key of serviceKeys) {
    const c = await daemonUpForKey(key);
    if (c !== 0) code = c;
  }
  return code;
}

async function daemonDown(): Promise<number> {
  resolveDaemonContext();
  const key = lcResolveKey();
  if (!key) { console.log("[daemon] down: no project resolved — nothing to stop."); return 0; }
  const info = lcReadRun(key);
  if (!info) { console.log(`[daemon] down: no daemon recorded for '${key}'.`); return 0; }
  if (lcIsAlive(info.pid)) {
    await lcStop(info.pid); // SIGTERM→SIGKILL; stops a wedged daemon too (down must work even when unhealthy)
    console.log(`[daemon] down: stopped '${key}' (pid ${info.pid}).`);
  } else {
    console.log(`[daemon] down: '${key}' was not running (stale runfile cleared).`);
  }
  lcRemoveRun(key);
  return 0;
}

async function daemonStatus(): Promise<number> {
  resolveDaemonContext();
  // AC4 (LOOP-469): which workspace the login item will start, printed before anything else and in
  // EVERY branch below — a binding you must read a plist to discover is not a readable decision.
  if (platform() === "darwin") console.log(`[daemon] ${describeAutostartBinding(readAutostartBinding())}`);
  const key = lcResolveKey();
  if (!key) { console.log("[daemon] status: no project resolved (DEVLOOP_PROJECT unset, cwd outside every repo). Set DEVLOOP_PROJECT=<key>, or run from inside a configured repo."); return 0; }
  const info = lcReadRun(key);
  if (info && lcIsAlive(info.pid)) {
    const live = await lcHealthInfo(info.url, key);
    if (live) {
      const ver = live.version || info.version || "?";
      const buildCommit = live.buildCommit ?? info.buildCommit ?? null;
      const stale = formatVersionStatus(ver, buildCommit, pkgVersion(), pkgBuildCommit(), key);
      const actor = live.actor || info.actor;
      const misId = actor && actor !== "operator" ? ` — WARNING actor='${actor}' (not operator; publish/attribution may be mis-gated)` : "";
      const ep = live.entryPath ?? info.entryPath;
      const epLine = ep ? `\n  entry: ${ep}` : "";
      console.log(`[daemon] status: '${key}' RUNNING → ${info.url} (pid ${info.pid}, v${ver}, actor=${actor ?? "?"})${stale}${misId}${epLine}`);
      return 0;
    }
  }
  if (info && !lcIsAlive(info.pid)) lcRemoveRun(key); // a dead pid must never read as "running" — clear it
  console.log(`[daemon] status: '${key}' stopped. Start it with \`DEVLOOP_PROJECT=${key} dev-loop daemon up\`.`);
  return 0;
}

export function launchAgentPath(): string {
  return join(process.env.HOME || "", "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
}

function plistEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
// `&amp;` LAST: escaping "&lt;" yields "&amp;lt;", which contains no "&lt;" substring, so the
// entity-first order can never double-unescape.
function plistUnescape(s: string): string {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

// ─── Autostart binding (LOOP-469, design `state-locality` I1 second half) ─────
// An autostart binding must be a WRITTEN, READABLE decision. The plist names exactly ONE workspace
// (`WorkingDirectory` + `DEVLOOP_WORKSPACE`); it no longer snapshots the install shell's ambient
// DEVLOOP_HOME / DEVLOOP_PROJECTS_JSON / DEVLOOP_HUB_DB / DEVLOOP_RUN_DIR. Those four each override
// workspace resolution — `loadProjectsConfig()` short-circuits on DEVLOOP_PROJECTS_JSON and
// `resolveDaemonContext()` short-circuits on DEVLOOP_RUN_DIR+DEVLOOP_HUB_DB — so carrying them
// forward would make DEVLOOP_WORKSPACE inert and let a shell that no longer exists decide which
// board the login item serves. That is the incident. DEVLOOP_NODE is the one legitimate carry-over:
// it names the interpreter, not a workspace.
export const AUTOSTART_CARRIED_ENV = ["DEVLOOP_NODE"] as const;

// Pure renderer — no fs, no launchctl — so the plist's CONTENT is directly assertable (AC2/AC5).
export function autostartPlistXml(o: {
  node: string; entry: string; workspace: string; logDir: string; carriedEnv?: Record<string, string>;
}): string {
  const env: Record<string, string> = { DEVLOOP_WORKSPACE: o.workspace, ...(o.carriedEnv ?? {}) };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${plistEscape(k)}</key><string>${plistEscape(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(o.node)}</string>
    <string>${plistEscape(o.entry)}</string>
    <string>up-all</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>${plistEscape(o.workspace)}</string>
  <key>StandardOutPath</key><string>${plistEscape(join(o.logDir, "daemon-autostart.out.log"))}</string>
  <key>StandardErrorPath</key><string>${plistEscape(join(o.logDir, "daemon-autostart.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

export interface AutostartBinding {
  installed: boolean;
  plist: string;
  /** The bound workspace root; null when a plist exists but names none (pre-LOOP-469 format). */
  workspace: string | null;
}

// AC4: the binding is readable without parsing the plist by hand. One reader, two consumers
// (`daemon status` and doctor's reconcileAutostart), so the two can never disagree.
export function readAutostartBinding(plistPath: string = launchAgentPath()): AutostartBinding {
  if (!existsSync(plistPath)) return { installed: false, plist: plistPath, workspace: null };
  let xml: string;
  try { xml = readFileSync(plistPath, "utf8"); } catch { return { installed: true, plist: plistPath, workspace: null }; }
  const fromEnv = /<key>DEVLOOP_WORKSPACE<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  const fromWd = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  const raw = fromEnv?.[1] ?? fromWd?.[1] ?? null;
  return { installed: true, plist: plistPath, workspace: raw === null ? null : plistUnescape(raw) };
}

export function describeAutostartBinding(b: AutostartBinding): string {
  if (!b.installed)
    return "daemon autostart — no login item installed (the default; run `dev-loop daemon install-autostart` inside a workspace to opt in)";
  if (!b.workspace)
    return `daemon autostart — installed at ${b.plist} but bound to NO workspace (pre-LOOP-469 plist: it starts whatever the install shell exported); re-run \`dev-loop daemon install-autostart\` to bind one`;
  return `daemon autostart — installed, bound to workspace ${b.workspace} → ${b.plist}`;
}

function autostartWorkspaceArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") return argv[i + 1] ?? "";
    if (a.startsWith("--workspace=")) return a.slice("--workspace=".length);
  }
  return undefined;
}

const AUTOSTART_HOWTO = "Name one explicitly — `dev-loop daemon install-autostart --workspace <workspace-root>` — or cd into a workspace (a directory holding dev-loop.json) and re-run.";

// Returns the workspace root to bind, or null after printing WHY it refused. Never writes anything:
// AC1's "must not write a plist" is a property of the caller ordering, so resolution comes first.
function resolveAutostartWorkspace(argv: string[]): string | null {
  const arg = autostartWorkspaceArg(argv);
  if (arg !== undefined) {
    if (!arg || arg.startsWith("--")) {
      console.error("[daemon] install-autostart: --workspace needs a directory path. No plist was written.");
      return null;
    }
    const abs = isAbsolute(arg) ? arg : resolvePath(process.cwd(), arg);
    if (!existsSync(join(abs, "dev-loop.json"))) {
      console.error(`[daemon] install-autostart: ${abs} is not a workspace (no dev-loop.json). No plist was written.`);
      return null;
    }
    try { return realpathSync(abs); } catch { return abs; }
  }
  let ws = null;
  try { ws = tryResolveWorkspace(); } catch (e) {
    console.error(`[daemon] install-autostart: ${(e as Error).message}`);
    console.error(`[daemon] ${AUTOSTART_HOWTO} No plist was written.`);
    return null;
  }
  if (ws) return ws.root;
  console.error("[daemon] install-autostart: no workspace resolved — refusing to install a login item that would start a project set nobody chose.");
  console.error(`[daemon] ${AUTOSTART_HOWTO} No plist was written.`);
  return null;
}

// Ordering is the contract, not a style choice. Argument validation and the `--dry-run` RENDER are
// platform-independent — refusing an unresolvable workspace is an argument fault, and rendering the
// plist writes nothing and invokes no launchctl. Only the side-effecting half (write the file, load
// it into launchd) needs macOS. Gating the whole verb on darwin, as this did, made the binding a
// login item WOULD carry unobservable anywhere but a Mac — including on the Linux CI that gates
// every merge, where it left the ambient-env regression this ticket exists to prevent unasserted.
function installAutostart(argv: string[] = []): number {
  const root = resolveAutostartWorkspace(argv);
  if (!root) return 1; // AC1 — refused; nothing written
  const plist = launchAgentPath();
  const logDir = join(root, ".dev-loop"); // logs follow the BINDING, not the installing shell's run dir
  const node = lcNode();
  const self = lcDaemonEntry();
  const carriedEnv: Record<string, string> = {};
  for (const k of AUTOSTART_CARRIED_ENV) if (process.env[k]) carriedEnv[k] = process.env[k]!;
  const xml = autostartPlistXml({ node, entry: self, workspace: root, logDir, carriedEnv });
  // `--dry-run`: show the operator the exact binding before it becomes a login item. Writes nothing
  // and runs no launchctl, so it is also the only safe way to assert plist CONTENT in a test —
  // the real path installs a live LaunchAgent on the machine running it.
  if (argv.includes("--dry-run")) {
    console.log(`[daemon] install-autostart --dry-run: would bind workspace ${root} and write ${plist}:`);
    console.log(xml);
    return 0;
  }
  if (platform() !== "darwin") {
    console.error("[daemon] install-autostart currently supports macOS LaunchAgent only.");
    console.error("[daemon] `--dry-run` renders the binding on any OS; run `dev-loop daemon up-all` from systemd/cron to autostart here.");
    return 1;
  }
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plist, xml);
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plist], { stdio: "ignore" }); } catch { /* not loaded */ }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist], { stdio: "inherit" });
  execFileSync("launchctl", ["enable", `gui/${process.getuid!()}/${AUTOSTART_LABEL}`], { stdio: "inherit" });
  console.log(`[daemon] autostart installed → ${plist}`);
  console.log(`[daemon] bound workspace: ${root} (WorkingDirectory + DEVLOOP_WORKSPACE).`);
  console.log(`[daemon] LaunchAgent runs \`${node} ${self} up-all\` at login for THAT workspace's backend:"service" projects only.`);
  return 0;
}

function uninstallAutostart(): number {
  if (platform() !== "darwin") {
    console.error("[daemon] uninstall-autostart currently supports macOS LaunchAgent only.");
    return 1;
  }
  const plist = launchAgentPath();
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plist], { stdio: "ignore" }); } catch { /* not loaded */ }
  try { unlinkSync(plist); } catch { /* already gone */ }
  console.log(`[daemon] autostart removed → ${plist}`);
  return 0;
}

// Exported so server.ts (the `dev-loop-hub` bin) can delegate `dev-loop-hub daemon <sub>` to this SAME
// lifecycle (the named command the DL-42 hook invokes), and daemon.ts's top-level CLI dispatch can route
// `node src/daemon.ts <sub>` here. Both importers are side-effect-free: this module has no top-level boot,
// and daemon.ts's dispatch/foreground guards key on argv[1]===daemon.ts (false when server.ts is the entry).
// `ensure` is an accepted alias for `up` (the design's `daemon ensure` — idempotent one-per-project start).
// Ownership rule (LOOP-95 reaper — keep verbatim): reap a listener iff BOTH:
//   (a) it self-identifies via /api/health as service:"dev-loop-hub"; AND
//   (b) it reports dbPresent:false.
// Never touch: a no-marker listener (foreign server) OR a marked daemon with dbPresent:true (a LIVE board —
// including another workspace's). Age, port, and fixture-name heuristics are never consulted.
async function lcReapInfo(url: string): Promise<{ pid: number; project: string; version?: string; dbPresent: boolean } | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1200);
  // P2 fix (PRRT_kwDOS6Puk86VoEUp): clear the timer only AFTER body consumption, not after headers.
  // A stalling foreign listener that sends headers instantly but delays the body would hang r.json()
  // indefinitely if we cleared the timer in a fetch .finally (which fires when headers arrive).
  // The outer try/finally keeps the timer alive through r.json() and then cleans it up.
  try {
    const r = await fetch(`${url}/api/health`, { signal: ac.signal });
    if (r.status !== 200 && r.status !== 503) return null; // only ok:true(200) and ok:false(503) carry the identity fields
    const b = (await r.json().catch(() => null)) as { service?: string; pid?: number; project?: string; version?: string; dbPresent?: boolean } | null;
    if (!b || b.service !== "dev-loop-hub" || typeof b.pid !== "number" || typeof b.dbPresent !== "boolean") return null;
    return { pid: b.pid, project: b.project ?? "", version: b.version, dbPresent: b.dbPresent };
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function daemonReap(opts: { dryRun?: boolean; host?: string } = {}): Promise<number> {
  const host = opts.host ?? "127.0.0.1";
  const dryRun = opts.dryRun ?? false;
  const bandStart = DEFAULT_DAEMON_PORT;
  const bandEnd = DEFAULT_DAEMON_PORT + REAP_SCAN_PORTS - 1;

  // P2 fix (LOOP-95): collect extra ports that lifecycle can allocate outside the fixed band.
  // (a) Any port recorded in a workspace runfile — daemons that landed outside the band on a
  //     restart from an existing.port near the top are captured this way.
  // (b) DEVLOOP_DAEMON_PORT if set — an explicit env override can point anywhere.
  const extraPorts = new Set<number>();
  // P2 fix (PRRT_kwDOS6Puk86VoEUq): only read runfiles when DEVLOOP_RUN_DIR is explicit. Without it
  // lcRunDir() falls back to dirname(lcDbPath()) which resolves from DEVLOOP_HUB_DB or the home .dev-loop
  // dir — NOT the current workspace — so reap would read orphan records from a different workspace.
  // An explicit DEVLOOP_RUN_DIR (set by `resolveDaemonContext` in the `up`/`down`/`status` paths)
  // means the caller has already resolved the workspace and the runfiles are authoritative.
  if (process.env.DEVLOOP_RUN_DIR) {
    const runDir = lcRunDir(); // resolves to DEVLOOP_RUN_DIR when set
    let runFiles: string[] = [];
    try { runFiles = readdirSync(runDir).filter((f) => /^daemon-.+\.json$/.test(f)); } catch { /* dir absent */ }
    for (const f of runFiles) {
      try {
        const info = JSON.parse(readFileSync(join(runDir, f), "utf8")) as RunInfo;
        if (typeof info.port === "number" && (info.port < bandStart || info.port > bandEnd)) extraPorts.add(info.port);
      } catch { /* malformed — skip */ }
    }
  }
  const envPort = process.env.DEVLOOP_DAEMON_PORT ? Number(process.env.DEVLOOP_DAEMON_PORT) : 0;
  if (envPort > 0 && (envPort < bandStart || envPort > bandEnd)) extraPorts.add(envPort);

  const extraList = [...extraPorts].sort((a, b) => a - b);
  console.log(`[daemon] reap: scanning ${host}:${bandStart}..${bandEnd}${extraList.length ? ` + extra ports ${extraList.join(",")}` : ""}${dryRun ? " (dry-run)" : ""}`);

  const bandUrls = Array.from({ length: REAP_SCAN_PORTS }, (_, i) => `http://${host}:${DEFAULT_DAEMON_PORT + i}`);
  const extraUrls = extraList.map((p) => `http://${host}:${p}`);
  const allUrls = [...bandUrls, ...extraUrls];

  const results = await Promise.all(allUrls.map((url) => lcReapInfo(url)));
  let reaped = 0, kept = 0;
  for (let i = 0; i < allUrls.length; i++) {
    const info = results[i];
    if (!info) continue; // no dev-loop-hub at this port
    if (info.dbPresent) {
      console.log(`[daemon] reap: KEEP ${allUrls[i]} (pid ${info.pid}, project '${info.project}') — dbPresent:true (live board)`);
      kept++;
    } else {
      if (dryRun) {
        console.log(`[daemon] reap: WOULD REAP ${allUrls[i]} (pid ${info.pid}, project '${info.project}') — dbPresent:false`);
      } else {
        // P3 fix (LOOP-95): re-probe immediately before killing to guard against PID reuse if a
        // prior lcStop caused a delay and the OS recycled the PID to an unrelated process.
        const recheck = await lcReapInfo(allUrls[i]);
        if (!recheck || recheck.pid !== info.pid || recheck.dbPresent) {
          console.log(`[daemon] reap: SKIPPED ${allUrls[i]} (pid changed or no longer stale since initial scan)`);
          continue;
        }
        console.log(`[daemon] reap: REAPING ${allUrls[i]} (pid ${info.pid}, project '${info.project}') — dbPresent:false`);
        await lcStop(info.pid);
      }
      reaped++;
    }
  }
  if (reaped === 0 && kept === 0) console.log("[daemon] reap: no dev-loop-hub listeners found in band (nothing to reap)");
  else console.log(`[daemon] reap: ${dryRun ? "would reap" : "reaped"} ${reaped}, kept ${kept}`);
  return 0;
}

export type LifecycleSub = "up" | "ensure" | "up-all" | "down" | "status" | "reap" | "install-autostart" | "uninstall-autostart";
export const LIFECYCLE_SUBS: readonly LifecycleSub[] = ["up", "ensure", "up-all", "down", "status", "reap", "install-autostart", "uninstall-autostart"];
// The exit-code core, exported so composable callers (e.g. `dev-loop hub stop` → down + WAL checkpoint)
// can run a lifecycle op WITHOUT the process.exit that daemonLifecycle applies.
export async function daemonLifecycleCode(sub: LifecycleSub): Promise<number> {
  return sub === "up" || sub === "ensure" ? await daemonUp()
    : sub === "up-all" ? await daemonUpAll()
    : sub === "down" ? await daemonDown()
    : sub === "status" ? await daemonStatus()
    : sub === "reap" ? await daemonReap({ dryRun: process.argv.includes("--dry-run") })
    : sub === "install-autostart" ? installAutostart(process.argv.slice(2))
    : uninstallAutostart();
}
export async function daemonLifecycle(sub: LifecycleSub): Promise<void> {
  process.exit(await daemonLifecycleCode(sub));
}

// Lists all daemon-*.json runfiles in the workspace run dir and prints each one's status.
// Used by `dev-loop hub status` to show every project daemon in the workspace (not just _team).
export async function daemonStatusAll(): Promise<number> {
  const runDir = lcRunDir();
  let files: string[];
  try { files = readdirSync(runDir).filter((f) => /^daemon-.+\.json$/.test(f)).sort(); }
  catch { files = []; }
  if (!files.length) {
    console.log("[daemon] status: no daemon runfiles in this workspace — no daemons started yet.");
    return 0;
  }
  for (const f of files) {
    const key = f.slice("daemon-".length, -".json".length);
    const info = lcReadRun(key);
    if (info && lcIsAlive(info.pid)) {
      const live = await lcHealthInfo(info.url, key);
      if (live) {
        const ver = live.version || info.version || "?";
        const buildCommit = live.buildCommit ?? info.buildCommit ?? null;
        const stale = formatVersionStatus(ver, buildCommit, pkgVersion(), pkgBuildCommit(), key);
        const actor = live.actor || info.actor;
        const misId = actor && actor !== "operator" ? ` — WARNING actor='${actor}' (not operator; publish/attribution may be mis-gated)` : "";
        const ep = live.entryPath ?? info.entryPath;
        const epLine = ep ? `\n  entry: ${ep}` : "";
        console.log(`[daemon] status: '${key}' RUNNING → ${info.url} (pid ${info.pid}, v${ver}, actor=${actor ?? "?"})${stale}${misId}${epLine}`);
      } else {
        console.log(`[daemon] status: '${key}' RUNNING (pid ${info.pid}) → ${info.url} — probe failed; run \`DEVLOOP_PROJECT=${key} dev-loop daemon up\` to restart`);
      }
    } else {
      if (info && !lcIsAlive(info.pid)) lcRemoveRun(key);
      console.log(`[daemon] status: '${key}' stopped. Start it with \`DEVLOOP_PROJECT=${key} dev-loop daemon up\`.`);
    }
  }
  return 0;
}
