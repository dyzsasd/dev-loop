// budget-ceiling.ts — LOOP-229 (Child 3 of LOOP-197): the pre-launch dailyUsd gate + budget breaker + the
// three observability surfaces (run.log / doctor / metrics), and the load-bearing INV-1 byte-identical-when-
// unset guarantee. Drives real `run-agents --once` fires (a fake CLI bin) against a seeded fires.jsonl ledger,
// exactly like team-scheduler.ts, so the gate is exercised end-to-end (the scheduler cannot be imported —
// run-agents' main() is unconditional). Run from a /tmp copy, never inside the live workspace (the
// hub-tests-shadowed-inside-workspace lesson — a scheduler test spawned inside the live workspace false-fails).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-budget-")));
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

  // ── doctor UNSET nag: no ceiling + measured spend ⇒ exactly ONE [W28] nag, and DOCTOR_OK still holds ──
  seed(costRow(50)); // some measured spend so there IS a burn rate to name
  const docUnset = await doctorRun(ws);
  const w28unset = (docUnset.out.match(/\[W28\]/g) ?? []).length;
  ok(w28unset === 1, `doctor: exactly ONE [W28] line when the ceiling is unset (got ${w28unset})`);
  ok(/no daily budget ceiling/.test(docUnset.out), "doctor: the unset nag names the missing ceiling + the measured burn rate");
  ok(docUnset.ok === true, "doctor: DOCTOR_OK (ok===true) holds — the unset nag is warn-only (the AC)");
  ok(!docUnset.out.includes("❌"), "doctor: no ❌ failures from the budget nag");
  // metrics --cost is UNCHANGED when the ceiling is unset (no budget line) — the read-surface half of INV-1.
  ok(!/budget: rolling 24h/.test(metricsCost(ws)), "metrics --cost: no budget line when the ceiling is unset (byte-identical surface)");

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
  ok(/\[W28\]/.test(docOver.out) && /budget BREACH/.test(docOver.out), "AC3 surface 2 (doctor): the [W28] budget BREACH line");
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
  writeFileSync(sleeperBin, "#!/bin/sh\necho 'fire started'\nsleep 60\necho 'fire finished'\n"); chmodSync(sleeperBin, 0o755);
  const t0 = Date.now();
  const killed = runAgents(["--agents", "pm", "--once"], ws, { DEVLOOP_CLAUDE_BIN: sleeperBin });
  const elapsedMs = Date.now() - t0;
  const killRow = lastRow();
  ok(elapsedMs < 30_000, `AC4: the 60s fire was terminated early (~2s deadline; took ${Math.round(elapsedMs / 1000)}s)`);
  ok(/budget perFireUsd \$0\.002/.test(killed.out),
    "AC4: the kill reason names the perFireUsd ceiling (a sub-cent ceiling is NOT printed as $0.00)");
  ok(!/fire exceeded/.test(killed.out) && !/looks WEDGED/.test(killed.out),
    "AC4: the reason is DISTINCT — neither the wall-timeout ('fire exceeded') nor the stall wording");
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
    writeFileSync(bin, `#!/bin/sh\nprintf '%s' '${payload}'\nsleep 60\n`); chmodSync(bin, 0o755);
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

  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
