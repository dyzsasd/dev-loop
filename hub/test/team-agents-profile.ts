// team-agents-profile.ts — `team.agents.<lane>.{codingAgent,model,effort}` reaches the launch profile.
//
// The path has been settable since LOOP-327 (`dev-loop team set team.agents.pm-review.model sonnet`
// writes it, the SETTABLE whitelist lists it, and the built-in profile table's own comments say
// "team.agents.<lane>.model overrides"), and nothing read it. toLegacyView projected
// `agents: p.agents` — the PROJECT's block only — so resolveLaunchProfile saw no team-level entry and
// fell through to the built-in default. An operator who set the documented key got no error, no
// warning, and no change: pm-review still fired `--model opus --effort max` after a restart,
// measured 07:43Z. The working path, `projects.<key>.agents.<lane>.model`, is not settable at all.
//
// Fixed as a MERGE rather than by retiring the key: team.agents is the team-level default and
// projects.<key>.agents overrides it per field, which is the same shape intake/hub already resolve
// with and the reading both the whitelist and the profile table's comments assume.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspace, toLegacyView } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-tap-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const HOME = join(tmp, "home");
const ws = join(tmp, "ws");
const cfgPath = join(ws, "dev-loop.json");
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra } as NodeJS.ProcessEnv);
const cli = (args: string[], cwd = ws) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env: env() });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// --no-daemon: a real scheduler tick would fork a detached board daemon this suite never reaps.
const sched = (args: string[]) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "run-agents.ts"), "--no-daemon", "--once", "--dry-run", ...args],
    { cwd: ws, encoding: "utf8", env: env() });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, Record<string, unknown>>;
const writeCfg = (mutate: (c: Record<string, Record<string, unknown>>) => void) => {
  const c = readCfg(); mutate(c); writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
};
/** The scheduler's own resolved-profile line: `[dry-run] <agent>: cwd=… cli=X [sandbox=…] model=Y effort=Z …`.
 *  A codex lane carries `sandbox=` between cli and model, so the fields are matched, not the spacing. */
const launchOf = (out: string, agent: string): string => {
  const line = out.split("\n").find((l) => l.startsWith(`[dry-run] ${agent}: cwd=`));
  if (!line) return "(no launch line)";
  const f = (k: string) => new RegExp(`\\b${k}=(\\S+)`).exec(line)?.[1] ?? "?";
  return `${f("cli")}:${f("model")}/${f("effort")}`;
};

try {
  mkdirSync(ws, { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "tap", "--backend", "service", "--yes"], tmp).code === 0, "fixture: team init");
  ok(cli(["team", "add-project", "tapproj", "--prefix", "TAP"]).code === 0, "fixture: add-project");
  // A repo, or every fire is skipped for "no usable repo cwd" and prints no launch line at all.
  const repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
  ok(cli(["team", "add-repo", "r", "--project", "tapproj", "--path", "repo", "--role", "primary"]).code === 0, "fixture: add-repo");

  // ── The built-in default, so the arms below are measured against a known start ──────────────────
  ok(launchOf(sched(["--agents", "pm-review"]).out, "pm-review") === "claude:opus/max",
    `baseline: pm-review's built-in profile is claude:opus/max (${launchOf(sched(["--agents", "pm-review"]).out, "pm-review")})`);

  // ── The team-level key is settable AND read ─────────────────────────────────────────────────────
  {
    const set = cli(["team", "set", "team.agents.pm-review.model", "sonnet"]);
    ok(set.code === 0, `team set team.agents.<lane>.model is accepted (${set.code}) ${set.out.slice(-160)}`);
    ok(cli(["team", "set", "team.agents.pm-review.effort", "high"]).code === 0, "…and team.agents.<lane>.effort too");
    const r = sched(["--agents", "pm-review"]);
    ok(launchOf(r.out, "pm-review") === "claude:sonnet/high",
      `team.agents.<lane>.{model,effort} reaches the launch profile (${launchOf(r.out, "pm-review")})`);
  }

  // ── The projection is where it arrives, so assert it there too ──────────────────────────────────
  {
    const view = toLegacyView(loadWorkspace(ws)).projects.tapproj as { agents?: Record<string, { model?: string; effort?: string }> };
    ok(view.agents?.["pm-review"]?.model === "sonnet",
      `toLegacyView projects the team-level agents block (${JSON.stringify(view.agents?.["pm-review"])})`);
  }

  // ── A project-level entry overrides it PER FIELD ────────────────────────────────────────────────
  // Whole-block nearest-wins would drop the team-level effort here, which is the failure mode the
  // intake/hub blocks were already fixed for.
  {
    writeCfg((c) => { (c.projects.tapproj as Record<string, unknown>).agents = { "pm-review": { model: "opus" } }; });
    const r = sched(["--agents", "pm-review"]);
    ok(launchOf(r.out, "pm-review") === "claude:opus/high",
      `projects.<key>.agents wins on model, team.agents still supplies effort (${launchOf(r.out, "pm-review")})`);
    writeCfg((c) => { delete (c.projects.tapproj as Record<string, unknown>).agents; });
  }

  // ── codingAgent routes too — the case the stale comment recorded as broken ──────────────────────
  {
    ok(cli(["team", "set", "team.agents.sweep.codingAgent", "codex"]).code === 0, "team set team.agents.<lane>.codingAgent is accepted");
    const r = sched(["--agents", "sweep"]);
    ok(launchOf(r.out, "sweep").startsWith("codex:"), `team.agents.<lane>.codingAgent routes the lane (${launchOf(r.out, "sweep")})`);
  }

  // ── No regression: cadence still resolves from team.agents ──────────────────────────────────────
  // Written to the file rather than through `team set`: cadence is not on the settable whitelist,
  // which is beside the point here — the reader is what must keep working.
  {
    writeCfg((c) => { (c.team.agents as Record<string, Record<string, unknown>>).sweep.cadence = "45m"; });
    const r = sched(["--agents", "sweep,pm-review"]);
    ok(/sweep@45m/.test(r.out), `team.agents.<lane>.cadence is still honoured (${/agents=[^\n]*/.exec(r.out)?.[0] ?? "no agents line"})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nTEAM_AGENTS_PROFILE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
