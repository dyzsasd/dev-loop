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
// firewall (structural): every hub-state write here is an INSERT/UPDATE on the `mirror_map`/`tickets` DB
// tables; the ONE filesystem touch is the D5 poller's machine-local acted-ledger under the data dir
// (devloopDataDir()/mirror-state/<projectKey>.json — the reports-state.json pattern, §23): pure machine
// bookkeeping, never operator/doc content and never a repo path, so no doc write can ever target a
// SKILL/conventions/code file. The only other external effect is the one-way network write via linear.ts
// (the hub NEVER reads Linear as truth — findByMarker reconciles our own mapping; the D5 poller reads
// comments/content ONLY to file needs-pm INTAKE tickets, never to write hub doc/ticket state back).
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, logEvent, type Ticket } from "./db.ts";
import { findByMarker, createIssue, updateIssue, findDocByMarker, createDocument, updateDocument,
  getDocumentContent, listDocComments, type MirrorIssue, type MirrorDocument, type FetchImpl } from "./linear.ts";
import { insertTicket } from "./ticketwrite.ts";
import { devloopDataDir } from "./paths.ts";
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
// D5 doc banner: unlike issues, a mirrored DOC has a working inbound path — comments (and needs-pm tickets)
// are picked up by mirror.pollComments; only BODY edits are one-way-overwritten. The banner says exactly that.
const MIRROR_DOC_BANNER = "> 🤖 Mirrored from dev-loop — body edits here are overwritten; comment here or file a ticket to give direction.";

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

// ─── D5 doc projection: which hub docs mirror, and what Linear sees ─────────────────────────────────────────
// PUBLISHED strategy/roadmap/decisions (the operator-gated kinds — drafts stay private until publish) +
// LATEST design (latest-is-live, never publish-gated; docstore.ts). 'notes' never mirrors (scratch tier).
// hub_id for a doc mapping row is the SLUG (the doc's stable identity, UNIQUE per project) and the title
// marker is `[hub:doc:<projectKey>/<slug>]` — the doc twin of the ticket mirror's `[hub:<id>]` convention.
// The projectKey discriminator is LOAD-BEARING (Codex review): ticket ids are workspace-unique by prefix,
// but doc slugs collide across projects ('strat' everywhere) — an unscoped marker would let project B's
// reconcile-by-marker ADOPT and overwrite project A's Linear Document.
const MIRRORED_PUBLISHED_KINDS = ["strategy", "roadmap", "decisions"] as const;
interface MirrorDocRow { slug: string; kind: string; title: string; version: number; body: string; }
const mirrorableDocsSql = `
  SELECT d.slug, d.kind, d.title, v.version, v.body
  FROM documents d JOIN document_versions v ON v.doc_id = d.id
  WHERE d.project_id = ? AND (
    (d.kind IN (${MIRRORED_PUBLISHED_KINDS.map((k) => `'${k}'`).join(",")}) AND d.current_version > 0 AND v.version = d.current_version)
    OR (d.kind = 'design' AND v.version = (SELECT max(version) FROM document_versions WHERE doc_id = d.id))
  ) ORDER BY d.slug`;
const mirrorableDocs = (db: DatabaseSync, projectId: string): MirrorDocRow[] =>
  db.prepare(mirrorableDocsSql).all(projectId) as unknown as MirrorDocRow[];
export const docMarker = (projectKey: string, slug: string): string => `[hub:doc:${projectKey}/${slug}]`;
const mirrorDocTitle = (projectKey: string, d: MirrorDocRow): string => `${d.title} ${docMarker(projectKey, d.slug)}`;
// The banner is PINNED (first line) so a Linear reader sees the contract before the content; the provenance
// line pins which hub version this body IS (the poller quotes it back on intake tickets).
const mirrorDocContent = (d: MirrorDocRow): string => [
  MIRROR_DOC_BANNER, "",
  `**hub doc:** ${d.slug} · **kind:** ${d.kind} · **version:** v${d.version}`,
  "", d.body || "_(empty)_",
].join("\n");
const mirrorDocHash = (title: string, content: string): string =>
  createHash("sha256").update(JSON.stringify({ title, content })).digest("hex");
