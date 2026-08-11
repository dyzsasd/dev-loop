import type { UsageAdapter, FireUsage } from "./metrics.ts";

// The runner buffers a structured lane's stdout so an adapter can parse it at exit. The buffer is capped so a
// runaway fire cannot OOM the scheduler — which means the buffer is sometimes a PREFIX of the stream rather
// than the stream, and the two must never be confused (LOOP-476 finding 2). Past the cap the tail is dropped
// silently: complete events before it still parse, so `parse()` returns an EARLY-turn value that reads exactly
// like a whole-fire measurement — and now that opencode's numbers are summed, a prefix understates by however
// much was dropped. So truncation is tracked here, beside the parse it invalidates, rather than left implicit.
export const MAX_FULL_STDOUT = 4 * 1024 * 1024; // 4 MiB

export type StdoutCapture = {
  append(chunk: string): void;
  text(): string;
  /** true once bytes were actually DROPPED — the buffer is a prefix, so nothing derived from it is a total. */
  truncated(): boolean;
};

export function makeStdoutCapture(max: number = MAX_FULL_STDOUT): StdoutCapture {
  let buf = "";
  let truncated = false;
  return {
    append(chunk: string) {
      if (truncated) return;
      const room = max - buf.length;
      // Strictly greater: a stream that ends exactly at the cap lost nothing and is a complete measurement.
      // Marking that case truncated would report "unknown" for a buffer that holds the whole fire.
      if (chunk.length > room) { buf += chunk.slice(0, room); truncated = true; return; }
      buf += chunk;
    },
    text: () => buf,
    truncated: () => truncated,
  };
}

/**
 * The usage evidence a capture supports — null when there is none, and null when the capture is TRUNCATED.
 * LOOP-476 AC3: a partial buffer is not a small measurement, it is an absent one. Downstream precedence
 * (LOOP-445) already handles unknown correctly — `budget-deadline`, never a breach — so admitting the gap
 * costs nothing, while passing the prefix on lets an early-turn number stand as the fire's total.
 */
export function usageFromCapture(adapter: UsageAdapter | null | undefined, capture: StdoutCapture): FireUsage | null {
  if (!adapter) return null;
  if (capture.truncated()) return null;
  try { return adapter.parse(capture.text()); } catch { return null; } // parse is best-effort, never throws into the runner
}

function fromUsageObj(raw: unknown): FireUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const inp = u["input_tokens"];
  const out = u["output_tokens"];
  if (typeof inp !== "number" || typeof out !== "number") return null;
  const costNum = typeof u["cost"] === "number" ? (u["cost"] as number) : null;
  return {
    source: "provider",
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: typeof u["cache_read_tokens"] === "number" ? (u["cache_read_tokens"] as number) : null,
    cacheWriteTokens: typeof u["cache_creation_tokens"] === "number" ? (u["cache_creation_tokens"] as number) : null,
    costUsd: costNum,
    currency: costNum !== null ? "USD" : null,
  };
}

// Adapter for `codex exec --json` JSONL output.
// Extracts token totals from any event carrying a `usage` object with `input_tokens`/`output_tokens`.
// Degrades to null on any shape mismatch — never a wrong row.
export const codexUsageAdapter: UsageAdapter = {
  extraArgs: ["--json"],

  parse(stdout: string): FireUsage | null {
    try {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
        // Direct usage on the event: { ..., usage: { input_tokens, output_tokens } }
        const direct = fromUsageObj(ev["usage"]);
        if (direct) return direct;
        // Nested under a response field: { response: { usage: { input_tokens, output_tokens } } }
        const inner = ev["response"] as Record<string, unknown> | undefined;
        if (inner) {
          const nested = fromUsageObj(inner["usage"]);
          if (nested) return nested;
        }
      }
    } catch { /* outer guard — parse is best-effort */ }
    return null;
  },

  isError(stdout: string): boolean {
    try {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
        if (ev["type"] === "error" || (ev["error"] !== null && ev["error"] !== undefined && typeof ev["error"] === "object")) return true;
      }
    } catch { /* outer guard */ }
    return false;
  },
};

