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
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";

export interface DaemonOpts {
  db: DatabaseSync;
  projectId: string;
  projectKey: string;
}

// ticket row → API shape (mirrors the MCP server's toTicket; labels/related_to are JSON columns).
function toTicket(r: Record<string, any>) {
  return {
    id: r.id, title: r.title, description: r.description, type: r.type, state: r.state,
    assignee: r.assignee, priority: r.priority,
    labels: JSON.parse(r.labels), duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to),
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
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
  });
  res.end(body);
}

// ─── tiny inline web UI (DL-2): server-rendered, read-only, zero build step ───
// The board + ticket pages are plain HTML rendered server-side from the same read-only db
// connection the JSON API uses (PRAGMA query_only=ON) — no client JS, no bundler, no native
// deps. Every interpolated DB value passes through esc() (localhost-only + read-only, but the
// SoR holds arbitrary agent-authored text, so we escape it rather than trust it).
const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low", 0: "None" };
const CORE_STATES = ["Todo", "In Progress", "In Review", "Done"]; // always shown (Linear-like board)
const STATE_ORDER = ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled", "Duplicate"];
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s: unknown): string { return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]); }
function ownerOf(labels: string[]): string { return labels.includes("pm") ? "pm" : labels.includes("qa") ? "qa" : "—"; }
function prioOf(p: number): string { return PRIORITY[p] ?? String(p); }

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--line:#e2e5ea;--ink:#1c1e21;--mut:#6b7280}
@media(prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1e2126;--line:#2c3036;--ink:#e6e8eb;--mut:#9aa3af}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:baseline;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid var(--line)}
header .home{font-weight:700;text-decoration:none;color:var(--ink)}header .proj{color:var(--mut)}
main{padding:1rem}
.board{display:flex;gap:.8rem;align-items:flex-start;overflow-x:auto}
.col{flex:0 0 260px;background:transparent}
.col h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);margin:.2rem .2rem .5rem;font-weight:600}
.col .count{background:var(--line);color:var(--mut);border-radius:999px;padding:0 .45rem;margin-left:.3rem;font-size:.72rem}
.card{display:block;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.55rem .6rem;margin-bottom:.5rem;text-decoration:none;color:inherit}
.card:hover{border-color:var(--mut)}
.card-top{display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem}
.id{font:600 .72rem ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut)}
.title{font-weight:500;margin:.1rem 0}
.card-meta{display:flex;gap:.5rem;align-items:center;margin-top:.35rem;font-size:.74rem;color:var(--mut)}
.badge{font-size:.68rem;border:1px solid var(--line);border-radius:4px;padding:0 .35rem;color:var(--mut)}
.badge.t-Feature{color:#2563eb;border-color:#2563eb55}.badge.t-Bug{color:#dc2626;border-color:#dc262655}.badge.t-Improvement{color:#16a34a;border-color:#16a34a55}
.prio.p1{color:#dc2626;font-weight:600}.prio.p2{color:#d97706}
.empty{color:var(--mut);font-size:.8rem;padding:.3rem .2rem}
.back{display:inline-block;margin-bottom:.8rem;color:var(--mut);text-decoration:none}.back:hover{color:var(--ink)}
.detail{max-width:760px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.1rem 1.3rem}
.detail h1{font-size:1.4rem;margin:.4rem 0 .8rem}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:.25rem .8rem;margin:.6rem 0 1rem}
.meta dt{color:var(--mut)}.meta dd{margin:0}
.lbl{font-size:.7rem;border:1px solid var(--line);border-radius:4px;padding:0 .35rem;color:var(--mut);margin-right:.25rem}
pre{white-space:pre-wrap;word-wrap:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.7rem .8rem;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto}
h3{margin:1.2rem 0 .4rem;font-size:.95rem}
.comment{margin:.5rem 0}.c-head{font-size:.78rem;color:var(--mut);margin-bottom:.2rem}.c-head time{margin-left:.4rem}
`;

function page(title: string, project: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<style>${STYLE}</style></head><body>`
    + `<header><a class="home" href="/">dev-loop</a><span class="proj">${esc(project)}</span></header>`
    + `<main>${inner}</main></body></html>`;
}

function cardHtml(t: ReturnType<typeof toTicket>): string {
  return `<a class="card" href="/ticket/${encodeURIComponent(t.id)}">`
    + `<div class="card-top"><span class="id">${esc(t.id)}</span><span class="badge t-${esc(t.type)}">${esc(t.type)}</span></div>`
    + `<div class="title">${esc(t.title)}</div>`
    + `<div class="card-meta"><span class="owner">${esc(ownerOf(t.labels))}</span>`
    + `<span class="prio p${esc(t.priority)}">${esc(prioOf(t.priority))}</span></div></a>`;
}

// Board: tickets grouped into state columns. Core workflow columns always render (even empty);
// Backlog/Canceled/Duplicate and any other state show only when populated, terminals last.
function boardPage(db: DatabaseSync, projectId: string, projectKey: string): string {
  const tickets = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY priority ASC, updated_at DESC").all(projectId) as Record<string, any>[]).map(toTicket);
  const byState = new Map<string, ReturnType<typeof toTicket>[]>();
  for (const t of tickets) (byState.get(t.state) ?? byState.set(t.state, []).get(t.state)!).push(t);
  const states = [
    ...STATE_ORDER.filter((s) => CORE_STATES.includes(s) || byState.has(s)),
    ...[...byState.keys()].filter((s) => !STATE_ORDER.includes(s)),
  ];
  const cols = states.map((s) => {
    const cards = byState.get(s) ?? [];
    const body = cards.length ? cards.map(cardHtml).join("") : `<p class="empty">—</p>`;
    return `<section class="col"><h2>${esc(s)}<span class="count">${cards.length}</span></h2>${body}</section>`;
  }).join("");
  return `<div class="board">${cols}</div>` + (tickets.length === 0 ? `<p class="empty">No tickets in ${esc(projectKey)} yet.</p>` : "");
}

