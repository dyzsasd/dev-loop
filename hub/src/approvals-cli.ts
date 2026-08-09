#!/usr/bin/env node
// `dev-loop approve | revoke | approvals | request` — the approvals verb surface (LOOP-392, approvals C2).
// Design: hubDoc:design/approvals — §2 (the invariant), §4 (the key grammar), §6 (expiry), §9 (discovery).
//
// THE LOAD-BEARING PROPERTY OF THIS FILE. `approve` and `revoke` are FIRE-REFUSED: they call
// destructive-guard's activeFireMarker() and refuse inside a fire. The design states why in §2 and
// C1's module header restates it as the one thing C2 must not omit:
//
//   Question 2 ("may a FIRE do this at all?") is deliberately absolute and un-bypassable, because a
//   guard that documents its own bypass documents it to the party being guarded. Question 3 ("did the
//   human approve THIS action?") is what makes a governed YES possible WITHOUT reopening that hole —
//   but only because a fire cannot grant its own approval. If granting ever becomes reachable from
//   inside a fire, question 2's guarantee is gone and the whole module is unsafe.
//
// That is also what makes it safe for any OTHER verb's refusal to name the approval path
// ("an operator may pre-authorise this with dev-loop approve <key>"): the fire that reads that
// sentence still cannot execute it.
//
// `request` and `approvals` are AGENT-callable by the same reasoning read in reverse — filing an ask
// and reading the record authorise nothing, and a fire that could not ask would route around the
// module entirely (design §1: a missing approval is a typed request and a moved-on fire, never a wait).
import { isMainEntry } from "./is-entry.ts";
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";
import { resolveHubDbPath } from "./workspace.ts";
import { resolveIdentity } from "./resolve-project.ts";
import { activeFireMarker } from "./destructive-guard.ts"; // the ONE fire-marker list, owned there
import {
  ACTION_CLASSES, DEFAULT_EXPIRY, NEVER, ApprovalError,
  grantApproval, listApprovals, requestApproval, revokeApproval, parseActionKey,
  type ApprovalErrorCode, type ApprovalListItem, type ApprovalState,
} from "./approvals.ts";
import type { DatabaseSync } from "node:sqlite";

export const VERBS = ["approve", "revoke", "approvals", "request"] as const;
export type Verb = (typeof VERBS)[number];

/** The verbs a fire may not run (design §2). Exported so a test names the same set the code does. */
export const FIRE_REFUSED_VERBS: ReadonlySet<Verb> = new Set<Verb>(["approve", "revoke"]);

// An ApprovalError is either "you typed the key/expiry wrong" (usage, exit 2 — AC6) or "the record
// says no" (domain, exit 1). Splitting them here rather than at each throw site keeps the mapping in
// one place, where it can be read against the CLI's published exit-code contract.
const USAGE_ERRORS: ReadonlySet<ApprovalErrorCode> = new Set<ApprovalErrorCode>([
  "unknown-action-class", "missing-component", "extra-component", "empty-component",
  "bad-expiry", "ambiguous-grant",
]);

// ─── The key grammar, as help text (design §9 part 2, AC5) ────────────────────────────────────────
//
// Rendered from ACTION_CLASSES rather than hand-written, so a class added to the registry cannot
// leave the operator-facing help behind — the LOOP-335 failure this design's §9 exists to not repeat.
export function keyGrammarHelp(): string {
  const rows = Object.entries(ACTION_CLASSES)
    .map(([cls, spec]) => `    ${(`${cls}:<${spec.components.join(">:<")}>`).padEnd(46)} ${spec.endState}`)
    .join("\n");
  return `KEY GRAMMAR — an action key names an END STATE, not a capability.

  If you cannot name the end state, you may not write the key.

    LEGAL    push:main:3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab
             — names one end state: that sha is on that branch. It discharges the moment that sha
               lands, and the next push is a different sha, so it is a different key.

    ILLEGAL  push:main
             — names a CAPABILITY ("may push to main"): a standing grant that never discharges.
               Refused at grant time, not warned about.

  Registered classes and the end state each names:
${rows}`;
}

