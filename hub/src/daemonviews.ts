// dev-loop hub daemon — the HTML web-UI view layer (DL-74 extraction from daemon.ts).
//
// Pure, read-only server-side rendering: every exported function RETURNS an HTML string (the
// routing/response layer in daemon.ts owns res via htmlOut/json). The board + ticket + roadmap +
// reports + activity pages render from the same read-only db connection the JSON API uses
// (PRAGMA query_only=ON) — no client JS, no bundler, no native deps. Every interpolated DB value
// passes through esc() (localhost-only + read-only, but the SoR holds arbitrary agent-authored
// text, so we escape it rather than trust it). No write path, no network, no res handling lives here.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { STATES } from "./db.ts";

// ticket row → API shape (mirrors the MCP server's toTicket; labels/related_to are JSON columns).
// Shared by the HTML views below and the daemon.ts JSON API routes (a row-shape helper, not view-only).
export function toTicket(r: Record<string, any>) {
  return {
    id: r.id, title: r.title, description: r.description, type: r.type, state: r.state,
    assignee: r.assignee, priority: r.priority,
    labels: JSON.parse(r.labels), duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to),
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
}

const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low", 0: "None" };
const CORE_STATES = ["Todo", "In Progress", "In Review", "Done"]; // always shown (Linear-like board)
// Human-Blocked (DL-25) is a parking state — ordered after In Review, but rendered ONLY when populated
// (like Backlog/Canceled/Duplicate), so an empty Human-Blocked column never clutters a healthy board.
const STATE_ORDER = ["Backlog", "Todo", "In Progress", "In Review", "Human-Blocked", "Done", "Canceled", "Duplicate"];
const TERMINAL_STATES = ["Done", "Canceled", "Duplicate"]; // DL-45: excluded from the composition summary band (the band shows the shape of OPEN work)
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s: unknown): string { return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]); }
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
.col .count,.lane-h .count{background:var(--line);color:var(--mut);border-radius:999px;padding:0 .45rem;margin-left:.3rem;font-size:.72rem}
.swimlanes{display:flex;flex-direction:column;gap:1.1rem}
.lane{border-top:1px solid var(--line);padding-top:.55rem}
.lane-h{font-size:.85rem;font-weight:600;margin:.1rem .2rem .55rem;color:var(--ink)}
.who{color:var(--ink);font-weight:500}
.group-tg{display:inline-flex;align-items:center;gap:.25rem;margin-left:.2rem;font-size:.72rem;color:var(--mut)}
.lbl.on{color:var(--ink);border-color:var(--mut);background:var(--card)}
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
.n-err{background:#dc26261f;border:1px solid #dc262655;color:#dc2626}.n-ok{background:#16a34a1f;border:1px solid #16a34a55;color:#16a34a}.n-info{background:#64748b1f;border:1px solid #64748b55;color:#475569}
.doc h1,.doc h2,.doc h3{margin:.7rem 0 .3rem;font-size:1rem}.doc ul,.doc ol{margin:.3rem 0;padding-left:1.3rem}.doc p{margin:.4rem 0}.doc hr{border:0;border-top:1px solid var(--line);margin:.7rem 0}
code{font:.92em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);padding:0 .25rem;border-radius:4px}
.ragent{margin:.9rem 0}.ragent h3{margin:.2rem 0 .4rem}
.rlevel{display:flex;gap:.4rem;align-items:baseline;flex-wrap:wrap;margin:.25rem 0}
.rkey{font-size:.68rem;text-transform:uppercase;letter-spacing:.03em;color:var(--mut);min-width:3.5rem}
.warn{color:#dc2626;font-weight:600}.sub{color:var(--mut)}
.lbl{cursor:pointer}a.lbl:hover{border-color:var(--mut);color:var(--ink)}
.filterbar{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;margin:0 0 .8rem}
.filterbar .chips{display:flex;gap:.3rem;flex-wrap:wrap;margin-left:.2rem}
.filterbar .clearall{border-style:dashed}
.summary{display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin:0 0 .8rem;padding:.4rem .55rem;background:var(--card);border:1px solid var(--line);border-radius:8px}
.summary .sum-grp{display:flex;gap:.3rem;flex-wrap:wrap}
.summary .lbl{cursor:default}.summary .lbl b{color:var(--ink);font-weight:600}
`;

export function page(title: string, project: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<style>${STYLE}</style></head><body>`
    + `<header><a class="home" href="/">dev-loop</a><span class="proj">${esc(project)}</span><nav><a href="/roadmap">roadmap</a> · <a href="/activity">activity</a> · <a href="/reports">reports</a></nav></header>`
    + `<main>${inner}</main></body></html>`;
}

