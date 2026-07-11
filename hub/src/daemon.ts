// dev-loop hub daemon — a persistent localhost HTTP read surface over the hub SoR (DL-1).
//
// READ-ONLY by construction: it opens the SAME node:sqlite DB the MCP server uses, sets
// `PRAGMA query_only=ON` (a structural guarantee it can never write the system of record),
// serves ONLY GET endpoints (any other method → 405), and never mutates tickets/docs/events.
// Binds 127.0.0.1 ONLY (§16) — never 0.0.0.0, no external exposure.
//
// The agents are UNCHANGED: they keep coordinating through the MCP server (`server.ts`); this is
// an additive human-facing read surface, NOT a new coordinator (strategyDoc Decisions log,
// 2026-06-23). DL-2 added a server-rendered web UI at `/` (board + ticket detail) and moved the
// JSON API index to `/api`; the `/api/*` JSON endpoints are unchanged. Write paths (roadmap edit)
// build on this later (DL-3).
//
// Zero native deps, zero build step (Node ≥23.6 type-stripping + built-in node:http/node:sqlite),
// reusing the existing `db.ts` schema with NO schema fork (hub doctrine).
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb, actorExists } from "./db.ts";
import { findProject } from "./seed.ts";
import { loadProjectsConfig } from "./resolve-project.ts";
import { hubDbPath, pkgVersion } from "./paths.ts";
import { resolveDoc, docSave, docPublish, statusForDocErr } from "./docstore.ts";
import { createTicket, addComment, moveTicket, assignTicket } from "./ticketwrite.ts";
import { agentOp, AGENT_WRITE_OPS, isAgentOp, resolveProjectOverride } from "./agentops.ts"; // DL-43: the daemon agent op-API's 5-op core (mirrors server.ts)
import { scrubErr } from "./channel.ts"; // the notifier's channel deps moved to daemon-notifiers.ts (A3); scrubErr stays for /api/health + the unhandledRejection guard
// DL-74: the HTML view layer (every page renderer + esc/toTicket/eventData) lives in daemonviews.ts; the
// per-project process-lifecycle subsystem lives in daemon-lifecycle.ts. This file keeps HTTP routing
// (createDaemon), the write-route handlers, the background timers, and the CLI dispatch + foreground boot.
import { page, esc, toTicket, boardPage, ticketPage, roadmapPage, activityPage, reportsIndexPage, reportsRoot, reportPage } from "./daemonviews.ts";
import { daemonLifecycle, LIFECYCLE_SUBS, type LifecycleSub } from "./daemon-lifecycle.ts";
import { // A3: extracted timers; imported for the foreground boot, re-exported (below) for the tests.
  blockedNotifyTick, startBlockedNotifier, noProgressNotifyTick,
  startNoProgressNotifier, walCheckpointTick, startWalCheckpoint,
} from "./daemon-notifiers.ts";

export interface DaemonOpts {
  db: DatabaseSync;          // read connection (PRAGMA query_only=ON) — every GET route reads through this
  projectId: string;
  projectKey: string;
  // DL-3 roadmap write surface (optional — absent ⇒ the daemon stays GET-only, exactly as DL-1/DL-2):
  writeDb?: DatabaseSync;    // a SEPARATE writable connection used ONLY by the /roadmap/* write routes
  actor?: string;            // the daemon's identity — attributes writes + gates publish (operator-only)
  // DL-83: the repo-file strategyDoc PATH when the hub roadmap is NOT this project's north-star (no agent
  // reads it). Set ⇒ /roadmap shows a divergence banner; absent ⇒ no banner (hub-doc/director, or unknown).
  roadmapRepoFileStrategy?: string;
}

// DL-83: does THIS project's resolved config make the hub roadmap doc its north-star, or is a repo-file
// strategyDoc the north-star? Returns the strategyDoc PATH when NO agent reads the hub roadmap doc
// (hub.docs:false/absent AND no director config AND a string strategyDoc) → the /roadmap divergence banner;
// else undefined (the hub roadmap IS the north-star — hub.docs:true or a director chairs it — or the config
// is unknown) → no banner. Pure + derived from config ONLY (never request input, §17), so it is unit-testable.
export function roadmapDivergenceDoc(proj: { hub?: { docs?: boolean }; director?: unknown; strategyDoc?: unknown } | undefined | null): string | undefined {
  if (!proj) return undefined;
  if (proj.hub?.docs === true) return undefined;   // a first-class hub doc IS the north-star
  if (proj.director != null) return undefined;      // a Director drafts/chairs the hub roadmap → north-star
  return typeof proj.strategyDoc === "string" ? proj.strategyDoc : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
}

function htmlOut(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    // Defense-in-depth (the pages interpolate escaped agent-authored DB text; CSP is the belt to esc()'s
    // braces). Inline style + the tiny inline live-updates script are allowed; connect-src 'self' lets the
    // EventSource reach /api/stream; nothing else (no remote script/img/frame). Matches the writeOriginOk posture.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'",
  });
  res.end(body);
}

