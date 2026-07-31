import type { UsageAdapter, FireUsage } from "./metrics.ts";

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
    // Take the LAST usage-bearing event, not the first: opencode emits one `step_finish` PER model turn, each
    // carrying that step's tokens/cost, so first-match records only the opening turn as the fire total — a
    // plausible-but-partial wrong row (PM constraint from the LOOP-15 verify). Last-match is exact for a
    // single-step fire and records the final turn's real measurement for a multi-step one; `usage:null` is an
    // honest miss. (Whether a multi-step fire's last step_finish is cumulative is unverified — single-step
    // sample only; summing is a follow-up if a real multi-step sample shows it's needed — see the hand-off.)
    let last: FireUsage | null = null;
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
        if (u) last = u;
      }
    } catch { /* outer guard — parse is best-effort, never throws into the runner */ }
    return last;
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
};

// Resolve the usage adapter for a coding agent. null for text-mode lanes without a structured-output flag —
// they keep the tail-regex health signal and honestly record usage:null.
export function resolveAdapter(codingAgent: string): UsageAdapter | null {
  if (codingAgent === "codex") return codexUsageAdapter;
  if (codingAgent === "claude") return claudeAdapter;
  if (codingAgent === "opencode") return opencodeAdapter;
  return null;
}
