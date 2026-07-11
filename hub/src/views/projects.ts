// dev-loop hub daemon web UI — the PROJECT INDEX landing (F2, decision D2 multi-project routing).
//
// GET / on a multi-project hub: one card per hub project — key/name, open-ticket counts by state
// (small state-colored dots), last-activity — each linking to its /p/<key>/ board. `_team` (the
// reserved service-intake pseudo-project) is PINNED LAST and presented as "Team intake", visually
// distinct (dashed, surface-2): it is the mailbox cross-project asks land in, not a peer delivery
// project. Pure read-only rendering through the query_only db; nowMs is injected by daemon.ts so the
// relative last-activity label stays pure/testable (the activityPage precedent). The single-real-
// project redirect (D2's allowance) lives in daemon.ts, so by the time this renders the hub holds
// zero or ≥2 real projects (an _team-only hub renders just the intake card).
import { DatabaseSync } from "node:sqlite";
import { isTeamProject } from "../team-config.ts";
import { esc, href, stateDot } from "./ui.ts";

// The non-terminal board states, in board order — "open" work for the per-project state counts
// (Done/Canceled/Duplicate are outcomes, not open work; matches boardPage's TERMINAL_STATES complement).
const OPEN_STATES = ["Backlog", "Todo", "In Progress", "In Review", "Human-Blocked"];

// Relative last-activity label ("3d ago" / "2h ago" / "just now"); no or unparseable timestamp →
// "no activity yet". Returns the iso alongside so the caller can render a <time title=ISO> hover.
function relLabel(iso: string | null | undefined, nowMs: number): { label: string; iso?: string } {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return { label: "no activity yet" };
  const m = Math.floor(Math.max(0, nowMs - t) / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return { label: d > 0 ? `${d}d ago` : h > 0 ? `${h}h ago` : m > 0 ? `${m}m ago` : "just now", iso: iso! };
}

export function projectIndexPage(db: DatabaseSync, nowMs: number): string {
  const projects = db.prepare("SELECT id,key,name FROM projects ORDER BY key").all() as { id: string; key: string; name: string }[];
  const openByState = db.prepare(`SELECT state, COUNT(*) AS n FROM tickets WHERE project_id=? AND state IN (${OPEN_STATES.map(() => "?").join(",")}) GROUP BY state`);
  const lastEvent = db.prepare("SELECT MAX(created_at) AS m FROM events WHERE project_id=?");

  const card = (p: { id: string; key: string; name: string }): string => {
    const counts = new Map((openByState.all(p.id, ...OPEN_STATES) as { state: string; n: number }[]).map((r) => [r.state, Number(r.n)]));
    const open = [...counts.values()].reduce((a, b) => a + b, 0);
    const last = relLabel((lastEvent.get(p.id) as { m: string | null }).m, nowMs);
    const when = last.iso ? `<time datetime="${esc(last.iso)}" title="${esc(last.iso)}">${esc(last.label)}</time>` : esc(last.label);
    const intake = isTeamProject(p.key);
    // dot + count per populated open state (title carries the state name; a visually-hidden span keeps
    // it readable to a screen reader) — the "shape of open work" at a glance, per the D2 index spec.
    const states = open
      ? `<div class="pstates">` + OPEN_STATES.filter((s) => counts.get(s)).map((s) =>
          `<span class="pstate" title="${esc(s)}">${stateDot(s)}${counts.get(s)}<span class="vh">${esc(s)}</span></span>`).join("") + `</div>`
      : `<p class="pstates empty">no open tickets</p>`;
    return `<a class="pcard${intake ? " team" : ""}" href="${esc(href(p.key, "/"))}">`
      + `<span class="pkey">${esc(p.key)}</span>`
      + `<h2>${intake ? "Team intake" : esc(p.name)}</h2>`
      + (intake
        ? `<p class="psub">${open} open intake ticket${open === 1 ? "" : "s"} — cross-project asks land here, not a delivery project</p>`
        : states)
      + `<p class="plast">last activity ${when}</p></a>`;
  };

  // real projects first (key order), the _team intake card pinned LAST — not a peer project.
  const cards = [...projects.filter((p) => !isTeamProject(p.key)), ...projects.filter((p) => isTeamProject(p.key))].map(card).join("");
  return `<h1 class="vh">hub projects</h1>`
    + (cards
      ? `<div class="projects">${cards}</div>`
      : `<p class="empty">No projects on this hub yet — seed one (<code>dev-loop team init</code> / <code>dev-loop add-project</code>), then reload.</p>`);
}
