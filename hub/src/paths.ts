import { homedir } from "node:os";
import { join } from "node:path";

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