function cardHtml(t: ReturnType<typeof toTicket>): string {
  return `<a class="card" href="/ticket/${encodeURIComponent(t.id)}">`
    + `<div class="card-top"><span class="id">${esc(t.id)}</span><span class="badge t-${esc(t.type)}">${esc(t.type)}</span></div>`
    + `<div class="title">${esc(t.title)}</div>`
    + `<div class="card-meta"><span class="owner">${esc(ownerOf(t.labels))}</span>`
    // DL-31: assignee chip — gated (rendered only when assigned), so unassigned cards stay clean. The
    // operator reported the board never showed who a ticket is assigned to; this surfaces it on the card.
    + (t.assignee ? `<span class="who">@${esc(t.assignee)}</span>` : "")
    + `<span class="prio p${esc(t.priority)}">${esc(prioOf(t.priority))}</span></div></a>`;
}

// DL-20: the board filter/search keys — mirror the /api/tickets filter semantics (state/type/label,
// + assignee) plus a free-text `q` over id/title. Server-side + read-only; no client JS, no build step.
interface BoardFilters { state?: string; type?: string; label?: string; assignee?: string; q?: string }
const FILTER_KEYS = ["state", "type", "label", "assignee", "q"] as const;

// Board: tickets grouped into state columns. Core workflow columns always render (even empty);
// Backlog/Canceled/Duplicate and any other state show only when populated, terminals last. DL-20 adds
// optional server-side filter/search (from the GET / query string) + a clearable, deep-linkable control row.
export function boardPage(db: DatabaseSync, projectId: string, projectKey: string, filters: BoardFilters = {}, canWrite = false, group?: string): string {
  let tickets = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY priority ASC, updated_at DESC").all(projectId) as Record<string, any>[]).map(toTicket);
  const f = filters;
  // mirror /api/tickets: each present (non-empty) filter narrows the set; q matches id/title, case-insensitive
  if (f.state) tickets = tickets.filter((t) => t.state === f.state);
  if (f.type) tickets = tickets.filter((t) => t.type === f.type);
  if (f.label) tickets = tickets.filter((t) => t.labels.includes(f.label!));
  if (f.assignee) tickets = tickets.filter((t) => t.assignee === f.assignee);
  if (f.q) { const q = f.q.toLowerCase(); tickets = tickets.filter((t) => String(t.id).toLowerCase().includes(q) || String(t.title ?? "").toLowerCase().includes(q)); }

  // DL-31: ?group=assignee (validated upstream to the one known value) switches the board to assignee
  // swimlanes. swim===false is byte-identical to the pre-DL-31 board apart from the always-present group
  // toggle. The URL helper carries `group` so filter/search/chip links keep the active view (deep-linkable).
  const swim = group === "assignee";
  const qstr = (over: { omit?: string; group?: string | null } = {}) => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (f[k] && k !== over.omit) p.set(k, f[k]!);
    const g = over.group === undefined ? group : over.group; // null ⇒ explicitly drop group
    if (g) p.set("group", g);
    const s = p.toString(); return s ? `/?${s}` : "/";
  };

  // control row: active filters as clearable chips + a free-text search form + a state↔assignee group
  // toggle; all reflected in the URL. A chip's link drops just that key but keeps the group view;
  // "clear all" drops every filter but keeps the view. esc() everything (AC4).
  const active = FILTER_KEYS.filter((k) => f[k]);
  const chips = active.map((k) => `<a class="lbl" href="${esc(qstr({ omit: k }))}">${esc(k)}: ${esc(f[k])} ✕</a>`).join(" ");
  const hidden = (["state", "type", "label", "assignee"] as const).map((k) => f[k] ? `<input type="hidden" name="${k}" value="${esc(f[k])}">` : "").join("")
    + (group ? `<input type="hidden" name="group" value="${esc(group)}">` : "");
  const groupToggle = `<span class="group-tg">group:`
    + `<a class="lbl${swim ? "" : " on"}" href="${esc(qstr({ group: null }))}">state</a>`
    + `<a class="lbl${swim ? " on" : ""}" href="${esc(qstr({ group: "assignee" }))}">assignee</a></span>`;
  const controls = `<form class="filterbar" method="get" action="/">${hidden}`
    + `<input type="text" name="q" value="${esc(f.q ?? "")}" placeholder="search id / title" spellcheck="false">`
    + `<button type="submit">search</button>`
    + (active.length ? `<a class="lbl clearall" href="${esc(swim ? "/?group=assignee" : "/")}">clear all</a>` : "")
    + groupToggle
    + (chips ? `<span class="chips">${chips}</span>` : "")
    + `</form>`;

  // Column ordering computed ONCE over the full filtered set so every swimlane shares an aligned column
  // layout (CORE_STATES always render; populated extras appended, non-STATE_ORDER states last).
  const allByState = new Map<string, ReturnType<typeof toTicket>[]>();
  for (const t of tickets) (allByState.get(t.state) ?? allByState.set(t.state, []).get(t.state)!).push(t);
  const states = [
    ...STATE_ORDER.filter((s) => CORE_STATES.includes(s) || allByState.has(s)),
    ...[...allByState.keys()].filter((s) => !STATE_ORDER.includes(s)),
  ];
  const columnsFor = (subset: ReturnType<typeof toTicket>[]): string => {
    const byState = new Map<string, ReturnType<typeof toTicket>[]>();
    for (const t of subset) (byState.get(t.state) ?? byState.set(t.state, []).get(t.state)!).push(t);
    const cols = states.map((s) => {
      const cards = byState.get(s) ?? [];
      const body = cards.length ? cards.map(cardHtml).join("") : `<p class="empty">—</p>`;
      return `<section class="col"><h2>${esc(s)}<span class="count">${cards.length}</span></h2>${body}</section>`;
    }).join("");
    return `<div class="board">${cols}</div>`;
  };

  let boardHtml: string;
  if (swim) {
    // one lane per distinct assignee (sorted), with the unassigned lane last; each lane reuses the shared
    // aligned columns. Assignee labels esc()'d (operator-controlled DATA → never trusted as markup).
    const named = [...new Set(tickets.map((t) => t.assignee).filter((a): a is string => !!a))].sort();
    const lanesKeys: (string | null)[] = [...named, ...(tickets.some((t) => !t.assignee) ? [null] : [])];
    boardHtml = `<div class="swimlanes">` + lanesKeys.map((a) => {
      const subset = tickets.filter((t) => (a === null ? !t.assignee : t.assignee === a));
      const label = a === null ? "unassigned" : `@${a}`;
      return `<section class="lane"><h2 class="lane-h">${esc(label)}<span class="count">${subset.length}</span></h2>${columnsFor(subset)}</section>`;
    }).join("") + `</div>`;
  } else {
    boardHtml = columnsFor(tickets);
  }

  // empty state (AC3): when nothing matches, show the existing empty element — filter-aware so it reads
  // accurately ("none match" when filtering vs. "none yet" on a genuinely empty board).
  const empty = tickets.length === 0
    ? (active.length ? `<p class="empty">No tickets match the active filters.</p>` : `<p class="empty">No tickets in ${esc(projectKey)} yet.</p>`)
    : "";
  // DL-29: opt-in "new ticket" form (only when humanWrite is enabled — gated upstream). POST → the daemon
  // create route, then PRG to the new ticket. esc() the option values (our own constants, but uniform).
  const newForm = canWrite
    ? `<form class="newticket" method="post" action="/ticket">`
      + `<input type="text" name="title" placeholder="New ticket title" required spellcheck="false">`
      + `<select name="type"><option>Feature</option><option>Bug</option><option>Improvement</option></select>`
      + `<button type="submit">+ New ticket</button></form>`
    : "";
  // DL-45: an at-a-glance composition summary band over the NON-TERMINAL tickets of the (filtered) set — by
  // type, owner, and priority. A pure read-only aggregate over the rows already fetched + filtered above, so it
  // always agrees with the columns below it (and with the swimlanes, which split this same `tickets` set). The
  // terminal states (Done/Canceled/Duplicate) are excluded — the band shows the shape of OPEN work. Hidden when
  // there is no open work (an empty / all-terminal set) so it never renders an all-zero strip.
  const open = tickets.filter((t) => !TERMINAL_STATES.includes(t.state));
  const sumChip = (label: string, n: number) => `<span class="lbl">${esc(label)} <b>${n}</b></span>`;
  const sumGrp = (chips: string) => `<span class="sum-grp">${chips}</span>`;
  const summary = open.length
    ? `<div class="summary" title="composition of the ${open.length} open (non-terminal) ticket(s)${active.length ? ", filtered" : ""}">`
      + sumGrp(["Feature", "Bug", "Improvement"].map((ty) => sumChip(ty, open.filter((t) => t.type === ty).length)).join(""))
      + sumGrp(["pm", "qa"].map((o) => sumChip(o, open.filter((t) => ownerOf(t.labels) === o).length)).join(""))
      + sumGrp([1, 2, 3, 4, 0].map((p) => sumChip(prioOf(p), open.filter((t) => t.priority === p).length)).join(""))
      + `</div>`
    : "";
  return controls + newForm + summary + boardHtml + empty;
}

