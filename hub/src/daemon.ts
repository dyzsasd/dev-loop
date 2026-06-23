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
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, actorExists } from "./db.ts";
import { findProject } from "./seed.ts";
import { resolveDoc, docSave, docPublish } from "./docstore.ts";

export interface DaemonOpts {
  db: DatabaseSync;          // read connection (PRAGMA query_only=ON) — every GET route reads through this
  projectId: string;
  projectKey: string;
  // DL-3 roadmap write surface (optional — absent ⇒ the daemon stays GET-only, exactly as DL-1/DL-2):
  writeDb?: DatabaseSync;    // a SEPARATE writable connection used ONLY by the /roadmap/* write routes
  actor?: string;            // the daemon's identity — attributes writes + gates publish (operator-only)
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
nav{margin-left:auto}nav a{color:var(--mut);text-decoration:none}nav a:hover{color:var(--ink)}
form{margin:.7rem 0}form label{display:block;margin:.45rem 0;color:var(--mut);font-size:.82rem}
textarea{display:block;width:100%;margin:.3rem 0;padding:.6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
input[type=text]{padding:.3rem .45rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
button{font:inherit;padding:.4rem .85rem;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);cursor:pointer}button:hover{border-color:var(--mut)}
.pub{margin-top:.5rem}
.notice{padding:.5rem .7rem;border-radius:8px;margin:.6rem 0;font-size:.85rem}
.n-err{background:#dc26261f;border:1px solid #dc262655;color:#dc2626}.n-ok{background:#16a34a1f;border:1px solid #16a34a55;color:#16a34a}
.doc h1,.doc h2,.doc h3{margin:.7rem 0 .3rem;font-size:1rem}.doc ul,.doc ol{margin:.3rem 0;padding-left:1.3rem}.doc p{margin:.4rem 0}.doc hr{border:0;border-top:1px solid var(--line);margin:.7rem 0}
code{font:.92em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);padding:0 .25rem;border-radius:4px}
.ragent{margin:.9rem 0}.ragent h3{margin:.2rem 0 .4rem}
.rlevel{display:flex;gap:.4rem;align-items:baseline;flex-wrap:wrap;margin:.25rem 0}
.rkey{font-size:.68rem;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);min-width:3.5rem}
.lbl{cursor:pointer}a.lbl:hover{border-color:var(--mut);color:var(--ink)}
`;

function page(title: string, project: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<style>${STYLE}</style></head><body>`
    + `<header><a class="home" href="/">dev-loop</a><span class="proj">${esc(project)}</span><nav><a href="/roadmap">roadmap</a> · <a href="/reports">reports</a></nav></header>`
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
  // DL-8: surface the hub relationships (relatedTo / duplicateOf) as click-through links — but ONLY
  // when present, so an unrelated ticket renders no dangling row (AC). Read-only GET navigation.
  const relLink = (rid: string) => `<a class="lbl" href="/ticket/${encodeURIComponent(rid)}">${esc(rid)}</a>`;
  const relatedRow = t.relatedTo?.length ? `<dt>Related</dt><dd>${t.relatedTo.map(relLink).join(" ")}</dd>` : "";
  const dupRow = t.duplicateOf ? `<dt>Duplicate of</dt><dd>${relLink(t.duplicateOf)}</dd>` : "";
  return `<a class="back" href="/">← board</a><article class="detail">`
    + `<div class="card-top"><span class="id">${esc(t.id)}</span><span class="badge t-${esc(t.type)}">${esc(t.type)}</span><span class="badge">${esc(t.state)}</span></div>`
    + `<h1>${esc(t.title)}</h1>`
    + `<dl class="meta"><dt>Owner</dt><dd>${esc(ownerOf(t.labels))}</dd>`
    + `<dt>Priority</dt><dd>${esc(prioOf(t.priority))}</dd>`
    + `<dt>Assignee</dt><dd>${esc(t.assignee ?? "—")}</dd>`
    + `<dt>Labels</dt><dd>${t.labels.map((l: string) => `<span class="lbl">${esc(l)}</span>`).join("")}</dd>${relatedRow}${dupRow}</dl>`
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

// ─── DL-3: roadmap view/edit ──────────────────────────────────────────────────
// A tiny, dependency-free, XSS-safe markdown renderer for the roadmap view. The body is arbitrary
// agent-authored text, so we esc() FIRST (no user content can then inject a tag), and only THEN apply a
// closed set of block/inline transforms that emit ONLY our own <h*>/<ul>/<ol>/<li>/<strong>/<code>/<hr>/<p>.
function renderMarkdown(md: string): string {
  const inline = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
  for (const raw of esc(md).split("\n")) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (/^\s*$/.test(line)) { closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); const l = m[1].length; out.push(`<h${l}>${inline(m[2])}</h${l}>`); continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList(); out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

// Read an application/x-www-form-urlencoded body (the roadmap edit/publish forms), bounded so a runaway
// upload can't exhaust memory. Localhost-only, but defensive anyway. Two correctness points: accumulate
// Buffers and decode ONCE at the end (a per-chunk `buf.toString()` mangles a multibyte char split across
// a TCP read boundary), and ALWAYS settle the Promise — on over-limit (reject + destroy), normal end,
// error, OR a premature 'close' (a destroyed/aborted socket emits 'close' but neither 'end' nor 'error',
// which would otherwise dangle the awaiting handler forever).
const MAX_BODY = 1_000_000; // 1 MB of body bytes — a roadmap doc is text; orders of magnitude above any real edit
function parseFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0, settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    req.on("data", (c: Buffer) => {
      len += c.length;
      if (len > MAX_BODY) { settle(() => reject(new Error("request body too large"))); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => settle(() => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))));
    req.on("error", (e) => settle(() => reject(e)));
    req.on("close", () => settle(() => reject(new Error("request closed before it completed"))));
  });
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "content-length": 0 }); // 303 See Other — POST→GET (Post/Redirect/Get)
  res.end();
}

