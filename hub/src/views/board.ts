// dev-loop hub daemon web UI — the kanban board view (F1 split of daemonviews.ts).
// History: DL-2 board · DL-20 filter/search · DL-31 assignee swimlanes · DL-45 summary band ·
// DL-86 failed-create re-render · F3 (2026-07 review, ui P3) board redesign: column wells,
// state-dot headers, the full card spec (semantic label chips, relative updated-at), guided
// empty states · ui P8 search upgrade: q matches description via a server-side WHERE + a card
// match-context snippet. Pure read-only rendering through the query_only db.
import { DatabaseSync } from "node:sqlite";
import { isTeamProject } from "../team-config.ts";
import { esc, href, toTicket, ownerOf, prioOf, noticeHtml, countPill, stateDot } from "./ui.ts";

const CORE_STATES = ["Todo", "In Progress", "In Review", "Done"]; // always shown (Linear-like board)
// Human-Blocked (DL-25) is a parking state — ordered after In Review, but rendered ONLY when populated
// (like Backlog/Canceled/Duplicate), so an empty Human-Blocked column never clutters a healthy board.
const STATE_ORDER = ["Backlog", "Todo", "In Progress", "In Review", "Human-Blocked", "Done", "Canceled", "Duplicate"];
const TERMINAL_STATES = ["Done", "Canceled", "Duplicate"]; // DL-45: excluded from the composition summary band (the band shows the shape of OPEN work)

// F3: per-column empty hint — an empty core column says what "empty HERE" means instead of an
// em-dash. Only the four core columns can be empty (the others render only when populated), but a
// generic fallback covers any future state.
const COL_HINTS: Record<string, string> = {
  "Todo": "Nothing queued",
  "In Progress": "Nothing in flight",
  "In Review": "Nothing awaiting verification",
  "Done": "Nothing finished yet",
};

// F3: the §4/§13 workflow-label semantic color map — the board is the operator's primary monitoring
// surface, so the alarm/routing labels (blocked / needs-* / incident / sensitive / the design tier)
// must read at a glance. Every color is a STATE/SIGNAL token (never a hex — the webui no-hex guard);
// labels outside the map stay neutral. needs-* is a §4 prefix family (needs-pm / needs-qa / …):
// "this ticket waits on someone" ⇒ the warn signal.
const LABEL_VAR: Record<string, string> = {
  incident: "--c-incident",
  blocked: "--s-blocked", "external-code": "--s-blocked", "external-access": "--s-blocked",
  sensitive: "--c-bug",
  design: "--s-review", "tech-debt": "--s-review",
  "senior-dev": "--brand", "junior-dev": "--c-info",
  signal: "--c-warn", coverage: "--c-improve",
};
export function labelVar(label: string): string | null {
  return LABEL_VAR[label] ?? (label.startsWith("needs-") ? "--c-warn" : null);
}
// One label chip; a semantic label gets the tinted .lbl-c treatment via an inline `--lc` custom
// property (the stateDot pattern: the token sheet stays the single color source, and CSP already
// allows inline style). .lbl-c declares a --lc fallback so the sheet's var() refs always resolve.
export function labelChip(label: string): string {
  const v = labelVar(label);
  return v
    ? `<span class="lbl lbl-c" style="--lc:var(${v})">${esc(label)}</span>`
    : `<span class="lbl">${esc(label)}</span>`;
}

// Card chips: the mandatory `dev-loop` marker and the pm/qa OWNER labels are suppressed (the marker
// is identical noise on every card; the owner already has its own meta-row slot) — both stay fully
// visible on the ticket detail page. Semantic (alarm) labels rank first so the 3-chip cap can never
// hide a blocked/incident signal behind a cosmetic label; the overflow "+n" carries the hidden
// names in its title.
const CARD_HIDDEN_LABELS = new Set(["dev-loop", "pm", "qa"]);
const MAX_CARD_CHIPS = 3;
function cardChips(labels: string[]): string {
  const visible = labels.filter((l) => !CARD_HIDDEN_LABELS.has(l));
  if (!visible.length) return "";
  const ranked = [...visible.filter((l) => labelVar(l) !== null), ...visible.filter((l) => labelVar(l) === null)];
  const over = ranked.length - MAX_CARD_CHIPS;
  return `<div class="card-labels">` + ranked.slice(0, MAX_CARD_CHIPS).map(labelChip).join("")
    + (over > 0 ? `<span class="lbl lbl-more" title="${esc(ranked.slice(MAX_CARD_CHIPS).join(", "))}">+${over}</span>` : "")
    + `</div>`;
}

