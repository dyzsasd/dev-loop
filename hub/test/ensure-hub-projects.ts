// LOOP-261 regression: ensureHub must ensure the per-project daemon(s) in addition to _team.
// Before the fix, ensureHub only ensured the _team daemon; any per-project daemon (the one
// agent-fire CLI ops actually resolve to) was never healed across an upgrade.
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "../src/workspace.ts";
import { ensureHub } from "../src/hub.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.env.DEVLOOP_NODE || process.execPath;
const ROOT = `/tmp/dl-ensure-hub-proj-${process.pid}`;
const WS_KEY = "ehp";
const PROJ = "ehpproj";
const WS_DB = join(ROOT, ".dev-loop", "hub.db");
const WS_RUN = join(ROOT, ".dev-loop");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const readPid = (key: string): number | null => {
  const rf = join(WS_RUN, `daemon-${key}.json`);
  try { return (JSON.parse(readFileSync(rf, "utf8")) as { pid: number }).pid; } catch { return null; }
};
const kill = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } };

const clean = { env: { ...scrubFireEnv() } as NodeJS.ProcessEnv };
const cli = (...args: string[]) => spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), ...args], { cwd: ROOT, encoding: "utf8", timeout: 20_000, ...clean });

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

try {
  // Setup: workspace with one delivery project (auto-seeds hub row on service backend)
  const init = spawnSync(NODE, [join(hubRoot, "src", "cli.ts"), "team", "init",
    "--dir", ROOT, "--key", WS_KEY, "--backend", "service", "--yes"],
    { cwd: "/tmp", encoding: "utf8", timeout: 20_000, ...clean });
  ok(init.status === 0, `setup: team init exits 0 (got ${init.status}: ${(init.stderr ?? "").split("\n")[0]})`);
  ok(existsSync(WS_DB), "setup: workspace hub.db created");

  const addProj = cli("team", "add-project", PROJ, "--prefix", "EHP");
  ok(addProj.status === 0, `setup: add-project exits 0 (got ${addProj.status}: ${(addProj.stderr ?? "").split("\n")[0]})`);

  // Resolve the workspace as run-agents.ts would, then call ensureHub.
  process.env.DEVLOOP_HUB_DB = WS_DB;
  process.env.DEVLOOP_RUN_DIR = WS_RUN;
  process.env.DEVLOOP_WORKSPACE = ROOT;
  const ws = resolveWorkspace();
  const code = await ensureHub(ws);

  // AC1: _team daemon started (web-UI + intake)
  ok(existsSync(join(WS_RUN, "daemon-_team.json")), "AC1: _team runfile created by ensureHub");
  const teamPid = readPid("_team");
  if (teamPid !== null) {
    ok((() => { try { process.kill(teamPid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } })(),
      "AC1: _team daemon pid is alive");
  }

  // AC2: per-project daemon started (this is what LOOP-261 fixes — was never reached before)
  ok(existsSync(join(WS_RUN, `daemon-${PROJ}.json`)), `AC2: per-project runfile (daemon-${PROJ}.json) created by ensureHub`);
  const projPid = readPid(PROJ);
  if (projPid !== null) {
    ok((() => { try { process.kill(projPid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } })(),
      `AC2: per-project daemon pid is alive`);
  }

  ok(code === 0, `ensureHub returns 0 when all daemons start cleanly (got ${code})`);

  // AC3: second call is idempotent (already-running daemons are no-ops)
  const code2 = await ensureHub(ws);
  ok(code2 === 0, "AC3: second ensureHub call is idempotent (no crash, exit 0)");
  ok(existsSync(join(WS_RUN, `daemon-${PROJ}.json`)), "AC3: per-project runfile still present after second call");
} finally {
  for (const key of ["_team", PROJ]) {
    const pid = readPid(key);
    if (pid !== null) kill(pid);
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails === 0 ? "\nENSURE_HUB_PROJECTS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
