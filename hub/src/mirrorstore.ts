// Shared P7 mirror store (DL-68) — the `mirror.push` HANDLER logic (ticket-fetch → content-hash skip →
// mapping-row-FIRST → reconcile-by-marker → create/update/skip/fail orchestration, the DL-11 side-effect-free
// DRYRUN) + `mirror.status`, used by BOTH the MCP server (server.ts) and the daemon op-API (agentops.ts). The
// Linear TRANSPORT (issueCreate/issueUpdate/findByMarker/the §16 token-never-thrown gql) stays in linear.ts and
// is reused AS-IS; this module is the handler layer linear.ts's transport serves — the docstore/topicstore/
// channelstore precedent that lets the stdio server and the daemon op-API share ONE implementation and never
// drift (the DL-11 DRYRUN invariant + the reconcile-by-marker idempotency live in exactly one place).
//
// SIDE-EFFECT-FREE entrypoint (no top-level db; identity (actor) + scope (projectId) are passed in by the
// caller — the daemon resolves the actor from X-Devloop-Actor, the stdio server passes its ACTOR — so every
// mirror.push/mirror.error event is attributed to the REAL caller on both paths). `fetchImpl` is injectable
// (default = the global fetch) so the adapter units can drive it; the live endpoint is env-overridable inside
// linear.ts (DEVLOOP_LINEAR_API_URL), exactly as before — the MIRROR_OK suite relies on that, unchanged.
//
// §16: the Linear token is read SERVER-SIDE from env[tokenEnv]; the caller passes only the NAME (validated by
// isEnvName, reused from channelstore — one definition, no drift). A literal token → a clean error, never
// persisted/echoed; a failed Linear call throws only a scrubbed status/message (linear.ts) which the catch
// records via scrubErr — the token never appears in any mirror.* response or event (the DL-52 invariant). §17
// firewall (structural): every write here is an INSERT/UPDATE on the `mirror_map` DB table — there is NO
// filesystem path anywhere in this module; the only external effect is the one-way network write via linear.ts
// (the hub NEVER reads Linear as truth — findByMarker only reconciles its own mapping).
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, logEvent, type Ticket } from "./db.ts";
import { findByMarker, createIssue, updateIssue, type MirrorIssue, type FetchImpl } from "./linear.ts";
import { scrubErr } from "./channel.ts";
import { isEnvName } from "./channelstore.ts";

// Discriminated result (mirrors docstore's DocResult / channelstore's ChannelResult): server.ts maps it to
// ok()/err(); the daemon op-API maps it to an HTTP status. mirror.push's only error class is bad input / an
// unset-or-literal token (a §16 cred problem) — all client 400s; the daemon owns origin/actor/mode upstream,
// and there is no not-found (404) or CAS (409) here. A failed Linear network call does NOT error the op — it
// is counted in `failed` and logged (scrubbed), exactly like server.ts. So callers map any error → 400.
export type MirrorResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Read at module load (a const, byte-identical to server.ts's MIRROR_DRYRUN) — DEVLOOP_MIRROR_DRYRUN=1 makes
// mirror.push side-effect-free: it previews the would-push `ops`, hits NO network, and persists NO mirror_map
// row (DL-11). Set it in the spawned process env (the MIRROR_OK suite + the agent-api/shim npm scripts do).
const MIRROR_DRYRUN = process.env.DEVLOOP_MIRROR_DRYRUN === "1";
const MIRROR_BANNER = "> 🤖 Mirrored from the dev-loop hub — edits here are IGNORED and overwritten on the next push. Give direction by filing a Todo to PM (conventions §9a).";

// row → Ticket (verbatim from server.ts/agentops.ts's local copy — the per-module idiom until the P3 dispatch
// convergence collapses the three into one). mirror.push needs the full ticket for mirrorTitle/mirrorBody.
interface TicketRow {
  id: string; project_id: string; title: string; description: string; type: string;
  state: string; assignee: string | null; priority: number; labels: string;
  duplicate_of: string | null; related_to: string; created_by: string; created_at: string; updated_at: string;
}
const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, project_id: r.project_id, title: r.title, description: r.description, type: r.type,
  state: r.state as Ticket["state"], assignee: r.assignee, priority: r.priority,
  labels: JSON.parse(r.labels) as string[],
  duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to) as string[],
  created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
});

