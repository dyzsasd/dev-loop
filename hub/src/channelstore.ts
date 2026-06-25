// Shared P6 IM-channel store (DL-67) — the channel register/send/poll/ack/status HANDLER logic + the DL-4
// roadmap-over-chat bridge, used by BOTH the MCP server (server.ts) and the daemon op-API (agentops.ts). The
// provider TRANSPORT (send/poll/cred-resolution/gating/scrub) stays in channel.ts and is reused AS-IS; this
// module is the handler layer channel.ts's transport serves — the docstore.ts/topicstore.ts precedent that
// lets the stdio server and the daemon op-API share ONE implementation and never drift.
//
// SIDE-EFFECT-FREE entrypoint (no top-level db; identity (actor) + scope (projectId/projectKey) are passed in
// by the caller — the daemon resolves the actor from X-Devloop-Actor, the stdio server passes its ACTOR — so
// every channel event is attributed to the REAL caller on both paths, exactly the topicstore precedent). The
// only module state is the per-process send throttle (below), the same loop-safety cap server.ts held before.
//
// §16: secrets are read by channel.ts from env NAMES (config_ref/secret_ref) SERVER-SIDE; this module NEVER
// stores/returns/logs a token (a failed send throws the scrubbed status, never the URL/secret — DL-52). §17
// firewall (structural): every write here is an INSERT/UPDATE on the `channels` / `channel_messages` DB tables
// — there is NO filesystem path anywhere in this module, so a channel op can never target a SKILL/conventions/
// code file; the only external effect is the network send via channel.ts's transport. The DL-4 bridge lands an
// operator chat edit as a roadmap DRAFT only — the operator-publish gate (docstore) is never bypassed, so an
// injected edit can never go live.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, logEvent } from "./db.ts";
import { sendVia, pollVia, getEnabledChannel, resolveCreds, scrubErr, cleanLine,
  CHANNEL_DRYRUN, CHANNEL_SEND_CAP, type Provider, type OutboundMsg, type InboundMsg, type ChannelRow } from "./channel.ts";
import { resolveDoc, latestVersion, docSave } from "./docstore.ts";

// Discriminated result (mirrors docstore's DocResult / topicstore's TopicResult): server.ts maps it to
// ok()/err(); the daemon op-API maps it to an HTTP status via statusForChannelErr — from ONE place, no drift.
export type ChannelResult<T> = { ok: true; data: T } | { ok: false; error: string };
// Map a channelstore error to an HTTP status: a missing inbound message (ack) → 404; everything else
// (no-channel-register-first / reply-needs-text / send-cap / send|poll failed / a non-env-NAME *Ref) → 400.
// (No 403/409 here: the op-API's origin/actor/mode gates are upstream in the daemon, and channel has no CAS.)
export const statusForChannelErr = (msg: string): number => /^no inbound message\b/.test(msg) ? 404 : 400;

// §16 (Codex review): a *Ref is an ENV-VAR NAME, never a literal secret — reject anything that isn't an
// env-name shape, and anything that looks like an actual token, so a caller can't persist a secret to the DB.
// Exported because the P7 mirror's tokenEnv check (server.ts) reuses the SAME validator — one definition, no drift.
const TOKEN_PREFIXES = /^(xox[abp]-|lin_api_|lin_oauth_|sk-|ghp_|Bearer\s)/i;
export const isEnvName = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !TOKEN_PREFIXES.test(s) && s.length <= 100;

// strip control chars + truncate — channel.ts's cleanLine IS server.ts's old local `clean` (byte-identical)
const clean = cleanLine;
const INBOX_GC_DAYS = 14;
// per-process send throttle (was server.ts's `channelSendsThisProcess`): module-scope here so the stdio server
// AND the daemon op-API each keep their OWN per-process cap — identical loop-safety semantics on both paths.
let sendsThisProcess = 0;

