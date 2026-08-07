// LOOP-432 — the per-fire secret strip is keyed on POLICY (what the workspace declares), not on
// PROVENANCE (which keys the loader happened to write).
//
// The measured defect: `loadWorkspaceSecrets` only records a key in `injectedByRoot` when the real
// environment did not already have one (secrets.ts, env-wins). The strip iterated that provenance
// set, so a key declared in secrets.env that the operator ALSO exported in the launching shell was
// never stripped from any fire — the identical value, surviving only because it arrived by a
// different route. On this workspace that shipped a live third-party API key into every claude fire.
//
// The differential below is the reproduction: two keys, same file, same fire, neither in the fire's
// keep-set, one pre-exported. Before the fix exactly one of them is stripped.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseSecretsEnv, secretsDeclaredKeys, secretsInjectedKeys, scopeFireSecrets, loadWorkspaceSecrets } from "../src/secrets.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = mkdtempSync(join(tmpdir(), "dl-fire-secret-scope-"));
try {

// ── AC4: the declared-key set reuses parseSecretsEnv, and is silent on an absent file ─────────────
{
  const root = join(tmp, "declared");
  mkdirSync(join(root, ".dev-loop"), { recursive: true });

  ok(secretsDeclaredKeys(join(tmp, "no-such-ws")).size === 0,
    "AC4: a workspace with no secrets.env yields an EMPTY declared set — no throw (loadWorkspaceSecrets's contract)");

  // The full dotenv subset the shared parser accepts: `export ` prefix, quotes, comments, junk lines.
  const content = "# comment\nexport QUOTED=\"v1\"\nPLAIN=v2\n\nnot-a-pair\n9BAD=x\nTRAILING='v3'\n";
  writeFileSync(join(root, ".dev-loop", "secrets.env"), content);
  const declared = secretsDeclaredKeys(root);
  ok([...declared].sort().join(",") === "PLAIN,QUOTED,TRAILING",
    `AC4: declared keys come from parseSecretsEnv — export/quotes accepted, malformed skipped (got ${[...declared].sort().join(",")})`);
  // AC4 is "reuse the parser", not "match it by coincidence": assert the two sets are the same set.
  ok([...declared].sort().join(",") === Object.keys(parseSecretsEnv(content)).sort().join(","),
    "AC4: the key set IS parseSecretsEnv's key set — not a second parser or a regex");
}

// ── AC1 + AC3: the strip is declared-minus-keep, and keep wins ────────────────────────────────────
{
  const declared = new Set(["DECLARED_A", "DECLARED_B", "PROVIDER_KEY"]);

  // AC1 — every declared key outside keep goes, regardless of how it got into the env.
  const env: Record<string, string | undefined> = {
    DECLARED_A: "a", DECLARED_B: "b", PROVIDER_KEY: "p", AMBIENT_UNRELATED: "u", ANTHROPIC_API_KEY: "k",
  };
  const claude = scopeFireSecrets(env, declared, new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]));
  ok(env.DECLARED_A === undefined && env.DECLARED_B === undefined && env.PROVIDER_KEY === undefined,
    "AC1: every declared key outside the keep-set is deleted from the fire env");
  ok(env.AMBIENT_UNRELATED === "u",
    "AC1: a key the workspace does NOT declare is untouched — the non-goal (ambient-only keys keep their capability)");
  ok(env.ANTHROPIC_API_KEY === "k", "AC1: the fire's own auth lane survives");
  ok(claude.stripped.join(",") === "DECLARED_A,DECLARED_B,PROVIDER_KEY", `AC5: stripped names reported, sorted (got ${claude.stripped.join(",")})`);
  ok(claude.kept.join(",") === "ANTHROPIC_API_KEY",
    `AC5: kept reports only keep-set keys actually PRESENT — ANTHROPIC_AUTH_TOKEN was never set, so naming it would overstate the fire's credential surface (got ${claude.kept.join(",")})`);

  // AC3 — the opencode non-regression: the provider's own authTokenEnv is declared AND kept.
  const ocEnv: Record<string, string | undefined> = { DECLARED_A: "a", PROVIDER_KEY: "p" };
  const oc = scopeFireSecrets(ocEnv, declared, new Set(["PROVIDER_KEY"]));
  ok(ocEnv.PROVIDER_KEY === "p", "AC3: a declared key that IS this fire's providerEntry.authTokenEnv survives the wider strip");
  ok(ocEnv.DECLARED_A === undefined, "AC3: …while its declared siblings still go");
  ok(oc.kept.join(",") === "PROVIDER_KEY" && oc.stripped.join(",") === "DECLARED_A", "AC5: the opencode fire reports its own kept lane");

  // A declared key that is not in the env at all is not reported as stripped — the line describes
  // what this fire was actually holding, not what the file happens to name.
  const sparse: Record<string, string | undefined> = { DECLARED_A: "a" };
  ok(scopeFireSecrets(sparse, declared, new Set()).stripped.join(",") === "DECLARED_A",
    "AC5: a declared key absent from the env is not reported as stripped");
}