// Adapter for `claude -p --output-format json`. Unlike codex's JSONL, this emits ONE terminal JSON object
// at fire end (a single blob, not a stream — that would be --output-format stream-json), so there is exactly
// one usage report per fire and the first/last-event question is moot. Shape (claude SDK ≥1.x):
//   { type:"result", subtype:"success"|…, is_error:bool, result:"<text>",
//     usage:{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens },
//     total_cost_usd:number }
// Degrades to null on any shape mismatch — never a wrong row.
export const claudeAdapter: UsageAdapter = {
  extraArgs: ["--output-format", "json"],

  parse(stdout: string): FireUsage | null {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(stdout.trim()) as Record<string, unknown>; } catch { return null; }
    if (!obj || typeof obj !== "object") return null;
    const u = fromClaudeUsage(obj["usage"]);
    if (!u) return null;
    const costNum = typeof obj["total_cost_usd"] === "number" ? (obj["total_cost_usd"] as number) : null;
    return { ...u, costUsd: costNum, currency: costNum !== null ? "USD" : null };
  },

  isError(stdout: string): boolean {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      if (!obj || typeof obj !== "object") return false;
      if (obj["is_error"] === true) return true;
      if (typeof obj["subtype"] === "string" && obj["subtype"] !== "success") return true;
      return false;
    } catch { return false; } // non-JSON / truncated buffer — the runAgent tail-regex arm already covers it
  },

  resultText(stdout: string): string | null {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      return typeof obj?.["result"] === "string" ? (obj["result"] as string) : null;
    } catch { return null; }
  },

  // LOOP-318 AC1 — claude reports it directly as `num_turns` on the result event.
  turns(stdout: string): number | null {
    try {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
        const n = ev["num_turns"];
        if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.trunc(n);
      }
    } catch { /* best-effort */ }
    return null; // AC3: unrecoverable ⇒ null, never 0
  },
};

// claude's usage object → the numeric FireUsage core (cost/currency layered on by the caller). Distinct from
// codex's fromUsageObj: claude names cache fields *_input_tokens and carries cost as top-level total_cost_usd.
function fromClaudeUsage(raw: unknown): Omit<FireUsage, "costUsd" | "currency"> | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const inp = u["input_tokens"];
  const out = u["output_tokens"];
  if (typeof inp !== "number" || typeof out !== "number") return null;
  return {
    source: "provider",
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: typeof u["cache_read_input_tokens"] === "number" ? (u["cache_read_input_tokens"] as number) : null,
    cacheWriteTokens: typeof u["cache_creation_input_tokens"] === "number" ? (u["cache_creation_input_tokens"] as number) : null,
  };
}

// opencode's `tokens` object → the numeric FireUsage core. opencode nests cache under tokens.cache.{read,write}
// (distinct from claude's *_input_tokens and codex's flat usage.{input,output}_tokens) and carries cost as a
// sibling `cost` field on the same event, so the caller passes both in. input+output must both be numbers or
// this is not a usage-bearing event → null (an event with `tokens:{}` records NO usage, never a zero-filled row).
function fromOpencodeTokens(tokensRaw: unknown, costRaw: unknown): FireUsage | null {
  if (!tokensRaw || typeof tokensRaw !== "object") return null;
  const t = tokensRaw as Record<string, unknown>;
  const inp = t["input"];
  const out = t["output"];
  if (typeof inp !== "number" || typeof out !== "number") return null;
  const cache = t["cache"] && typeof t["cache"] === "object" ? (t["cache"] as Record<string, unknown>) : undefined;
  const costUsd = typeof costRaw === "number" ? (costRaw as number) : null;
  return {
    source: "provider",
    inputTokens: inp,
    outputTokens: out,
    cacheReadTokens: typeof cache?.["read"] === "number" ? (cache["read"] as number) : null,
    cacheWriteTokens: typeof cache?.["write"] === "number" ? (cache["write"] as number) : null,
    costUsd,
    currency: costUsd !== null ? "USD" : null,
  };
}

