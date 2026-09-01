// hot-reload-config.ts — a config edit reaches the NEXT fire, not the next restart.
//
// The scheduler watches dev-loop.json's mtime and reloads it so "enabled/weight edits take effect
// without a restart". The reload refreshed the workspace handle, the rotation and the provider
// registry, and left behind everything a FIRE reads: `cfg`, the legacy projection resolveLaunchProfile
// resolves model/effort/codingAgent from, was captured `const` at boot, and `perFireCeilingUsd` was
// read once from the same boot workspace. The source said so ("the cfg/launch-profile projection
// staying stale across reloads is a pre-existing class").
//
// So an operator editing team.agents.<lane>.model watched the reload line print and the next fire
// launch the old model anyway, and a raised team.budget.perFireUsd did not move the in-flight budget
// watchdog — while team.budget.dailyUsd, read through the reloaded `ws` at tick time, DID take effect.
// One config file, two halves that disagreed about when an edit counts.
//
// Both halves are asserted against a REAL running scheduler, mid-run: the launch profile off the FIRE
// LEDGER (every row records the model and effort the fire actually launched with), and the ceiling off
// the reload line, which now reports what the reload picked up — without it, an operator cannot tell a
// reload that refreshed the profiles from one that did not. A dry run cannot be used here: it previews
// and exits before the scheduler loop that owns the reload (LOOP-459 AC3).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const tmp = realpathSync(tmpRoot("dl-hotreload-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ws = join(tmp, "ws");
const cfgPath = join(ws, "dev-loop.json");
const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
const cli = (args: string[], cwd = ws) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const editCfg = (mutate: (c: Record<string, Record<string, unknown>>) => void) => {
  const c = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, Record<string, unknown>>;
  mutate(c);
  writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let out = "";
/** Wait until `out` satisfies `pred`, or give up. Returns whether it arrived. */
async function waitFor(pred: (s: string) => boolean, label: string, ms = 45_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred(out)) return true;
    await sleep(200);
  }
  console.log(`   (timed out waiting for ${label}; last 600 chars: ${out.slice(-600).replace(/\n/g, " | ")})`);
  return false;
}
// The profile a fire ACTUALLY launched with, read off the fire ledger — the record the operator and
// every metric read, not a log line written next to the decision.
const ledgerPath = () => join(ws, ".dev-loop", "team", "fires.jsonl");
const profilesOf = (_s: string, agent: string): string[] => {
  let raw = "";
  try { raw = readFileSync(ledgerPath(), "utf8"); } catch { return []; }
  return raw.split("\n").filter(Boolean).flatMap((l) => {
    try {
      const r = JSON.parse(l) as { agent?: string; codingAgent?: string; model?: string; effort?: string };
      return r.agent === agent ? [`${r.codingAgent}:${r.model}/${r.effort}`] : [];
    } catch { return []; }
  });
};

let child: ReturnType<typeof spawn> | null = null;
try {
  mkdirSync(join(ws, "repo"), { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "hotr", "--backend", "service", "--yes"], tmp).code === 0, "fixture: team init");
  ok(cli(["team", "add-project", "hp", "--prefix", "HP"]).code === 0, "fixture: add-project");
  spawnSync("git", ["init", "-q", "-b", "main", join(ws, "repo")]);
  spawnSync("git", ["-C", join(ws, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
  ok(cli(["team", "add-repo", "r", "--project", "hp", "--path", "repo", "--role", "primary"]).code === 0, "fixture: add-repo");
  editCfg((c) => { (c.team.budget ??= {} as Record<string, unknown>); (c.team.budget as Record<string, unknown>).perFireUsd = 0.25; });

  // A real scheduler, re-firing every second so an edit lands within a tick or two. The "coding agent"
  // is a script that exits 0 immediately, so a fire costs nothing and still writes a ledger row.
  // It PRINTS: a fire that exits 0 with no output is flagged suspectError, and five of those open the
  // breaker and back the lane off to probe cadence — the loop this test needs would stop.
  const fakeBin = join(tmp, "fake-claude.sh");
  writeFileSync(fakeBin, "#!/bin/sh\necho 'fake fire: nothing to do'\nexit 0\n");
  chmodSync(fakeBin, 0o755);
  child = spawn(process.execPath,
    [join(hubRoot, "src", "run-agents.ts"), "--no-daemon", "--agents", "sweep", "--interval", "sweep=1s", "--stagger", "0"],
    { cwd: ws, env: { ...env, DEVLOOP_CLAUDE_BIN: fakeBin }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d: Buffer) => { out += String(d); });
  child.stderr!.on("data", (d: Buffer) => { out += String(d); });

  ok(await waitFor(() => profilesOf("", "sweep").length > 0, "the first fire's ledger row"),
    "the scheduler ledgers a fire before any edit");
  ok(profilesOf("", "sweep")[0] === "claude:sonnet/high",
    `baseline: sweep fires on its built-in profile (${profilesOf("", "sweep")[0]})`);

  // ── The edit, mid-run: a lane's model and the per-fire ceiling, in one write ─────────────────────
  const beforeEdit = out.length;
  const firesBeforeEdit = profilesOf("", "sweep").length;
  editCfg((c) => {
    (c.team.agents ??= {} as Record<string, unknown>);
    (c.team.agents as Record<string, unknown>).sweep = { model: "opus", effort: "max" };
    (c.team.budget as Record<string, unknown>).perFireUsd = 0.75;
  });

  ok(await waitFor((s) => /reloaded dev-loop\.json/.test(s.slice(beforeEdit)), "the reload line"),
    "the scheduler notices the edit and reloads");
  const reloadLine = out.slice(beforeEdit).split("\n").find((l) => l.includes("reloaded dev-loop.json")) ?? "";
  ok(/per-fire ceiling \$0\.75/.test(reloadLine),
    `the reload reports the REFRESHED per-fire ceiling, so the operator can see it took (${reloadLine})`);

  ok(await waitFor(() => profilesOf("", "sweep").slice(firesBeforeEdit).includes("claude:opus/max"), "a fire on the new profile"),
    "a fire AFTER the reload launches on the edited lane profile — no restart");
  const post = profilesOf("", "sweep").slice(firesBeforeEdit);
  ok(post.length > 0 && post[post.length - 1] === "claude:opus/max",
    `…and stays on it (last rendered profile: ${post[post.length - 1]})`);
} finally {
  if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}

ok(!existsSync(tmp), "fixture: the temp workspace is removed");
console.log(fails === 0 ? "\nHOT_RELOAD_CONFIG_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