// DL-41: a REAL `/api/health` liveness check — NOT a static {ok:true}. Proves the SoR is reachable (a
// trivial read) AND writable (acquire+release the RESERVED write lock without mutating), so a
// bound-but-wedged daemon (port open, but DB gone/corrupt/readonly/disk-full/closed) reads as NOT
// healthy and the lifecycle's `up`/`status` (which probe this endpoint) recover it instead of no-op'ing
// onto a dead process. A read-only daemon (no writeDb) verifies reachability only — it has no write
// surface to probe. §16-safe: no mutation persists (BEGIN IMMEDIATE → ROLLBACK), errors are scrubbed.
function healthLiveness(db: DatabaseSync, writeDb?: DatabaseSync): { ok: boolean; error?: string } {
  try {
    db.prepare("SELECT 1").get(); // read liveness: the connection + DB file are reachable & not corrupt
    if (writeDb) {
      // BEGIN IMMEDIATE takes the reserved write lock; ROLLBACK releases it — nothing persists. A
      // SQLITE_BUSY means another writer holds it ⇒ the SoR IS writable (just momentarily contended) ⇒
      // healthy; only a non-busy error (readonly fs / corrupt / disk-full / closed handle) is a real wedge.
      // Probe with busy_timeout=0 (restored after): on the normal busy_timeout=5000 connection a
      // cross-process write lock (a migration rebuild, an operator txn) stalls this synchronous exec —
      // and the whole single-threaded daemon — for up to 5s, so the lifecycle's 1s probe times out and
      // SIGTERMs a HEALTHY daemon. With 0, BUSY returns immediately and is already treated as healthy.
      try { writeDb.exec("PRAGMA busy_timeout=0"); } catch { /* probe still works, just blockingly */ }
      try { writeDb.exec("BEGIN IMMEDIATE; ROLLBACK;"); }
      catch (e) {
        try { writeDb.exec("ROLLBACK"); } catch { /* no open txn to undo */ }
        if (!/busy|locked/i.test(String((e as Error)?.message ?? e))) throw e;
      }
      finally { try { writeDb.exec("PRAGMA busy_timeout=5000"); } catch { /* connection may be wedged */ } }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: scrubErr(String((e as Error)?.message ?? e)) };
  }
}

// Defensively decode a single URL path segment. A malformed / incomplete percent-escape
// (e.g. "%", "%ZZ", an incomplete UTF-8 sequence "%E0%A4") makes decodeURIComponent throw a
// URIError — that is a CLIENT error, so callers surface 400 (matching the daemon's existing
// "bad request url" → 400 contract) instead of letting it fall through to the generic 500 catch
// (DL-7). Returns null when the segment cannot be decoded.
function decodeSeg(seg: string): string | null {
  try { return decodeURIComponent(seg); } catch { return null; }
}

// Read an application/x-www-form-urlencoded body (the roadmap edit/publish forms), bounded so a runaway
// upload can't exhaust memory. Localhost-only, but defensive anyway. Two correctness points: accumulate
// Buffers and decode ONCE at the end (a per-chunk `buf.toString()` mangles a multibyte char split across
// a TCP read boundary), and ALWAYS settle the Promise — on over-limit (reject + destroy), normal end,
// error, OR a premature 'close' (a destroyed/aborted socket emits 'close' but neither 'end' nor 'error',
// which would otherwise dangle the awaiting handler forever).
const MAX_BODY = 1_000_000; // 1 MB of body bytes — a roadmap doc is text; orders of magnitude above any real edit
// Bounded read of the full request body as bytes, settling EXACTLY ONCE on every terminal event (over-limit
// reject+destroy / normal end / error / premature 'close' — a destroyed socket emits 'close' but neither
// 'end' nor 'error', which would otherwise dangle the awaiting handler forever). The decode is the caller's
// — one read loop shared by parseFormBody (urlencoded forms) and parseJsonBody (the DL-43 op-API).
function readBodyBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0, settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    req.on("data", (c: Buffer) => {
      len += c.length;
      if (len > MAX_BODY) { settle(() => reject(new Error("request body too large"))); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks)))); // decode ONCE at the end (a per-chunk toString mangles a multibyte char split across a TCP read)
    req.on("error", (e) => settle(() => reject(e)));
    req.on("close", () => settle(() => reject(new Error("request closed before it completed"))));
  });
}
const parseFormBody = (req: IncomingMessage): Promise<URLSearchParams> =>
  readBodyBytes(req).then((b) => new URLSearchParams(b.toString("utf8")));

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "content-length": 0 }); // 303 See Other — POST→GET (Post/Redirect/Get)
  res.end();
}

// POST /roadmap/save | /roadmap/publish — the ONLY write routes. Both hard-target the kind:"roadmap"
// document through docstore (DB-doc-only; no filesystem path ⇒ §17 firewall). save → a DRAFT via the
// CAS (a stale baseVersion is surfaced as a CONFLICT, never last-write-wins); publish → operator-gated.
// `statusForDocErr` (the docstore-error → HTTP-status map) now lives in docstore.ts so this roadmap path
// and the DL-43/DL-62 agent op-API can't drift on it.

