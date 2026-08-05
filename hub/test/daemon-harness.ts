// Sanctioned daemon spawn harness — the ONLY place hub/test/* may directly spawn src/daemon.ts.
// Exports startTestDaemon (foreground spawn, port-from-stdout) and registerDaemonPid (for
// lifecycle-started daemons). Both register pids so ONE process.on("exit") SIGKILL sweep
// covers every termination path: normal exit, process.exit(), and uncaught throw.
// BRITTLENESS: a new spawn idiom (not port-from-stdout, not lifecycle-runfile) must add a
// variant here and update daemon-guard.ts to recognise it.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncReturns } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = new Set<number>();
let hookInstalled = false;

function ensureHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on("exit", () => {
    for (const pid of registry) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  });
}

export function registerDaemonPid(pid: number): void {
  ensureHook();
  registry.add(pid);
}

export interface DaemonHandle { url: string; pid: number; out: string; stop: () => void }

export async function startTestDaemon(
  env: Record<string, string>,
  opts?: { detectPattern?: RegExp },
): Promise<DaemonHandle> {
  ensureHook();
  const pattern = opts?.detectPattern ?? /http:\/\/127\.0\.0\.1:(\d+)\//;
  const child = spawn(process.execPath, [join(hubRoot, "src", "daemon.ts")], {
    env: { ...scrubFireEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid!;
  registry.add(pid);
  let started = false;
  let capturedOut = "";
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`daemon never announced its port:\n${out}`)),
      15_000,
    );
    child.stdout!.on("data", (d: Buffer) => {
      out += String(d);
      const m = out.match(pattern);
      if (m) {
        clearTimeout(timer);
        capturedOut = out;
        started = true;
        resolve(m[0].replace(/\s.*$/, "")); // trim trailing annotation
      }
    });
    child.stderr!.on("data", (d: Buffer) => { out += String(d); });
    child.on("exit", (code: number | null) => {
      clearTimeout(timer);
      if (!started) { capturedOut = out; registry.delete(pid); reject(new Error(`daemon exited ${code}:\n${out}`)); }
    });
  });
  function stop(): void {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    registry.delete(pid);
  }
  return { url, pid, out: capturedOut, stop };
}

// ── Sanctioned lifecycle-CLI spawn site (LOOP-136) ────────────────────────────────────────────
// The daemon lifecycle CLI has TWO entry forms, both dispatching to the SAME daemonLifecycle():
//   "daemon" → `node src/daemon.ts <sub>`        (the daemon.ts dispatcher, daemon.ts:750)
//   "server" → `node src/server.ts daemon <sub>` (the dev-loop-hub bin form, server.ts:68)
// A lifecycle `up`/`up-all`/`ensure` forks a DETACHED daemon + writes a runfile; the CLI process
// spawned here is short-lived. Callers read the runfile and registerDaemonPid(pid) so the ONE
// process.on("exit") sweep still covers the detached daemon. Routing EVERY daemon-starting spawn
// through these two functions keeps daemon-harness.ts the sole spawn site daemon-guard.ts trusts.
const NODE = process.env.DEVLOOP_NODE || process.execPath;
export type DaemonCliEntry = "daemon" | "server";
function daemonCliArgv(entry: DaemonCliEntry, sub: string): string[] {
  return entry === "server"
    ? [join(hubRoot, "src", "server.ts"), "daemon", sub]
    : [join(hubRoot, "src", "daemon.ts"), sub];
}

/** Blocking lifecycle-CLI invocation — the `spawnSync` form lifecycle.ts uses.
 *  `cwd` overrides the default `hubRoot` (useful when testing workspace ascent from outside the repo).
 *  `rawEnv` skips the `{ ...scrubFireEnv(), ...env }` merge — use when the caller has already built a
 *  fully-scrubbed env (e.g. via scrubFireEnv()) and must not re-introduce ambient fire markers. */
export function runDaemonCli(
  entry: DaemonCliEntry,
  sub: string,
  env: Record<string, string | undefined>,
  opts?: { timeout?: number; cwd?: string; rawEnv?: boolean },
): SpawnSyncReturns<string> {
  return spawnSync(NODE, daemonCliArgv(entry, sub), {
    cwd: opts?.cwd ?? hubRoot,
    encoding: "utf8",
    timeout: opts?.timeout ?? 25_000,
    env: (opts?.rawEnv ? env : { ...scrubFireEnv(), ...env }) as NodeJS.ProcessEnv,
  });
}

/** Async lifecycle-CLI invocation — returns the live child so overlapping `up`s can race (lifecycle-race.ts). */
export function launchDaemonCli(
  entry: DaemonCliEntry,
  sub: string,
  env: Record<string, string>,
): ChildProcessWithoutNullStreams {
  return spawn(NODE, daemonCliArgv(entry, sub), { cwd: hubRoot, env: { ...scrubFireEnv(), ...env } });
}