const EXIT_CODES = `Exit codes: 0 ok · 1 domain error (the record says no) · 2 usage (incl. a key that names a
capability) · 4 refused inside an agent fire.`;

function usage(verb?: string): void {
  const help: Record<Verb, string> = {
    approve: `dev-loop approve <key> [--expires <duration>|never] [--note <text>] [--ticket <id>]
                     [--project <key>|--workspace] [--json]
dev-loop approve --request <approval-id> [--expires …] [--note …] [--json]

  Grant an approval. OPERATOR-ONLY: refused inside an agent fire, because a fire that could grant
  its own approval would make every gate that consults one meaningless.

  --request <id>   grant an agent's standing request instead of creating a fresh grant. Mutually
                   exclusive with <key> — the request already names its key.
  --expires        ${DEFAULT_EXPIRY} by default. '${NEVER}' must be spelled out; an unbounded grant is a
                   standing capability, which is the thing the key grammar exists to prevent.
  --workspace      scope the grant to the whole workspace (covers every project) rather than one.`,

    revoke: `dev-loop revoke <key|approval-id> [--note <text>] [--project <key>] [--json]

  End an approval early. OPERATOR-ONLY: refused inside an agent fire, for the same reason approve is.

  <key> resolves to the one live (requested or granted) approval for that key; when several match,
  the ids are listed and you pass the one you mean. An already terminal approval is not revocable —
  there is nothing left to end.`,

    approvals: `dev-loop approvals [--key <key>] [--state <state>] [--project <key>|--workspace|--all]
                   [--json]

  List approvals with their state derived at read time (states: requested, granted, revoked,
  discharged, expired). Read-only, agent-callable, and appends nothing to the ledger — reading the
  record is not an event on it.

  --all         every scope (default: the resolved project plus workspace-scoped grants)
  --workspace   workspace-scoped rows only`,

    request: `dev-loop request <key> --ticket <id> [--note <text>] [--project <key>|--workspace] [--json]

  File a typed request for an approval this caller cannot grant itself. Agent-callable: it
  authorises nothing and nothing waits on it — file it, and move on. The operator sees it in the
  decision queue and grants it with 'dev-loop approve --request <id>'.

  The key is linted here too: a request naming a capability would otherwise sit in the operator's
  queue looking grantable, and be refused at grant time.`,
  };
  if (verb && Object.hasOwn(help, verb)) {
    console.log(`${help[verb as Verb]}\n\n${keyGrammarHelp()}\n\n${EXIT_CODES}`);
    return;
  }
  console.log(`dev-loop — typed human authorization the system can consult

  approve <key> …      grant an approval          (operator-only; refused inside a fire)
  revoke <key|id> …    end one early              (operator-only; refused inside a fire)
  approvals …          list them, state derived   (agent-callable, read-only)
  request <key> …      file a typed request       (agent-callable; authorises nothing)

Run 'dev-loop <verb> --help' for the flags of one verb.

${keyGrammarHelp()}

${EXIT_CODES}`);
}

// ─── arg parsing ──────────────────────────────────────────────────────────────────────────────────
//
// Same conventions as the neighbouring verbs (cli-tickets/cli-agentops): a dangling value or an
// unknown flag is a LOUD usage error, never a silently-swallowed arg.
interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
  error: string | null;
}

const VALUE_FLAGS = new Set(["expires", "note", "ticket", "project", "request", "key", "state"]);
const BOOL_FLAGS = new Set(["json", "workspace", "all", "help"]);

export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = (eq >= 0 ? a.slice(2, eq) : a.slice(2));
    if (BOOL_FLAGS.has(name)) {
      if (eq >= 0) return { positional, flags, error: `--${name} takes no value` };
      flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) return { positional, flags, error: `unknown flag '--${name}'` };
    const value = eq >= 0 ? a.slice(eq + 1) : argv[++i];
    if (value === undefined) return { positional, flags, error: `--${name} needs a value` };
    flags[name] = value;
  }
  return { positional, flags, error: null };
}

const str = (f: Record<string, string | true>, k: string): string | undefined =>
  typeof f[k] === "string" ? (f[k] as string) : undefined;

// ─── scope ────────────────────────────────────────────────────────────────────────────────────────
interface Scope { projectId: string | null; label: string }

