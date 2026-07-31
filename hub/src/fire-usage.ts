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

// Resolve the usage adapter for a coding agent. null for text-mode lanes (opencode, or any lane without a
// structured-output flag) — they keep the tail-regex health signal and honestly record usage:null.
export function resolveAdapter(codingAgent: string): UsageAdapter | null {
  if (codingAgent === "codex") return codexUsageAdapter;
  if (codingAgent === "claude") return claudeAdapter;
  return null;
}
