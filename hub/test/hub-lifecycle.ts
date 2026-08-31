// `dev-loop hub start|stop|status` — workspace hub daemon lifecycle (service backend): start is
// idempotent, status reports RUNNING, stop truncates the WAL + removes the runfile, linear teams refuse.
import { spawnSync } from "node:child_process";
import { realpathSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { registerDaemonPid } from "./daemon-harness.ts";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-hublc-"));
const HOME = join(tmp, "home");
// Scrub workspace-specific vars that an ambient dev-loop fire exports: inheriting them causes hub
// start/stop/status to resolve the wrong project or hub.db (LOOP-6 regression guard).
const env: Record<string, string | undefined> = { ...scrubFireEnv(), DEVLOOP_HOME: HOME };
delete env.DEVLOOP_HUB_DB;
delete env.DEVLOOP_PROJECT;
delete env.DEVLOOP_DEV_SPLIT;
const team = (args: string[], cwd = tmp) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env, encoding: "utf8" });
// LOOP-146 — these are REAL daemons (the assertions below count runfiles and assert RUNNING), started
// through a third entry file with a VARIABLE subcommand, which is why daemon-guard's three predicates
// all missed them. This file stays exempt from the spawn predicate — its whole subject IS
// `dev-loop hub start|stop|status|ensure`, so routing it through the harness would test something
// other than the verb under test — but its daemons must not sit outside the ONE exit sweep.
//
// The `finally` below is not enough on its own: process.exit() sits INSIDE the try, and finally does
// not run after process.exit(). Registering each started pid puts them on the harness's
// process.on("exit") SIGKILL sweep, which covers every termination path including that one.
const hub = (sub: string, cwd: string) => {
  const r = spawnSync("node", [join(hubRoot, "src", "hub.ts"), sub], { cwd, env, encoding: "utf8", timeout: 20000 });
  if (sub === "start" || sub === "ensure") {
    // The daemon detaches, so its pid is in the runfile rather than in `r`.
    try {
      for (const f of readdirSync(join(cwd, ".dev-loop")).filter((n) => /^daemon-.*\.json$/.test(n))) {
        const pid = (JSON.parse(readFileSync(join(cwd, ".dev-loop", f), "utf8")) as { pid?: number }).pid;
        if (typeof pid === "number") registerDaemonPid(pid);
      }
    } catch { /* best-effort: registration must never fail the verb under test */ }
  }
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const ws = join(tmp, "ws");
try {
  team(["init", "--dir", ws, "--key", "hublc-team", "--backend", "service"]);
  const stateDir = join(ws, ".dev-loop");

  // start → running
  const start = hub("start", ws);
  ok(start.code === 0 && /up:.*RUNNING|up: started|RUNNING/.test(start.out), "hub start brings the daemon up");
  // idempotent second start → still one instance (no error)
  const start2 = hub("start", ws);
  ok(start2.code === 0, "hub start is idempotent (second start is a clean no-op)");
  const runfiles = () => readdirSync(stateDir).filter((f) => /^daemon-.*\.json$/.test(f));
  ok(runfiles().length === 1, "exactly one daemon runfile after a double start (single instance)");

  // status → RUNNING + size line
  const status = hub("status", ws);
  ok(/RUNNING/.test(status.out) && /hub\.db .* KB/.test(status.out), "hub status reports RUNNING + db/WAL sizes");

  // stop → WAL truncated + runfile removed
  const stop = hub("stop", ws);
  ok(stop.code === 0 && /checkpointed \+ truncated/.test(stop.out), "hub stop checkpoints + truncates the WAL");
  const wal = join(stateDir, "hub.db-wal");
  ok(!existsSync(wal) || statSync(wal).size === 0, "the WAL is empty (0 bytes) after stop");
  ok(runfiles().length === 0, "the daemon runfile is removed after stop");

  // linear team → refuses
  const lin = join(tmp, "lin");
  team(["init", "--dir", lin, "--key", "hublc-lin", "--backend", "linear", "--linear-team", "L"]);
  const refused = hub("status", lin);
  ok(refused.code !== 0 && /service-backend teams only/.test(refused.out), "hub refuses on a linear team (no hub.db)");

  // Regression (LOOP-6): a DEVLOOP_HUB_DB leaked from an ambient fire (pointing at a DIFFERENT workspace)
  // must never silently redirect hub commands — wireEnv always overrides from the cwd-resolved workspace.
  // Test only the foreign-HUB_DB case (no foreign PROJECT), since LOOP-186 makes a non-_team PROJECT refuse.
  const wsB = join(tmp, "wsB");
  team(["init", "--dir", wsB, "--key", "hublc-other", "--backend", "service"]);
  const foreignHubDb = join(wsB, ".dev-loop", "hub.db");
  const hubForeignDb = (sub: string, cwd: string) => {
    const r = spawnSync("node", [join(hubRoot, "src", "hub.ts"), sub], {
      cwd, encoding: "utf8", timeout: 20000,
      env: { ...env, DEVLOOP_HUB_DB: foreignHubDb }, // foreign HUB_DB only; no PROJECT override
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const startForeign = hubForeignDb("start", ws);
  ok(startForeign.code === 0 && /up:.*RUNNING|up: started|RUNNING/.test(startForeign.out), "hub start with a foreign DEVLOOP_HUB_DB still resolves the cwd workspace (LOOP-6)");
  hubForeignDb("stop", ws);

  // Regression (LOOP-186): hub stop with an explicit non-_team DEVLOOP_PROJECT must REFUSE and name the
  // project — it must never silently stop _team while the operator asked for another project.
  const stateDir186 = join(ws, ".dev-loop");
  const runfileTeam = join(stateDir186, "daemon-_team.json");
  // Start _team so we can verify the runfile is NOT touched when DEVLOOP_PROJECT names another project.
  hub("start", ws);
  const hadRunfile = existsSync(runfileTeam);
  const hubMistarget = (sub: string) => {
    const r = spawnSync("node", [join(hubRoot, "src", "hub.ts"), sub], {
      cwd: ws, encoding: "utf8", timeout: 5000,
      env: { ...env, DEVLOOP_PROJECT: "hublc-other" }, // explicit non-_team project
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const stopMistarget = hubMistarget("stop");
  ok(stopMistarget.code !== 0, "hub stop refuses when DEVLOOP_PROJECT names a non-_team project (LOOP-186 AC1)");
  ok(/hublc-other/.test(stopMistarget.out), "hub stop refusal message names the requested project (LOOP-186 AC1)");
  ok(hadRunfile && existsSync(runfileTeam), "hub stop refusal did NOT remove the _team runfile (LOOP-186 AC4: mis-target gone)");
  const startMistarget = hubMistarget("start");
  ok(startMistarget.code !== 0, "hub start refuses when DEVLOOP_PROJECT names a non-_team project (LOOP-186 AC1)");
  ok(/DEVLOOP_PROJECT=.*daemon up/.test(startMistarget.out), "hub start refusal redirects to DEVLOOP_PROJECT=<key> daemon up (LOOP-186 AC2)");
  // Clean up the started daemon
  hub("stop", ws);

  console.log(fails === 0 ? "\nHUB_LIFECYCLE_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  // Always attempt to stop the daemon so a failed assertion never leaks a background process.
  try { hub("stop", ws); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
