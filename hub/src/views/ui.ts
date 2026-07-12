// dev-loop hub daemon web UI — shared view primitives (the F1 split of daemonviews.ts).
//
// Owns what every page shares: esc() (the XSS choke point — every interpolated DB value passes
// through it), href() (the D2 canonical /p/<key>/ URL builder every view link rides), the tokens-v2
// STYLE sheet, the page() shell (project switcher + nav + SSE live-update script), the esc-first
// markdown renderer, and the small shared shape/format helpers (toTicket / ownerOf / prioOf /
// noticeHtml / countPill / stateDot). Pure string-returning functions only — no res handling, no
// writes, no network (daemon.ts owns HTTP). daemonviews.ts re-exports this module's public surface.

// ticket row → API shape (mirrors the MCP server's toTicket; labels/related_to are JSON columns).
// Shared by the HTML views and the daemon.ts JSON API routes (a row-shape helper, not view-only).
export function toTicket(r: Record<string, any>) {
  return {
    id: r.id, title: r.title, description: r.description, type: r.type, state: r.state,
    assignee: r.assignee, priority: r.priority,
    labels: JSON.parse(r.labels), duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to),
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
}

const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low", 0: "None" };
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s: unknown): string { return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]); }

// F2 (D2 multi-project routing): the ONE canonical project-URL builder — EVERY view link and form
// action routes through it, so a rendered page navigates within /p/<key>/ no matter how it was
// reached (the bare-path boot fallback still SERVES old bookmarks, but pages never emit bare links).
// `path` is the project-local path ("/", "/ticket/DL-1", "/?state=Todo"); the key is percent-encoded
// (a key can never escape its path segment), the path passes through verbatim.
export function href(projectKey: string, path = "/"): string {
  return `/p/${encodeURIComponent(projectKey)}${path.startsWith("/") ? "" : "/"}${path}`;
}

// Workflow state → its --s-* token: the single place a state maps to a color (project-index counts
// today; the F3 board column headers adopt the same dot). Unknown state → the neutral --mut.
const STATE_VAR: Record<string, string> = {
  "Backlog": "--s-backlog", "Todo": "--s-todo", "In Progress": "--s-progress", "In Review": "--s-review",
  "Human-Blocked": "--s-blocked", "Done": "--s-done", "Canceled": "--s-canceled", "Duplicate": "--s-canceled",
};
// The small state-colored dot. The color rides an inline style var() — the token sheet stays the
// single color source (the webui no-hex guard holds), and CSP already allows inline style.
export function stateDot(state: string): string {
  return `<span class="dot" style="background:var(${STATE_VAR[state] ?? "--mut"})" aria-hidden="true"></span>`;
}
// The state's --s-* token NAME (for tinted state chips — .schip rides it via an inline --sc var());
// same single-source map as stateDot, so a chip and a dot can never disagree on a state's color.
export function stateVar(state: string): string { return STATE_VAR[state] ?? "--mut"; }
// owner = the §4 routing label (pm/qa); shared by the board cards/summary band and the ticket meta.
export function ownerOf(labels: string[]): string { return labels.includes("pm") ? "pm" : labels.includes("qa") ? "qa" : "—"; }
export function prioOf(p: number): string { return PRIORITY[p] ?? String(p); }

// DL-86-style inline notice (error/ok) — one renderer shared by the board / ticket / roadmap
// re-render paths so a failed write's error banner can't drift across pages.
export function noticeHtml(n?: { kind: "error" | "ok"; msg: string }): string {
  return n ? `<p class="notice ${n.kind === "error" ? "n-err" : "n-ok"}">${esc(n.msg)}</p>` : "";
}
// The small count pill on column/lane headers and section headings (gap = the heading variant).
export function countPill(n: number, gap = false): string {
  return `<span class="count${gap ? " count-gap" : ""}">${n}</span>`;
}

