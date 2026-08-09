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
import { openDb, actorExists, listActorHandles } from "./db.ts";
import { ensureActors, findProject } from "./seed.ts";
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

/**
 * The verbs that WRITE an approval row, and so must carry a real actor (G1, below).
 *
 * `approvals` is deliberately outside this set: a listing attributes nothing, so refusing it on a
 * bad DEVLOOP_ACTOR would cost the operator their only way to SEE the state without protecting any
 * record. The guard exists to keep an unattributable row out of the store, not to gate reading.
 */
export const WRITING_VERBS: ReadonlySet<Verb> = new Set<Verb>(["approve", "revoke", "request"]);

/** The shape `randomUUID()` writes into `approvals.id` — how `revoke` tells an id from a key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An ApprovalError is either "you typed the key/expiry wrong" (usage, exit 2 — AC6) or "the record
// says no" (domain, exit 1). Splitting them here rather than at each throw site keeps the mapping in
// one place, where it can be read against the CLI's published exit-code contract.
const USAGE_ERRORS: ReadonlySet<ApprovalErrorCode> = new Set<ApprovalErrorCode>([
  "unknown-action-class", "missing-component", "extra-component", "empty-component",
  "control-character", "bad-expiry", "ambiguous-grant",
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

    revoke: `dev-loop revoke <key|approval-id> [--note <text>] [--project <key>|--workspace] [--json]

  End an approval early. OPERATOR-ONLY: refused inside an agent fire, for the same reason approve is.

  <key> resolves to the one live (requested or granted) approval for that key WITHIN THE RESOLVED
  SCOPE — the booted project (or --project) plus workspace-scoped grants, exactly what 'dev-loop
  approvals' lists. Another project's grant is not yours to end from here. When several match, the
  ids are listed and you pass the one you mean.

  --workspace      resolve the key among workspace-scoped grants only.
  <approval-id>    names one row directly, and already carries its scope: --project/--workspace are
                   refused with an id rather than silently ignored.

  An already terminal approval is not revocable — there is nothing left to end.`,

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
    // Last-one-wins is the wrong rule on a surface that authorises actions: `approve <key>
    // --expires 1h --expires never` would exit 0 having quietly discarded the bound the caller
    // typed first and written the standing capability §4 exists to prevent, and a repeated
    // --project/--request would pick a scope or a record the earlier argument contradicted. A
    // command that says two things does not get to have one of them chosen for it.
    if (Object.hasOwn(flags, name)) {
      return { positional, flags, error: `--${name} was given more than once — the two values contradict each other, so neither is assumed` };
    }
    // Control characters are refused for EVERY value flag, not just the ones that reach a renderer
    // today. `--ticket` is agent-supplied and interpolated into the operator-facing listing exactly
    // as the action key is, so fixing the key alone left the same forged-line vector open through a
    // different field — and `--note` is one renderer away from the same thing. No value flag here
    // (a ticket id, a project key, a duration, a uuid, a note) legitimately contains one.
    const raw = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    if (typeof raw === "string" && /[\p{Cc}\p{Cf}]/u.test(raw)) {
      return { positional, flags, error: `--${name} contains a control character — these values are shown to the operator who acts on them, so they must be exactly what they look like` };
    }
    if (eq >= 0) { flags[name] = a.slice(eq + 1); continue; }
    const value = argv[i + 1];
    if (value === undefined) return { positional, flags, error: `--${name} needs a value` };
    // A dangling flag whose neighbour is another option must NOT swallow it: `request <key> --ticket
    // --workspace` would otherwise record "--workspace" as the ticket AND lose the scope flag, writing
    // a row with a value and a scope the caller never asked for. Refuse instead — the `=` form stays
    // available for the rare value that genuinely begins with `--`.
    if (value.startsWith("--")) {
      return { positional, flags, error: `--${name} needs a value, but the next argument is the flag '${value}' (write --${name}=<value> if the value really starts with '--')` };
    }
    flags[name] = value;
    i++;
  }
  return { positional, flags, error: null };
}

/**
 * Which flags each verb accepts. The parser recognises the UNION of all four verbs' flags (one lexer,
 * four verbs), and each handler reads only the fields it consumes — so without this table a flag meant
 * for another verb parses cleanly and is then read by nobody, and the caller is told nothing. That is
 * the same failure the mutually-exclusive shapes below refuse rather than resolve by precedence: a
 * silently-discarded flag lets the operator believe they wrote something they did not.
 */
export const VERB_FLAGS: Record<Verb, ReadonlySet<string>> = {
  approve: new Set(["expires", "note", "ticket", "project", "workspace", "request", "json", "help"]),
  revoke: new Set(["note", "project", "workspace", "json", "help"]),
  approvals: new Set(["key", "state", "project", "workspace", "all", "json", "help"]),
  request: new Set(["ticket", "note", "project", "workspace", "json", "help"]),
};

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

/**
 * The rows a scope can see: its own project's, plus workspace-scoped rows, which cover every project
 * by definition. ONE predicate, shared by the listing and by revoke's key resolution — a revoke that
 * searched wider than the listing showed would end an authorization the operator never saw, in a
 * project they did not name.
 */