// The poller's body-edit baseline: a hash of the NORMALIZED pushed content, persisted on the mapping row at
// push time so a Linear-side edit is detectable even while a NEWER hub version awaits its push (comparing
// upstream against the CURRENT projection would go blind in exactly that window — Codex review). normBody
// tolerates provider newline/edge-whitespace normalization only, never semantic drift.
const normBody = (s: string): string => s.replace(/\r\n/g, "\n").trim();
const bodyHash = (content: string): string => createHash("sha256").update(normBody(content)).digest("hex");

const mirrorTitle = (t: Ticket): string => `${t.title} [hub:${t.id}]`;
const mirrorBody = (t: Ticket): string => [
  MIRROR_BANNER, "",
  `**hub:** ${t.id} · **type:** ${t.type} · **state:** ${t.state} · **priority:** ${t.priority} · **owner:** ${t.assignee ?? "—"}`,
  t.labels.length ? `**labels:** ${t.labels.join(", ")}` : "",
  t.relatedTo.length ? `**related:** ${t.relatedTo.join(", ")}` : "",
  t.duplicateOf ? `**duplicate of:** ${t.duplicateOf}` : "",
  "", t.description || "_(no description)_",
].filter((l) => l !== "").join("\n");
// priority is in the hash so an existing mirror re-pushes once when this L2 field is added (a priority-only
// change would otherwise be a no-op skip, and Linear would keep showing priority only as body text).
const mirrorHash = (t: Ticket, stateId: string | undefined): string =>
  createHash("sha256").update(JSON.stringify({ title: mirrorTitle(t), body: mirrorBody(t), stateId: stateId ?? null, priority: t.priority })).digest("hex");