// GET /roadmap — render the kind:"roadmap" document (rendered markdown) + version/status, plus the edit
// form and (operator-only) publish control. Reads through the query_only `db`. slug/kind are NEVER form
// fields: the write routes hard-target the roadmap doc, so caller input can't redirect the write (§17).
function roadmapPage(db: DatabaseSync, projectId: string, opts: { writable: boolean; canPublish: boolean; notice?: { kind: "error" | "ok"; msg: string } }): string {
  const d = db.prepare("SELECT * FROM documents WHERE project_id=? AND kind='roadmap'").get(projectId) as Record<string, any> | undefined;
  const latest = d ? ((db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(d.id) as { v: number | null }).v ?? 0) : 0;
  const published = d ? d.current_version : 0;
  const showVer = latest;            // view + edit the LATEST version (draft or published) so the edit loop builds on the newest
  const cur = (d && showVer > 0) ? (db.prepare("SELECT version,body,status FROM document_versions WHERE doc_id=? AND version=?").get(d.id, showVer) as Record<string, any>) : undefined;
  const body = cur?.body ?? "";

  const notice = opts.notice ? `<p class="notice ${opts.notice.kind === "error" ? "n-err" : "n-ok"}">${esc(opts.notice.msg)}</p>` : "";
  const meta = d
    ? `<dl class="meta"><dt>Status</dt><dd>${esc(d.status)}</dd>`
      + `<dt>Latest version</dt><dd>v${latest}${latest > 0 ? ` (${esc(cur?.status ?? "draft")})` : ""}</dd>`
      + `<dt>Published</dt><dd>${published > 0 ? `v${published}` : "none — draft only"}</dd></dl>`
    : `<p class="empty">No roadmap document yet — saving below creates the first draft.</p>`;
  const view = `<h3>${latest > 0 ? (latest === published ? `Published (v${latest})` : `Draft (v${latest}, unpublished)`) : "Roadmap"}</h3>`
    + (body ? `<div class="doc">${renderMarkdown(body)}</div>` : `<p class="empty">(empty)</p>`);

  let controls = "";
  if (opts.writable) {
    controls = `<h3>Edit — saves a DRAFT (never publishes)</h3>`
      + `<form method="post" action="/roadmap/save">`
      + `<input type="hidden" name="baseVersion" value="${latest}">`              // server-derived CAS base; a stale base is rejected, not overwritten
      + `<textarea name="body" rows="16" spellcheck="false">${esc(body)}</textarea>`
      + `<label>Summary (optional) <input type="text" name="summary" placeholder="what changed"></label>`
      + `<button type="submit">Save draft</button></form>`;
    if (latest > 0) {
      controls += opts.canPublish
        ? `<form method="post" action="/roadmap/publish" class="pub"><input type="hidden" name="version" value="${latest}">`
          + `<button type="submit">Publish v${latest} → current</button></form>`
        : `<p class="empty">Publishing a draft → current is <b>operator-only</b>. This daemon runs as a non-operator actor, so the publish control is hidden (§16/§17).</p>`;
    }
  } else {
    controls = `<p class="empty">This daemon is read-only — no write surface is configured.</p>`;
  }

  return `<a class="back" href="/">← board</a><article class="detail">`
    + `<div class="card-top"><span class="id">roadmap</span><span class="badge">${esc(d?.status ?? "—")}</span></div>`
    + `<h1>${esc(d?.title ?? "Roadmap")}</h1>` + notice + meta + view + controls + `</article>`;
}

