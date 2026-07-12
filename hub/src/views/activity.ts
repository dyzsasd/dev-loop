// dev-loop hub daemon web UI — the activity & throughput view (F1 split of daemonviews.ts).
// DL-17: a human-facing read over the append-only `events` table (issue.create / issue.transition
// {from,to} / comment.add, written by the MCP server at server.ts). Pure GET through the query_only
// `db`: no write path, no new MCP tool call, no new table. Robust to a null ticket_id and to
// empty/malformed `data` JSON — a bad row is skipped (metrics) or shown plainly (feed), never
// breaking the page (AC5).
// ui P5 (2026-07 review): dashboard restyle — a stat-tile headline row, one .acard per metric group
// (stage medians get inline token-colored bars), and the feed as a real timeline (kind icon, actor
// chip, ticket link via href(), relative time, day dividers). Metrics/warn semantics are UNCHANGED:
// red/warn appears only for genuinely bad states (acceptance <50%, verify-lag, possible-orphan).
import { DatabaseSync } from "node:sqlite";
import { esc, href, countPill } from "./ui.ts";

const DAY_MS = 86_400_000;
// Defensive JSON parse of an event's `data` blob — empty / malformed / non-object → {} instead of throwing.
// Shared by the activity view below and the daemon no-progress detector (same done-count logic).
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
// DL-84 — the pipeline stages whose residence time the /activity "Time in stage" diagnostic reports.
const STAGES = ["Todo", "In Progress", "In Review"] as const;
// DL-89 — Open-WIP aging thresholds: how long a ticket may sit in an active state before /activity flags it
// stale. In Review past this = the owner agent (PM/QA) isn't verifying finished work (verify-lag); In Progress
// past this = a claim that outlived its Dev fire (possible-orphan, beyond Sweep's no-artifact reclaim).
const WIP_VERIFY_LAG_MS = 2 * DAY_MS;   // In Review (AC3: "> 2 days")
const WIP_ORPHAN_MS = 1 * DAY_MS;       // In Progress (a Dev fire should ship within its own run)
// DL-89 — the active states /activity ages, one source for both the query and the render list (so they can't
// drift). Core states always render (— none if empty); park states render only when populated — the
// parking-state rule, mirroring boardPage's STATE_ORDER/CORE_STATES handling.
const WIP_CORE_STATES = ["In Progress", "In Review"];   // always shown
const WIP_PARK_STATES = ["Human-Blocked"];              // shown only when populated
// DL-84/DL-89 — one ticket's create+transition history, ASC by id; shared by the cycle-time + open-WIP loops.
const HIST_SQL = "SELECT kind,data,created_at FROM events WHERE project_id=? AND ticket_id=? AND (kind='issue.create' OR kind='issue.transition') ORDER BY id";
// Median of a numeric list (ms); empty → undefined (caller renders "—"). Avg of the two middles for even n.
function median(nums: number[]): number | undefined {
  if (!nums.length) return undefined;
  const s = [...nums].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// DL-84 — per-stage residence time (ms) for ONE ticket, summed across ALL intervals it spent in each stage
// (a state may be re-entered — a verify-fail reopen). An interval is [transition INTO a state, the next
// transition OUT]; issue.create anchors the initial state (whose value is the first transition's `from`), and
// the trailing open interval (the final state, e.g. Done) is NOT counted. Graceful on incomplete history (no
// create anchor → the initial interval is dropped) and on malformed rows (eventData → {} → an undefined state
// bounds the prior interval by its timestamp, then attributes nothing). hist is the ticket's create+transition
// events ordered ASC by id.
function stageDurations(hist: Record<string, any>[]): Record<string, number> {
  const acc: Record<string, number> = {};
  let createT: number | undefined, firstFrom: unknown;
  const trans: { to: unknown; t: number }[] = [];
  for (const e of hist) {
    if (e.kind === "issue.create") { if (createT === undefined) { const t = Date.parse(e.created_at); if (Number.isFinite(t)) createT = t; } }
    else if (e.kind === "issue.transition") {
      const d = eventData(e.data), t = Date.parse(e.created_at);
      if (!Number.isFinite(t)) continue;                       // a row with no usable timestamp bounds nothing — skip
      if (!trans.length) firstFrom = d.from;                   // the initial state = what the first transition leaves
      trans.push({ to: d.to, t });
    }
  }
  let prevT = createT, prevState: unknown = firstFrom;
  for (const tr of trans) {
    if (prevT !== undefined && typeof prevState === "string" && (STAGES as readonly string[]).includes(prevState)) {
      const dur = tr.t - prevT;
      if (dur > 0) acc[prevState] = (acc[prevState] ?? 0) + dur;
    }
    prevState = tr.to; prevT = tr.t;                           // the next interval opens at this transition
  }
  return acc;                                                  // prevState's trailing open interval (e.g. Done) is uncounted
}
// Server-side relative time ("3d 4h ago" / "12m ago" / "just now"); the caller pairs it with the
// exact ISO in a title/datetime attribute. A malformed timestamp renders as-is (never NaN); a small
// negative diff (clock skew) folds into "just now". Pure — nowMs injected, same as activityPage.
function relTime(nowMs: number, iso: unknown): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return String(iso ?? "");
  const diff = nowMs - t;
  if (diff < 60_000) return "just now";
  return `${humanDur(diff)} ago`;
}
// ui P5 — event kind → [timeline-icon glyph, its color token]. Neutral, informational colors only:
// warn/red styling on this page is reserved for genuinely bad states (verify-lag / possible-orphan /
// a <50% acceptance rate), never for routine feed traffic. Unknown kinds get the neutral dot.
const KIND_ICO: Record<string, [string, string]> = {
  "issue.create": ["+", "--c-feature"],
  "issue.transition": ["→", "--s-progress"],
  "issue.promote": ["↑", "--c-info"],   // DL-32 env-label change
  "comment.add": ["❝", "--mut"],
};
// One timeline row per event, formatted by kind; every interpolation passes through esc() (AC6). A
// null ticket_id renders no link (AC5); unknown kinds (issue.update / topic.*) fall through to a
// plain line. F2: the ticket link rides href(projectKey, …) so the feed stays inside /p/<key>/.
// ui P5: a real timeline row — kind icon (colored via a token var, single color source), actor chip,
// relative time (exact ISO in title/datetime).
function eventLine(e: Record<string, any>, projectKey: string, nowMs: number): string {
  const d = eventData(e.data);
  const who = `<span class="ev-actor">${esc(e.actor)}</span>`;
  const tlink = e.ticket_id ? ` <a class="lbl" href="${esc(href(projectKey, `/ticket/${encodeURIComponent(e.ticket_id)}`))}">${esc(e.ticket_id)}</a>` : "";
  let what: string;
  switch (e.kind) {
    case "issue.create": what = `created${tlink} <span class="badge">${esc(d.type ?? "?")}</span> ${esc(d.title ?? "")}`; break;
    case "issue.transition": what = `moved${tlink} <span class="lbl">${esc(d.from ?? "?")}</span> → <span class="lbl">${esc(d.to ?? "?")}</span>`; break;
    case "issue.promote": what = `promoted${tlink} <span class="lbl">${esc(d.from || "—")}</span> → <span class="lbl">${esc(d.to || "—")}</span>`; break; // DL-32 env-label change
    case "comment.add": what = `commented on${tlink || " a ticket"}`; break;
    default: what = `${esc(e.kind)}${tlink}`; break;
  }
  const [glyph, color] = KIND_ICO[e.kind] ?? ["•", "--mut"];
  const when = `<time class="ev-time" datetime="${esc(e.created_at)}" title="${esc(e.created_at)}">${esc(relTime(nowMs, e.created_at))}</time>`;
  return `<div class="ev-row"><span class="ev-ico" style="color:var(${color})" aria-hidden="true">${glyph}</span>`
    + `<div class="ev-body">${who} ${what}${when}</div></div>`;
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
  const stageLists: Record<string, number[]> = Object.fromEntries(STAGES.map((s) => [s, []]));  // DL-84: per-stage residence, keyed by STAGES (single source) across the same recently-Done set
  const cycle = [...doneAt.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([tid, done]) => {
    const hist = db.prepare(HIST_SQL).all(projectId, tid) as Record<string, any>[];
    let start: string | undefined;
    for (const e of hist) if (e.kind === "issue.create") { start = e.created_at; break; }
    if (!start) for (const e of hist) if (eventData(e.data).to === "Todo") { start = e.created_at; break; }
    const sd = stageDurations(hist);                                                    // DL-84: folded off the same hist — no extra query per ticket
    for (const st of STAGES) if (sd[st] !== undefined) stageLists[st].push(sd[st]);      // a ticket contributes only the stages it actually had (AC4)
    return { tid, done, label: start ? humanDur(Date.parse(done) - Date.parse(start)) : "— (incomplete history)" };
  });

  // DL-89 — Open WIP aging DATA (computed before any rendering: the ui P5 stat tiles need the open
  // counts and the oldest-In-Review age, and the "Open WIP — aging" card reuses the same map). Per
  // open ticket: age = now − the latest transition INTO the current state, falling back to
  // issue.create when the ticket never transitioned in (AC2). Read-only over the same tickets/events
  // the page already uses; the open-WIP set is small (that's the point), so the per-ticket hist
  // query mirrors cycle-time.
  const wipAll = [...WIP_CORE_STATES, ...WIP_PARK_STATES];
  const openRows = db.prepare(`SELECT id,state FROM tickets WHERE project_id=? AND state IN (${wipAll.map(() => "?").join(",")})`).all(projectId, ...wipAll) as { id: string; state: string }[];
  const openByState = new Map<string, { id: string; sinceMs: number }[]>();
  for (const r of openRows) {
    const hist = db.prepare(HIST_SQL).all(projectId, r.id) as Record<string, any>[];
    let into: string | undefined, created: string | undefined;
    for (const e of hist) {
      if (e.kind === "issue.create") { if (created === undefined) created = e.created_at; }
      else if (eventData(e.data).to === r.state) into = e.created_at;        // ASC by id → the LAST match is the latest into-state transition (AC2)
    }
    const since = into ?? created;                                           // fallback to create when never transitioned into this state (AC2)
    if (!openByState.has(r.state)) openByState.set(r.state, []);
    openByState.get(r.state)!.push({ id: r.id, sinceMs: since ? Date.parse(since) : NaN });
  }

  const metricRow = (k: string, v: string) => `<div class="rlevel"><span class="rkey">${esc(k)}</span><span>${v}</span></div>`;
  const card = (inner: string, extra = "") => `<section class="acard${extra}">${inner}</section>`;

  // ── ui P5 stat tiles: the headline numbers (already computed above) get visual priority over the
  // per-metric detail cards. Warn tinting is reserved for GENUINELY bad states — a <50% acceptance
  // rate (the existing DL-79 threshold) and an oldest-In-Review age past the DL-89 verify-lag
  // threshold; Human-Blocked is a deliberate park and never warns. A zero-denominator acceptance
  // window renders "—", never a fake 0% (DL-79).
  const openIn = (state: string) => openByState.get(state) ?? [];
  const oldestIrMs = openIn("In Review").reduce<number | undefined>((max, t) => {
    const age = nowMs - t.sinceMs;
    return Number.isFinite(age) && (max === undefined || age > max) ? age : max;
  }, undefined);
  const accTotal30 = done30 + fail30;
  const acc30 = accTotal30 ? Math.round((done30 / accTotal30) * 100) : undefined;
  const tile = (v: string, label: string, warn = false) =>
    `<div class="tile${warn ? " tile-warn" : ""}"><span class="tile-v">${v}</span><span class="tile-l">${esc(label)}</span></div>`;
  const tiles = `<div class="tiles">`
    + tile(`${esc(done7)}`, "done · 7d")
    + tile(`${esc(done30)}`, "done · 30d")
    + tile(acc30 === undefined ? "—" : `${esc(acc30)}%`, "acceptance · 30d", acc30 !== undefined && acc30 < 50)
    + tile(`${esc(openIn("In Progress").length + openIn("In Review").length)}`, "in flight now")
    + tile(`${esc(openIn("Human-Blocked").length)}`, "blocked now")
    + tile(oldestIrMs === undefined ? "—" : esc(humanDur(oldestIrMs)), "oldest in review", oldestIrMs !== undefined && oldestIrMs > WIP_VERIFY_LAG_MS)
    + `</div>`;

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
    + (cycle.length ? cycle.map((c) => `<div class="rlevel"><span class="rkey">${esc(c.tid)}</span><span>cycle <b>${esc(c.label)}</b> · Done <time datetime="${esc(c.done)}" title="${esc(c.done)}">${esc(relTime(nowMs, c.done))}</time></span></div>`).join("") : `<p class="empty">No tickets reached Done in the last 30 days.</p>`);
  // DL-84 — per-stage breakdown of that cycle time: median residence in each stage over the SAME recently-Done
  // set, so the operator can see WHICH stage is the bottleneck. A high Todo (queue-wait) points at Dev throughput;
  // a high In Review (verify-lag) points at the OWNER agents (PM/QA) not verifying finished work — distinct from
  // DL-79's acceptance-rate (verify-*fails*, not verify-*waits*). A stage with no qualifying ticket renders "—"
  // (never a fake 0 / divide-by-zero); each median shows its n (DL-79 raw-count parity).
  const STAGE_LABELS: Record<string, string> = {
    "Todo": "Todo — queue-wait (awaiting Dev pickup)",
    "In Progress": "In Progress — build (Dev)",
    "In Review": "In Review — verify-lag (awaiting owner PM/QA verify)",
  };
  // ui P5: each stage median also renders as a horizontal bar sized against the SLOWEST stage — a
  // zero-dep inline visualization (the width is a computed integer %, the color a --s-* token var,
  // so the webui no-hex guard holds; a sub-2% sliver is floored so a real value never vanishes).
  const STAGE_VAR: Record<string, string> = { "Todo": "--s-todo", "In Progress": "--s-progress", "In Review": "--s-review" };
  const stageMed: Record<string, number | undefined> = Object.fromEntries(STAGES.map((s) => [s, median(stageLists[s])]));
  const maxMed = Math.max(0, ...STAGES.map((s) => stageMed[s] ?? 0));
  const stageRow = (st: string): string => {
    const list = stageLists[st], med = stageMed[st];
    if (med === undefined) return metricRow(STAGE_LABELS[st], `<span class="sub">— no data</span>`);
    const pct = maxMed > 0 ? Math.max(2, Math.round((med / maxMed) * 100)) : 0;
    return metricRow(STAGE_LABELS[st],
      `<b>${esc(humanDur(med))}</b> <span class="sub">n ${esc(list.length)}</span>`
      + `<span class="bar" aria-hidden="true"><span class="bar-fill" style="width:${pct}%;background:var(${STAGE_VAR[st]})"></span></span>`);
  };
  const stageSection = `<h3>Time in stage — recently Done (median)</h3>` + STAGES.map(stageRow).join("");
  // DL-89 — Open WIP aging RENDER (data computed above, before the tiles): per active state, the
  // currently-open tickets ordered oldest-first by how long they have sat in that state RIGHT NOW —
  // a forward-looking "now" snapshot complementing the backward-looking stage medians above.
  // ui P5: the stale flags render as tinted chips; the warn semantics are UNCHANGED (In Review > 2d,
  // In Progress > 1d, Human-Blocked never — a deliberate park is not a bad state).
  const wipFlag = (state: string, ageMs: number): string =>
    state === "In Review" && ageMs > WIP_VERIFY_LAG_MS ? ` <span class="flag warn">⚠ verify-lag</span>`        // owner (PM/QA) not verifying finished work
    : state === "In Progress" && ageMs > WIP_ORPHAN_MS ? ` <span class="flag warn">⚠ possible-orphan</span>`   // a claim outliving its Dev fire (beyond Sweep's reclaim)
    : "";                                                                    // Human-Blocked is a deliberate park — shown, never flagged
  const wipBlock = (state: string): string => {
    const list = (openByState.get(state) ?? []).sort((a, b) => a.sinceMs - b.sinceMs);  // oldest-first = earliest into-state timestamp first (AC1)
    const head = metricRow(state, `<span class="sub">${list.length ? `${esc(list.length)} open` : "— none"}</span>`);  // AC4: no open tickets → a neutral "— none", never a fake 0
    return head + list.map((t) => { const ageMs = nowMs - t.sinceMs; return metricRow(t.id, `<b>${esc(humanDur(ageMs))}</b>${wipFlag(state, ageMs)}`); }).join("");
  };
  // core states always render (— none when empty); a park state only when populated (see the WIP_*_STATES consts).
  const wipStates = [...WIP_CORE_STATES, ...WIP_PARK_STATES.filter((s) => openByState.get(s)?.length)];
  const openWipSection = `<h3>Open WIP — aging</h3>` + wipStates.map(wipBlock).join("");
  // ui P5: the feed as a real timeline — one eventLine row per event (kind icon / actor chip /
  // ticket link / relative time), grouped by UTC day (created_at is ISO-sorted; the feed is
  // newest-first, so the day dividers descend).
  let lastDay = "";
  const feedRows = feed.map((e) => {
    const day = String(e.created_at ?? "").slice(0, 10);
    const divider = day && day !== lastDay ? `<div class="ev-day">${esc(day)}</div>` : "";
    if (day) lastDay = day;
    return divider + eventLine(e, projectKey, nowMs);
  }).join("");
  const feedSection = `<h3>Recent activity${countPill(feed.length, true)}</h3>`
    + (feed.length ? `<div class="feed">${feedRows}</div>` : `<p class="empty">No activity recorded yet.</p>`);

  // ui P5 layout: stat tiles (headline) → one .acard per metric group in a responsive grid → the
  // timeline feed full-width below. Section ORDER is load-bearing for the slice-based tests
  // (cycle-stage.ts / open-wip.ts bind assertions between "Time in stage" / "Open WIP" / "Recent
  // activity" markers) — keep Throughput → Acceptance → Per-actor → Cycle → Stage → WIP → feed.
  return `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a><article class="apage"><h1>Activity — ${esc(projectKey)}</h1>`
    + tiles
    + `<div class="agrid">`
    + card(throughput) + card(acceptance) + card(actorSection) + card(cycleSection) + card(stageSection) + card(openWipSection)
    + `</div>`
    + card(feedSection, " afeed")
    + `</article>`;
}
