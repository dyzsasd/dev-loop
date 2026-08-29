// up-dry-launch.ts — `dev-loop up --dry-launch` prints a launch and starts NOTHING.
//
// The flag's contract is "print the resolved launch (command/args/env) as JSON instead of spawning".
// It was honoured for the operator console and broken for the board: the service-backend daemon
// ensure ran BEFORE the print, so every previewed launch forked a detached, unref'd daemon that
// outlived the command. Measured as nine live daemons whose cwd was a deleted fixture directory,
// each holding a port in the production band (8787+), and as EADDRINUSE in an unrelated repo that
// binds 8790. The daemon is detached by design, so nothing downstream ever reaps it.
//
// Asserted on the RUNFILE and the process table, not on stdout: `daemon up` records
// <ws>/.dev-loop/daemon-<key>.json when it starts one, so its absence is the same evidence a
// developer would collect by hand, and it does not depend on how the ensure reports itself.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runningDaemonPids } from "./daemon-pids.ts"; // the ONE daemon-pid listing
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-updry-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const cli = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], {
    cwd, encoding: "utf8",
    env: { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
};

try {
  const ws = join(tmp, "ws");
  mkdirSync(ws, { recursive: true });
  const init = cli(["team", "init", "--dir", ws, "--key", "updry", "--backend", "service", "--yes"], tmp);
  ok(init.code === 0, `fixture: team init on the SERVICE backend (${init.code}) ${init.out.slice(-200)}`);
  ok(cli(["team", "add-project", "updryproj", "--prefix", "UD"], ws).code === 0, "fixture: add-project");

  const before = runningDaemonPids() ?? new Set<number>();
  const dry = cli(["up", "--dir", ws, "--dry-launch"], ws);
  const after = runningDaemonPids() ?? new Set<number>();
  const started = [...after].filter((p) => !before.has(p));

  ok(dry.code === 0, `--dry-launch exits 0 (${dry.code}) ${dry.out.slice(-200)}`);
  type LaunchPlan = { command?: string; envAdded?: Record<string, string> };
  let plan: LaunchPlan | null = null;
  try { plan = JSON.parse(dry.stdout.slice(dry.stdout.indexOf("{"))) as LaunchPlan; } catch { /* asserted below */ }
  ok(!!plan?.command, `…and prints the resolved launch as JSON (command: ${plan?.command ?? "ABSENT"})`);

  const runfiles = (): string[] => {
    try { return readdirSync(join(ws, ".dev-loop")).filter((f) => f.startsWith("daemon-") && f.endsWith(".json")); }
    catch { return []; }
  };
  ok(runfiles().length === 0,
    `…and starts NO board daemon — the workspace holds no daemon runfile (found ${JSON.stringify(runfiles())})`);
  ok(started.length === 0,
    `…and no new daemon process outlives the command (new pids: ${JSON.stringify(started)})`);

  // The control: the ensure is only SKIPPED by the preview, not removed. `--no-daemon` was already
  // the documented way to skip it, so the two flags must not have become the same flag.
  const src = spawnSync("grep", ["-c", "ensureHub", join(hubRoot, "src", "up.ts")], { encoding: "utf8" });
  ok(Number((src.stdout ?? "0").trim()) > 0, "the board-daemon ensure still exists for a real launch — the preview skips it, it was not deleted");

  // Anything this suite did start would be a defect in the suite itself, so it never leaves one.
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

ok(existsSync(tmp) === false, "fixture: the temp workspace is removed");
console.log(fails === 0 ? "\nUP_DRY_LAUNCH_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
