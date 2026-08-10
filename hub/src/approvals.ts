// approvals.ts — the third question a destructive verb asks, as a row the system can consult.
//
// Design: hubDoc:design/approvals (LOOP-383). This module is child C1: the object model, the key
// grammar, and the store. No CLI (C2), no consumer (C4/C6), no `approvals.enforce` switch (C4).
//
// The destructive-verb family already answers two questions, and this is a third that composes with
// them rather than replacing either (design §2):
//
//   1. "Did you mean THIS target?"      → isolationVerdict()   (LOOP-305/316)
//   2. "May a FIRE do this at all?"     → activeFireMarker()   (LOOP-367/368) — absolute, un-bypassable
//   3. "Did the human approve THIS?"    → this module          — only if a record says so
//
// Question 2's refusal is deliberately un-bypassable, and `destructive-guard.ts` says why: a bypass
// flag "would document its own bypass to the party being guarded." Question 3 is what makes a
// GOVERNED yes possible without reopening that hole — the operator authorises a specific action ahead
// of time, and the fire consults a record it cannot write.
//
// ── THE INVARIANT THIS MODULE DEPENDS ON, AND DELIBERATELY DOES NOT ENFORCE ───────────────────────
// Design §2: `approve` and `revoke` are themselves FIRE-REFUSED — they call activeFireMarker() and
// refuse inside a fire, exactly like the verbs they authorise. That refusal lives in the CLI layer
// (C2), not here: this module is the store, and the store is also what the operator console writes
// through. **If a child ever makes granting reachable from inside a fire, question 2's guarantee is
// gone and the whole design is unsafe.** C1 therefore imports nothing from destructive-guard.ts, and
// the absence is a decision, not an oversight — it is recorded here so C2 cannot mistake it for one.
//
// ── WHY `state` IS NOT A COLUMN ───────────────────────────────────────────────────────────────────
// Design §3 lists `state` in the object model and annotates it "(derived, see §6)"; §6 makes it
// explicit: "state is derived on read, not stored. This is the fail-closed direction and it is not
// optional." A stored state is a state that can be stale, and a stale row that still reads `granted`
// is precisely the standing capability §4 exists to prevent. So the table stores the FACTS
// (granted_at / revoked_at / discharged_at / expires_at) and deriveState() computes the answer at
// consult time against the caller's `now`. No sweeper exists, and none is needed.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logEvent, nowIso } from "./db.ts";

// ─── The key grammar (design §4) ──────────────────────────────────────────────────────────────────
//
// "An action_key must denote a specific END STATE. If you cannot name the end state, you may not
// write the key."
//
// `push:main` is not a legal key: it names a CAPABILITY ("may push to main"), which is a standing
// grant that never discharges and would have authorised precisely the incident in LOOP-383's Why.
// The instance component (<sha>) is what turns it into an end state.
//
// This registry is the mechanical form of that rule. STANDING RULE 27 is why it is code and not a
// comment: the precision of the key IS the security boundary here, so it is checked where the key is
// WRITTEN (grantApproval), and an unknown class is refused rather than accepted as an opaque string.
//
// A consequence worth naming, because consultApproval relies on it: every class below carries its own
// scope inside the key — a ticket id is project-prefixed, `board-restore`/`remove-project` name the
// project, `push`/`npm-publish` name a branch+sha / package+version. Keys are therefore globally
// unique end states, which is what makes a key-only lookup safe.
export interface ActionClassSpec {
  /** Ordered component names, exactly as they appear after the class in the key. */
  components: readonly string[];
  /** The end state the key names — quoted in refusals so the operator sees WHAT they authorised. */
  endState: string;
}

export const ACTION_CLASSES: Readonly<Record<string, ActionClassSpec>> = Object.freeze({
  "npm-publish": { components: ["package", "version"], endState: "that version is on npm" },
  push: { components: ["branch", "sha"], endState: "that sha is on that branch" },
  reopen: { components: ["ticket"], endState: "that ticket has left its terminal state" },
  "board-restore": { components: ["project", "snapshot"], endState: "the board equals that snapshot" },
  "remove-project": { components: ["project"], endState: "that project is gone" },
});

