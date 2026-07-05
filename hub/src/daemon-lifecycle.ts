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
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";
import { loadProjectsConfig, resolveProjectFromCwd } from "./resolve-project.ts";
import { findCompatibleNode } from "./node-runtime.ts";
import { devloopProjectsPath, hubDbPath, pkgVersion } from "./paths.ts";

interface RunInfo { project: string; pid: number; port: number; host: string; url: string; startedAt: string; version?: string; actor?: string; }
const DEFAULT_DAEMON_PORT = 8787;
const AUTOSTART_LABEL = "com.dyzsasd.dev-loop.daemon";

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
async function lcFreePort(start: number, host: string, tries = 64): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const p = start + i;
    if (p > 65535) break;
    if (await lcTryBind(p, host)) return p;
  }
  return start; // give up probing — the spawned daemon will surface EADDRINUSE loudly rather than silently
}
async function lcProbe(url: string, key: string, timeoutMs = 1000): Promise<boolean> {
  return !!(await lcHealthInfo(url, key, timeoutMs));
}
// Like lcProbe but returns the health body (version/actor) on success, null otherwise — so `up` can
// detect a daemon still running PRE-UPGRADE code (version ≠ this CLI's) and restart it (D1). Without
// this, an `npm i -g` upgrade never takes effect on a running detached daemon until reboot / manual down.
async function lcHealthInfo(url: string, key: string, timeoutMs = 1000): Promise<{ version?: string; actor?: string } | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`${url}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(t));
    if (r.status !== 200) return null;
    const b = (await r.json().catch(() => null)) as { ok?: boolean; project?: string; version?: string; actor?: string } | null;
    if (!b || b.ok !== true || b.project !== key) return null; // confirm it's OUR project on that port, not a stranger
    return { version: b.version, actor: b.actor };
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
// Resolve the project key like the MCP server / DL-13 launcher: explicit DEVLOOP_PROJECT wins; else
// match cwd against the configured repo paths. null ⇒ unresolved (the caller no-ops, never guesses).
function lcResolveKey(): string | null {
  const explicit = process.env.DEVLOOP_PROJECT?.trim();
  if (explicit) return explicit; // parity with server.ts:22 — a present-but-empty/whitespace value is NOT a key
  const cfg = loadProjectsConfig();
  return cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null;
}

async function daemonUpForKey(key: string): Promise<number> {
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
    if (info && (info.version ?? "") === pkgVersion()) {
      console.log(`[daemon] up: already running for '${key}' → ${pre.url} (pid ${pre.pid})`);
      return 0;
    }
    if (info) console.log(`[daemon] up: '${key}' is running old code (v${info.version || "?"} ≠ v${pkgVersion()}) — restarting to pick up the upgrade`);
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
      if (info && (info.version ?? "") === pkgVersion()) { console.log(`[daemon] up: already running for '${key}' → ${existing.url} (pid ${existing.pid})`); return 0; }
      // Either not answering /api/health (a bound-but-wedged daemon) OR running pre-upgrade code — stop it
      // (SIGTERM→SIGKILL) so we cleanly restart on its port rather than no-op onto a dead / stale process.
      await lcStop(existing.pid);
    }
    // port: explicit env override > recorded (stable across restarts) > fixed default 8787; probe for free.
    const envPort = process.env.DEVLOOP_DAEMON_PORT ? Number(process.env.DEVLOOP_DAEMON_PORT) : 0;
    const port = envPort > 0 ? envPort : await lcFreePort(existing?.port || DEFAULT_DAEMON_PORT, host);
    const url = `http://${host}:${port}`;

    // Spawn the daemon ENTRY POINT — the foreground boot lives in daemon.ts/daemon.js (this module's
    // sibling), so resolve it relative to here. TypeScript's import rewriter does not touch string
    // literals inside new URL(...), so choose the extension at runtime: .ts in a source checkout, .js in
    // the published npm package. This is the npm-installed daemon-start regression guard.
    const node = lcNode();
    const self = lcDaemonEntry();
    mkdirSync(lcRunDir(), { recursive: true });
    const logFd = openSync(join(lcRunDir(), `daemon-${key}.log`), "a");
    const child = spawn(node, [self], {
      detached: true,                                   // survive the launching session (DL-42 hook)
      stdio: ["ignore", logFd, logFd],
      // Pin DEVLOOP_ACTOR=operator (D5): `up` is often invoked from an agent fire's env (the SessionStart
      // hook, an inherited scheduler fire) where DEVLOOP_ACTOR=<agent>. Without pinning, the daemon adopts
      // that actor — silently mis-attributing human writes and mis-gating publish (operator-only). The
      // daemon is operator-owned infrastructure regardless of who happened to trigger `up`.
      env: { ...process.env, DEVLOOP_ACTOR: "operator", DEVLOOP_NODE: node, DEVLOOP_PROJECT: key, DEVLOOP_DAEMON_PORT: String(port), DEVLOOP_HUB_DB: dbPath },
    });
    child.unref();
    closeSync(logFd);
    if (!child.pid) { console.error("[daemon] up: failed to spawn the daemon process."); return 1; }

    if (!(await lcWaitHealthy(url, key))) {
      console.error(`[daemon] up: spawned daemon for '${key}' did not become healthy at ${url} (see ${join(lcRunDir(), `daemon-${key}.log`)}).`);
      await lcStop(child.pid); // never leak a slow/wedged child — escalate to SIGKILL if SIGTERM doesn't take
      return 1;
    }
    const started = await lcHealthInfo(url, key); // record what actually came up (version/actor) for `status` + upgrade detection
    lcWriteRun({ project: key, pid: child.pid, port, host, url, startedAt: new Date().toISOString(), version: started?.version ?? pkgVersion(), actor: started?.actor ?? "operator" });
    console.log(`[daemon] up: started '${key}' → ${url} (pid ${child.pid})`);
    return 0;
  } finally {
    release();
  }
}

