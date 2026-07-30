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
