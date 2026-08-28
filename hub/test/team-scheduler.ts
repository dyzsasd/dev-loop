// run-agents team mode + locks: WRR plan, --project filter, enabled/weight exclusion, fires.jsonl ledger,
// the team run lock, and with-repo-lock serialization.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/locks.ts";
import { EXIT_NO_WORK } from "../src/breaker.ts"; // LOOP-543: the outcome code a fire that produced nothing is ledgered under
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-sched-")));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra });
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
  // LOOP-62 (AC3): the ledger the fire just CREATED is owner-only (0600) — the §16 perms posture the sibling
  // secrets.env already gets. (win32 has no POSIX mode bits — skipped there, as the src code is.)
  if (platform() !== "win32") ok((statSync(ledger).mode & 0o077) === 0,
    `LOOP-62: fires.jsonl is created owner-only 0600 (got ${(statSync(ledger).mode & 0o777).toString(8)})`);
  const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(rows.length >= 1 && rows[0].agent === "pm" && ["alpha", "beta"].includes(rows[0].project) && rows[0].exitCode === 0, "ledger row carries agent/project/exitCode (backend-agnostic soak metric)");
  // LOOP-58 (closes the LOOP-12 gap): recordFire stamps the per-fire UUID onto the fires.jsonl row, not just
  // the hub event. LOOP-12's test asserted only the event (and said so); the ledger write went untested.
  ok(typeof rows[0].fireId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(rows[0].fireId),
    `LOOP-58: the fires.jsonl row carries the per-fire UUID fireId (got ${JSON.stringify(rows[0].fireId)})`);

  // LOOP-93 (AC1): the SAME --once fire also created the operator runner logs — which hold the FULL stdout+stderr
  // stream, a strictly larger credential-adjacent surface than the ledger row above (same .dev-loop data home as
  // secrets.env). They get the identical §16 owner-only posture LOOP-62 gave the ledger: runner-logs/ is 0700 and
  // <agent>.log is 0600 on create. On a0afe6e both were world-readable 0644 — this is the LOOP-93 regression.
  // (win32 has no POSIX mode bits — skipped there, as the src is; the fuller warn/rotation/run.log cases: test/log-perms.ts.)
  if (platform() !== "win32") {
    const rlDir = join(ws, ".dev-loop", rows[0].project, "runner-logs");
    const rlLog = join(rlDir, "pm.log");
    ok(existsSync(rlLog) && (statSync(rlLog).mode & 0o077) === 0,
      `LOOP-93: runner-logs/<agent>.log is created owner-only 0600 (got ${existsSync(rlLog) ? (statSync(rlLog).mode & 0o777).toString(8) : "absent"})`);
    ok((statSync(rlDir).mode & 0o077) === 0,
      `LOOP-93: runner-logs/ is created owner-only 0700 (got ${(statSync(rlDir).mode & 0o777).toString(8)})`);
  }

  // ── LOOP-62 + suspectError: a failing fire is still FLAGGED, but the raw output tail — which can carry a
  //    credential the coding CLI echoed in its auth error — must NOT be persisted to fires.jsonl (§16). ──
  {
    const secret = "sk-LOOP62SEEDEDSECRET-must-not-persist";     // a credential-shaped token in the failing output
    const crashBin = join(tmp, "crash-claude.sh");
    writeFileSync(crashBin, `#!/bin/sh\necho 'Execution error: ${secret}'\nexit 0\n`); chmodSync(crashBin, 0o755);
    const r = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: crashBin });
    ok(/suspectError/.test(r.out), "the scheduler warns on an exit-0 fire whose output is a failure marker");
    const rawLines = readFileSync(ledger, "utf8").trim().split("\n");
    const rows2 = rawLines.map((l) => JSON.parse(l));
    const last = rows2[rows2.length - 1];
    // The failure is still CLASSIFIED (suspectError survives — the breaker/telemetry keep working) …
    ok(last.exitCode === 0 && last.suspectError === true,
      "LOOP-62: the ledger row still flags suspectError (classification survives the redaction)");
    // … but the raw CLI stream (outputTail) is GONE from disk, so a seeded credential never lands there.
    ok(!("outputTail" in last), "LOOP-62: the raw outputTail is no longer persisted to fires.jsonl (AC1)");
    ok(!rawLines.some((l) => l.includes(secret)),
      "LOOP-62: a secret echoed in a failing fire's output does not reach fires.jsonl (AC2/AC4)");
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
    writeFileSync(promptDump, `#!/bin/sh\nprintf '%s\\n' "$@" > ${promptFile}\ncat >> ${promptFile}\nexit 0\n`); chmodSync(promptDump, 0o755);
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

  // ── §22a digest gate re-key: a team-scope fire carries the TEAM.COMMS fact, so the digest can never
  //    be silently suppressed by a missing per-project "communication" block (agents P5) ──
  {
    const promptFile = join(tmp, "comms-prompt.txt");
    const promptDump = join(tmp, "comms-claude.sh");
    writeFileSync(promptDump, `#!/bin/sh\nprintf '%s\\n' "$@" > ${promptFile}\ncat >> ${promptFile}\nexit 0\n`); chmodSync(promptDump, 0o755);
    // no team.comms → the fire is told the channel is missing and to surface it, not to push
    runAgents(["--agents", "communication", "--once"], ws, { DEVLOOP_CLAUDE_BIN: promptDump });
    let prompt = readFileSync(promptFile, "utf8");
    ok(/team comms: not configured/.test(prompt), "a team-scope fire without team.comms carries the 'not configured' fact");
    ok(/§22a digest gate: no team comms channel — skip the digest push/.test(prompt),
      "a communication fire without team.comms is told to skip the digest push (and surface the gap)");
    // team.comms present → the digest gate is THIS, not any per-project communication block (none exists here)
    ok((team(["set", "team.comms.provider", "slack"], ws).status ?? 1) === 0, "team set wires team.comms for the digest-gate probe");
    rmSync(promptFile, { force: true });
    runAgents(["--agents", "communication", "--once"], ws, { DEVLOOP_CLAUDE_BIN: promptDump });
    prompt = readFileSync(promptFile, "utf8");
    ok(/team comms: slack \(webhook env DEVLOOP_COMMS_WEBHOOK\)/.test(prompt),
      "a team-scope fire with team.comms carries provider + webhook env NAME (never the URL)");
    ok(/§22a digest gate: the team comms line above IS the digest gate/.test(prompt) && /article drafting only/.test(prompt),
      "a communication fire is told the digest keys on team.comms — a missing per-project communication block never suppresses it");
    // a non-communication steward gets the comms fact but NOT the §22a digest directive
    rmSync(promptFile, { force: true });
    runAgents(["--agents", "sweep", "--once"], ws, { DEVLOOP_CLAUDE_BIN: promptDump });
    prompt = readFileSync(promptFile, "utf8");
    ok(/team comms: slack/.test(prompt) && !/§22a digest gate/.test(prompt),
      "other stewards see the comms fact but no digest directive (communication-only)");
    // drop comms again so later fixtures stay byte-identical to before this block
    const cComms = JSON.parse(readFileSync(cfgPath, "utf8"));
    delete cComms.team.comms;
    writeFileSync(cfgPath, JSON.stringify(cComms, null, 2));
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

    // ── D3 (team mirror): a lane that finds no eligible job SAYS so, per candidate project ────────
    // The team scheduler's lane branch `continue`d in silence, exactly like the legacy one: a lane
    // that declined every candidate produced no start line, no log file and no skip line, so a
    // correct skip and a crashed slot were indistinguishable. gamma is seeded and its board is empty
    // (the fires above write no tickets), so qa-maintenance has nothing to verify and nothing to unblock.
    {
      const laneOnce = runAgents(["--agents", "qa-maintenance", "--once"], svcWs, { DEVLOOP_CLAUDE_BIN: fakeBin });
      const skip = laneOnce.out.split("\n").find((l) => /\[qa-maintenance\] skipped: /.test(l)) ?? "";
      ok(laneOnce.code === 0, "D3 team: a lane with nothing eligible still exits 0");
      ok(skip !== "",
        `D3 team: the team scheduler prints '[qa-maintenance] skipped: <reason>' (lines seen: ${JSON.stringify(laneOnce.out.split("\n").filter((l) => /qa-maintenance/.test(l)))})`);
      ok(/qa-maintenance lane in 'gamma'/.test(skip) && /0 In Review/.test(skip),
        `D3 team: the reason names the lane, the candidate PROJECT it declined, and the board counts (got ${JSON.stringify(skip)})`);
      ok(!/qa-maintenance: start \(/.test(laneOnce.out),
        "D3 team control: the declining lane launched nothing, so the skip line is the only report of it");
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

  // ── LOOP-83: claude --output-format json lane — a REAL fire (fake `claude` bin emitting canned terminal
  //    JSON, read back from fires.jsonl) proves the end-to-end legs the adapter unit tests can't: usage on the
  //    recorded row, additive suspectError (silent + is_error, on top of the surviving text/empty arm), and
  //    operator-visible result text on every exit path incl. a truncated buffer. AC1-evidence choice: the
  //    canned-object route (a fake CLI emits the object, the fires.jsonl row is read back) — no live claude. ──
  {
    // (a) well-formed terminal object → usage recorded on the row; the operator sees the RESULT TEXT, not the blob.
    const okJson = '{"type":"result","subtype":"success","is_error":false,"result":"LOOP-83 fire complete.","usage":{"input_tokens":1234,"output_tokens":210,"cache_creation_input_tokens":12,"cache_read_input_tokens":99},"total_cost_usd":0.0212}';
    const goodBin = join(tmp, "usage-claude.sh");
    writeFileSync(goodBin, `#!/bin/sh\nprintf '%s\\n' '${okJson}'\nexit 0\n`); chmodSync(goodBin, 0o755);
    const g = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: goodBin });
    const gLast = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
    ok(gLast.usage && gLast.usage.source === "provider" && gLast.usage.inputTokens === 1234 && gLast.usage.outputTokens === 210
      && gLast.usage.costUsd === 0.0212 && gLast.usage.currency === "USD" && gLast.usage.cacheWriteTokens === 12 && gLast.usage.cacheReadTokens === 99,
      `LOOP-83: a well-formed claude fire records usage (tokens + cost + currency) on the fires.jsonl row (got ${JSON.stringify(gLast.usage)})`);
    ok(gLast.usage && !("suspectError" in gLast), "LOOP-83: a well-formed claude result is NOT flagged suspectError");
    const usageKeys = Object.keys(gLast.usage);
    ok(usageKeys.every((k) => ["source", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "currency"].includes(k)),
      `LOOP-83 §16: the recorded usage row carries ONLY numeric usage fields (${usageKeys.join(",")})`);
    ok(/LOOP-83 fire complete\./.test(g.out) && !/input_tokens/.test(g.out),
      "LOOP-83: the operator sees the agent's RESULT TEXT, not the raw JSON blob (deferred echo + extraction)");

    // (b) exit-0 fire whose terminal JSON reports is_error:true → flagged suspectError (the structured signal).
    const errJson = '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}';
    const errBin = join(tmp, "iserr-claude.sh");
    writeFileSync(errBin, `#!/bin/sh\nprintf '%s\\n' '${errJson}'\nexit 0\n`); chmodSync(errBin, 0o755);
    const e = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: errBin });
    const eLast = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
    ok(/suspectError/.test(e.out) && eLast.exitCode === 0 && eLast.suspectError === true,
      "LOOP-83: an exit-0 claude fire whose terminal JSON is_error:true is flagged suspectError (structured signal, additive)");

    // (c) SILENT exit-0 fire (no output at all) → flagged suspectError — the empty-output arm survives the migration.
    const silentBin = join(tmp, "silent-claude.sh");
    writeFileSync(silentBin, "#!/bin/sh\nexit 0\n"); chmodSync(silentBin, 0o755);
    const s = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: silentBin });
    const sLast = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
    ok(/suspectError/.test(s.out) && sLast.exitCode === EXIT_NO_WORK && sLast.suspectError === true,
      "LOOP-83: a SILENT exit-0 claude fire is flagged suspectError (empty-output arm preserved, not replaced by the JSON signal)");
    // LOOP-543 pins the OTHER half of that same row, on the one fixture in the suite that is this ticket's
    // subject: the child returned 0, and the LEDGER records EXIT_NO_WORK + errorClass "no-output" so the
    // breaker (which returns early on a 0) sees a failure and the taxonomy gets a bucket. Asserting both
    // together is what stops the flag and the class from drifting apart — the pair IS the contract.
    ok(sLast.errorClass === "no-output",
      "LOOP-543: …and the same row carries errorClass 'no-output' — the flag and the class agree on one observable");

    // (d) TRUNCATED terminal object (killed/timed-out mid-emit) → no usage row, but the operator still sees the
    //     partial output (never nothing) — the deferred echo falls back to the raw buffer when it can't parse.
    const truncBin = join(tmp, "trunc-claude.sh");
    writeFileSync(truncBin, `#!/bin/sh\nprintf '%s' '{"type":"result","subtype":"success","result":"partial work before the kill'\nexit 0\n`); chmodSync(truncBin, 0o755);
    const t = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: truncBin });
    const tLast = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
    ok(!tLast.usage, "LOOP-83: a truncated terminal object records NO usage (honest miss, never a wrong/partial row)");
    ok(/partial work before the kill/.test(t.out),
      "LOOP-83: operator-visible output survives a truncated buffer — the raw partial is echoed, never nothing (not only a JSON blob)");
  }

  // ── LOOP-459: --dry-run prints promptly and writes NO scheduler-gate.json ──
  {
    const gateDir = join(svcWs, ".dev-loop", "team");
    rmSync(gateDir, { recursive: true, force: true });
    const dryOnce = runAgents(["--agents", "pm", "--once", "--dry-run", "--change-gate"], svcWs);
    ok(dryOnce.code === 0, `LOOP-459(1): --once --dry-run --change-gate exits 0 (${dryOnce.code})`);
    ok(dryOnce.out.includes("[dry-run]"), "LOOP-459(1): dry-run output printed");
    ok(!existsSync(join(gateDir, "scheduler-gate.json")), "LOOP-459(1): no scheduler-gate.json written");
  }
  {
    rmSync(join(svcWs, ".dev-loop", "team"), { recursive: true, force: true });
    const dryNoOnce = runAgents(["--agents", "pm", "--dry-run", "--change-gate"], svcWs);
    ok(dryNoOnce.code === 0, `LOOP-459(2): --dry-run (no --once) exits 0 (${dryNoOnce.code})`);
    ok(dryNoOnce.out.includes("[dry-run]"), "LOOP-459(2): non-once dry-run prints immediately");
    ok(!existsSync(join(svcWs, ".dev-loop", "team", "scheduler-gate.json")), "LOOP-459(2): no scheduler-gate.json written");
  }

  console.log(fails === 0 ? "\nTEAM_SCHEDULER_OK" : `\n${fails} CHECK(S) FAILED`);
} finally {
  // The service run auto-ensures the workspace hub daemon — always stop it so no process outlives the test.
  // NOTE: exit via process.exitCode AFTER this block — a process.exit() inside the try would skip it entirely.
  try { spawnSync("node", [join(hubRoot, "src", "hub.ts"), "stop"], { cwd: svcWs, env: env(), encoding: "utf8", timeout: 20000 }); } catch { /* never started */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.exit(fails === 0 ? 0 : 1);
})();
