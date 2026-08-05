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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The hostname from a bare bind address OR a Host-header authority.
 *
 *   [::1]:8789 → ::1 · [::1] → ::1 · 127.0.0.1:8789 → 127.0.0.1 · ::1 → ::1 · localhost → localhost
 *
 * After `]` only end-of-string or `:<port>` is accepted. `[::1]evil.com` is returned VERBATIM, so it
 * fails the set lookup and is rejected. That case is not reachable from a browser — `new URL(
 * "http://[::1]evil.com/")` throws, so no browser can put it in a Host header — but a loopback
 * predicate that tolerates a trailing-garbage suffix is exactly the shape that becomes a hole the
 * moment its next consumer feeds it a string from somewhere other than a Host header. Closed at the
 * source rather than at each call site.
 */
export function hostnameOf(host: string): string {
  if (host.startsWith("[")) {
    const e = host.indexOf("]");
    if (e === -1) return host;                             // unterminated bracket → verbatim → rejected
    const rest = host.slice(e + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return host;  // "[::1]evil.com" → verbatim → rejected
    return host.slice(1, e);
  }
  // A bare IPv6 literal has >1 colon and carries no port (a bracket is required to add one), so the
  // only colon-splitting case is host:port. Splitting a bare "::1" on ":" would yield "" and reject
  // the very address this widens for.
  const colons = (host.match(/:/g) ?? []).length;
  return colons === 1 ? host.slice(0, host.indexOf(":")) : host;
}

/**
 * The ONE loopback predicate (LOOP-172 / LOOP-289).
 *
 * `daemon.ts` used to decide this twice, with two regexes that DISAGREED on IPv6 loopback: the boot
 * gate accepted `::1`, the write guard did not. A `DEVLOOP_DAEMON_HOST=::1` bind therefore booted
 * token-less AND 403'd every write — each half individually defensible, the pair unusable.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(hostnameOf(host));
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

// A URL reaches this diagnostic straight from WHATWG parsing, which permits shell metacharacters in
// both the host (`http://evil;id` ⇒ host `evil;id`) and the path (`/dev;id`, `/dev$(id)`, backticks) —
// so every COPYABLE fragment below (the ssh destination, and each `--attach`/TLS URL) is single-quoted
// as a unit, or a copy-paste would execute the suffix (codex P2). POSIX single-quote: wrap, and
// close/escape/reopen for any embedded quote.
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
  // ssh destination: an IPv6 literal keeps its URL brackets in base.hostname (`[2001:db8::1]`), which a
  // URL needs but OpenSSH does not — it reads a bracketed operand literally and fails to resolve, while
  // the bare `2001:db8::1` is accepted (codex P2). Strip the brackets, then quote.
  const sshHost = shellSingleQuote(base.hostname.replace(/^\[|\]$/g, ""));
  // The two attach URLs are copyable `--attach <url>` fragments, so each is quoted WHOLE: host AND the
  // preserved reverse-proxy path can carry shell metacharacters, and an IPv6 URL's `[]` are shell globs
  // (codex P2). base.host keeps IPv6 brackets here — correct for a URL, and the quoting neutralizes them.
  const tlsUrl = shellSingleQuote(`https://${base.host}${basePath}`);
  const loopbackUrl = shellSingleQuote(`http://127.0.0.1:${localPort}${basePath}`);
  return (
    `refusing to send the hub bearer token in cleartext to non-loopback host '${base.hostname}' over http — ` +
    `it is full write authority over the board (tickets, comments, docs) and rides every op call, so one ` +
    `on-path capture is a durable compromise. Attach over TLS (${tlsUrl}), or tunnel to loopback ` +
    `(ssh -L ${localPort}:localhost:${remotePort} ${sshHost} — then --attach ${loopbackUrl}). ` +
    `To allow plaintext on a trusted private link, set DEVLOOP_ATTACH_ALLOW_PLAINTEXT=1.`
  );
}
