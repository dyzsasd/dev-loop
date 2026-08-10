// LOOP-409 (design `project-config-projection`, D1) — the ONE reconciler that projects the
// operator's resolved `dev-loop.json` governing knobs into the hub `projects` row.
//
// Why a projection and not a read-through: `project` is in cli.ts's ATTACH_OK allowlist, so
// `get_project` is served to an operator attached over DEVLOOP_HUB_URL to a REMOTE hub. A
// read-through would answer that call from the caller's filesystem — the wrong workspace, or none
// at all — for the one op every `interface:"cli"` fire runs first. A projected row travels with
// `hub.db` through `bundle export` / `team import` and answers correctly from any host.
//
// Corollary, and the reason this file exists at all: `getProject`'s SQL and `labelstore.ts` are
// NOT touched by this work. The column stays the read surface; this module is its only writer.
//
// Leaf by construction: `team-config.ts` + `node:sqlite`, nothing else. The db is passed in and the
// opener is injected, so the module never reaches for a path, a logger, or the db layer.
import type { DatabaseSync } from "node:sqlite";
import {
  TEAM_INTAKE_PROJECT,
  deliveryProjects,
  effectiveProject,
  normalizeAutonomy,
  type Autonomy,
  type Mode,
  type Workspace,
} from "./team-config.ts";

// The two fields that exist in BOTH stores and must not disagree. Typed off the config vocabulary
// (`Mode` = "live" | "dry-run", `Autonomy` = "ask" | "full", both post-LOOP-408) rather than
// re-spelling the unions here — one token set is the point of child A, and the db CHECK constraints
// on `projects.mode` / `projects.autonomy` are the same two sets.
export interface ProjectionRow { mode: Mode; autonomy: Autonomy }
export interface ProjectionChange { key: string; from: ProjectionRow; to: ProjectionRow }

// The column defaults, which are also §12/§12a's defaults: absent config ⇒ live/ask.
const DEFAULTS: ProjectionRow = { mode: "live", autonomy: "ask" };

// The resolved values for one key. `effectiveProject` is the ONE resolver for the §11 precedence and
// the `guarded` → `ask` alias — never re-derived here. `_team` has no config entry by construction
// (E11), so it takes the team-level values through the same defaulting.
function resolvedRow(ws: Workspace, key: string): ProjectionRow {
  if (key === TEAM_INTAKE_PROJECT) {
    const t = ws.file.team;
    return { mode: t.mode ?? DEFAULTS.mode, autonomy: normalizeAutonomy(t.autonomy) ?? DEFAULTS.autonomy };
  }
  const p = effectiveProject(ws, key);
  return { mode: p.mode ?? DEFAULTS.mode, autonomy: p.autonomy ?? DEFAULTS.autonomy };
}

/**
 * Reconcile every DESCRIBED hub row with its resolved config values. Returns one entry per row
 * actually changed — so a second call on an unchanged workspace returns `[]` (idempotent).
 *
 * Scope is derived from `dev-loop.json`, which is what makes "never touch an undescribed row" true
 * by construction rather than by a filter: a hub row with no config entry is historical or
 * hand-seeded (doctor already reports it as info), and writing team defaults over it would invent
 * state rather than project it.
 *
 * `includeUnschedulable` is deliberate and is the one place this differs from the ticket's literal
 * `deliveryProjects(ws)`: that filter answers "which projects get FIRES", excluding `enabled:false`
 * and `scratch:true`. Both of those are still DESCRIBED rows whose `dev-loop project --json` an
 * operator reads, so excluding them would leave exactly the stale-row defect this module exists to
 * close (this workspace's own `fixture` is such a row). The undescribed-row rule is untouched.
 */
export function syncProjectRows(db: DatabaseSync, ws: Workspace): ProjectionChange[] {
  const changes = projectRowDivergences(db, ws);
  const upd = db.prepare("UPDATE projects SET mode=?, autonomy=? WHERE key=?");
  for (const c of changes) upd.run(c.to.mode, c.to.autonomy, c.key);
  return changes;
}

/**
 * The ONE definition of "this row disagrees with config" — read-only, and the detector
 * `syncProjectRows` applies (LOOP-410).
 *
 * Split out rather than duplicated because the two callers must never be able to disagree: the
 * mutator's console line and `doctor`'s W42 answer the same question, so a drift the writer would
 * repair is exactly a drift the checker reports, by construction. Everything scope-related — which
 * keys are in play, the undescribed-row rule, the `_team` case, the resolution precedence — lives
 * here once and is inherited by both.
 *
 * Read-only is load-bearing, not incidental: `doctor` opens `hub.db` in READ-ONLY mode, so a
 * detector that shared a code path with the UPDATE could not be called from there at all.
 */
export function projectRowDivergences(db: DatabaseSync, ws: Workspace): ProjectionChange[] {
  const sel = db.prepare("SELECT mode, autonomy FROM projects WHERE key=?");
  const diverged: ProjectionChange[] = [];
  for (const key of [...deliveryProjects(ws, { includeUnschedulable: true }), TEAM_INTAKE_PROJECT]) {
    const row = sel.get(key) as ProjectionRow | undefined;
    // No row yet: seeding creates it and then projects onto it. Writing here would invent a row.
    if (!row) continue;
    const to = resolvedRow(ws, key);
    if (row.mode === to.mode && row.autonomy === to.autonomy) continue;
    diverged.push({ key, from: { mode: row.mode, autonomy: row.autonomy }, to });
  }
  return diverged;
}

/**
 * The call-site form: open, reconcile, close — and NEVER fail the caller.
 *
 * The posture is `team-edit.ts`'s existing one for the `scratch` projection: the operator's config
 * write is their intent and must not be lost because `hub.db` is momentarily busy or unreachable.
 * A skipped projection is reported and self-heals on the next `hub start` / `dev-loop run`; the
 * doctor divergence check (LOOP-410) is the backstop that makes a persistent skip visible.
 *
 * The opener is injected so this module stays a leaf (no `db.ts` / `workspace.ts` import); every
 * call site already holds both a `Workspace` and the two helpers it needs.
 */
export function syncProjectRowsBestEffort(
  ws: Workspace,
  open: () => DatabaseSync,
  report: (line: string) => void,
): ProjectionChange[] {
  if (ws.file.team.backend !== "service") return [];
  try {
    const db = open();
    try {
      const changes = syncProjectRows(db, ws);
      for (const c of changes)
        report(`projected '${c.key}' to the hub row: mode ${c.from.mode} → ${c.to.mode}, autonomy ${c.from.autonomy} → ${c.to.autonomy}`);
      return changes;
    } finally { db.close(); }
  } catch (e) {
    // Report, do not throw — and name the surface that will catch a persistent divergence.
    report(`•  hub row projection skipped (${(e as Error).message}) — \`dev-loop doctor\` reports the divergence`);
    return [];
  }
}
