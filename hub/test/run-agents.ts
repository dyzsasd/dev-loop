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
import { breaker } from "../src/breaker.ts";

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

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