// POST /roadmap/save | /roadmap/publish — the ONLY write routes. Both hard-target the kind:"roadmap"
// document through docstore (DB-doc-only; no filesystem path ⇒ §17 firewall). save → a DRAFT via the
// CAS (a stale baseVersion is surfaced as a CONFLICT, never last-write-wins); publish → operator-gated.
// Map a docstore error message (the store returns prose, not codes) to the right HTTP status: the
// operator gate → 403, a missing doc/version → 404, the create-precondition → 400, else a genuine
// CAS / kind-immutability conflict → 409.
const statusForDocErr = (msg: string): number =>
  msg.startsWith("FORBIDDEN") ? 403
    : /^no (document|version)\b/.test(msg) ? 404
      : msg.includes("baseVersion must be 0") ? 400
        : 409;

async function handleRoadmapWrite(action: "save" | "publish", req: IncomingMessage, res: ServerResponse, db: DatabaseSync, writeDb: DatabaseSync, projectId: string, projectKey: string, actor: string): Promise<void> {
  let form: URLSearchParams;
  // If the body was rejected (too large / aborted), the socket may already be destroyed — only respond
  // when the response is still writable, so we never throw write-after-destroy into the outer catch.
  try { form = await parseFormBody(req); }
  catch (e) { if (!res.headersSent && !res.destroyed) json(res, 400, { error: (e as Error).message }); return; }
  // Resolve the roadmap doc's slug SERVER-SIDE (never from the form) so the write target can't be redirected.
  const slug = resolveDoc(writeDb, projectId, undefined, "roadmap")?.slug ?? "roadmap";
  const rerender = (msg: string) =>
    htmlOut(res, statusForDocErr(msg), page(`roadmap · ${projectKey}`, projectKey, roadmapPage(db, projectId, { writable: true, canPublish: actor === "operator", notice: { kind: "error", msg } })));

  if (action === "save") {
    const baseVersion = Number(form.get("baseVersion"));
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return json(res, 400, { error: "baseVersion must be a non-negative integer" });
    const r = docSave(writeDb, projectId, actor, { slug, kind: "roadmap", body: form.get("body") ?? "", baseVersion, summary: form.get("summary") ?? undefined });
    return r.ok ? redirect(res, "/roadmap") : rerender(r.error); // a stale baseVersion → 409 CONFLICT, surfaced (no last-write-wins)
  }
  const version = Number(form.get("version"));
  if (!Number.isInteger(version) || version <= 0) return json(res, 400, { error: "version must be a positive integer" });
  const r = docPublish(writeDb, projectId, actor, { kind: "roadmap", version });
  return r.ok ? redirect(res, "/roadmap") : rerender(r.error); // non-operator → 403; missing version → 404
}

