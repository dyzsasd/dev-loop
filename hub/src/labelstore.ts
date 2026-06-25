// Shared label/project metadata store (DL-68) — the trivial "label/project ops" the MCP server (server.ts)
// and the daemon op-API (agentops.ts) both serve: list_issue_labels / create_issue_label / get_project. These
// are thin project-scoped DB reads + one guarded insert, so this module is small — but it is the SINGLE shared
// source for `create_issue_label`'s LABEL_KINDS + empty-name reject (the DL-22 regression class: a bad kind
// silently dropping the row while returning ok{}), and for the read SELECTs (so the two paths can't drift on a
// column list / order → the differential-parity AC). The docstore/topicstore/channelstore precedent: one impl,
// no drift. §17 firewall (structural): every write is an INSERT on the `labels` DB table — no filesystem path,
// no external effect; a label can never name a SKILL/conventions/code file.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// The kinds the labels.kind CHECK constraint allows (db.ts). Validated UP FRONT so INSERT OR IGNORE can only
// ever ignore a genuine duplicate name — never silently swallow a CHECK(kind) violation and then masquerade as
// success (DL-22). The SINGLE shared source: server.ts + the op-API both import this, so they can't drift.
export const LABEL_KINDS = ["marker", "type", "owner", "subtype", "workflow", "repo"] as const;

// Discriminated result (mirrors the other stores). create_issue_label's only error class is bad input
// (empty/whitespace name, or a kind outside LABEL_KINDS) — all client 400s; callers map any error → 400.
export type LabelResult<T> = { ok: true; data: T } | { ok: false; error: string };

// list_issue_labels — the project's labels (no event; a read).
export function listLabels(db: DatabaseSync, projectId: string): unknown {
  return db.prepare("SELECT name,kind FROM labels WHERE project_id=? ORDER BY kind,name").all(projectId);
}

// create_issue_label — validate (DL-22: empty-name + LABEL_KINDS, UP FRONT) then INSERT OR IGNORE (idempotent
// on UNIQUE(project_id,name)). Returns the {name,kind} on success. NO event here — the op-API wrapper logs an
// attributed `label.create` (the identity win) while server.ts's tool stays byte-identical (it never logged one).
export function createLabel(db: DatabaseSync, projectId: string, a: { name: string; kind?: string }): LabelResult<{ name: string; kind: string }> {
  const nm = a.name.trim();
  if (!nm) return { ok: false, error: "label name required (non-empty, non-whitespace)" }; // DL-22: reject empty/whitespace, no junk row
  const k = a.kind ?? "workflow";
  if (!LABEL_KINDS.includes(k as (typeof LABEL_KINDS)[number])) return { ok: false, error: `invalid kind '${k}'; one of ${LABEL_KINDS.join("/")}` }; // DL-22: clean err, never a fake success
  db.prepare("INSERT OR IGNORE INTO labels(id,project_id,name,kind) VALUES (?,?,?,?)").run(randomUUID(), projectId, nm, k);
  return { ok: true, data: { name: nm, kind: k } }; // idempotent: UNIQUE(project_id,name) → re-create of an existing name is a no-op, still ok
}

// get_project — the active project row (no event; a read). Same column list/shape on both paths.
export function getProject(db: DatabaseSync, projectId: string): unknown {
  return db.prepare("SELECT id,key,name,ticket_prefix,mode,autonomy FROM projects WHERE id=?").get(projectId);
}
