import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { findWorkspaceRoot, WsNotFound } from "./workspace.ts";

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

// The RETIRED location. Before the 1.0 workspace model every state path was composed under
// ~/.dev-loop; a workspace owns them now (design/state-locality, I3/I4: copy the folder = migrate
// the machine). Nothing in the runtime resolves this root any more. Two callers name it on purpose:
// `dev-loop team import`, whose job is to copy state OUT of it, and doctor's E20, whose job is to
// report that state is still sitting behind it. A third caller would be a regression.
export function legacyHomeRoot(): string {
  return join(homedir(), ".dev-loop");
}

// DEVLOOP_HOME is an EXPLICIT override and nothing else — `undefined` means the operator named no
// home, NOT that ~/.dev-loop should be used. The return type carries that: a caller cannot reach a
// home-anchored path without deciding what an absent one means.
export function devloopHome(): string | undefined {
  return pathEnv("DEVLOOP_HOME");
}

// The state dir of the workspace this process is standing in, or undefined when none resolves.
// Discovery is workspace.ts's ladder (DEVLOOP_WORKSPACE > DEVLOOP_HUB_DB > DEVLOOP_TEAM > cwd
// ascent), so every resolver below agrees with the rest of the CLI about which workspace is in play.
function workspaceStateDir(): string | undefined {
  let root: string | null;
  // WsNotFound ⇒ "nothing here", the same reading tryResolveWorkspace gives it: a sentinel
  // DEVLOOP_WORKSPACE or a DEVLOOP_TEAM key with no index entry means discovery answered no, and the
  // caller's own ladder decides what that costs. Any other failure is a real fault and propagates.
  try { root = findWorkspaceRoot(); }
  catch (e) { if (e instanceof WsNotFound) return undefined; throw e; }
  return root ? join(root, ".dev-loop") : undefined;
}

// What every "no default left" error says, so the operator reads one remedy rather than three.
const NO_HOME_ANCHOR = "there is no home-anchored default any more (~/.dev-loop was retired). "
  + "Run `dev-loop team init` in a directory to create a workspace, `cd` into an existing one, or set the path explicitly.";

export function devloopDataDir(): string {
  const dir = tryDevloopDataDir();
  if (dir) return dir;
  throw new Error(`no dev-loop data dir resolved: DEVLOOP_DATA_DIR and DEVLOOP_HOME are unset and no workspace resolved — ${NO_HOME_ANCHOR}`);
}

// The same ladder for callers that must not fail on an unresolvable data dir (argument parsing that
// runs before `--help`, best-effort readers). They report the gap at the point it actually matters.
export function tryDevloopDataDir(): string | undefined {
  return pathEnv("DEVLOOP_DATA_DIR") || devloopHome() || workspaceDataDir();
}

// The legacy tree `dev-loop team import` copies OUT of. It is deliberately allowed to land on
// legacyHomeRoot(): the verb exists to drain that location, so refusing to name it would remove the
// only supported way off it. DEVLOOP_DATA_DIR / DEVLOOP_HOME still point it at a fixture.
export function legacyDataDir(): string {
  return pathEnv("DEVLOOP_DATA_DIR") || devloopHome() || legacyHomeRoot();
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

// The board this process reads and writes: explicit DEVLOOP_HUB_DB > explicit DEVLOOP_HOME > the
// discovered workspace's .dev-loop/hub.db. The last rung used to be ~/.dev-loop/hub.db, which is how
// a command run outside a workspace silently opened — and CREATED — a machine-global board instead
// of saying it could not find one. An unresolvable board is now an error the operator can act on.
export function hubDbPath(): string {
  const db = tryHubDbPath();
  if (db) return db;
  throw new Error(`no hub database resolved: DEVLOOP_HUB_DB and DEVLOOP_HOME are unset and no workspace resolved — ${NO_HOME_ANCHOR}`);
}

// The same ladder without the throw, for callers that compose a default before they know whether
// they will need it (see hubDbPath's contract for what an absent value means).
export function tryHubDbPath(): string | undefined {
  const explicit = pathEnv("DEVLOOP_HUB_DB");
  if (explicit) return explicit;
  const home = devloopHome();
  if (home) return join(home, "hub.db");
  const ws = workspaceStateDir();
  return ws ? join(ws, "hub.db") : undefined;
}

// LOOP-388: the workspace's state dir. An explicit DEVLOOP_HUB_DB IS the binding (the daemon is
// spawned with it), so it is read first — hub.db lives at <workspace>/.dev-loop/hub.db, so the state
// dir is dirname(hubDb). Otherwise discovery answers. undefined when no workspace resolves: the
// home-anchored fallback is gone, so no caller can mistake ~/.dev-loop for a workspace.
export function workspaceDataDir(): string | undefined {
  const hubDb = pathEnv("DEVLOOP_HUB_DB");
  if (hubDb) return dirname(hubDb);
  return workspaceStateDir();
}

// The workspace index — the ONE piece of dev-loop state that cannot live inside a workspace, because
// it is what answers `DEVLOOP_TEAM=<key>` → which workspace root. It is NON-authoritative: every
// in-workspace run rewrites its own entry, so a lost index costs one `cd` into the workspace.
// It moved off ~/.dev-loop with everything else — leaving it there would mean the next command
// re-created the retired tree the operator had just deleted — to an XDG-style config path.
// DEVLOOP_HOME still overrides, which is how the test suites keep it out of a real home directory.
export function workspacesIndexPath(): string {
  const home = devloopHome();
  if (home) return join(home, "workspaces.json");
  return join(pathEnv("XDG_CONFIG_HOME") || join(homedir(), ".config"), "dev-loop", "workspaces.json");
}