// ── DL-10: agent reports view (read-only, FILESYSTEM source — separate from the hub DB) ──────────
// The §22 reports tree is machine-local markdown. Resolve its root: DEVLOOP_REPORTS_DIR if set, else the
// FIRST EXISTING of a few candidates (the on-disk layout varies — both <data>/<project>/reports and a
// flat <data>/reports exist in the wild); falls back to the AC-formula path for the empty state.
const REPORT_DATED: Record<string, RegExp> = { daily: /^\d{4}-\d{2}-\d{2}$/, weekly: /^\d{4}-W\d{2}$/, monthly: /^\d{4}-\d{2}$/ };
function reportsRoot(projectKey: string): string {
  if (process.env.DEVLOOP_REPORTS_DIR) return process.env.DEVLOOP_REPORTS_DIR;
  const bases = [process.env.CLAUDE_PLUGIN_DATA, join(homedir(), ".claude", "plugins", "data", "dev-loop")].filter(Boolean) as string[];
  const candidates = bases.flatMap((b) => [join(b, projectKey, "reports"), join(b, "reports")]);
  for (const c of candidates) { try { if (statSync(c).isDirectory()) return c; } catch { /* not here */ } }
  return candidates[0]; // AC-formula path; may not exist → empty state at read time
}
const lsSubdirs = (p: string): string[] => { try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
// Only the §22 dated-report files for the level — this inherently EXCLUDES *.review.md / *.review.acted.
const lsDated = (p: string, level: string): string[] => { const re = REPORT_DATED[level]; try { return re ? readdirSync(p).filter((f) => f.endsWith(".md") && re.test(f.slice(0, -3))).sort().reverse() : []; } catch { return []; } };

// GET /reports — agents + their dated reports (daily is the must-have; weekly/monthly when present).
function reportsIndexPage(root: string): string {
  const agents = lsSubdirs(root).sort();
  const sections = agents.map((agent) => {
    const levels = ["daily", "weekly", "monthly"].map((level) => {
      const files = lsDated(join(root, agent, level), level);
      if (!files.length) return "";
      const items = files.map((f) => { const d = f.slice(0, -3); return `<a class="lbl" href="/reports/${encodeURIComponent(agent)}/${level}/${encodeURIComponent(d)}">${esc(d)}</a>`; }).join(" ");
      return `<div class="rlevel"><span class="rkey">${esc(level)}</span>${items}</div>`;
    }).filter(Boolean).join("");
    return levels ? `<section class="ragent"><h3>${esc(agent)}</h3>${levels}</section>` : "";
  }).filter(Boolean).join("");
  return `<a class="back" href="/">← board</a><article class="detail"><h1>Reports</h1>`
    + (sections || `<p class="empty">No reports found yet under <code>${esc(root)}</code>.</p>`) + `</article>`;
}
// GET /reports/<agent>/<level>/<date> — one report, read-only. "badpath" → 400 (traversal/garbage), null → 404.
function reportPage(root: string, agent: string, level: string, date: string): { html: string } | "badpath" | null {
  // strict segment validation defeats path traversal BEFORE any fs access: agent is a single safe name
  // (no `.`/`/`/`..`), level is one of the three, date matches the §22 grammar for that level.
  if (!/^[A-Za-z0-9_-]+$/.test(agent) || !(level in REPORT_DATED) || !REPORT_DATED[level].test(date)) return "badpath";
  const file = resolve(root, agent, level, `${date}.md`);
  if (!file.startsWith(resolve(root) + sep)) return "badpath"; // defense-in-depth: the resolved path must stay within root
  let body: string; try { body = readFileSync(file, "utf8"); } catch { return null; }
  return { html: `<a class="back" href="/reports">← reports</a> · <a class="back" href="/">board</a>`
    + `<article class="detail"><div class="card-top"><span class="id">${esc(agent)}</span><span class="badge">${esc(level)}</span></div>`
    + `<h1>${esc(date)}</h1><div class="doc">${renderMarkdown(body)}</div></article>` };
}

// Build the HTTP server over an already-opened, project-resolved db. Exported so tests (and a later
// in-process embed) can start it without the CLI bootstrap below. GET routes issue ONLY SELECTs; the
// optional DL-3 /roadmap/* POST routes write the roadmap doc through the separate `writeDb` connection.
export function createDaemon({ db, projectId, projectKey, writeDb, actor }: DaemonOpts): Server {
  const canWrite = !!writeDb && !!actor;
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
        await handleRoadmapWrite(path === "/roadmap/save" ? "save" : "publish", req, res, db, writeDb!, projectId, projectKey, actor!);
        return;
      }
      // READ-ONLY for everything else: any other non-GET is refused — the read surface never mutates (DL-1 AC).
      if (method !== "GET" && method !== "HEAD") {
        return json(res, 405, { error: "read-only daemon: only GET is allowed" });
      }

      // GET / — the web UI board (DL-2): server-rendered HTML, read-only, columns by state.
      if (path === "/") return htmlOut(res, 200, page(`${projectKey} · board`, projectKey, boardPage(db, projectId, projectKey)));

      // GET /roadmap — the roadmap doc view + edit form (+ operator-only publish) (DL-3).
      if (path === "/roadmap") {
        return htmlOut(res, 200, page(`roadmap · ${projectKey}`, projectKey, roadmapPage(db, projectId, { writable: canWrite, canPublish: canWrite && actor === "operator" })));
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
  const server = createDaemon({ db, projectId, projectKey: PROJECT_KEY, writeDb, actor: ACTOR });
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`[daemon] dev-loop-hub for '${PROJECT_KEY}' (actor=${ACTOR}${ACTOR === "operator" ? ", can publish" : ", drafts only"}) → http://${HOST}:${port}/  (reads read-only; /roadmap editable, localhost-only)`);
  });
}
