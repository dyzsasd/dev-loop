// Web-UI design-system + markdown-renderer guards. The STYLE token sheet and the esc-first markdown
// renderer are the two pieces most likely to regress silently (a hardcoded hex that fails dark-mode AA;
// a literal radius that bypasses the scale; a link/fence rule that drops content or admits a
// javascript: href). F1: STYLE is asserted on the EVALUATED export (views/ui.ts via the daemonviews
// façade) — no more brittle source slicing.
import { renderMarkdown, STYLE } from "../src/daemonviews.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── 1. Design tokens: no raw hex outside the :root token blocks — every color must be a var() ──
// Drop the two :root{...} blocks (light + the dark @media override, where tokens are DEFINED), then
// assert no #rrggbb / #rgb remains (an accent that skips a token can't adapt to dark mode). rgba()
// shadow values pass — the guard is about hex color literals.
const styleNoRoot = STYLE.replace(/:root\{[^}]*\}/g, "");
const strayHex = [...styleNoRoot.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
ok(strayHex.length === 0, `no raw hex outside :root token blocks (design tokens are the single color source)${strayHex.length ? " — stray: " + strayHex.join(", ") : ""}`);
ok(STYLE.includes("color-scheme:light dark"), "the sheet declares color-scheme:light dark (native form controls follow the scheme)");

// ── 2. Tokens v2 (2026-07 review, ui P2): the full palette + scales every downstream view builds on ──
const TOKENS_V2 = [
  // surfaces + lines
  "--bg", "--surface", "--surface-2", "--surface-3", "--line", "--line-strong",
  // ink tiers + brand
  "--ink", "--ink-2", "--mut", "--mut-2", "--brand", "--brand-ink",
  // ticket types
  "--c-feature", "--c-bug", "--c-improve",
  // workflow states (board columns/dots/chips)
  "--s-backlog", "--s-todo", "--s-progress", "--s-review", "--s-blocked", "--s-done", "--s-canceled",
  // signals
  "--c-urgent", "--c-warn", "--c-ok", "--c-info", "--c-incident",
  // type scale (sizes / line-heights / weights) + mono stack
  "--font-mono",
  "--fs-xs", "--fs-sm", "--fs-base", "--fs-md", "--fs-lg", "--fs-xl",
  "--lh-xs", "--lh-sm", "--lh-base", "--lh-md", "--lh-lg", "--lh-xl",
  "--fw-regular", "--fw-medium", "--fw-semibold", "--fw-bold",
  // spacing scale
  "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6",
  // radius scale
  "--r-sm", "--r-md", "--r-lg", "--r-full",
  // elevation + focus ring
  "--shadow-1", "--shadow-2", "--focus",
];
const missingTokens = TOKENS_V2.filter((t) => !STYLE.includes(`${t}:`));
ok(missingTokens.length === 0, `tokens v2: every semantic/state/type/spacing/radius/shadow token is declared${missingTokens.length ? " — missing: " + missingTokens.join(", ") : ""}`);

// every var(--x) REFERENCE resolves to a declaration — a typo'd token (var(--surfaec)) silently
// computes to nothing in CSS, so guard refs-vs-defs on the evaluated sheet (codex 2026-07-11).
const declaredTokens = new Set([...STYLE.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
const referencedTokens = [...new Set([...STYLE.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1]))];
const unresolved = referencedTokens.filter((t) => !declaredTokens.has(t));
ok(unresolved.length === 0, `every var(--*) reference is backed by a token declaration${unresolved.length ? " — unresolved: " + unresolved.join(", ") : ""}`);

// dark mode re-declares the per-scheme values (AA per scheme — light values on light surfaces, lighter
// shades on dark; dark elevation is a border-glow, not a drop shadow).
const dark = STYLE.match(/@media\(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/)?.[1] ?? "";
const DARK_MUST = ["--bg", "--surface", "--surface-2", "--line", "--ink", "--mut", "--brand", "--c-feature", "--c-bug", "--s-progress", "--s-done", "--s-blocked", "--c-incident", "--shadow-1"];
const missingDark = DARK_MUST.filter((t) => !dark.includes(`${t}:`));
ok(missingDark.length === 0, `dark-mode :root override re-declares surfaces/accents/states/shadows${missingDark.length ? " — missing: " + missingDark.join(", ") : ""}`);

// the radius scale is real: no literal border-radius remains (the v1 sheet declared --radius then
// bypassed it with 4/6/8/10px literals), and the tokens are actually consumed.
ok(!/border-radius:\s*[.\d]/.test(STYLE), "no literal border-radius — every radius rides the --r-* scale (the declared-then-bypassed --radius is fixed)");
ok(/border-radius:var\(--r-md\)/.test(STYLE) && /border-radius:var\(--r-sm\)/.test(STYLE) && /border-radius:var\(--r-full\)/.test(STYLE), "the --r-sm/--r-md/--r-full radius tokens are consumed by rules (not declared-only)");

// focus ring: interactive elements get the tokenized :focus-visible treatment.
ok(/:focus-visible\{[^}]*box-shadow:var\(--focus\)/.test(STYLE), ":focus-visible applies the --focus ring on interactive elements");

// ── 3. .doc typography: rendered markdown has a REAL heading hierarchy (ui P6 — the v1 sheet forced
// h1/h2/h3 all to 1rem, flattening every roadmap/report/description into a wall of body text) ──
ok(!/\.doc h1,\.doc h2,\.doc h3\{/.test(STYLE), "the old .doc h1/h2/h3 flattening rule is gone");
ok(/\.doc h1\{[^}]*font-size:var\(--fs-lg\)/.test(STYLE), ".doc h1 → --fs-lg (20px/28) semibold");
ok(/\.doc h2\{[^}]*font-size:var\(--fs-md\)/.test(STYLE), ".doc h2 → --fs-md (16px/24) semibold");
ok(/\.doc h3[^{]*\{[^}]*font-size:var\(--fs-base\)/.test(STYLE), ".doc h3 → --fs-base (14px/21) semibold (tinted)");
ok(/\.doc\{[^}]*max-width:72ch/.test(STYLE), ".doc caps its measure at 72ch (readable long-form width)");

// ── 4. mono stack: a token, not repeated verbatim across rules ──
ok(/--font-mono:/.test(STYLE) && (STYLE.match(/ui-monospace/g) ?? []).length === 1,
  "the mono font stack is a token (--font-mono) declared exactly once, referenced via var() everywhere else");

// ── 4b. F2 (D2 multi-project shell): nav active state + project-index card styles ──
ok(/nav a\[aria-current=page\]\{[^}]*border-bottom-color:var\(--brand\)/.test(STYLE), "the nav marks the active page (aria-current) with the brand underline — the shell spec's active state");
ok(/\.pcard\{[^}]*box-shadow:var\(--shadow-1\)/.test(STYLE) && /\.pcard:hover\{[^}]*box-shadow:var\(--shadow-2\)/.test(STYLE), "project-index cards ride the elevation tokens (--shadow-1, hover --shadow-2)");
ok(/\.dot\{[^}]*border-radius:var\(--r-full\)/.test(STYLE), "the state dot is an --r-full circle (its color arrives via a state-token var, never a hex)");
ok(/\.pcard\.team\{/.test(STYLE), "the Team-intake card has a distinct (non-peer) style");

// ── 5. Markdown: fenced code blocks ──
const fence = renderMarkdown("before\n```\nconst x = 1;\n- not a list\n```\nafter");
ok(/<pre><code>const x = 1;\n- not a list<\/code><\/pre>/.test(fence), "``` fence → one <pre><code>, inline transforms suspended (dash is NOT a list item inside)");
ok(!/<p>```<\/p>/.test(fence), "the ``` marker lines are consumed, never rendered as literal <p>```</p>");
ok(/<p>before<\/p>/.test(fence) && /<p>after<\/p>/.test(fence), "text around the fence still renders");

// ── 6. Markdown: links (allowlisted) ──
ok(/<a href="https:\/\/x\.com\/a" rel="noopener noreferrer" target="_blank">text<\/a>/.test(renderMarkdown("[text](https://x.com/a)")), "[text](https url) → an allowlisted link");
ok(/<a href="\/ticket\/DL-1"[^>]*>see<\/a>/.test(renderMarkdown("[see](/ticket/DL-1)")), "[text](/same-site path) → an allowlisted link");
const bare = renderMarkdown("visit https://example.com/p now");
ok(/<a href="https:\/\/example\.com\/p"[^>]*>https:\/\/example\.com\/p<\/a>/.test(bare), "a bare https URL autolinks");
// XSS: a javascript: (or other non-http/non-path) href must render as inert text, never an <a>
const evil = renderMarkdown("[x](javascript:alert(1))");
ok(!/<a /.test(evil) && /javascript/.test(evil), "javascript: href is rejected → inert text, no <a> (esc-first + allowlist)");
ok(!/<a /.test(renderMarkdown("[x](data:text/html,<script>)")), "data: href is rejected too");

// ── 7. Markdown: emphasis, blockquote, and no raw HTML injection ──
ok(/<blockquote>quoted<\/blockquote>/.test(renderMarkdown("> quoted")), "> line → blockquote");
ok(/<em>i<\/em>/.test(renderMarkdown("an *i* word")), "*italic* → <em>");
ok(!/<script>/.test(renderMarkdown("<script>alert(1)</script>")), "raw HTML in source is escaped, never emitted as a tag");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ── 8. TICKET DETAIL (ui P4 — the ticket-view agent's section): two-column layout, sidebar fields,
//       the unified state-history/comment timeline, and the write-form gates. Renders ticketPage
//       against a real in-memory hub schema (openDb ":memory:") with a pinned clock — no HTTP.
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { ticketPage, relTime, identityDot } from "../src/views/ticket.ts";
import { openDb } from "../src/db.ts";

const tdb = openDb(":memory:");
const NOW = "2026-07-11T12:00:00.000Z", NOW_MS = Date.parse(NOW);
const T_CREATE = "2026-07-10T12:00:00.000Z", T_COMMENT = "2026-07-10T15:00:00.000Z", T_MOVE = "2026-07-11T09:00:00.000Z";
tdb.prepare("INSERT INTO projects(id,key,name,ticket_prefix,created_at) VALUES ('p1','wui','WebUI Guard','WUI',?)").run(T_CREATE);
tdb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES ('WUI-1','p1','Timeline ticket','Body is **bold**','Feature','In Progress','dev',2,'[\"dev-loop\",\"pm\"]','[]','pm',?,?)").run(T_CREATE, T_MOVE);
const tev = tdb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES ('p1','WUI-1',?,?,?,?)");
tev.run("pm", "issue.create", "{}", T_CREATE);
tdb.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES ('c1','WUI-1','qa',?,?)")
  .run("looks <script>alert(1)</script> **fine**", T_COMMENT);

// BEFORE any state change: the timeline holds the create + comment rows, but no transition row.
const before = ticketPage(tdb, "p1", "wui", "WUI-1", false, { nowMs: NOW_MS })!;
ok(before.includes('class="timeline"') && before.includes("created this ticket") && !before.includes("moved"), "ticket timeline: create + comment render, NO transition row before any state change");

// a state change lands in the events ledger → the timeline renders the transition row (who/from→to/when)
tev.run("dev", "issue.transition", JSON.stringify({ from: "In Progress", to: "In Review" }), T_MOVE);
const tp = ticketPage(tdb, "p1", "wui", "WUI-1", false, { nowMs: NOW_MS })!;
ok(/<b>dev<\/b> moved <span class="lbl">In Progress<\/span> → <span class="lbl">In Review<\/span>/.test(tp), "ticket timeline: a state change renders a transition row — actor + from → to (from the events ledger)");
ok(tp.includes(`datetime="${T_MOVE}"`) && tp.includes("3h ago"), "ticket timeline: the transition row carries a relative time with the ISO on the <time> datetime/title");
// interleave: create → comment → transition, oldest first (chronological, top-down into the comment box)
const iCreate = tp.indexOf("created this ticket"), iComment = tp.indexOf("looks"), iMove = tp.indexOf("moved");
ok(iCreate > -1 && iComment > iCreate && iMove > iComment, "ticket timeline: transitions and comments INTERLEAVE chronologically (create < comment < move)");

// sidebar: every definition row present (State/Type/Priority/Owner/Assignee/Labels/Created/Updated)
for (const dt of ["State", "Type", "Priority", "Owner", "Assignee", "Labels", "Created", "Updated"])
  ok(tp.includes(`<dt>${dt}</dt>`), `ticket sidebar: the ${dt} row renders`);
ok(tp.includes('--sc:var(--s-progress)') && tp.includes('class="schip"'), "ticket sidebar/header: the state chip is tinted via its --s-* token (single color source)");
ok(tp.includes("@dev") && /class="idot"[^>]*title="@dev"/.test(tp), "ticket sidebar: the assignee renders an identity dot + @handle");
ok(tp.includes('<span class="lbl">dev-loop</span>') && tp.includes('<span class="lbl">pm</span>'), "ticket sidebar: labels render as chips");

// escaped content: an injected <script> in a comment is inert; markdown in the comment still renders
ok(tp.includes("&lt;script&gt;alert(1)") && !tp.includes("<script>alert(1)"), "ticket timeline: comment HTML is escaped (esc-first — an injected <script> is inert text)");
ok(tp.includes("<strong>fine</strong>"), "ticket timeline: comment markdown renders (**fine** → <strong>)");
// escaped content: a hostile actor handle can't break out of the identity dot's title attribute
ok(!identityDot('x" onmouseover="alert(1)').includes('" onmouseover='), "identityDot: the handle is esc()'d inside the title attribute (no attribute breakout)");
ok(identityDot("pm") === identityDot("pm"), "identityDot: deterministic (same handle → same hue)");

// write forms ride the humanWrite gate: absent read-only, present (all three + comment box) when on
ok(!tp.includes("<form"), "ticket page: NO write forms when canWrite=false (read-only render)");
const tpW = ticketPage(tdb, "p1", "wui", "WUI-1", true, { nowMs: NOW_MS })!;
ok(tpW.includes('action="/p/wui/ticket/WUI-1/move"') && tpW.includes('action="/p/wui/ticket/WUI-1/assign"') && tpW.includes('action="/p/wui/ticket/WUI-1/comment"'), "ticket page: move/assign/comment forms render when canWrite=true (canonical /p/<key>/ actions)");
ok(/<select name="state"[^>]*>[\s\S]*<option selected>In Progress<\/option>/.test(tpW), "ticket sidebar: the move <select> pre-selects the current state");

// layout: main + sidebar containers, and the STYLE rules that arrange them (two-column ≥900px,
// sidebar-first stack below; timeline connector + identity dot ride the token sheet)
ok(tp.includes('class="tgrid"') && tp.includes('class="tmain"') && tp.includes('class="tside"'), "ticket page: renders the two-column tgrid (main + sidebar)");
ok(/@media\(min-width:900px\)\{\.tgrid\{display:grid;grid-template-columns:minmax\(0,1fr\) 260px/.test(STYLE), "STYLE: ≥900px the ticket grid is two-column (minmax(0,1fr) 260px)");
ok(/\.tgrid \.tside\{order:-1\}/.test(STYLE), "STYLE: below the breakpoint the sidebar stacks ABOVE the main column (order:-1)");
ok(/\.timeline\{[^}]*border-left:2px solid var\(--line\)/.test(STYLE), "STYLE: the timeline connector is the spec'd 2px --line left border");
ok(/\.idot\{[^}]*border-radius:var\(--r-full\)/.test(STYLE) && /\.idot\{[^}]*--idl:var\(--mut\)/.test(STYLE), "STYLE: .idot is an --r-full circle with declared --idl/--idd fallbacks (unresolved-var guard holds)");
ok(/\.schip\{[^}]*color-mix\(in srgb,var\(--sc\) 12%,var\(--surface\)\)/.test(STYLE), "STYLE: .schip keeps the tinted-chip pattern (color-mix 12% over --surface)");

// relTime: pure, pinned-clock unit checks
ok(relTime(T_CREATE, NOW_MS) === "1d ago" && relTime(T_MOVE, NOW_MS) === "3h ago" && relTime(NOW, NOW_MS) === "just now", "relTime: d/h/just-now buckets");
ok(relTime("not-a-date", NOW_MS) === "—" && relTime("", NOW_MS) === "—", "relTime: unparsable input → — (never NaN)");
tdb.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ── 9. BOARD REDESIGN (ui P3 — the board agent's section): column wells, state-dot headers,
//       semantic label chips, guided empty states, relative updated-at, and card XSS. Renders
//       boardPage against a real in-memory hub schema with a pinned clock — no HTTP.
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { boardPage, labelChip, labelVar } from "../src/views/board.ts";

// STYLE: the well / elevation / chip / empty-state rules the board markup rides
ok(/\.col\{[^}]*background:var\(--surface-2\)/.test(STYLE) && /\.col\{[^}]*border-radius:var\(--r-lg\)/.test(STYLE) && /\.col\{[^}]*padding:var\(--sp-2\)/.test(STYLE),
  "STYLE: columns are surface-2 WELLS (rounded --r-lg, --sp-2 inner padding) — no more transparent columns");
ok(/\.card\{[^}]*box-shadow:var\(--shadow-1\)/.test(STYLE) && /\.card:hover\{[^}]*box-shadow:var\(--shadow-2\)/.test(STYLE) && /\.card:hover\{[^}]*border-color:var\(--line-strong\)/.test(STYLE),
  "STYLE: cards ride the elevation tokens (--shadow-1; hover --shadow-2 + line-strong)");
ok(/\.col-empty\{[^}]*border:1px dashed var\(--line-strong\)/.test(STYLE), "STYLE: an empty column renders a dashed guided-hint box (not an em-dash)");
ok(/\.lbl-c\{[^}]*--lc:var\(--mut\)/.test(STYLE) && /\.lbl-c\{[^}]*color-mix\(in srgb,var\(--lc\) 12%,var\(--surface\)\)/.test(STYLE),
  "STYLE: .lbl-c declares the --lc fallback + the tinted-chip pattern (the unresolved-var guard holds)");
ok(/\.prio\.p1\{[^}]*background:var\(--c-urgent\)/.test(STYLE) && /\.prio\.p2::before\{content:"↑ "\}/.test(STYLE),
  "STYLE: Urgent = filled --c-urgent pill; High = warn text + ↑ glyph");
ok(/\.search::before\{content:"⌕"/.test(STYLE) && /\.search input\{[^}]*width:260px/.test(STYLE), "STYLE: the search input grows to 260px with the CSS magnifier glyph (no icon font)");
ok(/\.btn-brand\{[^}]*background:var\(--brand\)/.test(STYLE), "STYLE: the primary filterbar/create action rides the brand tokens");
ok(/\.empty-state\{[^}]*box-shadow:var\(--shadow-1\)/.test(STYLE), "STYLE: the board-level empty state is a real card (surface + elevation)");

// labelVar/labelChip: the §4/§13 semantic map — blocked / needs-* / incident / sensitive / design
ok(labelVar("blocked") === "--s-blocked" && labelVar("incident") === "--c-incident" && labelVar("sensitive") === "--c-bug" && labelVar("design") === "--s-review",
  "labelVar: blocked/incident/sensitive/design map to their semantic tokens");
ok(labelVar("needs-pm") === "--c-warn" && labelVar("needs-qa") === "--c-warn", "labelVar: the needs-* prefix family (waiting on someone) → the warn signal");
ok(labelVar("some-cosmetic-label") === null, "labelVar: unknown labels stay neutral");
ok(labelChip("blocked") === '<span class="lbl lbl-c" style="--lc:var(--s-blocked)">blocked</span>', "labelChip: a semantic label renders .lbl-c with its inline --lc token");
ok(labelChip("misc") === '<span class="lbl">misc</span>', "labelChip: a neutral label renders a plain chip (no style attr)");
ok(!labelChip('x" onmouseover="alert(1)').includes('" onmouseover='), "labelChip: the label text is esc()'d (no attribute breakout)");

// live boardPage render over a real schema, pinned clock
const bdb = openDb(":memory:");
const B_NOW = Date.parse("2026-07-11T12:00:00.000Z");
const B_UPD = "2026-07-09T12:00:00.000Z"; // 2d before B_NOW
bdb.prepare("INSERT INTO projects(id,key,name,ticket_prefix,created_at) VALUES ('bp','acme','Acme','AC',?)").run(B_UPD);
bdb.prepare("INSERT INTO projects(id,key,name,ticket_prefix,created_at) VALUES ('bt','_team','Team intake','TEAM',?)").run(B_UPD);
bdb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]','pm',?,?)")
  .run("AC-1", "bp", "Fix the <script>alert(1)</script> crash", "", "Bug", "In Progress", "dev", 1,
    JSON.stringify(["dev-loop", "qa", "blocked", "needs-pm", "incident", "sensitive", "misc"]), B_UPD, B_UPD);
const board9 = boardPage(bdb, "bp", "acme", {}, false, undefined, { nowMs: B_NOW });

// XSS: a hostile ticket title stays escaped on the card
ok(board9.includes("Fix the &lt;script&gt;alert(1)&lt;/script&gt; crash") && !board9.includes("<script>alert(1)"),
  "board XSS: a ticket title with <script> renders escaped, never as a tag");
// column wells + state-dot headers with counts
ok(/<section class="col"><h2><span class="dot" style="background:var\(--s-progress\)"[^>]*><\/span>In Progress<span class="count">1<\/span>/.test(board9),
  "board columns: header = state-colored dot + name + count pill (In Progress · 1)");
// semantic label chips on the card: alarm labels rank first; dev-loop marker + owner labels suppressed; +n overflow
ok(board9.includes("--lc:var(--s-blocked)") && board9.includes("--lc:var(--c-warn)") && board9.includes("--lc:var(--c-incident)"),
  "board card: blocked / needs-pm / incident chips carry their semantic colors");
ok(/<span class="lbl lbl-more" title="sensitive, misc">\+2<\/span>/.test(board9), "board card: the 3-chip cap overflows to +n (hidden names on the title)");
ok(!board9.includes(">dev-loop</span>") && !/class="lbl[^"]*">qa</.test(board9), "board card: the dev-loop marker and the owner label are suppressed as chips (owner keeps its meta slot)");
ok(board9.includes('<span class="owner">qa</span>') && board9.includes("@dev"), "board card: owner + assignee render in the meta row");
ok(board9.includes('class="prio p1">Urgent<'), "board card: the Urgent priority renders (the filled-pill treatment is CSS)");
// relative updated-at with the ISO instant on the title
ok(new RegExp(`<time class="when" datetime="${B_UPD}" title="updated ${B_UPD}">2d</time>`).test(board9), "board card: relative updated-at (2d) with the ISO on datetime/title");
// per-column guided hints on the empty core columns
ok(board9.includes("Nothing queued") && board9.includes("Nothing awaiting verification") && board9.includes("Nothing finished yet"),
  "board columns: empty core columns carry their per-column guidance hints");
// summary band: zero-count chips dim (s0), populated counts keep weight
ok(board9.includes('class="lbl s0">Feature <b>0</b>') && board9.includes(">Bug <b>1</b>"), "summary band: a zero-count chip dims (s0), populated chips keep weight");
// filtered-to-zero: aligned wells stay + the filter-aware empty card with its clear action
const board9f = boardPage(bdb, "bp", "acme", { state: "Backlog" }, false, undefined, { nowMs: B_NOW });
ok(board9f.includes('class="board"') && board9f.includes("No tickets match") && board9f.includes(">clear filters</a>"),
  "board empty (filtered): wells stay aligned + the empty-state card offers clear-filters");
// genuinely empty _team: the intake guidance card names the exact CLI command; the well grid is suppressed
const board9t = boardPage(bdb, "bt", "_team", {}, false, undefined, { nowMs: B_NOW });
ok(board9t.includes("No intake yet") && board9t.includes("intake mailbox") && board9t.includes("DEVLOOP_PROJECT=_team dev-loop ticket create"),
  "board empty (_team): the guidance card explains the intake mailbox + names the exact CLI command");
ok(!board9t.includes('class="board"'), "board empty (unfiltered): the guidance card replaces the grid of empty wells");
// genuinely empty delivery project (+ canWrite): names the CLI command and points at the create form
const board9w = boardPage(bdb, "bq", "beta", {}, true, undefined, { nowMs: B_NOW }); // "bq": no tickets seeded → genuinely empty
ok(board9w.includes("No tickets yet") && board9w.includes("dev-loop ticket create --title") && board9w.includes("+ New ticket"),
  "board empty (delivery project): guidance names the CLI create command; the humanWrite form is offered");
// swimlane mode keeps working, now over wells
const board9s = boardPage(bdb, "bp", "acme", {}, false, "assignee", { nowMs: B_NOW });
ok(board9s.includes('class="swimlanes"') && board9s.includes('class="lane-h"') && board9s.includes("@dev") && board9s.includes('<section class="col">'),
  "board swimlanes: ?group=assignee still renders lanes, sharing the aligned column wells");
// codex 2026-07-11: a filtered-to-zero SWIM board keeps the class="board" wells (never an empty
// <div class="swimlanes"> with no grid) — the same no-match contract as the flat board.
const board9sf = boardPage(bdb, "bp", "acme", { state: "Backlog" }, false, "assignee", { nowMs: B_NOW });
ok(board9sf.includes('class="board"') && !board9sf.includes('class="swimlanes"') && board9sf.includes("No tickets match"),
  "board swimlanes (filtered to zero): falls back to the aligned empty wells + the no-match card");
// codex 2026-07-11: attribute-context XSS — a hostile assignee handle and a hostile label name in
// the +n overflow title stay inert (esc() at every attribute interpolation).
bdb.prepare("INSERT INTO projects(id,key,name,ticket_prefix,created_at) VALUES ('bx','xp','Xp','BX',?)").run(B_UPD);
bdb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]','pm',?,?)")
  .run("BX-1", "bx", "under_score fix", "", "Bug", "Todo", 'x" onmouseover="alert(1)', 3,
    JSON.stringify(["blocked", "needs-pm", "incident", 'evil" onx="1']), B_UPD, B_UPD);
bdb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'[]','[]','pm',?,?)")
  .run("BX-2", "bx", "underXscore miss", "", "Bug", "Todo", null, 3, B_UPD, B_UPD);
const board9x = boardPage(bdb, "bx", "xp", {}, false, undefined, { nowMs: B_NOW });
ok(board9x.includes("@x&quot;") && !board9x.includes('" onmouseover='), "board XSS: a hostile assignee handle is esc()'d in the card meta (no attribute breakout)");
ok(/title="evil&quot; onx=&quot;1"/.test(board9x) && !board9x.includes('" onx='), "board XSS: a hostile label name inside the +n overflow title is esc()'d (no attribute breakout)");
// codex 2026-07-11: the q LIKE-escape keeps '_' literal too (the ui P8 section covers '%')
const board9u = boardPage(bdb, "bx", "xp", { q: "der_sc" }, false, undefined, { nowMs: B_NOW });
ok(board9u.includes("BX-1") && !board9u.includes("BX-2"), "board search: '_' in q stays literal (matches under_score, never underXscore)");
bdb.close();

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ── 10. ACTIVITY DASHBOARD + BOARD SEARCH (ui P5/P8 — the activity agent's section): the stat-tile
//        row (warn tint only on genuinely bad states), one .acard per metric group with inline
//        token-colored stage bars, the feed as a real timeline (kind icon / actor chip / href()
//        ticket link / relative time / day dividers), and the board q matching DESCRIPTION text via
//        a server-side WHERE with literal (escaped) LIKE wildcards. In-memory schema, pinned clock.
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { activityPage } from "../src/views/activity.ts";

{
  const adb = openDb(":memory:");
  const A_NOW = Date.parse("2026-07-11T12:00:00.000Z");
  const A_DAY = 86_400_000;
  const aIso = (ms: number) => new Date(ms).toISOString();
  adb.prepare("INSERT INTO projects(id,key,name,created_at) VALUES ('ap','k','n',?)").run(aIso(A_NOW - 30 * A_DAY));
  const aTicket = (id: string, state: string, title: string, desc: string) =>
    adb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]','dev',?,?)")
      .run(id, "ap", title, desc, "Bug", state, null, 3, JSON.stringify(["dev-loop", "Bug", "qa"]), aIso(A_NOW - 9 * A_DAY), aIso(A_NOW));
  const aEv = (tid: string, kind: string, data: Record<string, unknown>, ms: number) =>
    adb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES ('ap',?,'pm',?,?,?)").run(tid, kind, JSON.stringify(data), aIso(ms));
  // AK-1 sits In Review for 5d (> the 2d verify-lag threshold — the ONE genuinely bad state here);
  // AK-2 ran the full pipeline to Done (throughput 1, acceptance 100%, medians for all three stages);
  // AK-3 carries hostile markup + a literal `_` in the DESCRIPTION (snippet-XSS + LIKE-escape pins);
  // AK-1's "50xpc" is the decoy an unescaped `_` wildcard would also match.
  aTicket("AK-1", "In Review", "alpha ships", "the needle-phrase lives only in this 100 description body — rate 50xpc set");
  aTicket("AK-2", "Todo", "beta polish", "plain text with a 100% literal");
  aTicket("AK-3", "Todo", "gamma cleanup", 'x <script>alert(9)</script> snippet-mark rate 50_pc set');
  aEv("AK-1", "issue.create", { type: "Bug", title: "alpha ships" }, A_NOW - 9 * A_DAY);
  aEv("AK-1", "issue.transition", { from: "Todo", to: "In Progress" }, A_NOW - 8 * A_DAY);
  aEv("AK-1", "issue.transition", { from: "In Progress", to: "In Review" }, A_NOW - 5 * A_DAY);
  aEv("AK-2", "issue.create", { type: "Bug", title: "beta polish" }, A_NOW - 9 * A_DAY);
  aEv("AK-2", "issue.transition", { from: "Todo", to: "In Progress" }, A_NOW - 8 * A_DAY);      // Todo 1d
  aEv("AK-2", "issue.transition", { from: "In Progress", to: "In Review" }, A_NOW - 4 * A_DAY); // In Progress 4d (max → 100% bar)
  aEv("AK-2", "issue.transition", { from: "In Review", to: "Done" }, A_NOW - 2 * A_DAY);        // In Review 2d
  aEv("AK-2", "comment.add", {}, A_NOW - 1 * A_DAY);
  // a hostile, MALFORMED ledger row (DL-17 AC5 robustness): bad-JSON data, unparseable created_at,
  // null ticket_id, markup in the actor — the metrics must skip it and the feed must render it inert.
  adb.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES ('ap',NULL,'<evil>&actor','issue.transition','{not json','not-a-date')").run();

  const act = activityPage(adb, "ap", "k", A_NOW);
  // (a) the stat-tile row
  ok((act.match(/class="tile( tile-warn)?"/g) ?? []).length === 6,
    "P5 tiles: six stat tiles render (done 7d/30d · acceptance · in flight · blocked · oldest in review)");
  ok(act.includes('<span class="tile-v">100%</span>'), "P5 tiles: the acceptance tile shows the computed 30d rate");
  ok(/class="tile tile-warn"><span class="tile-v">5d 0h<\/span><span class="tile-l">oldest in review<\/span>/.test(act)
    && (act.match(/tile tile-warn/g) ?? []).length === 1,
    "P5 tiles: warn tint ONLY on the genuinely bad tile (In Review > 2d) — healthy acceptance stays neutral");
  ok(!act.includes('class="warn"'), "P5: the DL-79 <50% warn span stays absent while the rate is healthy (warn semantics unchanged)");
  // (b) sectioned metric-group cards
  ok((act.match(/class="acard/g) ?? []).length === 7, "P5 cards: one .acard per metric group + the full-width feed card (7 total)");
  ok(/class="bar-fill" style="width:100%;background:var\(--s-progress\)"/.test(act)
    && /class="bar-fill" style="width:\d+%;background:var\(--s-review\)"/.test(act),
    "P5 cards: stage medians render token-colored inline bars sized against the slowest stage (no hex)");
  ok(act.includes('class="flag warn">⚠ verify-lag'), "P5 cards: the WIP verify-lag flag renders as a tinted chip (threshold unchanged)");
  // (c) the feed as a real timeline
  ok(act.includes('class="feed"') && (act.match(/class="ev-row"/g) ?? []).length === 9,
    "P5 feed: a real timeline renders (one .ev-row per event, including the malformed one)");
  ok(act.includes('<a class="lbl" href="/p/k/ticket/AK-1">AK-1</a>'), "P5 feed: rows link their ticket through href() (/p/<key>/ticket/…)");
  ok(act.includes('<span class="ev-actor">pm</span>'), "P5 feed: rows carry the actor chip");
  ok(act.includes('class="ev-ico"') && /ago<\/time>/.test(act), "P5 feed: rows carry a kind icon and a server-rendered relative time");
  ok(act.includes('class="ev-day"'), "P5 feed: day dividers group the feed");
  ok(!act.includes("NaN") && act.includes("&lt;evil&gt;&amp;actor") && !act.includes("<evil>"),
    "P5 feed: the hostile malformed row renders inert — escaped actor, no NaN age/time, no link (AC5)");
  ok(act.includes('<span class="tile-v">1</span>'), "P5: the malformed row never reaches the metrics (Done 30d stays 1)");

  // (d) ui P8 — the board q matches description, server-side
  const byDesc = boardPage(adb, "ap", "k", { q: "needle-phrase" }, false, undefined, { nowMs: A_NOW });
  ok(byDesc.includes("AK-1") && !byDesc.includes("AK-2"), "P8 search: q matches DESCRIPTION text — only the describing ticket returns");
  ok(/class="snippet">[^<]*needle-phrase/.test(byDesc), "P8 search: a description-only match shows its context snippet on the card");
  const byTitle = boardPage(adb, "ap", "k", { q: "BETA" }, false, undefined, { nowMs: A_NOW });
  ok(byTitle.includes("AK-2") && !byTitle.includes("AK-1") && !byTitle.includes('class="snippet"'),
    "P8 search: title matching still works case-insensitively — a visible (title) match needs no snippet");
  const wild = boardPage(adb, "ap", "k", { q: "100%" }, false, undefined, { nowMs: A_NOW });
  ok(wild.includes("AK-2") && !wild.includes("AK-1"), "P8 search: LIKE wildcards stay literal — q='100%' matches only the text containing it (never a bare '100')");
  const under = boardPage(adb, "ap", "k", { q: "50_pc" }, false, undefined, { nowMs: A_NOW });
  ok(under.includes("AK-3") && !under.includes("AK-1"), "P8 search: LIKE '_' stays literal too — q='50_pc' skips the '50xpc' decoy");
  const byXss = boardPage(adb, "ap", "k", { q: "snippet-mark" }, false, undefined, { nowMs: A_NOW });
  ok(byXss.includes("AK-3") && byXss.includes("&lt;script&gt;alert(9)&lt;/script&gt; snippet-mark") && !byXss.includes("<script>alert(9)"),
    "P8 search: the snippet esc()s hostile description markup — no tag reaches the card");
  adb.close();
}

// ══ DOCS SYSTEM (F4/D3) — style guards for the docs increment (appended by the docs agent) ══
// The chip/badge/diff styles must ride tokens only — the no-hex and no-literal-radius guards above
// already sweep them; these pin that the classes exist and use the tinted-chip color-mix pattern.
ok(/\.chip-drafts\{[^}]*border-radius:var\(--r-full\)/.test(STYLE), "docs: the drafts-pending header chip is a token pill (--r-full)");
ok(/\.chip-drafts\{[^}]*color-mix\(in srgb,var\(--c-warn\) 12%,var\(--surface\)\)/.test(STYLE), "docs: the drafts chip rides the tinted-chip pattern (color-mix over --c-warn)");
ok(/\.lbl\.vpend\{[^}]*var\(--c-warn\)/.test(STYLE) && /\.lbl\.vpub\{[^}]*var\(--c-ok\)/.test(STYLE), "docs: the pending/published version badges tint via --c-warn/--c-ok");
ok(/\.diff \.da\{[^}]*var\(--c-ok\)/.test(STYLE) && /\.diff \.dd\{[^}]*var\(--c-bug\)/.test(STYLE), "docs: diff added/removed lines tint via --c-ok/--c-bug (token-only)");
ok(/\.diff \.da,\.diff \.dd,\.diff \.dc\{display:block\}/.test(STYLE), "docs: diff lines are block spans (pre-safe, no doubled newlines)");

console.log(fails === 0 ? "\nWEBUI_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