// DL-19: CSRF + DNS-rebinding guard for the write routes. The daemon is http localhost-only, so the
// ONLY legitimate origin is the host the operator's own browser connected to. Refuse:
//  (a) a Host that isn't 127.0.0.1/localhost — a DNS-rebound name resolving to 127.0.0.1 reaches the
//      bind, and the loopback bind alone never validates Host (the rebinding bypass), and
//  (b) a cross-origin Origin/Referer — a urlencoded form is a CORS "simple request" (no preflight),
//      so a page the operator visits can auto-submit to these routes as the operator (textbook CSRF).
// An ABSENT Origin AND Referer is allowed: a browser CSRF auto-submit always carries Origin, so absence
// means a non-browser client (curl / the operator's own tooling / tests) — not the CSRF vector, and it
// must keep working. Origin is preferred over Referer when present.
// INVARIANT: this literal Host allowlist is sufficient ONLY because the server binds the v4 loopback
// (127.0.0.1) ONLY — see the `HOST = "127.0.0.1"` bind below. If that bind ever widens (0.0.0.0, ::1,
// a LAN address), this guard must widen with it (resolve/validate accordingly), or it silently weakens.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
function writeOriginOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !LOCAL_HOST.test(host)) return false;            // (a) foreign/rebound Host → refuse before any write
  const allowed = `http://${host}`;                             // the daemon is http localhost-only (the served page's origin)
  const origin = req.headers.origin;
  if (origin !== undefined) return origin === allowed;          // (b) Origin present → must be same-origin
  const referer = req.headers.referer;
  if (referer !== undefined) { try { return new URL(referer).origin === allowed; } catch { return false; } }
  return true;                                                  // no Origin/Referer → non-browser client (allowed)
}

async function handleRoadmapWrite(action: "save" | "publish", req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string, actor: string, roadmapRepoFileStrategy?: string): Promise<void> {
  let form: URLSearchParams;
  // If the body was rejected (too large / aborted), the socket may already be destroyed — only respond
  // when the response is still writable, so we never throw write-after-destroy into the outer catch.
  try { form = await parseFormBody(req); }
  catch (e) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: (e as Error).message }); return; }
  // Resolve the roadmap doc's slug SERVER-SIDE (never from the form) so the write target can't be redirected.
  const slug = resolveDoc(writeDb, projectId, undefined, "roadmap")?.slug ?? "roadmap";
  // DL-14: on a rejected re-render, preserve the user's submitted body in the textarea (so a CAS
  // conflict / validation error doesn't discard a substantial edit). roadmapPage recomputes the hidden
  // `baseVersion` from the current latest, so an immediate re-submit targets the right base.
  const rerender = (msg: string, submittedBody?: string) =>
    htmlOut(res, statusForDocErr(msg), page(`roadmap · ${projectKey}`, projectKey, roadmapPage(db, projectId, { writable: true, canPublish: actor === "operator", notice: { kind: "error", msg }, submittedBody, roadmapRepoFileStrategy })));

  if (action === "save") {
    const baseVersion = Number(form.get("baseVersion"));
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return json(res, 400, { error: "baseVersion must be a non-negative integer" });
    const r = docSave(writeDb, projectId, actor, { slug, kind: "roadmap", body: form.get("body") ?? "", baseVersion, summary: form.get("summary") ?? undefined });
    return r.ok ? redirect(res, "/roadmap") : rerender(r.error, form.get("body") ?? ""); // 409 CONFLICT (stale base) — surfaced, and the typed edit is preserved (DL-14)
  }
  const version = Number(form.get("version"));
  if (!Number.isInteger(version) || version <= 0) return json(res, 400, { error: "version must be a positive integer" });
  const r = docPublish(writeDb, projectId, actor, { kind: "roadmap", version });
  return r.ok ? redirect(res, "/roadmap") : rerender(r.error); // non-operator → 403; missing version → 404
}

// ─── DL-29: opt-in human web-write surface (design §11 subsystem D) ──────────────────────────────
// POST /ticket (create) · /ticket/:id/comment · /ticket/:id/move · /ticket/:id/assign. Present ONLY when
// a write connection + actor exist (canWrite) AND settings_json.humanWrite.enabled is true. Read FRESH per
// request so the operator can flip the flag without a daemon restart. Absent/false ⇒ these POSTs are NOT
// matched and fall through to the read-only 405 (byte-identical to today). The same localhost CSRF /
// DNS-rebinding guard as /roadmap/* (writeOriginOk) runs BEFORE any write.
function humanWriteEnabled(db: DatabaseSync, projectId: string): boolean {
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    return JSON.parse(row?.settings_json ?? "{}")?.humanWrite?.enabled === true;
  } catch { return false; }
}
function isTicketWriteRoute(seg: string[]): boolean {
  return (seg.length === 1 && seg[0] === "ticket")
    || (seg.length === 3 && seg[0] === "ticket" && (seg[2] === "comment" || seg[2] === "move" || seg[2] === "assign"));
}
async function handleTicketWrite(seg: string[], req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string, actor: string): Promise<void> {
  let form: URLSearchParams;
  try { form = await parseFormBody(req); }
  catch (e) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: (e as Error).message }); return; }

  if (seg.length === 1) { // POST /ticket — create, then PRG to the new ticket
    const r = createTicket(writeDb, projectId, actor, { title: form.get("title") ?? "", description: form.get("description") ?? undefined, type: form.get("type") ?? undefined });
    if (r.ok) return redirect(res, `/ticket/${encodeURIComponent(r.id)}`);
    // DL-86: a rejected create re-renders the BOARD as HTML with the error inline + the typed title preserved
    // (mirrors the /roadmap/save rerender), instead of dead-ending the operator on a raw-JSON {error} page.
    return htmlOut(res, r.status, page(`${projectKey} · board`, projectKey, boardPage(db, projectId, projectKey, {}, true, undefined, { notice: { kind: "error", msg: r.error }, submittedTitle: form.get("title") ?? "" })));
  }
  const id = decodeSeg(seg[1]);
  if (id === null) return json(res, 400, { error: "malformed percent-escape in path" });
  const verb = seg[2];
  const r = verb === "comment" ? addComment(writeDb, projectId, actor, id, form.get("body") ?? "")
    : verb === "move" ? moveTicket(writeDb, projectId, actor, id, form.get("state") ?? "")
    : assignTicket(writeDb, projectId, actor, id, form.get("assignee") ?? "");
  if (r.ok) return redirect(res, `/ticket/${encodeURIComponent(id)}`);
  // DL-86: a rejected move/assign/comment re-renders the TICKET PAGE as HTML with the error inline (+ the typed
  // comment preserved on a rejected comment), instead of a raw-JSON dead-end. If the ticket is gone (ticketPage
  // null) fall back to the JSON error — there is no page to re-render.
  const inner = ticketPage(db, projectId, id, true, { notice: { kind: "error", msg: r.error }, submittedComment: verb === "comment" ? (form.get("body") ?? "") : undefined });
  if (!inner) return json(res, r.status, { error: r.error });
  return htmlOut(res, r.status, page(`${id} · ${projectKey}`, projectKey, inner));
}

