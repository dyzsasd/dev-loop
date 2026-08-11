// dev-loop hub daemon — a persistent localhost HTTP surface over the hub SoR (DL-1).
//
// Two connections: `db` (PRAGMA query_only=ON — that connection can never write) and
// `writeDb` (a separate writable connection for the three POST write families below).
// Serves GET endpoints plus three POST write families: doc save/publish (+ /roadmap
// aliases), human ticket writes, and the DL-43 agent op-API — each behind its §6.2
// gate; unmatched non-GET → 405. Binds 127.0.0.1 by default (§16); DEVLOOP_DAEMON_HOST
// may widen the bind, requiring DEVLOOP_UI_TOKEN(_FILE) — see the bind-invariant
// comment at the Host-allowlist guard for the full reasoning.
//
// The agents are UNCHANGED: they keep coordinating through the MCP server (`server.ts`); this is
// an additive human-facing read surface, NOT a new coordinator (strategyDoc Decisions log,
// 2026-06-23). DL-2 added a server-rendered web UI at `/` (board + ticket detail) and moved the
// JSON API index to `/api`; the `/api/*` JSON endpoints are unchanged.
//
// Zero native deps, zero build step (Node ≥23.6 type-stripping + built-in node:http/node:sqlite),
// reusing the existing `db.ts` schema with NO schema fork (hub doctrine).
import { createServer, type Server, type ServerResponse, type IncomingMessage } from "node:http";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainEntry } from "./is-entry.ts";
import { startBoardSnapshot, resolveBackupConfig } from "./board-snapshot.ts"; // LOOP-339: the cadence trigger

// LOOP-96: the same cap list_issues uses (agentops.ts LIST_ISSUES_DEFAULT_LIMIT). db.ts already names
// list_issues / /api/tickets / the board as ONE family sorted by (project_id, updated_at DESC); one of
// the three was bounded and two were not, so they now share one number.
const API_TICKETS_DEFAULT_LIMIT = 250;
import { DatabaseSync } from "node:sqlite";
import { openDb, actorExists, fireIdStore } from "./db.ts";
import { findProject } from "./seed.ts";
import { loadProjectsConfig, repoFileStrategyPath } from "./resolve-project.ts"; // + docs P3b: the ONE strategyDoc→repo-file rule (doc-home, §19)
import { hubDbPath, pkgVersion, pkgVersionFresh, pkgBuildCommit, pkgBuildCommitFresh } from "./paths.ts";
import { resolveDoc, docSave, docPublish, statusForDocErr, type DocKind } from "./docstore.ts";
import { createTicket, addComment, moveTicket, assignTicket } from "./ticketwrite.ts";
import { agentOp, AGENT_WRITE_OPS, isAgentOp, resolveProjectOverride } from "./agentops.ts"; // DL-43: the daemon agent op-API's 5-op core (mirrors server.ts)
import { scrubErr } from "./channel.ts"; // the notifier's channel deps moved to daemon-notifiers.ts (A3); scrubErr stays for /api/health + the unhandledRejection guard
import { NOT_SCRATCH_SQL } from "./sql-predicates.ts";
import { humanWriteEnabled } from "./project-settings.ts"; // LOOP-481: the human-write gate, shared with doctor via a lean leaf
// DL-74/F1: the HTML view layer lives in src/views/* (ui/board/ticket/roadmap/activity/reports) with
// daemonviews.ts as the compat façade; the HTML GET routes are dispatched off the typed registry
// (views/registry.ts). The per-project process-lifecycle subsystem lives in daemon-lifecycle.ts. This
// file keeps HTTP routing (createDaemon), the write-route handlers (which re-render via the view fns
// below), the background timers, and the CLI dispatch + foreground boot.
import { page, esc, href, toTicket } from "./views/ui.ts";
import { boardPage } from "./views/board.ts";
import { ticketPage } from "./views/ticket.ts";
import { docPage, draftsPendingCount, roadmapDocSlug, isSingletonKind } from "./views/docs.ts";
import { projectIndexPage } from "./views/projects.ts";
import { matchViewRoute, decodeSeg } from "./views/registry.ts";
import { TEAM_INTAKE_PROJECT } from "./team-config.ts"; // F2/D2: the index pins _team last; the single-REAL-project redirect excludes it
import { daemonLifecycle, LIFECYCLE_SUBS, type LifecycleSub } from "./daemon-lifecycle.ts";
import { // A3: extracted timers; imported for the foreground boot, re-exported (below) for the tests.
  blockedNotifyTick, startBlockedNotifier, noProgressNotifyTick,
  startNoProgressNotifier, walCheckpointTick, startWalCheckpoint,
  resolveBlockedReminderHours, startDocForeignEditNotifier, startDocDraftsPendingNotifier,
  startStrategyFileEditNotifier, // docs P3b: the passive-mode repo-FILE strategy-doc watch
  fireHealthNotifyTick, startFireHealthNotifier, // P0-1c: the loop fire-health self-monitor
} from "./daemon-notifiers.ts";
import { tryResolveWorkspace, wsFireLedger, wsStateRoot } from "./workspace.ts";
import { resolveUiToken, bearerOk, isLoopbackHost } from "./ui-token.ts"; // one-click P1 §6.2: the bearer gate + bind knob

export interface DaemonOpts {
  db: DatabaseSync;          // read connection (PRAGMA query_only=ON) — every GET route reads through this
  // The BOOT project: the fallback every bare path serves (old URLs/bookmarks keep working). F2 (D2):
  // a /p/<key>/ path prefix re-resolves the project PER REQUEST, so one daemon serves every hub project.
  projectId: string;
  projectKey: string;
  writeDb?: DatabaseSync;    // a SEPARATE writable connection for the three write route families (doc, ticket, agent-op) — see SEAM 3a
  actor?: string;            // the daemon's identity — attributes writes + gates publish (operator-only)
  // DL-83: the repo-file strategyDoc PATH when the hub roadmap is NOT this project's north-star (no agent
  // reads it). Set ⇒ /roadmap shows a divergence banner; absent ⇒ no banner (hub-doc/director, or unknown).
  roadmapRepoFileStrategy?: string;
  // LOOP-52: the version the daemon was started with (defaults to pkgVersion(); override in tests to
  // simulate a stale daemon without modifying package.json on disk).
  daemonVersion?: string;
  // LOOP-95: the actual path of the DB file the daemon opened (may differ from wsHubDb when
  // DEVLOOP_HUB_DB overrides; /api/health checks existsSync on THIS path, not on workspaceId).
  dbPath?: string;
  // LOOP-252: the resolved entry path of this daemon process (daemon.ts / daemon.js), so daemon status
  // can identify which tree is serving the board without resorting to `ps`.
  entryPath?: string;
}