// ── AC2: loader precedence is unchanged, and the strip no longer depends on it ────────────────────
{
  const root = join(tmp, "precedence");
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  writeFileSync(join(root, ".dev-loop", "secrets.env"), "DL432_PRE_EXPORTED=from-file\nDL432_FILE_ONLY=from-file\n");

  const savedPre = process.env.DL432_PRE_EXPORTED;
  const savedOnly = process.env.DL432_FILE_ONLY;
  try {
    process.env.DL432_PRE_EXPORTED = "from-shell";   // the operator also exported it
    delete process.env.DL432_FILE_ONLY;
    loadWorkspaceSecrets(root);

    // Precedence: unchanged. The real environment still wins, and injectedByRoot still records only
    // what the loader genuinely wrote — this is what `dev-loop secret list` prints (env) vs
    // (secrets.env) from, so W12/W13 and the operator readout keep their meaning.
    ok(process.env.DL432_PRE_EXPORTED === "from-shell", "AC2: the real environment still wins in the scheduler's own process.env");
    ok(process.env.DL432_FILE_ONLY === "from-file", "AC2: an unset key is still hydrated from the file");
    const injected = secretsInjectedKeys(root);
    ok(!injected.has("DL432_PRE_EXPORTED"), "AC2: injectedByRoot still EXCLUDES the pre-exported key — `secret list` still says (env)");
    ok(injected.has("DL432_FILE_ONLY"), "AC2: …and still includes the one it wrote — still says (secrets.env)");

    // …and the fire env no longer carries it. Same key, same assertion block: the point of AC2 is
    // that these two facts now coexist, where before the first one CAUSED the second to fail.
    // Built key-by-key rather than spread from process.env (LOOP-193's guard, and it states what the
    // fixture holds); the VALUES still come from the loader's own post-hydration state.
    const fireEnv: Record<string, string | undefined> = {
      DL432_PRE_EXPORTED: process.env.DL432_PRE_EXPORTED,
      DL432_FILE_ONLY: process.env.DL432_FILE_ONLY,
      ANTHROPIC_API_KEY: "the-fire-s-own-lane",
    };
    scopeFireSecrets(fireEnv, secretsDeclaredKeys(root), new Set(["ANTHROPIC_API_KEY"]));
    ok(fireEnv.DL432_PRE_EXPORTED === undefined, "AC2: the pre-exported declared key IS stripped from the fire env despite being absent from injectedByRoot");
    ok(fireEnv.DL432_FILE_ONLY === undefined, "AC2: the file-injected key is stripped too — same policy, both routes");
  } finally {
    if (savedPre === undefined) delete process.env.DL432_PRE_EXPORTED; else process.env.DL432_PRE_EXPORTED = savedPre;
    if (savedOnly === undefined) delete process.env.DL432_FILE_ONLY; else process.env.DL432_FILE_ONLY = savedOnly;
  }
}