// Design tokens v2 (2026-07 review, ui P2). ONE :root sheet owns every color (surface tiers, ink
// tiers, brand, ticket types, workflow STATES, signals), the full type scale (--fs-*/--lh-*/--fw-*),
// the spacing (--sp-*) and radius (--r-*) scales, elevation (--shadow-*), and the focus ring
// (--focus). Views reference tokens via var() and NEVER hardcode a hex — test/webui.ts asserts no
// raw hex outside :root, that every scale exists, and that no literal border-radius remains (the v1
// sheet declared --radius then bypassed it). Every accent/state token carries a per-scheme value:
// the light values sit on the light surfaces, the dark values are lighter shades chosen to clear
// WCAG AA (4.5:1) on their scheme's surface (the 2026-07 design-input contrast notes). Dark
// elevation swaps drop shadows for a border-glow (a drop shadow on near-black reads as mud).
const STYLE = `
:root{
  color-scheme:light dark;
  --bg:#f7f8fa;--surface:#ffffff;--surface-2:#eef0f4;--surface-3:#e4e7ec;
  --line:#e3e6ea;--line-strong:#c9cdd4;
  --ink:#16181d;--ink-2:#3f4650;--mut:#6b7280;--mut-2:#9aa1ab;
  --brand:#4f46e5;--brand-ink:#ffffff;
  --c-feature:#2563eb;--c-bug:#dc2626;--c-improve:#16a34a;
  --s-backlog:#94a3b8;--s-todo:#64748b;--s-progress:#d97706;--s-review:#7c3aed;--s-blocked:#ea580c;--s-done:#16a34a;--s-canceled:#9ca3af;
  --c-urgent:#dc2626;--c-warn:#b45309;--c-ok:#16a34a;--c-info:#475569;--c-incident:#be123c;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --fs-xs:11px;--lh-xs:16px;--fs-sm:12.5px;--lh-sm:18px;--fs-base:14px;--lh-base:21px;--fs-md:16px;--lh-md:24px;--fs-lg:20px;--lh-lg:28px;--fs-xl:24px;--lh-xl:32px;
  --fw-regular:400;--fw-medium:500;--fw-semibold:600;--fw-bold:700;
  --sp-1:4px;--sp-2:8px;--sp-3:12px;--sp-4:16px;--sp-5:24px;--sp-6:32px;
  --r-sm:4px;--r-md:8px;--r-lg:12px;--r-full:999px;
  --shadow-1:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.09);
  --shadow-2:0 4px 6px rgba(16,24,40,.05),0 10px 20px rgba(16,24,40,.10);
  --focus:0 0 0 2px var(--bg),0 0 0 4px var(--brand);
}
@media(prefers-color-scheme:dark){:root{
  --bg:#111318;--surface:#1a1d23;--surface-2:#22262e;--surface-3:#2a2f38;
  --line:#2c313a;--line-strong:#3d434e;
  --ink:#e7e9ec;--ink-2:#c2c7cf;--mut:#9aa3af;--mut-2:#6f7680;
  --brand:#818cf8;--brand-ink:#111318;
  --c-feature:#60a5fa;--c-bug:#f87171;--c-improve:#4ade80;
  --s-backlog:#64748b;--s-todo:#94a3b8;--s-progress:#fbbf24;--s-review:#a78bfa;--s-blocked:#fb923c;--s-done:#4ade80;--s-canceled:#6b7280;
  --c-urgent:#f87171;--c-warn:#fbbf24;--c-ok:#4ade80;--c-info:#94a3b8;--c-incident:#fb7185;
  --shadow-1:0 0 0 1px rgba(255,255,255,.04);
  --shadow-2:0 0 0 1px rgba(255,255,255,.07);
}}
/* body line-height is the UNITLESS form of the base step (14px × 1.5 = 21px = --lh-base) ON PURPOSE:
   an absolute var(--lh-base) would inherit 21px into larger text (e.g. .detail h1) and cramp it —
   unitless recomputes per element. Elements ON the type scale set their own --lh-* explicitly. */
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:var(--fs-base);line-height:1.5;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:baseline;gap:.6rem;padding:.7rem 1rem;border-bottom:1px solid var(--line)}
header .home{font-weight:var(--fw-bold);text-decoration:none;color:var(--ink)}header .proj{color:var(--mut)}
header a.proj{text-decoration:none}header a.proj:hover{color:var(--ink)}
main{padding:1rem}
.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:var(--sp-4);max-width:900px}
.pcard{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--sp-4);text-decoration:none;color:inherit;box-shadow:var(--shadow-1)}
.pcard:hover{border-color:var(--line-strong);box-shadow:var(--shadow-2)}
.pcard .pkey{font:var(--fw-semibold) var(--fs-xs)/var(--lh-xs) var(--font-mono);color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.pcard h2{margin:var(--sp-1) 0 var(--sp-2);font-size:var(--fs-md);line-height:var(--lh-md);font-weight:var(--fw-semibold);color:var(--ink)}
.pstates{display:flex;gap:var(--sp-3);flex-wrap:wrap;margin:0 0 var(--sp-2)}
.pstate{display:inline-flex;align-items:center;gap:var(--sp-1);font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--ink-2)}
.dot{display:inline-block;width:8px;height:8px;border-radius:var(--r-full);flex:none}
.psub{margin:0 0 var(--sp-2);font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--mut)}
.plast{margin:0;font-size:var(--fs-xs);line-height:var(--lh-xs);color:var(--mut-2)}
.pcard.team{background:var(--surface-2);border-style:dashed}
/* ── board redesign (ui P3): surface-2 column wells · state-dot headers · guided empty columns ── */
.board{display:flex;gap:var(--sp-3);align-items:flex-start;overflow-x:auto;padding-bottom:var(--sp-2)}
.col{flex:0 0 280px;background:var(--surface-2);border-radius:var(--r-lg);padding:var(--sp-2)}
.col h2{display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-sm);line-height:var(--lh-sm);text-transform:uppercase;letter-spacing:.03em;color:var(--mut);margin:var(--sp-1) var(--sp-1) var(--sp-2);font-weight:var(--fw-semibold)}
.col .count,.lane-h .count{background:var(--surface-3);color:var(--mut);border-radius:var(--r-full);padding:0 .45rem;font-size:var(--fs-xs);line-height:var(--lh-xs)}
.lane-h .count{margin-left:.3rem}
.col-empty{border:1px dashed var(--line-strong);border-radius:var(--r-md);margin:0;padding:var(--sp-4) var(--sp-2);text-align:center;font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--mut)}
.swimlanes{display:flex;flex-direction:column;gap:1.1rem}
.lane{border-top:1px solid var(--line);padding-top:.55rem}
.lane-h{font-size:.85rem;font-weight:var(--fw-semibold);margin:.1rem .2rem .55rem;color:var(--ink)}
.who{color:var(--ink);font-weight:var(--fw-medium)}
.group-tg{display:inline-flex;align-items:center;gap:.25rem;margin-left:.2rem;font-size:var(--fs-xs);color:var(--mut)}
.lbl.on{color:var(--ink);border-color:var(--mut);background:var(--surface)}
/* ── board redesign (ui P3): the full card spec — elevation, 2-line title clamp, label chips row ── */
.card{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--sp-3);margin-bottom:var(--sp-2);text-decoration:none;color:inherit;box-shadow:var(--shadow-1)}
.card:hover{border-color:var(--line-strong);box-shadow:var(--shadow-2)}
.card-top{display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem}
.card-top .when{margin-left:auto;font-size:var(--fs-xs);line-height:var(--lh-xs);color:var(--mut-2)}
.id{font:600 var(--fs-xs) var(--font-mono);color:var(--mut)}
.title{font-weight:var(--fw-medium);font-size:var(--fs-base);line-height:var(--lh-base);margin:.1rem 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-labels{display:flex;gap:var(--sp-1);flex-wrap:wrap;margin-top:var(--sp-2)}
.card-meta{display:flex;gap:.5rem;align-items:center;margin-top:var(--sp-2);font-size:var(--fs-xs);line-height:var(--lh-xs);color:var(--mut)}
.card-meta .prio{margin-left:auto}
.badge{font-size:var(--fs-xs);border:1px solid var(--line);border-radius:var(--r-sm);padding:0 .35rem;color:var(--mut)}
.badge.t-Feature{color:var(--c-feature);border-color:color-mix(in srgb,var(--c-feature) 45%,var(--line))}.badge.t-Bug{color:var(--c-bug);border-color:color-mix(in srgb,var(--c-bug) 45%,var(--line))}.badge.t-Improvement{color:var(--c-improve);border-color:color-mix(in srgb,var(--c-improve) 45%,var(--line))}
.prio.p1{background:var(--c-urgent);color:var(--brand-ink);border-radius:var(--r-full);padding:0 var(--sp-2);font-weight:var(--fw-semibold)}
.prio.p2{color:var(--c-warn);font-weight:var(--fw-medium)}.prio.p2::before{content:"↑ "}
.empty{color:var(--mut);font-size:.8rem;padding:.3rem .2rem}
.back{display:inline-block;margin-bottom:.8rem;color:var(--mut);text-decoration:none}.back:hover{color:var(--ink)}
.detail{max-width:760px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:1.1rem 1.3rem}
.detail h1{font-size:1.4rem;margin:.4rem 0 .8rem}
.meta{display:grid;grid-template-columns:max-content 1fr;gap:.25rem .8rem;margin:.6rem 0 1rem}
.meta dt{color:var(--mut)}.meta dd{margin:0}
.lbl{font-size:.7rem;border:1px solid var(--line);border-radius:var(--r-sm);padding:0 .35rem;color:var(--mut);margin-right:.25rem}
/* ── board redesign (ui P3): semantic label chips — the color rides an inline --lc custom property
   (declared here with a neutral fallback so every var() ref in this sheet resolves) ── */
.lbl-c{--lc:var(--mut);color:var(--lc);border-color:color-mix(in srgb,var(--lc) 45%,var(--line));background:color-mix(in srgb,var(--lc) 12%,var(--surface))}
.lbl-more{color:var(--mut-2)}
pre{white-space:pre-wrap;word-wrap:break-word;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-md);padding:.7rem .8rem;font:var(--fs-sm)/1.5 var(--font-mono);overflow-x:auto}
h3{margin:1.2rem 0 .4rem;font-size:.95rem}
.comment{margin:.5rem 0}.c-head{font-size:.78rem;color:var(--mut);margin-bottom:.2rem}.c-head time{margin-left:.4rem}
nav{margin-left:auto;display:flex;gap:var(--sp-4)}
nav a{color:var(--mut);text-decoration:none;padding:.15rem 0;border-bottom:2px solid transparent}nav a:hover{color:var(--ink)}
nav a[aria-current=page]{color:var(--ink);font-weight:var(--fw-medium);border-bottom-color:var(--brand)}
form{margin:.7rem 0}form label{display:block;margin:.45rem 0;color:var(--mut);font-size:.82rem}
textarea{display:block;width:100%;margin:.3rem 0;padding:.6rem;border:1px solid var(--line);border-radius:var(--r-md);background:var(--bg);color:var(--ink);font:var(--fs-sm)/1.5 var(--font-mono)}
input[type=text]{padding:.3rem .45rem;border:1px solid var(--line);border-radius:var(--r-md);background:var(--bg);color:var(--ink);font:inherit}
button{font:inherit;padding:.4rem .85rem;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);color:var(--ink);cursor:pointer}button:hover{border-color:var(--mut)}
.pub{margin-top:.5rem}
.notice{padding:.5rem .7rem;border-radius:var(--r-md);margin:.6rem 0;font-size:.85rem}
.n-err{background:color-mix(in srgb,var(--c-bug) 12%,transparent);border:1px solid color-mix(in srgb,var(--c-bug) 45%,var(--line));color:var(--c-bug)}.n-ok{background:color-mix(in srgb,var(--c-ok) 12%,transparent);border:1px solid color-mix(in srgb,var(--c-ok) 45%,var(--line));color:var(--c-ok)}.n-info{background:color-mix(in srgb,var(--c-info) 12%,transparent);border:1px solid color-mix(in srgb,var(--c-info) 45%,var(--line));color:var(--c-info)}
.doc{max-width:72ch}
.doc>:first-child{margin-top:0}
.doc h1{margin:var(--sp-4) 0 var(--sp-2);font-size:var(--fs-lg);line-height:var(--lh-lg);font-weight:var(--fw-semibold)}
.doc h2{margin:var(--sp-5) 0 var(--sp-2);font-size:var(--fs-md);line-height:var(--lh-md);font-weight:var(--fw-semibold)}
.doc h3,.doc h4,.doc h5,.doc h6{margin:var(--sp-4) 0 var(--sp-1);font-size:var(--fs-base);line-height:var(--lh-base);font-weight:var(--fw-semibold);color:var(--ink-2)}
.doc ul,.doc ol{margin:.3rem 0;padding-left:1.3rem}.doc ul ul,.doc ul ol,.doc ol ul,.doc ol ol{margin:.1rem 0;padding-left:1.1rem}
.doc p{margin:.4rem 0}.doc hr{border:0;border-top:1px solid var(--line);margin:.7rem 0}
.doc blockquote{margin:.5rem 0;padding:.1rem .8rem;border-left:3px solid var(--line);color:var(--mut)}.doc a{color:var(--c-feature)}.doc pre code{background:none;padding:0}
code{font:.92em var(--font-mono);background:var(--bg);padding:0 .25rem;border-radius:var(--r-sm)}
.ragent{margin:.9rem 0}.ragent h3{margin:.2rem 0 .4rem}
.rlevel{display:flex;gap:.4rem;align-items:baseline;flex-wrap:wrap;margin:.25rem 0}
.rkey{font-size:var(--fs-xs);text-transform:uppercase;letter-spacing:.03em;color:var(--mut);min-width:3.5rem}
.warn{color:var(--c-bug);font-weight:var(--fw-semibold)}.sub{color:var(--mut)}
/* ── activity dashboard (ui P5): stat tiles · metric-group cards · timeline feed ── */
.apage>h1{font-size:var(--fs-lg);line-height:var(--lh-lg);font-weight:var(--fw-semibold);margin:.2rem 0 var(--sp-4)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--sp-3);margin:0 0 var(--sp-4);max-width:1100px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--sp-3);box-shadow:var(--shadow-1)}
.tile-v{display:block;font-size:var(--fs-xl);line-height:var(--lh-xl);font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums}
.tile-l{display:block;margin-top:var(--sp-1);font-size:var(--fs-xs);line-height:var(--lh-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--mut)}
.tile-warn{border-color:color-mix(in srgb,var(--c-warn) 45%,var(--line));background:color-mix(in srgb,var(--c-warn) 12%,var(--surface))}
.tile-warn .tile-v{color:var(--c-warn)}
.agrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--sp-4);align-items:start;max-width:1100px}
.acard{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--sp-4);box-shadow:var(--shadow-1);min-width:0}
.acard h3{margin:0 0 var(--sp-2);font-size:var(--fs-md);line-height:var(--lh-md)}
.acard h3 .count{background:var(--surface-2);color:var(--mut);border-radius:var(--r-full);padding:0 .45rem;font-size:var(--fs-xs);font-weight:var(--fw-regular)}
.acard .rlevel{margin:0;padding:var(--sp-1) 0;border-top:1px solid var(--line)}
.acard .rlevel>span:last-child{flex:1;min-width:0}
.acard .empty{padding:var(--sp-2) 0}
.afeed{margin-top:var(--sp-4);max-width:1100px}
.flag{display:inline-block;border-radius:var(--r-full);padding:0 var(--sp-2);font-size:var(--fs-xs);line-height:var(--lh-xs);white-space:nowrap}
.flag.warn{background:color-mix(in srgb,var(--c-bug) 10%,var(--surface))}
.bar{display:block;width:100%;height:6px;margin-top:var(--sp-1);background:var(--surface-2);border-radius:var(--r-full);overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:var(--r-full)}
.feed{position:relative;margin-top:var(--sp-2)}
.feed::before{content:"";position:absolute;left:11px;top:14px;bottom:14px;width:2px;background:var(--line)}
.ev-day{position:relative;margin:var(--sp-3) 0 var(--sp-1) 36px;font-size:var(--fs-xs);line-height:var(--lh-xs);font-weight:var(--fw-semibold);text-transform:uppercase;letter-spacing:.04em;color:var(--mut-2)}
.ev-row{position:relative;display:flex;gap:var(--sp-3);align-items:flex-start;padding:var(--sp-1) 0}
.ev-ico{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-full);font-size:var(--fs-sm);line-height:1}
.ev-body{flex:1;min-width:0;font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--ink-2);padding-top:3px}
.ev-body b{color:var(--ink)}
.ev-actor{display:inline-block;background:var(--surface-2);border-radius:var(--r-full);padding:0 var(--sp-2);font-size:var(--fs-xs);line-height:var(--lh-xs);font-weight:var(--fw-medium);color:var(--ink-2)}
.ev-time{margin-left:var(--sp-1);font-size:var(--fs-xs);color:var(--mut-2);white-space:nowrap}
/* ── board search (ui P8): description-match context snippet on a card ── */
.snippet{margin-top:.3rem;font-size:var(--fs-xs);line-height:var(--lh-xs);color:var(--mut);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
a.lbl{cursor:pointer}a.lbl:hover{border-color:var(--mut);color:var(--ink)}
.filterbar{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;margin:0 0 .8rem}
.filterbar .chips{display:flex;gap:.3rem;flex-wrap:wrap;margin-left:.2rem}
.filterbar .clearall{border-style:dashed}
/* ── board redesign (ui P3): search affordance (CSS magnifier glyph, no icon font) + brand-primary action ── */
.search{position:relative;display:inline-flex}
.search::before{content:"⌕";position:absolute;left:.5rem;top:50%;transform:translateY(-50%);color:var(--mut-2);pointer-events:none;font-size:var(--fs-md);line-height:1}
.search input{width:260px;max-width:100%;padding-left:1.6rem}
.btn-brand{background:var(--brand);color:var(--brand-ink);border-color:var(--brand)}
.btn-brand:hover{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 85%,var(--ink))}
.summary{display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin:0 0 .8rem;padding:.4rem .55rem;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-md)}
.summary .sum-grp{display:flex;gap:.3rem;flex-wrap:wrap}
.summary .lbl{cursor:default}.summary .lbl b{color:var(--ink);font-weight:var(--fw-semibold)}
.summary .lbl.s0{color:var(--mut-2)}.summary .lbl.s0 b{color:var(--mut-2);font-weight:var(--fw-regular)}
/* ── board redesign (ui P3): the guided board-level empty state ── */
.empty-state{max-width:460px;margin:var(--sp-5) auto;padding:var(--sp-5);background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-1);text-align:center}
.empty-state h2{margin:0 0 var(--sp-2);font-size:var(--fs-md);line-height:var(--lh-md);font-weight:var(--fw-semibold)}
.empty-state p{margin:0 0 var(--sp-3);font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--mut)}
.empty-state code{display:inline-block;max-width:100%;text-align:left;padding:var(--sp-1) var(--sp-2);font-size:var(--fs-xs);line-height:var(--lh-xs);color:var(--ink-2);background:var(--surface-2);border-radius:var(--r-sm);overflow-wrap:anywhere}
.empty-state .empty-alt{margin:var(--sp-3) 0 0}
.empty-state .lbl{font-size:var(--fs-sm)}
.count-gap{margin-left:.4rem}
.vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
h3 .live-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:var(--r-full);background:var(--c-ok);margin-left:.5rem;vertical-align:middle;opacity:.5;transition:opacity .3s}
h3 .live-dot.on{opacity:1}
/* ── docs system (F4/D3): drafts-pending header chip · index version badges · doc links · diff tints —
   all token-riding (the tinted-chip color-mix pattern; no hex, no literal radius) ── */
.chip-drafts{font-size:var(--fs-xs);line-height:var(--lh-xs);text-decoration:none;white-space:nowrap;color:var(--c-warn);border:1px solid color-mix(in srgb,var(--c-warn) 45%,var(--line));background:color-mix(in srgb,var(--c-warn) 12%,var(--surface));border-radius:var(--r-full);padding:0 .5rem}
.chip-drafts:hover{border-color:var(--c-warn)}
.lbl.vpub{color:var(--c-ok);border-color:color-mix(in srgb,var(--c-ok) 45%,var(--line))}
.lbl.vpend{color:var(--c-warn);border-color:color-mix(in srgb,var(--c-warn) 45%,var(--line));background:color-mix(in srgb,var(--c-warn) 12%,var(--surface))}
.doclink{color:var(--c-feature);text-decoration:none;margin-right:.4rem}.doclink:hover{text-decoration:underline}
.vlinks a{color:var(--mut);text-decoration:none;margin-right:.15rem}.vlinks a:hover{color:var(--ink)}.vlinks .vcur{font-weight:var(--fw-semibold);margin-right:.15rem}
.diff .da,.diff .dd,.diff .dc{display:block}
.diff .da{background:color-mix(in srgb,var(--c-ok) 14%,var(--surface))}
.diff .dd{background:color-mix(in srgb,var(--c-bug) 12%,var(--surface))}
.diff .dc{color:var(--mut)}
:where(a,button,input,textarea,select,summary):focus-visible{outline:none;box-shadow:var(--focus)}
/* ── ticket detail (ui P4): two-column layout · tinted state chip · identity dots · unified timeline ── */
.tgrid{display:flex;flex-direction:column;gap:var(--sp-4);max-width:1080px}
.tgrid .tside{order:-1}
.tmain{min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--sp-5);box-shadow:var(--shadow-1)}
.tmain h1{margin:var(--sp-2) 0 var(--sp-3);font-size:var(--fs-xl);line-height:var(--lh-xl);font-weight:var(--fw-semibold)}
.schip{--sc:var(--mut);display:inline-flex;align-items:center;gap:var(--sp-1);background:color-mix(in srgb,var(--sc) 12%,var(--surface));color:color-mix(in srgb,var(--sc) 60%,var(--ink));border:1px solid color-mix(in srgb,var(--sc) 45%,var(--line));border-radius:var(--r-full);padding:0 var(--sp-2);font-size:var(--fs-sm);line-height:var(--lh-sm);font-weight:var(--fw-medium)}
.tside{min-width:0}
.tside-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:var(--sp-4);box-shadow:var(--shadow-1)}
.tside .meta{display:block;margin:0}
.tside .meta dt{font-size:var(--fs-xs);line-height:var(--lh-xs);text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin-top:var(--sp-3)}
.tside .meta dt:first-child{margin-top:0}
.tside .meta dd{margin:var(--sp-1) 0 0;font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--ink)}
.tside .lbl{display:inline-block;margin:0 var(--sp-1) var(--sp-1) 0}
.tside form.act{display:flex;gap:var(--sp-2);margin:var(--sp-3) 0 0}
.tside form.act select,.tside form.act input[type=text]{flex:1;min-width:0}
select{font:inherit;padding:.3rem .45rem;border:1px solid var(--line);border-radius:var(--r-md);background:var(--bg);color:var(--ink)}
.idot{--idl:var(--mut);--idd:var(--mut-2);display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:var(--r-full);background:var(--idl);color:var(--brand-ink);font-size:var(--fs-xs);line-height:var(--lh-xs);font-weight:var(--fw-semibold);flex:none;vertical-align:text-bottom}
@media(prefers-color-scheme:dark){.idot{background:var(--idd)}}
.timeline{list-style:none;margin:var(--sp-3) 0 0 9px;padding:0 0 0 var(--sp-4);border-left:2px solid var(--line)}
.tl-item{position:relative;padding:0 0 var(--sp-4);font-size:var(--fs-sm);line-height:var(--lh-sm);color:var(--ink-2)}
.tl-item:last-child{padding-bottom:var(--sp-1)}
.tl-item>.idot{position:absolute;left:-26px;top:0}
.tl-item time{color:var(--mut)}
.tl-body>time{margin-left:var(--sp-1)}
.tl-comment .doc{margin-top:var(--sp-1);background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-md);padding:var(--sp-2) var(--sp-3)}
@media(min-width:900px){.tgrid{display:grid;grid-template-columns:minmax(0,1fr) 260px;align-items:start}.tgrid .tside{order:0}}
@media(max-width:640px){
  main{padding:.6rem}
  .board{scroll-snap-type:x mandatory}
  .col{flex-basis:85vw;scroll-snap-align:start}
  .filterbar input,.filterbar button{min-height:2.2rem}
  .search{flex:1}.search input{width:100%}
  .detail{padding:.9rem 1rem}
  .meta{grid-template-columns:1fr}
}
`;
// Exported for the test/webui.ts token guards (asserted on the EVALUATED sheet, not source slices).
export { STYLE };

