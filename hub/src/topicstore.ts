// Shared discussion-board (P5/§25) store — the topic/post read+write logic + the two cooperative role
// gates, used by BOTH the MCP server (server.ts) and the read+write daemon op-API (agentops.ts, DL-64).
// SIDE-EFFECT-FREE (no env read, no transport, no top-level db) so either entrypoint can import it; identity
// (actor) and scope (projectId/projectKey) are passed in by the caller — exactly the docstore.ts precedent
// that lets the stdio server and the daemon op-API share ONE implementation and never drift.
//
// §17 firewall (structural): every write here is an INSERT/UPDATE on the `topics` / `posts` tables (a CHECKed
// `kind` enum {perspective,synthesis}, db.ts) — there is NO filesystem path anywhere in this module, so a
// board write can never target a SKILL / conventions / code file. A discussion DECISION (topic.close) is DATA,
// never an auto-applied change. The two role gates live here ONCE so the two callers can't diverge on them:
//   • chair-gate   = actor === topic.opened_by  (only the chair synthesizes/closes)
//   • invited-gate = actor ∈ topic.invited      (your-lane: post only AS yourself, once per round)
// Both are cooperative single-host attribution (§18 / HUB-ARCHITECTURE §16), not anti-spoof.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, logEvent, actorExists, listActorHandles } from "./db.ts";

export interface TopicRow {
  id: string; project_id: string; question: string; invited: string; status: string;
  round: number; round_opened_at: string; opened_by: string; opened_at: string;
  closed_at: string | null; decision: string | null;
}

// Discriminated result (mirrors docstore's DocResult): server.ts maps it to ok()/err(); the daemon op-API
// maps it to an HTTP status via statusForTopicErr — from ONE place, so the two callers can't drift.
export type TopicResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Map a topicstore error message (prose, not codes) to an HTTP status, mirroring statusForDocErr: the role
// gate → 403, a missing topic → 404, a state/dup conflict (closed / already posted / already synthesized /
// stale) → 409, else a create-precondition (an unknown invited handle) → 400.
export const statusForTopicErr = (msg: string): number =>
  msg.startsWith("FORBIDDEN") ? 403
    : /^no topic\b/.test(msg) ? 404
      : (msg.startsWith("CONFLICT") || /^already /.test(msg)) ? 409
        : 400;

const getTopic = (db: DatabaseSync, projectId: string, id: string): TopicRow | undefined =>
  db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(id, projectId) as TopicRow | undefined;

const pendingFor = (db: DatabaseSync, t: TopicRow): string[] => {
  const invited = JSON.parse(t.invited) as string[];
  const answered = new Set(
    (db.prepare("SELECT author FROM posts WHERE topic_id=? AND round=? AND kind='perspective'").all(t.id, t.round) as { author: string }[])
      .map((r) => r.author));
  return invited.filter((h) => !answered.has(h));
};

// ── reads (shaped HERE so server.ts and the op-API return byte-identical bodies — the parity tripwire) ──
// topic.list row: …invited, pending, youArePending (per-actor). topic.get adds posts and omits youArePending.
export function topicList(db: DatabaseSync, projectId: string, actor: string, status?: string): unknown[] {
  const rows = (status
    ? db.prepare("SELECT * FROM topics WHERE project_id=? AND status=? ORDER BY opened_at DESC").all(projectId, status)
    : db.prepare("SELECT * FROM topics WHERE project_id=? ORDER BY opened_at DESC").all(projectId)) as TopicRow[];
  return rows.map((t) => {
    const pending = t.status === "open" ? pendingFor(db, t) : [];
    return {
      id: t.id, question: t.question, status: t.status, round: t.round, round_opened_at: t.round_opened_at,
      opened_by: t.opened_by, opened_at: t.opened_at, closed_at: t.closed_at, decision: t.decision,
      invited: JSON.parse(t.invited) as string[], pending, youArePending: pending.includes(actor),
    };
  });
}

export function topicGet(db: DatabaseSync, projectId: string, projectKey: string, id: string): TopicResult<unknown> {
  const t = getTopic(db, projectId, id);
  if (!t) return { ok: false, error: `no topic ${id} in ${projectKey}` };
  const posts = db.prepare("SELECT round,author,kind,body,created_at FROM posts WHERE topic_id=? ORDER BY round, created_at").all(id);
  return { ok: true, data: {
    id: t.id, question: t.question, status: t.status, round: t.round, round_opened_at: t.round_opened_at,
    opened_by: t.opened_by, opened_at: t.opened_at, closed_at: t.closed_at, decision: t.decision,
    invited: JSON.parse(t.invited) as string[], pending: t.status === "open" ? pendingFor(db, t) : [], posts,
  } };
}

// ── writes (the chair/invited gates + the per-round append rules live here; mirror server.ts verbatim) ──
export interface TopicOpenArgs { question: string; invited: string[] }
export function topicOpen(db: DatabaseSync, projectId: string, actor: string, a: TopicOpenArgs): TopicResult<{ id: string; question: string; invited: string[]; status: string; round: number; opened_by: string }> {
  const bad = a.invited.filter((h) => !actorExists(db, h));
  if (bad.length) return { ok: false, error: `unknown invited actor(s): ${bad.join(", ")} — valid: ${listActorHandles(db).join(", ")}` };
  const id = randomUUID();
  const t = nowIso();
  db.prepare("INSERT INTO topics(id,project_id,question,invited,status,round,round_opened_at,opened_by,opened_at) VALUES (?,?,?,?,'open',1,?,?,?)")
    .run(id, projectId, a.question, JSON.stringify([...new Set(a.invited)]), t, actor, t);
  logEvent(db, { project_id: projectId, actor, kind: "topic.open", data: { id, invited: a.invited } });
  return { ok: true, data: { id, question: a.question, invited: [...new Set(a.invited)], status: "open", round: 1, opened_by: actor } };
}