// ─── DL-43: opt-in daemon agent op-API (/api/op/*) — the MCP↔daemon unification foundation (P1) ───────────
// A DORMANT, default-OFF loopback surface dispatching every AGENT_OPS op — the full tool set minus whoami
// (agentops.ts, mirroring server.ts 1:1) — so a later increment's thin stdio MCP shim (P2) can proxy to the
// daemon instead of opening hub.db directly. Gated on settings_json.hub.transport==="daemon" (read FRESH per
// request, the DL-29 humanWrite pattern): unset/≠"daemon" ⇒ the /api/op/* mount is dormant → 404 and every
// read/roadmap surface is byte-for-byte unchanged. server.ts (the stdio transport) is 100% untouched.
// handleAgentOp owns the full endpoint pipeline: writeOriginOk (DL-19 CSRF/DNS-rebind wall) → the
// X-Devloop-Actor header → the G1 phantom-actor guard → (writes only) the dry-run mode gate → dispatch.
// Read ops use the query_only `db`; write ops use the writable `writeDb` (the same connection the
// human-write routes write through).
function agentApiEnabled(db: DatabaseSync, projectId: string): boolean {
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    return JSON.parse(row?.settings_json ?? "{}")?.hub?.transport === "daemon";
  } catch { return false; } // malformed config ⇒ dormant (fail-closed: a write surface never opens on bad config)
}
// The project's mode (live|dry-run), read fresh per request so an operator flip takes effect without a
// restart. Honoring it server-side (design Decision #4) gates the op-API WRITE ops under dry-run — a
// defense-in-depth atop the agent-side mode authority (§12/§18: the hub row is advisory). A malformed /
// missing value reads as "live" (fail-OPEN to the working default — never silently wedge a live write path).
function projectMode(db: DatabaseSync, projectId: string): string {
  try {
    const row = db.prepare("SELECT mode FROM projects WHERE id=?").get(projectId) as { mode?: string } | undefined;
    return row?.mode ?? "live";
  } catch { return "live"; }
}

// Read the op-API's JSON args via the shared bounded reader (readBodyBytes). An empty body ⇒ {} (a no-arg op
// like list_issues). A non-object JSON value (array/number/null) ⇒ {} — the ops read named fields, so a
// non-object is "no args", never thrown; only un-parseable JSON rejects (→ the caller's 400).
function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return readBodyBytes(req).then((b) => {
    const raw = b.toString("utf8").trim();
    if (!raw) return {};
    let v: unknown;
    try { v = JSON.parse(raw); } catch { throw new Error("invalid JSON body"); }
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  });
}

