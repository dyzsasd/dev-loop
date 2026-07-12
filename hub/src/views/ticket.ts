// dev-loop hub daemon web UI — the ticket-detail view (F1 split of daemonviews.ts).
// History: DL-2 detail · DL-8 relations · DL-16 markdown + timestamps · DL-29 human-write forms ·
// DL-86 failed-write re-render · ui P4 (2026-07 review) two-column redesign + unified timeline.
// Pure read-only rendering through the query_only db.
//
// Layout (the 2026-07 design input, proposal 4): ≥900px two-column grid — MAIN (breadcrumb, title,
// tinted state chip, markdown description, then ONE chronological timeline interleaving state
// transitions from the events ledger with comments) · SIDEBAR (State/Type/Priority/Owner/Assignee/
// Labels/Relations/Created/Updated definition rows + the compact move/assign controls when
// humanWrite is on; the comment box docks under the timeline). Mobile: the sidebar stacks ABOVE
// the main column (CSS order, DOM stays main-first for readers).
import { DatabaseSync } from "node:sqlite";
import { STATES } from "../db.ts";
import { esc, href, toTicket, ownerOf, prioOf, renderMarkdown, noticeHtml, countPill, stateVar } from "./ui.ts";

// ── small pure helpers (exported for the webui guard tests) ─────────────────────────────────────

// Server-side relative time ("3d ago") — pure so tests can pin the clock; the ISO always rides the
// <time> title (see timeHtml) so precision is one hover away. Unparsable/blank → "—".
export function relTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}
const timeHtml = (iso: string, nowMs: number) =>
  `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(relTime(iso, nowMs))}</time>`;

// The 18px hue-hashed identity dot (design input: hsl(hash(handle)%360 45% 42%) light / (h 50% 68%)
// dark — the initial rides --brand-ink, which is white-on-light / dark-on-light-dot per scheme, the
// same relationship the brand button uses). The per-scheme values arrive as the --idl/--idd custom
// props (declared with neutral fallbacks on the .idot rule, so the webui unresolved-var guard holds);
// inline style is CSP-allowed and keeps the token sheet the only place a literal color could hide —
// hsl() here is derived DATA (a hash), not a design token.
export function identityDot(handle: string): string {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) hash = (hash * 31 + handle.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const initial = (handle[0] ?? "?").toUpperCase();
  return `<span class="idot" style="--idl:hsl(${hue} 45% 42%);--idd:hsl(${hue} 50% 68%)" title="@${esc(handle)}" aria-hidden="true">${esc(initial)}</span>`;
}

// ── timeline ─────────────────────────────────────────────────────────────────────────────────────

// Per-ticket lifecycle from the append-only events ledger — the /activity HIST_SQL adapted to carry
// the actor (who moved it). comment.add events are deliberately NOT selected: their bodies live in
// the comments table, which the timeline interleaves below (selecting both would double-render).
const TL_SQL = "SELECT kind,actor,data,created_at FROM events WHERE project_id=? AND ticket_id=? AND (kind='issue.create' OR kind='issue.transition') ORDER BY id";
// Defensive parse of an event's data blob (mirrors activity.ts eventData; kept local so the two view
// modules stay independently editable) — empty / malformed / non-object → {}.
function tlData(s: unknown): Record<string, any> {
  if (typeof s !== "string" || s === "") return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, any>) : {}; } catch { return {}; }
}