// ── channel.register ────────────────────────────────────────────────────────────
export interface ChannelRegisterArgs { provider: "slack" | "lark"; configRef: string; secretRef?: string; channelRef: string }
export function channelRegister(db: DatabaseSync, projectId: string, actor: string, a: ChannelRegisterArgs): ChannelResult<{ id: string; provider: string; channelRef: string; updated?: boolean }> {
  if (!isEnvName(a.configRef)) return { ok: false, error: `configRef must be an ENV-VAR NAME (e.g. DEVLOOP_CHANNEL_TOKEN), not the secret value itself` };
  if (a.secretRef && !isEnvName(a.secretRef)) return { ok: false, error: `secretRef must be an ENV-VAR NAME, not the secret value itself` };
  const t = nowIso();
  const existing = db.prepare("SELECT id FROM channels WHERE project_id=? AND provider=? AND channel_ref=?").get(projectId, a.provider, a.channelRef) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE channels SET config_ref=?, secret_ref=?, enabled=1, updated_at=? WHERE id=?").run(a.configRef, a.secretRef ?? null, t, existing.id);
    logEvent(db, { project_id: projectId, actor, kind: "channel.register", data: { provider: a.provider, channelRef: a.channelRef, updated: true } });
    return { ok: true, data: { id: existing.id, provider: a.provider, channelRef: a.channelRef, updated: true } };
  }
  const id = randomUUID();
  db.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)")
    .run(id, projectId, a.provider, a.configRef, a.secretRef ?? null, a.channelRef, t, t);
  logEvent(db, { project_id: projectId, actor, kind: "channel.register", data: { provider: a.provider, channelRef: a.channelRef } });
  return { ok: true, data: { id, provider: a.provider, channelRef: a.channelRef } };
}

// ── channel.send — build the §16 allow-listed lines, then send (or DRYRUN: build, no network) ─────────────
export interface ChannelSendArgs {
  kind: "notify" | "digest" | "reply";
  ticketId?: string;
  bailShape?: "info-needed" | "decision-needed" | "scope-design" | "external-prereq" | "fix-exhausted";
  digest?: { topicsChaired?: number; decisionsClosed?: number; roadmapDraftVersion?: number | null; openProposals?: string[]; throughput?: { done?: number; inReview?: number; todo?: number }; headline?: string };
  replyTo?: string;
  text?: string;
}
export async function channelSend(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: ChannelSendArgs): Promise<ChannelResult<unknown>> {
  const ch = getEnabledChannel(db, projectId);
  if (!ch) return { ok: false, error: `no enabled channel for ${projectKey} — channel.register first` };
  const lines: string[] = [];
  if (a.kind === "notify") {
    const tk = a.ticketId ? (db.prepare("SELECT title FROM tickets WHERE id=? AND project_id=?").get(a.ticketId, projectId) as { title: string } | undefined) : undefined;
    const title = tk ? clean(tk.title, 80) : a.ticketId ? `(unknown ${a.ticketId})` : "(no ticket)";
    lines.push(`[${projectKey}] ${a.bailShape ?? "blocked"}: ${a.ticketId ?? "—"} ${title}`);
  } else if (a.kind === "digest") {
    const d = a.digest ?? {};
    lines.push(`[${projectKey}] dev-loop digest`);
    if (d.headline) lines.push(clean(d.headline, 200));
    lines.push(`topics chaired ${d.topicsChaired ?? 0} · decisions ${d.decisionsClosed ?? 0} · roadmap draft v${d.roadmapDraftVersion ?? "—"}`);
    if (d.throughput) lines.push(`tickets: done ${d.throughput.done ?? 0} · in-review ${d.throughput.inReview ?? 0} · todo ${d.throughput.todo ?? 0}`);
    if (d.openProposals?.length) lines.push(`open proposals: ${d.openProposals.slice(0, 20).map((p) => clean(p, 24)).join(", ")}`);
  } else {
    if (!a.text) return { ok: false, error: "reply requires text" };
    lines.push(clean(a.text, 800));
  }
  const msg: OutboundMsg = { kind: a.kind, lines };
  if (CHANNEL_DRYRUN) {
    logEvent(db, { project_id: projectId, actor, kind: "channel.send", data: { kind: a.kind, dryrun: true } });
    return { ok: true, data: { ok: true, dryrun: true, provider: ch.provider, kind: a.kind, lines } };
  }
  if (sendsThisProcess >= CHANNEL_SEND_CAP) return { ok: false, error: `channel send cap (${CHANNEL_SEND_CAP}/process) reached — loop-safety throttle` };
  sendsThisProcess++;
  try {
    await sendVia(ch.provider as Provider, resolveCreds(ch), ch.channel_ref, msg, fetch);
  } catch (e) {
    return { ok: false, error: `channel send failed: ${scrubErr((e as Error).message)}` }; // secret-free by construction (channel.ts) + scrubbed
  }
  const t = nowIso();
  db.prepare("INSERT INTO channel_messages(id,channel_id,project_id,direction,provider_msg_id,body,kind,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), ch.id, projectId, "outbound", null, lines.join(" | ").slice(0, 500), a.kind, t);
  logEvent(db, { project_id: projectId, actor, kind: "channel.send", data: { kind: a.kind } });
  return { ok: true, data: { ok: true, provider: ch.provider, kind: a.kind } };
}

// ── DL-4: roadmap-over-chat bridge (handled INSIDE channelPoll) — moved verbatim from server.ts ────────────
// Recognize an operator roadmap command in an inbound message: a bare `roadmap` (summary) or `roadmap edit
// <text>` (an edit). null ⇒ a normal message → the Director's inbox. There is deliberately NO publish command
// — publishing stays the operator-actor doc.publish gate (DL-3/§25), so a chat message can never push the
// roadmap live; an edit only ever lands as a DRAFT. A bare `roadmap: <musing>` is NOT captured as an edit.
function parseRoadmapCommand(text: string): { type: "summary" } | { type: "edit"; body: string } | null {
  const t = text.trim();
  const m = t.match(/^\/?roadmap\s+edit\s+([\s\S]+)$/i);
  if (m) { const body = m[1].trim(); if (body) return { type: "edit", body }; }
  if (/^\/?roadmap(?:\s+(?:show|view|status))?\??$/i.test(t)) return { type: "summary" };
  return null;
}
// Scrub channel-originated content before it lands in a doc or an outbound summary (§16/AC4 — no secrets or
// PII pasted from chat). Broadened past the loop's own creds to common third-party secret shapes + PII; secret
// shapes never occur in real roadmap prose so aggressive is safe, the operator reviews the DRAFT before
// publishing, so light over-redaction is acceptable. No truncation here — the caller bounds length (DL-4).
const scrubChannel = (s: string): string => s
  .replace(/\b(xox[abprs]-[\w-]+|xapp-[\w-]+|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|gh[opusr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9-]+|[sr]k_(?:live|test)_[A-Za-z0-9]+|lin_(?:api|oauth)_[\w-]+|eyJ[\w.-]{20,})\b/g, "***") // API tokens/keys
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "***")                              // email
  .replace(/\b\+?\d{1,4}[ .-]\(?\d{2,4}\)?[ .-]\d{3,4}(?:[ .-]\d{2,4})?\b/g, "***") // phone (multi-segment, avoids plain numbers)
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "***")                           // IPv4
  .replace(/(?:\d[ -]?){13,19}/g, (m) => m.replace(/\D/g, "").length >= 13 ? "***" : m); // card-shaped digit run