// Handle POST /api/op/<op>. Identity rides X-Devloop-Actor (cooperative single-host attribution, §18 — NOT
// anti-spoof; the real human boundary stays the operator-publish gate). Pipeline order is load-bearing: the
// CSRF/Host wall runs BEFORE the actor/body are read, and a write is mode-gated before any mutation.
async function handleAgentOp(op: string, req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string): Promise<void> {
  if (!isAgentOp(op)) return json(res, 404, { error: `unknown op '${op}'` });
  // (1) CSRF / DNS-rebinding wall FIRST — uniform over every op. A non-browser agent client (the shim, curl,
  //     tests) sends no Origin ⇒ allowed; a browser cross-origin / foreign-Host POST is refused before anything.
  if (!writeOriginOk(req)) return json(res, 403, { error: "op refused: cross-origin or non-localhost Host (CSRF / DNS-rebinding guard)" });
  // (2) actor from the header, validated against `actors` (the G1 phantom-actor guard — every write/comment
  //     must be attributable, exactly like the stdio server's DEVLOOP_ACTOR start guard).
  const actor = (req.headers["x-devloop-actor"] as string | undefined)?.trim();
  if (!actor) return json(res, 400, { error: "missing X-Devloop-Actor header (the caller's actor)" });
  if (!actorExists(writeDb, actor)) return json(res, 400, { error: `unknown actor '${actor}'` });
  const isWrite = AGENT_WRITE_OPS.has(op);
  // (3) parse the JSON args (bounded) — BEFORE the mode gate, because the D1 `project` override rides the
  //     body and the gate must judge the EFFECTIVE project. Parsing mutates nothing, so "mode-gated before
  //     any mutation" still holds. A rejected body may have destroyed the socket — guard the response.
  let args: Record<string, unknown>;
  try { args = await parseJsonBody(req); }
  catch (e) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: (e as Error).message }); return; }
  // (4) D1 project override — resolve the effective project through the SAME matrix agentOp applies (one
  //     resolver, agentops.ts), so a forbidden/unknown override errors identically to the stdio path.
  const ov = resolveProjectOverride(db, projectId, projectKey, actor, args.project);
  if (!ov.ok) return json(res, ov.result.status, ov.result.body);
  // (5) honor `mode` server-side (design Decision #4) on the EFFECTIVE project: a WRITE op into a dry-run
  //     project is refused (defense-in-depth atop agent-side mode authority) — an override into a dry-run
  //     sibling is gated by the SIBLING's mode, not the booted board's. Reads are never gated.
  if (isWrite && projectMode(db, ov.projectId) === "dry-run") return json(res, 403, { error: `project '${ov.projectKey}' is in dry-run mode — the op-API refuses writes (mode honored server-side; §12/§18)` });
  // (6) dispatch — writes through writeDb (atomic txn + attributed event in ticketwrite), reads through the
  //     query_only db. agentOp mirrors server.ts; an op-level validation/not-found maps to its HTTP status.
  //     The effective ids go in; agentOp's own choke-point resolve degenerates to the same-key fast path.
  //     AWAIT: agentOp returns OpResult|Promise<OpResult> — the DL-67 channel.send/poll ops are async (network/
  //     dryrun build); the sync ops resolve immediately, so awaiting them is a no-op (back-compat).
  const r = await agentOp(op, isWrite ? writeDb : db, ov.projectId, ov.projectKey, actor, args);
  return json(res, r.status, r.body);
}

