// DL-60 — `dev-loop-hub init-service` §15 suite. Drives the REAL `node src/init-service.ts` (and the
// `node src/server.ts init-service` bin form) against an ISOLATED temp DB + run dir + projects.json +
// plugin-root (NEVER the operator's ~/.dev-loop / real config / real hooks), and asserts:
//   • a non-"service" backend → exit-0 no-op, the hub DB is never even created (back-compat);
//   • `mode:"dry-run"` AND the `--dry-run` flag → prints every step, seeds nothing, starts no daemon;
//   • a cold perform → seeds (idempotent) → DOCTOR_OK → one-shot `daemon up` → /api/health {ok:true} →
//     reports the board URL → confirms the DL-42 SessionStart hook is present;
//   • a re-run is a clean idempotent no-op (daemon "already running", same pid, no seed error);
//   • a duplicate PREFIX → exit 1 with a clear "pick a unique prefix" error (the throw is surfaced);
//   • an absent DL-42 hook → a WARNING (not an install, not a failure — the bootstrap still succeeds);
//   • the `npm run init-service` convenience script resolves to the same standalone entry.
import { spawnSync, execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/hub-init-service";
const DB = join(ROOT, "hub.db");
const RUN = join(ROOT, "run");
const CFG = join(ROOT, "projects.json");
const PLUGIN_PRESENT = join(ROOT, "plugin-present"); // a temp plugin root WITH the DL-42 hook
const PLUGIN_ABSENT = join(ROOT, "plugin-absent");   // a temp plugin root WITHOUT hooks.json
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });
mkdirSync(join(PLUGIN_PRESENT, "hooks"), { recursive: true });
mkdirSync(PLUGIN_ABSENT, { recursive: true });
// a minimal hooks.json carrying a `daemon up` SessionStart command (mirrors the real DL-42 hook shape)
writeFileSync(join(PLUGIN_PRESENT, "hooks", "hooks.json"), JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'node "$X/hub/src/server.ts" daemon up >/dev/null 2>&1 || true' }] }] },
}));

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = (key: string): string => join(RUN, `daemon-${key}.json`);
const readRun = (key: string): { pid: number; url: string } => JSON.parse(readFileSync(runfile(key), "utf8"));

// write the isolated projects.json for a case (controls backend + mode resolution)
function cfg(projects: Record<string, { backend?: string; mode?: string }>): void {
  writeFileSync(CFG, JSON.stringify({ projects }));
}
// run `node src/init-service.ts <args>` with the isolated env; pluginRoot defaults to PLUGIN_PRESENT
function is(args: string[], pluginRoot = PLUGIN_PRESENT): ReturnType<typeof spawnSync> {
  return spawnSync("node", ["src/init-service.ts", ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: CFG, DEVLOOP_PLUGIN_ROOT: pluginRoot, DEVLOOP_ACTOR: "operator" },
  });
}