interface MirrorRow { id: string; hub_id: string; linear_id: string | null; last_pushed_hash: string | null; }
const mirrorTitle = (t: Ticket): string => `${t.title} [hub:${t.id}]`;
const mirrorBody = (t: Ticket): string => [
  MIRROR_BANNER, "",
  `**hub:** ${t.id} · **type:** ${t.type} · **state:** ${t.state} · **priority:** ${t.priority} · **owner:** ${t.assignee ?? "—"}`,
  t.labels.length ? `**labels:** ${t.labels.join(", ")}` : "",
  t.relatedTo.length ? `**related:** ${t.relatedTo.join(", ")}` : "",
  t.duplicateOf ? `**duplicate of:** ${t.duplicateOf}` : "",
  "", t.description || "_(no description)_",
].filter((l) => l !== "").join("\n");
const mirrorHash = (t: Ticket, stateId: string | undefined): string =>
  createHash("sha256").update(JSON.stringify({ title: mirrorTitle(t), body: mirrorBody(t), stateId: stateId ?? null })).digest("hex");

export interface MirrorPushArgs {
  teamId: string;
  tokenEnv: string;
  projectId?: string;            // the Linear project id (optional)
  stateMap?: Record<string, string>; // hub State → Linear state id
  limit?: number;
}
export interface MirrorPushResult {
  created: number; updated: number; skipped: number; failed: number; dryrun: boolean;
  ops?: { op: string; hubId: string; title: string; body: string; stateId: string | null }[];
}
// ONE-WAY push: project hub tickets → Linear issues (create-or-update, idempotent + incremental). Verbatim
// from server.ts (ACTOR → the passed `actor`, the global fetch → the injectable `fetchImpl`), so server.ts's
// externally-observable behavior is unchanged. `db` MUST be a WRITABLE connection for a live push.
export async function mirrorPush(
  db: DatabaseSync, projectId: string, actor: string, a: MirrorPushArgs, fetchImpl: FetchImpl = fetch,
): Promise<MirrorResult<MirrorPushResult>> {
  if (!isEnvName(a.tokenEnv)) return { ok: false, error: `tokenEnv must be an ENV-VAR NAME (e.g. DEVLOOP_LINEAR_TOKEN), not the secret value itself` };
  const token = process.env[a.tokenEnv];
  if (!token && !MIRROR_DRYRUN) return { ok: false, error: `mirror token env '${a.tokenEnv}' is unset` };
  const rows = db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC LIMIT ?").all(projectId, a.limit ?? 500) as TicketRow[];
  const tickets = rows.map(toTicket);
  let created = 0, updated = 0, skipped = 0, failed = 0;
  const ops: { op: string; hubId: string; title: string; body: string; stateId: string | null }[] = [];
  for (const t of tickets) {
    const stateId = a.stateMap?.[t.state]; // missing ⇒ undefined ⇒ no stateId (fallback: state is in the body)
    const issue: MirrorIssue = { title: mirrorTitle(t), description: mirrorBody(t), stateId };
    const hash = mirrorHash(t, stateId);
    let row = db.prepare("SELECT id,hub_id,linear_id,last_pushed_hash FROM mirror_map WHERE project_id=? AND hub_kind='ticket' AND hub_id=?").get(projectId, t.id) as MirrorRow | undefined;
    if (row && row.linear_id && row.last_pushed_hash === hash) { skipped++; continue; } // incremental skip (unchanged)
    if (!row) {
      // mapping-row-FIRST: record intent BEFORE the remote create → a crash never orphans a Linear
      // issue (a NULL-id row on the next fire reconciles by marker). The UNIQUE(project,kind,hub_id)
      // makes two concurrent pushers' INSERTs serialize — the loser throws + retries (no dup row).
      const rid = randomUUID();
      // DRYRUN is side-effect-free (§12, DL-11): keep the mapping row IN MEMORY only. Persisting it
      // poisons a later live push — an unchanged ticket is skipped (never created) and a changed one
      // gets stuck updating a non-existent `dry-<id>`. The in-memory row still drives the logic + ops.
      if (!MIRROR_DRYRUN) db.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,created_at) VALUES (?,?,'ticket',?,?)").run(rid, projectId, t.id, nowIso());
      row = { id: rid, hub_id: t.id, linear_id: null, last_pushed_hash: null };
    }
    try {
      if (!row.linear_id) {
        // ALWAYS reconcile-by-marker before creating (Codex review): closes the concurrent-create
        // window (a racing pusher's issue is found, not duplicated), and on a crashed-create retry
        // the existing issue is ADOPTED + UPDATED to current content (never left stale). A genuinely
        // new ticket: findByMarker returns null → create. (Full concurrency-safety still assumes the
        // single-Sweep-per-project model; a lease is over-engineering for one writer.)
        const found = MIRROR_DRYRUN ? null : await findByMarker(fetchImpl, token!, `[hub:${t.id}]`);
        let linearId: string;
        if (found) { await updateIssue(fetchImpl, token!, found, issue); linearId = found; } // adopt + push current content (fixes stale-reconcile)
        else { linearId = MIRROR_DRYRUN ? `dry-${t.id}` : await createIssue(fetchImpl, token!, a.teamId, a.projectId ?? null, issue); }
        if (!MIRROR_DRYRUN) db.prepare("UPDATE mirror_map SET linear_id=?, last_pushed_hash=?, last_pushed_at=? WHERE id=?").run(linearId, hash, nowIso(), row.id); // DRYRUN: never persist the dry-<id> sentinel/hash (DL-11)
        created++; ops.push({ op: found ? "reconcile" : "create", hubId: t.id, title: issue.title, body: issue.description, stateId: stateId ?? null });
      } else {
        if (!MIRROR_DRYRUN) await updateIssue(fetchImpl, token!, row.linear_id, issue);
        if (!MIRROR_DRYRUN) db.prepare("UPDATE mirror_map SET last_pushed_hash=?, last_pushed_at=? WHERE id=?").run(hash, nowIso(), row.id); // DRYRUN: don't advance the persisted hash (DL-11)
        updated++; ops.push({ op: "update", hubId: t.id, title: issue.title, body: issue.description, stateId: stateId ?? null });
      }
    } catch (e) {
      // leave the row (linear_id as-is, hash NOT advanced) → next push retries; never persist the token
      failed++;
      logEvent(db, { project_id: projectId, actor, kind: "mirror.error", data: { hubId: t.id, error: scrubErr((e as Error).message) } });
    }
  }
  logEvent(db, { project_id: projectId, actor, kind: "mirror.push", data: { created, updated, skipped, failed } });
  return { ok: true, data: { created, updated, skipped, failed, dryrun: MIRROR_DRYRUN, ...(MIRROR_DRYRUN ? { ops } : {}) } };
}

// mirror.status — coverage counts; no secret, no Linear read. Shared so server.ts + the op-API are byte-identical.
export function mirrorStatus(db: DatabaseSync, projectId: string): { mapped: number; tickets: number; lastPush: string | null } {
  const mapped = (db.prepare("SELECT count(*) c FROM mirror_map WHERE project_id=? AND hub_kind='ticket'").get(projectId) as { c: number }).c;
  const tickets = (db.prepare("SELECT count(*) c FROM tickets WHERE project_id=?").get(projectId) as { c: number }).c;
  const last = (db.prepare("SELECT max(last_pushed_at) m FROM mirror_map WHERE project_id=?").get(projectId) as { m: string | null }).m;
  return { mapped, tickets, lastPush: last };
}