// F3: relative updated-at ("3d" / "2h" / "5m" / "now"; title carries the ISO instant) — mirrors
// projects.ts relLabel. A missing/unparseable timestamp renders nothing (never a NaN).
function relTime(iso: string | null | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const m = Math.floor(Math.max(0, nowMs - t) / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const label = d > 0 ? `${d}d` : h > 0 ? `${h}h` : m > 0 ? `${m}m` : "now";
  return `<time class="when" datetime="${esc(iso)}" title="updated ${esc(iso)}">${esc(label)}</time>`;
}

// ui P8: cap on how many description chars the q LIKE scans per row (see the boardPage q comment).
const Q_DESC_CAP = 5000;
// ui P8: when the free-text q matched only the DESCRIPTION (not the visible id/title), the card
// shows a one-line match-context snippet — otherwise the operator sees a card with no visible reason
// it matched. ±~30/50 chars around the first hit, whitespace collapsed; esc() at interpolation.
function qSnippet(t: ReturnType<typeof toTicket>, q?: string): string {
  if (!q) return "";
  const ql = q.toLowerCase();
  if (String(t.id).toLowerCase().includes(ql) || String(t.title ?? "").toLowerCase().includes(ql)) return "";
  const desc = String(t.description ?? "");
  const i = desc.toLowerCase().indexOf(ql);
  if (i < 0) return "";
  const from = Math.max(0, i - 30), to = Math.min(desc.length, i + ql.length + 50);
  return `<div class="snippet">${from > 0 ? "… " : ""}${esc(desc.slice(from, to).replace(/\s+/g, " "))}${to < desc.length ? " …" : ""}</div>`;
}

// F3 card spec: row1 = mono id + type badge + relative updated-at (right); row2 = title (2-line
// clamp in CSS); row3 = semantic label chips (only when any survive the card filter); row4 = owner ·
// @assignee (DL-31, gated) · priority (right; Urgent = filled pill, High = ↑ + warn — CSS).
// ui P8: an active q appends the description match-context snippet under the title.
function cardHtml(projectKey: string, t: ReturnType<typeof toTicket>, nowMs: number, q?: string): string {
  return `<a class="card" href="${esc(href(projectKey, `/ticket/${encodeURIComponent(t.id)}`))}">`
    + `<div class="card-top"><span class="id">${esc(t.id)}</span><span class="badge t-${esc(t.type)}">${esc(t.type)}</span>${relTime(t.updated_at, nowMs)}</div>`
    + `<div class="title">${esc(t.title)}</div>`
    + qSnippet(t, q)
    + cardChips(t.labels)
    + `<div class="card-meta"><span class="owner">${esc(ownerOf(t.labels))}</span>`
    + (t.assignee ? `<span class="who">@${esc(t.assignee)}</span>` : "")
    + `<span class="prio p${esc(t.priority)}">${esc(prioOf(t.priority))}</span></div></a>`;
}

// F3: the guided board-level empty state — a dead board must orient the operator, not shrug (the
// 2026-07 review's "looks dead" finding). Filter-aware: "none match" + a clear-filters action when
// filters exclude everything, vs what this board IS + the EXACT CLI command that files work into it
// when the project genuinely holds nothing yet (the _team intake mailbox gets its own wording).
function emptyStateHtml(projectKey: string, clearHref: string, filtered: boolean, canWrite: boolean): string {
  if (filtered) {
    return `<div class="empty-state"><h2>No tickets match the active filters</h2>`
      + `<p>Every ticket on this board is excluded by the current filter set.</p>`
      + `<a class="lbl clearall" href="${esc(clearHref)}">clear filters</a></div>`;
  }
  const intake = isTeamProject(projectKey);
  const cmd = `DEVLOOP_PROJECT=${projectKey} dev-loop ticket create --title "<your ${intake ? "ask" : "title"}>" --type ${intake ? "Feature" : "Feature|Bug|Improvement"}`;
  return `<div class="empty-state">`
    + (intake
      ? `<h2>No intake yet</h2><p>${esc(projectKey)} is the team&#39;s intake mailbox — cross-project asks land here for PM triage; it is not a delivery board.</p><p>File an ask from a terminal:</p>`
      : `<h2>No tickets yet</h2><p>Work lands here when the agents file it (PM grooms the roadmap into tickets) — or file the first one yourself:</p>`)
    + `<code>${esc(cmd)}</code>`
    + (canWrite ? `<p class="empty-alt">…or use the “+ New ticket” form above.</p>` : "")
    + `</div>`;
}

// DL-20: the board filter/search keys — mirror the /api/tickets filter semantics (state/type/label,
// + assignee) plus a free-text `q` over id/title/description (ui P8). Server-side + read-only; no
// client JS, no build step.
export interface BoardFilters { state?: string; type?: string; label?: string; assignee?: string; q?: string }
export const FILTER_KEYS = ["state", "type", "label", "assignee", "q"] as const;

// Board: tickets grouped into state columns. Core workflow columns always render (even empty);
// Backlog/Canceled/Duplicate and any other state show only when populated, terminals last. DL-20 adds
// optional server-side filter/search (from the GET / query string) + a clearable, deep-linkable control row.
// DL-86: `opts` lets a failed create (POST /ticket) RE-RENDER the board with an inline error notice (instead
// of a raw-JSON dead-end) and preserve the operator's typed title in the create form (DL-14-style).
// F3: opts.nowMs pins "now" for the relative updated-at labels (tests inject it; live requests default).
export function boardPage(db: DatabaseSync, projectId: string, projectKey: string, filters: BoardFilters = {}, canWrite = false, group?: string, opts: { notice?: { kind: "error" | "ok"; msg: string }; submittedTitle?: string; nowMs?: number } = {}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const f = filters;
  // ui P8: the free-text q rides a server-side WHERE and matches DESCRIPTION text too (id/title as
  // before). lower() on both sides keeps the match deterministically case-insensitive (sqlite's bare
  // LIKE only case-folds ASCII; lower() shares that ASCII limit — the old JS toLowerCase folded full
  // Unicode, an accepted tradeoff for pushing the scan into the engine). LIKE metacharacters in the
  // query are escaped so the search text is always literal (%/_ can't wildcard). A leading-wildcard
  // LIKE can never use an index, so the description scan is CAPPED at the first Q_DESC_CAP chars per
  // row, bounding the per-row cost on pathological multi-hundred-KB agent-authored descriptions —
  // the tradeoff: a phrase appearing ONLY beyond the cap misses (id/title always match in full, and
  // per-project ticket sets are small, so the scan stays cheap).
  const qWhere = f.q
    ? ` AND (lower(id) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\' OR lower(substr(description,1,${Q_DESC_CAP})) LIKE ? ESCAPE '\\')`
    : "";
  const qArgs: string[] = f.q ? Array(3).fill(`%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : [];
  let tickets = (db.prepare(`SELECT * FROM tickets WHERE project_id=?${qWhere} ORDER BY priority ASC, updated_at DESC`)
    .all(projectId, ...qArgs) as Record<string, any>[]).map(toTicket);
  // mirror /api/tickets: each present (non-empty) filter narrows the set
  if (f.state) tickets = tickets.filter((t) => t.state === f.state);
  if (f.type) tickets = tickets.filter((t) => t.type === f.type);
  if (f.label) tickets = tickets.filter((t) => t.labels.includes(f.label!));
  if (f.assignee) tickets = tickets.filter((t) => t.assignee === f.assignee);

  // DL-31: ?group=assignee (validated upstream to the one known value) switches the board to assignee
  // swimlanes. swim===false is byte-identical to the pre-DL-31 board apart from the always-present group
  // toggle. The URL helper carries `group` so filter/search/chip links keep the active view (deep-linkable);
  // F2: it emits the canonical /p/<key>/ URL (href) so a filter click never drops off the project.
  const swim = group === "assignee";
  const qstr = (over: { omit?: string; group?: string | null } = {}) => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (f[k] && k !== over.omit) p.set(k, f[k]!);
    const g = over.group === undefined ? group : over.group; // null ⇒ explicitly drop group
    if (g) p.set("group", g);
    const s = p.toString(); return href(projectKey, s ? `/?${s}` : "/");
  };

  // control row: active filters as clearable chips + a free-text search form + a state↔assignee group
  // toggle; all reflected in the URL. A chip's link drops just that key but keeps the group view;
  // "clear all" drops every filter but keeps the view. esc() everything (AC4).
  // F3: the search input rides a .search wrapper (the CSS ::before magnifier glyph — an input can't
  // carry a pseudo-element) and the submit gets the brand-primary treatment.
  const active = FILTER_KEYS.filter((k) => f[k]);
  const clearHref = href(projectKey, swim ? "/?group=assignee" : "/");
  const chips = active.map((k) => `<a class="lbl" href="${esc(qstr({ omit: k }))}" aria-label="remove filter ${esc(k)} ${esc(f[k])}">${esc(k)}: ${esc(f[k])} <span aria-hidden="true">✕</span></a>`).join(" ");
  const hidden = (["state", "type", "label", "assignee"] as const).map((k) => f[k] ? `<input type="hidden" name="${k}" value="${esc(f[k])}">` : "").join("")
    + (group ? `<input type="hidden" name="group" value="${esc(group)}">` : "");
  const groupToggle = `<span class="group-tg">group:`
    + `<a class="lbl${swim ? "" : " on"}" href="${esc(qstr({ group: null }))}">state</a>`
    + `<a class="lbl${swim ? " on" : ""}" href="${esc(qstr({ group: "assignee" }))}">assignee</a></span>`;
  const controls = `<form class="filterbar" method="get" action="${esc(href(projectKey, "/"))}">${hidden}`
    + `<span class="search"><input type="text" name="q" value="${esc(f.q ?? "")}" placeholder="search id / title / description" aria-label="search tickets by id, title, or description" spellcheck="false"></span>`
    + `<button type="submit" class="btn-brand">search</button>`
    + (active.length ? `<a class="lbl clearall" href="${esc(clearHref)}">clear all</a>` : "")
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
  // F3 column wells: a surface-2 rounded well per state; header = state dot + name + count pill;
  // an empty column renders its guided hint in a dashed drop-zone box (not an em-dash).
  const columnsFor = (subset: ReturnType<typeof toTicket>[]): string => {
    const byState = new Map<string, ReturnType<typeof toTicket>[]>();
    for (const t of subset) (byState.get(t.state) ?? byState.set(t.state, []).get(t.state)!).push(t);
    const cols = states.map((s) => {
      const cards = byState.get(s) ?? [];
      const body = cards.length ? cards.map((t) => cardHtml(projectKey, t, nowMs, f.q)).join("") : `<p class="col-empty">${esc(COL_HINTS[s] ?? "No tickets")}</p>`;
      return `<section class="col"><h2>${stateDot(s)}${esc(s)}${countPill(cards.length)}</h2>${body}</section>`;
    }).join("");
    return `<div class="board">${cols}</div>`;
  };

  let boardHtml: string;
  // F3 (codex 2026-07-11): a filtered-to-zero SWIM board falls back to the aligned empty wells —
  // an empty `<div class="swimlanes">` (zero lanes to render) would drop the class="board" grid
  // that the daemon e2e contract keeps on a no-match filter.
  if (swim && tickets.length) {
    // one lane per distinct assignee (sorted), with the unassigned lane last; each lane reuses the shared
    // aligned columns. Assignee labels esc()'d (operator-controlled DATA → never trusted as markup).
    const named = [...new Set(tickets.map((t) => t.assignee).filter((a): a is string => !!a))].sort();
    const lanesKeys: (string | null)[] = [...named, ...(tickets.some((t) => !t.assignee) ? [null] : [])];
    boardHtml = `<div class="swimlanes">` + lanesKeys.map((a) => {
      const subset = tickets.filter((t) => (a === null ? !t.assignee : t.assignee === a));
      const label = a === null ? "unassigned" : `@${a}`;
      return `<section class="lane"><h2 class="lane-h">${esc(label)}${countPill(subset.length)}</h2>${columnsFor(subset)}</section>`;
    }).join("") + `</div>`;
  } else {
    boardHtml = columnsFor(tickets);
  }

  // F3 empty states (replaces the bare one-line paragraph): a genuinely empty, unfiltered board renders
  // the guidance card INSTEAD of a grid of empty wells (nothing to align); a filtered-to-zero board keeps
  // the aligned wells (the daemon e2e contract) and appends the filter-aware card with its clear action.
  const emptyBoard = tickets.length === 0 && active.length === 0;
  const empty = tickets.length === 0 ? emptyStateHtml(projectKey, clearHref, active.length > 0, canWrite) : "";
  if (emptyBoard) boardHtml = "";
  // DL-29: opt-in "new ticket" form (only when humanWrite is enabled — gated upstream). POST → the daemon
  // create route, then PRG to the new ticket. esc() the option values (our own constants, but uniform).
  const newForm = canWrite
    ? `<form class="newticket" method="post" action="${esc(href(projectKey, "/ticket"))}">`
      + `<input type="text" name="title" value="${esc(opts.submittedTitle ?? "")}" placeholder="New ticket title" required spellcheck="false">` // DL-86: preserve typed title on a rejected create
      + `<select name="type"><option>Feature</option><option>Bug</option><option>Improvement</option></select>`
      + `<button type="submit" class="btn-brand">+ New ticket</button></form>`
    : "";
  // DL-45: an at-a-glance composition summary band over the NON-TERMINAL tickets of the (filtered) set — by
  // type, owner, and priority. A pure read-only aggregate over the rows already fetched + filtered above, so it
  // always agrees with the columns below it (and with the swimlanes, which split this same `tickets` set). The
  // terminal states (Done/Canceled/Duplicate) are excluded — the band shows the shape of OPEN work. Hidden when
  // there is no open work (an empty / all-terminal set) so it never renders an all-zero strip.
  // F3: a zero-count chip dims (class s0) so the populated counts carry the visual weight.
  const open = tickets.filter((t) => !TERMINAL_STATES.includes(t.state));
  const sumChip = (label: string, n: number) => `<span class="lbl${n === 0 ? " s0" : ""}">${esc(label)} <b>${n}</b></span>`;
  const sumGrp = (chips: string) => `<span class="sum-grp">${chips}</span>`;
  const summary = open.length
    ? `<div class="summary" title="composition of the ${open.length} open (non-terminal) ticket(s)${active.length ? ", filtered" : ""}">`
      + sumGrp(["Feature", "Bug", "Improvement"].map((ty) => sumChip(ty, open.filter((t) => t.type === ty).length)).join(""))
      + sumGrp(["pm", "qa"].map((o) => sumChip(o, open.filter((t) => ownerOf(t.labels) === o).length)).join(""))
      + sumGrp([1, 2, 3, 4, 0].map((p) => sumChip(prioOf(p), open.filter((t) => t.priority === p).length)).join(""))
      + `</div>`
    : "";
  // DL-86: an inline error notice on a failed create, rendered above the create form (mirrors roadmapPage's notice).
  return `<h1 class="vh">${esc(projectKey)} board</h1>` + noticeHtml(opts.notice) + controls + newForm + summary + boardHtml + empty;
}
