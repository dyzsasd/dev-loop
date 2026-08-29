// hub/undefined/ regression (paths.ts pathEnv guard): a launcher that interpolates an unset JS variable
// into a db/data env var (DEVLOOP_HUB_DB=`${ws}/hub.db` with ws undefined, DEVLOOP_HOME=undefined, …)
// used to hand openDb() a truthy junk path — the first mkdirSync silently planted a schema-only
// `undefined/hub.db` (0 projects, 0 actors) in whatever cwd the command ran from, and probes like
// `daemon up` even exited 0. The guard must refuse the value LOUDLY, naming the env var at fault,
// BEFORE any directory is created.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { devloopHome, devloopDataDir, tryDevloopDataDir, devloopProjectsPath, projectConfigCandidates, hubDbPath, tryHubDbPath, workspacesIndexPath, guardCliPath } from "../src/paths.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ENV_KEYS = ["DEVLOOP_HOME", "DEVLOOP_DATA_DIR", "DEVLOOP_PROJECTS_JSON", "DEVLOOP_HUB_DB"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const reset = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } };
const throwsNaming = (fn: () => unknown, name: string): boolean => {
  try { fn(); return false; } catch (e) { return (e as Error).message.includes(name); }
};

// ── unit: every composed db/data path rejects a junk "undefined"/"null" segment, naming the env var ──
reset(); process.env.DEVLOOP_HUB_DB = "undefined/hub.db";
ok(throwsNaming(hubDbPath, "DEVLOOP_HUB_DB"), "DEVLOOP_HUB_DB with an 'undefined' segment → hubDbPath throws naming the var");
reset(); process.env.DEVLOOP_HUB_DB = "undefined";
ok(throwsNaming(hubDbPath, "DEVLOOP_HUB_DB"), "DEVLOOP_HUB_DB literally 'undefined' → throws");
reset(); process.env.DEVLOOP_HOME = "undefined"; delete process.env.DEVLOOP_HUB_DB;
ok(throwsNaming(hubDbPath, "DEVLOOP_HOME"), "DEVLOOP_HOME='undefined' → hubDbPath (composed under it) throws naming DEVLOOP_HOME");
ok(throwsNaming(devloopHome, "DEVLOOP_HOME"), "DEVLOOP_HOME='undefined' → devloopHome throws");
reset(); process.env.DEVLOOP_DATA_DIR = "/tmp/null/data";
ok(throwsNaming(devloopDataDir, "DEVLOOP_DATA_DIR"), "DEVLOOP_DATA_DIR with a 'null' segment → devloopDataDir throws");
reset(); process.env.DEVLOOP_PROJECTS_JSON = "undefined/projects.json";
ok(throwsNaming(() => devloopProjectsPath("/tmp"), "DEVLOOP_PROJECTS_JSON"), "junk DEVLOOP_PROJECTS_JSON → devloopProjectsPath throws");
ok(throwsNaming(() => projectConfigCandidates("/tmp"), "DEVLOOP_PROJECTS_JSON"), "junk DEVLOOP_PROJECTS_JSON → projectConfigCandidates throws");

// ── unit: guardCliPath — same segment guard for explicit CLI flags (LOOP-29) ──
ok(throwsNaming(() => guardCliPath("--hub-db", "undefined/x.db"), "--hub-db"), "guardCliPath rejects 'undefined' segment, names the flag");
ok(throwsNaming(() => guardCliPath("--data", "/tmp/null/data"), "--data"), "guardCliPath rejects 'null' segment in --data");
ok(throwsNaming(() => guardCliPath("--root", "undefined"), "--root"), "guardCliPath rejects literal 'undefined' in --root");
ok(!throwsNaming(() => guardCliPath("--hub-db", "/tmp/valid/hub.db"), "--hub-db"), "guardCliPath passes a valid path");
ok(guardCliPath("--hub-db", "/tmp/undefined-behavior/hub.db") === "/tmp/undefined-behavior/hub.db",
  "guardCliPath: 'undefined-behavior' as a segment is NOT junk (exact-segment match only)");

// ── unit: sane values still pass through; empty ≡ unset falls back to the default ──
reset(); process.env.DEVLOOP_HUB_DB = "/tmp/hub-paths/ok/hub.db";
ok(hubDbPath() === "/tmp/hub-paths/ok/hub.db", "a sane DEVLOOP_HUB_DB passes through unchanged");
reset(); process.env.DEVLOOP_HOME = "/tmp/hub-paths/home"; delete process.env.DEVLOOP_HUB_DB;
ok(hubDbPath() === "/tmp/hub-paths/home/hub.db", "a sane DEVLOOP_HOME composes the default hub.db under it");
reset(); process.env.DEVLOOP_HUB_DB = ""; process.env.DEVLOOP_HOME = "/tmp/hub-paths/home";
ok(hubDbPath() === "/tmp/hub-paths/home/hub.db", "an EMPTY DEVLOOP_HUB_DB falls back to the default (empty ≡ unset)");
// a legit dir merely CONTAINING the substring must NOT trip the guard (exact-segment match, not substring)
reset(); process.env.DEVLOOP_HUB_DB = "/tmp/undefined-behavior/hub.db";
ok(hubDbPath() === "/tmp/undefined-behavior/hub.db", "'undefined-behavior' as a segment is NOT junk (segment match only)");
reset();