// DL-83: does THIS project's resolved config make the hub roadmap doc its north-star, or is a repo-file
// strategyDoc the north-star? Returns the strategyDoc PATH when NO agent reads the hub roadmap doc
// (hub.docs:false/absent AND no director config AND a string strategyDoc) → the /roadmap divergence banner;
// else undefined (the hub roadmap IS the north-star — hub.docs:true or a director chairs it — or the config
// is unknown) → no banner. Pure + derived from config ONLY (never request input, §17), so it is unit-testable.
export function roadmapDivergenceDoc(proj: { hub?: { docs?: unknown }; director?: unknown; strategyDoc?: unknown } | undefined | null): string | undefined {
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
// LOOP-304 — `projectId` is resolved ONCE at boot and carried as a field; every later read is
// `WHERE project_id=?` against that cached id. Nothing re-checks that the `projects` row still
// exists, so after a cascade delete the daemon kept answering from a connection whose target was
// gone: during the 2026-08-04 board wipe it served the pre-delete board for roughly TWO HOURS,
// `dev-loop queue` returned 68 backlog rows 115 minutes after the data was destroyed, and doctor
// printed DOCTOR_OK throughout. The cached view is what made the deletion unobservable.
//
// The tell existed and nothing surfaced it: the DIRECT-read verbs refused with "project is not
// seeded in the hub DB" while the DAEMON-backed verbs answered normally. That split — direct read
// refuses, daemon answers — is a precise, machine-checkable signature, and it is now checked on
// every health probe, which is the one call the lifecycle already makes on a cadence.
function projectRowGone(db: DatabaseSync, projectId: string): boolean {
  try { return db.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId) === undefined; }
  catch { return false; } // an unreadable db is the EXISTING wedge path below — not this one
}

// LOOP-367 — the SECOND way a daemon serves a board that is no longer the board. `projectRowGone` catches a
// row DELETED underneath the connection; it cannot catch the file being REPLACED, because the orphaned inode
// still holds a perfectly valid `projects` row. On 2026-08-06 a `qa` fire ran `board restore` against the live
// workspace: the restore swapped hub.db for a new inode, this daemon kept its open fd on the old one, and the
// UI served a board frozen at the moment of the swap for 69 minutes while every direct-read verb answered
// correctly. Same signature as 2026-08-04 (direct read disagrees with daemon read), same invisibility.
//
// The check is the path's inode versus the inode this daemon opened. `stat` is cheap, runs on the probe the
// lifecycle already makes on a cadence, and needs no fd introspection. A missing file is NOT this case — an
// unlinked-and-not-yet-recreated db is the existing wedge path below, which reports through the same channel.
export function dbFileReplaced(opened: { path: string; ino: number } | undefined): boolean {
  if (opened === undefined) return false; // nothing to compare ⇒ never a false alarm
  try { return statSync(opened.path).ino !== opened.ino; }
  catch { return false; } // absent/unstattable ⇒ the wedged-SoR path owns it, not this one
}

export function healthLiveness(db: DatabaseSync, writeDb?: DatabaseSync, projectId?: string, opened?: { path: string; ino: number }): { ok: boolean; error?: string } {
  try {
    db.prepare("SELECT 1").get(); // read liveness: the connection + DB file are reachable & not corrupt
    if (dbFileReplaced(opened))
      return { ok: false, error: `${opened?.path} has been REPLACED since this daemon opened it (different inode) — this connection is reading an orphaned file and every view it serves is stale, however healthy it looks. A \`board restore\` or an out-of-band file swap does this. Restart it: dev-loop daemon up` };
    // A live connection to a board that no longer exists is NOT healthy. Reported through the same
    // ok:false channel the wedged-SoR case uses, so the lifecycle's existing reaper acts on it
    // without a second mechanism — and so a scripted reader polling /api/health cannot miss it.
    if (projectId !== undefined && projectRowGone(db, projectId))
      return { ok: false, error: `project row ${projectId} no longer exists in this db — the board was deleted underneath this daemon; it is serving a CACHED view. Restart it: dev-loop daemon up` };
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

// decodeSeg (the DL-7 malformed-percent-escape → 400 helper) moved to views/registry.ts — the view
// handlers and the /api routes below share the one implementation (imported above).

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

// LOOP-289: an IPv6 literal must be bracketed before it goes into a URL, or `new URL()` throws on it —
// `http://::1:8789` is not parseable. Only for URL construction; the loopback DECISION is
// isLoopbackHost's, which accepts either spelling.
const hostForUrl = (h: string): string => (h.includes(":") && !h.startsWith("[") ? `[${h}]` : h);

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "content-length": 0 }); // 303 See Other — POST→GET (Post/Redirect/Get)
  res.end();
}

// POST /doc/:slug/save | /doc/:slug/publish (F4/D3 — plus the legacy /roadmap/* aliases, which resolve
// the roadmap doc's slug server-side). Every doc write goes through docstore (DB-doc-only; no filesystem
// path ⇒ §17 firewall). save → a DRAFT via the CAS (a stale baseVersion is surfaced as a CONFLICT, never
// last-write-wins); publish → operator-gated in docstore. `statusForDocErr` (the docstore-error →
// HTTP-status map) lives in docstore.ts so this path and the DL-43/DL-62 agent op-API can't drift on it.

// DL-19: CSRF + DNS-rebinding guard for the write routes. The daemon is http localhost-only, so the
// ONLY legitimate origin is the host the operator's own browser connected to. Refuse:
//  (a) a Host that isn't 127.0.0.1/localhost — a DNS-rebound name resolving to 127.0.0.1 reaches the
//      bind, and the loopback bind alone never validates Host (the rebinding bypass), and
//  (b) a cross-origin Origin/Referer — a urlencoded form is a CORS "simple request" (no preflight),
//      so a page the operator visits can auto-submit to these routes as the operator (textbook CSRF).
// An ABSENT Origin AND Referer is allowed: a browser CSRF auto-submit always carries Origin, so absence
// means a non-browser client (curl / the operator's own tooling / tests) — not the CSRF vector, and it
// must keep working. Origin is preferred over Referer when present.
// INVARIANT: this literal Host allowlist is sufficient ONLY while the server binds the v4 loopback
// (127.0.0.1) — the default. One-click P1 (§6.2): the bind may now widen via DEVLOOP_DAEMON_HOST, and
// the guard widens WITH it exactly as this invariant demands — a non-loopback bind REQUIRES the
// DEVLOOP_UI_TOKEN bearer (boot refuses otherwise), every request except /api/health must then carry
// the token, and a token-authed request bypasses this Host heuristic entirely (a bearer is strictly
// stronger: a browser cannot attach cross-site Authorization headers, so the CSRF/rebinding vector
// this guard exists for cannot reach a tokened surface).

// F2: the grammar a PATH-derived /p/<key> project key must satisfy before any DB lookup or filesystem
// use — one safe segment, no "/", no leading dot (kills "." / ".." traversal). Slightly wider than the
// config KEY_RE (allows "_team" and uppercase) so every legitimately-seeded key stays reachable.
// WHATWG URL parsing normalizes dot-segments (incl. %2e%2e) out of url.pathname BEFORE routing, so
// encoded traversal renders the index instead of reaching this guard; the regex backstops raw shapes.
const SAFE_KEY = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
function writeOriginOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  // LOOP-289: the SHARED predicate, not a second hand-rolled regex. The two used to disagree on
  // IPv6 loopback, and this guard was the half that refused it — so a ::1 bind 403'd every write.
  // They can no longer drift, because there is only one of them.
  if (!host || !isLoopbackHost(host)) return false;            // (a) foreign/rebound Host → refuse before any write
  const allowed = `http://${host}`;                             // the daemon is http localhost-only (the served page's origin)
  const origin = req.headers.origin;
  if (origin !== undefined) return origin === allowed;          // (b) Origin present → must be same-origin
  const referer = req.headers.referer;
  if (referer !== undefined) { try { return new URL(referer).origin === allowed; } catch { return false; } }
  return true;                                                  // no Origin/Referer → non-browser client (allowed)
}