// Ticket detail: two-column layout + unified timeline. Returns null when the ticket is absent (→ 404).
// DL-86: `opts` lets a failed human-write (move/assign/comment) RE-RENDER this page with an inline error
// notice (instead of a raw-JSON dead-end) and preserve the operator's typed comment in the textarea (DL-14-style).
// `opts.nowMs` pins the relative-time clock for tests (daemon.ts callers omit it → Date.now()).
// F2: projectKey scopes every link/form action to /p/<key>/ via href().
export function ticketPage(db: DatabaseSync, projectId: string, projectKey: string, id: string, canWrite = false, opts: { notice?: { kind: "error" | "ok"; msg: string }; submittedComment?: string; nowMs?: number } = {}): string | null {
  const r = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as Record<string, any> | undefined;
  if (!r) return null;
  const t = toTicket(r);
  const nowMs = opts.nowMs ?? Date.now();

  // ── the unified timeline: create + transitions (events ledger) interleaved with comments, oldest
  // first (it reads top-down into the docked comment box). Items merge on created_at (ISO strings
  // sort lexicographically); the sort is stable, so a transition logged in the same millisecond as
  // its comment keeps ledger-before-comment order. Every interpolation esc()'d; comment bodies ride
  // renderMarkdown (esc-FIRST, consistent with the description).
  const events = db.prepare(TL_SQL).all(projectId, id) as Record<string, any>[];
  const comments = db.prepare("SELECT author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as Record<string, any>[];
  const items: { at: string; html: string }[] = [];
  for (const e of events) {
    if (e.kind === "issue.create") {
      items.push({ at: e.created_at, html: `<li class="tl-item tl-create">${identityDot(e.actor)}<div class="tl-body"><b>${esc(e.actor)}</b> created this ticket ${timeHtml(e.created_at, nowMs)}</div></li>` });
    } else { // issue.transition — who moved what state when (malformed data → "?", never a broken row)
      const d = tlData(e.data);
      items.push({ at: e.created_at, html: `<li class="tl-item tl-move">${identityDot(e.actor)}<div class="tl-body"><b>${esc(e.actor)}</b> moved <span class="lbl">${esc(d.from ?? "?")}</span> → <span class="lbl">${esc(d.to ?? "?")}</span> ${timeHtml(e.created_at, nowMs)}</div></li>` });
    }
  }
  for (const c of comments) {
    items.push({ at: c.created_at, html: `<li class="tl-item tl-comment">${identityDot(c.author)}<div class="tl-body"><div class="c-head"><b>${esc(c.author)}</b><time datetime="${esc(c.created_at)}" title="${esc(c.created_at)}">${esc(relTime(c.created_at, nowMs))}</time></div><div class="doc">${renderMarkdown(c.body)}</div></div></li>` });
  }
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // stable — same-instant items keep push order
  const timelineHtml = items.length
    ? `<ol class="timeline">${items.map((i) => i.html).join("")}</ol>`
    : `<p class="empty">No activity yet.</p>`;

  // DL-8: surface the hub relationships (relatedTo / duplicateOf) as click-through links — but ONLY
  // when present, so an unrelated ticket renders no dangling row (AC). Read-only GET navigation.
  const relLink = (rid: string) => `<a class="lbl" href="${esc(href(projectKey, `/ticket/${encodeURIComponent(rid)}`))}">${esc(rid)}</a>`;
  const relatedRow = t.relatedTo?.length ? `<dt>Related</dt><dd>${t.relatedTo.map(relLink).join(" ")}</dd>` : "";
  const dupRow = t.duplicateOf ? `<dt>Duplicate of</dt><dd>${relLink(t.duplicateOf)}</dd>` : "";
  // L1: the reverse of Related — tickets that point AT this one (a design parent shows its staged children).
  const referencedBy = (db.prepare("SELECT id,related_to FROM tickets WHERE project_id=? AND related_to LIKE ?").all(projectId, `%${JSON.stringify(id)}%`) as { id: string; related_to: string }[])
    .filter((row) => { try { return (JSON.parse(row.related_to) as string[]).includes(id); } catch { return false; } }).map((row) => row.id);
  const refByRow = referencedBy.length ? `<dt>Referenced by</dt><dd>${referencedBy.map(relLink).join(" ")}</dd>` : "";

  // ── sidebar: definition rows (State/Type/Priority/Owner/Assignee/Labels/relations/timestamps) +
  // the compact move/assign controls when humanWrite is on (DL-29 — gated upstream; each POSTs to a
  // daemon write route then PRG-redirects back here; assignee is operator DATA, stored verbatim).
  const sideActions = canWrite
    ? `<form class="act" method="post" action="${esc(href(projectKey, `/ticket/${encodeURIComponent(id)}/move`))}"><select name="state" aria-label="move to state">${STATES.map((s) => `<option${s === t.state ? " selected" : ""}>${esc(s)}</option>`).join("")}</select><button type="submit">Move</button></form>`
      + `<form class="act" method="post" action="${esc(href(projectKey, `/ticket/${encodeURIComponent(id)}/assign`))}"><input type="text" name="assignee" value="${esc(t.assignee ?? "")}" placeholder="assignee (blank = unassign)" aria-label="assignee handle (blank = unassign)" spellcheck="false"><button type="submit">Assign</button></form>`
    : "";
  const sidebar = `<aside class="tside"><div class="tside-card"><dl class="meta">`
    + `<dt>State</dt><dd><span class="schip" style="--sc:var(${stateVar(t.state)})">${esc(t.state)}</span></dd>`
    + `<dt>Type</dt><dd><span class="badge t-${esc(t.type)}">${esc(t.type)}</span></dd>`
    + `<dt>Priority</dt><dd><span class="prio p${esc(t.priority)}">${esc(prioOf(t.priority))}</span></dd>`
    + `<dt>Owner</dt><dd>${esc(ownerOf(t.labels))}</dd>`
    + `<dt>Assignee</dt><dd>${t.assignee ? `${identityDot(t.assignee)} @${esc(t.assignee)}` : "—"}</dd>`
    + `<dt>Labels</dt><dd>${t.labels.length ? t.labels.map((l: string) => `<span class="lbl">${esc(l)}</span>`).join("") : "—"}</dd>`
    + relatedRow + refByRow + dupRow
    + `<dt>Created</dt><dd>${timeHtml(t.created_at, nowMs)}</dd><dt>Updated</dt><dd>${timeHtml(t.updated_at, nowMs)}</dd>`  // DL-16 (relative + ISO on hover)
    + `</dl>${sideActions}</div></aside>`;

  // ── main column: breadcrumb · id/type/state chip row · title · notice · description · timeline ·
  // (comment box docked under the timeline when humanWrite is on — DL-86 preserves rejected input).
  const commentForm = canWrite
    ? `<form class="act" method="post" action="${esc(href(projectKey, `/ticket/${encodeURIComponent(id)}/comment`))}"><textarea name="body" rows="3" placeholder="Add a comment" aria-label="add a comment" required spellcheck="false">${esc(opts.submittedComment ?? "")}</textarea><button type="submit">Comment</button></form>`
    : "";
  const main = `<div class="tmain">`
    + `<div class="card-top"><span class="id">${esc(t.id)}</span><span class="badge t-${esc(t.type)}">${esc(t.type)}</span><span class="schip" style="--sc:var(${stateVar(t.state)})">${esc(t.state)}</span></div>`
    + `<h1>${esc(t.title)}</h1>`
    + noticeHtml(opts.notice) // DL-86: inline error on a failed write
    + `<h3>Description</h3><div class="doc">${renderMarkdown(t.description)}</div>`  // DL-16: rendered markdown (XSS-safe via renderMarkdown), not raw <pre>
    + `<h3>Timeline${countPill(items.length, true)}</h3>${timelineHtml}`
    + commentForm
    + `</div>`;

  return `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a>`
    + `<article class="tgrid">${main}${sidebar}</article>`;
}
