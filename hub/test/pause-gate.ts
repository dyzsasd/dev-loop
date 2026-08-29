// pause-gate.ts — `dev-loop pause` stops launches, not just the status line.
//
// Measured 2026-08-29 on a live workspace: `dev-loop pause --reason "install dev-loop build …"` at
// 14:02Z, and `dev-loop status` read `DRAINING pid 5347 … paused 41m ago by operator` for the whole
// window — while run.log recorded fourteen launches after it (ops, pm-maintenance, junior-dev, ops,
// pm-groom, pm-maintenance, ops, senior-dev, junior-dev, qa-hunt, ops, sweep, pm-review,
// pm-maintenance). The drain therefore never finished: it polls for an empty in-flight set that the
// scheduler kept refilling. After 45 minutes the operator gave up and SIGINT'd four live fires, and
// the upgrade — a build carrying twelve fixes — went in over a loop that had never actually stopped.
//
// Root cause, verified rather than guessed: `readPause` had exactly ONE consumer, status.ts. The word
// "pause" did not appear in run-agents.ts at all. So the display and the behaviour were reading
// different things — the display read the board row `dev-loop pause` writes, and the tick read
// nothing. An earlier `pause --drain` that DID report "drained" (07:42Z, a different pid) had simply
// observed a gap between launches; with no gate in the scheduler, launching never stopped either time.
//
// This drives a REAL scheduler with a fake coding agent, because the defect is only visible in the
// interaction between the pause writer and the tick loop.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-pausegate-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ws = join(tmp, "ws");
const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
const cli = (args: string[], cwd = ws) => {
  const r = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let out = "";
/** Launches are counted off the fire LEDGER — the record, not a log line about it. */
const ledgerPath = () => join(ws, ".dev-loop", "team", "fires.jsonl");
const fireCount = (): number => {
  try { return readFileSync(ledgerPath(), "utf8").split("\n").filter(Boolean).length; }
  catch { return 0; }
};
async function waitFor(pred: () => boolean, label: string, ms = 45_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(200); }
  console.log(`   (timed out waiting for ${label}; tail: ${out.slice(-400).replace(/\n/g, " | ")})`);
  return false;
}

let child: ReturnType<typeof spawn> | null = null;
try {
  mkdirSync(join(ws, "repo"), { recursive: true });
  ok(cli(["team", "init", "--dir", ws, "--key", "pg", "--backend", "service", "--yes"], tmp).code === 0, "fixture: team init");
  ok(cli(["team", "add-project", "pgp", "--prefix", "PG"]).code === 0, "fixture: add-project");
  spawnSync("git", ["init", "-q", "-b", "main", join(ws, "repo")]);
  spawnSync("git", ["-C", join(ws, "repo"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"]);
  ok(cli(["team", "add-repo", "r", "--project", "pgp", "--path", "repo", "--role", "primary"]).code === 0, "fixture: add-repo");

  // A "coding agent" that prints and exits 0: a fire costs nothing, and printing keeps the breaker
  // shut (five silent exits would open it and back the lane off, hiding the thing under test).
  const fakeBin = join(tmp, "fake-claude.sh");
  writeFileSync(fakeBin, "#!/bin/sh\necho 'fake fire: nothing to do'\nexit 0\n");
  chmodSync(fakeBin, 0o755);

  child = spawn(process.execPath,
    [join(hubRoot, "src", "run-agents.ts"), "--no-daemon", "--agents", "sweep", "--interval", "sweep=1s", "--stagger", "0"],
    { cwd: ws, env: { ...env, DEVLOOP_CLAUDE_BIN: fakeBin }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (d: Buffer) => { out += String(d); });
  child.stderr!.on("data", (d: Buffer) => { out += String(d); });

  ok(await waitFor(() => fireCount() >= 2, "the scheduler's first fires"),
    "the scheduler is launching before the pause — the control for everything below");

  // ── The pause ───────────────────────────────────────────────────────────────────────────────────
  {
    const atPause = fireCount();
    const p = cli(["pause", "--reason", "install a build"]);
    ok(p.code === 0, `dev-loop pause exits 0 (${p.code}) ${p.out.slice(-160)}`);

    const marked = out.length;
    // Long enough for many ticks at a 1s cadence — the live defect launched 14 times in 41 minutes,
    // which is far sparser than this window.
    await sleep(6_000);
    const after = fireCount();
    ok(after === atPause,
      `ZERO launches after the pause (${atPause} before, ${after} after — ${after - atPause} new)`);
    ok(/launch refused: paused by operator: install a build/.test(out.slice(marked)),
      `…and each due slot says why, in the budget gate's shape (${out.slice(marked).split("\n").find((l) => /launch refused/.test(l))?.slice(0, 120) ?? "no refusal line"})`);

    // The display and the behaviour must now be reading the same thing.
    const st = cli(["status"]);
    ok(/paused/i.test(st.out), `status still reports the pause (${st.out.split("\n").find((l) => /paused/i.test(l))?.slice(0, 100) ?? "no line"})`);
  }

  // ── The drain can only finish because launching stopped ─────────────────────────────────────────
  {
    const d = cli(["pause", "--drain", "--timeout", "30"]);
    ok(d.code === 0 && /drained/.test(d.out),
      `pause --drain completes on an already-paused loop (${d.code}) ${d.out.trim().split("\n").pop()?.slice(0, 120)}`);
  }

  // ── Resume re-arms it ───────────────────────────────────────────────────────────────────────────
  {
    const atResume = fireCount();
    ok(cli(["resume"]).code === 0, "dev-loop resume exits 0");
    ok(await waitFor(() => fireCount() > atResume, "a fire after resume"),
      `launching resumes without a restart (${atResume} at resume, ${fireCount()} now)`);
  }
} finally {
  if (child?.pid) { try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ } }
  await sleep(200);
  rmSync(tmp, { recursive: true, force: true });
}

ok(!existsSync(tmp), "fixture: the temp workspace is removed");
console.log(fails === 0 ? "\nPAUSE_GATE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