async function handleDocWrite(action: "save" | "publish", slug: string, req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string, actor: string, roadmapRepoFileStrategy: string | undefined, successPath: string | undefined, pg: typeof page): Promise<void> {
  let form: URLSearchParams;
  // If the body was rejected (too large / aborted), the socket may already be destroyed — only respond
  // when the response is still writable, so we never throw write-after-destroy into the outer catch.
  try { form = await parseFormBody(req); }
  catch (e) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: (e as Error).message }); return; }
  // kind is SERVER-derived (never a form field, §17/DL-9): the stored doc's kind, or — for a first
  // draft — the slug itself when it names a singleton gated kind (the docPage create affordance).
  const d = resolveDoc(writeDb, projectId, slug);
  const kind = d?.kind ?? (isSingletonKind(slug) ? slug : undefined);
  if (!kind) return json(res, 404, { error: `no document '${slug}' in ${projectKey}` });
  // create-collision guard: the singleton kinds are UNIQUE per project — creating slug X while the
  // kind already lives at slug Y would trip the partial unique index (a 500); refuse it as a conflict.
  if (!d && resolveDoc(writeDb, projectId, undefined, kind)) {
    return json(res, 409, { error: `CONFLICT: a '${kind}' document already exists under another slug` });
  }
  // DL-14: on a rejected re-render, preserve the user's submitted body in the textarea (so a CAS
  // conflict / validation error doesn't discard a substantial edit). docPage recomputes the hidden
  // `baseVersion` from the current latest, so an immediate re-submit targets the right base.
  const rerender = (msg: string, submittedBody?: string) => {
    const inner = docPage(db, projectId, projectKey, slug, { canEdit: true, canPublish: actor === "operator", notice: { kind: "error", msg }, submittedBody, roadmapRepoFileStrategy });
    return typeof inner === "string"
      ? htmlOut(res, statusForDocErr(msg), pg(`${slug} · ${projectKey}`, projectKey, inner, { active: "docs", drafts: draftsPendingCount(db, projectId) }))
      : json(res, statusForDocErr(msg), { error: msg }); // doc vanished mid-flight — no page to re-render
  };
  const done = href(projectKey, successPath ?? `/doc/${encodeURIComponent(slug)}`); // PRG target (the legacy alias keeps /roadmap → its 302)

  if (action === "save") {
    const baseVersion = Number(form.get("baseVersion"));
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return json(res, 400, { error: "baseVersion must be a non-negative integer" });
    const r = docSave(writeDb, projectId, actor, { slug, kind: kind as DocKind, body: form.get("body") ?? "", baseVersion, summary: form.get("summary") ?? undefined });
    return r.ok ? redirect(res, done) : rerender(r.error, form.get("body") ?? ""); // 409 CONFLICT (stale base) — surfaced, and the typed edit is preserved (DL-14)
  }
  // design is NEVER publish-gated — the latest draft IS the live design (docstore DL-split semantics).
  // The UI renders no publish button for it; refuse a hand-crafted POST too, or a stray 'current' pin
  // would freeze default reads on an old version while later drafts silently go unread (codex 2026-07-11).
  if (kind === "design") return json(res, 409, { error: "CONFLICT: 'design' docs are never published — the latest draft is live" });
  const version = Number(form.get("version"));
  if (!Number.isInteger(version) || version <= 0) return json(res, 400, { error: "version must be a positive integer" });
  const r = docPublish(writeDb, projectId, actor, { slug, version });
  return r.ok ? redirect(res, done) : rerender(r.error); // non-operator → 403; missing version → 404
}

// ─── DL-29: opt-in human web-write surface (design §11 subsystem D) ──────────────────────────────
// POST /ticket (create) · /ticket/:id/comment · /ticket/:id/move · /ticket/:id/assign. Present ONLY when
// a write connection + actor exist (canWrite) AND settings_json.humanWrite.enabled is true. Read FRESH per
// request so the operator can flip the flag without a daemon restart. Absent/false ⇒ these POSTs are NOT
// matched and fall through to the read-only 405 (byte-identical to today). The same localhost CSRF /
// DNS-rebinding guard as /roadmap/* (writeOriginOk) runs BEFORE any write.
// The predicate itself now lives in `project-settings.ts` (LOOP-481): `doctor` needs the same gate to
// know whether W20 may prescribe the board page, and it must not import this file to get it — this
// module's graph reaches zod, and doctor runs on every boot. Imported by both, defined once.
function isTicketWriteRoute(seg: string[]): boolean {
  return (seg.length === 1 && seg[0] === "ticket")
    || (seg.length === 3 && seg[0] === "ticket" && (seg[2] === "comment" || seg[2] === "move" || seg[2] === "assign"));
}
async function handleTicketWrite(seg: string[], req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string, actor: string, pg: typeof page): Promise<void> {
  let form: URLSearchParams;
  try { form = await parseFormBody(req); }
  catch (e) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: (e as Error).message }); return; }

  if (seg.length === 1) { // POST /ticket — create, then PRG to the new ticket
    const r = createTicket(writeDb, projectId, actor, { title: form.get("title") ?? "", description: form.get("description") ?? undefined, type: form.get("type") ?? undefined });
    if (r.ok) return redirect(res, href(projectKey, `/ticket/${encodeURIComponent(r.id)}`));
    // DL-86: a rejected create re-renders the BOARD as HTML with the error inline + the typed title preserved
    // (mirrors the /roadmap/save rerender), instead of dead-ending the operator on a raw-JSON {error} page.
    return htmlOut(res, r.status, pg(`${projectKey} · board`, projectKey, boardPage(db, projectId, projectKey, {}, true, undefined, { notice: { kind: "error", msg: r.error }, submittedTitle: form.get("title") ?? "" }), { active: "board" }));
  }
  const id = decodeSeg(seg[1]);
  if (id === null) return json(res, 400, { error: "malformed percent-escape in path" });
  const verb = seg[2];
  const r = verb === "comment" ? addComment(writeDb, projectId, actor, id, form.get("body") ?? "")
    : verb === "move" ? moveTicket(writeDb, projectId, actor, id, form.get("state") ?? "")
    : assignTicket(writeDb, projectId, actor, id, form.get("assignee") ?? "");
  if (r.ok) return redirect(res, href(projectKey, `/ticket/${encodeURIComponent(id)}`));
  // DL-86: a rejected move/assign/comment re-renders the TICKET PAGE as HTML with the error inline (+ the typed
  // comment preserved on a rejected comment), instead of a raw-JSON dead-end. If the ticket is gone (ticketPage
  // null) fall back to the JSON error — there is no page to re-render.
  const inner = ticketPage(db, projectId, projectKey, id, true, { notice: { kind: "error", msg: r.error }, submittedComment: verb === "comment" ? (form.get("body") ?? "") : undefined });
  if (!inner) return json(res, r.status, { error: r.error });
  return htmlOut(res, r.status, pg(`${id} · ${projectKey}`, projectKey, inner, { active: "board" }));
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
async function handleAgentOp(op: string, req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string, authedByToken = false): Promise<void> {
  if (!isAgentOp(op)) return json(res, 404, { error: `unknown op '${op}'` });
  // (1) CSRF / DNS-rebinding wall FIRST — uniform over every op. A non-browser agent client (the shim, curl,
  //     tests) sends no Origin ⇒ allowed; a browser cross-origin / foreign-Host POST is refused before anything.
  //     A bearer-authed request (attach / a reverse proxy injecting the token) bypasses the Host heuristic —
  //     see the loopback-Host invariant note (§6.2): a bearer is strictly stronger than locality.
  if (!authedByToken && !writeOriginOk(req)) return json(res, 403, { error: "op refused: cross-origin or non-localhost Host (CSRF / DNS-rebinding guard)" });
  // (2) actor from the header, validated against `actors` (the G1 phantom-actor guard — every write/comment
  //     must be attributable, exactly like the stdio server's DEVLOOP_ACTOR start guard).
  const actor = (req.headers["x-devloop-actor"] as string | undefined)?.trim();
  if (!actor) return json(res, 400, { error: "missing X-Devloop-Actor header (the caller's actor)" });
  if (!actorExists(writeDb, actor)) return json(res, 400, { error: `unknown actor '${actor}'` });
  // fireId is ATTRIBUTION only — never authorization; never added to the G1 phantom-actor guard (LOOP-75).
  // null when header absent so logEvent uses the null-state (no env fallback for daemon-side requests).
  const reqFireId = (req.headers["x-devloop-fire-id"] as string | undefined)?.trim() || null;
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
  // Run the dispatch inside the fireId ALS scope so logEvent() stamps the right request's fireId.
  // Concurrent requests each run in their own scope — no cross-talk (the AsyncLocalStorage guarantee).
  const r = await fireIdStore.run(reqFireId, () => agentOp(op, isWrite ? writeDb : db, ov.projectId, ov.projectKey, actor, args));
  return json(res, r.status, r.body);
}

