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

// LOOP-250: the build commit SHA this package was compiled from (present for source builds,
// absent for npm-installed packages older than the stamp). Used by W18 and daemon up to compare
// what code is actually RUNNING rather than inferring it from the version STRING.
let cachedBuildCommit: string | null | undefined;
export function pkgBuildCommit(): string | null {
  if (cachedBuildCommit === undefined) {
    try {
      cachedBuildCommit = (JSON.parse(readFileSync(new URL("../build-commit.json", import.meta.url), "utf8")) as { commit?: string }).commit ?? null;
    } catch { cachedBuildCommit = null; }
  }
  return cachedBuildCommit;
}

// LOOP-250: uncached fresh read — used by daemon lifecycle to detect an on-disk upgrade while
// a daemon is still running the old code (pkgBuildCommit() is cached at startup).
export function pkgBuildCommitFresh(): string | null {
  try { return (JSON.parse(readFileSync(new URL("../build-commit.json", import.meta.url), "utf8")) as { commit?: string }).commit ?? null; }
  catch { return null; }
}

// Uncached fresh read — used to detect an on-disk upgrade while a daemon is still running
// the old code (pkgVersion() is cached at startup; pkgVersionFresh() reads the file each call).
export function pkgVersionFresh(): string {
  try { return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? ""; }
  catch { return ""; }
}

// A launcher that interpolates an unset JS variable into one of these env vars hands us the truthy
// literal "undefined" (e.g. DEVLOOP_HUB_DB=`${ws}/hub.db` with ws unset) — the || fallbacks below never
// see a falsy value, and the first openDb()/mkdirSync then silently plants a junk `undefined/` directory
// (schema-only hub.db, zero projects) in whatever cwd the command ran from. Refuse LOUDLY here — the one
// module every db/data path is composed through — naming the env var at fault. A present-but-EMPTY value
// stays falsy and falls through to the default (the established empty≡unset convention, resolve-project.ts).
function checkPathSegments(label: string, value: string): void {
  for (const seg of value.split(/[/\\]/)) {
    if (seg === "undefined" || seg === "null") {
      throw new Error(`${label}='${value}' contains the literal path segment '${seg}' — the caller interpolated an unset variable into it.`);
    }
  }
}

function pathEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return value;
  checkPathSegments(`${name}`, value);
  return value;
}

// Same guard as pathEnv(), but for an explicit CLI flag value rather than an env var.
export function guardCliPath(flag: string, value: string): string {
  checkPathSegments(flag, value);
  return value;
}

export function devloopHome(): string {
  return pathEnv("DEVLOOP_HOME") || join(homedir(), ".dev-loop");
}

export function devloopDataDir(): string {
  return pathEnv("DEVLOOP_DATA_DIR") || devloopHome();
}

// 1.0 clean break: the runtime does NOT read a machine-global v1 projects.json anymore. This path
// exists for (a) `dev-loop team import`'s --from default (the one-shot migration bridge) and (b) the
// EXPLICIT DEVLOOP_PROJECTS_JSON injection used by tests/CI and callers that pass a --data dir.
export function devloopProjectsPath(dataDir = devloopDataDir()): string {
  return pathEnv("DEVLOOP_PROJECTS_JSON") || join(dataDir, "projects.json");
}

// EXPLICIT config sources only (env var, or the caller-provided data dir). The implicit fallback chain
// (~/.dev-loop/projects.json + the legacy Claude-plugin data dir) was removed at 1.0 — a workspace
// (dev-loop.json) is the only operator-facing config; migrate once with `dev-loop team import`.
export function projectConfigCandidates(dataDir?: string): string[] {
  const out: string[] = [];
  const explicit = pathEnv("DEVLOOP_PROJECTS_JSON");
  if (explicit) out.push(explicit);
  else if (dataDir) out.push(join(dataDir, "projects.json"));
  return out;
}

export function hubDbPath(): string {
  return pathEnv("DEVLOOP_HUB_DB") || join(devloopHome(), "hub.db");
}