// ── unit: the retired home anchor — a state path comes from a workspace, or from nothing ──────────
// `~/.dev-loop` was the last rung of every state ladder, so a command run outside every workspace
// silently opened (and CREATED) a machine-global board and data dir instead of saying it had found
// none. The measured symptom was doctor checking one machine's fire ledger against another tree's
// reports (W35). The rung is gone: a workspace answers, or the caller gets an error naming the ways
// to supply the path.
{
  const WS_KEYS = ["DEVLOOP_WORKSPACE", "DEVLOOP_TEAM", "DEVLOOP_HOME", "DEVLOOP_HUB_DB", "DEVLOOP_DATA_DIR", "DEVLOOP_PROJECTS_JSON"] as const;
  const savedWs = Object.fromEntries(WS_KEYS.map((k) => [k, process.env[k]]));
  const cwd0 = process.cwd();
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), "dl-paths-ws-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "dl-paths-none-")));
  const legacyHome = join(homedir(), ".dev-loop");
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2, team: { key: "pathsws", backend: "service" }, repos: {}, projects: {},
  }));
  try {
    for (const k of WS_KEYS) delete process.env[k];

    // The workspace answers, without any env var naming the db.
    process.env.DEVLOOP_WORKSPACE = wsRoot;
    ok(hubDbPath() === join(wsRoot, ".dev-loop", "hub.db"),
      `no DEVLOOP_HUB_DB + DEVLOOP_WORKSPACE → the workspace's own board (${hubDbPath()})`);
    ok(devloopDataDir() === join(wsRoot, ".dev-loop"),
      `…and the data dir is that workspace's state root (${devloopDataDir()})`);

    // Nothing answers: an error, not a home-anchored path.
    delete process.env.DEVLOOP_WORKSPACE;
    process.chdir(outside);
    ok(tryHubDbPath() === undefined, "outside every workspace with no env set, the hub-db ladder resolves NOTHING");
    ok(tryDevloopDataDir() === undefined, "…and so does the data-dir ladder");
    let dbErr = "";
    try { dbErr = `resolved to ${hubDbPath()}`; } catch (e) { dbErr = (e as Error).message; }
    ok(dbErr.includes("no hub database resolved"), `…so hubDbPath() reports it cannot resolve one (${dbErr.slice(0, 90)})`);
    ok(!dbErr.includes(legacyHome), "…and never returns or names ~/.dev-loop/hub.db");
    ok(dbErr.includes("DEVLOOP_HUB_DB") && dbErr.includes("dev-loop team init"),
      "…and the message names both ways to supply one (the env var, or a workspace)");
    let dataErr = "";
    try { dataErr = `resolved to ${devloopDataDir()}`; } catch (e) { dataErr = (e as Error).message; }
    ok(dataErr.includes("no dev-loop data dir resolved") && !dataErr.includes(legacyHome),
      `devloopDataDir() refuses the same way (${dataErr.slice(0, 90)})`);

    // The workspace index is the ONE file that cannot live in a workspace. It left the retired tree
    // too, or the next command would re-create what the operator had just deleted.
    ok(!workspacesIndexPath().startsWith(legacyHome + "/"),
      `the workspace index is not under ~/.dev-loop (${workspacesIndexPath()})`);
    ok(workspacesIndexPath().endsWith(join("dev-loop", "workspaces.json")),
      `…it is an XDG-style config path (${workspacesIndexPath()})`);
    process.env.DEVLOOP_HOME = join(outside, "home");
    ok(workspacesIndexPath() === join(outside, "home", "workspaces.json"),
      "…and DEVLOOP_HOME still relocates it, which is how the suites keep it out of a real home directory");
    ok(devloopHome() === join(outside, "home"), "devloopHome() is that explicit override and nothing more");
    delete process.env.DEVLOOP_HOME;
    ok(devloopHome() === undefined, "…and it is undefined when unset, rather than ~/.dev-loop");
  } finally {
    process.chdir(cwd0);
    for (const k of WS_KEYS) { if (savedWs[k] === undefined) delete process.env[k]; else process.env[k] = savedWs[k]!; }
    rmSync(wsRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// ── integration: the ORIGINAL incident — a hub boot / daemon-up probe with a junk db path must fail
// LOUDLY and create NOTHING (before the fix, both silently mkdir'd `<cwd>/undefined/` with a schema-only
// hub.db; `daemon up` even exited 0 with "nothing to start"). ──
const SERVER = realpathSync("src/server.ts"); // absolute — the spawn cwd is the temp dir, not hub/
const TMP = "/tmp/hub-paths-e2e";
type Run = { code: number; stderr: string };
function boot(extraArgs: string[], env: Record<string, string>): Run {
  try {
    execFileSync("node", [SERVER, ...extraArgs], { cwd: TMP, env: { ...scrubFireEnv(), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: String(err.stderr ?? "") };
  }
}
for (const [label, args, env] of [
  ["server boot with DEVLOOP_HOME='undefined'", [], { DEVLOOP_HOME: "undefined", DEVLOOP_HUB_DB: "", DEVLOOP_PROJECT: "demo", DEVLOOP_ACTOR: "operator" }],
  ["daemon up with DEVLOOP_HUB_DB='undefined/hub.db'", ["daemon", "up"], { DEVLOOP_HUB_DB: "undefined/hub.db", DEVLOOP_PROJECT: "demo" }],
] as const) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const r = boot([...args], { ...env });
  ok(r.code !== 0, `${label} → non-zero exit`);
  ok(/DEVLOOP_(HOME|HUB_DB)/.test(r.stderr), `${label} → stderr names the env var at fault`);
  ok(readdirSync(TMP).length === 0, `${label} → creates NOTHING in the cwd (no junk undefined/ dir)`);
}
rmSync(TMP, { recursive: true, force: true });

console.log(fails === 0 ? "\nPATHS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
