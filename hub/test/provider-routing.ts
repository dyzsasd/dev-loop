// Model-provider routing suite (docs/design/model-provider-routing.md; PORTABILITY §5 certification):
// E16 registry validation, opencode.json render/sync (create-or-merge, never clobber), the scheduler's
// opencode lane (--variant, certified OPENCODE_PERMISSION injection, pre-spawn provider-env-missing,
// fire-ledger provider dimension), doctor W13/W14, and claude-lane parity (no provider artifacts).
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
  ok(missRow?.fireError === "provider-env-missing" && missRow?.provider === "synth" && missRow?.exitCode === 4,
    `pre-spawn: ledger row carries fireError/provider/exit 4 (got ${JSON.stringify(missRow)})`);

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
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "provider-routing: all checks passed");
process.exit(fails ? 1 : 0);
