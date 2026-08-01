import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeSeenLineWindow, RETRY_LOOP_LINE_WINDOW } from "../src/seen-lines.ts";
import { openDb, logEvent } from "../src/db.ts";
// NB: run-agents.ts must NOT be imported here — its main() runs unconditionally (LOOP-58), so an import
// would launch the scheduler. recordFire's ledger/event writes are asserted via real-fire subprocess
// harnesses (test/team-scheduler.ts, test/run-agents-live.ts).
import { breaker, formatBreakerMsg, PROVIDER_SCOPED_CLASSES, type Agent } from "../src/breaker.ts";
import { codexUsageAdapter, claudeAdapter, opencodeAdapter, resolveAdapter } from "../src/fire-usage.ts";
import { releaseClaimedTickets } from "../src/ticket-release.ts";
import { insertTicket } from "../src/ticketwrite.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const run = (args: string[]) => {
  const env = { ...process.env };
  delete env.DEVLOOP_PROJECTS_JSON; delete env.DEVLOOP_PROJECT; delete env.DEVLOOP_ACTOR;
  delete env.DEVLOOP_HUB_DB; delete env.DEVLOOP_DEV_SPLIT; delete env.DEVLOOP_DATA_DIR;
  delete env.DEVLOOP_RUN_DIR; delete env.DEVLOOP_PLUGIN_ROOT;
  const r = spawnSync("node", ["src/run-agents.ts", ...args], { cwd: hubRoot, encoding: "utf8", env });
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