// Build the HTTP server over an already-opened, project-resolved db. Exported so tests (and a later
// in-process embed) can start it without the CLI bootstrap below. GET routes issue ONLY SELECTs; the
// optional DL-3 /roadmap/* POST routes write the roadmap doc through the separate `writeDb` connection.
// F2 (D2): one daemon serves EVERY hub project — /p/<key>/… re-resolves the project per request, bare
// paths fall back to the boot project, and bare GET / is the hub project index (or the single-real-
// project redirect), so the workspace hub is never a dead `_team` landing again.
// All per-project background notifiers, wired in one place (1.8.1 quality-gauntlet drain: the
// listen-callback anon was the post-1.8 ceiling — CRAP 156 purely because NO test ever reached the
// listen path: spawned daemons die by SIGKILL before V8 flushes coverage. Extracted + exported so the
// wiring is unit-testable without a socket; test/notifier-wiring.ts holds the regression.)
export function startProjectNotifiers(deps: {
  writeDb: DatabaseSync; projectId: string; projectKey: string; actorLabel?: string; baseUrl: string;
  dbPath: string; cadenceHours: number; noProgressWindowHours: number;
  fhWindowHours: number; fhMinFires: number; fhThreshold: number; ledgerPath?: string;
  projCfg: Record<string, unknown> | undefined; notify: unknown; log?: (line: string) => void;
}): { active: string[]; timers: Array<ReturnType<typeof setInterval>> } {
  const { writeDb, projectId, projectKey, baseUrl, notify } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const active: string[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const track = (name: string, t: unknown, line: string) => { if (t) { active.push(name); timers.push(t as ReturnType<typeof setInterval>); log(line); } };
  // Human-Blocked notifier (option b): owns first-ping + reminders on service. No channel / cadence≤0 ⇒ no-op.
  track("blocked", startBlockedNotifier({ writeDb, projectId, projectKey, baseUrl, cadenceHours: deps.cadenceHours, notify }),
    `[daemon] decision-queue notifier active (Human-Blocked ∪ In Review@operator, every ${deps.cadenceHours}h via the configured channel / §9 notify webhook)`);
  // DL-76: loop no-progress / runaway circuit-breaker — alert ONCE when 0 accepted change (Done) lands in the
  // rolling window. No channel/notify OR noProgressWindowHours≤0 ⇒ no-op (mirrors the Human-Blocked notifier).
  track("no-progress", startNoProgressNotifier({ writeDb, projectId, projectKey, baseUrl, windowHours: deps.noProgressWindowHours, notify }),
    `[daemon] no-progress detector active (alert on 0 accepted change in ${deps.noProgressWindowHours}h via the configured channel / §9 notify webhook)`);
  // P0-1c: the loop fire-health self-monitor — ops watches prod; THIS watches the loop itself.
  const fhLedger = deps.ledgerPath ?? (() => { try { const ws = tryResolveWorkspace(); return ws ? wsFireLedger(ws) : ""; } catch { return ""; } })();
  track("fire-health", startFireHealthNotifier({ writeDb, projectId, projectKey, baseUrl, ledgerPath: fhLedger, windowHours: deps.fhWindowHours, minFires: deps.fhMinFires, threshold: deps.fhThreshold, notify }),
    `[daemon] fire-health monitor active (alert when success <${Math.round(deps.fhThreshold * 100)}% over ${deps.fhWindowHours}h with ≥${deps.fhMinFires} fires; one alert per episode)`);
  // Docs P3: passive-intake foreign-doc-edit notifier — under intake.mode:"passive" PM's doc-watch is off,
  // so an unconsumed HUMAN (non-agent) doc version emits one comms line, deduped per version.
  const intakeMode = (deps.projCfg?.intake as { mode?: string } | undefined)?.mode;
  track("foreign-docs", startDocForeignEditNotifier({ writeDb, projectId, projectKey, baseUrl, intakeMode, notify }),
    `[daemon] passive-intake doc-edit notifier active (operator/web doc edits → one comms line per version)`);
  // Docs P3b: the repo-FILE twin — watch the strategy file's content hash; one deduped line per settled edit.
  const strategyFile = repoFileStrategyPath(deps.projCfg as Parameters<typeof repoFileStrategyPath>[0]);
  track("strategy-file", startStrategyFileEditNotifier({ writeDb, projectId, projectKey, intakeMode, filePath: strategyFile?.abs, displayPath: strategyFile?.display, notify }),
    `[daemon] passive-intake strategy-file watch active (${strategyFile?.display ?? ""} → one comms line per settled edit)`);
  // Docs P6b: drafts-pending notifier — one DAILY line while a gated doc's drafts trail its published current.
  track("drafts-pending", startDocDraftsPendingNotifier({ writeDb, projectId, projectKey, baseUrl, notify }),
    `[daemon] drafts-pending notifier active (daily line while a doc draft trails its published version)`);
  // P3b: bound the single-writer connection's WAL via a DEDICATED busy_timeout=0 maintenance connection.
  startWalCheckpoint(deps.dbPath);
  active.push("wal-checkpoint");
  log(`[daemon] WAL checkpoint active (periodic TRUNCATE on a dedicated non-blocking connection)`);
  // LOOP-339 trigger 1 — the cadence. AC1 of LOOP-303 is "a snapshot the operator does not have to
  // remember to take"; a verb nobody invokes is exactly the state that lost 19 tickets on
  // 2026-08-04. everyHours: 0 ⇒ not started at all, the same posture every other notifier has.
  try {
    const ws = tryResolveWorkspace();
    if (ws) {
      const cfg = resolveBackupConfig(ws.file.team as Parameters<typeof resolveBackupConfig>[0], wsStateRoot(ws));
      const snapTimer = startBoardSnapshot({ dbPath: deps.dbPath, dir: cfg.dir, keep: cfg.keep, intervalMs: cfg.intervalMs, log });
      if (snapTimer) {
        timers.push(snapTimer);
        active.push("board-snapshot");
        log(`[daemon] board snapshot active (every ${Math.round(cfg.intervalMs / 60_000)} min, keep ${cfg.keep} → ${cfg.dir})`);
      } else log(`[daemon] board snapshot DISABLED (team.backup.everyHours = 0)`);
    }
  } catch (e) { log(`[daemon] board snapshot not started: ${(e as Error)?.message ?? String(e)}`); }
  return { active, timers };
}

// ── LOOP-116: the HTTP request handler is decomposed per-seam so no single function trips the CC/CRAP
//    merge gate as new daemon routes land (precedent: LOOP-22/24 red ratchet blocked ALL merges →
//    LOOP-33 stripGo split). The createDaemon callback below is a THIN orchestrator that calls these
//    helpers IN THE SAME ORDER, each returning a `handled` signal, so the dispatch sequence and every
//    response byte stay byte-identical to the pre-split handler (hub/test asserts every route).
//    SECURITY INVARIANT: enforceBearer() runs BEFORE resolvePathProject() in the orchestrator — an
//    unauthenticated /p/<unknown>/… must 401 (auth), never 404 (a key-existence leak). Locked by the
//    auth-before-resolution assertion in hub/test/ui-token.ts.

// Per-request dispatch context: the resolved request + the daemon-lifetime deps the route groups read.
interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  rawPath: string;
  seg: string[];
  path: string;
  projectId: string;
  projectKey: string;
  prefixed: boolean;
  authedByToken: boolean;
  db: DatabaseSync;
  writeDb?: DatabaseSync;
  canWrite: boolean;
  actor?: string;
  pg: (title: string, project: string, inner: string, opts?: Parameters<typeof page>[3]) => string;
  divergenceFor: (key: string) => string | undefined;
  getBasePageOpts: () => { workspaceId: string; daemonVersion: string; cliVersion?: string; daemonIsNewer?: boolean };
  dbPath: string;
  opened?: { path: string; ino: number };  // LOOP-367: the path+inode this daemon opened; a later mismatch = swapped
  entryPath?: string;
  stream: { count: number; max: number };
}

