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

// One-click §6.0 ATTACH egress guard (LOOP-173). The §6.2 bearer is the SOLE credential for a remote
// hub's entire write surface and rides EVERY op call; on a plaintext wire to a non-loopback host, one
// on-path capture is a durable board compromise. This is the single decision BOTH the entry point
// (up.ts) and the egress (op-client.ts postOpUrl) consult, so they can never diverge. Each exemption
// has a real reason: no token ⇒ nothing to leak; https ⇒ encrypted; loopback http ⇒ the supported
// `ssh -L` tunnel posture (reuses isLoopbackHost — the ONE loopback predicate, LOOP-172, not a third);
// an explicit DEVLOOP_ATTACH_ALLOW_PLAINTEXT=1 opt-in escapes for a trusted private link. Default: refuse.
export function plaintextBearerToRemote(base: URL, hasToken: boolean): boolean {
  if (!hasToken) return false;                                            // nothing to leak
  if (base.protocol === "https:") return false;                          // https carries it safely
  if (isLoopbackHost(base.hostname)) return false;                       // loopback (tunnel) http is fine
  if (process.env.DEVLOOP_ATTACH_ALLOW_PLAINTEXT?.trim() === "1") return false; // explicit opt-in
  return true;
}

// A hostname reaches this diagnostic straight from a WHATWG URL, which permits shell metacharacters
// (`http://evil;id` parses to hostname `evil;id`, and `$()`/backticks survive too) — so the ssh remedy,
// the one COPYABLE shell command here, single-quotes the host, or a copy-paste would execute the suffix
// (codex P2). POSIX single-quote: wrap, and close/escape/reopen for any embedded quote.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The refusal diagnostic — names the real risk and BOTH remedies (AC4); NEVER the token value (§16).
export function plaintextBearerRefusal(base: URL): string {
  // The tunnel's REMOTE port must be the one the client will ACTUALLY hit — the URL's effective port,
  // which is 80 when http omits it. A hardcoded `ssh -L 8787:localhost:8787` would forward to a port
  // the hub is not on for `--attach http://hub.example` (codex P2). Keep the LOCAL port convenient (the
  // hub's own 8787 default); derive only the remote end. base.port is "" when omitted OR when it equals
  // the scheme default, so `|| …` supplies the right fallback either way.
  const remotePort = base.port || "80";
  const localPort = base.port || "8787";
  // A reverse-proxy path prefix must survive into the remedies: postOpUrl targets
  // `${base.pathname}/api/op/...`, so a hub served under `/dev-loop` is reached at `/dev-loop/api/op/...`
  // and a remedy that drops the prefix points at the wrong path (codex P2). Same trailing-slash strip as
  // postOpUrl, so a bare host (pathname "/") collapses to "" and gains no spurious slash.
  const basePath = base.pathname.replace(/\/$/, "");
  return (
    `refusing to send the hub bearer token in cleartext to non-loopback host '${base.hostname}' over http — ` +
    `it is full write authority over the board (tickets, comments, docs) and rides every op call, so one ` +
    `on-path capture is a durable compromise. Attach over TLS (https://${base.host}${basePath}), or tunnel to loopback ` +
    `(ssh -L ${localPort}:localhost:${remotePort} ${shellSingleQuote(base.hostname)} — then --attach http://127.0.0.1:${localPort}${basePath}). ` +
    `To allow plaintext on a trusted private link, set DEVLOOP_ATTACH_ALLOW_PLAINTEXT=1.`
  );
}
