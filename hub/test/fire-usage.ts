// LOOP-115 — `codexUsageAdapter.isError` shipped with NO test file at all.
//
// It is the codex lane's fire-error detector, called from run-agents on every structured-lane fire,
// and its position at the top of the CRAP ratchet was purely the absence of a test: a completely
// untested CC-9 function scores exactly CC² · (1−cov)³ + CC = 81 + 9 = 90.0 against a threshold of
// 90, so `90.0 > 90` is false and main passed the required merge check by a margin of exactly 0.0.
// One added branch anywhere in that function would have red-lined every PR in the repo — an outage
// that has already happened once (LOOP-22 / LOOP-24).
//
// So this file is not busywork: it converts the repo's merge margin from luck into headroom, and it
// exercises a detector that decides whether a fire is recorded as a success.
import { codexUsageAdapter, claudeAdapter, opencodeAdapter } from "../src/fire-usage.ts";
import { fireMetrics } from "../src/metrics.ts"; // LOOP-318: the aggregation half
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── isError: the two positive shapes ───────────────────────────────────────────────────────────
ok(codexUsageAdapter.isError!('{"type":"error","message":"boom"}'), "isError: an event with type:'error'");
ok(codexUsageAdapter.isError!('{"type":"item","error":{"code":"x"}}'), "isError: an event carrying an error OBJECT");
ok(codexUsageAdapter.isError!('{"type":"item"}\n{"type":"error"}\n'), "isError: scans every line, not just the first");
ok(codexUsageAdapter.isError!('\n\n  {"type":"error"}  \n'), "isError: blank lines and surrounding whitespace are tolerated");

// ── isError: the negatives, which are where a false positive would cost a real fire ───────────
ok(!codexUsageAdapter.isError!(""), "isError: empty output is not an error");
ok(!codexUsageAdapter.isError!('{"type":"item","text":"all good"}'), "isError: an ordinary event is not an error");
ok(!codexUsageAdapter.isError!("not json at all\nstill not json"), "isError: unparseable lines are SKIPPED, never treated as errors");
ok(!codexUsageAdapter.isError!('{"type":"item","error":null}'), "isError: error:null is explicitly NOT an error (the honest-null shape)");
ok(!codexUsageAdapter.isError!('{"type":"item","error":"a string"}'), "isError: a non-object error field does not trip it — only an object does");
ok(!codexUsageAdapter.isError!('{"type":"result","subtype":"success"}'), "isError: a success result is not an error");
// The mixed case matters most: a fire that ECHOES the word error mid-run must not be failed for it.
ok(!codexUsageAdapter.isError!('{"type":"item","text":"the build printed: error: missing semicolon"}'),
  "isError: an error string INSIDE an ordinary event's text is not a fire error");

// ── parse: the usage shapes it is paired with ─────────────────────────────────────────────────
{
  const direct = codexUsageAdapter.parse('{"usage":{"input_tokens":10,"output_tokens":5}}');
  ok(direct !== null && direct.inputTokens === 10 && direct.outputTokens === 5, "parse: usage directly on the event");
  const nested = codexUsageAdapter.parse('{"response":{"usage":{"input_tokens":7,"output_tokens":3}}}');
  ok(nested !== null && nested.inputTokens === 7, "parse: usage nested under `response`");
  ok(codexUsageAdapter.parse("garbage") === null, "parse: unparseable output degrades to null, never a wrong row");
  ok(codexUsageAdapter.parse('{"type":"item"}') === null, "parse: an event with no usage yields null");
}

// ── the sibling adapters' honest-null contract (the invariant LOOP-268 depends on) ────────────
{
  const c = claudeAdapter.parse(JSON.stringify({
    type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
    total_cost_usd: 0.5,
  }));
  ok(c !== null && c.inputTokens === 1 && c.cacheReadTokens === 4 && c.costUsd === 0.5, "claudeAdapter: the terminal blob parses");
  ok(claudeAdapter.parse("{not json") === null, "claudeAdapter: a shape mismatch degrades to null");
  // Every adapter must emit an EXPLICIT null rather than omitting a key — the contract sumNull relies on.
  for (const [name, cell] of [["claude", c]] as const) {
    if (!cell) continue;
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "currency"] as const)
      ok(k in cell, `${name}Adapter: '${k}' is present as an explicit key (never absent — LOOP-268's contract)`);
  }
  ok(typeof opencodeAdapter.parse === "function", "opencodeAdapter exposes a parse (lane coverage)");
}