const inScope = (scope: Scope) => (r: { project_id: string | null }): boolean =>
  scope.projectId === null ? r.project_id === null : r.project_id === scope.projectId || r.project_id === null;

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

  // Checked AFTER the invariant on purpose: inside a fire, `approve`/`revoke` must answer with the
  // refusal above whatever flags were typed, never with a usage note that reads like the flags were
  // the only problem.
  const stray = Object.keys(flags).filter((f) => !VERB_FLAGS[v].has(f));
  if (stray.length) {
    const list = stray.map((f) => `--${f}`).join(", ");
    console.error(`dev-loop ${v}: ${list} ${stray.length > 1 ? "do" : "does"} not apply to '${v}' — ${stray.length > 1 ? "they would be" : "it would be"} parsed and then read by nobody`);
    usage(v);
    return 2;
  }

  let db: DatabaseSync;
  try {
    db = openDb(resolveHubDbPath());
    ensureActors(db); // idempotent; the G1 guard below needs the roster present to answer at all
  }
  catch (e) { console.error(`dev-loop ${v}: cannot open the board — ${(e as Error).message}`); return 5; }

  const json = flags.json === true;
  const now = new Date().toISOString();
  const actor = process.env.DEVLOOP_ACTOR?.trim() || "operator";

  // G1 phantom-actor guard — the same one cli-agentops.ts applies to the other direct-DB write
  // surface, and this surface needs it MORE: an approval's entire value is the identity that granted
  // it, the grantor/revoker columns carry no foreign key to the roster, and the fire refusal above
  // rests on DEVLOOP_ACTOR being a name the workspace actually knows. Without this, a typo
  // (`DEVLOOP_ACTOR=opertaor dev-loop approve <key>`) exits 0 and leaves a GRANTED row authorising a
  // real action on behalf of nobody — an authorisation no one can be asked about afterwards.
  if (WRITING_VERBS.has(v) && !actorExists(db, actor)) {
    console.error(
      `dev-loop ${v}: DEVLOOP_ACTOR='${actor}' is not a known actor, so this ${v} could only be ` +
      `recorded against a name the workspace does not have. Valid: ${listActorHandles(db).join(", ")}. ` +
      `Nothing has been written.`,
    );
    return 4;
  }

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
  // The NORMALIZED key is what the writers store (parseActionKey trims), so the filter has to ask
  // with the same string: a pasted key carrying a trailing space parsed fine here and then matched
  // nothing, reporting a live approval as absent — which invites the operator to grant it a second time.
  let key = str(flags, "key");
  if (key !== undefined) {
    const parsed = parseActionKey(key);
    if (!parsed.ok) { console.error(`dev-loop approvals: ${parsed.message}`); return 2; }
    key = parsed.parsed.key;
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
    items = listApprovals(db, { actionKey: key, now }).filter(inScope(scope));
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

  // The two shapes are told apart by the ID's own grammar rather than by a flag the caller must
  // remember. Asking "is this a UUID?" is the load-bearing direction: failing the KEY grammar only
  // proves the target is not a legal key, so routing every parse failure to the id path answered a
  // mistyped key (`revoke push:main`) with "no such approval id" — a domain error, exit 1, naming
  // nothing the caller could fix — and `--project` alongside it with the unrelated note that a scope
  // cannot accompany an id. A malformed key is a malformed key, and says so.
  if (UUID.test(target)) {
    // An explicit id names ONE row, which already carries its scope. A scope flag passed alongside it
    // could only be silently ignored — the shape `approve --request` refuses rather than resolves by
    // precedence, for the same reason: the caller would believe they had constrained the write.
    for (const [flag, given] of [["--project", str(flags, "project") !== undefined], ["--workspace", flags.workspace === true]] as const) {
      if (given) {
        console.error(`dev-loop revoke: ${flag} does not apply to an explicit approval id — the row it names already carries its scope; pass the KEY to revoke within a scope`);
        return 2;
      }
    }
    const row = revokeApproval(db, target, actor, note); // not-found ⇒ ApprovalError ⇒ exit 1
    emit(withState(row, db), json, `revoked ${row.action_key}`);
    return 0;
  }

  // Not a UUID ⇒ the caller meant a key, so a bad one is answered in the key's own terms — the same
  // usage error (exit 2, AC6) `approvals --key` and `approve` already give for the same input.
  const parsed = parseActionKey(target);
  if (!parsed.ok) { console.error(`dev-loop revoke: ${parsed.message}`); return 2; }

  // Key resolution is SCOPED (the same predicate the listing uses). Unscoped, `revoke <key> --project a`
  // matched every project's row for that key and ended one belonging to project b — cancelling an
  // authorization in a project the operator never named, which they would then believe was still in force.
  const scope = resolveScope(db, flags);
  if (typeof scope === "string") { console.error(`dev-loop revoke: ${scope}`); return 2; }
  const live = listApprovals(db, { actionKey: parsed.parsed.key, now })
    .filter(inScope(scope))
    .filter((r) => r.state === "requested" || r.state === "granted");
  if (!live.length) {
    console.error(`dev-loop revoke: no live approval for ${JSON.stringify(parsed.parsed.key)} in ${scope.label} scope — nothing to revoke (see: dev-loop approvals --key ${parsed.parsed.key} --all)`);
    return 1;
  }
  if (live.length > 1) {
    console.error(`dev-loop revoke: ${live.length} live approvals share the key ${JSON.stringify(parsed.parsed.key)} in ${scope.label} scope — pass the one you mean by id:`);
    for (const r of live) console.error(fmt(r));
    return 2;
  }
  const row = revokeApproval(db, live[0].id, actor, note);
  emit(withState(row, db), json, `revoked ${row.action_key}`);
  return 0;
}

if (isMainEntry(import.meta.url)) process.exit(approvalsCmd());
