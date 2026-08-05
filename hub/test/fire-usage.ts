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

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nFIRE_USAGE_OK");
process.exit(fails ? 1 : 0);