// ── LOOP-318: turns are recorded, and null NEVER becomes 0 ───────────────────────────────────────
// Turns were recorded nowhere: the ledger kept only the digested usage block, so LOOP-228's own cost
// decomposition rested on an estimated n that no instrument could resolve — and no already-run fire
// can be back-filled, so the distinction has to be captured as it happens.
{
  // AC1 — claude reports it directly.
  const claudeOut = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", num_turns: 7, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.1 }),
  ].join("\n");
  ok(claudeAdapter.turns?.(claudeOut) === 7, `LOOP-318 AC1: the claude lane reads num_turns (got ${claudeAdapter.turns?.(claudeOut)})`);

  // AC2 — opencode has no num_turns; it emits one step_finish PER model turn.
  const ocOut = [
    JSON.stringify({ type: "step_start" }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } }, cost: 0.01 } }),
    JSON.stringify({ type: "text", part: { type: "text" } }),
    JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 2, output: 2, cache: { read: 0, write: 0 } }, cost: 0.02 } }),
  ].join("\n");
  ok(opencodeAdapter.turns?.(ocOut) === 2, `LOOP-318 AC2: the opencode lane counts step_finish events (got ${opencodeAdapter.turns?.(ocOut)})`);
  ok(opencodeAdapter.parse(ocOut) !== null,
    "LOOP-318 AC2: …reusing the SAME walk shape parse() relies on — no second JSON parse of the result");

  // AC3 — unrecoverable ⇒ null, NEVER 0. A fire that ran took at least one turn, so a zero would be
  // a measurement claiming something false rather than admitting it does not know.
  for (const [label, out] of [["empty", ""], ["no counts", JSON.stringify({ type: "result" })], ["garbage", "not json at all"]] as const) {
    ok(claudeAdapter.turns?.(out) === null, `LOOP-318 AC3: claude ${label} ⇒ null, not 0`);
    ok(opencodeAdapter.turns?.(out) === null, `LOOP-318 AC3: opencode ${label} ⇒ null, not 0`);
  }
  ok(claudeAdapter.turns?.(JSON.stringify({ num_turns: 0 })) === null,
    "LOOP-318 AC3: an explicit num_turns of 0 is treated as unrecoverable — a fire that ran took at least one turn");

  // AC4/AC5 — the aggregation. Mixed rows: the mean is over the non-null subset ONLY, and the
  // covered count rides alongside so a partially-instrumented window cannot read as a complete one.
  {
    const now = Date.now();
    const at = (m: number) => new Date(now - m * 60_000).toISOString();
    const rows = [
      { ts: at(5), agent: "pm", project: "p", durationMs: 1000, exitCode: 0, turns: 4 },
      { ts: at(4), agent: "pm", project: "p", durationMs: 1000, exitCode: 0, turns: 6 },
      { ts: at(3), agent: "pm", project: "p", durationMs: 1000, exitCode: 0, turns: null },
      { ts: at(2), agent: "pm", project: "p", durationMs: 1000, exitCode: 0 },              // field absent entirely
      { ts: at(1), agent: "qa", project: "p", durationMs: 1000, exitCode: 0, turns: null },
    ];
    // fireMetrics reads a LEDGER PATH, not rows — the whole point is that it parses what a fire wrote.
    const ledger = join(mkdtempSync(join(tmpdir(), "dl-turns-")), "fires.jsonl");
    writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const m2 = fireMetrics(ledger, 3_600_000, now);
    ok(m2.byAgent.pm.turnsPerFire === 5, `LOOP-318 AC4/AC5: the mean is over the NON-NULL subset only ((4+6)/2 = 5, got ${m2.byAgent.pm.turnsPerFire})`);
    ok(m2.byAgent.pm.turnsCoveredFires === 2,
      `LOOP-318 AC4: …and the covered count is reported beside it (got ${m2.byAgent.pm.turnsCoveredFires} of ${m2.byAgent.pm.fires} fires)`);
    ok(m2.byAgent.pm.fires === 4, "LOOP-318 AC4: …over the SAME row set as every other per-agent field");
    ok(m2.byAgent.qa.turnsPerFire === null,
      "LOOP-318 AC5: an ALL-NULL agent reports NO mean rather than 0 — the LOOP-268 null contract survives the aggregation hop");
    ok(m2.byAgent.qa.turnsCoveredFires === 0, "LOOP-318 AC5: …with a covered count of 0, so the absence is legible");
  }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nFIRE_USAGE_OK");
process.exit(fails ? 1 : 0);