// Ticket detail: full description + comments. Returns null when the ticket is absent (→ 404).
function ticketPage(db: DatabaseSync, projectId: string, id: string): string | null {
  const r = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as Record<string, any> | undefined;
  if (!r) return null;
  const t = toTicket(r);
  const comments = db.prepare("SELECT author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as Record<string, any>[];
  const commentsHtml = comments.length
    ? comments.map((c) => `<div class="comment"><div class="c-head"><b>${esc(c.author)}</b><time>${esc(c.created_at)}</time></div><pre>${esc(c.body)}</pre></div>`).join("")
    : `<p class="empty">No comments yet.</p>`;
  return `<a class="back" href="/">← board</a><article class="detail">`
    + `<div class="card-top"><span class="id">${esc(t.id)}</span><span class="badge t-${esc(t.type)}">${esc(t.type)}</span><span class="badge">${esc(t.state)}</span></div>`
    + `<h1>${esc(t.title)}</h1>`
    + `<dl class="meta"><dt>Owner</dt><dd>${esc(ownerOf(t.labels))}</dd>`
    + `<dt>Priority</dt><dd>${esc(prioOf(t.priority))}</dd>`
    + `<dt>Assignee</dt><dd>${esc(t.assignee ?? "—")}</dd>`
    + `<dt>Labels</dt><dd>${t.labels.map((l: string) => `<span class="lbl">${esc(l)}</span>`).join("")}</dd></dl>`
    + `<h3>Description</h3><pre>${esc(t.description)}</pre>`
    + `<h3>Comments<span class="count" style="margin-left:.4rem">${comments.length}</span></h3>${commentsHtml}</article>`;
}

// Defensively decode a single URL path segment. A malformed / incomplete percent-escape
// (e.g. "%", "%ZZ", an incomplete UTF-8 sequence "%E0%A4") makes decodeURIComponent throw a
// URIError — that is a CLIENT error, so callers surface 400 (matching the daemon's existing
// "bad request url" → 400 contract) instead of letting it fall through to the generic 500 catch
// (DL-7). Returns null when the segment cannot be decoded.
function decodeSeg(seg: string): string | null {
  try { return decodeURIComponent(seg); } catch { return null; }
}

// Build the HTTP server over an already-opened, project-resolved db. Exported so tests (and a later
// in-process embed) can start it without the CLI bootstrap below. The handler issues ONLY SELECTs.
export function createDaemon({ db, projectId, projectKey }: DaemonOpts): Server {
  return createServer((req, res) => {
    // READ-ONLY: anything but GET/HEAD is refused — the daemon never mutates the SoR (DL-1 AC).
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "read-only daemon: only GET is allowed" });
    }
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { return json(res, 400, { error: "bad request url" }); }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean); // [] for "/"

    try {
      // GET / — the web UI board (DL-2): server-rendered HTML, read-only, columns by state.
      if (path === "/") return htmlOut(res, 200, page(`${projectKey} · board`, projectKey, boardPage(db, projectId, projectKey)));

      // GET /ticket/:id — the web UI detail view (DL-2): full description + comments.
      if (seg[0] === "ticket" && seg.length === 2) {
        const id = decodeSeg(seg[1]);
        if (id === null) return json(res, 400, { error: "malformed percent-escape in path" });
        const inner = ticketPage(db, projectId, id);
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

      // GET /api/health — liveness.
      if (path === "/api/health") return json(res, 200, { ok: true, project: projectKey });

      // GET /api/tickets — board, project-scoped (§2), filter by state/type/label (+ optional limit).
      if (path === "/api/tickets") {
        let out = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as Record<string, any>[]).map(toTicket);
        const state = url.searchParams.get("state"); if (state) out = out.filter((t) => t.state === state);
        const type = url.searchParams.get("type"); if (type) out = out.filter((t) => t.type === type);
        const label = url.searchParams.get("label"); if (label) out = out.filter((t) => t.labels.includes(label));
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

      return json(res, 404, { error: `not found: ${path}` });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
}

// ─── CLI entry: `npm run daemon` — open db, resolve project (same guard as the MCP server), listen ──
// Only runs when executed directly (not on import — the test imports createDaemon and starts it itself).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const DB_PATH = process.env.DEVLOOP_HUB_DB ?? `${homedir()}/.dev-loop/hub.db`;
  const PROJECT_KEY = process.env.DEVLOOP_PROJECT ?? "demo";
  const HOST = "127.0.0.1"; // §16 localhost-only; NEVER 0.0.0.0
  const PORT = Number(process.env.DEVLOOP_DAEMON_PORT ?? 8787);

  const db = openDb(DB_PATH);
  db.exec("PRAGMA query_only=ON"); // structural read-only: this connection can never write the SoR
  // No ensureActors/auto-create here: like the MCP server's G2 guard, refuse to serve a phantom board.
  const projectId = findProject(db, PROJECT_KEY);
  if (!projectId) {
    console.error(`[daemon] unknown project '${PROJECT_KEY}'. Seed it first (e.g. start the hub, or \`node src/seed.ts ${PROJECT_KEY} "<name>" <PREFIX>\`). Refusing to serve a phantom board.`);
    process.exit(1);
  }
  const server = createDaemon({ db, projectId, projectKey: PROJECT_KEY });
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`[daemon] dev-loop-hub read API for '${PROJECT_KEY}' → http://${HOST}:${port}/  (read-only, localhost-only)`);
  });
}
