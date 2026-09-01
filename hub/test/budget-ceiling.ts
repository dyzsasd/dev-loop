// budget-ceiling.ts — LOOP-229 (Child 3 of LOOP-197): the pre-launch dailyUsd gate + budget breaker + the
// three observability surfaces (run.log / doctor / metrics), and the load-bearing INV-1 byte-identical-when-
// unset guarantee. Drives real `run-agents --once` fires (a fake CLI bin) against a seeded fires.jsonl ledger,
// exactly like team-scheduler.ts, so the gate is exercised end-to-end (the scheduler cannot be imported —
// run-agents' main() is unconditional). Run from a /tmp copy, never inside the live workspace (the
// hub-tests-shadowed-inside-workspace lesson — a scheduler test spawned inside the live workspace false-fails).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorWorkspace } from "../src/doctor.ts";
import { rollingSpendUsd, type FireRow } from "../src/metrics.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-budget-"));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const runAgents = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd, env: env(extra), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const metricsCost = (cwd: string) => {
  const r = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--cost"], { cwd, env: env(), encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};
// doctorWorkspace prints via console.log and returns { ok } — capture BOTH (ok===true IS the DOCTOR_OK contract).
const doctorRun = async (wsRoot: string): Promise<{ out: string; ok: boolean }> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  let res: { ok: boolean } = { ok: false };
  try { res = await doctorWorkspace(loadWorkspace(wsRoot)); } finally { console.log = orig; }
  return { out: lines.join("\n"), ok: res.ok };
};