/**
 * `--workspace` ⇒ NULL (covers every project); `--project <key>` ⇒ that project; otherwise the
 * booted project. An unknown key is a usage error rather than a silent fall-through to workspace
 * scope, which would grant strictly MORE than the operator asked for.
 */
function resolveScope(db: DatabaseSync, flags: Record<string, string | true>): Scope | string {
  if (flags.workspace === true) {
    if (str(flags, "project") !== undefined) return "pass --project or --workspace, not both";
    return { projectId: null, label: "workspace" };
  }
  const key = str(flags, "project") ?? resolveIdentity().projectKey;
  if (!key) return "no project resolved — pass --project <key> (or --workspace for a workspace-scoped approval)";
  const id = findProject(db, key);
  if (!id) return `unknown project '${key}' — it is not seeded in this workspace's board`;
  return { projectId: id, label: key };
}

// ─── rendering ────────────────────────────────────────────────────────────────────────────────────
const fmt = (r: ApprovalListItem): string => {
  const bits = [r.state.toUpperCase().padEnd(10), r.action_key];
  if (r.state === "granted") bits.push(`(expires ${r.expires_at ?? "never"})`);
  if (r.state === "requested") bits.push(`(requested by ${r.requested_by ?? "?"}${r.ticket_id ? ` on ${r.ticket_id}` : ""})`);
  if (r.state === "revoked") bits.push(`(revoked by ${r.revoked_by ?? "?"} at ${r.revoked_at})`);
  if (r.state === "discharged") bits.push(`(discharged at ${r.discharged_at})`);
  if (r.state === "expired") bits.push(`(expired at ${r.expires_at})`);
  return `  ${r.id}  ${bits.join("  ")}`;
};

/** Re-read the row the writer just returned, so what we print is the DERIVED state, not a guess. */
const withState = (row: { id: string; action_key: string }, db: DatabaseSync): ApprovalListItem =>
  listApprovals(db, { actionKey: row.action_key }).find((r) => r.id === row.id)!;

const emit = (item: ApprovalListItem, json: boolean, headline: string): void => {
  if (json) { console.log(JSON.stringify(item, null, 2)); return; }
  console.log(headline);
  console.log(fmt(item));
};

// ─── the verbs ────────────────────────────────────────────────────────────────────────────────────
export function approvalsCmd(argv: readonly string[] = process.argv.slice(2)): number {
  const [verb, ...rest] = argv;
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") { usage(); return 0; }
  if (!(VERBS as readonly string[]).includes(verb)) {
    console.error(`dev-loop: unknown approvals verb '${verb}' (${VERBS.join(" | ")})`);
    return 2;
  }
  const v = verb as Verb;
  const { positional, flags, error } = parseArgs(rest);
  if (flags.help === true) { usage(v); return 0; }
  if (error) { console.error(`dev-loop ${v}: ${error}`); usage(v); return 2; }

  // ── THE INVARIANT (design §2) ──────────────────────────────────────────────────────────────────
  //
  // Checked FIRST — before the key is parsed, before the workspace is resolved, before the db is
  // even opened — so that no ordering of arguments reaches a write, exactly as `board restore` and
  // `secret set` place theirs. The message names what the OPERATOR must do and deliberately names no
  // flag, token, or env change that would let this caller proceed: an escape hatch would be reached
  // the way LOOP-367's confirmation token was, with the guard documenting its own bypass to the
  // party being guarded. The suppressor is the ABSENCE of a fire marker, which a fire cannot arrange
  // for itself and the operator console has by construction (up.ts clears both markers before exec).
  if (FIRE_REFUSED_VERBS.has(v)) {
    const marker = activeFireMarker();
    if (marker) {
      console.error(
        `dev-loop ${v}: refusing inside an agent fire (${marker} is set). ` +
        `Granting is the human's act — an approval a fire could write for itself would authorise nothing, ` +
        `because every gate that consults one is gated against fires in the first place. Nothing has been read or written. ` +
        `To ask for this approval, file it: dev-loop request <key> --ticket <id>. ` +
        `The operator then grants it from their own console, outside any fire.`,
      );
      return 4;
    }
  }

  let db: DatabaseSync;
  try { db = openDb(resolveHubDbPath()); }
  catch (e) { console.error(`dev-loop ${v}: cannot open the board — ${(e as Error).message}`); return 5; }

  const json = flags.json === true;
  const now = new Date().toISOString();
  const actor = process.env.DEVLOOP_ACTOR?.trim() || "operator";

  try {
    if (v === "approvals") return listVerb(db, flags, positional, json, now);
    if (v === "request") return requestVerb(db, flags, positional, json, actor);
    if (v === "approve") return approveVerb(db, flags, positional, json, actor);
    return revokeVerb(db, flags, positional, json, actor, now);
  } catch (e) {
    if (e instanceof ApprovalError) {
      console.error(`dev-loop ${v}: ${e.message}`);
      return USAGE_ERRORS.has(e.code) ? 2 : 1;
    }
    console.error(`dev-loop ${v}: ${(e as Error).message}`);
    return 1;
  }
}