try {
  // ── 1. back-compat: a non-"service" backend → exit-0 no-op; the hub DB is never created ──
  cfg({ iscv: { backend: "local", mode: "live" } });
  const noop = is(["iscv", "Isc Project", "ISV"]);
  ok(noop.status === 0, `non-service backend → exit 0 (got ${noop.status})`);
  ok(/nothing to bootstrap/.test(noop.stdout), "non-service backend → 'nothing to bootstrap' no-op");
  ok(!existsSync(DB), "no-op never created the hub DB (back-compat: zero new surface)");

  // ── 2. dry-run via config mode:"dry-run" → prints steps, performs NONE ──
  cfg({ iscv: { backend: "service", mode: "dry-run" } });
  const dry = is(["iscv", "Isc Project", "ISV"]);
  ok(dry.status === 0, `dry-run (config) → exit 0 (got ${dry.status})`);
  ok(/\[dry-run\] would: seed/.test(dry.stdout) && /\[dry-run\] would: run doctor/.test(dry.stdout) && /\[dry-run\] would: start the daemon/.test(dry.stdout), "dry-run prints would-seed / would-doctor / would-daemon");
  ok(/preview complete/.test(dry.stdout), "dry-run → 'preview complete'");
  ok(!existsSync(DB) && !existsSync(runfile("iscv")), "dry-run performed NOTHING (no DB seeded, no daemon started)");

  // ── 3. dry-run via the --dry-run flag (config says live) → still performs nothing ──
  cfg({ iscv: { backend: "service", mode: "live" } });
  const dryFlag = is(["iscv", "Isc Project", "ISV", "--dry-run"]);
  ok(dryFlag.status === 0 && /\[dry-run\]/.test(dryFlag.stdout) && !existsSync(DB), "--dry-run flag overrides config:live → preview only, nothing performed");

  // ── 4. cold PERFORM: seed → DOCTOR_OK → daemon up → /api/health ok → board URL → hook present ──
  cfg({ iscv: { backend: "service", mode: "live" } });
  const perform = is(["iscv", "Isc Project", "ISV"]);
  ok(perform.status === 0, `perform → exit 0 (got ${perform.status})${perform.stderr ? "\n   stderr: " + perform.stderr : ""}`);
  ok(existsSync(DB) && /seeded \(idempotent on key\)/.test(perform.stdout), "perform seeded the project (idempotent on key)");
  ok(/DOCTOR_OK/.test(perform.stdout), "perform asserted DOCTOR_OK");
  ok(/Board: http:\/\/127\.0\.0\.1:/.test(perform.stdout), "perform reported the localhost board URL");
  ok(/SessionStart hook present/.test(perform.stdout), "perform confirmed the DL-42 SessionStart hook is present");
  ok(existsSync(runfile("iscv")), "perform brought the per-project daemon up (runfile written)");
  const r4 = readRun("iscv");
  const h4 = await fetch(`${r4.url}/api/health`).then((x) => x.json()).catch(() => null) as { ok?: boolean; project?: string } | null;
  ok(!!h4 && h4.ok === true && h4.project === "iscv", "the bootstrapped daemon serves /api/health {ok:true} for the project");

  // ── 5. idempotent re-run → clean no-op (daemon already running, same pid, no seed error) ──
  const rerun = is(["iscv", "Isc Project", "ISV"]);
  ok(rerun.status === 0 && /already running/.test(rerun.stdout), "re-run → exit 0, daemon 'already running' (idempotent)");
  ok(!/seed failed/.test(rerun.stdout), "re-run did not error on the idempotent re-seed");
  ok(readRun("iscv").pid === r4.pid, "re-run did NOT spawn a second daemon — same pid (idempotent lifecycle)");

  // ── 6. a duplicate PREFIX → exit 1 with a clear 'pick a unique prefix' error (clash surfaced) ──
  cfg({ iscv: { backend: "service" }, clashy: { backend: "service" } });
  const clash = is(["clashy", "Clashy", "ISV"]); // ISV already belongs to iscv (seeded in case 4)
  ok(clash.status === 1, `prefix clash → exit 1 (got ${clash.status})`);
  ok(/pick a unique prefix/.test(clash.stdout), "prefix clash → 'pick a unique prefix' error (the hard-throw is surfaced, never swallowed)");
  ok(!existsSync(runfile("clashy")), "prefix clash failed at seed → no daemon started for the clashing project");

  // ── 7. an ABSENT DL-42 hook → a WARNING, not a failure (bootstrap still succeeds, no install) ──
  cfg({ hookless: { backend: "service", mode: "live" } });
  const hookless = is(["hookless", "Hookless", "HKL"], PLUGIN_ABSENT);
  ok(hookless.status === 0, `hook absent → still exit 0 (bootstrap succeeds; got ${hookless.status})`);
  ok(/SessionStart hook NOT found/.test(hookless.stdout), "absent hook → a clear WARNING to re-sync/reinstall (never an install)");
  ok(/Board: http:\/\/127\.0\.0\.1:/.test(hookless.stdout), "absent hook did NOT block the bootstrap (board still reported)");

  // ── 8. the `npm run init-service` convenience script resolves to the same standalone entry (idempotent) ──
  const via = spawnSync("npm", ["run", "--silent", "init-service", "--", "iscv", "Isc Project", "ISV"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: CFG, DEVLOOP_PLUGIN_ROOT: PLUGIN_PRESENT, DEVLOOP_ACTOR: "operator" },
  });
  ok(via.status === 0 && /already running/.test(via.stdout), "`npm run init-service` resolves to the same standalone entry (idempotent no-op)");
} finally {
  // never leak a detached daemon: kill any we started, then drop the temp tree
  for (const key of ["iscv", "hookless", "clashy"]) {
    try { if (existsSync(runfile(key))) { const p = readRun(key).pid; if (isAlive(p)) process.kill(p, "SIGKILL"); } } catch { /* best-effort */ }
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nINIT_SERVICE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