// Adapter for `opencode run --format json` (raw JSON events, JSONL — one object per line). Verified against a
// real opencode 1.2.24 run: the usage-bearing event is `step_finish`, and its numbers live NESTED under `part`
// — `{ type:"step_finish", part:{ type:"step-finish", tokens:{input,output,cache:{read,write}, total, reasoning},
// cost } }` — NOT at the top level the hand-written LOOP-14 fixture assumed (reading `ev.tokens` returned null on
// real output). We read `ev.part.tokens`/`ev.part.cost`, falling back to a top-level `ev.tokens`/`ev.cost` so a
// version that flattens the shape still parses. Every other line (step_start, text, tool parts) is scanned past.
// Unlike claude (one terminal blob) opencode STREAMS its events live, so this adapter deliberately has NO
// resultText — deferEcho stays false and the raw JSONL is echoed to console + run.log as it arrives (mirroring
// the codex lane). Degrades to null on any shape mismatch — never a wrong row.
export const opencodeAdapter: UsageAdapter = {
  extraArgs: ["--format", "json"],

  parse(stdout: string): FireUsage | null {
    // SUM every `step_finish`, because opencode's per-event numbers are PER-TURN — measured, not assumed
    // (LOOP-476 AC1, which existed because the note here used to read "unverified — single-step sample only").
    //
    // Measurement, 2026-08-11, over the real `--format json` streams this workspace's own opencode fires left
    // in `.dev-loop/*/runner-logs/*.log` (junior-dev + qa, opencode 1.2.24, deepseek-v4-flash). Two independent
    // facts, either of which alone settles it:
    //   · cost DECREASES between consecutive steps within one fire — 8 of 17 consecutive pairs on an 18-step
    //     fire, 92 of 197 on a 198-step one. A cumulative counter cannot decrease.
    //   · `tokens.input` falls from 36822 on step 0 to 1439 on step 1 as the prefix moves into `cache.read`
    //     (0 → 36608). Each event reports THAT turn's input, not a running total.
    // So last-match reported one turn as the fire: on the 19-step fixture beside this file it records
    // $0.003178756 of a real $0.140456736 (2.3%), and on the 198-step fire $0.0076 of $1.1466 (0.67%).
    //
    // Summing is therefore the exact total, not an estimate. Absent fields stay ABSENT rather than becoming
    // zero: a fire whose events carry no `cost` at all reports costUsd null (an honest miss), never $0.00 —
    // the distinction between "measured nothing" and "did not measure" that LOOP-445 rests on. Every other
    // line (step_start, text, tool parts) is scanned past, and a shape mismatch still degrades to null.
    let steps = 0;
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, costTotal = 0;
    let costSeen = false, cacheReadSeen = false, cacheWriteSeen = false;
    try {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
        const part = ev["part"] && typeof ev["part"] === "object" ? (ev["part"] as Record<string, unknown>) : undefined;
        const tokens = part?.["tokens"] ?? ev["tokens"];
        const cost = part?.["cost"] ?? ev["cost"];
        const u = fromOpencodeTokens(tokens, cost);
        if (!u) continue;
        steps++;
        input += u.inputTokens ?? 0;
        output += u.outputTokens ?? 0;
        if (u.cacheReadTokens !== null) { cacheRead += u.cacheReadTokens; cacheReadSeen = true; }
        if (u.cacheWriteTokens !== null) { cacheWrite += u.cacheWriteTokens; cacheWriteSeen = true; }
        if (u.costUsd !== null) { costTotal += u.costUsd; costSeen = true; }
      }
    } catch { /* outer guard — parse is best-effort, never throws into the runner */ }
    if (steps === 0) return null; // no usage-bearing event — an honest miss, not a zero-filled row
    // A bucket no event ever reported stays null (unknown); one that reported is the sum across the fire.
    return {
      source: "provider",
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheReadSeen ? cacheRead : null,
      cacheWriteTokens: cacheWriteSeen ? cacheWrite : null,
      costUsd: costSeen ? costTotal : null,
      currency: costSeen ? "USD" : null,
    };
  },

  isError(stdout: string): boolean {
    // Structured failure signal ONLY (an exit-0 fire whose stream carries a `type:"error"` event). The
    // bare-text cases — a fire that dies printing "Execution error", or emits nothing — are NOT this
    // adapter's job: run-agents' tail-regex/empty arm catches them additively (the "keep the tail-regex as
    // the fallback" contract). So isError("Execution error") and isError("") are FALSE by design, not a gap.
    try {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
        if (ev["type"] === "error") return true;
      }
    } catch { /* outer guard */ }
    return false;
  },

  // LOOP-318 AC2 — opencode has no num_turns; it emits one `step_finish` PER model turn, which the
  // parse() walk above already relies on. Counting those events reuses the same walk shape rather
  // than parsing the result a second time.
  turns(stdout: string): number | null {
    let n = 0;
    try {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
        const part = ev["part"] && typeof ev["part"] === "object" ? (ev["part"] as Record<string, unknown>) : undefined;
        // Match on either spelling, exactly as parse() tolerates both: the event type on the envelope
        // and the `type` on the nested part disagree between opencode versions.
        if (ev["type"] === "step_finish" || part?.["type"] === "step-finish") n++;
      }
    } catch { /* best-effort */ }
    return n > 0 ? n : null; // AC3: nothing recoverable ⇒ null, never 0
  },
};

// Resolve the usage adapter for a coding agent. null for text-mode lanes without a structured-output flag —
// they keep the tail-regex health signal and honestly record usage:null.
export function resolveAdapter(codingAgent: string): UsageAdapter | null {
  if (codingAgent === "codex") return codexUsageAdapter;
  if (codingAgent === "claude") return claudeAdapter;
  if (codingAgent === "opencode") return opencodeAdapter;
  return null;
}
