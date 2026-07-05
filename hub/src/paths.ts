import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// The installed package version — src/paths.ts and dist/paths.js both sit one level under the
// package root, so ../package.json resolves in a source checkout AND the published artifact.
// Used by the daemon health body + lifecycle so `daemon up` can restart a stale-code daemon
// after an npm upgrade (without it, an upgraded install keeps serving old code until reboot).
let cachedVersion: string | undefined;
export function pkgVersion(): string {
  if (cachedVersion === undefined) {
    try { cachedVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? ""; }
    catch { cachedVersion = ""; }
  }
  return cachedVersion;
}

export function devloopHome(): string {
  return process.env.DEVLOOP_HOME || join(homedir(), ".dev-loop");
}

export function devloopDataDir(): string {
  return process.env.DEVLOOP_DATA_DIR || devloopHome();
}

// 1.0 clean break: the runtime does NOT read a machine-global v1 projects.json anymore. This path
// exists for (a) `dev-loop team import`'s --from default (the one-shot migration bridge) and (b) the
// EXPLICIT DEVLOOP_PROJECTS_JSON injection used by tests/CI and callers that pass a --data dir.
export function devloopProjectsPath(dataDir = devloopDataDir()): string {
  return process.env.DEVLOOP_PROJECTS_JSON || join(dataDir, "projects.json");
}

// EXPLICIT config sources only (env var, or the caller-provided data dir). The implicit fallback chain
// (~/.dev-loop/projects.json + the legacy Claude-plugin data dir) was removed at 1.0 — a workspace
// (dev-loop.json) is the only operator-facing config; migrate once with `dev-loop team import`.
export function projectConfigCandidates(dataDir?: string): string[] {
  const out: string[] = [];
  if (process.env.DEVLOOP_PROJECTS_JSON) out.push(process.env.DEVLOOP_PROJECTS_JSON);
  else if (dataDir) out.push(join(dataDir, "projects.json"));
  return out;
}

export function hubDbPath(): string {
  return process.env.DEVLOOP_HUB_DB || join(devloopHome(), "hub.db");
}