export type ActionClass = keyof typeof ACTION_CLASSES;

/** Every legal class, sorted — the list a refusal or a `--help` enumerates. */
export const actionClasses = (): string[] => Object.keys(ACTION_CLASSES).sort();

// ─── Typed errors ─────────────────────────────────────────────────────────────────────────────────
//
// parseActionKey RETURNS its error (it is an inspector — a linter, a `--help` validator and the CLI
// all want the reason without a throw). The WRITERS throw, and that asymmetry is deliberate: design
// §4 calls the grant-time lint "a hard refusal, never a warning", and a returned error is exactly the
// shape a caller can drop on the floor. A throw cannot be ignored silently.
export type ApprovalErrorCode =
  | "unknown-action-class"   // the class is not in ACTION_CLASSES
  | "missing-component"      // the class requires components the key did not supply
  | "extra-component"        // the key supplied more components than the class declares
  | "empty-component"        // a component was present but empty (`push::sha`)
  | "control-character"      // a component carried a control/format character — it would render as a lie
  | "bad-expiry"             // --expires was neither a duration nor `never`
  | "ambiguous-grant"        // both a requestId and an actionKey — which key is being authorised?
  | "not-found"              // no approval row with that id
  | "not-grantable"          // the row is already granted or already terminal
  | "not-revocable"          // the row is already terminal
  | "not-dischargeable";     // the row was never granted, or is already terminal

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}

// ─── parseActionKey ───────────────────────────────────────────────────────────────────────────────
export interface ParsedActionKey {
  key: string;
  actionClass: string;
  /** Component name → value, in the class's declared order. */
  components: Record<string, string>;
  /** The component values, positionally — convenient for consumers that only want `<sha>`. */
  values: string[];
  endState: string;
}

export type ParseResult =
  | { ok: true; parsed: ParsedActionKey }
  | { ok: false; code: ApprovalErrorCode; message: string };

/**
 * Split an action key into its class and components, or explain exactly why it is not one.
 *
 * Colon is the only separator, and no registered component may contain one: git refnames forbid `:`,
 * a scoped npm name uses `@scope/name`, a sha is hex, and a hub ticket id is `PREFIX-N`. So a plain
 * split is correct for every class in the registry — and a class whose component COULD contain a
 * colon must not be added without revisiting this.
 */
export function parseActionKey(key: string): ParseResult {
  const raw = typeof key === "string" ? key.trim() : "";
  const parts = raw.split(":");
  const actionClass = parts[0] ?? "";
  const spec = Object.hasOwn(ACTION_CLASSES, actionClass) ? ACTION_CLASSES[actionClass] : undefined;
  if (!spec) {
    return {
      ok: false,
      code: "unknown-action-class",
      message: `unknown action class ${JSON.stringify(actionClass)} in key ${JSON.stringify(raw)} — legal classes: ${actionClasses().join(", ")}`,
    };
  }
  const values = parts.slice(1);
  const want = spec.components;
  if (values.length < want.length) {
    const missing = want.slice(values.length);
    return {
      ok: false,
      code: "missing-component",
      message:
        `key ${JSON.stringify(raw)} names a capability, not an end state: '${actionClass}' requires ` +
        `<${want.join(">:<")}> and is missing <${missing.join(">, <")}>. ` +
        `The instance component is what makes the key an end state (${spec.endState}).`,
    };
  }
  if (values.length > want.length) {
    return {
      ok: false,
      code: "extra-component",
      message: `key ${JSON.stringify(raw)} has ${values.length} component(s); '${actionClass}' declares ${want.length} (<${want.join(">:<")}>)`,
    };
  }
  const emptyAt = values.findIndex((v) => v.trim() === "");
  if (emptyAt >= 0) {
    return {
      ok: false,
      code: "empty-component",
      message: `key ${JSON.stringify(raw)} has an empty <${want[emptyAt]}> component`,
    };
  }
  // A component is shape-checked for COUNT and emptiness above; nothing else constrains its bytes,
  // and `request` is agent-callable by design (§ AC3). So a key component carrying a newline or a
  // terminal escape would be stored verbatim and then interpolated into the operator-facing
  // `approvals` listing — letting a filed request inject a line that reads like a granted approval
  // into the very output the operator consults to see what is authorised. Refused at the parser
  // rather than escaped at one renderer: escaping fixes the one consumer that remembers to escape,
  // while the poisoned key stays in the store for every other reader.
  const ctrlAt = values.findIndex((v) => /[\p{Cc}\p{Cf}]/u.test(v));
  if (ctrlAt >= 0) {
    return {
      ok: false,
      code: "control-character",
      message:
        `key ${JSON.stringify(raw)} has a control character in its <${want[ctrlAt]}> component — ` +
        `an action key is displayed to the operator who acts on it, so it must be exactly what it looks like`,
    };
  }
  const components: Record<string, string> = {};
  want.forEach((name, i) => { components[name] = values[i]; });
  return { ok: true, parsed: { key: raw, actionClass, components, values, endState: spec.endState } };
}