type ResolveResult =
  | { done: true }
  | { done: false; seg: string[]; path: string; projectId: string; projectKey: string; prefixed: boolean };

// SEAM 1 — the bearer gate (one-click P1 §6.2). With a token configured, EVERY request except GET
// /api/health must present it. Runs FIRST, before any project/DB work, so it can never leak whether a
// /p/<key> exists to an unauthenticated caller. Returns true iff it wrote the 401 (caller stops).
function enforceBearer(res: ServerResponse, uiToken: string | null, authedByToken: boolean, rawPath: string): boolean {
  if (uiToken !== null && !authedByToken && rawPath !== "/api/health") {
    res.setHeader("www-authenticate", "Bearer");
    json(res, 401, { error: "unauthorized: this daemon requires Authorization: Bearer <token> (DEVLOOP_UI_TOKEN)" });
    return true;
  }
  return false;
}

// SEAM 2 — F2 (D2) per-request project resolution: /p/<key>/… resolves <key> against the projects table
// and strips the prefix; a bare path keeps the boot project. SAFE_KEY is defense-in-depth (codex
// 2026-07-11): the resolved key later feeds filesystem joins (reportsRoot), so a path-derived key must be
// a single safe name (no "/", no leading "." ⇒ no ".." traversal) BEFORE it is looked up. An out-of-grammar
// key can't be a real config project, so it 404s like any unknown key. Returns {done:true} once it has
// written a response, else the resolved routing state for the dispatch.
function resolvePathProject(res: ServerResponse, db: DatabaseSync, seg0: string[], bootProjectId: string, bootProjectKey: string, pg: RouteCtx["pg"]): ResolveResult {
  let seg = seg0, projectId = bootProjectId, projectKey = bootProjectKey, prefixed = false;
  if (seg[0] === "p" && seg.length >= 2) {
    const key = decodeSeg(seg[1]);
    if (key === null) { json(res, 400, { error: "malformed percent-escape in path" }); return { done: true }; }
    const row = SAFE_KEY.test(key)
      ? db.prepare("SELECT id,key FROM projects WHERE key=?").get(key) as { id: string; key: string } | undefined
      : undefined;
    if (!row) { htmlOut(res, 404, pg("Not found", "", `<a class="back" href="/">← projects</a><p class="empty">No project <code>${esc(key)}</code> on this hub.</p>`, { hub: true })); return { done: true }; }
    prefixed = true; projectId = row.id; projectKey = row.key; seg = seg.slice(2);
  }
  const path = "/" + seg.join("/"); // the project-local path (prefix stripped; equals rawPath when bare)
  return { done: false, seg, path, projectId, projectKey, prefixed };
}

// SEAM 3a — the write surface: doc save/publish (+ /roadmap aliases), human ticket writes, and the DL-43
// agent op-API. Each rides its DL-29/DL-43 gate (canWrite AND the RESOLVED project's FRESH humanWrite /
// opt-in) and the DL-19 Origin/Host guard BEFORE any mutation; the op-API owns the whole /api/op/* path
// (a dormant mount 404s). Bodies delegate to handleDocWrite / handleTicketWrite / handleAgentOp.
async function handleWriteRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, method, seg, path, projectId, projectKey, authedByToken, db, writeDb, canWrite, actor, pg, divergenceFor } = ctx;
  const isDocWrite = seg.length === 3 && seg[0] === "doc" && (seg[2] === "save" || seg[2] === "publish");
  const isRoadmapAlias = path === "/roadmap/save" || path === "/roadmap/publish";
  if (method === "POST" && canWrite && (isDocWrite || isRoadmapAlias) && humanWriteEnabled(db, projectId)) {
    if (!authedByToken && !writeOriginOk(req)) { json(res, 403, { error: "write refused: cross-origin or non-localhost Host (CSRF / DNS-rebinding guard)" }); return true; }
    let slug: string;
    if (isDocWrite) {
      const s = decodeSeg(seg[1]);
      if (s === null) { json(res, 400, { error: "malformed percent-escape in path" }); return true; }
      slug = s;
    } else {
      slug = roadmapDocSlug(writeDb!, projectId); // the alias hard-targets the roadmap doc — never caller input
    }
    await handleDocWrite(seg[seg.length - 1] as "save" | "publish", slug, req, res, db, writeDb!, projectId, projectKey, actor!, divergenceFor(projectKey), isRoadmapAlias ? "/roadmap" : undefined, pg);
    return true;
  }
  if (method === "POST" && canWrite && humanWriteEnabled(db, projectId) && isTicketWriteRoute(seg)) {
    if (!authedByToken && !writeOriginOk(req)) { json(res, 403, { error: "write refused: cross-origin or non-localhost Host (CSRF / DNS-rebinding guard)" }); return true; }
    await handleTicketWrite(seg, req, res, db, writeDb!, projectId, projectKey, actor!, pg);
    return true;
  }
  if (seg[0] === "api" && seg[1] === "op") {
    if (method === "POST" && canWrite && seg.length === 3 && agentApiEnabled(db, projectId)) {
      await handleAgentOp(seg[2], req, res, db, writeDb!, projectId, projectKey, authedByToken);
      return true;
    }
    json(res, 404, { error: `not found: ${path}` });
    return true;
  }
  return false;
}