// Ticket detail: full description + comments. Returns null when the ticket is absent (→ 404).
export function ticketPage(db: DatabaseSync, projectId: string, id: string, canWrite = false): string | null {
  const r = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as Record<string, any> | undefined;
  if (!r) return null;
  const t = toTicket(r);
  const comments = db.prepare("SELECT author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as Record<string, any>[];
  const commentsHtml = comments.length
    ? comments.map((c) => `<div class="comment"><div class="c-head"><b>${esc(c.author)}</b><time>${esc(c.created_at)}</time></div><div class="doc">${renderMarkdown(c.body)}</div></div>`).join("")
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
    + `<dt>Created</dt><dd>${esc(t.created_at)}</dd><dt>Updated</dt><dd>${esc(t.updated_at)}</dd>`  // DL-16
    + `<dt>Labels</dt><dd>${t.labels.map((l: string) => `<span class="lbl">${esc(l)}</span>`).join("")}</dd>${relatedRow}${dupRow}</dl>`
    + `<h3>Description</h3><div class="doc">${renderMarkdown(t.description)}</div>`  // DL-16: rendered markdown (XSS-safe via renderMarkdown), not raw <pre>
    + `<h3>Comments<span class="count" style="margin-left:.4rem">${comments.length}</span></h3>${commentsHtml}`
    // DL-29: opt-in human actions (only when humanWrite is enabled — gated upstream). Each POSTs to a
    // daemon write route then PRG-redirects back here. All interpolated values esc()'d; comment/assignee
    // are operator DATA (stored verbatim, never parsed). Move offers the STATES set, current pre-selected.
    + (canWrite
      ? `<h3>Actions</h3>`
        + `<form class="act" method="post" action="/ticket/${encodeURIComponent(id)}/comment"><textarea name="body" rows="3" placeholder="Add a comment" required spellcheck="false"></textarea><button type="submit">Comment</button></form>`
        + `<form class="act" method="post" action="/ticket/${encodeURIComponent(id)}/move"><select name="state">${STATES.map((s) => `<option${s === t.state ? " selected" : ""}>${esc(s)}</option>`).join("")}</select><button type="submit">Move</button></form>`
        + `<form class="act" method="post" action="/ticket/${encodeURIComponent(id)}/assign"><input type="text" name="assignee" value="${esc(t.assignee ?? "")}" placeholder="assignee handle (blank = unassign)" spellcheck="false"><button type="submit">Assign</button></form>`
      : "")
    + `</article>`;
}

// ─── DL-3: roadmap view ─────────────────────────────────────────────────────────
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
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; } const cb = m[1].match(/^\[([ xX])\]\s+([\s\S]*)$/); out.push(cb ? `<li><input type="checkbox" disabled${cb[1] === " " ? "" : " checked"}> ${inline(cb[2])}</li>` : `<li>${inline(m[1])}</li>`); continue; } // DL-16: a `- [ ]`/`- [x]` item → a disabled checkbox (the text is already esc'd → XSS-safe)
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList(); out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

