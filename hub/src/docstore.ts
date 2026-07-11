// Shared document store — the CAS + operator-publish invariants for hub product-docs, used by BOTH
// the MCP server (server.ts) and the read+write daemon (daemon.ts, DL-3). It is SIDE-EFFECT-FREE
// (no env read, no transport, no top-level db) so either entrypoint can import it; identity (actor)
// and scope (projectId) are passed in by the caller.
//
// §17 firewall (structural): every write in this module is an INSERT/UPDATE on the `documents` /
// `document_versions` tables keyed by a `kind` ∈ DOC_KINDS — there is NO filesystem path anywhere in
// here, so a doc write can never target a SKILL / conventions / code file. The operator-publish gate
// lives here ONCE (docPublish), so the MCP server and the daemon can never drift on who may publish.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso, logEvent } from "./db.ts";

// DL split: `design` is the senior-dev's living per-module design tier (one doc per module slug).
// Two departures from the singleton kinds (handled in db.ts v3 + the read path): (1) MULTI-INSTANCE —
// the UNIQUE(project_id, kind) constraint is relaxed for `design` so many design rows coexist by slug;
// (2) NOT operator-publish-gated — a design draft IS the live design, so design-reads return the LATEST
// version (no `current` publish). docPublish's operator gate for strategy/roadmap is unchanged.
export const DOC_KINDS = ["strategy", "roadmap", "decisions", "notes", "design"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export interface DocRow {
  id: string; project_id: string; kind: string; slug: string; title: string;
  status: string; current_version: number; created_by: string; created_at: string; updated_at: string;
}

// A discriminated result so callers map it to their own surface: server.ts → ok()/err(); the daemon →
// an HTTP status. `error` carries the same human message the MCP `err()` used (CONFLICT / FORBIDDEN / …).
// A CAS CONFLICT additionally carries `conflict` — machine-readable retry data. This exists because
// doc.get's DEFAULT read returns the PUBLISHED version while the CAS keys on the LATEST (drafts included):
// a caller that re-read the default could never converge once a draft existed past the published version.
// `latestVersion` is exactly what the retry's baseVersion must be (read the body via doc.get version:"latest").
export type DocConflict = { latestVersion: number; latestAuthor: string | null; hint: string };
export type DocResult<T> = { ok: true; data: T } | { ok: false; error: string; conflict?: DocConflict };

// Map a docstore error message (the store returns prose, not codes) to the right HTTP status, so EVERY
// caller that surfaces a DocResult over HTTP — the DL-3 roadmap write routes AND the DL-43/DL-62 agent
// op-API — maps it IDENTICALLY from this one place (no drift): the operator gate → 403, a missing
// doc/version → 404, the create-precondition → 400, else a genuine CAS / kind-immutability conflict → 409.
export const statusForDocErr = (msg: string): number =>
  msg.startsWith("FORBIDDEN") ? 403
    : /^no (document|version)\b/.test(msg) ? 404
      : msg.includes("baseVersion must be 0") ? 400
        : 409;

export const resolveDoc = (db: DatabaseSync, projectId: string, slug?: string, kind?: string): DocRow | undefined =>
  slug ? db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, slug) as DocRow | undefined
       : kind ? db.prepare("SELECT * FROM documents WHERE project_id=? AND kind=?").get(projectId, kind) as DocRow | undefined
              : undefined;

export const latestVersion = (db: DatabaseSync, docId: string): number =>
  (db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(docId) as { v: number | null }).v ?? 0;

export interface DocSaveArgs { slug: string; kind: DocKind; title?: string; body: string; baseVersion: number; summary?: string; }

