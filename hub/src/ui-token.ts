// One-click P1 (§6.2 of docs/design/one-click-deployment.md) — the daemon UI/op-API bearer token.
// LEAF module (zero dev-loop imports) so BOTH the daemon and the thin op-client (which must never drag
// the SoR graph, op-client.ts:1-5) can share it. The token VALUE comes from DEVLOOP_UI_TOKEN (env) or
// DEVLOOP_UI_TOKEN_FILE (a mounted secret file — the container shape; trailing newline tolerated).
// §16: config never carries the value; compose/K8s mount it as a secret, the operator exports it locally.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

export function resolveUiToken(): string | null {
  const v = process.env.DEVLOOP_UI_TOKEN?.trim();
  if (v) return v;
  const f = process.env.DEVLOOP_UI_TOKEN_FILE?.trim();
  if (f) {
    try { const t = readFileSync(f, "utf8").trim(); return t || null; }
    catch { return null; } // unreadable file = no token (the daemon's fail-closed boot check surfaces it)
  }
  return null;
}

// Constant-time bearer comparison — a length mismatch short-circuits (length is not secret here;
// timingSafeEqual throws on unequal lengths, so the early return is required, not a timing leak).
export function bearerOk(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(token);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

export function isLoopbackHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(host);
}
