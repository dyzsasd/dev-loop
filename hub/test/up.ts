// One-click §2 — `dev-loop up` (LOCAL + ATTACH legs; the bundle leg has its own suite). Covers: the
// scaffold-if-needed path (workspace + operator briefs), the --dry-launch contract (command/args/env
// with the operator identity and WITHOUT the fire markers), CLI resolution precedence, create-only
// brief scaffolding (an operator's own file is never clobbered), the claude trust pre-seed merge, and
// the attach leg's DEVLOOP_HUB_URL injection + URL validation.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { deriveTeamKey, preseedClaudeTrust, interactiveCommandFor } from "../src/up.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── units ───────────────────────────────────────────────────────────────────
ok(deriveTeamKey("/tmp/My Cool_Project!") === "my-cool-project", "deriveTeamKey: sanitizes to the team-key grammar");
ok(deriveTeamKey("/tmp/@@") === "team", "deriveTeamKey: degenerate name falls back to 'team'");
{
  const c = interactiveCommandFor("claude", { model: "opus", effort: "max" }, "BRIEF");
  ok(/claude$/.test(c.command) && JSON.stringify(c.args) === JSON.stringify(["--model", "opus", "--effort", "max", "--append-system-prompt", "BRIEF"]),
    "interactiveCommandFor(claude): verified interactive flags only, brief appended");
  const o = interactiveCommandFor("opencode", { model: "openrouter/foo", effort: "high" }, "BRIEF");
  ok(/opencode$/.test(o.command) && JSON.stringify(o.args) === JSON.stringify(["--model", "openrouter/foo"]),
    "interactiveCommandFor(opencode): --model only — TUI has no effort flag (rides config), no unverified flags");
}
{
  const tmp = mkdtempSync(join(tmpdir(), "dl-up-trust-"));
  const cj = join(tmp, "claude.json");
  ok(preseedClaudeTrust("/ws/x", cj) === "absent", "preseedClaudeTrust: no ~/.claude.json → 'absent' (never invents claude's config)");
  writeFileSync(cj, JSON.stringify({ userID: "u", projects: { "/other": { hasTrustDialogAccepted: true, allowedTools: ["x"] } } }));
  ok(preseedClaudeTrust("/ws/x", cj) === "seeded", "preseedClaudeTrust: merges the workspace trust in");
  const after = JSON.parse(readFileSync(cj, "utf8"));
  ok(after.projects["/ws/x"].hasTrustDialogAccepted === true && after.projects["/other"].allowedTools[0] === "x" && after.userID === "u",
    "preseedClaudeTrust: existing projects + top-level keys survive the merge");
  ok(preseedClaudeTrust("/ws/x", cj) === "already", "preseedClaudeTrust: idempotent second call");
  writeFileSync(cj, "{ not json");
  ok(preseedClaudeTrust("/ws/x", cj) === "unparseable", "preseedClaudeTrust: garbled file untouched → 'unparseable'");
  rmSync(tmp, { recursive: true, force: true });
}

