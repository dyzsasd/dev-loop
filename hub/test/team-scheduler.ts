// run-agents team mode + locks: WRR plan, --project filter, enabled/weight exclusion, fires.jsonl ledger,
// the team run lock, and with-repo-lock serialization.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/locks.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-sched-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, DEVLOOP_HOME: HOME, ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const runAgents = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd, env: env(extra), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
// Only the numbered plan rows ("  1  pm → alpha"), never the header line (which also contains →).
const planLines = (out: string) => out.split("\n").filter((l) => /^\s*\d+\s+\S+\s*→/.test(l)).map((l) => l.split("→")[1].trim());

(async () => {
const svcWs = join(tmp, "svc"); // service workspace for the pick-time seed guard (daemon stopped in finally)
try {
  // ── fixture: workspace with alpha(w2) + beta(w1), both with a repo ──
  const ws = join(tmp, "ws");
  team(["init", "--dir", ws, "--key", "sched-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
  mkdirSync(join(ws, "ra"), { recursive: true }); mkdirSync(join(ws, "rb"), { recursive: true });
  team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "2"], ws);
  team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);
  team(["add-project", "beta", "--linear-project", "Beta", "--weight", "1"], ws);
  team(["add-repo", "rb", "--project", "beta", "--path", "rb", "--role", "primary"], ws);

  // ── --plan prints the exact 2:1 WRR sequence ──
  const plan = runAgents(["--agents", "pm", "--plan", "6"], ws);
  ok(plan.code === 0 && planLines(plan.out).join(" ") === "alpha beta alpha alpha beta alpha", "--plan 6 prints the exact 2:1 WRR sequence");
  ok(!existsSync(join(ws, ".dev-loop", "team", "scheduler.json")), "--plan does NOT persist the cursor (preview only)");

  // ── --project filter restricts rotation to one project ──
  const filtered = runAgents(["--agents", "pm", "--project", "alpha", "--plan", "3"], ws);
  ok(planLines(filtered.out).join(" ") === "alpha alpha alpha", "--project filters rotation to a single project");

  // ── enabled:false / weight:0 exclusion ──
  const cfgPath = join(ws, "dev-loop.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.projects.beta.enabled = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(planLines(runAgents(["--agents", "pm", "--plan", "3"], ws).out).join(" ") === "alpha alpha alpha", "enabled:false excludes a project from rotation");
  cfg.projects.beta.enabled = true; cfg.projects.beta.weight = 0;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(planLines(runAgents(["--agents", "pm", "--plan", "2"], ws).out).join(" ") === "alpha alpha", "weight:0 excludes a project from rotation");
  // all disabled → hard error
  cfg.projects.alpha.enabled = false; cfg.projects.beta.enabled = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  ok(runAgents(["--agents", "pm", "--plan", "2"], ws).code !== 0, "all-disabled team → run refuses (exit ≠ 0)");
  // restore
  cfg.projects.alpha.enabled = true; cfg.projects.beta.enabled = true; cfg.projects.beta.weight = 1;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // ── fires.jsonl ledger: a real --once fire (fake CLI bin) appends a row on BOTH backends ──
  const fakeBin = join(tmp, "fake-claude.sh");
  // Prints a line: a truly silent exit-0 is (correctly) flagged suspectError — a healthy CLI always emits output.
  writeFileSync(fakeBin, "#!/bin/sh\necho 'fire ok'\nexit 0\n"); chmodSync(fakeBin, 0o755);
  const once = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
  ok(once.code === 0 && existsSync(ledger), "--once with a fake CLI fires and writes the fires.jsonl ledger");
  const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(rows.length >= 1 && rows[0].agent === "pm" && ["alpha", "beta"].includes(rows[0].project) && rows[0].exitCode === 0, "ledger row carries agent/project/exitCode (backend-agnostic soak metric)");

  // ── suspectError: a CLI that prints "Execution error" and exits 0 must be flagged in the ledger ──
  {
    const crashBin = join(tmp, "crash-claude.sh");
    writeFileSync(crashBin, "#!/bin/sh\necho 'Execution error'\nexit 0\n"); chmodSync(crashBin, 0o755);
    const r = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: crashBin });
    ok(/suspectError/.test(r.out), "the scheduler warns on an exit-0 fire whose output is a failure marker");
    const rows2 = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = rows2[rows2.length - 1];
    ok(last.exitCode === 0 && last.suspectError === true && /Execution error/.test(last.outputTail ?? ""),
      "the ledger row carries suspectError + the output tail (fake success no longer masked)");
    const healthy = rows2.find((row: { suspectError?: boolean }) => row.suspectError === undefined);
    ok(!!healthy, "healthy fires carry NO suspectError flag (narrow detection, no false positives)");
  }

  // ── regression: a shell-exported CLAUDE_CODE_EFFORT_LEVEL must NOT leak into agent fires (it would
  //    override the per-agent --effort; precedence is env > --effort > model default). The scheduler strips it.
  const effProbe = join(tmp, "eff-probe.sh");
  const effOut = join(tmp, "eff-seen.txt");
  writeFileSync(effProbe, `#!/bin/sh\necho "\${CLAUDE_CODE_EFFORT_LEVEL:-UNSET}" > ${effOut}\nexit 0\n`); chmodSync(effProbe, 0o755);
  runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: effProbe, CLAUDE_CODE_EFFORT_LEVEL: "low" });
  ok(readFileSync(effOut, "utf8").trim() === "UNSET", "an exported CLAUDE_CODE_EFFORT_LEVEL is stripped from agent fires (per-agent --effort stays authoritative)");

  // ── steward vs delivery fire scope (M4): sweep fires at the workspace ROOT; pm fires in a repo ──
  const stewardDry = runAgents(["--agents", "sweep", "--once", "--dry-run"], ws);
  ok(stewardDry.out.includes(`sweep: cwd=${ws} `), "a steward (sweep) fires with cwd = the workspace ROOT (team scope)");
  const deliveryDry = runAgents(["--agents", "pm", "--once", "--dry-run"], ws);
  ok(/pm: cwd=\S+\/(ra|rb) /.test(deliveryDry.out), "a delivery agent (pm) fires with cwd = a project repo (rotation)");

  // ── intake.mode:"passive" is surfaced on pm dry-run lines (§5a) ──
  {
    const c = JSON.parse(readFileSync(cfgPath, "utf8"));
    c.projects.alpha.intake = { mode: "passive" };
    writeFileSync(cfgPath, JSON.stringify(c, null, 2));
    const passiveDry = runAgents(["--agents", "pm", "--project", "alpha", "--once", "--dry-run"], ws);
    ok(/pm: cwd=\S+ .* intake=passive/.test(passiveDry.out), "a pm dry-run fire on a passive project carries the intake=passive marker");
    delete c.projects.alpha.intake;
    writeFileSync(cfgPath, JSON.stringify(c, null, 2));
  }

  // ── T3.2 weight:0 = maintenance mode: excluded from delivery rotation, KEPT in steward coverage ──
  {
    const c = JSON.parse(readFileSync(cfgPath, "utf8"));
    c.projects.beta.weight = 0;
    writeFileSync(cfgPath, JSON.stringify(c, null, 2));
    ok(planLines(runAgents(["--agents", "pm", "--plan", "4"], ws).out).join(" ") === "alpha alpha alpha alpha",
      "a weight:0 project is never picked for delivery");
    // The steward project list rides the prompt ("enabled projects: …"), which dry-run masks — dump the
    // real argv (the prompt is the last arg) through a stub CLI instead.
    const promptFile = join(tmp, "steward-prompt.txt");
    const promptDump = join(tmp, "prompt-claude.sh");
    writeFileSync(promptDump, `#!/bin/sh\nprintf '%s\\n' "$@" > ${promptFile}\nexit 0\n`); chmodSync(promptDump, 0o755);
    runAgents(["--agents", "sweep", "--once"], ws, { DEVLOOP_CLAUDE_BIN: promptDump });
    ok(/enabled projects: alpha, beta/.test(readFileSync(promptFile, "utf8")),
      "a weight:0 project STAYS in steward enumeration (delivery paused, stewards continue — T3.2)");
    // --project narrows delivery rotation but must NOT narrow team-scope steward coverage.
    rmSync(promptFile, { force: true });
    runAgents(["--agents", "sweep", "--once", "--project", "alpha"], ws, { DEVLOOP_CLAUDE_BIN: promptDump });
    ok(/enabled projects: alpha, beta/.test(readFileSync(promptFile, "utf8")),
      "--project does not narrow steward coverage (a steward fire is team-scope)");
    // --project targeting the weight:0 project itself: delivery-only refuses, but a steward run continues
    // (the filter is delivery-only — weight:0 is a pause, not an error).
    const w0 = runAgents(["--agents", "sweep", "--once", "--project", "beta"], ws, { DEVLOOP_CLAUDE_BIN: promptDump });
    ok(w0.code === 0 && /delivery rotation paused/.test(w0.out),
      "--project <weight:0> + a steward → run continues with delivery paused");
    ok(runAgents(["--agents", "pm", "--plan", "2", "--project", "beta"], ws).code !== 0,
      "--project <weight:0> + delivery-only agents → run refuses");
    ok(runAgents(["--agents", "sweep", "--once", "--project", "nope"], ws).code !== 0,
      "--project <unknown> still refuses (must name a real project)");
    // all-weight:0: a delivery-only run refuses; a run with stewards continues (delivery paused).
    c.projects.alpha.weight = 0;
    writeFileSync(cfgPath, JSON.stringify(c, null, 2));
    ok(runAgents(["--agents", "pm", "--plan", "2"], ws).code !== 0, "all-weight:0 + delivery-only agents → run refuses");
    const paused = runAgents(["--agents", "pm,sweep", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
    ok(paused.code === 0 && /delivery rotation paused/.test(paused.out),
      "all-weight:0 + stewards selected → run continues with delivery paused");
    c.projects.alpha.weight = 2; c.projects.beta.weight = 1;
    writeFileSync(cfgPath, JSON.stringify(c, null, 2));
  }

  // ── pick-time seed guard (service): an unseeded project never fires, warned ONCE, siblings unaffected ──
  {
    team(["init", "--dir", svcWs, "--key", "svc-sched", "--backend", "service"], tmp);
    mkdirSync(join(svcWs, "rg"), { recursive: true }); mkdirSync(join(svcWs, "rd"), { recursive: true });
    team(["add-project", "gamma", "--weight", "1"], svcWs); // auto-seeds its hub row (service)
    team(["add-repo", "rg", "--project", "gamma", "--path", "rg", "--role", "primary"], svcWs);
    // delta: a config entry with NO hub row — add-project now AUTO-SEEDS on service, so stage the drift
    // by hand (the shape still arrives via hand-edited configs / copied workspaces; weight 2 ⇒ delta is
    // every agent's FIRST pick, the token-burn shape the guard closes).
    {
      const c2 = JSON.parse(readFileSync(join(svcWs, "dev-loop.json"), "utf8"));
      c2.projects.delta = { weight: 2, repos: [] };
      writeFileSync(join(svcWs, "dev-loop.json"), JSON.stringify(c2, null, 2));
    }
    team(["add-repo", "rd", "--project", "delta", "--path", "rd", "--role", "primary"], svcWs);
    const r = runAgents(["--agents", "pm,qa", "--once"], svcWs, { DEVLOOP_CLAUDE_BIN: fakeBin });
    ok(r.code === 0, "an unseeded sibling does not fail the run");
    const warns = r.out.match(/project 'delta' is backend:"service" but not seeded/g) ?? [];
    ok(warns.length === 1, `the unseeded project is warned exactly ONCE per process (got ${warns.length})`);
    ok(/dev-loop seed delta/.test(r.out), "the warning names the exact seed command");
    const svcRows = readFileSync(join(svcWs, ".dev-loop", "team", "fires.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    ok(svcRows.length === 2 && svcRows.every((row: { project: string }) => row.project === "gamma"),
      "no fire launched for the unseeded project; both fires went to the seeded sibling (skip-advance)");

    // ── D8/D9 in TEAM mode: a service claude fire on the default interface ("cli") gets NO hub MCP
    //    injection, and the spawn env carries the FULL identity the dev-loop write layer needs —
    //    the env block IS the identity transport for interface="cli" fires. Pause delta (weight 0)
    //    so the rotation deterministically lands the probe fire on the seeded gamma. ──
    {
      const c2 = JSON.parse(readFileSync(join(svcWs, "dev-loop.json"), "utf8"));
      c2.projects.delta.weight = 0;
      writeFileSync(join(svcWs, "dev-loop.json"), JSON.stringify(c2, null, 2));
    }
    const argsFile = join(tmp, "svc-fire-args.txt");
    const envFile = join(tmp, "svc-fire-env.txt");
    const probeBin = join(tmp, "probe-claude.sh");
    writeFileSync(probeBin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsFile}\nenv | grep '^DEVLOOP' > ${envFile}\necho 'fire ok'\nexit 0\n`); chmodSync(probeBin, 0o755);
    const probed = runAgents(["--agents", "pm", "--once"], svcWs, { DEVLOOP_CLAUDE_BIN: probeBin });
    ok(probed.code === 0, "service team-mode claude fire (interface=cli default) exits 0");
    const fireArgs = readFileSync(argsFile, "utf8");
    ok(!/--mcp-config/.test(fireArgs) && !/--strict-mcp-config/.test(fireArgs) && !/dev-loop-hub/.test(fireArgs),
      "the team-mode claude fire carries NO hub MCP injection (D9: claude defaults to the CLI interface)");
    const fireEnv = readFileSync(envFile, "utf8");
    ok(/^DEVLOOP_ACTOR=pm$/m.test(fireEnv) && /^DEVLOOP_PROJECT=gamma$/m.test(fireEnv),
      "the fire env pins DEVLOOP_ACTOR + DEVLOOP_PROJECT (the CLI's identity ladder)");
    ok(new RegExp(`^DEVLOOP_HUB_DB=${join(svcWs, ".dev-loop", "hub.db").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(fireEnv),
      "the fire env pins DEVLOOP_HUB_DB at the workspace hub.db (the CLI's SoR path)");
    ok(/^DEVLOOP_DEV_SPLIT=(true|false)$/m.test(fireEnv),
      "the fire env carries DEVLOOP_DEV_SPLIT (the write layer's fire marker for its operator-write guard)");

    // The rollback switch: pin claude back to "mcp" on the project → the injection returns.
    {
      const c3 = JSON.parse(readFileSync(join(svcWs, "dev-loop.json"), "utf8"));
      c3.projects.gamma.hub = { agentInterface: { claude: "mcp" } };
      writeFileSync(join(svcWs, "dev-loop.json"), JSON.stringify(c3, null, 2));
      rmSync(argsFile, { force: true });
      runAgents(["--agents", "pm", "--once"], svcWs, { DEVLOOP_CLAUDE_BIN: probeBin });
      ok(/--mcp-config/.test(readFileSync(argsFile, "utf8")) && /dev-loop-hub/.test(readFileSync(argsFile, "utf8")),
        "hub.agentInterface.claude=\"mcp\" restores the inline hub injection (the D8 rollback switch, team mode)");
      delete c3.projects.gamma.hub;
      writeFileSync(join(svcWs, "dev-loop.json"), JSON.stringify(c3, null, 2));
    }
  }

  // ── team run lock: a live holder blocks a second scheduler ──
  const lockPath = join(ws, ".dev-loop", "locks", "run.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, team: "sched-team", startedAt: new Date().toISOString() })); // THIS process = a live holder
  const blocked = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--max-fires", "1"], { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: fakeBin }), encoding: "utf8", timeout: 8000 });
  ok((blocked.status ?? 1) !== 0 && /already running/.test(`${blocked.stdout}${blocked.stderr}`), "a second scheduler refuses while a live run lock is held");
  rmSync(lockPath, { force: true });

  // ── locks.ts: second acquire throws within the deadline, succeeds after release ──
  const lp = join(tmp, "unit.lock");
  const rel = await acquireLock(lp, { totalMs: 1000 });
  let threw = false;
  try { await acquireLock(lp, { totalMs: 300 }); } catch { threw = true; }
  ok(threw, "acquireLock: a second acquire throws while a live holder holds it");
  rel();
  const rel2 = await acquireLock(lp, { totalMs: 300 });
  ok(true, "acquireLock: succeeds after the holder releases");
  rel2();

  // ── with-repo-lock serializes concurrent base-clone mutations on a shared repo (must not interleave) ──
  const wrl = join(hubRoot, "src", "with-repo-lock.ts");
  const marker = join(tmp, "wrl.log");
  writeFileSync(marker, "");
  const pA = spawn("node", [wrl, "ra", "--", "sh", "-c", `echo A-in >> ${marker}; sleep 0.6; echo A-out >> ${marker}`], { cwd: ws, env: env(), stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 120));
  const pB = spawn("node", [wrl, "ra", "--wait", "10s", "--", "sh", "-c", `echo B-in >> ${marker}; echo B-out >> ${marker}`], { cwd: ws, env: env(), stdio: "ignore" });
  await Promise.all([new Promise((r) => pA.on("exit", r)), new Promise((r) => pB.on("exit", r))]);
  const seq = readFileSync(marker, "utf8").trim().split("\n").map((l) => l.trim()).filter(Boolean);
  ok(seq.join(",") === "A-in,A-out,B-in,B-out", `with-repo-lock serializes concurrent holders (got: ${seq.join(",")})`);

  console.log(fails === 0 ? "\nTEAM_SCHEDULER_OK" : `\n${fails} CHECK(S) FAILED`);
} finally {
  // The service run auto-ensures the workspace hub daemon — always stop it so no process outlives the test.
  // NOTE: exit via process.exitCode AFTER this block — a process.exit() inside the try would skip it entirely.
  try { spawnSync("node", [join(hubRoot, "src", "hub.ts"), "stop"], { cwd: svcWs, env: env(), encoding: "utf8", timeout: 20000 }); } catch { /* never started */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.exit(fails === 0 ? 0 : 1);
})();