function listVerb(
  db: DatabaseSync, flags: Record<string, string | true>, positional: string[], json: boolean, now: string,
): number {
  if (positional.length) { console.error(`dev-loop approvals: unexpected argument '${positional[0]}' (filter with --key)`); return 2; }
  const state = str(flags, "state");
  const STATES: readonly ApprovalState[] = ["requested", "granted", "revoked", "discharged", "expired"];
  if (state !== undefined && !STATES.includes(state as ApprovalState)) {
    console.error(`dev-loop approvals: unknown --state '${state}' (${STATES.join(", ")})`);
    return 2;
  }
  const key = str(flags, "key");
  if (key !== undefined) {
    const parsed = parseActionKey(key);
    if (!parsed.ok) { console.error(`dev-loop approvals: ${parsed.message}`); return 2; }
  }

  let items: ApprovalListItem[];
  let label: string;
  if (flags.all === true && (flags.workspace === true || str(flags, "project") !== undefined)) {
    console.error("dev-loop approvals: --all already means every scope — pass it alone, not with --project/--workspace");
    return 2;
  }
  if (flags.all === true) {
    items = listApprovals(db, { actionKey: key, now });
    label = "every scope";
  } else {
    const scope = resolveScope(db, flags);
    if (typeof scope === "string") { console.error(`dev-loop approvals: ${scope}`); return 2; }
    // A workspace-scoped grant covers every project by definition, so a project listing that hid one
    // would misreport what is in force here. `--workspace` narrows to workspace rows only.
    const rows = listApprovals(db, { actionKey: key, now });
    items = scope.projectId === null
      ? rows.filter((r) => r.project_id === null)
      : rows.filter((r) => r.project_id === scope.projectId || r.project_id === null);
    label = scope.projectId === null ? "workspace scope" : `project ${scope.label} (+ workspace-scoped)`;
  }
  if (state !== undefined) items = items.filter((i) => i.state === state);

  if (json) { console.log(JSON.stringify(items, null, 2)); return 0; }
  if (!items.length) {
    console.log(`no approvals in ${label}${key ? ` for ${key}` : ""}${state ? ` in state ${state}` : ""}`);
    return 0;
  }
  console.log(`approvals — ${label} (state derived at ${now})`);
  for (const i of items) console.log(fmt(i));
  return 0;
}

function requestVerb(
  db: DatabaseSync, flags: Record<string, string | true>, positional: string[], json: boolean, actor: string,
): number {
  const key = positional[0];
  if (!key) { console.error("dev-loop request: usage: dev-loop request <key> --ticket <id>"); return 2; }
  if (positional.length > 1) { console.error(`dev-loop request: unexpected argument '${positional[1]}'`); return 2; }
  const ticket = str(flags, "ticket");
  if (!ticket) { console.error("dev-loop request: --ticket <id> is required — a request the operator cannot trace to a ticket is not actionable"); return 2; }
  const scope = resolveScope(db, flags);
  if (typeof scope === "string") { console.error(`dev-loop request: ${scope}`); return 2; }
  const row = requestApproval(db, {
    projectId: scope.projectId, actionKey: key, requestedBy: actor,
    ticketId: ticket, note: str(flags, "note") ?? null,
  });
  emit(withState(row, db), json, `requested — the operator grants it with: dev-loop approve --request ${row.id}`);
  return 0;
}