// ── LOOP-58: `dev-loop run` must still fire when the checkout path contains a URL-escaped char ──
// LOOP-12 guarded the entry with `import.meta.url === \`file://${process.argv[1]}\`` — but import.meta.url
// is percent-ENCODED while process.argv[1] is a RAW path, so on any path with a space (macOS Google Drive /
// iCloud Drive checkouts) the guard silently failed: main() never ran and `dev-loop run` exited 0 having
// fired, logged, and reported nothing. Copy the source into a directory whose name contains a space and
// assert the entry still prints its usage — this FAILS against the guarded form (0-byte stdout) and PASSES
// with the unconditional main(). realpathSync isolates the defect to the space (not a /tmp symlink).
{
  const spaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "dl run agents ")));       // last segment holds spaces
  cpSync(join(hubRoot, "src"), join(spaceRoot, "src"), { recursive: true });
  writeFileSync(join(spaceRoot, "package.json"), JSON.stringify({ type: "module" }));  // ESM for the copied .ts
  const spaced = spawnSync("node", [join(spaceRoot, "src", "run-agents.ts"), "--help"], { encoding: "utf8" });
  const spacedOut = spaced.stdout ?? "";
  ok(spacedOut.length > 0 && /--dry-run/.test(spacedOut),
    `LOOP-58: run-agents.ts --help fires from a path containing a space (${spacedOut.length}B stdout, exit ${spaced.status})`);
  rmSync(spaceRoot, { recursive: true, force: true });
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
  ok(/pm: claude --mcp-config .* --strict-mcp-config --model opus --effort max --output-format json --model opus -p '?<prompt:\d+ chars>'?/.test(claude.out), "claude dry-run injects model/effort defaults + --output-format json (usage capture), keeps extra CLI args last, and renders without dumping the prompt");
  ok(/dev-loop-hub/.test(claude.out), "the inline --mcp-config defines the dev-loop-hub server (no plugin / .mcp.json needed)");
  ok(/communication: claude --mcp-config .* --strict-mcp-config --model sonnet --effort high --output-format json --model opus -p '?<prompt:\d+ chars>'?/.test(claude.out), "communication-agent gets its own default profile (+ --output-format json) and remains overrideable through --cli-arg");

  // boot-prefix (conventions-to-code phase 0): --assemble-boot appends the deterministic §0a corpus and
  // flips the claude prompt channel to stdin (Linux MAX_ARG_STRLEN caps a single execve arg at 128 KiB).
  const boot = run(["--cli", "claude", "--once", "--dry-run", "--assemble-boot", "--agents", "pm", ...common]);
  ok(boot.code === 0, "assemble-boot dry-run exits 0");
  ok(/pm: boot corpus \d+KB \(conventions \d+KB; lessons \d+B(; config-pruned [^)]+)?\) hash=[0-9a-f]{12} — prompt via stdin/.test(boot.out),
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
  ok(/codex exec --json --model gpt-5\.5 -c 'model_reasoning_effort="high"'/.test(codex.out), "codex dry-run injects --json (structured output) + model + reasoning effort defaults");
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
  ok(/pm: claude --model opus --effort max --output-format json -p '?<prompt:\d+ chars>'?/.test(cliDefault.out),
    "interface=cli claude command drops the hub injection entirely (model/effort + --output-format json + prompt) — D9 default, the lane LOOP-13 regressed");
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
  ok(/pm: codex exec --json --model gpt-5\.5-mini -c 'model_reasoning_effort="xhigh"'/.test(overrideCodex.out), "codex command applies project model/effort override");

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
  ok(/junior-dev: codex exec --json --model gpt-5\.5 -c 'model_reasoning_effort="high"'/.test(twoLevel.out), "junior-dev renders a codex command inside a claude run (mixed-CLI)");
  ok(/senior-dev:claude:claude-opus-4-8\/max/.test(twoLevel.out), "senior-dev inherits the run CLI (claude) with its agents{} model/effort");
  ok(/senior-dev: claude .*--model claude-opus-4-8 --effort max /.test(twoLevel.out), "senior-dev renders a claude command with its pinned model/effort");
  ok(/pm:opencode:anthropic\/claude-opus-4-8\//.test(twoLevel.out), "pm resolves to codingAgent=opencode with its model");
  ok(/pm: opencode run --model anthropic\/claude-opus-4-8 --format json /.test(twoLevel.out), "pm renders an opencode run command with --format json (LOOP-85 usage capture), extra CLI args last");
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
  ok(/sweep: opencode run --format json /.test(cliOpencode.out), "LOOP-85: the model-less opencode command also carries --format json (usage capture on every opencode fire)");

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
    const base = { ...process.env };
    delete base.DEVLOOP_PROJECTS_JSON; delete base.DEVLOOP_PROJECT; delete base.DEVLOOP_ACTOR;
    delete base.DEVLOOP_HUB_DB; delete base.DEVLOOP_DEV_SPLIT; delete base.DEVLOOP_DATA_DIR;
    delete base.DEVLOOP_RUN_DIR; delete base.DEVLOOP_PLUGIN_ROOT;
    const r = spawnSync("node", ["src/run-agents.ts", ...args], { cwd: hubRoot, encoding: "utf8", env: { ...base, ...env } });
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

  // LOOP-12 AC: recordFire writes fireId to both the hub event and the JSONL ledger. This used to be a
  // direct `import { recordFire }` + call here — impossible now that main() is unconditional (LOOP-58), and
  // it could only ever reach the hub event, never the module-level `fireLedgerPath` ledger. Both writes are
  // now asserted on REAL fires: the fires.jsonl row in test/team-scheduler.ts, the fire.completed event's
  // fireId in test/run-agents-live.ts §5. Read-side FireRow.fireId? parsing stays in test/metrics.ts.

  // LOOP-12 AC: a linear/local (no-hub) fire does not crash.
  const linearFire = run(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", "--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "fallback"]);
  ok(linearFire.code === 0, "LOOP-12: linear-backend fire (no hub) exits 0 — no fireId crash");

  // ── LOOP-9: per-agent fireTimeout/stallTimeout config (resolution order + application) ─────────────
  // The resolution order is: per-agent config > explicit --fire-timeout/--stall-timeout CLI flag >
  // per-lane/global default (1h fire, 10m stall for opencode, off for claude/codex).
  //
  // runL9: like run() but overrides DEVLOOP_WORKSPACE to a missing path so tryResolveWorkspace()
  // returns null and the scheduler falls through to the legacy fixed-project path (legacy projects.json).
  // Without this, nested worktrees find the parent workspace and enter teamMain() — which rejects
  // "demo" because that project doesn't exist in the real workspace config.
  const runL9 = (args: string[]) => {
    // Clear workspace-discovery env vars so the subprocess uses the --data flag (not the operator env).
    const { DEVLOOP_WORKSPACE: _ws, DEVLOOP_PROJECTS_JSON: _pj, DEVLOOP_HUB_DB: _hdb, DEVLOOP_TEAM: _dt, ...inheritedEnv } = process.env;
    const r = spawnSync("node", ["src/run-agents.ts", ...args], {
      cwd: hubRoot, encoding: "utf8",
      env: { ...inheritedEnv, DEVLOOP_WORKSPACE: "/dev/null/no-workspace" },
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: {
      demo: {
        repoPath: repo,
        backend: "service",
        hub: { agentInterface: { claude: "mcp", codex: "mcp" } },
        agents: {
          pm:    { fireTimeout: "30m" },       // per-agent override; beats CLI default
          sweep: { stallTimeout: "0" },         // explicit "0" = disable stall for sweep
          qa:    { fireTimeout: "0", stallTimeout: "5m" },  // both disabled fire + explicit stall
        },
      },
      fallback: { repoPath: otherRepo },
    },
  }));

  const timeoutPm = runL9(["--cli", "claude", "--once", "--dry-run", "--agents", "pm", ...common]);
  ok(timeoutPm.code === 0, "LOOP-9: per-agent fireTimeout config dry-run exits 0");
  ok(/\[dry-run\] pm:.*fireTimeout=30m/.test(timeoutPm.out),
    "LOOP-9: per-agent agents.pm.fireTimeout='30m' overrides the 1h default — dry-run shows 30m");
  ok(/\[dry-run\] pm:.*stallTimeout=off/.test(timeoutPm.out),
    "LOOP-9: stallTimeout stays off for claude (no per-agent override, no --stall-timeout flag)");

  const timeoutSweep = runL9(["--cli", "claude", "--once", "--dry-run", "--agents", "sweep", ...common]);
  ok(/\[dry-run\] sweep:.*stallTimeout=off/.test(timeoutSweep.out),
    "LOOP-9: agents.sweep.stallTimeout='0' renders as stallTimeout=off");
  ok(/\[dry-run\] sweep:.*fireTimeout=1h/.test(timeoutSweep.out),
    "LOOP-9: sweep.fireTimeout not configured — default 1h applies");

  const timeoutQa = runL9(["--cli", "claude", "--once", "--dry-run", "--agents", "qa", ...common]);
  ok(/\[dry-run\] qa:.*fireTimeout=off/.test(timeoutQa.out),
    "LOOP-9: agents.qa.fireTimeout='0' renders as fireTimeout=off");
  ok(/\[dry-run\] qa:.*stallTimeout=5m/.test(timeoutQa.out),
    "LOOP-9: agents.qa.stallTimeout='5m' overrides the per-lane default");

  // Per-agent config beats an explicit CLI flag.
  const timeoutPmVsCli = runL9(["--cli", "claude", "--once", "--dry-run", "--agents", "pm",
    "--fire-timeout", "2h", ...common]);
  ok(/\[dry-run\] pm:.*fireTimeout=30m/.test(timeoutPmVsCli.out),
    "LOOP-9: per-agent config (30m) beats explicit --fire-timeout 2h (resolution order: config > CLI > default)");

  // Default (no agent config, no CLI flag): 1h fire timeout, off stall for claude.
  const timeoutJunior = runL9(["--cli", "claude", "--once", "--dry-run", "--agents", "junior-dev", ...common]);
  ok(/\[dry-run\] junior-dev:.*fireTimeout=1h/.test(timeoutJunior.out),
    "LOOP-9: junior-dev has no per-agent config — default 1h fire timeout applies");
  ok(/\[dry-run\] junior-dev:.*stallTimeout=off/.test(timeoutJunior.out),
    "LOOP-9: claude/codex stall default is off when neither config nor --stall-timeout is set");

  // ── P0-1b: provider-scoped circuit breaker (LOOP-8) ─────────────────────────────────────────────────
  // 5 same-class failures spread across 3 agents on one provider trips it; a 4th agent on that provider
  // is immediately probe-capped without accumulating its own streak; an agent on a different provider is
  // not affected; one success on the provider closes all provider breakers.
  {
    breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
    const savedThreshold = breaker.threshold;
    breaker.threshold = 5;
    const events: Array<{ ev: string; agent: string; key: string }> = [];
    const savedOnEvent = breaker.onEvent;
    breaker.onEvent = (agent, ev, key) => events.push({ ev, agent, key });

    // Pre-register providers — simulates the steady-state where each agent has fired at least once.
    for (const a of ["pm", "qa", "senior-dev", "junior-dev"] as const) breaker._agentProvider.set(a, "anthropic");
    breaker._agentProvider.set("sweep", "openai");

    // 5 spend-limit failures spread across 3 agents on "anthropic" → trips the provider breaker.
    breaker.record("pm",         1, "spend-limit", "spend limit exceeded", "anthropic");
    breaker.record("qa",         1, "spend-limit", "spend limit exceeded", "anthropic");
    breaker.record("senior-dev", 1, "spend-limit", "spend limit exceeded", "anthropic");
    breaker.record("pm",         1, "spend-limit", "spend limit exceeded", "anthropic");
    ok(!breaker.isOpen("junior-dev"), "P0-1b: 4 of 5 failures — provider breaker not yet open");
    breaker.record("qa",         1, "spend-limit", "spend limit exceeded", "anthropic"); // 5th → trips

    ok(events.some(e => e.ev === "open" && e.key.includes("anthropic") && e.key.includes("spend-limit")),
      "P0-1b: provider breaker OPEN event names the provider and error class");
    ok(breaker.isOpen("pm"),         "P0-1b: pm (anthropic) is probe-capped after provider breaker opens");
    ok(breaker.isOpen("qa"),         "P0-1b: qa (anthropic) is probe-capped after provider breaker opens");
    ok(breaker.isOpen("junior-dev"), "P0-1b: junior-dev (4th agent, same provider) immediately probe-capped without re-accumulation");
    ok(!breaker.isOpen("sweep"),     "P0-1b: sweep (openai) NOT capped by the anthropic provider breaker");
    ok(breaker.intervalFor("junior-dev", 10_000) >= breaker.probeMs, "P0-1b: intervalFor caps junior-dev at probe cadence");
    ok(breaker.intervalFor("sweep", 10_000) === 10_000,              "P0-1b: intervalFor leaves sweep at normal cadence");

    // Non-provider-scoped class (null) accumulates in byAgent, not byProvider.
    breaker.record("pm", 1, null, "task error", "anthropic");
    ok(!breaker.byProvider.has("anthropic:null"), "P0-1b: null errorClass does NOT accumulate in byProvider");
    ok((breaker.byAgent.get("pm")?.streak ?? 0) > 0, "P0-1b: null errorClass DOES accumulate in byAgent for pm");

    // One success on the provider closes all provider breakers for that provider.
    events.length = 0;
    breaker.record("pm", 0, null, undefined, "anthropic");
    ok(events.some(e => e.ev === "close" && e.key.includes("anthropic")),
      "P0-1b: provider breaker CLOSE event fires after a success on the provider");
    ok(!breaker.isOpen("pm"),         "P0-1b: pm back to normal cadence after provider success");
    ok(!breaker.isOpen("qa"),         "P0-1b: qa back to normal cadence after provider success");
    ok(!breaker.isOpen("junior-dev"), "P0-1b: junior-dev back to normal cadence after provider success");
    ok(!breaker.isOpen("sweep"),      "P0-1b: sweep (openai) still not open after anthropic success");

    breaker.threshold = savedThreshold;
    breaker.byAgent.clear(); breaker.byProvider.clear(); breaker._agentProvider.clear();
    breaker.onEvent = savedOnEvent;
  }

  // ── LOOP-175: formatBreakerMsg — provider-scoped vs agent-scoped message shapes ──────────────────────
  // Regression: provider-scoped OPEN/CLOSE name the provider + blast radius, not the tripping agent.
  // Agent-scoped OPEN/CLOSE keep the original per-agent wording unchanged.
  {
    const providerMap = new Map<Agent, string | null>([
      ["pm", "anthropic"], ["qa", "anthropic"], ["senior-dev", "anthropic"],
      ["junior-dev", "anthropic"], ["sweep", "openai"],
    ]);

    // Provider-scoped OPEN — key emitted by breaker: "[provider=anthropic] rate-limit"
    const openMsg = formatBreakerMsg("qa", "open", "[provider=anthropic] rate-limit", 5, "1h", providerMap);
    ok(!openMsg.startsWith("breaker OPEN: qa"), "LOOP-175 AC1: provider OPEN does not name the agent as subject");
    ok(openMsg.includes("provider anthropic"), "LOOP-175 AC1: provider OPEN names the provider");
    ok(openMsg.includes("rate-limit"), "LOOP-175 AC1: provider OPEN names the errorClass");
    ok(openMsg.includes("tripped by qa"), "LOOP-175 AC1: provider OPEN mentions tripping agent as detail");
    ok(openMsg.includes("junior-dev") && openMsg.includes("pm"), "LOOP-175 AC1: provider OPEN lists all lanes on that provider");
    ok(!openMsg.includes("sweep"), "LOOP-175 AC1: provider OPEN excludes agents on a different provider");

    // Provider-scoped CLOSE — key emitted by breaker: "anthropic:rate-limit"
    const closeMsg = formatBreakerMsg("pm", "close", "anthropic:rate-limit", 5, "1h", providerMap);
    ok(!closeMsg.startsWith("breaker CLOSED: pm"), "LOOP-175 AC2: provider CLOSE does not name agent as subject");
    ok(closeMsg.includes("provider anthropic"), "LOOP-175 AC2: provider CLOSE names the provider");
    ok(closeMsg.includes("rate-limit"), "LOOP-175 AC2: provider CLOSE names the errorClass");
    ok(closeMsg.includes("recovery by pm"), "LOOP-175 AC2: provider CLOSE mentions recovering agent");

    // Agent-scoped OPEN — keeps original wording (LOOP-175 AC3)
    const agentOpenMsg = formatBreakerMsg("sweep", "open", "task-failed", 3, "1h", providerMap);
    ok(agentOpenMsg.startsWith("breaker OPEN: sweep →"), "LOOP-175 AC3: agent-scoped OPEN still names the agent as subject");
    ok(agentOpenMsg.includes("task-failed"), "LOOP-175 AC3: agent-scoped OPEN includes the error key");

    // Agent-scoped CLOSE — keeps original wording (LOOP-175 AC3)
    const agentCloseMsg = formatBreakerMsg("sweep", "close", "task-failed", 3, "1h", providerMap);
    ok(agentCloseMsg.startsWith("breaker CLOSED: sweep"), "LOOP-175 AC3: agent-scoped CLOSE still names the agent");

    // PROVIDER_SCOPED_CLASSES covers rate-limit, spend-limit, auth — provider-scoped pattern applies to all
    for (const cls of PROVIDER_SCOPED_CLASSES) {
      const msg = formatBreakerMsg("qa", "open", `[provider=anthropic] ${cls}`, 5, "1h", providerMap);
      ok(msg.includes(`provider anthropic (${cls})`), `LOOP-175 AC3: ${cls} is provider-scoped`);
    }
  }

  // ── LOOP-19: releaseClaimedTickets — runner-side infra-kill release ──────────────────────────────────
  // Tests exercise the function directly via hub/src/ticket-release.ts (safe to import — no unconditional
  // main()) to cover all four ACs without needing a real hanging CLI binary.
  {
    const testDb19 = join(tmp, "loop19-release.db");
    const db19 = openDb(testDb19);
    execFileSync("node", ["src/seed.ts", "rlt", "Release Test", "RLT", testDb19], { cwd: hubRoot, encoding: "utf8" });
    const projectId19 = (db19.prepare("SELECT id FROM projects WHERE key='rlt'").get() as { id: string }).id;
    const testFireId19 = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

    // AC1 — a ticket claimed by the fire is released to Todo with tier assignee preserved and attribution comment
    const claimedId = insertTicket(db19, projectId19, "junior-dev",
      { title: "claimed ticket", description: "", type: "Feature", state: "In Progress",
        assignee: "junior-dev", priority: 2, labels: ["dev-loop", "junior-dev"], duplicateOf: null, relatedTo: [] },
      { title: "claimed ticket", type: "Feature" });
    // Stamp the claim event (issue.transition → In Progress with this fire's fireId)
    db19.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)")
      .run(projectId19, claimedId, "junior-dev", "issue.transition",
        JSON.stringify({ from: "Todo", to: "In Progress", assignee: "junior-dev", fireId: testFireId19 }),
        new Date().toISOString());

    releaseClaimedTickets(db19, "rlt", "junior-dev", testFireId19, "timeout");

    const after19 = db19.prepare("SELECT state,assignee FROM tickets WHERE id=?").get(claimedId) as { state: string; assignee: string | null } | undefined;
    ok(after19?.state === "Todo", "LOOP-19 AC1: infra-killed ticket is released back to Todo");
    ok(after19?.assignee === "junior-dev", "LOOP-19 AC1: tier assignee is preserved on release (not unassigned)");
    const comment19 = db19.prepare("SELECT body FROM comments WHERE ticket_id=? ORDER BY created_at DESC LIMIT 1").get(claimedId) as { body: string } | undefined;
    ok(!!(comment19?.body?.includes("infrastructure")), "LOOP-19 AC1: attribution comment names the kill class");
    ok(!!(comment19?.body?.includes("runner-side automatic")), "LOOP-19 AC1: attribution comment distinguishes runner-side from agent judgment");

    // AC2 — a claim the fire legitimately advanced (In Progress → In Review) before the kill is NOT released
    const advancedId = insertTicket(db19, projectId19, "junior-dev",
      { title: "advanced ticket", description: "", type: "Feature", state: "In Review",
        assignee: "junior-dev", priority: 2, labels: ["dev-loop", "junior-dev"], duplicateOf: null, relatedTo: [] },
      { title: "advanced ticket", type: "Feature" });
    db19.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES (?,?,?,?,?,?)")
      .run(projectId19, advancedId, "junior-dev", "issue.transition",
        JSON.stringify({ from: "Todo", to: "In Progress", assignee: "junior-dev", fireId: testFireId19 }),
        new Date().toISOString());

    releaseClaimedTickets(db19, "rlt", "junior-dev", testFireId19, "timeout");

    const after19b = db19.prepare("SELECT state FROM tickets WHERE id=?").get(advancedId) as { state: string } | undefined;
    ok(after19b?.state === "In Review", "LOOP-19 AC2: a legitimately-advanced claim (In Review) is NOT touched by release");

    // AC3 — null/undefined db (linear/local — no hub events ledger) does not crash and releases nothing
    let ac3Threw = false;
    try { releaseClaimedTickets(null, "rlt", "junior-dev", testFireId19); }
    catch { ac3Threw = true; }
    ok(!ac3Threw, "LOOP-19 AC3: null db (linear/local no-hub) does not throw — degrades gracefully");

    let ac3bThrew = false;
    try { releaseClaimedTickets(undefined, "rlt", "junior-dev", testFireId19); }
    catch { ac3bThrew = true; }
    ok(!ac3bThrew, "LOOP-19 AC3: undefined db also does not throw");

    // AC4 — best-effort: a write failure (non-existent project) does not crash teardown
    let ac4Threw = false;
    try { releaseClaimedTickets(db19, "nonexistent-project", "junior-dev", testFireId19); }
    catch { ac4Threw = true; }
    ok(!ac4Threw, "LOOP-19 AC4: release with unknown project is a silent no-op — best-effort, never crashes teardown");

    db19.close();
  }

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── LOOP-15: codex UsageAdapter (fire-usage.ts) ─────────────────────────────────────────────────────
// AC1: a recorded `codex exec --json` fixture → populated token fields (costUsd:null acceptable)
{
  const fixture = [
    '{"type":"session_started","session_id":"test-sess-1"}',
    '{"type":"agent_message","role":"assistant","content":"Done."}',
    '{"type":"response","usage":{"input_tokens":150,"output_tokens":42}}',
    '{"type":"session_stopped","reason":"completed"}',
  ].join("\n");
  const result = codexUsageAdapter.parse(fixture);
  ok(result !== null, "LOOP-15 AC1: codex fixture → non-null FireUsage");
  ok(result?.source === "provider", "LOOP-15 AC1: source = 'provider'");
  ok(result?.inputTokens === 150, "LOOP-15 AC1: inputTokens = 150");
  ok(result?.outputTokens === 42, "LOOP-15 AC1: outputTokens = 42");
  ok(result?.costUsd === null, "LOOP-15 AC1: costUsd = null (codex tokens-only)");
  ok(result?.currency === null, "LOOP-15 AC1: currency = null when no cost");
  // also works with nested response.done shape
  const nestedFixture = '{"type":"response.done","response":{"id":"resp_x","usage":{"input_tokens":77,"output_tokens":11}}}';
  const nested = codexUsageAdapter.parse(nestedFixture);
  ok(nested !== null && nested.inputTokens === 77, "LOOP-15 AC1: nested response.usage shape also parsed");
}
// AC2: live shape mismatch / broken binary (spawn error) → usage:null, fire still runs
{
  ok(codexUsageAdapter.parse("") === null, "LOOP-15 AC2: empty stdout → usage null");
  ok(codexUsageAdapter.parse("not json\nnope") === null, "LOOP-15 AC2: non-JSON stdout → usage null");
  ok(codexUsageAdapter.parse('{"type":"session_stopped"}') === null, "LOOP-15 AC2: event with no usage → null");
  ok(codexUsageAdapter.parse('{"type":"response","usage":{"total_tokens":10}}') === null, "LOOP-15 AC2: usage without input_tokens/output_tokens → null");
  ok(codexUsageAdapter.parse('{"type":"error","message":"binary not found"}') === null, "LOOP-15 AC2: error event alone → usage null (isError handles suspectError separately)");
}
// AC3: §16 — FireUsage result contains ONLY numeric fields + source/currency, no content/PII
{
  const richFixture = '{"type":"response","usage":{"input_tokens":10,"output_tokens":5},"result":"secret agent output here","tool_calls":[{"id":"call_1","args":"rm -rf /"}]}';
  const result = codexUsageAdapter.parse(richFixture);
  ok(result !== null, "LOOP-15 AC3: parses usage from event with extra fields");
  const allowed = new Set(["source", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "currency"]);
  const keys = Object.keys(result ?? {});
  ok(keys.every(k => allowed.has(k)), `LOOP-15 AC3 §16: FireUsage has only allowed keys (${keys.join(",")}) — no content/PII`);
  ok(!JSON.stringify(result).includes("secret") && !JSON.stringify(result).includes("rm -rf"),
    "LOOP-15 AC3 §16: no content strings in parsed FireUsage");
}

