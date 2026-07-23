#!/usr/bin/env node
// `dev-loop stop` — cleanly stop the running scheduler for this workspace's team.
//
// The missing half of `dev-loop run --background` (operator-console flow): the run lock already refuses a
// second scheduler, but stopping the first one meant hand-hunting the pid — exactly where a field operator
// mis-killed processes during a provider switch (2026-07-23). This verb reads the team run lock, SIGTERMs
// the holder (the scheduler forwards SIGINT/SIGTERM to in-flight fires and exits when they drain), and
// escalates to SIGKILL only if it won't die. The hub daemon is deliberately untouched — the board stays up.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tryResolveWorkspace, wsLockPath } from "./workspace.ts";

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const ws = tryResolveWorkspace(process.cwd());
  if (!ws) {
    console.error("dev-loop stop: no workspace here (no dev-loop.json in this directory or above) — run it from the workspace root");
    process.exit(2);
  }
  const lockPath = wsLockPath(ws, "run");
  if (!existsSync(lockPath)) {
    console.log(`dev-loop stop: no scheduler running for team '${ws.file.team.key}' (no run lock)`);
    return;
  }
  let holder: { pid?: number; startedAt?: string } = {};
  try { holder = JSON.parse(readFileSync(lockPath, "utf8")); } catch { /* unreadable = stale */ }
  const pid = holder.pid;
  if (!pid || !pidAlive(pid)) {
    try { unlinkSync(lockPath); } catch { /* raced */ }
    console.log(`dev-loop stop: stale run lock (pid ${pid ?? "?"} is gone) — removed; nothing was running`);
    return;
  }
  console.log(`dev-loop stop: stopping scheduler pid ${pid} (team '${ws.file.team.key}'${holder.startedAt ? `, up since ${holder.startedAt}` : ""}) — in-flight fires get SIGINT and drain`);
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 20_000; waited += 250) {
    if (!pidAlive(pid)) {
      try { unlinkSync(lockPath); } catch { /* the scheduler's own exit hook usually beat us */ }
      console.log(`dev-loop stop: scheduler stopped (${(waited / 1000).toFixed(1)}s). The hub daemon (board/UI) is untouched — \`dev-loop hub status\`. Restart with \`dev-loop run --background …\``);
      return;
    }
    await sleep(250);
  }
  console.error(`dev-loop stop: pid ${pid} still alive after 20s — SIGKILL (in-flight fires may leave orphan CLI children; check \`pgrep -f "opencode run|claude -p"\`)`);
  try { process.kill(pid, "SIGKILL"); } catch { /* died in the race */ }
  await sleep(500);
  try { unlinkSync(lockPath); } catch { /* already gone */ }
  process.exit(pidAlive(pid) ? 1 : 0);
}

main().catch((e) => { console.error(`dev-loop stop: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