// SEAM 4 — the HTML views: the bare-GET-/ project index (with D2's single-real-project redirect) and the
// F1 typed view-route registry (board / roadmap / activity / reports / ticket). View patterns never
// overlap /api/*, so this leaves the JSON surface untouched.
function handleViewRoutes(ctx: RouteCtx): boolean {
  const { res, method, url, seg, path, prefixed, projectId, projectKey, db, canWrite, actor, pg, divergenceFor, getBasePageOpts } = ctx;
  if (!prefixed && path === "/") {
    // LOOP-271: the switcher lists what an operator can switch TO. A scratch project can never fire,
    // so listing it offers a destination that does nothing. Direct navigation still resolves.
    const real = db.prepare(`SELECT key FROM projects WHERE key<>? AND ${NOT_SCRATCH_SQL} ORDER BY key`).all(TEAM_INTAKE_PROJECT) as { key: string }[];
    if (real.length === 1) {
      res.writeHead(302, { location: href(real[0].key, `/${url.search}`), "content-length": 0 });
      res.end();
      return true;
    }
    htmlOut(res, 200, pg("projects · dev-loop hub", "", projectIndexPage(db, Date.now()), { hub: true }));
    return true;
  }
  const vm = matchViewRoute(method, seg);
  if (vm) {
    const out = vm.route.handler({
      db, projectId, projectKey, url, params: vm.params,
      humanWrite: () => canWrite && humanWriteEnabled(db, projectId),
      writable: canWrite,
      canPublish: canWrite && actor === "operator",
      roadmapRepoFileStrategy: divergenceFor(projectKey),
      draftsPending: () => draftsPendingCount(db, projectId), // docs P6a header chip — LAZY, resolved-project scope
      basePageOpts: getBasePageOpts(), // LOOP-52 board identity
    });
    if (out.kind === "redirect") { // D3: /roadmap → the roadmap doc page; /doc/<kind> → its canonical slug
      res.writeHead(out.status, { location: out.location, "content-length": 0 });
      res.end();
      return true;
    }
    if (out.kind === "html") htmlOut(res, out.status, out.html);
    else json(res, out.status, out.body);
    return true;
  }
  return false;
}