// ── AC6 + AC5 e2e: the measured differential, through the real scheduler ──────────────────────────
// This is the mutation-check target. Reverting the run-agents call site to iterate
// `secretsInjectedKeys` leaves DL432_E2E_PRE_EXPORTED unstripped, and the first assertion fails.
{
  const ws = join(tmp, "ws");
  const repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  const cli = (args: string[], cwd: string) => spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env: scrubFireEnv() as NodeJS.ProcessEnv });
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# t\n");
  g("add", "."); g("commit", "-qm", "init");

  ok(cli(["team", "init", "--dir", ws, "--key", "sectest", "--backend", "service", "--yes"], tmp).status === 0, "setup: team init");
  ok(cli(["team", "add-project", "secproj", "--prefix", "SEC"], ws).status === 0, "setup: add-project");
  ok(cli(["team", "add-repo", "repo", "--project", "secproj", "--path", "repo"], ws).status === 0, "setup: add-repo");

  const cfgPath = join(ws, "dev-loop.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.team.providers = { synth: { kind: "openai-compatible", baseUrl: "https://api.x.example/v1", authTokenEnv: "DL432_E2E_PROVIDER", models: ["m1"] } };
  cfg.projects.secproj.agents = {
    pm: { codingAgent: "claude", model: "opus", effort: "max" },
    qa: { codingAgent: "opencode", model: "synth/m1" },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

  // Both declared in the SAME file. Neither is in a claude fire's keep-set.
  writeFileSync(join(ws, ".dev-loop", "secrets.env"),
    "DL432_E2E_PRE_EXPORTED=from-file\nDL432_E2E_FILE_ONLY=from-file\nDL432_E2E_PROVIDER=from-file\n");

  const runSched = (args: string[], env: Record<string, string | undefined>) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd: ws, encoding: "utf8", env: { ...scrubFireEnv(), ...env } as NodeJS.ProcessEnv });

  // The operator's shell already exports one of them — the whole point of the ticket.
  const claudeOut = (() => {
    const r = runSched(["--agents", "pm", "--once", "--dry-run"], { DL432_E2E_PRE_EXPORTED: "from-shell" });
    return `${r.stdout}${r.stderr}`;
  })();
  const claudeLine = claudeOut.split("\n").find((l) => l.includes("pm: secrets:")) ?? "";

  ok(/stripped [^;]*\bDL432_E2E_PRE_EXPORTED\b/.test(claudeLine),
    `AC6: the PRE-EXPORTED declared key is stripped from a claude fire — the measured defect (line: ${claudeLine.trim() || "(no secrets line)"})`);
  ok(/stripped [^;]*\bDL432_E2E_FILE_ONLY\b/.test(claudeLine),
    "AC6: the file-injected declared key is stripped too — BOTH sides of the differential");
  ok(/stripped [^;]*\bDL432_E2E_PROVIDER\b/.test(claudeLine),
    "AC6: the provider key is stripped on a CLAUDE fire — it is not this fire's auth lane");
  ok(!/from-file|from-shell/.test(claudeOut),
    "AC5/§16: no secret VALUE appears anywhere in the dry-run output — names only");

  // AC3 e2e — the non-regression the openrouter fires depend on: on an opencode fire the provider's
  // authTokenEnv is declared AND pre-exported, and must still reach the fire.
  const ocOut = (() => {
    const r = runSched(["--agents", "qa", "--once", "--dry-run"], { DL432_E2E_PROVIDER: "from-shell", DL432_E2E_PRE_EXPORTED: "from-shell" });
    return `${r.stdout}${r.stderr}`;
  })();
  const ocLine = ocOut.split("\n").find((l) => l.includes("qa: secrets:")) ?? "";
  ok(/kept [^;]*\bDL432_E2E_PROVIDER\b/.test(ocLine),
    `AC3: on the opencode fire the pre-exported provider key is KEPT, not stripped (line: ${ocLine.trim() || "(no secrets line)"})`);
  ok(!/stripped [^;]*\bDL432_E2E_PROVIDER\b/.test(ocLine), "AC3: …and is not also reported as stripped");
  ok(/stripped [^;]*\bDL432_E2E_PRE_EXPORTED\b/.test(ocLine), "AC3: its declared siblings are still stripped on that same fire");
}

} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails === 0 ? "\nFIRE_SECRET_SCOPE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