async function daemonUp(): Promise<number> {
  const key = lcResolveKey();
  if (!key) { console.log("[daemon] up: no project resolved from cwd and DEVLOOP_PROJECT is unset — nothing to start."); return 0; }
  return daemonUpForKey(key);
}

async function daemonUpAll(): Promise<number> {
  const cfg = loadProjectsConfig();
  const entries = Object.entries(cfg?.projects ?? {}) as Array<[string, { backend?: string }]>;
  const serviceKeys = entries.filter(([, p]) => p.backend === "service").map(([key]) => key);
  if (!serviceKeys.length) {
    console.log(`[daemon] up-all: no backend:"service" projects configured in ${devloopProjectsPath()}.`);
    return 0;
  }
  let code = 0;
  for (const key of serviceKeys) {
    const c = await daemonUpForKey(key);
    if (c !== 0) code = c;
  }
  return code;
}

async function daemonDown(): Promise<number> {
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
  const key = lcResolveKey();
  if (!key) { console.log("[daemon] status: no project resolved (DEVLOOP_PROJECT unset, cwd outside every repo). Set DEVLOOP_PROJECT=<key>, or run from inside a configured repo."); return 0; }
  const info = lcReadRun(key);
  if (info && lcIsAlive(info.pid)) {
    const live = await lcHealthInfo(info.url, key);
    if (live) {
      const ver = live.version || info.version || "?";
      const stale = ver !== "?" && ver !== pkgVersion() ? ` — running OLD code v${ver}, CLI is v${pkgVersion()}; run \`dev-loop daemon up\` to restart` : "";
      const actor = live.actor || info.actor;
      const misId = actor && actor !== "operator" ? ` — WARNING actor='${actor}' (not operator; publish/attribution may be mis-gated)` : "";
      console.log(`[daemon] status: '${key}' RUNNING → ${info.url} (pid ${info.pid}, v${ver}, actor=${actor ?? "?"})${stale}${misId}`);
      return 0;
    }
  }
  if (info && !lcIsAlive(info.pid)) lcRemoveRun(key); // a dead pid must never read as "running" — clear it
  console.log(`[daemon] status: '${key}' stopped. Start it with \`dev-loop daemon up\`.`);
  return 0;
}

function launchAgentPath(): string {
  return join(process.env.HOME || "", "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`);
}

function plistEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function installAutostart(): number {
  if (platform() !== "darwin") {
    console.error("[daemon] install-autostart currently supports macOS LaunchAgent only.");
    return 1;
  }
  const plist = launchAgentPath();
  mkdirSync(dirname(plist), { recursive: true });
  const node = lcNode();
  const self = lcDaemonEntry();
  const env: Record<string, string> = {};
  for (const k of ["DEVLOOP_HOME", "DEVLOOP_PROJECTS_JSON", "DEVLOOP_HUB_DB", "DEVLOOP_RUN_DIR", "DEVLOOP_NODE"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  const envXml = Object.entries(env).map(([k, v]) => `      <key>${plistEscape(k)}</key><string>${plistEscape(v)}</string>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTOSTART_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistEscape(node)}</string>
    <string>${plistEscape(self)}</string>
    <string>up-all</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${plistEscape(join(lcRunDir(), "daemon-autostart.out.log"))}</string>
  <key>StandardErrorPath</key><string>${plistEscape(join(lcRunDir(), "daemon-autostart.err.log"))}</string>
${envXml ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n` : ""}</dict>
</plist>
`;
  writeFileSync(plist, xml);
  try { execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plist], { stdio: "ignore" }); } catch { /* not loaded */ }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist], { stdio: "inherit" });
  execFileSync("launchctl", ["enable", `gui/${process.getuid!()}/${AUTOSTART_LABEL}`], { stdio: "inherit" });
  console.log(`[daemon] autostart installed → ${plist}`);
  console.log(`[daemon] LaunchAgent runs \`${node} ${self} up-all\` at login for configured service projects.`);
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
export type LifecycleSub = "up" | "ensure" | "up-all" | "down" | "status" | "install-autostart" | "uninstall-autostart";
export const LIFECYCLE_SUBS: readonly LifecycleSub[] = ["up", "ensure", "up-all", "down", "status", "install-autostart", "uninstall-autostart"];
// The exit-code core, exported so composable callers (e.g. `dev-loop hub stop` → down + WAL checkpoint)
// can run a lifecycle op WITHOUT the process.exit that daemonLifecycle applies.
export async function daemonLifecycleCode(sub: LifecycleSub): Promise<number> {
  return sub === "up" || sub === "ensure" ? await daemonUp()
    : sub === "up-all" ? await daemonUpAll()
    : sub === "down" ? await daemonDown()
    : sub === "status" ? await daemonStatus()
    : sub === "install-autostart" ? installAutostart()
    : uninstallAutostart();
}
export async function daemonLifecycle(sub: LifecycleSub): Promise<void> {
  process.exit(await daemonLifecycleCode(sub));
}