(async () => {
  const ws = join(tmp, "ws");
  team(["init", "--dir", ws, "--key", "budget-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
  mkdirSync(join(ws, "ra"), { recursive: true });
  team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
  team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);

  const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
  const fakeBin = join(tmp, "fake-claude.sh");
  writeFileSync(fakeBin, "#!/bin/sh\necho 'fire ok'\nexit 0\n"); chmodSync(fakeBin, 0o755);

  // A priced ledger row the enforcement total (rollingSpendUsd) sums directly. Only ts + usage.costUsd matter
  // for the sum; the rest mirror a real recordFire row. ageMs pushes the row back in time (for the roll-over test).
  const costRow = (costUsd: number, ageMs = 0) => JSON.stringify({
    ts: new Date(Date.now() - ageMs).toISOString(), agent: "qa", project: "alpha", codingAgent: "claude",
    provider: "anthropic", model: "claude-opus", effort: "high", durationMs: 600_000, exitCode: 0, timedOut: false,
    fireId: "00000000-0000-0000-0000-000000000000",
    usage: { source: "provider", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, currency: "USD" },
  });
  const seed = (...rows: string[]) => { mkdirSync(dirname(ledger), { recursive: true }); writeFileSync(ledger, rows.map((r) => r + "\n").join("")); };
  const rowCount = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).length : 0);

  // ── doctor UNSET nag: no ceiling + measured spend ⇒ exactly ONE [W47] nag, and DOCTOR_OK still holds ──
  seed(costRow(50)); // some measured spend so there IS a burn rate to name
  const docUnset = await doctorRun(ws);
  const w47unset = (docUnset.out.match(/\[W47\]/g) ?? []).length;
  ok(w47unset === 1, `doctor: exactly ONE [W47] line when the ceiling is unset (got ${w47unset})`);
  ok(/no daily budget ceiling/.test(docUnset.out), "doctor: the unset nag names the missing ceiling + the measured burn rate");
  ok(docUnset.ok === true, "doctor: DOCTOR_OK (ok===true) holds — the unset nag is warn-only (the AC)");
  ok(!docUnset.out.includes("❌"), "doctor: no ❌ failures from the budget nag");
  // metrics --cost is UNCHANGED when the ceiling is unset (no budget line) — the read-surface half of INV-1.
  ok(!/budget: rolling 24h/.test(metricsCost(ws)), "metrics --cost: no budget line when the ceiling is unset (byte-identical surface)");

  // ── W47 rate: the divisor is the ledger's own span, not a fixed 7 (a young ledger is not seven days old) ──
  // $70 billed across one hour of ledger extrapolates to $1680/day. A fixed divisor of 7 reported $10.00/day
  // for the same ledger, and the operator sizes team.budget.dailyUsd from exactly this number.
  seed(costRow(70, 60 * 60_000));
  const docYoung = await doctorRun(ws);
  const rateYoung = /~\$([0-9.]+)\/day/.exec(docYoung.out)?.[1];
  ok(rateYoung === "1680.00", `doctor W47: a 1h-old $70 ledger reads ~$1680.00/day, not the $10.00 a /7 divisor gave (got ${rateYoung ?? "no rate"})`);
  ok(/measured over 1h of ledger/.test(docYoung.out), "doctor W47: the line names the span it measured over");

  // A ledger spanning nearly the whole window is divided by that span: $70 over 6d23h is $10.06/day, which is
  // where the old fixed /7 divisor happened to be right — it is right only for a ledger exactly 7 days long.
  seed(costRow(70, 6 * 86_400_000 + 23 * 3_600_000));
  const docOld = await doctorRun(ws);
  const rateOld = /~\$([0-9.]+)\/day/.exec(docOld.out)?.[1];
  ok(rateOld === "10.06", `doctor W47: a 6d23h-old $70 ledger reads ~$10.06/day (got ${rateOld ?? "no rate"})`);

  // ── the number the GATE compares, printed next to the average ─────────────────────────────────
  // The average divides spend by how long the ledger has EXISTED. For a young ledger that is right and
  // is what the arms above pin. For an IDLE one it decays: the numerator freezes while the divisor
  // grows, so the same spend reads lower every hour the loop stays down — and the operator sizes the
  // ceiling from it. Measured on the live jinko-browser-use ledger, one frozen $345.91 printed $487/day,
  // then $169, then $112 over three days of downtime. `budgetGateReason` compares a 24h ROLLING total,
  // so that is the figure that has to be on the line too.
  //
  // Fixture: $40 + $50 inside one day, three days back, then nothing. Busiest 24h = $90; the average is
  // $90 / 3.1d ≈ $29 and keeps falling.
  const DAY = 86_400_000;
  seed(costRow(40, 3 * DAY), costRow(50, 3 * DAY - 2 * 3_600_000));
  const docIdle = await doctorRun(ws);
  ok(/busiest 24h billed \$90\.00/.test(docIdle.out),
    `doctor W47: the line names the busiest 24h — the quantity the ceiling is compared against (got ${/busiest 24h billed \$[0-9.]+/.exec(docIdle.out)?.[0] ?? "no peak"})`);
  const avgIdle = /~\$([0-9.]+)\/day/.exec(docIdle.out)?.[1];
  ok(avgIdle !== undefined && Number(avgIdle) < 90,
    `doctor W47: …and the lifetime average is BELOW it once the loop goes idle, which is the dilution (avg ${avgIdle ?? "none"} vs peak 90.00)`);
  ok(/idle 2\.9d|idle 3\.0d|idle 7[0-9]h/.test(docIdle.out),
    `doctor W47: the idle stretch is disclosed, so the average is not read as a current rate (got ${/idle [0-9.]+[dh]/.exec(docIdle.out)?.[0] ?? "no idle note"})`);

  // A busy ledger with no idle tail says nothing about idleness — the note is a disclosure, not decoration.
  seed(costRow(40, 3 * 3_600_000), costRow(50, 60_000));
  const docFresh = await doctorRun(ws);
  ok(!/dilutes that average/.test(docFresh.out),
    "doctor W47: a ledger whose last fire is minutes old carries no idle note");
  ok(/busiest 24h billed \$90\.00/.test(docFresh.out),
    "doctor W47: …and the peak is the same $90.00 — it does not move with the clock, which is the point");

  // Below an hour the span is clamped to an hour, so a burst of fires cannot extrapolate to an absurd figure.
  seed(costRow(5, 60_000));
  const docBurst = await doctorRun(ws);
  const rateBurst = /~\$([0-9.]+)\/day/.exec(docBurst.out)?.[1];
  ok(rateBurst === "120.00", `doctor W47: a 1-minute-old $5 ledger is clamped to the 1h span, ~$120.00/day (got ${rateBurst ?? "no rate"})`);

  // ── AC5 (anti-deadlock, LOAD-BEARING): dailyUsd UNSET ⇒ byte-identical — even a huge spend never gates ──
  // The failure mode we design against is a silent-refuse deadlock, so prove that with NO ceiling set, a ledger
  // far above any plausible ceiling still FIRES normally (no gate, no refusal line, a fire actually lands).
  seed(costRow(100), costRow(100)); // $200 rolling in the 24h window
  const before5 = rowCount();
  const unset = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  ok(unset.code === 0, "AC5: --once exits 0 with dailyUsd unset");
  ok(!/launch refused/.test(unset.out), "AC5: dailyUsd unset ⇒ NO 'launch refused' at $200 rolling (INV-1 short-circuit, byte-identical)");
  ok(rowCount() === before5 + 1, "AC5: dailyUsd unset ⇒ the fire actually fired (a new ledger row was appended)");

  // ── AC2/AC3: over dailyUsd ⇒ the launch is REFUSED (not spawned) and ALL THREE surfaces report it ──
  ok((team(["set", "team.budget.dailyUsd", "5"], ws).status ?? 1) === 0, "AC1: team set team.budget.dailyUsd 5 (through the mutator)");
  seed(costRow(100), costRow(100)); // $200 rolling >> $5 ceiling
  const before2 = rowCount();
  const over = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  ok(over.code === 0, "AC2: an over-ceiling --once still exits 0 (a refusal is not a failure)");
  ok(/\[pm\] launch refused: budget dailyUsd \$5\.00 reached \(rolling \$/.test(over.out),
    "AC3 surface 1 (run.log): the refusal line names the ceiling + the rolling total");
  ok(!/fire ok/.test(over.out) && rowCount() === before2,
    "AC2: the fire was NOT spawned (no CLI output, no new ledger row) — a scheduler-skip that boots no corpus");
  const docOver = await doctorRun(ws);
  ok(/\[W47\]/.test(docOver.out) && /budget BREACH/.test(docOver.out), "AC3 surface 2 (doctor): the [W47] budget BREACH line");
  ok(docOver.ok === true, "AC3: doctor breach is warn-only — DOCTOR_OK still holds");
  const metOver = metricsCost(ws);
  ok(/budget: rolling 24h \$/.test(metOver) && /dailyUsd \$5\.00/.test(metOver) && /OVER ceiling/.test(metOver),
    "AC3 surface 3 (metrics): the rolling-daily-total-vs-ceiling line reports the breach");

  // ── AC6 resume (raise the ceiling): over ⇒ raise dailyUsd above the total ⇒ the next --once fires ──
  ok((team(["set", "team.budget.dailyUsd", "100000"], ws).status ?? 1) === 0, "AC6: team set team.budget.dailyUsd 100000 (raise above the total)");
  seed(costRow(100), costRow(100));
  const beforeR = rowCount();
  const resumed = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  ok(!/launch refused/.test(resumed.out) && rowCount() === beforeR + 1,
    "AC6: raising dailyUsd above the rolling total resumes launches (no refusal, a fire lands)");

  // ── AC6 resume (24h window roll-over): keep the low ceiling, but the costly rows AGE OUT of the window ──
  ok((team(["set", "team.budget.dailyUsd", "5"], ws).status ?? 1) === 0, "AC6: team set team.budget.dailyUsd 5 (low ceiling again)");
  seed(costRow(100, 25 * 3_600_000), costRow(100, 26 * 3_600_000)); // both > 24h old ⇒ outside the DAY window
  const beforeA = rowCount();
  const aged = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  ok(!/launch refused/.test(aged.out) && rowCount() === beforeA + 1,
    "AC6: costly rows aging out of the 24h window drops the total below the ceiling ⇒ launches resume");

  // ════ Child 4 (LOOP-230) — the perFireUsd in-flight watchdog ════════════════════════════════════
  // Same harness, one axis down: dailyUsd decides whether a fire LAUNCHES, perFireUsd decides whether a
  // launched fire SURVIVES. Park dailyUsd far above anything seeded so only the per-fire ceiling can act.
  ok((team(["set", "team.budget.dailyUsd", "100000"], ws).status ?? 1) === 0, "LOOP-230 setup: dailyUsd parked high (isolate the per-fire axis)");
  const lastRow = (): Record<string, unknown> => {
    const lines = readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  };

  // ── AC "no false kill on a normal fire" (the control run): a ceiling far above this fire's estimated
  // cost arms the watchdog (55h deadline at the fallback rate) and never trips it. This runs FIRST because
  // its ledger row is also how the test learns the exact (codingAgent, model) profile ratePerMsFor keys on —
  // hard-coding that profile would let the rate lookup silently miss and fall back without the test noticing.
  seed();
  ok((team(["set", "team.budget.perFireUsd", "1000"], ws).status ?? 1) === 0, "AC1: team set team.budget.perFireUsd 1000 (through the mutator)");
  const control = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: fakeBin });
  const ctlRow = lastRow();
  ok(/fire ok/.test(control.out) && !/budget perFireUsd/.test(control.out),
    "AC (control): a fire under the ceiling runs to completion — no budget kill, no budget reason logged");
  ok(ctlRow.exitCode === 0 && ctlRow.errorClass === undefined && ctlRow.timedOut === false,
    `AC (control): its ledger row is a clean exit — no errorClass (got ${JSON.stringify({ exitCode: ctlRow.exitCode, errorClass: ctlRow.errorClass })})`);

  // ── AC4: a fire whose ELAPSED time crosses perFireUsd / ratePerMs is terminated, with a reason and a
  // ledger class DISTINCT from the wall-timeout. The rate is pinned by seeding ONE priced row of the very
  // profile the control fire just recorded: $1.00 / 1_000_000ms = 1e-6 $/ms, so a $0.002 ceiling ⇒ a 2s
  // deadline. The stub sleeps 60s, so anything under that is the watchdog, not the stub finishing.
  const pricedProfileRow = JSON.stringify({
    ts: new Date().toISOString(), agent: "pm", project: "alpha",
    codingAgent: ctlRow.codingAgent, model: ctlRow.model, provider: "anthropic", effort: "high",
    durationMs: 1_000_000, exitCode: 0, timedOut: false, fireId: "00000000-0000-0000-0000-000000000001",
    usage: { source: "provider", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, currency: "USD" },
  });
  seed(pricedProfileRow);
  ok((team(["set", "team.budget.perFireUsd", "0.002"], ws).status ?? 1) === 0, "AC1: team set team.budget.perFireUsd 0.002 (a fractional ceiling is valid config)");
  const sleeperBin = join(tmp, "sleeper-claude.sh");
  // `exec`, not a plain `sleep`: the watchdogs signal the DIRECT CHILD, and a shell waiting on a
  // foreground command cannot act on SIGINT until that command returns — so a plain `sleep 60` here sits
  // out the full 10 s escalation on every kill arm. exec makes the sleep itself the child, which dies on
  // the signal. Measured: 11.9 s → 1.9 s for this arm. (The unreachable `echo 'fire finished'` went with
  // it; nothing asserted it, and a 60 s sleep never reached it.)
  writeFileSync(sleeperBin, "#!/bin/sh\necho 'fire started'\nexec sleep 60\n"); chmodSync(sleeperBin, 0o755);
  const t0 = Date.now();
  const killed = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: sleeperBin });
  const elapsedMs = Date.now() - t0;
  const killRow = lastRow();
  ok(elapsedMs < 30_000, `AC4: the 60s fire was terminated early (~2s deadline; took ${Math.round(elapsedMs / 1000)}s)`);
  ok(/budget perFireUsd \$0\.002/.test(killed.out),
    "AC4: the kill reason names the perFireUsd ceiling (a sub-cent ceiling is NOT printed as $0.00)");
  ok(!/fire exceeded/.test(killed.out) && !/looks WEDGED/.test(killed.out),
    "AC4: the reason is DISTINCT — neither the wall-timeout ('fire exceeded') nor the stall wording");

  // The SIGNAL the budget watchdog opens with decides whether the spend it just stopped is ever accounted
  // for. claude's `--output-format json` buffers its terminal object until exit and flushes it for SIGINT
  // but not for SIGTERM: on the live board all 7 SIGTERM budget kills carry `usage: null`, while all 17
  // fires the operator's SIGINT stop ended carry a real provider-measured cost. The 10s SIGKILL escalation
  // is unchanged, so a child that ignores SIGINT still dies on schedule.
  ok(/— SIGINT \(SIGKILL in 10s\)/.test(killed.out) && !/— SIGTERM/.test(killed.out),
    `AC4: the budget kill opens with SIGINT, the signal that leaves the receipt behind${/— SIGTERM/.test(killed.out) ? " [regressed: still SIGTERM]" : ""}`);

  // Wording is not delivery. This stub installs its own SIGINT handler and leaves a marker, so the arm
  // fails if the signal that actually reaches the child is anything else.
  //
  // It is a node script rather than a shell wrapper on purpose. The watchdog signals the DIRECT CHILD
  // (LOOP-23: a graceful signal to the group would also hit the agent's check-point helpers), and a
  // `#!/bin/sh` stub waiting on a foreground `sleep` cannot run its trap until that sleep returns — so a
  // shell stub would model the delivery as failing when the real child, the `claude` binary, handles
  // SIGINT itself. The production ledger settles which model is right: the operator stop path has always
  // signalled the direct child only, and all 17 fires it ended came back with their receipts.
  const marker = join(tmp, "sigint-received");
  const trapBin = join(tmp, "trap-claude.js");
  writeFileSync(trapBin, `#!/usr/bin/env node\nconst fs = require("node:fs");\nprocess.on("SIGINT", () => { fs.writeFileSync(${JSON.stringify(marker)}, "caught"); process.exit(0); });\nconsole.log("fire started");\nsetTimeout(() => {}, 60_000);\n`);
  chmodSync(trapBin, 0o755);
  runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: trapBin });
  ok(existsSync(marker), "AC4: …and the child actually receives INT — the fire's own trap ran");
  // LOOP-445 — this stub emits plain text, so no usage is parseable and the fire's spend is UNKNOWN. A kill
  // on an unknown spend is a MODELED kill: "budget-deadline". It used to read "budget-per-fire", which
  // asserted a breach the run never measured. The measured-breach path is asserted below and is what keeps
  // LOOP-230's protection pinned.
  ok(killRow.errorClass === "budget-deadline",
    `LOOP-445: an unmeasurable kill is "budget-deadline", not a claimed breach (got ${JSON.stringify(killRow.errorClass)})`);
  ok(killRow.timedOut === false && killRow.exitCode === 126,
    `AC4: the row is not a timeout — timedOut false + exit 126, never 124 (got ${JSON.stringify({ timedOut: killRow.timedOut, exitCode: killRow.exitCode })})`);
  ok(typeof killRow.durationMs === "number" && (killRow.durationMs as number) < 30_000,
    "AC4: the row carries the (short) durationMs a killed fire always records — the estimate's own input");
  // LOOP-445 AC4 — the kill reason carries the fire's OWN spend beside the model that condemned it.
  ok(/spend at kill:/.test(killed.out),
    "LOOP-445 AC4: the kill reason states the fire's spend at kill time, not only the ceiling/rate/deadline");

  // ── LOOP-445 AC6 — the REAL budget path is not disarmed: a fire whose MEASURED spend crosses the
  // ceiling is still killed and still classified "budget-per-fire". Same 2s deadline; the only change is
  // that this stub emits a claude-shaped result payload, so the spend is measurable at finalize.
  // (`printf` then sleep: the whole buffer is one JSON object, which is what claudeAdapter.parse reads.)
  const claudeStub = (costUsd: number, tokens: number, name: string): string => {
    const bin = join(tmp, name);
    const payload = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: "done", num_turns: 3,
      total_cost_usd: costUsd,
      usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }).replace(/'/g, "'\\''");
    // exec for the same reason as sleeperBin above — the payload is already printed by then.
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${payload}'\nexec sleep 60\n`); chmodSync(bin, 0o755);
    return bin;
  };
  seed(pricedProfileRow);
  const overBin = claudeStub(0.5, 1234, "over-claude.sh"); // $0.50 measured against the $0.002 ceiling
  const overRun = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: overBin });
  const overRow = lastRow();
  ok(overRow.exitCode === 126 && /budget perFireUsd/.test(overRun.out),
    `AC6: a fire over the ceiling is still KILLED by the budget watchdog (got exit ${JSON.stringify(overRow.exitCode)})`);
  ok(overRow.errorClass === "budget-per-fire",
    `AC6: and it is still classified "budget-per-fire" — LOOP-230 is not disarmed (got ${JSON.stringify(overRow.errorClass)})`);

  // ── LOOP-445 AC1 (end-to-end) — the same kill, with the spend MEASURED UNDER the ceiling, must not
  // claim a breach. This is the $4.34-against-$20 shape that motivated the ticket, in miniature.
  seed(pricedProfileRow);
  const underBin = claudeStub(0.0001, 1234, "under-claude.sh"); // $0.0001 measured against the $0.002 ceiling
  runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: underBin });
  const underRow = lastRow();
  ok(underRow.exitCode === 126 && underRow.errorClass === "budget-deadline",
    `AC1: a kill at 5% of the ceiling is "budget-deadline", never a claimed breach (got ${JSON.stringify({ exitCode: underRow.exitCode, errorClass: underRow.errorClass })})`);

  // ── LOOP-445 AC2 (end-to-end) — a fire that reached the provider and spent NOTHING is wedged, and the
  // liveness arm names it even though the budget deadline is what tripped. On this lane the stall watchdog
  // is disarmed (effectiveStallMs = 0 for claude), so before this ticket nothing could ever classify it.
  seed(pricedProfileRow);
  const wedgedBin = claudeStub(0, 0, "wedged-claude.sh"); // 0 tokens, $0 — the 12 pm rows of 2026-08-07/08
  runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: wedgedBin });
  const wedgedRow = lastRow();
  ok(wedgedRow.errorClass === "stalled",
    `AC2: a 0-token fire killed by the budget deadline is classified "stalled" (got ${JSON.stringify(wedgedRow.errorClass)})`);

  // ── a killed fire's $0 receipt is missing data, not a $0 fire ───────────────────────────────
  // The budget watchdog now sends SIGINT (run-agents.ts), which lets the CLI flush its terminal JSON on
  // the way out, so a killed fire finally reports usage at all. That receipt covers only COMPLETED turns,
  // so a kill landing inside the first turn returns costUsd 0 — and counting that as measured would drop
  // the total BELOW the estimate it replaced. That is the one way this change could make the accounting
  // worse than the null it fixes.
  {
    const t = (ageMin: number) => new Date(Date.now() - ageMin * 60_000).toISOString();
    const usage = (costUsd: number) => ({ source: "provider" as const, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, currency: "USD" });
    const base = { agent: "qa", project: "alpha", codingAgent: "claude", model: "sonnet", exitCode: 0 };
    const priced = { ...base, ts: t(50), durationMs: 600_000, usage: usage(6) } as FireRow;

    const withKilled = rollingSpendUsd(
      [priced, { ...base, ts: t(30), durationMs: 600_000, exitCode: 126, watchdog: "budget", usage: usage(0) } as FireRow],
      86_400_000, Date.now());
    ok(withKilled > 6.5,
      `a watchdog-killed fire reporting $0 is ESTIMATED, not read as a $0 fire (total $${withKilled.toFixed(2)})`);
    // …and estimated at the SURVIVING fires' rate: a truncated fire's own $/ms must not enter the median it
    // is measured against (the reason ratePerMsBasis excludes killed rows, LOOP-445).
    ok(Math.abs(withKilled - 12) < 0.01,
      `…at the priced row's rate — $6 measured + $6 for an equal-duration kill (got $${withKilled.toFixed(2)})`);

    // CONTROL: a genuine measured $0 — the CLI refusing at a session limit before billing, 17 such rows on
    // the live board — is not watchdog-killed and still counts as the $0 it really was.
    const withRealZero = rollingSpendUsd(
      [priced, { ...base, ts: t(30), durationMs: 4_000, exitCode: 1, errorClass: "session-limit", usage: usage(0) } as FireRow],
      86_400_000, Date.now());
    // A usage object with NO costUsd key at all. `!== null` let `undefined` through, so `measured` became
    // undefined and the sum went NaN — and NaN loses every comparison, so budgetGateReason's
    // `rolling > dailyUsd` turned false and the spend gate stopped refusing launches while still looking
    // armed. The same slip sat in the rate collection, where `undefined / durationMs` poisoned the median,
    // so fixing only the total left the sum NaN through the estimate. readFireRows does not shape-check
    // (deliberately — it tolerates a half-written line from a crash), so such a row is reachable.
    const noKey = rollingSpendUsd(
      [priced, { ...base, ts: t(30), durationMs: 600_000, usage: { source: "provider", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, currency: "USD" } } as unknown as FireRow],
      86_400_000, Date.now());
    ok(Number.isFinite(noKey), `a usage object missing costUsd does not poison the total to NaN (got ${noKey})`);
    ok(Math.abs(noKey - 12) < 0.01, `…it is estimated like any other unpriced row (got $${noKey.toFixed(2)}, expected $6 measured + $6 modelled)`);
    ok(noKey > 1, "…so a gate comparing rolling spend against a ceiling still fires — NaN would have lost it silently");

    ok(Math.abs(withRealZero - 6) < 0.01,
      `a measured $0 no watchdog killed still counts as $0 — not every zero is missing data (got $${withRealZero.toFixed(2)})`);

    // A killed fire's receipt is a LOWER BOUND on ANY lane, not just when it reads $0. opencode SUMS its
    // per-step events (LOOP-476), so a kill truncates the sum mid-run and hands back a real, short number —
    // and opencode is the one lane where the stall watchdog is armed by default. Guarding only the $0 case
    // would have let every partial sum through as a measurement.
    const partial = rollingSpendUsd(
      [priced, { ...base, ts: t(30), durationMs: 600_000, exitCode: 126, watchdog: "budget", usage: usage(2) } as FireRow],
      86_400_000, Date.now());
    ok(Math.abs(partial - 12) < 0.01,
      `a killed fire's PARTIAL receipt ($2) does not undercut the $6 model for the same duration (got $${partial.toFixed(2)})`);

    // …and the receipt wins when it is the larger of the two: it is evidence, not a number to discard.
    const overspent = rollingSpendUsd(
      [priced, { ...base, ts: t(30), durationMs: 600_000, exitCode: 126, watchdog: "budget", usage: usage(9) } as FireRow],
      86_400_000, Date.now());
    ok(Math.abs(overspent - 15) < 0.01,
      `a killed fire that outspent the model is counted at its receipt ($9), not modelled down to $6 (got $${overspent.toFixed(2)})`);
  }

  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