// Build the HTTP server over an already-opened, project-resolved db. Exported so tests (and a later
// in-process embed) can start it without the CLI bootstrap below. GET routes issue ONLY SELECTs; the
// optional DL-3 /roadmap/* POST routes write the roadmap doc through the separate `writeDb` connection.
export function createDaemon({ db, projectId, projectKey, writeDb, actor, roadmapRepoFileStrategy }: DaemonOpts): Server {
  const canWrite = !!writeDb && !!actor;
  let streamCount = 0; const MAX_STREAMS = 16; // bound concurrent SSE connections (one operator, a few tabs)
  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { return json(res, 400, { error: "bad request url" }); }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean); // [] for "/"

    try {
      // ── DL-3 write surface: the ONLY non-GET routes. They hard-target the kind:"roadmap" doc through
      //    docstore (DB-doc-only — no filesystem path ⇒ §17 firewall). Present ONLY when a write
      //    connection + actor were supplied; otherwise the daemon stays GET-only (DL-1/DL-2 behavior).
      if (method === "POST" && canWrite && (path === "/roadmap/save" || path === "/roadmap/publish")) {
        // DL-19: refuse a cross-origin (CSRF) or foreign-Host (DNS-rebinding) write BEFORE any docSave/
        // docPublish — the guard runs ahead of handleRoadmapWrite, so a refused request never mutates.
        if (!writeOriginOk(req)) return json(res, 403, { error: "write refused: cross-origin or non-localhost Host (CSRF / DNS-rebinding guard)" });
        await handleRoadmapWrite(path === "/roadmap/save" ? "save" : "publish", req, res, db, writeDb!, projectId, projectKey, actor!, roadmapRepoFileStrategy);
        return;
      }
      // DL-29: opt-in human ticket-write routes — present ONLY when canWrite AND humanWrite.enabled. When
      // disabled (or absent), these POSTs are NOT matched and fall through to the 405 below (byte-identical
      // read-only). Origin/Host guard runs BEFORE any write, exactly like /roadmap/*.
      if (method === "POST" && canWrite && humanWriteEnabled(db, projectId) && isTicketWriteRoute(seg)) {
        if (!writeOriginOk(req)) return json(res, 403, { error: "write refused: cross-origin or non-localhost Host (CSRF / DNS-rebinding guard)" });
        await handleTicketWrite(seg, req, res, db, writeDb!, projectId, projectKey, actor!);
        return;
      }
      // DL-43: opt-in agent op-API — POST /api/op/<op>, active ONLY when canWrite AND the project opted in
      // (settings_json.hub.transport==="daemon", read FRESH). The WHOLE /api/op/* path is owned here so a
      // DORMANT mount (flag off, or a read-only daemon, or a non-POST/garbled op path) 404s — an absent
      // mount, not the generic non-GET 405 — leaving every existing surface byte-for-byte unchanged.
      if (seg[0] === "api" && seg[1] === "op") {
        if (method === "POST" && canWrite && seg.length === 3 && agentApiEnabled(db, projectId)) {
          await handleAgentOp(seg[2], req, res, db, writeDb!, projectId, projectKey);
          return;
        }
        return json(res, 404, { error: `not found: ${path}` });
      }
      // READ-ONLY for everything else: any other non-GET is refused — the read surface never mutates (DL-1 AC).
      if (method !== "GET" && method !== "HEAD") {
        return json(res, 405, { error: "read-only daemon: only GET is allowed" });
      }

      // GET / — the web UI board (DL-2): server-rendered HTML, read-only, columns by state. DL-20:
      // optional server-side filter/search via the query string (state/type/label/assignee + free-text q).
      if (path === "/") {
        const sp = url.searchParams;
        const filters = { state: sp.get("state") ?? undefined, type: sp.get("type") ?? undefined, label: sp.get("label") ?? undefined, assignee: sp.get("assignee") ?? undefined, q: sp.get("q") ?? undefined };
        // DL-31: validate ?group to the single known view ("assignee" → swimlanes); anything else ⇒ default board.
        const group = sp.get("group") === "assignee" ? "assignee" : undefined;
        return htmlOut(res, 200, page(`${projectKey} · board`, projectKey, boardPage(db, projectId, projectKey, filters, canWrite && humanWriteEnabled(db, projectId), group)));
      }

      // GET /roadmap — the roadmap doc view + edit form (+ operator-only publish) (DL-3).
      if (path === "/roadmap") {
        return htmlOut(res, 200, page(`roadmap · ${projectKey}`, projectKey, roadmapPage(db, projectId, { writable: canWrite, canPublish: canWrite && actor === "operator", roadmapRepoFileStrategy })));
      }

      // GET /activity — read-only activity & throughput over the events ledger (DL-17). Pure SELECTs
      // through the query_only db; Date.now() injected so activityPage stays pure/testable.
      if (path === "/activity") {
        return htmlOut(res, 200, page(`activity · ${projectKey}`, projectKey, activityPage(db, projectId, projectKey, Date.now())));
      }

      // GET /reports — the agent reports index (DL-10, read-only filesystem view; empty state if absent).
      if (path === "/reports") {
        return htmlOut(res, 200, page(`reports · ${projectKey}`, projectKey, reportsIndexPage(reportsRoot(projectKey))));
      }
      // GET /reports/<agent>/<level>/<date> — one report, read-only (path-validated → 400 traversal, 404 absent).
      if (seg[0] === "reports" && seg.length === 4) {
        const agent = decodeSeg(seg[1]), level = decodeSeg(seg[2]), date = decodeSeg(seg[3]);
        if (agent === null || level === null || date === null) return json(res, 400, { error: "malformed percent-escape in path" });
        const r = reportPage(reportsRoot(projectKey), agent, level, date);
        if (r === "badpath") return json(res, 400, { error: "invalid report path" });
        if (r === null) return htmlOut(res, 404, page("Not found", projectKey, `<a class="back" href="/reports">← reports</a><p class="empty">No report ${esc(agent)}/${esc(level)}/${esc(date)}.</p>`));
        return htmlOut(res, 200, page(`${date} · ${agent} · ${projectKey}`, projectKey, r.html));
      }

      // GET /ticket/:id — the web UI detail view (DL-2): full description + comments.
      if (seg[0] === "ticket" && seg.length === 2) {
        const id = decodeSeg(seg[1]);
        if (id === null) return json(res, 400, { error: "malformed percent-escape in path" });
        const inner = ticketPage(db, projectId, id, canWrite && humanWriteEnabled(db, projectId));
        if (!inner) return htmlOut(res, 404, page("Not found", projectKey, `<a class="back" href="/">← board</a><p class="empty">No ticket ${esc(id)} in ${esc(projectKey)}.</p>`));
        return htmlOut(res, 200, page(`${id} · ${projectKey}`, projectKey, inner));
      }

      // GET /api — JSON API index (was GET / before DL-2 added the web UI at the root).
      if (path === "/api") {
        return json(res, 200, {
          name: "dev-loop-hub daemon", project: projectKey, readOnly: true,
          ui: "/", endpoints: ["/api/health", "/api/tickets", "/api/tickets/:id", "/api/docs", "/api/docs/:kind"],
        });
      }

      // GET /api/stream — SSE live-update channel (the DL-2 no-JS doctrine was amended by the operator to
      // allow a tiny inline progressive-enhancement script, 2026-07-02). Poll-push, never blocking: a timer
      // checks max(events.id) — an O(1) read on the AUTOINCREMENT PK — and emits only when it ADVANCES, so
      // the board/activity pages refresh themselves as agents mutate the ledger. node:sqlite is synchronous,
      // so we poll on a setInterval (a few ms of work) rather than hold any long DB operation.
      if (path === "/api/stream") {
        if (streamCount >= MAX_STREAMS) return json(res, 503, { error: "too many live connections" });
        streamCount++;
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-accel-buffering": "no" });
        const maxId = (): number => Number((db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM events WHERE project_id=?").get(projectId) as { m: number }).m);
        let last = maxId();
        res.write(`retry: 3000\ndata: ${last}\n\n`); // initial baseline + client reconnect hint
        const iv = setInterval(() => {
          try { const now = maxId(); if (now !== last) { last = now; res.write(`data: ${now}\n\n`); } else { res.write(": ping\n\n"); } }
          catch { /* transient read error — the next tick retries; never crash the daemon */ }
        }, 2000);
        iv.unref?.();
        const done = () => { clearInterval(iv); streamCount--; };
        req.on("close", done); res.on("close", done);
        return;
      }

      // GET /api/health — a REAL DB-writable liveness check (DL-41), not a static 200: a bound-but-wedged
      // daemon (SoR unreadable/unwritable) returns 503 ok:false so the lifecycle `up`/`status` recover it.
      if (path === "/api/health") {
        const h = healthLiveness(db, writeDb);
        // version: lets `daemon up` detect a daemon still running pre-upgrade code and restart it;
        // actor: surfaces a mis-identified daemon (e.g. one cold-started from an agent fire's env).
        return json(res, h.ok ? 200 : 503, h.ok
          ? { ok: true, project: projectKey, version: pkgVersion(), actor }
          : { ok: false, project: projectKey, version: pkgVersion(), actor, error: h.error });
      }

      // GET /api/tickets — board, project-scoped (§2), filter by state/type/label/assignee (+ optional limit).
      if (path === "/api/tickets") {
        let out = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as Record<string, any>[]).map(toTicket);
        const state = url.searchParams.get("state"); if (state) out = out.filter((t) => t.state === state);
        const type = url.searchParams.get("type"); if (type) out = out.filter((t) => t.type === type);
        const label = url.searchParams.get("label"); if (label) out = out.filter((t) => t.labels.includes(label));
        // DL-31: honor ?assignee (was silently ignored → board/API parity; the GET / board already filters it).
        const assignee = url.searchParams.get("assignee"); if (assignee) out = out.filter((t) => t.assignee === assignee);
        const limit = Number(url.searchParams.get("limit")); if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
        return json(res, 200, out);
      }

      // GET /api/tickets/:id — one ticket with its comments.
      if (seg[0] === "api" && seg[1] === "tickets" && seg.length === 3) {
        const id = decodeSeg(seg[2]);
        if (id === null) return json(res, 400, { error: "malformed percent-escape in path" });
        const r = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as Record<string, any> | undefined;
        if (!r) return json(res, 404, { error: `no such ticket ${id} in ${projectKey}` });
        const comments = db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id);
        return json(res, 200, { ...toTicket(r), comments });
      }

      // GET /api/docs — list this project's documents (no bodies).
      if (path === "/api/docs") {
        return json(res, 200, db.prepare("SELECT kind,slug,title,status,current_version,updated_at FROM documents WHERE project_id=? ORDER BY kind").all(projectId));
      }

      // GET /api/docs/:kind — the current roadmap/strategy doc (published version, else latest draft).
      if (seg[0] === "api" && seg[1] === "docs" && seg.length === 3) {
        const key = decodeSeg(seg[2]);
        if (key === null) return json(res, 400, { error: "malformed percent-escape in path" });
        const d = (db.prepare("SELECT * FROM documents WHERE project_id=? AND kind=?").get(projectId, key)
          ?? db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, key)) as Record<string, any> | undefined;
        if (!d) return json(res, 404, { error: `no document '${key}' in ${projectKey}` });
        const ver = d.current_version > 0
          ? d.current_version
          : ((db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(d.id) as { v: number | null }).v ?? 0);
        if (ver === 0) return json(res, 200, { kind: d.kind, slug: d.slug, title: d.title, status: d.status, version: 0, body: "", unpublished: true, empty: true });
        const v = db.prepare("SELECT version,body,status,summary,base_version,author,created_at FROM document_versions WHERE doc_id=? AND version=?").get(d.id, ver) as Record<string, any>;
        return json(res, 200, { kind: d.kind, slug: d.slug, title: d.title, status: d.status, current_version: d.current_version, ...v, ...(d.current_version === 0 ? { unpublished: true } : {}) });
      }

      // DL-36: an unknown /api/* path is a machine client → JSON 404 (unchanged). An unknown NON-API path is
      // a page navigation (a typo'd URL) → serve the friendly HTML 404, like the ghost-ticket route, instead
      // of a raw-JSON dead-end. Read-only; query_only preserved.
      if (seg[0] === "api") return json(res, 404, { error: `not found: ${path}` });
      return htmlOut(res, 404, page("Not found", projectKey, `<a class="back" href="/">← board</a><p class="empty">No page <code>${esc(path)}</code> in ${esc(projectKey)}.</p>`));
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
}

