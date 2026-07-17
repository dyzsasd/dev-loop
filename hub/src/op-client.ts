// dev-loop hub — the ONE loopback op-API HTTP client (A1: extracted from shim.ts so the CLI write layer,
// cli-agentops.ts, and the stdio shim share the POST /api/op/<op> transport instead of each duplicating the
// ~45 lines of runfile/port resolution + request/timeout/outcome classification). THIN-CLIENT BOUNDARY: like
// tooldefs.ts this is a LEAF — it imports only paths.ts (for the runfile dir); it must NEVER import
// agentops.ts / the SoR (that would drag the system of record into the thin shim's graph).
//
// Behavior is byte-identical to the pre-extraction shim: DEVLOOP_HUB_PORT wins over the DL-41 lifecycle
// runfile; the port is re-read PER CALL (the daemon can restart on a new port mid-session — a cached port
// would go stale → false ECONNREFUSED); the 30s timeout kills a silent hang; and the caller gets a
// three-way discriminated outcome — a genuine op {status,body}, the DORMANT-mount 404, or a dead/absent
// daemon — so each client renders its own surface (the shim → MCP err() prose; the CLI → exit 5).
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hubDbPath } from "./paths.ts";
import { resolveUiToken } from "./ui-token.ts"; // leaf→leaf: the §6.2 bearer rides every op call when configured

// ─── DL-41 lifecycle runfile path (REPLICATES daemon.ts lcDbPath/lcRunDir/lcRunfile) ────────────────────────
// A thin client must NOT import the 92KB daemon, so the stable runfile path convention is re-derived here —
// this comment is the drift tripwire against daemon.ts. runDir = DEVLOOP_RUN_DIR ?? dirname(hubDbPath());
// file = daemon-<key>.json. (Moved verbatim from shim.ts:43-45, which now imports it.)
export function opRunfilePath(projectKey: string): string {
  const runDir = process.env.DEVLOOP_RUN_DIR ?? dirname(hubDbPath());
  return join(runDir, `daemon-${projectKey}.json`);
}

// Resolve the daemon's loopback port WITHOUT hardcoding 8787 (folded critique #89): an explicit
// DEVLOOP_HUB_PORT override wins (a foreground `npm run daemon` writes NO runfile; tests inject the
// in-process port), else the DL-41 lifecycle runfile's recorded port. null ⇒ neither is available
// (→ each caller's clear "daemon down" surface). Re-read per call ON PURPOSE (not memoized) — see above.
export function resolveOpPort(projectKey: string): number | null {
  const envPort = process.env.DEVLOOP_HUB_PORT?.trim();
  if (envPort) { const n = Number(envPort); if (Number.isInteger(n) && n > 0 && n < 65536) return n; }
  try {
    const info = JSON.parse(readFileSync(opRunfilePath(projectKey), "utf8")) as { port?: unknown };
    // same 0<port<65536 bound as the env override: a corrupt runfile port (e.g. 70000) must resolve to null
    // (→ the caller's clear daemon-down surface), never make http.request throw synchronously (codex #4).
    if (typeof info.port === "number" && Number.isInteger(info.port) && info.port > 0 && info.port < 65536) return info.port;
  } catch { /* no/garbled runfile → the daemon was not lifecycle-started here */ }
  return null;
}

// The three ways a loopback op call can land, discriminated so BOTH clients keep their exact pre-extraction
// behavior: "result" = a genuine daemon answer (2xx success OR an op-level 400/403/404/409/500 to forward
// verbatim, body already JSON-parsed — null when the body was empty/non-JSON); "dormant" = the mount answers
// every /api/op/* with 404 {error:"not found: …"} (daemon.ts:759) — the project has not opted in via
// settings_json.hub.transport="daemon"; "down" = no HTTP response at all (ECONNREFUSED / timeout / DNS-level
// error), `detail` carrying the same parenthesized why-string the shim always rendered.
export type OpHttpOutcome =
  | { kind: "result"; status: number; body: unknown }
  | { kind: "dormant" }
  | { kind: "down"; detail: string };

// One-click P2 (§6.0 attach): the op target is either the machine-local loopback daemon (default —
// DEVLOOP_HUB_PORT / the DL-41 runfile, exactly the pre-attach behavior) or a REMOTE hub named by
// DEVLOOP_HUB_URL (http(s)://host:port). Re-read per call, like the port (a profile/env change must not
// need a process restart). A garbled URL resolves to null → the caller's clear "daemon down" surface.
export function resolveOpBase(projectKey: string): URL | null {
  const raw = process.env.DEVLOOP_HUB_URL?.trim();
  if (raw) {
    try { const u = new URL(raw); if (u.protocol === "http:" || u.protocol === "https:") return u; } catch { /* fall through */ }
    return null;
  }
  const port = resolveOpPort(projectKey);
  return port === null ? null : new URL(`http://127.0.0.1:${port}`);
}

// POST <base>/api/op/<op> with X-Devloop-Actor (identity env→header, design Decision #2/#5 — the only
// attribution the daemon trusts) + the §6.2 bearer when a token is configured (a tokened daemon 401s
// without it; a token-less loopback daemon ignores the header). Default base stays 127.0.0.1 (§16);
// a non-loopback base is the ATTACH posture and only ever works against a tokened daemon.
export function postOpUrl(base: URL, op: string, args: Record<string, unknown>, actor: string): Promise<OpHttpOutcome> {
  const body = JSON.stringify(args ?? {});
  const token = resolveUiToken();
  return new Promise<OpHttpOutcome>((resolve) => {
    let settled = false;
    const finish = (r: OpHttpOutcome) => { if (!settled) { settled = true; resolve(r); } };
    const req = (base.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: base.hostname, port: base.port || (base.protocol === "https:" ? 443 : 80), method: "POST",
        path: `${base.pathname.replace(/\/$/, "")}/api/op/${op}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-devloop-actor": actor,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let d = ""; res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let parsed: unknown = null;
          try { parsed = d ? JSON.parse(d) : null; } catch { /* non-JSON body (a bare daemon error) */ }
          const emsg = typeof (parsed as { error?: unknown })?.error === "string" ? (parsed as { error: string }).error : "";
          // A dormant mount answers EVERY /api/op/* with 404 {error:"not found: …"} (daemon.ts:759),
          // distinct from a genuine op-level 404 ({error:"no such ticket …"}) which is a real result to forward.
          if (status === 404 && (parsed === null || /^not found:/.test(emsg))) { finish({ kind: "dormant" }); return; }
          finish({ kind: "result", status, body: parsed });
        });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      const why = e.code === "ECONNREFUSED" ? " (connection refused — a stale runfile / a daemon that died?)"
        : e.message === "timeout" ? " (no response within 30s — the daemon hung?)"
        : ` (${e.code ?? e.message})`;
      finish({ kind: "down", detail: why });
    });
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); }); // never a silent hang
    req.end(body);
  });
}

// Back-compat wrapper: the pre-attach signature (loopback port). Existing callers (shim, cli-agentops)
// keep working unchanged; new callers route through resolveOpBase → postOpUrl.
export function postOp(port: number, op: string, args: Record<string, unknown>, actor: string): Promise<OpHttpOutcome> {
  return postOpUrl(new URL(`http://127.0.0.1:${port}`), op, args, actor);
}