// The project-scoped nav pages, in nav order; `active` marks the current one (aria-current="page" +
// the 2px brand underline — the 2026-07 shell spec's active state). F4/D3: "docs" replaced "roadmap"
// (GET /roadmap is now a 302 onto the roadmap DOC page, reachable from the /docs index).
const NAV = ["board", "docs", "activity", "reports"] as const;
export interface PageOpts {
  active?: (typeof NAV)[number]; // which nav item is the current page (absent ⇒ none marked)
  hub?: boolean;                 // a HUB-level page (project index / unknown-project 404): no project nav, all-projects SSE scope
  drafts?: number;               // docs P6a: gated docs with a draft ahead of published — >0 renders the header "N drafts pending" chip → /docs
}
export function page(title: string, project: string, inner: string, opts: PageOpts = {}): string {
  // Inline SVG favicon (a small "dl" mark) — data-URI, so no static-asset route and no /favicon.ico 404 noise.
  const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2563eb"/><text x="8" y="12" font-family="monospace" font-size="9" font-weight="700" fill="#fff" text-anchor="middle">dl</text></svg>')}`;
  // F2 (D2): the header IS the project switcher — the wordmark and the current project's key both
  // link to the project index at /; the nav routes through href() so every page of project X stays
  // on X (bare paths are served as a fallback but never emitted).
  const crumb = opts.hub
    ? `<span class="proj">projects</span>`
    : `<a class="proj" href="/" title="all projects — switch project">${esc(project)}</a>`;
  const nav = opts.hub ? "" : `<nav>` + NAV.map((n) =>
    `<a href="${esc(href(project, n === "board" ? "/" : `/${n}`))}"${opts.active === n ? ` aria-current="page"` : ""}>${n}</a>`).join("") + `</nav>`;
  // docs P6a: the drafts-pending chip — agent-drafted direction awaiting the operator-publish gate is
  // otherwise invisible (drafts silently stall). Resolved-project count only; links to the /docs index.
  const drafts = !opts.hub && (opts.drafts ?? 0) > 0
    ? `<a class="chip-drafts" href="${esc(href(project, "/docs"))}" title="doc drafts awaiting operator publish">${opts.drafts} draft${opts.drafts === 1 ? "" : "s"} pending</a>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<link rel="icon" href="${favicon}">`
    + `<style>${STYLE}</style></head><body>`
    + `<header><a class="home" href="/">dev-loop</a>${crumb}${drafts}`
    + `<span class="live-dot" id="live" title="live — updates when agents change the board"></span>`
    + `${nav}</header>`
    + `<main>${inner}</main>`
    + liveScript(opts.hub ? "/api/stream?all=1" : href(project, "/api/stream"))
    + `</body></html>`;
}