function approveVerb(
  db: DatabaseSync, flags: Record<string, string | true>, positional: string[], json: boolean, actor: string,
): number {
  const key = positional[0];
  const requestId = str(flags, "request");
  if (positional.length > 1) { console.error(`dev-loop approve: unexpected argument '${positional[1]}'`); return 2; }
  if (!key && !requestId) { console.error("dev-loop approve: usage: dev-loop approve <key> | dev-loop approve --request <approval-id>"); return 2; }
  // Surfaced as two mutually exclusive shapes for the reason C1 refuses them together rather than
  // resolving by precedence: silently ignoring one would let the operator believe they authorised
  // one end state while the stored request named another.
  if (key && requestId) {
    console.error(`dev-loop approve: pass <key> or --request <id>, not both — the request ${JSON.stringify(requestId)} already names its key`);
    return 2;
  }
  const expires = str(flags, "expires");
  const note = str(flags, "note") ?? null;
  const ticket = str(flags, "ticket") ?? null;

  if (requestId) {
    // Same doctrine as the ambiguous-grant refusal above, one level out: the stored request already
    // names its ticket and its scope. Silently ignoring a --ticket/--project passed here would let the
    // operator believe they re-targeted the grant they were making.
    for (const [flag, val] of [["--ticket", ticket], ["--project", str(flags, "project")]] as const) {
      if (val) {
        console.error(`dev-loop approve: ${flag} does not apply to --request ${JSON.stringify(requestId)} — the stored request already carries its ticket and scope`);
        return 2;
      }
    }
    if (flags.workspace === true) {
      console.error(`dev-loop approve: --workspace does not apply to --request ${JSON.stringify(requestId)} — the stored request already carries its scope`);
      return 2;
    }
    const row = grantApproval(db, { requestId, grantor: actor, expires, note });
    emit(withState(row, db), json, `granted ${row.action_key}`);
    return 0;
  }
  const scope = resolveScope(db, flags);
  if (typeof scope === "string") { console.error(`dev-loop approve: ${scope}`); return 2; }
  const row = grantApproval(db, {
    projectId: scope.projectId, actionKey: key, grantor: actor, expires, note, ticketId: ticket,
  });
  emit(withState(row, db), json, `granted ${row.action_key} (${scope.label} scope)`);
  return 0;
}

function revokeVerb(
  db: DatabaseSync, flags: Record<string, string | true>, positional: string[], json: boolean,
  actor: string, now: string,
): number {
  const target = positional[0];
  if (!target) { console.error("dev-loop revoke: usage: dev-loop revoke <key|approval-id>"); return 2; }
  if (positional.length > 1) { console.error(`dev-loop revoke: unexpected argument '${positional[1]}'`); return 2; }
  const note = str(flags, "note") ?? null;

  // A UUID is never a legal action key (its first segment is not a registered class), so the two
  // shapes are told apart by the grammar itself rather than by a flag the caller must remember.
  const parsed = parseActionKey(target);
  if (!parsed.ok) {
    const row = revokeApproval(db, target, actor, note); // not-found ⇒ ApprovalError ⇒ exit 1
    emit(withState(row, db), json, `revoked ${row.action_key}`);
    return 0;
  }

  const live = listApprovals(db, { actionKey: parsed.parsed.key, now })
    .filter((r) => r.state === "requested" || r.state === "granted");
  if (!live.length) {
    console.error(`dev-loop revoke: no live approval for ${JSON.stringify(parsed.parsed.key)} — nothing to revoke (see: dev-loop approvals --key ${parsed.parsed.key} --all)`);
    return 1;
  }
  if (live.length > 1) {
    console.error(`dev-loop revoke: ${live.length} live approvals share the key ${JSON.stringify(parsed.parsed.key)} — pass the one you mean by id:`);
    for (const r of live) console.error(fmt(r));
    return 2;
  }
  const row = revokeApproval(db, live[0].id, actor, note);
  emit(withState(row, db), json, `revoked ${row.action_key}`);
  return 0;
}

if (isMainEntry(import.meta.url)) process.exit(approvalsCmd());
