import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const run = (args: string[]) => {
  const r = spawnSync("node", ["src/run-agents.ts", ...args], { cwd: hubRoot, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const tmp = mkdtempSync(join(tmpdir(), "dl-run-agents-"));
try {
  const data = join(tmp, "data");
  const repo = join(tmp, "repo");
  const otherRepo = join(tmp, "other-repo");
  const outside = join(tmp, "outside");
  mkdirSync(data, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(otherRepo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: { demo: { repoPath: repo }, fallback: { repoPath: otherRepo } },
  }));
  const common = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "demo"];
  const noProjectCommon = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--cwd", repo];

  const defaultCore = run(["--cli", "claude", "--once", "--dry-run", ...common]);
  ok(defaultCore.code === 0, "default scheduler exits 0");
  ok(/agents=pm@5m, qa@5m, senior-dev@5m, junior-dev@5m, sweep@30m/.test(defaultCore.out), "default core uses split-dev agents");
  ok(/launch=pm:claude:opus\/max, qa:claude:sonnet\/high, senior-dev:claude:claude-opus-4-8\/max, junior-dev:claude:claude-sonnet-4-6\/high, sweep:claude:sonnet\/high/.test(defaultCore.out),
    "default core applies per-agent Claude coding-agent/model/effort profiles");
  ok(/devSplit=runtime/.test(defaultCore.out), "default core marks split-dev runtime mode");
  ok(/DEVLOOP_DEV_SPLIT":"true"/.test(defaultCore.out), "default core injects DEVLOOP_DEV_SPLIT=true");
  ok(/junior-dev: claude .* --model claude-sonnet-4-6 --effort high /.test(defaultCore.out),
    "junior-dev is pinned to the Sonnet/high default");

  const claude = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm,communication", "--interval", "pm=2m", "--cli-arg", "--model", "--cli-arg", "opus", ...common]);
  ok(claude.code === 0, "claude dry-run scheduler exits 0");
  ok(/agents=pm@2m, communication@1d/.test(claude.out), "claude dry-run shows resolved agents + interval override");
  ok(/pm: claude --mcp-config .* --strict-mcp-config --model opus --effort max --model opus -p '?<prompt:\d+ chars>'?/.test(claude.out), "claude dry-run injects model/effort defaults, keeps extra CLI args last, and renders without dumping the prompt");
  ok(/dev-loop-hub/.test(claude.out), "the inline --mcp-config defines the dev-loop-hub server (no plugin / .mcp.json needed)");
  ok(/communication: claude --mcp-config .* --strict-mcp-config --model sonnet --effort high --model opus -p '?<prompt:\d+ chars>'?/.test(claude.out), "communication-agent gets its own default profile and remains overrideable through --cli-arg");

  const codex = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "communication", ...common]);
  ok(codex.code === 0, "codex dry-run scheduler exits 0");
  ok(/codex exec/.test(codex.out), "codex dry-run uses codex exec");
  ok(/codex exec --model gpt-5\.5 -c 'model_reasoning_effort="high"'/.test(codex.out), "codex dry-run injects model + reasoning effort defaults");
  ok(/mcp_servers\.dev-loop-hub\.command="[^"]*node[^"]*"/.test(codex.out), "codex dry-run DEFINES the hub server via -c (no pre-existing config.toml block needed)");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_ACTOR="communication"/.test(codex.out), "codex dry-run injects per-agent actor with -c");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_PROJECT="demo"/.test(codex.out), "codex dry-run injects project with -c");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_DEV_SPLIT="false"/.test(codex.out), "codex dry-run injects the runtime dev-split switch");
  ok(!/dangerously-bypass/.test(codex.out), "--codex-safe omits unsafe bypass flags");

  const inferred = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "communication", ...noProjectCommon]);
  ok(inferred.code === 0, "runner can omit --project when cwd is inside a configured repo");
  ok(/project=demo cwd=/.test(inferred.out), "cwd→repoPath inference resolves the project");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_PROJECT="demo"/.test(inferred.out), "inferred project is injected into Codex with -c");

  const unresolved = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "communication", "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--cwd", outside]);
  ok(unresolved.code === 2 && /no project resolved from cwd/.test(unresolved.out) && /Configured projects: demo, fallback/.test(unresolved.out),
    "runner refuses to guess defaultProject/demo when cwd is outside every configured repo");

  const split = run(["--cli", "claude", "--once", "--dry-run", "--agents", "core", "--dev-split", ...common]);
  ok(split.code === 0, "--dev-split dry-run exits 0");
  ok(/devSplit=runtime/.test(split.out), "--dev-split marks this runner as split-dev at runtime");
  ok(/agents=pm@5m, qa@5m, senior-dev@5m, junior-dev@5m, sweep@30m/.test(split.out), "--dev-split replaces dev with senior-dev + junior-dev");
  ok(/DEVLOOP_DEV_SPLIT":"true"/.test(split.out), "--dev-split injects DEVLOOP_DEV_SPLIT=true into the Claude MCP env");

  const legacy = run(["--cli", "claude", "--once", "--dry-run", "--agents", "legacy", ...common]);
  ok(legacy.code === 0, "legacy single-dev group exits 0");
  ok(/agents=pm@5m, qa@5m, dev@5m, sweep@30m/.test(legacy.out), "legacy group keeps the single dev agent");
  ok(!/devSplit=runtime/.test(legacy.out), "legacy group does not mark split-dev runtime mode");
  ok(/DEVLOOP_DEV_SPLIT":"false"/.test(legacy.out), "legacy group injects DEVLOOP_DEV_SPLIT=false");

  const explicitSplit = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm,qa,senior-dev,junior-dev,sweep", ...common]);
  ok(explicitSplit.code === 0, "explicit senior/junior selection exits 0");
  ok(/devSplit=runtime/.test(explicitSplit.out), "explicit senior/junior selection also marks split-dev runtime mode");
  ok(/DEVLOOP_DEV_SPLIT":"true"/.test(explicitSplit.out), "explicit senior/junior selection injects DEVLOOP_DEV_SPLIT=true");

  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: {
      demo: {
        repoPath: repo,
        models: { pm: { claude: "claude-sonnet-4-6", codex: "gpt-5.5-mini" } },
        efforts: { pm: "extrahigh" },
      },
      fallback: { repoPath: otherRepo },
    },
  }));
  const overrideClaude = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", ...common]);
  ok(overrideClaude.code === 0, "claude model/effort override exits 0");
  ok(/launch=pm:claude:claude-sonnet-4-6\/xhigh/.test(overrideClaude.out), "claude model/effort override is reflected in launch summary");
  ok(/pm: claude .* --model claude-sonnet-4-6 --effort xhigh /.test(overrideClaude.out), "claude command applies project model/effort override");

  const overrideCodex = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "pm", ...common]);
  ok(overrideCodex.code === 0, "codex model/effort override exits 0");
  ok(/launch=pm:codex:gpt-5\.5-mini\/xhigh/.test(overrideCodex.out), "codex model/effort override is reflected in launch summary");
  ok(/pm: codex exec --model gpt-5\.5-mini -c 'model_reasoning_effort="xhigh"'/.test(overrideCodex.out), "codex command applies project model/effort override");

  // --- Two-level launch config: agents{}.codingAgent (L1) + model/effort (L2),
  //     codingAgentDefaults{} per-coding-agent defaults, defaultCodingAgent, mixed-CLI runs. ---
  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: {
      demo: {
        repoPath: repo,
        codingAgentDefaults: {
          claude: { model: "haiku", effort: "low" },
          codex: { model: "gpt-5.5-codex", effort: "medium" },
        },
        agents: {
          "junior-dev": { codingAgent: "codex", model: "gpt-5.5", effort: "high" }, // different CLI than --cli
          "senior-dev": { model: "claude-opus-4-8", effort: "max" },                 // inherits run CLI (claude)
          "pm": { codingAgent: "opencode", model: "anthropic/claude-opus-4-8" },     // opencode pane
        },
        models: { qa: { claude: "sonnet" } }, // back-compat map still applies where agents{} doesn't
      },
      fallback: { repoPath: otherRepo },
    },
  }));
  const twoLevel = run(["--cli", "claude", "--once", "--dry-run", "--codex-safe", "--agents", "pm,qa,senior-dev,junior-dev,sweep", ...common]);
  ok(twoLevel.code === 0, "two-level config dry-run exits 0");
  ok(/junior-dev:codex:gpt-5\.5\/high/.test(twoLevel.out), "junior-dev resolves to its own codingAgent=codex, overriding --cli claude");
  ok(/junior-dev: codex exec --model gpt-5\.5 -c 'model_reasoning_effort="high"'/.test(twoLevel.out), "junior-dev renders a codex command inside a claude run (mixed-CLI)");
  ok(/senior-dev:claude:claude-opus-4-8\/max/.test(twoLevel.out), "senior-dev inherits the run CLI (claude) with its agents{} model/effort");
  ok(/senior-dev: claude .* --model claude-opus-4-8 --effort max /.test(twoLevel.out), "senior-dev renders a claude command with its pinned model/effort");
  ok(/pm:opencode:anthropic\/claude-opus-4-8\//.test(twoLevel.out), "pm resolves to codingAgent=opencode with its model");
  ok(/pm: opencode run --model anthropic\/claude-opus-4-8 /.test(twoLevel.out), "pm renders an opencode run command");
  ok(/sweep:claude:haiku\/low/.test(twoLevel.out), "sweep takes the per-coding-agent default (claude haiku/low) from codingAgentDefaults");
  ok(/qa:claude:sonnet\/low/.test(twoLevel.out), "qa uses back-compat models{} for model + codingAgentDefaults for effort");

  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: {
      demo: { repoPath: repo, defaultCodingAgent: "codex" },
      fallback: { repoPath: otherRepo },
    },
  }));
  const defCoding = run(["--once", "--dry-run", "--codex-safe", "--agents", "sweep", ...common]);
  ok(defCoding.code === 0 && /sweep:codex:/.test(defCoding.out), "project defaultCodingAgent=codex applies when --cli is not passed");
  const explicitBeatsDefault = run(["--cli", "claude", "--once", "--dry-run", "--agents", "sweep", ...common]);
  ok(/sweep:claude:/.test(explicitBeatsDefault.out), "an explicit --cli claude beats project defaultCodingAgent=codex");
  const cliOpencode = run(["--cli", "opencode", "--once", "--dry-run", "--agents", "sweep", ...common]);
  ok(cliOpencode.code === 0 && /sweep:opencode:/.test(cliOpencode.out), "--cli opencode is accepted as a run-wide coding agent");

  const bad = run(["--cli", "claude", "--once", "--dry-run", "--agents", "nope", ...common]);
  ok(bad.code === 2 && /unknown agent\/group 'nope'/.test(bad.out), "unknown agent fails with a usage error");

  // DX regression: a garbage DEVLOOP_RUNNER_CLI used to crash with an opaque
  // "Cannot read properties of undefined (reading 'model')" — now the same clean die() as --cli.
  const runEnv = (args: string[], env: Record<string, string>) => {
    const r = spawnSync("node", ["src/run-agents.ts", ...args], { cwd: hubRoot, encoding: "utf8", env: { ...process.env, ...env } });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const badEnvCli = runEnv(["--once", "--dry-run", "--agents", "sweep", ...common], { DEVLOOP_RUNNER_CLI: "garbage" });
  ok(badEnvCli.code === 2 && /DEVLOOP_RUNNER_CLI must be claude, codex, or opencode \(got 'garbage'\)/.test(badEnvCli.out),
    "garbage DEVLOOP_RUNNER_CLI fails with the clean --cli-style error, not a TypeError");

  // DX regression: service-backend preflight — an unseeded project used to burn a full LLM fire per agent
  // with zero hub tools (the MCP server boots into its G2 refusal). Now: real run dies before any spawn;
  // dry-run warns but previews on.
  writeFileSync(join(data, "projects.json"), JSON.stringify({
    projects: { demo: { repoPath: repo }, fallback: { repoPath: otherRepo }, svc: { repoPath: repo, backend: "service" } },
  }));
  const svcCommon = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "svc"];
  const svcDry = run(["--cli", "claude", "--once", "--dry-run", "--agents", "sweep", ...svcCommon]);
  ok(svcDry.code === 0 && /WARNING: project 'svc' is backend:"service" but not seeded/.test(svcDry.out),
    "unseeded service project + --dry-run → warning, preview continues (exit 0)");
  const svcReal = run(["--cli", "claude", "--once", "--agents", "sweep", ...svcCommon]);
  ok(svcReal.code === 2 && /not seeded in the hub DB/.test(svcReal.out) && /dev-loop seed svc/.test(svcReal.out),
    "unseeded service project + real run → dies with the seed command BEFORE spawning any agent");
  execFileSync("node", ["src/seed.ts", "svc", "Svc Project", "SVX", join(tmp, "hub.db")], { cwd: hubRoot, encoding: "utf8" });
  const svcSeeded = run(["--cli", "claude", "--once", "--dry-run", "--agents", "sweep", ...svcCommon]);
  ok(svcSeeded.code === 0 && !/WARNING: project 'svc'/.test(svcSeeded.out),
    "seeded service project → preflight passes silently");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