// GET /roadmap — render the kind:"roadmap" document (rendered markdown) + version/status, plus the edit
// form and (operator-only) publish control. Reads through the query_only `db`. slug/kind are NEVER form
// fields: the write routes hard-target the roadmap doc, so caller input can't redirect the write (§17).
export function roadmapPage(db: DatabaseSync, projectId: string, opts: { writable: boolean; canPublish: boolean; notice?: { kind: "error" | "ok"; msg: string }; submittedBody?: string; roadmapRepoFileStrategy?: string }): string {
  const d = db.prepare("SELECT * FROM documents WHERE project_id=? AND kind='roadmap'").get(projectId) as Record<string, any> | undefined;
  const latest = d ? ((db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(d.id) as { v: number | null }).v ?? 0) : 0;
  const published = d ? d.current_version : 0;
  const showVer = latest;            // view + edit the LATEST version (draft or published) so the edit loop builds on the newest
  const cur = (d && showVer > 0) ? (db.prepare("SELECT version,body,status FROM document_versions WHERE doc_id=? AND version=?").get(d.id, showVer) as Record<string, any>) : undefined;
  const body = cur?.body ?? "";

  const notice = opts.notice ? `<p class="notice ${opts.notice.kind === "error" ? "n-err" : "n-ok"}">${esc(opts.notice.msg)}</p>` : "";
  // DL-83: when the hub roadmap doc is NOT this project's north-star (a repo-file strategyDoc is, because no
  // agent reads the hub roadmap under hub.docs:false/absent + no director), a NEUTRAL informational banner
  // sets expectations — editing here won't steer the loop. Purely informational: it never hides the
  // view/edit/publish controls (AC2). The path comes from the daemon's resolved config (§17) and is esc'd.
  const divergence = opts.roadmapRepoFileStrategy
    ? `<p class="notice n-info">This project's north-star is the repo file <code>${esc(opts.roadmapRepoFileStrategy)}</code> — this hub roadmap is <b>not read by the agents</b> under the current config (no <code>hub.docs</code>, no <code>director</code>), so edits here won't steer the loop.</p>`
    : "";
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
      + `<textarea name="body" rows="16" spellcheck="false">${esc(opts.submittedBody ?? body)}</textarea>`  // DL-14: on a rejected save, keep the user's typed text (?? — an empty submission stays empty), not the DB body
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
    + `<h1>${esc(d?.title ?? "Roadmap")}</h1>` + divergence + notice + meta + view + controls + `</article>`;
}