export interface MirrorPushArgs {
  teamId: string;
  tokenEnv: string;
  projectId?: string;            // the Linear project id (optional)
  stateMap?: Record<string, string>; // hub State → Linear state id
  limit?: number;
}
export interface MirrorPushResult {
  created: number; updated: number; skipped: number; failed: number; dryrun: boolean;
  // D5: doc pushes are counted SEPARATELY so the sweep report's ticket counts keep their historical meaning.
  // `note` explains a wholesale doc skip (no Linear projectId to parent Documents to).
  docs: { created: number; updated: number; skipped: number; failed: number; note?: string };
  ops?: { op: string; hubId: string; title: string; body: string; stateId: string | null }[];
}
// ONE-WAY push: project hub tickets → Linear issues (create-or-update, idempotent + incremental). Verbatim
// from server.ts (ACTOR → the passed `actor`, the global fetch → the injectable `fetchImpl`), so server.ts's
// externally-observable behavior is unchanged. `db` MUST be a WRITABLE connection for a live push.
// D5 EXTENSION: when `projectId` (the Linear project) is configured, the push ALSO projects the mirrorable
// docs (published strategy/roadmap/decisions + latest design) as Linear Documents parented to that project —
// same mapping-row-FIRST / reconcile-by-marker / content-hash-skip / DRYRUN discipline as the tickets above.
export async function mirrorPush(
  db: DatabaseSync, projectId: string, actor: string, a: MirrorPushArgs, fetchImpl: FetchImpl = fetch,
): Promise<MirrorResult<MirrorPushResult>> {
  if (!isEnvName(a.tokenEnv)) return { ok: false, error: `tokenEnv must be an ENV-VAR NAME (e.g. DEVLOOP_LINEAR_TOKEN), not the secret value itself` };
  const token = process.env[a.tokenEnv];
  if (!token && !MIRROR_DRYRUN) return { ok: false, error: `mirror token env '${a.tokenEnv}' is unset` };
  const rows = db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC LIMIT ?").all(projectId, a.limit ?? 500) as unknown as TicketRow[];
  const tickets = rows.map(toTicket);
  let created = 0, updated = 0, skipped = 0, failed = 0;
  const ops: { op: string; hubId: string; title: string; body: string; stateId: string | null }[] = [];
  for (const t of tickets) {
    const stateId = a.stateMap?.[t.state]; // missing ⇒ undefined ⇒ no stateId (fallback: state is in the body)
    const issue: MirrorIssue = { title: mirrorTitle(t), description: mirrorBody(t), stateId, priority: t.priority || undefined };
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
  // ── D5: project the mirrorable docs as Linear Documents (same discipline as the ticket loop above) ──
  const docs = { created: 0, updated: 0, skipped: 0, failed: 0 } as MirrorPushResult["docs"];
  if (!a.projectId) {
    // documentCreate parents to a Linear PROJECT; without one there is nothing to attach to — skip
    // wholesale (visible via `note`, never a silent drop, never a guaranteed-to-fail network call).
    if (mirrorableDocs(db, projectId).length) docs.note = "docs not mirrored: no Linear projectId configured (Documents parent to the mirrored project)";
  } else {
    // the marker needs the workspace-unique project KEY (doc slugs collide across projects); resolved here
    // from the SoR so server.ts/agentops callers can't drift on how it is derived.
    const projectKey = (db.prepare("SELECT key FROM projects WHERE id=?").get(projectId) as { key: string } | undefined)?.key ?? projectId;
    for (const d of mirrorableDocs(db, projectId)) {
      const title = mirrorDocTitle(projectKey, d), content = mirrorDocContent(d);
      const hash = mirrorDocHash(title, content);
      let row = db.prepare("SELECT id,hub_id,linear_id,last_pushed_hash FROM mirror_map WHERE project_id=? AND hub_kind='doc' AND hub_id=?").get(projectId, d.slug) as MirrorRow | undefined;
      if (row && row.linear_id && row.last_pushed_hash === hash) { docs.skipped++; continue; } // incremental skip (unchanged)
      if (!row) {
        // mapping-row-FIRST + the DL-11 in-memory-only DRYRUN row — verbatim the ticket discipline above.
        const rid = randomUUID();
        if (!MIRROR_DRYRUN) db.prepare("INSERT INTO mirror_map(id,project_id,hub_kind,hub_id,created_at) VALUES (?,?,'doc',?,?)").run(rid, projectId, d.slug, nowIso());
        row = { id: rid, hub_id: d.slug, linear_id: null, last_pushed_hash: null };
      }
      const doc: MirrorDocument = { title, content };
      // last_pushed_version/body_hash ride every successful push: the poller's provenance + body-edit
      // baseline must describe what LINEAR holds, not where the hub has moved since.
      const stamp = (linearId: string | null): void => {
        if (MIRROR_DRYRUN) return;
        if (linearId) db.prepare("UPDATE mirror_map SET linear_id=?, last_pushed_hash=?, last_pushed_at=?, last_pushed_version=?, last_pushed_body_hash=? WHERE id=?").run(linearId, hash, nowIso(), d.version, bodyHash(content), row!.id);
        else db.prepare("UPDATE mirror_map SET last_pushed_hash=?, last_pushed_at=?, last_pushed_version=?, last_pushed_body_hash=? WHERE id=?").run(hash, nowIso(), d.version, bodyHash(content), row!.id);
      };
      try {
        if (!row.linear_id) {
          // reconcile-by-marker before creating (the crashed-create/concurrent-create window, as tickets).
          const found = MIRROR_DRYRUN ? null : await findDocByMarker(fetchImpl, token!, docMarker(projectKey, d.slug));
          let linearId: string;
          if (found) { await updateDocument(fetchImpl, token!, found, doc); linearId = found; } // adopt + push current content
          else { linearId = MIRROR_DRYRUN ? `dry-doc-${d.slug}` : await createDocument(fetchImpl, token!, a.projectId, doc); }
          stamp(linearId);
          docs.created++; ops.push({ op: found ? "doc.reconcile" : "doc.create", hubId: `doc:${d.slug}`, title, body: content, stateId: null });
        } else {
          if (!MIRROR_DRYRUN) await updateDocument(fetchImpl, token!, row.linear_id, doc);
          stamp(null);
          docs.updated++; ops.push({ op: "doc.update", hubId: `doc:${d.slug}`, title, body: content, stateId: null });
        }
      } catch (e) {
        docs.failed++; // row left as-is (hash not advanced) → next push retries; token never persisted
        logEvent(db, { project_id: projectId, actor, kind: "mirror.error", data: { hubId: `doc:${d.slug}`, error: scrubErr((e as Error).message) } });
      }
    }
  }
  logEvent(db, { project_id: projectId, actor, kind: "mirror.push", data: { created, updated, skipped, failed, docs } });
  return { ok: true, data: { created, updated, skipped, failed, dryrun: MIRROR_DRYRUN, docs, ...(MIRROR_DRYRUN ? { ops } : {}) } };
}

// mirror.status — coverage counts; no secret, no Linear read. Shared so server.ts + the op-API are byte-identical.
// D5 additive fields: docsMapped (mirror_map hub_kind='doc' rows) vs docs (the currently-mirrorable set).
export function mirrorStatus(db: DatabaseSync, projectId: string): { mapped: number; tickets: number; docsMapped: number; docs: number; lastPush: string | null } {
  const mapped = (db.prepare("SELECT count(*) c FROM mirror_map WHERE project_id=? AND hub_kind='ticket'").get(projectId) as { c: number }).c;
  const tickets = (db.prepare("SELECT count(*) c FROM tickets WHERE project_id=?").get(projectId) as { c: number }).c;
  const docsMapped = (db.prepare("SELECT count(*) c FROM mirror_map WHERE project_id=? AND hub_kind='doc'").get(projectId) as { c: number }).c;
  const docs = mirrorableDocs(db, projectId).length;
  const last = (db.prepare("SELECT max(last_pushed_at) m FROM mirror_map WHERE project_id=?").get(projectId) as { m: string | null }).m;
  return { mapped, tickets, docsMapped, docs, lastPush: last };
}

// ─── D5 comment→intake poller (mirror.pollComments) ─────────────────────────────────────────────────────────
// Reads NEW human comments on the mirrored docs and files ONE needs-pm Backlog ticket per comment (doc slug +
// mirrored version + quoted text + comment URL as provenance), plus ONE per detected Linear-side BODY edit
// (the upstream content no longer matches what we pushed — flagged, never written back; the next push
// overwrites it). Dedup is a MACHINE-LOCAL acted-ledger (the §23 reports-state.json shape: an `acted` map
// keyed by comment id + a `lastPolledAt` watermark), NOT hub state — re-pointing the data dir simply re-files,
// and the ledger never carries operator content beyond the ids it needs. DRYRUN (DEVLOOP_MIRROR_DRYRUN=1):
// Linear READS still happen (they are side-effect-free) but NO ticket is filed and NO ledger byte is written —
// the would-file ops are returned, mirroring mirror.push's DL-11 preview contract.
interface MirrorLedger {
  acted: Record<string, { actedAt: string; ticketId: string }>;
  divergence: Record<string, { hash: string; ticketId: string; filedAt: string }>;
  lastPolledAt: string | null;
}
const ledgerPath = (projectKey: string): string => join(devloopDataDir(), "mirror-state", `${projectKey}.json`);
function loadLedger(projectKey: string): MirrorLedger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(projectKey), "utf8")) as Partial<MirrorLedger>;
    return { acted: raw.acted ?? {}, divergence: raw.divergence ?? {}, lastPolledAt: raw.lastPolledAt ?? null };
  } catch { return { acted: {}, divergence: {}, lastPolledAt: null }; } // missing/corrupt ⇒ fresh (worst case: a re-filed intake, never a crash)
}
function saveLedger(projectKey: string, ledger: MirrorLedger): void {
  const path = ledgerPath(projectKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(ledger, null, 2)); // tmp+rename: never leave a torn JSON (§11)
  renameSync(`${path}.tmp`, path);
}
// One intake filer for both signals: Backlog + dev-loop/pm/needs-pm (the §9a carrier — explicit intake, so it
// works under passive §5a too). Body text is PROVENANCE, quoted as data (§16: stored verbatim, esc()'d at render).
function fileIntake(db: DatabaseSync, projectId: string, actor: string, title: string, description: string, priority: number): string {
  return insertTicket(db, projectId, actor,
    { title, description, type: "Improvement", state: "Backlog", assignee: null, priority, labels: ["dev-loop", "pm", "needs-pm"], duplicateOf: null, relatedTo: [] },
    { title, type: "Improvement" });
}
const firstLine = (s: string, max: number): string => {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

export interface MirrorPollArgs { tokenEnv: string; }
export interface MirrorPollResult {
  docs: number; comments: number; filed: number; divergences: number; alreadyActed: number; failed: number; dryrun: boolean;
  ops?: { op: "comment-intake" | "edit-divergence"; slug: string; commentId?: string; ticketId?: string; title: string }[];
}
export async function mirrorPollComments(
  db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: MirrorPollArgs, fetchImpl: FetchImpl = fetch,
): Promise<MirrorResult<MirrorPollResult>> {
  if (!isEnvName(a.tokenEnv)) return { ok: false, error: `tokenEnv must be an ENV-VAR NAME (e.g. DEVLOOP_LINEAR_TOKEN), not the secret value itself` };
  const token = process.env[a.tokenEnv];
  if (!token) return { ok: false, error: `mirror token env '${a.tokenEnv}' is unset` }; // unlike push, DRYRUN still READS Linear — the token is always required
  const ledger = loadLedger(projectKey);
  // Only PUSHED docs are pollable (linear_id set); join back to documents so provenance carries the kind.
  // last_pushed_version/body_hash describe what LINEAR currently holds (stamped at push time) — the intake
  // provenance and the divergence baseline use THOSE, so both stay correct while a newer hub version is
  // still awaiting its push (the doc row's own version may have moved on since).
  const rows = db.prepare(`
    SELECT m.linear_id, m.last_pushed_hash, m.last_pushed_at, m.last_pushed_version, m.last_pushed_body_hash,
           d.slug, d.kind, d.title, v.version, v.body
    FROM mirror_map m
    JOIN documents d ON d.project_id = m.project_id AND d.slug = m.hub_id
    JOIN document_versions v ON v.doc_id = d.id AND v.version = CASE WHEN d.kind = 'design'
      THEN (SELECT max(version) FROM document_versions WHERE doc_id = d.id) ELSE d.current_version END
    WHERE m.project_id = ? AND m.hub_kind = 'doc' AND m.linear_id IS NOT NULL
    ORDER BY d.slug`).all(projectId) as unknown as (MirrorDocRow &
      { linear_id: string; last_pushed_hash: string | null; last_pushed_at: string | null; last_pushed_version: number | null; last_pushed_body_hash: string | null })[];
  let comments = 0, filed = 0, divergences = 0, alreadyActed = 0, failed = 0;
  const ops: NonNullable<MirrorPollResult["ops"]> = [];
  for (const d of rows) {
    // Divergence dedupe RESET: ledger.divergence[slug] keys on the upstream content hash, but a push
    // that lands AFTER the ticket was filed OVERWRITES that diverged upstream — the hashed content is
    // gone from Linear, so a human RE-APPLYING the byte-identical edit is a NEW divergence and must
    // re-file (without this, it was silently deduped forever). The push side already RECORDS the
    // reconcile signal — last_pushed_at is stamped on every non-skip doc push — so the poller (the
    // ledger's sole owner) reconciles here: an entry filed BEFORE the last stamping push is stale ⇒
    // drop it. STRICTLY newer: a push that merely predates the filing is the very baseline the
    // divergence was computed against, and clearing on it would re-file the SAME ticket every poll.
    // The in-memory delete persists via the poll's own saveLedger calls (none in DRYRUN — write-free).
    const staleDiv = ledger.divergence[d.slug];
    if (staleDiv && d.last_pushed_at && Date.parse(d.last_pushed_at) > Date.parse(staleDiv.filedAt)) delete ledger.divergence[d.slug];
    // (1) comment → intake: every unseen HUMAN comment files one needs-pm Backlog ticket.
    try {
      for (const c of await listDocComments(fetchImpl, token, d.linear_id)) {
        if (!c.isHuman) continue;
        if (ledger.acted[c.id]) { alreadyActed++; continue; }
        comments++;
        const mirroredV = d.last_pushed_version ?? d.version; // what Linear showed the commenter (legacy rows: best effort)
        const title = `Doc comment on '${d.slug}': ${firstLine(c.body, 60) || "(empty comment)"}`;
        const description = [
          "## Linear doc comment → PM intake (mirror.pollComments, conventions §18)",
          "",
          `Mirrored doc: **${d.slug}** (kind \`${d.kind}\`, mirrored v${mirroredV})`,
          `Comment: ${c.url ?? `id ${c.id}`}${c.createdAt ? ` · ${c.createdAt}` : ""}`,
          "",
          ...c.body.split("\n").map((l) => `> ${l}`),
          "",
          "The mirror is ONE-WAY: respond by updating the hub doc / filing work — never by editing the Linear document body.",
        ].join("\n");
        let ticketId: string | undefined;
        if (!MIRROR_DRYRUN) {
          ticketId = fileIntake(db, projectId, actor, title, description, 0);
          ledger.acted[c.id] = { actedAt: nowIso(), ticketId };
          saveLedger(projectKey, ledger); // durable per-item (a crash mid-poll must not re-file the earlier intakes)
        }
        filed++; ops.push({ op: "comment-intake", slug: d.slug, commentId: c.id, ticketId, title });
      }
    } catch (e) {
      failed++;
      logEvent(db, { project_id: projectId, actor, kind: "mirror.error", data: { hubId: `doc:${d.slug}`, error: scrubErr((e as Error).message) } });
      continue; // comments unreadable ⇒ the content read would likely fail too; retry next poll
    }
    // (2) body-edit divergence: upstream is compared against the LAST-PUSHED body baseline
    // (last_pushed_body_hash, stamped at push time) — NOT the current hub projection — so a human edit is
    // caught even while a newer hub version awaits its push (that window is exactly when the next push
    // silently deletes the edit). Legacy rows without the baseline fall back to the fully-pushed guard.
    try {
      let baseline = d.last_pushed_body_hash;
      if (!baseline) {
        const title = mirrorDocTitle(projectKey, d), content = mirrorDocContent(d);
        if (d.last_pushed_hash !== mirrorDocHash(title, content)) continue; // legacy row + pending push: undecidable, skip
        baseline = bodyHash(content);
      }
      const upstream = await getDocumentContent(fetchImpl, token, d.linear_id);
      if (upstream === null || bodyHash(upstream) === baseline) continue; // normBody tolerates newline/edge-whitespace normalization only
      const upstreamHash = createHash("sha256").update(upstream).digest("hex");
      if (ledger.divergence[d.slug]?.hash === upstreamHash) continue; // ONE ticket per distinct divergence
      divergences++;
      const dTitle = `Linear-side edit detected on mirrored doc '${d.slug}'`;
      const dBody = [
        "## Mirrored-doc divergence → PM intake (mirror.pollComments, conventions §18)",
        "",
        `The Linear Document mirroring **${d.slug}** (kind \`${d.kind}\`, pushed v${d.last_pushed_version ?? d.version}) no longer matches the content the hub last pushed — someone edited the body in Linear.`,
        "",
        "The mirror is ONE-WAY: the next `mirror.push` will OVERWRITE that edit (the pinned banner says so).",
        "PM: recover any intended direction from the Linear document into the hub doc / tickets before it is overwritten — never write the Linear body back into the hub verbatim without review.",
      ].join("\n");
      let ticketId: string | undefined;
      if (!MIRROR_DRYRUN) {
        ticketId = fileIntake(db, projectId, actor, dTitle, dBody, 2); // High: the human edit is one push away from deletion
        ledger.divergence[d.slug] = { hash: upstreamHash, ticketId, filedAt: nowIso() };
        saveLedger(projectKey, ledger); // durable per-item, as the comment loop above
      }
      filed++; ops.push({ op: "edit-divergence", slug: d.slug, ticketId, title: dTitle });
    } catch (e) {
      failed++;
      logEvent(db, { project_id: projectId, actor, kind: "mirror.error", data: { hubId: `doc:${d.slug}`, error: scrubErr((e as Error).message) } });
    }
  }
  if (!MIRROR_DRYRUN) {
    ledger.lastPolledAt = nowIso();
    saveLedger(projectKey, ledger);
  }
  logEvent(db, { project_id: projectId, actor, kind: "mirror.pollComments", data: { docs: rows.length, comments, filed, divergences, alreadyActed, failed } });
  return { ok: true, data: { docs: rows.length, comments, filed, divergences, alreadyActed, failed, dryrun: MIRROR_DRYRUN, ...(MIRROR_DRYRUN ? { ops } : {}) } };
}