/** The grant-time lint, as a throw (design §4: hard refusal). Returns the parse for the caller. */
function requireLegalKey(key: string): ParsedActionKey {
  const r = parseActionKey(key);
  if (!r.ok) throw new ApprovalError(r.code, r.message);
  return r.parsed;
}

// ─── Expiry (design §6) ───────────────────────────────────────────────────────────────────────────
//
// "Default: 24h. A bounded default is deliberate — an unbounded grant is a standing capability, which
// is the thing §4 exists to prevent." `never` must be spelled out; it is never reachable by omission.
export const DEFAULT_EXPIRY = "24h";
export const NEVER = "never";

const DURATION_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `24h` / `7d` / `30m` → milliseconds; `null` when the input is not a duration. */
export function parseDuration(spec: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(String(spec ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n * DURATION_MS[m[2]];
}

/**
 * Resolve `--expires` into the stored `expires_at`.
 *
 * `undefined` ⇒ DEFAULT_EXPIRY (AC7: omission is bounded, never unbounded).
 * `never`     ⇒ NULL, and only ever by that explicit word.
 */
export function resolveExpiry(spec: string | undefined | null, from: string): string | null {
  const s = (spec ?? DEFAULT_EXPIRY).trim();
  if (s === NEVER) return null;
  const ms = parseDuration(s);
  if (ms === null) {
    throw new ApprovalError(
      "bad-expiry",
      `--expires ${JSON.stringify(s)} is neither a duration (e.g. 24h, 7d) nor the explicit word '${NEVER}'`,
    );
  }
  const base = Date.parse(from);
  if (!Number.isFinite(base)) throw new ApprovalError("bad-expiry", `cannot resolve an expiry from ${JSON.stringify(from)}`);
  return new Date(base + ms).toISOString();
}

// ─── The row + the derived state ──────────────────────────────────────────────────────────────────
export interface ApprovalRow {
  id: string;
  project_id: string | null;
  action_key: string;
  requested_by: string | null;
  requested_at: string | null;
  ticket_id: string | null;
  grantor: string | null;
  granted_at: string | null;
  expires_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  discharged_at: string | null;
  note: string | null;
}

export type ApprovalState = "requested" | "granted" | "revoked" | "discharged" | "expired";

/** Exactly one state authorises. Everything else is a refusal, which is the fail-closed direction. */
export const AUTHORISING_STATE: ApprovalState = "granted";

/**
 * The whole of §6, in one function: no sweeper, no stored state, expiry against the caller's `now`.
 *
 * Precedence is a straight line because the writers keep it one: revoke/discharge refuse a row that
 * is already terminal, so `revoked_at` and `discharged_at` are never both set. The order below is
 * still total rather than relying on that — a hand-written row must not produce `undefined`.
 */
export function deriveState(row: ApprovalRow, now: string): ApprovalState {
  if (row.revoked_at) return "revoked";
  if (row.discharged_at) return "discharged";
  if (!row.granted_at) return "requested";
  if (row.expires_at && Date.parse(now) >= Date.parse(row.expires_at)) return "expired";
  return "granted";
}

// ─── Ledger scope ─────────────────────────────────────────────────────────────────────────────────
//
// `events.project_id` is NOT NULL and carries no foreign key, while an approval's `project_id` is
// NULLABLE (design §3: "the project, or NULL for a workspace-scoped action"). A workspace-scoped
// approval therefore has no project id to stamp on its ledger row. Rather than skip the audit line —
// the audit trail is the point — those rows are ledgered under this named scope. Every project-scoped
// query filters by a real project uuid, so a `workspace` row is simply never matched by one.
export const WORKSPACE_SCOPE = "workspace";

const ledgerScope = (projectId: string | null): string => projectId ?? WORKSPACE_SCOPE;

// ─── The store ────────────────────────────────────────────────────────────────────────────────────
const COLS =
  "id,project_id,action_key,requested_by,requested_at,ticket_id,grantor,granted_at,expires_at,revoked_by,revoked_at,discharged_at,note";

const getRow = (db: DatabaseSync, id: string): ApprovalRow | undefined =>
  db.prepare(`SELECT ${COLS} FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined;

const requireRow = (db: DatabaseSync, id: string): ApprovalRow => {
  const row = getRow(db, id);
  if (!row) throw new ApprovalError("not-found", `no approval with id ${JSON.stringify(id)}`);
  return row;
};

export interface RequestInput {
  projectId: string | null;
  actionKey: string;
  requestedBy: string;
  ticketId?: string | null;
  note?: string | null;
}

/**
 * An agent asks for an approval it cannot grant itself. This files the record; it authorises nothing
 * and — design §1 — nothing waits on it. The fire that filed it moves on.
 *
 * The key is linted HERE too, not only at grant: a request naming a capability would otherwise sit in
 * the operator's decision queue as a grantable-looking item that grantApproval will refuse.
 */
export function requestApproval(db: DatabaseSync, input: RequestInput): ApprovalRow {
  const parsed = requireLegalKey(input.actionKey);
  const id = randomUUID();
  const at = nowIso();
  db.prepare(`INSERT INTO approvals(${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.projectId ?? null, parsed.key, input.requestedBy, at, input.ticketId ?? null,
    null, null, null, null, null, null, input.note ?? null,
  );
  logEvent(db, {
    project_id: ledgerScope(input.projectId ?? null),
    ticket_id: input.ticketId ?? null,
    actor: input.requestedBy,
    kind: "approval.request",
    data: { approvalId: id, actionKey: parsed.key, actionClass: parsed.actionClass },
  });
  return requireRow(db, id);
}

export interface GrantInput {
  projectId?: string | null;
  actionKey?: string;
  /** Grant an existing `requested` row instead of creating one. Its key is re-linted. */
  requestId?: string;
  grantor: string;
  /** A duration (`24h`, `7d`) or the explicit word `never`. Omitted ⇒ DEFAULT_EXPIRY. */
  expires?: string | null;
  ticketId?: string | null;
  note?: string | null;
}

/**
 * The security boundary of the module (design §4). Two shapes, one lint:
 *   - `{ actionKey }`  — the operator grants unprompted; `requested_by`/`requested_at` stay NULL (§3).
 *   - `{ requestId }`  — the operator grants an agent's standing request.
 *
 * REFUSES, by throw, a key whose class requires an instance component and did not get one, and an
 * unknown class. This is the §4 lint and it is checked at WRITE time because that is the only moment
 * at which the key's precision can still be corrected.
 */
export function grantApproval(db: DatabaseSync, input: GrantInput): ApprovalRow {
  const at = nowIso();

  if (input.requestId) {
    // Both shapes at once is refused rather than resolved by precedence. Silently ignoring the
    // supplied actionKey would let a caller believe it authorised one end state while the stored
    // request named another — and the whole module rests on the operator knowing exactly what they
    // granted.
    if (input.actionKey !== undefined) {
      throw new ApprovalError(
        "ambiguous-grant",
        `grantApproval got both requestId ${JSON.stringify(input.requestId)} and actionKey ${JSON.stringify(input.actionKey)} — pass one: the request already names its key`,
      );
    }
    const row = requireRow(db, input.requestId);
    const state = deriveState(row, at);
    if (state !== "requested") {
      throw new ApprovalError("not-grantable", `approval ${row.id} is ${state}, not requested — nothing to grant`);
    }
    // The §4 lint runs BEFORE the expiry is resolved, in both shapes: the key is the security
    // boundary, so a bad key must never be reported as an expiry problem.
    const parsed = requireLegalKey(row.action_key); // re-lint: the row may predate a registry change
    const expiresAt = resolveExpiry(input.expires, at);
    db.prepare("UPDATE approvals SET grantor=?, granted_at=?, expires_at=?, note=COALESCE(?,note) WHERE id=?")
      .run(input.grantor, at, expiresAt, input.note ?? null, row.id);
    logEvent(db, {
      project_id: ledgerScope(row.project_id),
      ticket_id: row.ticket_id,
      actor: input.grantor,
      kind: "approval.grant",
      data: { approvalId: row.id, actionKey: parsed.key, actionClass: parsed.actionClass, expiresAt, fromRequest: true },
    });
    return requireRow(db, row.id);
  }

  const parsed = requireLegalKey(input.actionKey ?? "");
  const expiresAt = resolveExpiry(input.expires, at);
  const id = randomUUID();
  const projectId = input.projectId ?? null;
  db.prepare(`INSERT INTO approvals(${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, projectId, parsed.key, null, null, input.ticketId ?? null,
    input.grantor, at, expiresAt, null, null, null, input.note ?? null,
  );
  logEvent(db, {
    project_id: ledgerScope(projectId),
    ticket_id: input.ticketId ?? null,
    actor: input.grantor,
    kind: "approval.grant",
    data: { approvalId: id, actionKey: parsed.key, actionClass: parsed.actionClass, expiresAt, fromRequest: false },
  });
  return requireRow(db, id);
}

/** The operator ends an approval early — one of §5's three exits. Legal from `requested` or `granted`. */
export function revokeApproval(db: DatabaseSync, id: string, revokedBy: string, note?: string | null): ApprovalRow {
  const at = nowIso();
  const row = requireRow(db, id);
  const state = deriveState(row, at);
  if (state !== "requested" && state !== "granted") {
    throw new ApprovalError("not-revocable", `approval ${id} is already ${state} — there is nothing to revoke`);
  }
  db.prepare("UPDATE approvals SET revoked_by=?, revoked_at=?, note=COALESCE(?,note) WHERE id=?")
    .run(revokedBy, at, note ?? null, id);
  logEvent(db, {
    project_id: ledgerScope(row.project_id),
    ticket_id: row.ticket_id,
    actor: revokedBy,
    kind: "approval.revoke",
    data: { approvalId: id, actionKey: row.action_key, priorState: state },
  });
  return requireRow(db, id);
}

/**
 * A consumer observed the end state reached — §5's first exit, and the one the key grammar makes
 * possible at all. `push:main:<sha>` discharges the moment that sha lands; the next push is a
 * different sha, so it is a different key, and this approval authorises nothing further.
 */
export function dischargeApproval(db: DatabaseSync, id: string, actor: string, note?: string | null): ApprovalRow {
  const at = nowIso();
  const row = requireRow(db, id);
  const state = deriveState(row, at);
  if (state !== "granted") {
    throw new ApprovalError("not-dischargeable", `approval ${id} is ${state}, not granted — only a granted approval discharges`);
  }
  db.prepare("UPDATE approvals SET discharged_at=?, note=COALESCE(?,note) WHERE id=?").run(at, note ?? null, id);
  logEvent(db, {
    project_id: ledgerScope(row.project_id),
    ticket_id: row.ticket_id,
    actor,
    kind: "approval.discharge",
    data: { approvalId: id, actionKey: row.action_key },
  });
  return requireRow(db, id);
}

export interface ListFilter {
  /** Match rows for this project. Omit for every scope; pass `null` for workspace-scoped only. */
  projectId?: string | null;
  actionKey?: string;
  /** Keep only rows whose DERIVED state (at `now`) is one of these. */
  states?: readonly ApprovalState[];
  now?: string;
}

export interface ApprovalListItem extends ApprovalRow { state: ApprovalState }

/**
 * The read surface. Deliberately appends NO ledger row: §3 names five kinds (request, grant, revoke,
 * attempt, discharge) and none of them is a list — reading the board is not an event on it.
 */
export function listApprovals(db: DatabaseSync, filter: ListFilter = {}): ApprovalListItem[] {
  const now = filter.now ?? nowIso();
  const where: string[] = [];
  const args: (string | null)[] = [];
  if (filter.projectId !== undefined) {
    if (filter.projectId === null) where.push("project_id IS NULL");
    else { where.push("project_id = ?"); args.push(filter.projectId); }
  }
  if (filter.actionKey !== undefined) { where.push("action_key = ?"); args.push(filter.actionKey); }
  const sql = `SELECT ${COLS} FROM approvals${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid ASC`;
  const rows = db.prepare(sql).all(...args) as unknown as ApprovalRow[];
  const items = rows.map((r) => ({ ...r, state: deriveState(r, now) }));
  return filter.states ? items.filter((i) => filter.states!.includes(i.state)) : items;
}

// ─── Consumption (design §5) ──────────────────────────────────────────────────────────────────────
export interface ApprovalVerdict {
  /** The only field a consumer may branch on to proceed. */
  authorises: boolean;
  key: string;
  /** The row this verdict is about — the authorising one if there is one, else the latest. */
  approval: ApprovalRow | null;
  /** Its derived state, or `null` when no row exists for the key at all. */
  state: ApprovalState | null;
  /** Why it does not authorise. `null` exactly when `authorises` is true. */
  reason: string | null;
  /** Whether this consult was ledgered as an `approval.attempt` (see below). */
  attemptRecorded: boolean;
}

export interface ConsultOptions {
  /**
   * The consulting consumer's project. Scopes the ledger row, and narrows which rows may match: a
   * row for THIS project, or a workspace-scoped one (project_id NULL), which covers every project by
   * definition. Omit to match on the key alone.
   */
  projectId?: string | null;
  actor?: string;
  ticketId?: string | null;
  /**
   * Ledger this consult as an `approval.attempt`. Default true: the audit line should happen without
   * every consumer remembering to ask for it. Pass `false` for a read that is genuinely NOT an
   * attempt — `doctor`, a listing, or C6's `approvals --covers <key>` coverage query — and for any
   * caller holding a `query_only` connection (the daemon's read handle), where a write would throw.
   */
  record?: boolean;
}

/**
 * "Does a record authorise <key> right now?" — a VERDICT, never a boolean, because every refusal has
 * a reason the caller must be able to print (design §5 / AC4).
 *
 * Attempts are recorded and NEVER subtractive (§5): an approval is not consumed by being used. It
 * leaves the authorising state exactly three ways — discharged, expired, revoked — and consulting it
 * a hundred times is none of them. That is what makes one grant cover a retry: the release case
 * `npm-publish:@dyzsasd/dev-loop:1.15.1` is ONE end state across four dispatches, and the key, not
 * the expiry, is what bounds it.
 *
 * Key-only matching is safe because §4's grammar makes every key a globally unique end state (see the
 * registry comment). `opts.projectId` narrows further when a consumer wants belt-and-braces.
 */
export function consultApproval(
  db: DatabaseSync,
  actionKey: string,
  now: string,
  opts: ConsultOptions = {},
): ApprovalVerdict {
  const record = opts.record !== false;
  const parsed = parseActionKey(actionKey);

  const finish = (v: Omit<ApprovalVerdict, "attemptRecorded">): ApprovalVerdict => {
    // The scope for the ledger row: the caller's, else the matched row's. A workspace-scoped consult
    // with neither resolves to WORKSPACE_SCOPE, so the attempt is always ledgered when asked for.
    const scope = opts.projectId !== undefined ? opts.projectId : (v.approval?.project_id ?? null);
    if (!record) return { ...v, attemptRecorded: false };
    logEvent(db, {
      project_id: ledgerScope(scope),
      ticket_id: opts.ticketId ?? v.approval?.ticket_id ?? null,
      actor: opts.actor ?? "unknown",
      kind: "approval.attempt",
      data: { actionKey, approvalId: v.approval?.id ?? null, state: v.state, authorises: v.authorises },
    });
    return { ...v, attemptRecorded: true };
  };

  // A malformed key can match nothing (grantApproval refused to write one), but say WHY rather than
  // reporting a bare "no approval" — the two are different operator problems.
  if (!parsed.ok) {
    return finish({ authorises: false, key: actionKey, approval: null, state: null, reason: parsed.message });
  }

  // Scope narrowing is done HERE rather than through listApprovals' filter, which is strict by
  // design (a listing means what it says). A consult is the other question: a workspace-scoped grant
  // covers every project, so excluding it because the consumer named its own project would refuse an
  // approval the operator did grant — `npm-publish:<pkg>:<version>` is exactly that shape.
  const inScope = (r: { project_id: string | null }): boolean =>
    opts.projectId === undefined || r.project_id === null || r.project_id === opts.projectId;
  const candidates = listApprovals(db, { actionKey: parsed.parsed.key, now }).filter(inScope);

  const authorising = candidates.filter((c) => c.state === AUTHORISING_STATE).at(-1);
  if (authorising) {
    const { state: _s, ...row } = authorising;
    return finish({ authorises: true, key: parsed.parsed.key, approval: row, state: AUTHORISING_STATE, reason: null });
  }

  const latest = candidates.at(-1);
  if (!latest) {
    return finish({
      authorises: false, key: parsed.parsed.key, approval: null, state: null,
      reason: `no approval exists for ${JSON.stringify(parsed.parsed.key)}`,
    });
  }
  const { state, ...row } = latest;
  const reason =
    state === "requested" ? `approval ${row.id} for ${JSON.stringify(row.action_key)} is requested but not granted`
    : state === "revoked" ? `approval ${row.id} for ${JSON.stringify(row.action_key)} was revoked by ${row.revoked_by ?? "?"} at ${row.revoked_at}`
    : state === "discharged" ? `approval ${row.id} for ${JSON.stringify(row.action_key)} was discharged at ${row.discharged_at} — its end state was already reached`
    : `approval ${row.id} for ${JSON.stringify(row.action_key)} expired at ${row.expires_at}`;
  return finish({ authorises: false, key: parsed.parsed.key, approval: row, state, reason });
}

// ─── The coverage query (design §7 — the CONSULTING consumer, LOOP-395 / C6) ──────────────────────
//
// The hub can only refuse what the hub executes. The npm publish runs from a `workflow_dispatch`
// workflow a human triggers in the GitHub UI, so no approval object can gate it — and design §7 says
// plainly that no child should pretend otherwise. What failure 2 actually cost was never the missing
// gate; it is stated in LOOP-383's Why: *"every retry required the operator console to re-derive
// whether the original approval still covered the changed mechanics."* The party that needed the
// record is the operator console. This is the answer it asks for.
//
// TWO PROPERTIES MAKE THIS A COVERAGE QUERY AND NOT A PERMISSION CHECK, and they are the same
// property read from both ends (§5):
//   - a grant is NOT consumed by being used, so all four dispatches of one release are covered by
//     one grant, however many attempts were recorded against it;
//   - a key names an END STATE, so the next version is a different key and is NOT covered.
// A test that only asserts the first passes equally against a blanket permission. Both directions
// are asserted (AC2 with AC3), and `nearest` below exists so the second one can be READ rather than
// inferred from an absence.

/** A live grant of the same action class that names a DIFFERENT end state — never coverage. */
export interface CoverageNearMiss {
  id: string;
  key: string;
  /** Component name → what was asked vs what is granted, for the components that differ. */
  differs: Record<string, { asked: string; granted: string }>;
  expires_at: string | null;
}

export interface CoverageVerdict {
  /** The one field a caller may branch on; `verdict` is the same answer as a printable word. */
  covered: boolean;
  verdict: "covered" | "not-covered";
  /** The normalized key, or the key exactly as typed when it does not parse. */
  key: string;
  /** The covering approval when covered; the latest row for the key otherwise; else null. */
  approval: ApprovalRow | null;
  state: ApprovalState | null;
  /** Why it is not covered. `null` exactly when `covered` is true. */
  reason: string | null;
  nearest: CoverageNearMiss[];
}

export interface CoverageOptions {
  /** Same narrowing as a consult: this project's rows plus workspace-scoped ones. */
  projectId?: string | null;
}

/**
 * "Does a grant still cover the action I am about to retry?" — a read, and only a read.
 *
 * It ledgers NOTHING. Design §14 decision 4 names this caller explicitly as one of the three that
 * must pass `record:false`: a coverage QUERY is not an attempt, and recording it would inflate the
 * very ledger the operator console reads to see what was attempted. That is not a security bypass —
 * `record:false` skips the audit line and nothing else — but it IS the difference between a ledger
 * that says "four dispatches" and one that says "four dispatches and eleven times somebody asked".
 */
export function coverageQuery(
  db: DatabaseSync,
  actionKey: string,
  now: string,
  opts: CoverageOptions = {},
): CoverageVerdict {
  const v = consultApproval(db, actionKey, now, { projectId: opts.projectId, record: false });
  if (v.authorises) {
    return { covered: true, verdict: "covered", key: v.key, approval: v.approval, state: v.state, reason: null, nearest: [] };
  }

  // The near-miss set answers the reason AC1 lists last — "a key that denotes a different end state".
  // Without it, asking about 1.15.2 while holding a grant for 1.15.1 answers "no approval exists",
  // which is true and useless: it reads identically to never having been granted anything, so the
  // console is back to re-deriving by hand, which is the failure this ticket closes.
  const parsed = parseActionKey(actionKey);
  const nearest: CoverageNearMiss[] = [];
  if (parsed.ok) {
    const asked = parsed.parsed;
    const inScope = (r: { project_id: string | null }): boolean =>
      opts.projectId === undefined || r.project_id === null || r.project_id === opts.projectId;
    for (const row of listApprovals(db, { now, states: [AUTHORISING_STATE] })) {
      if (!inScope(row) || row.action_key === asked.key) continue;
      const other = parseActionKey(row.action_key);
      // A stored key that no longer parses cannot be compared component-wise, and guessing at one
      // would be the same class of error as the ILLEGAL keys §4 refuses. Skipping is right: it is
      // not a near miss, and it is not coverage either — `covered` is already false.
      if (!other.ok || other.parsed.actionClass !== asked.actionClass) continue;
      const differs: Record<string, { asked: string; granted: string }> = {};
      for (const [name, value] of Object.entries(asked.components)) {
        const granted = other.parsed.components[name];
        if (granted !== value) differs[name] = { asked: value, granted };
      }
      if (Object.keys(differs).length) nearest.push({ id: row.id, key: row.action_key, differs, expires_at: row.expires_at });
    }
  }

  // A near miss REPLACES the reason only when there is no row for the asked key at all. When one
  // exists (revoked, expired, discharged), that row is the answer to "why not" and a neighbouring
  // grant is context — reporting the neighbour instead would tell the operator to look at the wrong
  // approval.
  const reason =
    v.approval === null && nearest.length
      ? `no approval covers ${JSON.stringify(v.key)} — ${nearest.length === 1 ? "a granted approval names" : `${nearest.length} granted approvals name`} a DIFFERENT end state: ` +
        nearest.map((n) => `${n.key} (${Object.entries(n.differs).map(([c, d]) => `${c} ${JSON.stringify(d.granted)}, not ${JSON.stringify(d.asked)}`).join("; ")})`).join(", ")
      : v.reason;

  return { covered: false, verdict: "not-covered", key: v.key, approval: v.approval, state: v.state, reason, nearest };
}