// Create (baseVersion 0) or append a new DRAFT version. Optimistic CAS: baseVersion MUST equal the
// doc's latest version, else CONFLICT (never last-write-wins) carrying the DocConflict retry data.
// NEVER publishes. The DL-9 kind-immutability guard and DL-6 actor semantics are preserved verbatim
// from the original MCP handler.
export function docSave(db: DatabaseSync, projectId: string, actor: string, a: DocSaveArgs): DocResult<{ doc: string; kind: string; version: number; status: string }> {
  const t = nowIso();
  db.exec("BEGIN IMMEDIATE"); // RESERVED lock before the read → cross-process CAS is atomic (§7)
  try {
    const d = db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, a.slug) as DocRow | undefined;
    if (!d) {
      if (a.baseVersion !== 0) { db.exec("ROLLBACK"); return { ok: false, error: `baseVersion must be 0 to create a new doc '${a.slug}'` }; }
      const id = randomUUID();
      db.prepare("INSERT INTO documents(id,project_id,kind,slug,title,status,current_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'draft',0,?,?,?)").run(id, projectId, a.kind, a.slug, a.title ?? a.slug, actor, t, t);
      db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES (?,?,1,?,'draft',?,0,?,?)").run(randomUUID(), id, a.body, a.summary ?? "", actor, t);
      logEvent(db, { project_id: projectId, actor, kind: "doc.save", data: { slug: a.slug, version: 1, base: 0 } });
      db.exec("COMMIT");
      return { ok: true, data: { doc: a.slug, kind: a.kind, version: 1, status: "draft" } };
    }
    // A document's kind is immutable identity: a save whose kind contradicts the stored doc at this
    // slug is targeting the WRONG document, so refuse it (DL-9) instead of silently appending into /
    // clobbering the existing doc. Checked BEFORE the CAS — a baseVersion comparison against the
    // wrong doc is meaningless. (Keeps slug effectively unique per project: two kinds can never
    // share a slug, so resolveDoc-by-slug stays correct.)
    if (a.kind !== d.kind) { db.exec("ROLLBACK"); return { ok: false, error: `CONFLICT: slug '${a.slug}' is a '${d.kind}' document — refusing a '${a.kind}' save (a document's kind is immutable; use a distinct slug)` }; }
    const latest = latestVersion(db, d.id);
    if (a.baseVersion !== latest) {
      const latestAuthor = (db.prepare("SELECT author FROM document_versions WHERE doc_id=? AND version=?").get(d.id, latest) as { author: string } | undefined)?.author ?? null;
      db.exec("ROLLBACK");
      return { ok: false, error: `CONFLICT: '${a.slug}' is at version ${latest}, your baseVersion ${a.baseVersion} is stale — re-read the latest draft (doc.get version:"latest"), re-apply your change, and re-save with baseVersion ${latest}`,
        conflict: { latestVersion: latest, latestAuthor, hint: `doc.get { slug:"${a.slug}", version:"latest" }, re-apply your change, then doc.save with baseVersion ${latest}` } };
    }
    const nv = latest + 1;
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,status,summary,base_version,author,created_at) VALUES (?,?,?,?,'draft',?,?,?,?)").run(randomUUID(), d.id, nv, a.body, a.summary ?? "", a.baseVersion, actor, t);
    db.prepare("UPDATE documents SET title=?, updated_at=? WHERE id=?").run(a.title ?? d.title, t, d.id);
    logEvent(db, { project_id: projectId, actor, kind: "doc.save", data: { slug: a.slug, version: nv, base: a.baseVersion } });
    db.exec("COMMIT");
    return { ok: true, data: { doc: a.slug, kind: d.kind, version: nv, status: "draft" } };
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
}

export interface DocPublishArgs { slug?: string; kind?: string; version: number; }

// OPERATOR-ONLY: publish a draft version → current (the live doc). Cooperative role-gate
// (actor === "operator"), not anti-spoof — see §18 / HUB-ARCHITECTURE §16. This single gate is the
// human-authorization point of the §17 firewall, so it lives in exactly one place.
export function docPublish(db: DatabaseSync, projectId: string, actor: string, a: DocPublishArgs): DocResult<{ doc: string; status: string; current_version: number }> {
  if (actor !== "operator") return { ok: false, error: "FORBIDDEN: only the operator may publish a doc draft→current" };
  const d = resolveDoc(db, projectId, a.slug, a.kind);
  if (!d) return { ok: false, error: `no document ${a.slug ?? a.kind}` };
  const v = db.prepare("SELECT version FROM document_versions WHERE doc_id=? AND version=?").get(d.id, a.version);
  if (!v) return { ok: false, error: `no version ${a.version} of ${d.slug} to publish` };
  const t = nowIso();
  // single-current invariant (Codex review): publishing vN after vM must leave EXACTLY one version
  // row marked 'current' — reset all to draft, then mark the chosen one, atomically.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE document_versions SET status='draft' WHERE doc_id=? AND status='current'").run(d.id);
    db.prepare("UPDATE document_versions SET status='current' WHERE doc_id=? AND version=?").run(d.id, a.version);
    db.prepare("UPDATE documents SET status='current', current_version=?, updated_at=? WHERE id=?").run(a.version, t, d.id);
    logEvent(db, { project_id: projectId, actor, kind: "doc.publish", data: { slug: d.slug, version: a.version } });
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
  return { ok: true, data: { doc: d.slug, status: "current", current_version: a.version } };
}