// A §16-safe one-shot summary of the current kind:"roadmap" doc for the channel (DL-4 AC1): title, status,
// versions, and a bounded, scrubbed excerpt — never a secret/PII, never the full history.
function roadmapSummaryLines(db: DatabaseSync, projectId: string, projectKey: string): string[] {
  const d = resolveDoc(db, projectId, undefined, "roadmap");
  if (!d) return [`[${projectKey}] roadmap — no roadmap document yet`];
  const latest = latestVersion(db, d.id), published = d.current_version;
  const head = `[${projectKey}] roadmap "${clean(d.title, 80)}" — ${published > 0 ? `published v${published}` : "unpublished"}${latest > published ? `, latest draft v${latest}` : ""}`;
  const v = latest > 0 ? (db.prepare("SELECT body FROM document_versions WHERE doc_id=? AND version=?").get(d.id, latest) as { body: string } | undefined) : undefined;
  return [head, v?.body ? scrubChannel(clean(v.body, 600)) : "(empty)"];
}
// Send pre-built lines to the channel as a reply (the roadmap auto-reply). Respects CHANNEL_DRYRUN (log, no
// network) + the per-process send cap; the token never crosses this boundary.
async function sendChannelLines(db: DatabaseSync, projectId: string, actor: string, ch: ChannelRow, lines: string[]): Promise<void> {
  if (CHANNEL_DRYRUN) { logEvent(db, { project_id: projectId, actor, kind: "channel.send", data: { kind: "reply", dryrun: true } }); return; }
  if (sendsThisProcess >= CHANNEL_SEND_CAP) return;
  sendsThisProcess++;
  await sendVia(ch.provider as Provider, resolveCreds(ch), ch.channel_ref, { kind: "reply", lines }, fetch);
  db.prepare("INSERT INTO channel_messages(id,channel_id,project_id,direction,provider_msg_id,body,kind,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(randomUUID(), ch.id, projectId, "outbound", null, lines.join(" | ").slice(0, 500), "reply", nowIso());
  logEvent(db, { project_id: projectId, actor, kind: "channel.send", data: { kind: "reply" } });
}

// ── channel.poll — TWO-PHASE (fetch lock-free → atomic dedup-insert+cursor advance) + the DL-4 bridge ─────
export async function channelPoll(db: DatabaseSync, projectId: string, projectKey: string, actor: string): Promise<ChannelResult<unknown>> {
  const ch = getEnabledChannel(db, projectId);
  if (!ch) return { ok: false, error: `no enabled channel for ${projectKey} — channel.register first` };
  const cursor = ch.inbound_cursor; // PHASE 1 — lock-free read
  // PHASE 2 — fetch OUTSIDE any lock (network I/O must never be held under busy_timeout)
  let fetched: { messages: InboundMsg[]; cursor: string | null };
  try {
    if (CHANNEL_DRYRUN) {
      const fixture = JSON.parse(process.env.DEVLOOP_CHANNEL_FIXTURE ?? "[]") as InboundMsg[];
      const fresh = fixture.filter((m) => cursor === null || m.providerTs > cursor);
      const next = fresh.reduce<string | null>((acc, m) => (acc === null || m.providerTs > acc ? m.providerTs : acc), cursor);
      fetched = { messages: fresh, cursor: next };
    } else {
      fetched = await pollVia(ch.provider as Provider, resolveCreds(ch), ch.channel_ref, cursor, fetch);
    }
  } catch (e) {
    return { ok: false, error: `channel poll failed: ${scrubErr((e as Error).message)}` }; // cursor unchanged → next fire retries
  }
  const t = nowIso();
  db.exec("BEGIN IMMEDIATE"); // PHASE 3 — atomic dedup-insert + cursor advance
  try {
    // ON CONFLICT DO NOTHING: suppress ONLY the dedup-key conflict — any OTHER constraint failure must throw → ROLLBACK → cursor NOT advanced.
    const ins = db.prepare("INSERT INTO channel_messages(id,channel_id,project_id,direction,provider_msg_id,author_ref,body,acted,created_at,provider_ts) VALUES (?,?,?,?,?,?,?,0,?,?) ON CONFLICT(channel_id,direction,provider_msg_id) DO NOTHING");
    let inserted = 0;
    for (const m of fetched.messages) {
      const r = ins.run(randomUUID(), ch.id, projectId, "inbound", m.providerMsgId, m.authorRef, m.text, t, m.providerTs);
      if (r.changes > 0) inserted++;
    }
    if (fetched.cursor !== null) db.prepare("UPDATE channels SET inbound_cursor=?, last_poll_at=? WHERE id=?").run(fetched.cursor, t, ch.id);
    else db.prepare("UPDATE channels SET last_poll_at=? WHERE id=?").run(t, ch.id);
    db.prepare("DELETE FROM channel_messages WHERE project_id=? AND direction='inbound' AND acted=1 AND created_at < ?")
      .run(projectId, new Date(Date.now() - INBOX_GC_DAYS * 86400000).toISOString());
    logEvent(db, { project_id: projectId, actor, kind: "channel.poll", data: { new: inserted } });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }

  // ── DL-4: auto-handle roadmap commands among the now-ingested inbox — a §16-safe summary reply, or a
  //    roadmap DRAFT via doc.save (NEVER published). Run OUTSIDE the poll txn (docSave has its own; sendVia
  //    is network). Handled messages are ack'd so they never reach the Director's `pending`; non-roadmap
  //    messages flow through unchanged. A chat author is UNVERIFIED, but a draft is non-live + reversible
  //    (§16/§25) — only the operator can publish it, so an injected edit can never go live.
  const roadmapHandled: { messageId: string; type: "summary" | "edit"; result: string; lines: string[] }[] = [];
  for (const msg of db.prepare("SELECT id,body FROM channel_messages WHERE project_id=? AND direction='inbound' AND acted=0 ORDER BY provider_ts").all(projectId) as { id: string; body: string }[]) {
    const cmd = parseRoadmapCommand(msg.body);
    if (!cmd) continue;
    // ATOMIC CLAIM (cross-process safety §7/§18/§26): flip acted 0→1 in one statement, proceed ONLY if we won
    // it, so a second overlapping poll (another Director fire / a 2nd CLI) can't double-process the command.
    if (db.prepare("UPDATE channel_messages SET acted=1, acted_into='roadmap:handling' WHERE id=? AND project_id=? AND direction='inbound' AND acted=0").run(msg.id, projectId).changes === 0) continue;
    let lines: string[], actedInto: string, result: string;
    if (cmd.type === "summary") {
      lines = roadmapSummaryLines(db, projectId, projectKey); actedInto = "roadmap:summary"; result = "summary";
    } else {
      const existing = resolveDoc(db, projectId, undefined, "roadmap");
      const r = docSave(db, projectId, actor, { slug: existing?.slug ?? "roadmap", kind: "roadmap", body: scrubChannel(cmd.body).slice(0, 8000), baseVersion: existing ? latestVersion(db, existing.id) : 0, summary: "via channel" });
      if (r.ok) { lines = [`[${projectKey}] roadmap draft v${r.data.version} saved from chat — awaiting operator publish`]; actedInto = `roadmap:draft:v${r.data.version}`; result = `draft v${r.data.version}`; }
      else { lines = [`[${projectKey}] roadmap edit not applied — ${clean(r.error, 160)}`]; actedInto = "roadmap:edit-rejected"; result = "rejected"; }
    }
    try { await sendChannelLines(db, projectId, actor, ch, lines); } catch { /* a failed reply must not wedge the poll or undo a persisted draft */ }
    db.prepare("UPDATE channel_messages SET acted_into=? WHERE id=? AND project_id=?").run(actedInto, msg.id, projectId);
    roadmapHandled.push({ messageId: msg.id, type: cmd.type, result, lines });
  }

  const pending = db.prepare("SELECT id,author_ref,body,provider_ts FROM channel_messages WHERE project_id=? AND direction='inbound' AND acted=0 ORDER BY provider_ts")
    .all(projectId) as { id: string; author_ref: string; body: string; provider_ts: string }[];
  return { ok: true, data: { new: fetched.messages.length, cursor: fetched.cursor, roadmapHandled, pending: pending.map((p) => ({ messageId: p.id, author: p.author_ref, text: p.body, ts: p.provider_ts })) } };
}

// ── channel.ack ──────────────────────────────────────────────────────────────────
export interface ChannelAckArgs { messageId: string; actedInto?: string }
export function channelAck(db: DatabaseSync, projectId: string, projectKey: string, actor: string, a: ChannelAckArgs): ChannelResult<{ messageId: string; acted: boolean; actedInto: string | null }> {
  const r = db.prepare("UPDATE channel_messages SET acted=1, acted_into=? WHERE id=? AND project_id=? AND direction='inbound'")
    .run(a.actedInto ?? null, a.messageId, projectId);
  if (r.changes === 0) return { ok: false, error: `no inbound message ${a.messageId} in ${projectKey}` };
  logEvent(db, { project_id: projectId, actor, kind: "channel.ack", data: { messageId: a.messageId, actedInto: a.actedInto ?? null } });
  return { ok: true, data: { messageId: a.messageId, acted: true, actedInto: a.actedInto ?? null } };
}

// ── channel.status (read; never origin/actor-gated — parity with the read ticket/doc/topic ops) ──────────
// Returns the ENV-VAR NAMES' SET-or-not as booleans, NEVER the secret values (§16).
export function channelStatus(db: DatabaseSync, projectId: string): unknown {
  const ch = getEnabledChannel(db, projectId);
  if (!ch) return { configured: false };
  const pending = (db.prepare("SELECT count(*) c FROM channel_messages WHERE project_id=? AND direction='inbound' AND acted=0").get(projectId) as { c: number }).c;
  return {
    configured: true, provider: ch.provider, channelRef: ch.channel_ref, cursor: ch.inbound_cursor, lastPoll: ch.last_poll_at,
    configRefSet: process.env[ch.config_ref] !== undefined, secretRefSet: ch.secret_ref ? process.env[ch.secret_ref] !== undefined : null,
    inboxPending: pending,
  };
}