// Progressive-enhancement live updates (degrades to a static page with no JS). Subscribes to the SSE
// stream at `streamPath` — project-scoped via href() so a /p/<key>/ page reloads on ITS project's
// events only; the hub index watches the whole ledger (?all=1). The dot goes solid on new activity and
// the page auto-reloads — but NEVER while a form field is focused (so it can't interrupt an operator
// typing a roadmap edit / new ticket). JSON.stringify embeds the server-built path safely (the project
// key inside it is percent-encoded by href(), so no quote or </script> can reach the script body).
const liveScript = (streamPath: string) => `<script>
(function(){
  try{
    var dot=document.getElementById('live'), base=null, pending=false;
    var es=new EventSource(${JSON.stringify(streamPath)});
    function typing(){var a=document.activeElement;return a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.tagName==='SELECT');}
    es.onmessage=function(e){
      var id=e.data; if(base===null){base=id;return;}
      if(id!==base){ if(dot)dot.classList.add('on'); pending=true; if(!typing())location.reload(); }
    };
    document.addEventListener('focusout',function(){ if(pending&&!typing())location.reload(); });
  }catch(_){/* no EventSource ⇒ static page, fine */}
})();
</script>`;

// A tiny, dependency-free, XSS-safe markdown renderer (roadmap / reports / ticket descriptions /
// comments). The body is arbitrary agent-authored text, so we esc() FIRST (no user content can then
// inject a tag), and only THEN apply a closed set of block/inline transforms that emit ONLY our own
// <h*>/<ul>/<ol>/<li>/<strong>/<code>/<hr>/<p>.
export function renderMarkdown(md: string): string {
  // esc FIRST (input is arbitrary agent-authored text) — every rule below emits only its own tags around
  // already-escaped content, so the sole injection surface is a link href, which is allowlisted to
  // http(s):// or a same-site /path (never javascript:, data:, etc. — those render as inert text).
  const link = (url: string, text: string) =>
    /^(https?:\/\/|\/)/i.test(url) ? `<a href="${url}" rel="noopener noreferrer" target="_blank">${text}</a>` : null;
  const inline = (s: string) => {
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, url) => link(url, text) ?? whole); // [text](url)
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_w, pre, url) => `${pre}${link(url, url)}`);   // bare-URL autolink
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  };
  const out: string[] = [];
  let listTag: "ul" | "ol" | null = null;
  const closeList = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
  let fence: string[] | null = null; // non-null ⇔ inside a ``` block, accumulating raw (esc'd) lines
  for (const raw of esc(md).split("\n")) {
    if (/^\s*```/.test(raw)) { // fence open/close — inline transforms are suspended inside
      if (fence) { out.push(`<pre><code>${fence.join("\n")}</code></pre>`); fence = null; }
      else { closeList(); fence = []; }
      continue;
    }
    if (fence) { fence.push(raw); continue; }
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (/^\s*$/.test(line)) { closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); const l = m[1].length; out.push(`<h${l}>${inline(m[2])}</h${l}>`); continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*&gt;\s?(.*)$/))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; } // > blockquote (> is esc'd to &gt;)
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (listTag !== "ul") { closeList(); out.push("<ul>"); listTag = "ul"; } const cb = m[1].match(/^\[([ xX])\]\s+([\s\S]*)$/); out.push(cb ? `<li><input type="checkbox" disabled${cb[1] === " " ? "" : " checked"}> ${inline(cb[2])}</li>` : `<li>${inline(m[1])}</li>`); continue; } // DL-16: a `- [ ]`/`- [x]` item → a disabled checkbox (the text is already esc'd → XSS-safe)
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (listTag !== "ol") { closeList(); out.push("<ol>"); listTag = "ol"; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList(); out.push(`<p>${inline(line)}</p>`);
  }
  if (fence) out.push(`<pre><code>${fence.join("\n")}</code></pre>`); // unterminated fence
  closeList();
  return out.join("\n");
}