// A3: the background notifier + WAL timers live in daemon-notifiers.ts. Imported for the boot below, then
// re-exported so the existing test imports from ./daemon.ts keep resolving unchanged.
export {
  blockedNotifyTick, startBlockedNotifier, noProgressNotifyTick,
  startNoProgressNotifier, walCheckpointTick, startWalCheckpoint,
};

// DL-41 dispatch — a lifecycle subcommand handles itself and exits; ANY other invocation (incl. the
// bare `npm run daemon`) falls through to today's foreground boot below, byte-for-byte unchanged.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
    && LIFECYCLE_SUBS.includes(process.argv[2] as LifecycleSub)) {
  await daemonLifecycle(process.argv[2] as LifecycleSub); // calls process.exit — never returns
}

// ─── CLI entry: `npm run daemon` — open db, resolve project (same guard as the MCP server), listen ──
// Only runs when executed directly (not on import — the test imports createDaemon and starts it itself).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const DB_PATH = hubDbPath();
  const PROJECT_KEY = process.env.DEVLOOP_PROJECT?.trim();
  const HOST = "127.0.0.1"; // §16 localhost-only; NEVER 0.0.0.0
  const PORT = Number(process.env.DEVLOOP_DAEMON_PORT ?? 8787);
  if (!PROJECT_KEY) {
    console.error("[daemon] no project resolved. Set DEVLOOP_PROJECT=<key> for foreground daemon mode, or use `dev-loop daemon up` from inside a configured repo.");
    process.exit(1);
  }

  const db = openDb(DB_PATH);
  db.exec("PRAGMA query_only=ON"); // structural read-only: this connection can never write the SoR
  // Defense-in-depth alongside the notifier .catch handlers: any OTHER stray rejection logs instead of
  // killing a daemon that agents and the operator depend on (nothing here should reject, but the cost of
  // a silent crash — a dead board UI + dead notifiers until the next `up` — is far higher than a log line).
  process.on("unhandledRejection", (e) => console.error(`[daemon] unhandled rejection (daemon stays up): ${scrubErr(String((e as Error)?.message ?? e))}`));
  // No ensureActors/auto-create here: like the MCP server's G2 guard, refuse to serve a phantom board.
  const projectId = findProject(db, PROJECT_KEY);
  if (!projectId) {
    console.error(`[daemon] unknown project '${PROJECT_KEY}'. Seed it first (e.g. start the hub, or \`node src/seed.ts ${PROJECT_KEY} "<name>" <PREFIX>\`). Refusing to serve a phantom board.`);
    process.exit(1);
  }
  // DL-3: a SECOND, writable connection backs ONLY the /roadmap/* write routes — the read `db` above
  // stays query_only, so the daemon's read surface remains structurally read-only. DEVLOOP_ACTOR (default
  // operator, matching the MCP server) attributes writes and gates publish; refuse a phantom actor
  // (G1-style) so a write can never land unattributable authorship.
  const ACTOR = process.env.DEVLOOP_ACTOR ?? "operator";
  const writeDb = openDb(DB_PATH);
  if (!actorExists(writeDb, ACTOR)) {
    console.error(`[daemon] DEVLOOP_ACTOR='${ACTOR}' is not a known actor — refusing to start the roadmap write surface with an unattributable identity. Seed actors via the hub first.`);
    process.exit(1);
  }
  // DL-83: detect whether a repo-file strategyDoc (not the hub roadmap doc) is THIS project's north-star,
  // from the daemon's OWN resolved config (projects.json) — never request input (§17). When it is, /roadmap
  // shows a divergence banner naming that file. Same config-read precedent as the §9 `notify` resolve below.
  let roadmapRepoFileStrategy: string | undefined;
  try { roadmapRepoFileStrategy = roadmapDivergenceDoc(loadProjectsConfig()?.projects?.[PROJECT_KEY]); }
  catch { roadmapRepoFileStrategy = undefined; }
  const server = createDaemon({ db, projectId, projectKey: PROJECT_KEY, writeDb, actor: ACTOR, roadmapRepoFileStrategy });
  // DL-26: read the per-project Human-Blocked reminder cadence (settings_json.humanBlockedReminderHours).
  // DL-76: read the loop no-progress circuit-breaker window (settings_json.noProgressWindowHours) from the
  // SAME parse — both are operator-set, hours, 0/absent ⇒ off (true no-op, no timer).
  let cadenceHours = 0, noProgressWindowHours = 0;
  try {
    const row = writeDb.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    const settings = JSON.parse(row?.settings_json ?? "{}");
    cadenceHours = Number(settings?.humanBlockedReminderHours) || 0;
    noProgressWindowHours = Number(settings?.noProgressWindowHours) || 0;
  } catch { cadenceHours = 0; noProgressWindowHours = 0; }
  // DL-59: also resolve the §9 `notify` webhook (projects.json) so a project with ONLY a notify webhook (no
  // registered bot/webhook channel) still receives Human-Blocked reminders — the daemon is the single emitter
  // on `service`. §16: the block stays in config/env; the daemon reads it but never writes it to the DB.
  let notify: unknown;
  try { notify = (loadProjectsConfig()?.projects?.[PROJECT_KEY] as { notify?: unknown } | undefined)?.notify; } catch { notify = undefined; }
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`[daemon] dev-loop-hub for '${PROJECT_KEY}' (actor=${ACTOR}${ACTOR === "operator" ? ", can publish" : ", drafts only"}) → http://${HOST}:${port}/  (reads read-only; /roadmap editable, localhost-only)`);
    // Human-Blocked notifier (option b): owns first-ping + reminders on service. No channel / cadence≤0 ⇒ no-op.
    const notifier = startBlockedNotifier({ writeDb, projectId, projectKey: PROJECT_KEY, baseUrl: `http://${HOST}:${port}`, cadenceHours, notify });
    if (notifier) console.log(`[daemon] Human-Blocked notifier active (every ${cadenceHours}h via the configured channel / §9 notify webhook)`);
    // DL-76: loop no-progress / runaway circuit-breaker — alert ONCE when 0 accepted change (Done) lands in the
    // rolling window. No channel/notify OR noProgressWindowHours≤0 ⇒ no-op (mirrors the Human-Blocked notifier).
    const noProgress = startNoProgressNotifier({ writeDb, projectId, projectKey: PROJECT_KEY, baseUrl: `http://${HOST}:${port}`, windowHours: noProgressWindowHours, notify });
    if (noProgress) console.log(`[daemon] no-progress detector active (alert on 0 accepted change in ${noProgressWindowHours}h via the configured channel / §9 notify webhook)`);
    // P3b: bound the single-writer connection's WAL via a DEDICATED busy_timeout=0 maintenance connection
    // (never blocks the synchronous event loop under a concurrent reader — Codex review 2026-06-27).
    startWalCheckpoint(DB_PATH);
    console.log(`[daemon] WAL checkpoint active (periodic TRUNCATE on a dedicated non-blocking connection)`);
  });
}