// ── DL-10: agent reports view (read-only, FILESYSTEM source — separate from the hub DB) ──────────
// The §22 reports tree is machine-local markdown. Resolve its root: DEVLOOP_REPORTS_DIR if set, else the
// FIRST EXISTING of a few candidates (the on-disk layout varies — both <data>/<project>/reports and a
// flat <data>/reports exist in the wild); falls back to the AC-formula path for the empty state.
const REPORT_DATED: Record<string, RegExp> = { daily: /^\d{4}-\d{2}-\d{2}$/, weekly: /^\d{4}-W\d{2}$/, monthly: /^\d{4}-\d{2}$/ };
export function reportsRoot(projectKey: string): string {
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
export function reportsIndexPage(root: string): string {
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
export function reportPage(root: string, agent: string, level: string, date: string): { html: string } | "badpath" | null {
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

// ── DL-17: activity & throughput view over the events ledger (read-only) ─────────────────────────
// A human-facing read over the append-only `events` table (issue.create / issue.transition{from,to} /
// comment.add, written by the MCP server at server.ts). Pure GET through the query_only `db`: no write
// path, no new MCP tool call, no new table. Robust to a null ticket_id and to empty/malformed `data`
// JSON — a bad row is skipped (metrics) or shown plainly (feed), never breaking the page (AC5).
const DAY_MS = 86_400_000;
// Defensive JSON parse of an event's `data` blob — empty / malformed / non-object → {} instead of throwing.
// Shared by the activity view below and the daemon.ts no-progress detector (same done-count logic).
export function eventData(s: unknown): Record<string, any> {
  if (typeof s !== "string" || s === "") return {};
  try { const v = JSON.parse(s); return v && typeof v === "object" ? (v as Record<string, any>) : {}; } catch { return {}; }
}
// Human-readable elapsed (ms → "3d 4h" / "2h 5m" / "12m" / "<1m"); NaN/negative → "—".
function humanDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}
// One feed line per event, formatted by kind; every interpolation passes through esc() (AC6). A null
// ticket_id renders no link (AC5); unknown kinds (issue.update / topic.*) fall through to a plain line.
function eventLine(e: Record<string, any>): string {
  const d = eventData(e.data);
  const who = `<b>${esc(e.actor)}</b>`;
  const tlink = e.ticket_id ? ` <a class="lbl" href="/ticket/${encodeURIComponent(e.ticket_id)}">${esc(e.ticket_id)}</a>` : "";
  let what: string;
  switch (e.kind) {
    case "issue.create": what = `created${tlink} <span class="badge">${esc(d.type ?? "?")}</span> ${esc(d.title ?? "")}`; break;
    case "issue.transition": what = `moved${tlink} <span class="lbl">${esc(d.from ?? "?")}</span> → <span class="lbl">${esc(d.to ?? "?")}</span>`; break;
    case "issue.promote": what = `promoted${tlink} <span class="lbl">${esc(d.from || "—")}</span> → <span class="lbl">${esc(d.to || "—")}</span>`; break; // DL-32 env-label change
    case "comment.add": what = `commented on${tlink || " a ticket"}`; break;
    default: what = `${esc(e.kind)}${tlink}`; break;
  }
  return `<div class="rlevel"><span class="rkey">${esc(e.created_at)}</span><span>${who} ${what}</span></div>`;
}

// GET /activity — recent events + throughput (Done transitions), acceptance rate, per-actor counts, and
// cycle time, all read through the query_only `db`. `nowMs` is injected (the daemon passes Date.now()) so
// the helper is pure/testable. Windows: 7d + 30d for throughput + acceptance rate; 30d for per-actor +
// cycle-time recency.
export function activityPage(db: DatabaseSync, projectId: string, projectKey: string, nowMs: number): string {
  const since30 = new Date(nowMs - 30 * DAY_MS).toISOString();
  const since7 = new Date(nowMs - 7 * DAY_MS).toISOString();

  // Recent feed — newest-first, bounded (the three named kinds get rich formatting; others fall through).
  const feed = db.prepare("SELECT ticket_id,actor,kind,data,created_at FROM events WHERE project_id=? ORDER BY id DESC LIMIT 100").all(projectId) as Record<string, any>[];

  // Transitions in the last 30d → Done throughput + the set of recently-Done tickets for cycle time.
  const trans = db.prepare("SELECT ticket_id,data,created_at FROM events WHERE project_id=? AND kind='issue.transition' AND created_at>=? ORDER BY id").all(projectId, since30) as Record<string, any>[];
  let done7 = 0, done30 = 0, fail7 = 0, fail30 = 0;                           // fail* = verify-fail Cancels (the accept-rate denominator, DL-79)
  const doneAt = new Map<string, string>();                                   // ticket_id → latest Done-transition time (in window)
  for (const e of trans) {
    const d = eventData(e.data);                                              // parsed once; empty/malformed → {} → matches neither branch, skipped (AC5)
    const in7 = e.created_at >= since7;
    if (d.to === "Done") {
      done30++; if (in7) done7++;
      if (e.ticket_id) { const prev = doneAt.get(e.ticket_id); if (!prev || e.created_at > prev) doneAt.set(e.ticket_id, e.created_at); }  // null ticket_id → counted in throughput, no cycle row (AC5)
    } else if (d.from === "In Review" && d.to === "Canceled") {               // §3 verify-fail close+follow-up always leaves THIS exact edge — an ordinary Cancel (Todo/Backlog→Canceled) is NOT counted (DL-79)
      fail30++; if (in7) fail7++;
    }
  }

  // Per-actor activity over the same 30d window.
  const actors = db.prepare("SELECT actor,count(*) n FROM events WHERE project_id=? AND created_at>=? GROUP BY actor ORDER BY n DESC, actor").all(projectId, since30) as { actor: string; n: number }[];

  // Cycle time per recently-Done ticket: elapsed from the ticket's create (else first Todo transition) to
  // its Done transition. When that start anchor is missing (incomplete history), render a graceful fallback.
  const cycle = [...doneAt.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([tid, done]) => {
    const hist = db.prepare("SELECT kind,data,created_at FROM events WHERE project_id=? AND ticket_id=? AND (kind='issue.create' OR kind='issue.transition') ORDER BY id").all(projectId, tid) as Record<string, any>[];
    let start: string | undefined;
    for (const e of hist) if (e.kind === "issue.create") { start = e.created_at; break; }
    if (!start) for (const e of hist) if (eventData(e.data).to === "Todo") { start = e.created_at; break; }
    return { tid, done, label: start ? humanDur(Date.parse(done) - Date.parse(start)) : "— (incomplete history)" };
  });

  const metricRow = (k: string, v: string) => `<div class="rlevel"><span class="rkey">${esc(k)}</span><span>${v}</span></div>`;
  const throughput = `<h3>Throughput — transitions into Done</h3>`
    + metricRow("last 7d", `<b>${esc(done7)}</b>`) + metricRow("last 30d", `<b>${esc(done30)}</b>`);
  // Acceptance rate = Done ÷ (Done + verify-fail Cancels): is the loop's output being accepted, or churning?
  // Raw counts shown for audit; flagged below 50% (the loop is likely losing money). A zero-denominator window
  // renders a neutral "no data" — never a fake 0% or a divide-by-zero (DL-79 ACs).
  const acceptVal = (done: number, fail: number): string => {
    const total = done + fail;
    if (total === 0) return `<span class="sub">— no data</span>`;
    const rate = Math.round((done / total) * 100);
    const head = rate < 50 ? `<span class="warn">${esc(rate)}% ⚠ low</span>` : `<b>${esc(rate)}%</b>`;
    return `${head} <span class="sub">Done ${esc(done)} · verify-fail ${esc(fail)}</span>`;
  };
  const acceptance = `<h3>Acceptance rate — Done ÷ (Done + verify-fail)</h3>`
    + metricRow("last 7d", acceptVal(done7, fail7)) + metricRow("last 30d", acceptVal(done30, fail30));
  const actorSection = `<h3>Per-actor activity — last 30 days</h3>`
    + (actors.length ? actors.map((a) => metricRow(a.actor, `<b>${esc(a.n)}</b> event${Number(a.n) === 1 ? "" : "s"}`)).join("") : `<p class="empty">No activity in the last 30 days.</p>`);
  const cycleSection = `<h3>Cycle time — recently Done</h3>`
    + (cycle.length ? cycle.map((c) => `<div class="rlevel"><span class="rkey">${esc(c.tid)}</span><span>cycle <b>${esc(c.label)}</b> · Done ${esc(c.done)}</span></div>`).join("") : `<p class="empty">No tickets reached Done in the last 30 days.</p>`);
  const feedSection = `<h3>Recent activity<span class="count" style="margin-left:.4rem">${feed.length}</span></h3>`
    + (feed.length ? feed.map(eventLine).join("") : `<p class="empty">No activity recorded yet.</p>`);

  return `<a class="back" href="/">← board</a><article class="detail"><h1>Activity</h1>`
    + throughput + acceptance + actorSection + cycleSection + feedSection + `</article>`;
}
