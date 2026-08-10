// LOOP-459 standalone test: --dry-run prints promptly and writes NO scheduler-gate.json
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = "/tmp/dl-loop459-test";
const ws = join(tmp, "ws");
const repoDir = join(ws, "repo");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(repoDir, { recursive: true });
mkdirSync(ws, { recursive: true });

spawnSync("git", ["init", "-b", "main"], { cwd: repoDir });
spawnSync("git", ["config", "user.email", "t@t"], { cwd: repoDir });
spawnSync("git", ["config", "user.name", "T"], { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "# t");
spawnSync("git", ["add", "-A"], { cwd: repoDir });
spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

const scrubEnv = () => {
  const e = { ...process.env };
  for (const k of ["DEVLOOP_WORKSPACE","DEVLOOP_PROJECT","DEVLOOP_ACTOR","DEVLOOP_HUB_DB","DEVLOOP_DEV_SPLIT","DEVLOOP_DATA_DIR","DEVLOOP_RUN_DIR","DEVLOOP_PROJECTS_JSON","DEVLOOP_TEAM","DEVLOOP_HOME","DEVLOOP_PLUGIN_ROOT","DEVLOOP_PREFER_REMOTE_PLUGIN"]) delete e[k];
  return e;
};
const env = scrubEnv();
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src/team.ts"), ...args], { cwd, env, encoding: "utf8" });
const run459 = (args: string[]) => {
  const r = spawnSync("node", [join(hubRoot, "src/run-agents.ts"), ...args], { cwd: ws, env, encoding: "utf8", timeout: 10000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const ti = team(["init", "--dir", ws, "--key", "lp459", "--backend", "service"], tmp);
if (ti.status !== 0) { console.error("FAIL init:", ti.stdout, ti.stderr); process.exit(1); }
const tp = team(["add-project", "proj", "--weight", "1"], ws);
if (tp.status !== 0) { console.error("FAIL add-project:", tp.stdout, tp.stderr); process.exit(1); }
const tr = team(["add-repo", "loc", "--project", "proj", "--path", "repo", "--role", "primary"], ws);
if (tr.status !== 0) { console.error("FAIL add-repo:", tr.stdout, tr.stderr); process.exit(1); }

const gateFile = join(ws, ".dev-loop", "team", "scheduler-gate.json");

// Test 1: --once --dry-run --change-gate → no gate file
rmSync(dirname(gateFile), { recursive: true, force: true });
const d1 = run459(["--cli", "claude", "--once", "--dry-run", "--change-gate", "--agents", "pm"]);
ok(d1.code === 0, `T1: exit 0 (${d1.code})`);
ok(d1.out.includes("[dry-run]"), "T1: [dry-run] in output");
ok(!existsSync(gateFile), "T1: no gate file");

// Test 2: --dry-run (no --once) → immediate output, no gate file
rmSync(dirname(gateFile), { recursive: true, force: true });
const d2 = run459(["--cli", "claude", "--dry-run", "--change-gate", "--agents", "pm"]);
ok(d2.code === 0, `T2: exit 0 (${d2.code})`);
ok(d2.out.includes("[dry-run]"), "T2: [dry-run] in output");
ok(!existsSync(gateFile), "T2: no gate file");
console.log("T2 out:", d2.out.slice(0, 300).replace(/\n/g, " | "));

console.log(fails === 0 ? "\nLOOP459_DRYRUN_OK" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);