// ── e2e: the dry-launch contract ────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), "dl-up-"));
try {
  const ws = join(ROOT, "acme-shop");
  mkdirSync(ws, { recursive: true });
  const up = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", ...args], {
      cwd: ws, encoding: "utf8",
      env: { ...process.env, HOME: join(ROOT, "home"), DEVLOOP_RUNNER_CLI: undefined, ...env } as NodeJS.ProcessEnv,
    });
  mkdirSync(join(ROOT, "home"), { recursive: true });

  // The dry-launch JSON is the LAST block on stdout (scaffold log lines precede it and contain `{`).
  const launchJson = (out: string) => JSON.parse(out.slice(out.search(/\n\{\n|^\{\n/)));
  const r1 = up(["--dry-launch", "--no-daemon"]);
  ok(r1.status === 0, `fresh dir: up --dry-launch exits 0 (got ${r1.status}: ${(r1.stderr ?? "").split("\n")[0]})`);
  ok(existsSync(join(ws, "dev-loop.json")), "fresh dir: workspace scaffolded (team init composed, not reimplemented)");
  ok(JSON.parse(readFileSync(join(ws, "dev-loop.json"), "utf8")).team.key === "acme-shop", "fresh dir: team key derived from the directory name");
  ok(existsSync(join(ws, "CLAUDE.md")) && existsSync(join(ws, "AGENTS.md")), "fresh dir: CLAUDE.md + AGENTS.md operator briefs scaffolded");
  ok(readFileSync(join(ws, "CLAUDE.md"), "utf8").includes("dev-loop secret set"), "brief: carries the no-secrets-in-chat rule");
  const launch = launchJson(r1.stdout);
  ok(/claude$/.test(launch.command), "dry-launch: default CLI is claude (rank-4 fallback)");
  ok(launch.envAdded.DEVLOOP_ACTOR === "operator" && launch.envAdded.DEVLOOP_WORKSPACE === realpathSync(ws) && !!launch.envAdded.DEVLOOP_HUB_DB,
    "dry-launch: operator env block (ACTOR/WORKSPACE/HUB_DB; workspace realpath'd)");
  ok(JSON.stringify(launch.envRemoved) === JSON.stringify(["DEVLOOP_TEAM_SCOPE", "DEVLOOP_DEV_SPLIT"]),
    "dry-launch: the fire markers are STRIPPED (the exit-4 operator-write trap)");
  ok(launch.args.includes("--append-system-prompt"), "dry-launch: claude gets the console brief via the verified flag");

  // CLI precedence: team.defaultCodingAgent beats the built-in fallback; --cli beats both.
  const cfg = JSON.parse(readFileSync(join(ws, "dev-loop.json"), "utf8"));
  cfg.team.defaultCodingAgent = "opencode";
  cfg.team.codingAgentDefaults = { opencode: { model: "openrouter/moonshotai/kimi-k2.5" } };
  writeFileSync(join(ws, "dev-loop.json"), JSON.stringify(cfg, null, 2) + "\n");
  const r2 = launchJson(up(["--dry-launch", "--no-daemon"]).stdout);
  ok(/opencode$/.test(r2.command) && r2.args.includes("openrouter/moonshotai/kimi-k2.5"),
    "precedence: team.defaultCodingAgent=opencode + codingAgentDefaults model flow into the launch");
  const r3 = launchJson(up(["--dry-launch", "--no-daemon", "--cli", "claude", "--model", "opus"]).stdout);
  ok(/claude$/.test(r3.command) && r3.args.includes("opus"), "precedence: --cli/--model flags beat the team default");

  // create-only briefs: the operator's own file survives a re-run byte-for-byte.
  writeFileSync(join(ws, "CLAUDE.md"), "# my own instructions\n");
  up(["--dry-launch", "--no-daemon"]);
  ok(readFileSync(join(ws, "CLAUDE.md"), "utf8") === "# my own instructions\n", "briefs: an operator-edited CLAUDE.md is NEVER overwritten");

  // attach leg: URL validation + env injection, no local workspace required.
  const bare = join(ROOT, "bare"); mkdirSync(bare, { recursive: true });
  const bad = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", "--attach", "not a url", "--dry-launch"], { cwd: bare, encoding: "utf8", env: { ...process.env, HOME: join(ROOT, "home") } });
  ok(bad.status === 2 && /not a valid URL/.test(bad.stderr), "attach: a garbled URL is a usage error");
  const att = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "up", "--attach", "https://hub.example:8787", "--dry-launch"], { cwd: bare, encoding: "utf8", env: { ...process.env, HOME: join(ROOT, "home") } });
  const attLaunch = JSON.parse(att.stdout.slice(att.stdout.search(/\{/)));
  ok(att.status === 0 && attLaunch.envAdded.DEVLOOP_HUB_URL === "https://hub.example:8787" && !existsSync(join(bare, "dev-loop.json")),
    "attach: DEVLOOP_HUB_URL rides the console env; NO local workspace is scaffolded (the home is remote)");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "up: all checks passed");
process.exit(fails ? 1 : 0);
