#!/usr/bin/env node
// SessionStart hook entry for packaged Claude plugin installs — OPT-IN since WS-B.
//
// The hook stays registered in hooks/hooks.json (a plugin manifest needs it), but it does nothing
// unless the operator asked for it: `DEVLOOP_SESSION_HOOK=1` in the environment, OR the resolved
// workspace's dev-loop.json carries `team.sessionStartHook: true`. The standalone lifecycle is owned
// by the dev-loop CLI (`dev-loop hub ensure`, `daemon up-all`, `daemon install-autostart`, and the
// harness-neutral dev-loop-operator/ skill); a Claude session starting is not, by itself, a reason
// to spawn a daemon on the machine. When it DOES act it appends one line to `<runDir>/hook.log`
// (runDir = <workspace>/.dev-loop, else ~/.dev-loop, DEVLOOP_RUN_DIR wins) instead of swallowing
// everything — a silent hook is a hook nobody can debug.
//
// The hook may be invoked by whatever `node` appears first on PATH. Keep this file free of
// node:sqlite imports (and of workspace.ts, which pulls the validator) so even an older Node can run
// it, find a compatible runtime, and then start the real daemon. Config is read LENIENTLY here:
// parse the JSON, read the one key if present — validation of the key lives in team-config.ts.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findCompatibleNode } from "./node-runtime.ts";

// The workspace root: DEVLOOP_WORKSPACE if it holds a dev-loop.json, else the cwd ascent. Null when
// none — the hook then has no config to consult and only the env flag can enable it.
function findWorkspaceRoot(): string | null {
  const explicit = process.env.DEVLOOP_WORKSPACE?.trim();
  if (explicit && existsSync(join(explicit, "dev-loop.json"))) return resolve(explicit);
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "dev-loop.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function sessionHookEnabled(env: NodeJS.ProcessEnv, root: string | null): boolean {
  if (env.DEVLOOP_SESSION_HOOK === "1") return true;
  if (!root) return false;
  try {
    const j = JSON.parse(readFileSync(join(root, "dev-loop.json"), "utf8")) as { team?: { sessionStartHook?: unknown } };
    return j.team?.sessionStartHook === true;
  } catch { return false; }
}

const root = findWorkspaceRoot();
if (sessionHookEnabled(process.env, root)) {
  const here = dirname(fileURLToPath(import.meta.url)); // hub/src (source) | dist (published)
  const ext = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
  const node = findCompatibleNode();
  // The log follows the workspace. With neither DEVLOOP_RUN_DIR nor a workspace root there is
  // nowhere to write it — ~/.dev-loop was retired, and a hook that re-created it would undo the
  // operator's removal on the next session. `daemon up` still runs; only the log line is skipped.
  const runDir = process.env.DEVLOOP_RUN_DIR ?? (root ? join(root, ".dev-loop") : null);
  let line: string;
  if (node) {
    const r = spawnSync(node, [join(here, `cli${ext}`), "daemon", "up"], { encoding: "utf8", env: { ...process.env, DEVLOOP_NODE: node } });
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").filter(Boolean).pop() ?? "(no output)";
    line = `daemon up → exit ${r.status ?? "signal"}: ${tail}`;
  } else {
    line = "skipped: no compatible node (>= 23.6) found — set DEVLOOP_NODE";
  }
  try {
    if (runDir) {
      mkdirSync(runDir, { recursive: true });
      const logPath = join(runDir, "hook.log");
      // Bounded like every other log the loop keeps: the runner logs and run.log rotate at 50 MB with a
      // single .1 generation, and the fire ledger is pruned. This one appended forever. It grows a line
      // per session rather than per fire, so it is the slowest of them — which is exactly why nothing
      // noticed, and why an unattended machine is where it would eventually matter.
      try { if (statSync(logPath).size > 50 * 1024 * 1024) renameSync(logPath, `${logPath}.1`); } catch { /* no log yet */ }
      appendFileSync(logPath, `${new Date().toISOString()} session-start cwd=${process.cwd()} ${line}\n`);
    }
  } catch { /* the log is best-effort; the hook must never fail a session */ }
}

// Hooks must never make a Claude session fail to start. Disabled / missing Node / non-service project → no-op.
process.exit(0);
