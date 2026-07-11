// hub/undefined/ regression (paths.ts pathEnv guard): a launcher that interpolates an unset JS variable
// into a db/data env var (DEVLOOP_HUB_DB=`${ws}/hub.db` with ws undefined, DEVLOOP_HOME=undefined, …)
// used to hand openDb() a truthy junk path — the first mkdirSync silently planted a schema-only
// `undefined/hub.db` (0 projects, 0 actors) in whatever cwd the command ran from, and probes like
// `daemon up` even exited 0. The guard must refuse the value LOUDLY, naming the env var at fault,
// BEFORE any directory is created.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, realpathSync } from "node:fs";
import { devloopHome, devloopDataDir, devloopProjectsPath, projectConfigCandidates, hubDbPath } from "../src/paths.ts";

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

// ── integration: the ORIGINAL incident — a hub boot / daemon-up probe with a junk db path must fail
// LOUDLY and create NOTHING (before the fix, both silently mkdir'd `<cwd>/undefined/` with a schema-only
// hub.db; `daemon up` even exited 0 with "nothing to start"). ──
const SERVER = realpathSync("src/server.ts"); // absolute — the spawn cwd is the temp dir, not hub/
const TMP = "/tmp/hub-paths-e2e";
type Run = { code: number; stderr: string };
function boot(extraArgs: string[], env: Record<string, string>): Run {
  try {
    execFileSync("node", [SERVER, ...extraArgs], { cwd: TMP, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
