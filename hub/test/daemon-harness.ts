// Sanctioned daemon spawn harness — the ONLY place hub/test/* may directly spawn src/daemon.ts.
// Exports startTestDaemon (foreground spawn, port-from-stdout) and registerDaemonPid (for
// lifecycle-started daemons). Both register pids so ONE process.on("exit") SIGKILL sweep
// covers every termination path: normal exit, process.exit(), and uncaught throw.
// BRITTLENESS: a new spawn idiom (not port-from-stdout, not lifecycle-runfile) must add a
// variant here and update daemon-guard.ts to recognise it.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
    env: { ...process.env, ...env },
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
