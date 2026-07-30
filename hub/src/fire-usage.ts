import type { FireUsage, UsageAdapter } from "./metrics.ts";

// Defensive cap: claude --output-format json emits one terminal JSON object; in practice
// it's small, but we cap the accumulation buffer so a runaway pipe never OOMs the scheduler.
export const MAX_FULL_STDOUT_BYTES = 4 * 1024 * 1024; // 4 MiB

// Claude `--output-format json` adapter.
// The terminal object shape (claude SDK ≥1.x):
//   { type:"result", subtype:"success"|..., is_error:bool, result:"<text>",
//     usage:{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens },
//     total_cost_usd: number }
export const claudeAdapter: UsageAdapter = {
  extraArgs: ["--output-format", "json"],

  parse(stdout: string): FireUsage | null {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      if (typeof obj !== "object" || obj === null) return null;
      const u = obj.usage as Record<string, unknown> | undefined;
      if (typeof u !== "object" || u === null) return null;
      const costUsd = typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null;
      return {
        source: "provider",
        inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
        cacheWriteTokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : null,
        cacheReadTokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : null,
        costUsd,
        currency: costUsd !== null ? "USD" : null,
      };
    } catch {
      return null; // any shape mismatch or parse error → null (best-effort, non-fatal)
    }
  },

  isError(stdout: string): boolean {
    try {
      const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
      if (typeof obj !== "object" || obj === null) return true;
      if (obj.is_error === true) return true;
      if (typeof obj.subtype === "string" && obj.subtype !== "success") return true;
      return false;
    } catch {
      // Non-JSON or truncated buffer — can't determine structured error; fall through to exit-code.
      return false;
    }
  },
};

// Select the adapter for a given coding agent. Returns null for unstructured (text-mode) lanes.
export function resolveAdapter(codingAgent: string): UsageAdapter | null {
  if (codingAgent === "claude") return claudeAdapter;
  return null;
}

// Extract the human-readable result text from a claude --output-format json terminal object.
// Returns null if the object is malformed or lacks a result field. §16: only the result TEXT
// is returned here, never the full stdout (which would carry the usage object too — parsed
// separately by claudeAdapter.parse to extract only numeric fields).
export function extractResultText(stdout: string): string | null {
  try {
    const obj = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (typeof obj?.result === "string") return obj.result;
    return null;
  } catch {
    return null;
  }
}