export interface PostAddArgs { topicId: string; body: string }
export function postAdd(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: PostAddArgs): TopicResult<{ topicId: string; round: number; author: string; kind: string; created_at: string }> {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE"); // read round+status then insert atomically vs a concurrent synthesize round-bump (§7)
  try {
    const t = db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(a.topicId, projectId) as TopicRow | undefined;
    if (!t) { db.exec("ROLLBACK"); return { ok: false, error: `no topic ${a.topicId} in ${projectKey}` }; }
    if (t.status !== "open") { db.exec("ROLLBACK"); return { ok: false, error: `CONFLICT: topic ${a.topicId} is closed` }; }
    if (!(JSON.parse(t.invited) as string[]).includes(actor)) { db.exec("ROLLBACK"); return { ok: false, error: `FORBIDDEN: '${actor}' is not invited to topic ${a.topicId}` }; }
    const dup = db.prepare("SELECT 1 FROM posts WHERE topic_id=? AND round=? AND author=? AND kind='perspective'").get(a.topicId, t.round, actor);
    if (dup) { db.exec("ROLLBACK"); return { ok: false, error: `already posted in round ${t.round} — append-only, one perspective per round` }; }
    db.prepare("INSERT INTO posts(id,topic_id,round,author,kind,body,created_at) VALUES (?,?,?,?,'perspective',?,?)")
      .run(randomUUID(), a.topicId, t.round, actor, a.body, ts);
    logEvent(db, { project_id: projectId, actor, kind: "post.add", data: { topicId: a.topicId, round: t.round } });
    db.exec("COMMIT");
    return { ok: true, data: { topicId: a.topicId, round: t.round, author: actor, kind: "perspective", created_at: ts } };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
}

export interface TopicSynthesizeArgs { topicId: string; body: string; nextRound?: boolean }
export function topicSynthesize(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: TopicSynthesizeArgs): TopicResult<{ topicId: string; synthesizedRound: number; round: number; status: string }> {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const t = db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(a.topicId, projectId) as TopicRow | undefined;
    if (!t) { db.exec("ROLLBACK"); return { ok: false, error: `no topic ${a.topicId} in ${projectKey}` }; }
    if (t.status !== "open") { db.exec("ROLLBACK"); return { ok: false, error: `CONFLICT: topic ${a.topicId} is closed` }; }
    if (t.opened_by !== actor) { db.exec("ROLLBACK"); return { ok: false, error: `FORBIDDEN: only the chair '${t.opened_by}' may synthesize topic ${a.topicId}` }; }
    // pre-check the once-per-round synthesis (Codex review): a clean CONFLICT, not a raw UNIQUE error
    const dupSyn = db.prepare("SELECT 1 FROM posts WHERE topic_id=? AND round=? AND author=? AND kind='synthesis'").get(a.topicId, t.round, actor);
    if (dupSyn) { db.exec("ROLLBACK"); return { ok: false, error: `CONFLICT: already synthesized round ${t.round} — bump with nextRound:true or close` }; }
    db.prepare("INSERT INTO posts(id,topic_id,round,author,kind,body,created_at) VALUES (?,?,?,?,'synthesis',?,?)")
      .run(randomUUID(), a.topicId, t.round, actor, a.body, ts);
    let round = t.round;
    if (a.nextRound) { round = t.round + 1; db.prepare("UPDATE topics SET round=?, round_opened_at=? WHERE id=?").run(round, ts, t.id); }
    logEvent(db, { project_id: projectId, actor, kind: "topic.synthesize", data: { topicId: a.topicId, round: t.round, nextRound: !!a.nextRound } });
    db.exec("COMMIT");
    return { ok: true, data: { topicId: a.topicId, synthesizedRound: t.round, round, status: "open" } };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
}

export interface TopicCloseArgs { topicId: string; decision: string }
export function topicClose(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: TopicCloseArgs): TopicResult<{ topicId: string; status: string; decision: string; closed_at: string }> {
  const ts = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const t = db.prepare("SELECT * FROM topics WHERE id=? AND project_id=?").get(a.topicId, projectId) as TopicRow | undefined;
    if (!t) { db.exec("ROLLBACK"); return { ok: false, error: `no topic ${a.topicId} in ${projectKey}` }; }
    if (t.status !== "open") { db.exec("ROLLBACK"); return { ok: false, error: `CONFLICT: topic ${a.topicId} is already closed` }; }
    if (t.opened_by !== actor) { db.exec("ROLLBACK"); return { ok: false, error: `FORBIDDEN: only the chair '${t.opened_by}' may close topic ${a.topicId}` }; }
    db.prepare("UPDATE topics SET status='closed', decision=?, closed_at=? WHERE id=?").run(a.decision, ts, t.id);
    logEvent(db, { project_id: projectId, actor, kind: "topic.close", data: { topicId: a.topicId, round: t.round } });
    db.exec("COMMIT");
    return { ok: true, data: { topicId: a.topicId, status: "closed", decision: a.decision, closed_at: ts } };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
}