// ── LOOP-83: claude UsageAdapter (fire-usage.ts) — mirrors codex, but ONE terminal JSON object (not JSONL) ──
// Measured-usage AC: a well-formed `claude -p --output-format json` terminal object → populated token + cost fields.
{
  const fixture = JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: "All acceptance criteria satisfied.",
    usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 88, cache_read_input_tokens: 512 },
    total_cost_usd: 0.0187,
  });
  const u = claudeAdapter.parse(fixture);
  ok(u !== null && u.source === "provider", "LOOP-83: claude fixture → non-null FireUsage, source='provider'");
  ok((u?.inputTokens ?? 0) > 0 && u?.inputTokens === 1200, "LOOP-83: inputTokens mapped (>0, =1200)");
  ok((u?.outputTokens ?? 0) > 0 && u?.outputTokens === 340, "LOOP-83: outputTokens mapped (>0, =340)");
  ok(u?.cacheWriteTokens === 88 && u?.cacheReadTokens === 512, "LOOP-83: cache_creation/read_input_tokens → cacheWrite/cacheRead");
  ok(u?.costUsd === 0.0187 && u?.currency === "USD", "LOOP-83: total_cost_usd → costUsd + currency 'USD'");
  // isError is a SEPARATE signal (additive to the tail-regex): success is healthy, is_error / non-success subtype is not.
  ok(claudeAdapter.isError?.(fixture) === false, "LOOP-83: a subtype:'success' object is NOT a structured error");
  ok(claudeAdapter.isError?.('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}') === true,
    "LOOP-83: is_error:true terminal object → structured error");
  ok(claudeAdapter.isError?.('{"type":"result","subtype":"error_max_turns","is_error":false,"result":""}') === true,
    "LOOP-83: subtype!=='success' → structured error even when is_error is false");
  // resultText: the operator echo pulls ONLY the result string (never the raw blob / usage numbers).
  ok(claudeAdapter.resultText?.(fixture) === "All acceptance criteria satisfied.", "LOOP-83: resultText extracts the result string for the operator echo");
}
// Malformed / truncated → usage null (honest miss), and isError falls through to the tail-regex arm.
{
  ok(claudeAdapter.parse("") === null, "LOOP-83: empty stdout → usage null");
  ok(claudeAdapter.parse("Execution error") === null, "LOOP-83: non-JSON stdout → usage null");
  ok(claudeAdapter.parse('{"type":"result","subtype":"success","result":"hi"') === null, "LOOP-83: truncated JSON (no closing brace) → usage null");
  ok(claudeAdapter.parse('{"type":"result","usage":{"output_tokens":5}}') === null, "LOOP-83: usage missing input_tokens → null (never a partial/wrong row)");
  ok(claudeAdapter.resultText?.('{"type":"result","result":"partial') === null, "LOOP-83: truncated buffer → resultText null (caller falls back to the raw buffer, never nothing)");
  ok(claudeAdapter.isError?.("Execution error") === false, "LOOP-83: non-JSON → isError false — the runAgent tail-regex owns that case, additively (LOOP-13's regression was replacing it)");
}
// §16: the recorded FireUsage carries ONLY numeric fields + source/currency — never result text, session id, or tool args.
{
  const rich = JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    result: "secret agent output sk-SEEDED", session_id: "sess-must-not-persist",
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    total_cost_usd: 0.001,
  });
  const u = claudeAdapter.parse(rich);
  const allowed = new Set(["source", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "currency"]);
  const keys = Object.keys(u ?? {});
  ok(u !== null && keys.every(k => allowed.has(k)), `LOOP-83 §16: FireUsage has only allowed keys (${keys.join(",")}) — no content/PII`);
  ok(!JSON.stringify(u).includes("secret") && !JSON.stringify(u).includes("sess-must-not-persist"),
    "LOOP-83 §16: no result text / session id in the parsed FireUsage");
}
// ── LOOP-85: opencode UsageAdapter (fire-usage.ts) — JSONL like codex, but tokens/cost nest under `part` ──
// AC1: a RECORDED `opencode run --format json` fixture → populated usage. These three lines are captured
// VERBATIM from a real opencode 1.2.24 fire (Vertex/Anthropic) — NOT hand-authored (the LOOP-14 gap): the
// usage-bearing event is `step_finish`, and tokens/cost live under `part`, not top-level as LOOP-14 assumed.
{
  const fixture = [
    '{"type":"step_start","timestamp":1785467806735,"sessionID":"ses_049d37440ffex05VV18wLW13E4","part":{"id":"prt_fb62ca40","sessionID":"ses_049d37440ffex05VV18wLW13E4","messageID":"msg_fb62c8cd","type":"step-start"}}',
    '{"type":"text","timestamp":1785467810709,"sessionID":"ses_049d37440ffex05VV18wLW13E4","part":{"id":"prt_fb62cb33","type":"text","text":"hello from opencode."}}',
    '{"type":"step_finish","timestamp":1785467810731,"sessionID":"ses_049d37440ffex05VV18wLW13E4","part":{"id":"prt_fb62cb39","type":"step-finish","reason":"stop","cost":0,"tokens":{"total":107882,"input":107862,"output":20,"reasoning":14,"cache":{"read":0,"write":0}}}}',
  ].join("\n");
  const u = opencodeAdapter.parse(fixture);
  ok(u !== null && u.source === "provider", "LOOP-85 AC1: real opencode fixture → non-null FireUsage, source='provider'");
  ok(u?.inputTokens === 107862 && u?.outputTokens === 20, "LOOP-85 AC1: token totals read from part.tokens.{input,output} (nested, not top-level)");
  ok(u?.cacheReadTokens === 0 && u?.cacheWriteTokens === 0, "LOOP-85 AC1: cache split read from part.tokens.cache.{read,write}");
  ok(u?.costUsd === 0 && u?.currency === "USD", "LOOP-85 AC1: part.cost → costUsd (0 on a free model is a real measurement) + currency 'USD'");
}
// AC (PM constraint from the LOOP-15 verify): opencode emits one step_finish PER model turn — take the LAST,
// never the first, so a multi-turn fire records the final turn's real numbers, not the opening turn as the total.
{
  const multiTurn = [
    '{"type":"step_finish","part":{"type":"step-finish","cost":0.001,"tokens":{"input":10,"output":2,"cache":{"read":0,"write":0}}}}',
    '{"type":"text","part":{"type":"text","text":"...thinking..."}}',
    '{"type":"step_finish","part":{"type":"step-finish","cost":0.05,"tokens":{"input":900,"output":80,"cache":{"read":100,"write":50}}}}',
  ].join("\n");
  const u = opencodeAdapter.parse(multiTurn);
  ok(u?.inputTokens === 900 && u?.outputTokens === 80 && u?.costUsd === 0.05, "LOOP-85: multi-step fire → LAST step_finish wins (900/80/$0.05), NOT the first (10/2) — no plausible-but-partial wrong row");
  ok(u?.cacheReadTokens === 100 && u?.cacheWriteTokens === 50, "LOOP-85: last-match carries the final turn's cache split too");
  // Version-drift robustness: a flattened (top-level tokens/cost, no `part`) shape still parses.
  const flat = '{"type":"summary","tokens":{"input":5,"output":1},"cost":0.002}';
  ok(opencodeAdapter.parse(flat)?.inputTokens === 5, "LOOP-85: a top-level tokens/cost shape (no `part`) also parses — resilient to a version that flattens the events");
}
// AC2: absent / changed shape → usage:null, no crash (honest miss, never a zero-filled or partial row).
{
  ok(opencodeAdapter.parse("") === null, "LOOP-85 AC2: empty stdout → usage null");
  ok(opencodeAdapter.parse("not json\nnope") === null, "LOOP-85 AC2: non-JSON stdout → usage null (no crash)");
  ok(opencodeAdapter.parse('{"type":"step_finish","part":{"type":"step-finish"}}') === null, "LOOP-85 AC2: step_finish with no tokens object → null");
  ok(opencodeAdapter.parse('{"type":"step_finish","part":{"tokens":{"output":5}}}') === null, "LOOP-85 AC2: tokens missing `input` → null (never a partial row)");
  ok(opencodeAdapter.parse('{"type":"step_finish","part":{"tokens":{"input":"NaN","output":5}}}') === null, "LOOP-85 AC2: non-numeric input → null");
}
// AC (§16): the recorded FireUsage carries ONLY numeric fields + source/currency — never the message text
// ("hello from opencode."), session id, or any string payload the raw events also stream.
{
  const rich = [
    '{"type":"text","part":{"type":"text","text":"secret sk-SEEDED do not persist"}}',
    '{"type":"step_finish","sessionID":"ses_must_not_persist","part":{"type":"step-finish","cost":0.01,"tokens":{"input":10,"output":5,"cache":{"read":1,"write":2}}}}',
  ].join("\n");
  const u = opencodeAdapter.parse(rich);
  const allowed = new Set(["source", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "currency"]);
  const keys = Object.keys(u ?? {});
  ok(u !== null && keys.every((k) => allowed.has(k)), `LOOP-85 §16: FireUsage has only allowed keys (${keys.join(",")}) — no content/PII`);
  ok(!JSON.stringify(u).includes("secret") && !JSON.stringify(u).includes("ses_must_not_persist"), "LOOP-85 §16: no message text / session id in the parsed FireUsage");
}
// AC (suspectError — the adapter's HALF: a structured error signal, additive to run-agents' tail-regex).
// A `type:"error"` event → true; a healthy stream → false. The bare-text arms ("Execution error", empty)
// are DELIBERATELY false here — run-agents' tail-regex/empty check owns them (§ "keep the tail-regex as the
// fallback"); duplicating them in isError would be the LOOP-13 replace-not-add regression in reverse.
{
  ok(opencodeAdapter.isError?.('{"type":"error","part":{"message":"provider 429"}}') === true, "LOOP-85: a structured type:'error' event → isError true (flags suspectError on an exit-0 fire)");
  ok(opencodeAdapter.isError?.('{"type":"step_finish","part":{"tokens":{"input":1,"output":1}}}') === false, "LOOP-85: a healthy step_finish stream → isError false");
  ok(opencodeAdapter.isError?.("Execution error") === false, "LOOP-85: bare 'Execution error' → isError false BY DESIGN — run-agents' tail-regex owns it (fallback kept, not replaced)");
  ok(opencodeAdapter.isError?.("") === false, "LOOP-85: empty output → isError false — run-agents' empty-output arm owns it");
}
// AC (operator-visible output survives): opencode STREAMS its JSONL, so the adapter must NOT define resultText
// — that is the exact bit run-agents keys `deferEcho` on. resultText === undefined ⇒ deferEcho false ⇒ every
// chunk is echoed live to console + run.log (LOOP-14 defined it via the structured branch and suppressed the
// whole stream). The end-to-end proof (a real fire's run.log carries the lines) lives in run-agents-live.ts.
{
  ok(opencodeAdapter.resultText === undefined, "LOOP-85: opencodeAdapter has NO resultText → deferEcho stays false → the JSONL stream echoes live (output is never suppressed)");
  // and it still parses a multi-line + a truncated buffer without throwing (the buffer run-agents accumulates).
  const multi = '{"type":"step_start","part":{"type":"step-start"}}\n{"type":"step_finish","part":{"tokens":{"input":3,"output":1}}}';
  ok(opencodeAdapter.parse(multi)?.inputTokens === 3, "LOOP-85: multi-line JSONL buffer parses (usage from the step_finish line)");
  const truncated = '{"type":"step_finish","part":{"tokens":{"input":3,"output":1}}}\n{"type":"step_fin';
  ok(opencodeAdapter.parse(truncated)?.inputTokens === 3, "LOOP-85: a TRUNCATED trailing line is skipped, the earlier usage still recovered (never a throw, never nothing)");
}

// resolveAdapter: claude + codex + opencode resolve to their adapters (all three lanes now structured).
{
  ok(resolveAdapter("claude") === claudeAdapter, "LOOP-83: resolveAdapter('claude') → claudeAdapter");
  ok(resolveAdapter("codex") === codexUsageAdapter, "LOOP-83: resolveAdapter('codex') → codexUsageAdapter (untouched)");
  ok(resolveAdapter("opencode") === opencodeAdapter, "LOOP-85: resolveAdapter('opencode') → opencodeAdapter (was null — now the structured lane, still keeps the tail-regex fallback)");
  ok(resolveAdapter("mystery") === null, "resolveAdapter(unknown lane) → null (text-mode, usage:null)");
}

console.log(fails === 0 ? "\nRUN_AGENTS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
