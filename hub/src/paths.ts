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

export function legacyClaudeDataDir(): string {
  return join(homedir(), ".claude", "plugins", "data", "dev-loop");
}

export function devloopDataDir(): string {
  return process.env.DEVLOOP_DATA_DIR || devloopHome();
}

export function devloopProjectsPath(dataDir = devloopDataDir()): string {
  return process.env.DEVLOOP_PROJECTS_JSON || join(dataDir, "projects.json");
}

export function projectConfigCandidates(dataDir = devloopDataDir()): string[] {
  const primary = devloopProjectsPath(dataDir);
  const candidates = [
    primary,
    process.env.CLAUDE_PLUGIN_DATA ? join(process.env.CLAUDE_PLUGIN_DATA, "projects.json") : undefined,
    join(legacyClaudeDataDir(), "projects.json"),
  ].filter((x): x is string => !!x);
  return [...new Set(candidates)];
}

export function hubDbPath(): string {
  return process.env.DEVLOOP_HUB_DB || join(devloopHome(), "hub.db");
}