// SEAM 5 — GET /api/stream: the SSE live-update channel (poll-push; an O(1) max(events.id) read that
// emits only when it advances). Bounds concurrent connections via ctx.stream, follows the RESOLVED
// project (?all=1 on the bare path watches the whole ledger), and tears down on close. Writes to res
// directly (a streaming response, not a descriptor).
function serveStream(ctx: RouteCtx): void {
  const { req, res, url, prefixed, projectId, db, stream } = ctx;
  if (stream.count >= stream.max) { json(res, 503, { error: "too many live connections" }); return; }
  stream.count++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive", "x-accel-buffering": "no" });
  const all = !prefixed && url.searchParams.get("all") === "1";
  const maxId = all
    ? (): number => Number((db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM events").get() as { m: number }).m)
    : (): number => Number((db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM events WHERE project_id=?").get(projectId) as { m: number }).m);
  let last = maxId();
  res.write(`retry: 3000\ndata: ${last}\n\n`); // initial baseline + client reconnect hint
  const iv = setInterval(() => {
    try { const now = maxId(); if (now !== last) { last = now; res.write(`data: ${now}\n\n`); } else { res.write(": ping\n\n"); } }
    catch { /* transient read error — the next tick retries; never crash the daemon */ }
  }, 2000);
  iv.unref?.();
  const done = () => { clearInterval(iv); stream.count--; };
  req.on("close", done); res.on("close", done);
}

// SEAM 3b — the JSON read surface, in the ORIGINAL order: /api index, /api/stream (→ serveStream, SEAM 5),
// health, tickets, tickets/:id, docs, docs/:kind, then the terminal 404 fallthrough (an unknown /api/* →
// JSON 404; a page navigation → the friendly HTML 404, DL-36). Always returns true — it owns the dispatch tail.
function handleApiRoutes(ctx: RouteCtx): boolean {
  const { res, url, seg, path, projectId, projectKey, db, writeDb, actor, pg, rawPath } = ctx;
  if (path === "/api") {
    json(res, 200, {
      name: "dev-loop-hub daemon", project: projectKey, readOnly: true,
      ui: "/", endpoints: ["/api/health", "/api/tickets", "/api/tickets/:id", "/api/docs", "/api/docs/:kind"],
    });
    return true;
  }
  if (path === "/api/stream") { serveStream(ctx); return true; }
  if (path === "/api/health") {
    const h = healthLiveness(db, writeDb, projectId, ctx.opened);
    // §16: expose dbPresent as a BOOLEAN only — /api/health bypasses the UI token (daemon.ts:471)
    // so the raw DB path must never appear here; the boolean is sufficient for the reaper (LOOP-95).
    // Use ctx.dbPath (the actual opened path) not workspaceId (which ignores DEVLOOP_HUB_DB overrides).
    const dbPresent = existsSync(ctx.dbPath);
    const buildCommit = pkgBuildCommit();
    json(res, h.ok ? 200 : 503, h.ok
      ? { ok: true, service: "dev-loop-hub", pid: process.pid, project: projectKey, version: pkgVersion(), buildCommit, actor, dbPresent, entryPath: ctx.entryPath }
      : { ok: false, service: "dev-loop-hub", pid: process.pid, project: projectKey, version: pkgVersion(), buildCommit, actor, dbPresent, error: h.error, entryPath: ctx.entryPath });
    return true;
  }
  if (path === "/api/tickets") {
    // LOOP-96 — this path and the HTML board were the only two of the four board-list reads with no
    // bound at all: SELECT * of every ticket, full descriptions included, on every request. Measured
    // on a 95-ticket board: 433.6 KiB per call, of which 92% was description text — and
    // `?fields=summary` was accepted and SILENTLY IGNORED, so the documented way to ask for a cheap
    // read returned the expensive one. `db.ts` already names all three ticket paths as one family;
    // one of the three got the cap (list_issues, 250) and two did not. Same cap, same summary shape.
    //
    // The bound is in SQL (LIMIT), not a .slice() after loading the table — a slice still pays for
    // every row's read and JSON.parse, which is the cost this exists to remove.
    const rawLimit = url.searchParams.get("limit");
    let limit = API_TICKETS_DEFAULT_LIMIT;
    if (rawLimit !== null) {
      const n = Number(rawLimit);
      // An unparseable/negative/zero limit is a caller mistake. Follow the list_events precedent — a
      // clean 400 — rather than the old ignore-and-default, which silently answered a different
      // question than the one asked.
      if (!Number.isInteger(n) || n <= 0) { json(res, 400, { error: `limit must be a positive integer (got ${JSON.stringify(rawLimit)})` }); return true; }
      limit = n;
    }
    const total = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE project_id=?").get(projectId) as { n: number }).n;
    let out = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC LIMIT ?").all(projectId, limit) as Record<string, any>[]).map(toTicket);
    const state = url.searchParams.get("state"); if (state) out = out.filter((t) => t.state === state);
    const type = url.searchParams.get("type"); if (type) out = out.filter((t) => t.type === type);
    const label = url.searchParams.get("label"); if (label) out = out.filter((t) => t.labels.includes(label));
    const assignee = url.searchParams.get("assignee"); if (assignee) out = out.filter((t) => t.assignee === assignee);
    // The summary shape list_issues already serves: drop the description body, which is the bulk of
    // the bytes. It was accepted and ignored here, which is worse than not supporting it.
    if (url.searchParams.get("fields") === "summary") out = out.map((t) => { const { description: _drop, ...rest } = t as Record<string, unknown>; return rest; }) as typeof out;
    res.setHeader("X-Total-Count", String(total));      // truncation is detectable without changing the body shape
    res.setHeader("X-Returned-Count", String(out.length));
    json(res, 200, out);
    return true;
  }
  if (seg[0] === "api" && seg[1] === "tickets" && seg.length === 3) {
    const id = decodeSeg(seg[2]);
    if (id === null) { json(res, 400, { error: "malformed percent-escape in path" }); return true; }
    const r = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as Record<string, any> | undefined;
    if (!r) { json(res, 404, { error: `no such ticket ${id} in ${projectKey}` }); return true; }
    const comments = db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id);
    json(res, 200, { ...toTicket(r), comments });
    return true;
  }
  if (path === "/api/docs") {
    json(res, 200, db.prepare("SELECT kind,slug,title,status,current_version,updated_at FROM documents WHERE project_id=? ORDER BY kind").all(projectId));
    return true;
  }
  if (seg[0] === "api" && seg[1] === "docs" && seg.length === 3) {
    const key = decodeSeg(seg[2]);
    if (key === null) { json(res, 400, { error: "malformed percent-escape in path" }); return true; }
    const d = (db.prepare("SELECT * FROM documents WHERE project_id=? AND kind=?").get(projectId, key)
      ?? db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, key)) as Record<string, any> | undefined;
    if (!d) { json(res, 404, { error: `no document '${key}' in ${projectKey}` }); return true; }
    const ver = d.current_version > 0
      ? d.current_version
      : ((db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(d.id) as { v: number | null }).v ?? 0);
    if (ver === 0) { json(res, 200, { kind: d.kind, slug: d.slug, title: d.title, status: d.status, version: 0, body: "", unpublished: true, empty: true }); return true; }
    const v = db.prepare("SELECT version,body,status,summary,base_version,author,created_at FROM document_versions WHERE doc_id=? AND version=?").get(d.id, ver) as Record<string, any>;
    json(res, 200, { kind: d.kind, slug: d.slug, title: d.title, status: d.status, current_version: d.current_version, ...v, ...(d.current_version === 0 ? { unpublished: true } : {}) });
    return true;
  }
  if (seg[0] === "api") { json(res, 404, { error: `not found: ${rawPath}` }); return true; }
  htmlOut(res, 404, pg("Not found", projectKey, `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a><p class="empty">No page <code>${esc(rawPath)}</code> in ${esc(projectKey)}.</p>`));
  return true;
}

// semver direction: true when a < b. Unparseable → false.
function semverBefore(a: string, b: string): boolean {
  const pa = a.match(/^(\d+)\.(\d+)\.(\d+)/), pb = b.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d !== 0) return d < 0; }
  return false;
}
export function createDaemon({ db, projectId: bootProjectId, projectKey: bootProjectKey, writeDb, actor, roadmapRepoFileStrategy, daemonVersion: daemonVersionOpt, dbPath: daemonDbPath, entryPath: daemonEntryPath }: DaemonOpts): Server {
  const canWrite = !!writeDb && !!actor;
  const streamGate = { count: 0, max: 16 }; // bound concurrent SSE connections (one operator, a few tabs)
  // LOOP-52 board identity: record daemon's startup version + resolve the workspace hub.db path.
  // WS_ID is the authenticated surface's identity affordance — shows which workspace's board you're on.
  const DAEMON_VER = daemonVersionOpt ?? pkgVersion();
  const DAEMON_BUILD_COMMIT = pkgBuildCommit();
  const WS_ID = daemonDbPath ?? hubDbPath();
  // LOOP-367: the inode this daemon actually opened. Captured here rather than accepted as an option so no
  // caller can forget to pass it — every daemon, including the ones tests spawn, gets the swap check.
  const OPENED = ((): { path: string; ino: number } | undefined => {
    try { return { path: WS_ID, ino: statSync(WS_ID).ino }; } catch { return undefined; }
  })();
  // Per-request: compare DAEMON_VER with the on-disk version to detect an upgrade while the daemon runs.
  // LOOP-252: direction-aware — only set cliVersion (upgrade prompt) when daemon is OLDER; when daemon is
  // NEWER than the on-disk CLI, flag daemonIsNewer so the UI warns against running daemon up.
  const getBasePageOpts = (): { workspaceId: string; daemonVersion: string; cliVersion?: string; daemonIsNewer?: boolean } => {
    const freshVer = pkgVersionFresh();
    const freshCommit = pkgBuildCommitFresh();
    if (DAEMON_VER === freshVer) {
      if (freshCommit && DAEMON_BUILD_COMMIT && freshCommit !== DAEMON_BUILD_COMMIT)
        return { workspaceId: WS_ID, daemonVersion: DAEMON_VER, cliVersion: freshVer };
      return { workspaceId: WS_ID, daemonVersion: DAEMON_VER };
    }
    if (semverBefore(freshVer, DAEMON_VER)) return { workspaceId: WS_ID, daemonVersion: DAEMON_VER, cliVersion: freshVer, daemonIsNewer: true };
    return { workspaceId: WS_ID, daemonVersion: DAEMON_VER, cliVersion: freshVer };
  };
  const pg = (title: string, project: string, inner: string, opts: Parameters<typeof page>[3] = {}): string =>
    page(title, project, inner, { ...getBasePageOpts(), ...opts });
  // F2: the DL-83 divergence flag is per-PROJECT config, and opts carry only the BOOT project's
  // boot-resolved value — a /p/<key>/roadmap request for a SIBLING must not inherit it. Resolve a
  // sibling's flag from the same config source the boot path uses, cached per key (config resolution
  // is boot-time semantics — the boot value itself is a one-shot resolve, so a cache matches it).
  const divergenceCache = new Map<string, string | undefined>([[bootProjectKey, roadmapRepoFileStrategy]]);
  const divergenceFor = (key: string): string | undefined => {
    if (!divergenceCache.has(key)) {
      let v: string | undefined;
      try { v = roadmapDivergenceDoc(loadProjectsConfig()?.projects?.[key]); } catch { v = undefined; }
      divergenceCache.set(key, v);
    }
    return divergenceCache.get(key);
  };
  // One-click P1 (§6.2): the bearer gate. Resolved ONCE at createDaemon time (tests set the env before
  // constructing). With a token configured, EVERY request except GET /api/health (the probe surface —
  // kubelet/docker-healthcheck/lifecycle ensure cannot attach headers) must present it; without a token
  // the surface is byte-identical to the pre-token daemon (loopback bind enforced at boot).
  const uiToken = resolveUiToken();
  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { return json(res, 400, { error: "bad request url" }); }
    const rawPath = url.pathname.replace(/\/+$/, "") || "/";
    const authedByToken = uiToken !== null && bearerOk(req.headers.authorization, uiToken);
    // SEAM 1 — the bearer gate runs FIRST, before any project/DB work, so it can never leak whether a
    // /p/<key> exists to an unauthenticated caller (auth precedes resolution — ui-token.ts locks this).
    if (enforceBearer(res, uiToken, authedByToken, rawPath)) return;
    const seg0 = rawPath.split("/").filter(Boolean); // [] for "/"

    try {
      // SEAM 2 — per-request project resolution (/p/<key> + the SAFE_KEY guard, before any fs join).
      const rp = resolvePathProject(res, db, seg0, bootProjectId, bootProjectKey, pg);
      if (rp.done) return;
      const { seg, path, projectId, projectKey, prefixed } = rp;
      const ctx: RouteCtx = {
        req, res, method, url, rawPath, seg, path, projectId, projectKey, prefixed, authedByToken,
        db, writeDb, canWrite, actor, pg, divergenceFor, getBasePageOpts, dbPath: daemonDbPath ?? "", opened: OPENED, entryPath: daemonEntryPath, stream: streamGate,
      };

      // Under a /p/<key>/ prefix only the HTML views, write routes, and the project SSE stream are mounted;
      // the JSON /api/* surface (incl. the op-API + its D1 role-gated override) stays boot-scoped on the
      // bare path, so a URL prefix can never bypass the D1 override matrix.
      if (prefixed && seg[0] === "api" && !(seg.length === 2 && seg[1] === "stream")) {
        return json(res, 404, { error: `not found: ${rawPath}` });
      }
      // SEAM 3a — the write surface (doc / ticket / agent-op); each POST rides its gate + Origin guard.
      if (await handleWriteRoutes(ctx)) return;
      // READ-ONLY for everything else: any other non-GET is refused — the read surface never mutates (DL-1 AC).
      if (method !== "GET" && method !== "HEAD") {
        return json(res, 405, { error: "read-only daemon: only GET is allowed" });
      }
      // SEAM 4 — the HTML view routes (GET / index + the typed view registry).
      if (handleViewRoutes(ctx)) return;
      // SEAM 3b/5 — the JSON read surface + SSE + the terminal 404 (always handled).
      if (handleApiRoutes(ctx)) return;
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
  resolveBlockedReminderHours, startDocForeignEditNotifier, startDocDraftsPendingNotifier,
  fireHealthNotifyTick, startFireHealthNotifier,
};

// DL-41 dispatch — a lifecycle subcommand handles itself and exits; ANY other invocation (incl. the
// bare `npm run daemon`) falls through to today's foreground boot below, byte-for-byte unchanged.
// LOOP-154: `--help` must never be a daemon-spawn vector. `--help` is not a LIFECYCLE_SUB, so it fell
// straight through to the foreground boot below and started a REAL daemon on the surface the operator
// docs teach as the way to explore this CLI — then died on an unhandled EADDRINUSE. Answered here,
// before any bind, because the boot block is a top-level statement with no earlier exit.
if (isMainEntry(import.meta.url) && ["--help", "-h", "help"].includes(process.argv[2] ?? "")) {
  console.log(`usage: dev-loop daemon <${LIFECYCLE_SUBS.join("|")}>  — per-project daemon lifecycle (localhost web UI + agent op-API)

  up                 start (or adopt) the daemon for DEVLOOP_PROJECT; idempotent
  up-all             up every delivery project in the workspace
  down               stop this project's daemon and remove its runfile
  status             report pid/port/health for this project's daemon
  reap [--dry-run]   stop orphaned daemons (dbPresent:false) across the port band
  install-autostart | uninstall-autostart   manage the login autostart entry

Env: DEVLOOP_PROJECT (which board), DEVLOOP_DAEMON_HOST/PORT (bind), DEVLOOP_UI_TOKEN(_FILE) (non-loopback binds).
Running \`dev-loop daemon\` with no subcommand boots a FOREGROUND daemon — that is the server itself, not this help.`);
  process.exit(0);
}

if (isMainEntry(import.meta.url)
    && LIFECYCLE_SUBS.includes(process.argv[2] as LifecycleSub)) {
  await daemonLifecycle(process.argv[2] as LifecycleSub); // calls process.exit — never returns
}

// ─── CLI entry: `npm run daemon` — open db, resolve project (same guard as the MCP server), listen ──
// Only runs when executed directly (not on import — the test imports createDaemon and starts it itself).
if (isMainEntry(import.meta.url)) {
  const DB_PATH = hubDbPath();
  const PROJECT_KEY = process.env.DEVLOOP_PROJECT?.trim();
  // One-click P1 (§1.5/§6.2): the bind knob. Default stays the v4 loopback (§16). Widening it beyond
  // loopback (a container/pod must — probes and published ports reach the pod IP, never the container's
  // loopback) REQUIRES the bearer token: the loopback-Host write guard is only sufficient on a loopback
  // bind (its own invariant), so a widened, token-less daemon refuses to boot — fail closed, never a
  // silently weakened write surface.
  const HOST = process.env.DEVLOOP_DAEMON_HOST?.trim() || "127.0.0.1";
  const PORT = Number(process.env.DEVLOOP_DAEMON_PORT ?? 8787);
  if (!isLoopbackHost(HOST) && resolveUiToken() === null) {
    console.error(`[daemon] refusing to bind ${HOST}: DEVLOOP_DAEMON_HOST widens the bind beyond loopback without DEVLOOP_UI_TOKEN(_FILE) — the Host-allowlist write guard would silently weaken (see the isLoopbackHost invariant in ui-token.ts). Set a token, or drop the bind override.`);
    process.exit(1);
  }
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
  const server = createDaemon({ db, projectId, projectKey: PROJECT_KEY, writeDb, actor: ACTOR, roadmapRepoFileStrategy, dbPath: DB_PATH, entryPath: fileURLToPath(import.meta.url) });
  // DL-59: resolve the daemon's OWN view of the project config ONCE — the §9 `notify` webhook (so a project
  // with ONLY a notify webhook still receives reminders; team.comms is bridged into it by toLegacyView), the
  // comms presence (the workflows-P3 reminder default below), and intake.mode (the docs-P3 passive notifier).
  // §16: the block stays in config/env; the daemon reads it but never writes it to the DB. Read at BOOT:
  // an already-running daemon picks config changes up on restart only (references/config-schema.md).
  let projCfg: Record<string, unknown> | undefined;
  try { projCfg = loadProjectsConfig()?.projects?.[PROJECT_KEY] as Record<string, unknown> | undefined; } catch { projCfg = undefined; }
  const notify: unknown = projCfg?.notify;
  // DL-26: the per-project Human-Blocked reminder cadence (settings_json.humanBlockedReminderHours). Workflows
  // P3: ABSENT now defaults to 24h when the workspace has a comms channel (team.comms present) — explicit 0
  // stays the opt-out (resolveBlockedReminderHours). DL-76: the loop no-progress circuit-breaker window
  // (settings_json.noProgressWindowHours) from the SAME parse — operator-set, hours, 0/absent ⇒ off.
  const commsConfigured = projCfg?.comms !== undefined;
  let cadenceHours = resolveBlockedReminderHours(undefined, commsConfigured), noProgressWindowHours = 0;
  // P0-1c defaults: ON (2h window, ≥6 fires, <50% success) whenever a send target + a team fires ledger
  // exist; settings_json.fireHealth.windowHours=0 opts out; minFires/threshold tune from the same block.
  let fhWindowHours = 2, fhMinFires = 6, fhThreshold = 0.5;
  try {
    const row = writeDb.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    const settings = JSON.parse(row?.settings_json ?? "{}");
    cadenceHours = resolveBlockedReminderHours(settings, commsConfigured);
    noProgressWindowHours = Number(settings?.noProgressWindowHours) || 0;
    const fh = (settings?.fireHealth ?? {}) as { windowHours?: unknown; minFires?: unknown; threshold?: unknown };
    if (fh.windowHours !== undefined) fhWindowHours = Number(fh.windowHours) || 0;
    if (fh.minFires !== undefined && Number(fh.minFires) > 0) fhMinFires = Number(fh.minFires);
    if (fh.threshold !== undefined && Number(fh.threshold) > 0) fhThreshold = Number(fh.threshold);
  } catch { /* malformed settings_json ⇒ keep the comms-aware default + noProgress off */ }
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`[daemon] dev-loop-hub for '${PROJECT_KEY}' (actor=${ACTOR}${ACTOR === "operator" ? ", can publish" : ", drafts only"}) → http://${hostForUrl(HOST)}:${port}/  (reads read-only; /roadmap editable${isLoopbackHost(HOST) ? ", localhost-only" : ", bearer-token required (§6.2)"})`);
    const baseUrl = `http://${hostForUrl(isLoopbackHost(HOST) ? HOST : "127.0.0.1")}:${port}`; // notifier links stay reachable from the host itself
    startProjectNotifiers({ writeDb, projectId, projectKey: PROJECT_KEY, baseUrl, dbPath: DB_PATH,
      cadenceHours, noProgressWindowHours, fhWindowHours, fhMinFires, fhThreshold,
      projCfg: projCfg as Record<string, unknown> | undefined, notify });
  });
}
