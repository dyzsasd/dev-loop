// dev-loop hub — the single home for ticket/comment writes (DL-29 daemon routes + DL-35 server.ts convergence).
// EVERY ticket INSERT/UPDATE and comment INSERT in the hub lives here (grep: no other src file writes the
// tickets/comments tables). Two callers share these:
//   • the MCP server (server.ts save_issue/save_comment) — the agent write path; it computes its own merge
//     (REPLACE labels, APPEND-only relatedTo, DL-24 assignTo) inside its own BEGIN IMMEDIATE txn, then calls
//     the raw mechanics below to do the write + log the event.
//   • the daemon's opt-in human web-write routes (create/comment/move/assign) — the board write path; the
//     narrow primitives (createTicket/addComment/moveTicket/assignTicket) wrap the same mechanics.
// The mechanics take a WRITABLE connection (NEVER the daemon's query_only read connection) and the caller's
// resolved actor. Attribution + the event-log discipline (logEvent) + the unknown-assignee guard
// (actorExists) + the state set (STATES) are uniform across both paths by construction.
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { nowIso, nextTicketId, logEvent, actorExists, actorIsHuman, listHumanActorHandles, STATES, type State } from "./db.ts";
import { designParentIds, isDesignParent, designPointerOf, docSlugOf, designOwnerOfSlug, designChildrenOf } from "./design-parent.ts"; // LOOP-344/345: ONE predicate, shared with opQueue
import { handoffGateRejection } from "./handoff-gate.ts";
import { acCompletenessRejection, unlandedWorkRejection } from "./ac-gate.ts"; // LOOP-198: the COMPLETENESS axis of acceptance; LOOP-575: the UNLANDED axis // LOOP-309: In Progress → In Review requires a COMMIT (local git only — never the forge)
import { tryResolveWorkspace } from "./workspace.ts";
import { effectiveRepo, reposOfProject } from "./team-config.ts";
import { BAIL_SHAPE_SET, parseBailShape, latestBailShape, type BailShape } from "./bail-shape.ts"; // Decision 1: the derived bail-shape label

export type WriteResult = { ok: true; id: string } | { ok: false; status: number; error: string };

// Fully-resolved column values for a create. The caller resolves defaults/aliases (state, assignee, labels…)
// before calling — the mechanic does no policy, only the write.
export interface NewTicketFields {
  title: string; description: string; type: string; state: string;
  assignee: string | null; priority: number; labels: string[];
  duplicateOf: string | null; relatedTo: string[]; waiting_on?: string | null;
}
// Fully-merged next-row values for an update. labels/related_to are the PRE-SERIALIZED JSON strings exactly as
// stored (the caller owns REPLACE-vs-append policy); duplicate_of is the scalar column value.
export interface TicketUpdateFields {
  title: string; description: string; type: string; state: string;
  assignee: string | null; priority: number;
  labels: string; duplicate_of: string | null; related_to: string; waiting_on: string | null;
}
// A stored row, narrowed to the columns an update copies (moveTicket/assignTicket read the row to rewrite it).
type StoredRow = TicketUpdateFields;

const exists = (db: DatabaseSync, projectId: string, id: string): boolean =>
  !!db.prepare("SELECT 1 FROM tickets WHERE id=? AND project_id=?").get(id, projectId);
// LOOP-587: the ONE way to hydrate a TicketUpdateFields row. Every caller that reads a ticket in order to
// write it back through updateTicketRow goes through here — merge-guard's forge trip and ticket-release's
// infra-kill release included — so the column list exists in exactly one place.
//
// Why this is exported rather than each caller writing its own SELECT: the interface's fields are REQUIRED,
// but a `db.prepare(...).get()` result is cast, not checked, so a hand-rolled list that omits a column
// type-checks and then fails at the bind. LOOP-384 added `waiting_on` to the interface and to the UPDATE
// and updated this reader — the two hand-rolled copies in merge-guard.ts and ticket-release.ts kept
// hydrating the 9-column shape, so `waiting_on` arrived `undefined` and node:sqlite refused it
// ("Provided value cannot be bound to SQLite parameter 10"). That broke merge-guard loudly and the
// infra-kill release SILENTLY, because its per-ticket `catch {}` swallowed the throw and the ticket was
// simply never released. One list, one reader, so the next column addition cannot repeat it.
export const readTicketUpdateFields = (db: DatabaseSync, projectId: string, id: string): TicketUpdateFields | undefined =>
  db.prepare("SELECT title,description,type,state,assignee,priority,labels,duplicate_of,related_to,waiting_on FROM tickets WHERE id=? AND project_id=?")
    .get(id, projectId) as StoredRow | undefined;
const rowFor = readTicketUpdateFields;

// ─── release/env config + the staging-deploy gate (DL-32 / DL-38, design §7) ──
export interface ReleaseConfig {
  prodPromotionGate?: string;          // DL-32: "human" gates ADDING env:prod (enforced ACTOR-side in server.ts)
  requireDeployBeforeReview?: boolean; // DL-38: the staging-deploy gate (this file)
  deployRepos?: string[];              // DL-38 opt-(a): repos that deploy — match the ticket's repo:<name> label
  hasDeploy?: boolean;                 // DL-38 opt-(a): the single-repo project deploys
}
// Read settings_json.workflow.release fresh (a live, operator-set, opt-in config). Malformed ⇒ {} (fail-open).
export function loadRelease(db: DatabaseSync, projectId: string): ReleaseConfig {
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    const r = (row?.settings_json ? JSON.parse(row.settings_json) : {})?.workflow?.release;
    return r && typeof r === "object" ? r : {};
  } catch { return {}; } // never brick a write on malformed config
}
// DL-38 staging-deploy gate (design §7). Enforced in updateTicketRow below — the shared write path — so it
// covers BOTH the MCP save_issue transition AND the daemon board-move automatically. The In Progress → In
// Review transition is REJECTED when requireDeployBeforeReview is on AND the ticket's repo deploys (its
// repo:<name> ∈ deployRepos, or single-repo hasDeploy) AND it lacks env:dev. A non-deploying repo bypasses
// (carve-out — else docs-only/no-deploy work could never earn env:dev and would deadlock). No ACTOR context.
function stagingDeployRejection(db: DatabaseSync, projectId: string, fromState: string, next: TicketUpdateFields): string | null {
  if (!(fromState === "In Progress" && next.state === "In Review")) return null; // only this edge is gated
  const rel = loadRelease(db, projectId);
  if (rel.requireDeployBeforeReview !== true) return null; // default off ⇒ unchanged behavior
  const labels = JSON.parse(next.labels) as string[];
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  const repoDeploys = repoLabel
    ? Array.isArray(rel.deployRepos) && rel.deployRepos.includes(repoLabel.slice(5))
    : rel.hasDeploy === true; // single-repo (no repo:<name> label)
  if (!repoDeploys) return null;                // carve-out: a non-deploying repo never needs env:dev (no deadlock)
  if (labels.includes("env:dev")) return null;  // gate satisfied — staged
  return `staging-deploy gate: In Progress → In Review requires env:dev (this repo deploys and requireDeployBeforeReview is on)`;
}

// DL-77 verify gate (the Ralph-Wiggum guard) + LOOP-157 two-hop close + LOOP-208 actor coverage. Enforced in
// updateTicketRow below — the SAME single-choke-point placement as stagingDeployRejection — so it covers BOTH the
// MCP save_issue transition AND the daemon board-move automatically. Two edges to Done are gated:
//   • In Progress → Done — the naive maker-self-accept shortcut — is REJECTED for everyone (Done is the OWNER's
//     verdict, reached via In Review).
//   • In Review → Done — LOOP-157/183 defeated the direct edge by splitting the self-accept into two legal calls
//     and by dropping the owner label mid-close. LOOP-208: those fixes keyed the gate on isDevTierActor — a
//     predicate that answers "is this a BUILDER?", not "is this actor entitled to sign off?". The roster has ten
//     agents; three are builders, two (qa/pm) are the verifier-owners, and the remaining five (sweep, reflect,
//     ops, architect, communication) are NEITHER — so they fell straight through the gate and could close a
//     qa/pm-owned ticket with rc=0. A deny-list keyed on a role the invariant never mentions grows a hole every
//     time the roster grows. So the gate now asks the RIGHT question — "is the actor this ticket's verifier-owner?":
//     an In Review → Done close is refused for EVERY actor that is not one of the ticket's own qa/pm owner labels
//     and is not the operator. Keys on the ticket's owner label (STORED ∪ incoming, so a label-drop-at-close can't
//     unlock it — LOOP-183 Vector A) + the actor handle — never the mutable assignee — and the refusal is
//     greppable + names the actual verifier-owner and the actor (observability), with no "builder tier" claim for
//     actors that are not one. RULING (LOOP-208): a single-owner ticket admits ONLY that owner (pm cannot close a
//     qa-owned ticket, nor qa a pm-owned one — "Done means verified by ITS owner", §3); a dual qa+pm-owned ticket
//     admits either owner. §9a's Todo/Backlog → Done parent-close is a different, ungated edge — unaffected.
// Every OTHER path to Done stays legal — In Review → Done by the ticket's own qa/pm owner or the operator (the
// verified close), any actor's In Review → Done on a ticket with NO qa/pm owner label (a §9a self-verified intake
// item), Todo → Done / Backlog → Done (the §9a intake parent-close, which MUST stay legal or it breaks PM's
// grooming), and In Progress → Canceled/Duplicate (terminal, NOT Done). Unlike the DL-38 gate this is
// UNCONDITIONAL (no opt-in config): "Done means verified" is a §3 loop invariant, not an operator preference.
// VERIFIER_OWNER_LABELS — the owner tiers whose sign-off "Done means verified" (§3) requires. Any non-owner,
// non-operator actor may neither close (verifyGateRejection) nor create-closed (verifyCreateGateRejection) a
// ticket carrying one. Deduped so a doubled label never inflates the refusal message.
const VERIFIER_OWNER_LABELS = new Set<string>(["qa", "pm"]);
const ownerLabelsOf = (labels: string[]): string[] => [...new Set(labels.filter((l) => VERIFIER_OWNER_LABELS.has(l)))];

// LOOP-345 — R1 and R2 land TOGETHER, deliberately. With R1 alone, PM could close a design parent
// AND strand its children in Backlog — strictly worse than the old behaviour, where PM could not
// close it at all. They are one rule with two halves and must not be split.
//
// The defect the two halves fix is an INVERSION between the layers: the layer that SHOWS the work
// (opQueue) put a design parent in pm.verify, and the layer that PERMITS the write refused pm and
// allowed qa — so the only ordering the write layer permitted was the one that strands the children,
// and it stranded them silently with rc=0. Measured on a `Bug` design parent with three staged
// Backlog children: `pm` → REFUSED, `qa` → ALLOWED, parent Done, three children left in Backlog.
//
// Both halves resolve "is this a design parent?" through the SAME shared predicate the queue uses
// (design-parent.ts, LOOP-344) — a second copy here is how a gate ends up enforcing something
// different from what the queue displays, which is the bug itself.
function designParentGate(
  db: DatabaseSync, projectId: string, id: string, actor: string, fromState: string, next: TicketUpdateFields,
  storedRow: { description?: string } | undefined,
): string | null {
  if (!(fromState === "In Review" && next.state === "Done")) return null;
  if (actor === "operator") return null; // the operator is never gated by §21a routing
  const parentIds = designParentIds(db, projectId);
  const me = { id, description: next.description ?? storedRow?.description ?? "" };
  if (!isDesignParent(me, parentIds)) return null;
  // From here the §21a design rule DECIDES — see the DESIGN_PARENT_DECIDED sentinel at the call
  // site. It cannot merely layer on top of the ownership gate: R1's whole content is that PM may
  // close a design parent DESPITE the qa owner label the ticket carries from its type. Returning
  // null here would let that owner gate refuse pm two lines later, which is the bug.

  // R1 — PM may close a design parent. §21a gives design-parent verification to PM, and opQueue has
  // always shown it in pm.verify; the write layer refused it because the ticket carried a `qa` owner
  // label from its TYPE. Ownership does not decide a design gate; §21a does.
  if (actor !== "pm")
    return `verify gate: In Review → Done blocked — ${id} is a DESIGN PARENT (§21a), so only 'pm' or the operator may close it (got '${actor}'). PM owns design coherence; the type's qa/pm owner label does not decide this gate.`;

  // R2 — …but not while its staged children sit in Backlog. Closing the parent is the design gate's
  // PASS action, and §21a's pass action is "promote every staged child Backlog → Todo FIRST, THEN
  // move the parent Done". Backlog is invisible to every dev pick-query, so a parent closed over
  // Backlog children strands them with no owner and no signal.
  // WHICH tickets are this parent's children is the shared derivation's answer, not a local one
  // (PR #278 review, P1 — `designChildrenOf`). It used to be decided here by matching the child's
  // slug against a slug scanned out of the PARENT'S description, which stopped being the same
  // relation the parent was derived from the moment ownership moved to §21a's back-link: a parent
  // that names its doc nowhere is now a design parent, and this scan found NONE of its children,
  // so R2 measured zero strandings for exactly the parents LOOP-379 admits.
  // R2's own row set is still fetched where it is used. It is NOT the predicate's input (LOOP-378):
  // this asks which of the children are stranded, which is a question about STATE.
  const children = designChildrenOf(db, projectId, id);
  const rows = db.prepare("SELECT id, state FROM tickets WHERE project_id=?")
    .all(projectId) as unknown as Array<{ id: string; state: string }>;
  const stranded = rows.filter((t) => t.state === "Backlog" && children.has(t.id));
  if (stranded.length)
    return `verify gate: In Review → Done blocked — ${id} is a design parent with ${stranded.length} staged child(ren) still in Backlog (${stranded.map((t) => t.id).join(", ")}). §21a's pass action promotes every child Backlog → Todo FIRST, then closes the parent; Backlog is invisible to every dev pick-query, so closing now strands them.`;
  return DESIGN_PARENT_DECIDED;
}

// A sentinel, not a message: "this is a design parent, pm is closing it, both rules passed — the
// ownership gate must NOT also run." It never reaches a caller (the call site turns it into a pass).
const DESIGN_PARENT_DECIDED = "\u0000design-parent-ok";

// LOOP-360 — the LOOP-309 handoff gate refuses `In Progress → In Review` without a commit or branch
// naming the ticket. A §21a design parent can never satisfy that: its verified increment is the
// design doc plus the staged children, and on `backend:"service"` the doc lives in the hub db rather
// than the repo. designParentGate above covers only the `In Review → Done` edge — it returns null for
// every other transition — so the design hand-off fell straight through to a gate with no notion of
// design parents, and the senior design tier could not deliver at all on a landing:"pr" repo.
//
// Resolved through the SAME shared predicate opQueue and designParentGate use (design-parent.ts,
// LOOP-344); a second copy of the rule here is exactly how a gate ends up enforcing something other
// than what the queue displays. Extracted rather than inlined at the call site for the reason the
// rest of this file is written the same way: updateTicketRow is the choke point every write path
// runs through, and a branch added inline lands on the module's hottest function (the CRAP-ratchet
// trap — green diff, red CI). The transition guard lives here too, so the extra db read happens only
// on the one edge that needs it rather than on every ticket write.
function designParentHandoffExemption(
  db: DatabaseSync, projectId: string, id: string, fromState: string, next: TicketUpdateFields,
  storedRow: { description?: string } | undefined,
): boolean {
  if (!(fromState === "In Progress" && next.state === "In Review")) return false;
  const me = { id, description: next.description ?? storedRow?.description ?? "" };
  return isDesignParent(me, designParentIds(db, projectId));
}

/**
 * The repo the handoff gate (LOOP-309) measures against: the project's primary checkout and its
 * `landing` mode.
 *
 * Returns an empty object on ANY failure — no workspace, no repo, an unreadable config. The gate is
 * then silent, which is the right posture for a check whose input is missing: library callers pass a
 * bare dbPath with no workspace at all (the LOOP-284 lesson), and refusing every handoff for them
 * would break the write layer for everyone who is not running a loop.
 */
function landingContextFor(db: DatabaseSync, projectId: string): { repoRoot?: string; landing?: "pr" | "direct"; baseRef?: string } {
  try {
    const ws = tryResolveWorkspace();
    if (!ws) return {};
    // The gate is configured per REPO, and repos are attached to a project by its config KEY — the
    // write layer only carries the row's UUID, so translate here rather than threading a second
    // identifier through every caller.
    const row = db.prepare("SELECT key FROM projects WHERE id=?").get(projectId) as { key?: string } | undefined;
    if (!row?.key) return {};
    const repos = reposOfProject(ws, row.key);
    const primary = repos.find((r) => r.role === "primary") ?? repos[0];
    if (!primary) return {};
    const r = effectiveRepo(ws, primary.ref);
    // LOOP-575 — the base the UNLANDED axis measures against. `origin/<defaultBranch>`, never the
    // local branch of the same name: under split-dev the local ref does not advance (every worktree
    // is based on the remote-tracking ref), so measuring against it would report the whole of main's
    // recent history as unlanded work belonging to whichever ticket happened to be closing.
    return { repoRoot: r.absPath, landing: r.landing, baseRef: `origin/${r.defaultBranch}` };
  } catch { return {}; }
}

/**
 * The ticket's comment bodies, for the LOOP-198 waiver check.
 *
 * Best-effort: an unreadable comments table must not refuse a close. The gate's whole justification
 * is that it catches an omission mechanically, and a gate that fails closed on its own read error
 * would block every transition the moment that read breaks.
 */
/**
 * Is the LOOP-198 completeness gate enabled for this workspace?
 *
 * Off unless `team.intake.acCompletenessGate` is true — see the AC5 measurement in ac-gate.ts.
 * Resolved here rather than threaded, and best-effort: a library caller with no workspace gets the
 * default (off), which is the same posture landingContextFor takes for the same reason.
 */
function acGateEnabled(): boolean {
  try {
    const ws = tryResolveWorkspace();
    return (ws?.file.team.intake as { acCompletenessGate?: unknown } | undefined)?.acCompletenessGate === true;
  } catch { return false; }
}

/**
 * Is the LOOP-575 unlanded-work axis enabled for this workspace?
 *
 * Same posture and same default as acGateEnabled above — off unless
 * `team.intake.unlandedWorkGate` is true, per the AC4 measurement recorded on LOOP-575. Extracted
 * rather than inlined for the reason the rest of this file gives: updateTicketRow is the choke point
 * every write path runs through, and a branch added there lands on the module's hottest function.
 */
function unlandedGateEnabled(): boolean {
  try {
    const ws = tryResolveWorkspace();
    return (ws?.file.team.intake as { unlandedWorkGate?: unknown } | undefined)?.unlandedWorkGate === true;
  } catch { return false; }
}

function commentBodiesFor(db: DatabaseSync, ticketId: string): string[] {
  try {
    return (db.prepare("SELECT body FROM comments WHERE ticket_id=?").all(ticketId) as unknown as { body: string }[]).map((r) => r.body ?? "");
  } catch { return []; }
}

function verifyGateRejection(actor: string, fromState: string, next: TicketUpdateFields, storedLabels: string[]): string | null {
  if (fromState === "In Progress" && next.state === "Done")
    return `verify gate: In Progress → Done is not allowed — Done must be reached via In Review (owner verification); move to In Review first`;
  // LOOP-208 (was LOOP-157 + LOOP-183 Vector A): the close-edge gate keys on OWNERSHIP, not builder-tier. A ticket
  // carrying a qa/pm verifier-owner label may be closed In Review → Done ONLY by one of those owners or the
  // operator — every other actor is refused (the five non-builder, non-owner handles used to fall through). Read
  // owners from the STORED labels ∪ the incoming set — NOT next.labels alone: the agent save_issue path
  // REPLACE-merges labels, so gating on next.labels let a REPLACE that DROPS the qa/pm owner label in the SAME
  // In Review → Done write empty the owner set and unlock the close (LOOP-183 Vector A). The stored set is the
  // ticket's real ownership at the close; unioning the incoming set keeps the plain "still carries the label"
  // case covered too.
  if (fromState === "In Review" && next.state === "Done") {
    const owners = ownerLabelsOf([...storedLabels, ...(JSON.parse(next.labels) as string[])]);
    if (owners.length > 0 && actor !== "operator" && !owners.includes(actor))
      return `verify gate: In Review → Done blocked — '${actor}' is not the ${owners.join("/")} verifier-owner of this ticket; only that ${owners.join("/")} owner or the operator may close it`;
  }
  return null; // every other transition is the caller's concern
}

// LOOP-183 Vector B + LOOP-208: the create-edge twin of the verify gate. insertTicket writes the row verbatim —
// NONE of the updateTicketRow gates run on a create — so an actor could create a ticket DIRECTLY in Done on a
// qa/pm-owner-labelled ticket, reaching Done with zero owner verification (a distinct sink from the transition
// edge). Mirror the In Review → Done ownership rule at the create edge: only the ticket's own qa/pm owner (or the
// operator) may create a qa/pm-owned ticket already in Done; every other actor is refused — NOT just builder
// tiers (LOOP-208: sweep/reflect/ops/architect/communication fell through here too). Todo/Backlog intake creates
// (§9a) and non-owner-labelled creates stay legal (state ≠ Done, or no owner label). Wired into opSaveIssue's
// create path — the only create path with agent-controlled state (the daemon createTicket hardcodes Todo, the
// Linear mirror intake hardcodes Backlog).
export function verifyCreateGateRejection(actor: string, state: string, labels: string[]): string | null {
  if (state !== "Done") return null;
  const owners = ownerLabelsOf(labels);
  if (owners.length === 0 || actor === "operator" || owners.includes(actor)) return null;
  return `verify gate: create directly into Done blocked — '${actor}' is not the ${owners.join("/")} verifier-owner of this ticket; create it in Todo/Backlog and let the ${owners.join("/")} owner close it after review`;
}

// Field-report P1-1 terminal-state guard (MP-275). A fire's stale queue snapshot let agents lift tickets
// OUT of terminal states — a ticket the operator had just Canceled was re-implemented, rode a batched push,
// and DEPLOYED; a Done ticket was re-opened to In Review. Prompt/pick discipline cannot hold this line;
// the shared write path does: only the OPERATOR exits Done/Canceled — agents file a NEW ticket and link it
// via relatedTo instead (§3). Same single-choke-point placement as the two gates above, so the MCP
// save_issue, the CLI write verbs, and the daemon board-move are all covered. State-PRESERVING updates on
// a closed ticket (label/relatedTo hygiene, comments) stay legal, and Duplicate deliberately stays
// un-gated (its resolution lives on the duplicateOf target; Sweep re-routes mislabeled ones).
const TERMINAL_STATES = new Set<string>(["Done", "Canceled"]);
function terminalExitRejection(actor: string, fromState: string, next: TicketUpdateFields): string | null {
  if (next.state === fromState || !TERMINAL_STATES.has(fromState) || actor === "operator") return null;
  return `terminal-state guard: '${fromState}' → '${next.state}' — only the operator reopens a ${fromState} ticket (P1-1); file a NEW ticket for the follow-up and link it with relatedTo`;
}

// ─── sensitive → senior-dev re-tier gate (design sensitive-routing §2 / LOOP-79 Child A) ──────
// Applied in both insertTicket and updateTicketRow so every write path is covered by construction.
// Rule: sensitive+junior-dev present AND senior-dev actor exists → silently correct to senior-dev
// and log issue.retier. Strict no-op otherwise (incl. legacy no-senior-dev projects).
// LOOP-296 — resolve this ticket's design parent (all three §21a pointer forms, via the shared
// predicate) and inherit `sensitive` from it. Returns the ORIGINAL array when nothing changes, so
// the caller can skip the copy.
//
// `relatedTo` is the pending child's OWN link set, and it is load-bearing rather than incidental: a
// slug's owner is derived from the set of its children, so the FIRST child of a design resolves
// against a slug with no children on the board yet and the lookup answers nobody — the one case
// where the label matters most, since a design's first staged child is exactly where the tier is
// chosen. Passing the pending row lets the shared derivation see it (LOOP-379). `updateTicketRow`
// passes nothing: by then the row is on the board and re-adding it would double the child.
function inheritSensitiveFromDesignParent(db: DatabaseSync, projectId: string, description: string, labels: string[], relatedTo?: readonly string[]): string[] {
  if (labels.includes("sensitive")) return labels;             // already carried explicitly
  try {
    const ptr = designPointerOf(description ?? "");
    if (!ptr) return labels;
    const rows = db.prepare("SELECT id, description, labels FROM tickets WHERE project_id=?")
      .all(projectId) as unknown as Array<{ id: string; description: string; labels: string }>;
    // The direct form names the parent; the two doc forms name the DOC, so the parent is the ticket
    // that owns that slug. The predicate resolves both — reuse it rather than re-deriving, which is
    // how the LOOP-344 inversion happened in the first place.
    // The rows above carry `labels` for the lookup below; the predicate fetches its own board-wide
    // set (LOOP-378) rather than borrowing this one, which is what kept the four call sites honest.
    //
    // LOOP-379: this used to pick the owner out of `designParentIds` by asking which candidate's
    // DESCRIPTION contained the slug. That was a second, private copy of the derivation, and the
    // back-link rule falsifies it — an owner need not name its own doc anywhere (LOOP-399 does not),
    // so the scan would have matched nobody and a doc-pointer child of a `sensitive` design would
    // have silently stopped inheriting the label. That is LOOP-290's shape, which LOOP-296 exists to
    // prevent. Ask the module that owns the derivation instead.
    const direct = /^parent\s+(\S+)/i.exec(ptr);
    const slug = direct ? null : docSlugOf(ptr);
    const ownerId = slug === null
      ? null
      : designOwnerOfSlug(db, projectId, slug, relatedTo ? { description, relatedTo } : undefined);
    const parent = direct
      ? rows.find((r) => r.id === direct[1])
      : (ownerId === null ? undefined : rows.find((r) => r.id === ownerId));
    if (!parent) return labels;
    let parentLabels: string[] = [];
    try { parentLabels = JSON.parse(parent.labels) as string[]; } catch { return labels; }
    if (!parentLabels.includes("sensitive")) return labels;
    return [...labels, "sensitive"];
  } catch { return labels; } // never block a create on this — the backstops still exist
}

function applySensitiveRetier(
  db: DatabaseSync,
  assignee: string | null,
  labels: string[],
): { assignee: string | null; labels: string[]; retiered: { from: string; to: string } | null } {
  if (!labels.includes("sensitive")) return { assignee, labels, retiered: null };
  const isJunior = assignee === "junior-dev" || labels.includes("junior-dev");
  if (!isJunior || !actorExists(db, "senior-dev")) return { assignee, labels, retiered: null };
  const newLabels = [...new Set(labels.map((l) => (l === "junior-dev" ? "senior-dev" : l)))];
  return { assignee: "senior-dev", labels: newLabels, retiered: { from: "junior-dev", to: "senior-dev" } };
}

// ─── tier restore: write-layer null-assignee fix (LOOP-223) ─────────────────────
// Called BEFORE applySensitiveRetier so a restored junior-dev on a sensitive ticket still gets
// escalated. Only acts when a Todo write carries assignee=null (the orphan-reclaim defect:
// Step-0 reset clears the assignee but the tier label survives).
//   - Exactly one dev-tier label (junior-dev/senior-dev) → restore assignee from the label.
//   - More than one dev-tier label → reject (ambiguous — can't pick).
//   - Zero dev-tier labels → pass through (non-split project or pm/qa-owned tracker, e.g. LOOP-277).
function applyTierRestore(
  db: DatabaseSync,
  state: string,
  assignee: string | null,
  labels: string[],
): { assignee: string | null; labels: string[]; restored: { from: null; to: string } | null; rejection: string | null } {
  if (state !== "Todo" || assignee !== null) return { assignee, labels, restored: null, rejection: null };
  const devTierLabels = labels.filter((l) => l === "junior-dev" || l === "senior-dev");
  if (devTierLabels.length === 1) {
    return { assignee: devTierLabels[0], labels, restored: { from: null, to: devTierLabels[0] }, rejection: null };
  }
  if (devTierLabels.length > 1) {
    return {
      assignee, labels, restored: null,
      rejection: `tier restore: Todo ticket with '${devTierLabels.join("', '")}' labels and no assignee is ambiguous — exactly one dev-tier label required`
    };
  }
  return { assignee, labels, restored: null, rejection: null };
}


// ─── WS-C review 3: `waiting_on` is a property of the Human-Blocked STATE, not of the ticket ──────────
// LOOP-384 added the discriminator (human-decision | human-action | external) and the ruling grammar
// documented "leaving Human-Blocked IS the clear" — but nothing cleared it: updateTicketRow carried the
// column forward on every transition, so a ticket parked `human-action`, resumed to Todo and re-parked
// for a DECISION still read `human-action` in the operator's queue. status.ts masked the stale value on
// display (waitingOn is shown only in Human-Blocked), which is exactly how a wrong stored value survives
// until the one place that trusts the column. Two halves, one function, enforced at THE choke point
// every write path runs through (save_issue, the daemon board-move, merge-guard's demote, ticket-release):
//   • leaving Human-Blocked → NULL (idempotent — a ticket that was never parked is already NULL);
//   • entering Human-Blocked with nothing set → 'human-decision', the documented default, so a re-park
//     always carries a fresh, meaningful discriminator (an explicit value still wins);
//   • every other write carries the value through unchanged (LOOP-587's In Review rewrite keeps its
//     `external`; a Human-Blocked ticket's field is edited only by an explicit save_issue waitingOn).
export const WAITING_ON_DEFAULT = "human-decision";
export function waitingOnFor(toState: string, requested: string | null, fromState: string | null): string | null {
  if (toState === "Human-Blocked") return fromState === "Human-Blocked" ? requested : (requested ?? WAITING_ON_DEFAULT);
  return fromState === "Human-Blocked" ? null : requested;
}

// ─── WS-C review 3: the operator ruling — ONE grammar, ONE policy, at the comment write ──────────────
// `Ruling: approve|reject|defer — <reason>` (references/operator-rulings.md) is what PM's next verify
// pass, the digest and a human scrolling all read as THE operator's answer on a parked ticket. Before
// this, a comment body was pure data at the write (insertComment: "never a command-verb parser"), so any
// actor could post one and it would be read as the human's ruling. The grammar is parsed HERE, once,
// and both comment writers (opSaveComment on every agent transport, addComment on the daemon's web
// form) apply the same policy: a ruling-shaped body from a non-human actor is refused, a malformed one
// is refused rather than stored as prose that half-parses, and a valid one is RECORDED — an
// `issue.ruling` ledger event, and on a Human-Blocked ticket the wait it was parked for is answered, so
// waiting_on clears. It does NOT move state: the state verb is still the operator's explicit act
// (`dev-loop rule` does both in one shot; the two-step form stays legal). insertComment itself stays
// the mechanic: the policy sits in the callers, which carry an actor to check.
export const RULING_PREFIX = "Ruling:";
export const RULING_VERDICTS = ["approve", "reject", "defer"] as const;
export type RulingVerdict = (typeof RULING_VERDICTS)[number];
export interface ParsedRuling { verdict: RulingVerdict; reason: string }
/** Anything that LOOKS like a ruling is subject to the policy — a lookalike (`ruling:`, `RULING :`) from an agent must not slip through as prose. */
export const isRulingShaped = (body: string): boolean => /^\s*ruling\s*:/i.test(body ?? "");
const RULING_RE = /^\s*Ruling:\s+(approve|reject|defer)\b\s*(?:[—–-]+\s*)?([\s\S]*)$/;
export const rulingBody = (verdict: RulingVerdict, reason: string): string => `${RULING_PREFIX} ${verdict} — ${reason.trim()}`;
/** null when the body is not ruling-shaped; a string error when it is but does not parse; else the parse. */
export function parseRuling(body: string): ParsedRuling | string | null {
  if (!isRulingShaped(body)) return null;
  const m = RULING_RE.exec(body);
  if (!m) return `a ruling comment must read exactly "${RULING_PREFIX} ${RULING_VERDICTS.join("|")} — <reason in the human's words>" (references/operator-rulings.md); got ${JSON.stringify(body.split("\n")[0]!.slice(0, 80))}`;
  const reason = m[2]!.trim();
  if (!reason) return `a ruling needs the human's reason after the dash — "${RULING_PREFIX} ${m[1]} — <why>"; the record must read back later without this conversation`;
  return { verdict: m[1] as RulingVerdict, reason };
}
export type RulingPolicy = { status: 400 | 403; error: string; ruling: null } | { status: 200; error: null; ruling: ParsedRuling | null };
/** The policy half: is this body a ruling, and may THIS actor post one. */
export function rulingCommentPolicy(db: DatabaseSync, actor: string, body: string): RulingPolicy {
  const parsed = parseRuling(body);
  if (parsed === null) return { status: 200, error: null, ruling: null };
  if (typeof parsed === "string") return { status: 400, error: parsed, ruling: null };
  if (!actorIsHuman(db, actor)) {
    return { status: 403, error: `a ${RULING_PREFIX} comment is the operator's act — '${actor}' is an agent identity, and a ruling recorded against an agent would be read by PM's next pass as the human's answer. Nothing has been written. Human identities in this workspace: ${listHumanActorHandles(db).join(", ") || "(none seeded)"}. To ASK for a ruling, park the ticket Human-Blocked with a Bail-shape comment; the operator rules with: dev-loop rule <id> approve|reject|defer --reason "<why>"`, ruling: null };
  }
  return { status: 200, error: null, ruling: parsed };
}
export interface RulingRecord { verdict: RulingVerdict; reason: string; state: string; waitingOnCleared: string | null }
/**
 * The record half, called AFTER the comment row is in (inside the caller's txn): logs `issue.ruling`
 * and, on a Human-Blocked ticket, clears waiting_on — the wait the park was for is answered. The state
 * is deliberately untouched (see the module note above).
 */
export function recordRuling(db: DatabaseSync, projectId: string, actor: string, ticketId: string, ruling: ParsedRuling): RulingRecord {
  const cur = db.prepare("SELECT state, waiting_on FROM tickets WHERE id=? AND project_id=?").get(ticketId, projectId) as { state: string; waiting_on: string | null } | undefined;
  const state = cur?.state ?? "";
  let waitingOnCleared: string | null = null;
  if (cur && cur.state === "Human-Blocked" && cur.waiting_on !== null) {
    waitingOnCleared = cur.waiting_on;
    db.prepare("UPDATE tickets SET waiting_on=NULL, updated_at=? WHERE id=? AND project_id=?").run(nowIso(), ticketId, projectId);
  }
  logEvent(db, { project_id: projectId, ticket_id: ticketId, actor, kind: "issue.ruling", data: { ruling: ruling.verdict, state, waitingOnCleared } });
  return { verdict: ruling.verdict, reason: ruling.reason, state, waitingOnCleared };
}
// ─── Decision 1: the bail-shape label is a DERIVED, single-source field ───────
// The `Bail-shape: <x>` comment first line is the SOURCE (the human record carrying the reason
// text); the bail-shape LABEL of the same name is its PROJECTION (the machine-routable form the
// scheduler reads). Exactly as Review 3 made `waiting_on` a derived single-source column, the label
// is recomputed from the comment here, at the write choke point, so the two can never disagree:
//   • updateTicketRow — reconciles on every label write: blocked + a parseable Bail-shape comment ⇒
//     that one label (stale bail-shape labels stripped); blocked cleared ⇒ every bail-shape label
//     stripped. This covers the ordering where `blocked` is set AFTER the comment, and the unblock.
//   • insertComment — when a `Bail-shape: <x>` comment lands on a blocked ticket, sets label <x>
//     (stripping stale bail-shape labels). This covers the canonical order (block, then comment):
//     at block time no comment existed, so the label is derived the instant the comment lands.
// Between the two hooks the label cannot drift from the newest comment for any write ordering.

// The newest parseable bail-shape across a ticket's comments (chronological, rowid-tiebroken like
// metrics.ts's marker reader so same-ms comments order deterministically). Rows only — no fs/forge.
function latestBailShapeOf(db: DatabaseSync, ticketId: string): BailShape | null {
  const rows = db.prepare("SELECT body FROM comments WHERE ticket_id=? ORDER BY created_at, rowid").all(ticketId) as { body: string }[];
  return latestBailShape(rows.map((r) => r.body));
}

// Return `labels` reconciled so at most ONE bail-shape label is present and it matches the source:
// the latest Bail-shape comment when the ticket is blocked, nothing when it is not. Same reference
// back when already consistent (the caller skips the write). Fast path: a ticket that is neither
// blocked nor already carrying a bail-shape label needs no comment read.
function reconcileBailShapeLabels(db: DatabaseSync, ticketId: string, labels: string[]): string[] {
  const isBlocked = labels.includes("blocked");
  const hasBailLabel = labels.some((l) => BAIL_SHAPE_SET.has(l));
  if (!isBlocked && !hasBailLabel) return labels; // nothing a bail-shape label could be doing here
  const target = isBlocked ? latestBailShapeOf(db, ticketId) : null;
  // Keep every non-bail label in place, and the target label in place if already present; drop the
  // OTHER bail-shape labels; append the target only when absent. Order-preserving so an already-correct
  // set is returned unchanged (the caller skips the write — no spurious reorder churn).
  const next = labels.filter((l) => !BAIL_SHAPE_SET.has(l) || l === target);
  if (target && !next.includes(target)) next.push(target);
  return next.length === labels.length && next.every((l, i) => l === labels[i]) ? labels : next;
}

export function insertTicket(
  db: DatabaseSync, projectId: string, actor: string, f: NewTicketFields, createEventData: Record<string, unknown>,
): string {
  // LOOP-296 — `sensitive` is INHERITED from the design parent, BEFORE the tier logic runs.
  //
  // Three enforcement layers exist and all three key on the LABEL: the write gate's re-tier here,
  // servable.ts's notSensitiveForJunior queue defense, and doctor W21 + the Sweep digest backstop.
  // Every one is correctly built and none is at fault — they share one input, and nothing guaranteed
  // that input was written on a CHILD. A staged child of a sensitive parent is sensitive work BY
  // CONSTRUCTION, yet whether it carried the label was left to the filer's judgement at staging time.
  //
  // When that judgement said no, all three layers went silent at once and the work routed to the
  // cheap tier. That is not hypothetical: it happened on LOOP-290, the one ticket on this board that
  // edits an irreversible cascade-delete guard. The gate reasoned the label off explicitly —
  // "sensitive-adjacent but not itself sensitive-labeled since the guard bar is inherited from the
  // parent, not new surface" — which is exactly the inference this makes unnecessary.
  //
  // Inheritance runs FIRST so the re-tier below sees the inherited label and escalates the child in
  // the same write, rather than leaving a sensitive ticket sitting on the junior tier until a
  // backstop notices.
  const inherited = inheritSensitiveFromDesignParent(db, projectId, f.description, f.labels, f.relatedTo);
  f = inherited === f.labels ? f : { ...f, labels: inherited };
  // Tier restore FIRST (LOOP-223): fix null assignee before sensitive retier
  const tierRestore = applyTierRestore(db, f.state, f.assignee, f.labels);
  if (tierRestore.rejection) throw new Error(tierRestore.rejection);
  // Sensitive re-tier SECOND (design sensitive-routing §2 / LOOP-79 Child A)
  const retier = applySensitiveRetier(db, tierRestore.assignee, tierRestore.labels);
  const assignee = retier.assignee;
  const labels = retier.labels;
  const id = nextTicketId(db, projectId);
  const t = nowIso();
  db.prepare(`INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,duplicate_of,related_to,waiting_on,created_by,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, projectId, f.title, f.description, f.type, f.state, assignee, f.priority, JSON.stringify(labels), f.duplicateOf, JSON.stringify(f.relatedTo), waitingOnFor(f.state, f.waiting_on ?? null, null), actor, t, t);
  logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.create", data: createEventData });
  if (retier.retiered) {
    logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.retier", data: { from: retier.retiered.from, to: retier.retiered.to, reason: "sensitive" } });
  }
  if (tierRestore.restored) {
    logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.restore", data: { from: "null", to: tierRestore.restored.to, reason: "null-assignee" } });
  }
  return id;
}
export function updateTicketRow(
  db: DatabaseSync, projectId: string, actor: string, id: string, fromState: string, next: TicketUpdateFields,
): WriteResult {
  const labelsArr = JSON.parse(next.labels) as string[];
  // Tier restore FIRST (LOOP-223): fix null assignee before sensitive retier
  const tierRestore = applyTierRestore(db, next.state, next.assignee, labelsArr);
  if (tierRestore.rejection) return { ok: false, status: 400, error: tierRestore.rejection };
  // Build intermediate resolved from tier restore (may change assignee, never labels)
  const tierResolved: TicketUpdateFields = tierRestore.restored
    ? { ...next, assignee: tierRestore.assignee }
    : next;
  // Sensitive re-tier SECOND (design sensitive-routing §2 / LOOP-79 Child A) — on potentially restored values
  const retier = applySensitiveRetier(db, tierRestore.assignee, labelsArr);
  const resolved: TicketUpdateFields = retier.retiered
    ? { ...tierResolved, assignee: retier.assignee, labels: JSON.stringify(retier.labels) }
    : tierResolved;

  // LOOP-183 Vector A: the verify gate keys on the ticket's STORED owner labels (read here, pre-write) so dropping
  // the qa/pm owner label in `resolved` cannot unlock a dev-tier self-close. rowFor reads within the caller's txn.
  const storedRow = rowFor(db, projectId, id);
  const storedLabels = storedRow ? (JSON.parse(storedRow.labels) as string[]) : [];
  // LOOP-575: resolved ONCE — the LOOP-309 handoff axis and the unlanded axis measure against the
  // same checkout, and re-resolving it per axis would re-read the workspace file on every write.
  const landingCtx = landingContextFor(db, projectId);
  const gate = terminalExitRejection(actor, fromState, resolved)
    ?? stagingDeployRejection(db, projectId, fromState, resolved)
    ?? designParentGate(db, projectId, id, actor, fromState, resolved, storedRow)   // LOOP-345 (R1+R2)
    ?? handoffGateRejection({ id, fromState, toState: resolved.state, actor, ...landingCtx,        // LOOP-309
      isDesignParent: designParentHandoffExemption(db, projectId, id, fromState, resolved, storedRow) })            // LOOP-360
    ?? acCompletenessRejection({                                                                    // LOOP-198
      id, description: resolved.description ?? "", toState: resolved.state, fromState, actor,
      commentBodies: commentBodiesFor(db, id),
      enabled: acGateEnabled(),
    })
    ?? unlandedWorkRejection({                                                                      // LOOP-575
      id, toState: resolved.state, fromState, actor,
      commentBodies: commentBodiesFor(db, id),
      repoRoot: landingCtx.repoRoot, baseRef: landingCtx.baseRef,
      enabled: unlandedGateEnabled(),
    })
    ?? verifyGateRejection(actor, fromState, resolved, storedLabels);
  // LOOP-345 R1: on a design parent the §21a rule is the WHOLE decision — a pass here means the
  // ownership gate must not also refuse pm for the qa label the ticket carries from its type.
  if (gate && gate !== DESIGN_PARENT_DECIDED) return { ok: false, status: 400, error: gate };
  // Decision 1: reconcile the derived bail-shape label AFTER the gates (a label-only projection never
  // gates a transition). Setting `blocked` picks up an existing Bail-shape comment; clearing `blocked`
  // strips every bail-shape label — the "unblock removes the bail-shape label" invariant.
  const finalLabels = JSON.stringify(reconcileBailShapeLabels(db, id, JSON.parse(resolved.labels) as string[]));
  const t = nowIso();
  const waitingOn = waitingOnFor(resolved.state, resolved.waiting_on, fromState); // WS-C review 3: the discriminator lives and dies with the Human-Blocked state
  db.prepare(`UPDATE tickets SET title=?,description=?,type=?,state=?,assignee=?,priority=?,labels=?,duplicate_of=?,related_to=?,waiting_on=?,updated_at=? WHERE id=? AND project_id=?`)
    .run(resolved.title, resolved.description, resolved.type, resolved.state, resolved.assignee, resolved.priority, finalLabels, resolved.duplicate_of, resolved.related_to, waitingOn, t, id, projectId);
  logEvent(db, resolved.state !== fromState
    ? { project_id: projectId, ticket_id: id, actor, kind: "issue.transition", data: { from: fromState, to: resolved.state, assignee: resolved.assignee } }
    : { project_id: projectId, ticket_id: id, actor, kind: "issue.update", data: {} });
  if (retier.retiered) {
    logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.retier", data: { from: retier.retiered.from, to: retier.retiered.to, reason: "sensitive" } });
  }
  if (tierRestore.restored) {
    logEvent(db, { project_id: projectId, ticket_id: id, actor, kind: "issue.restore", data: { from: "null", to: tierRestore.restored.to, reason: "null-assignee" } });
  }
  return { ok: true, id };
}

// THE comment INSERT. Mechanic only — existence/body policy is the caller's. Returns the new id + timestamp
// (the MCP echoes them back to the caller). Body is operator/agent DATA — stored verbatim, esc()'d at render
// (never a command-verb parser, never a channel scrub).
export function insertComment(
  db: DatabaseSync, projectId: string, actor: string, ticketId: string, body: string,
): { id: string; createdAt: string } {
  const id = randomUUID();
  const t = nowIso();
  db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES (?,?,?,?,?)").run(id, ticketId, actor, body, t);
  logEvent(db, { project_id: projectId, ticket_id: ticketId, actor, kind: "comment.add", data: {} });
  // Decision 1: derive the bail-shape LABEL from the comment as it lands (the single source). Only a
  // comment whose first line parses as `Bail-shape: <x>` triggers a read — every other comment is an
  // untouched no-op. On a blocked ticket, set label <x> and strip any stale bail-shape label. The
  // comment.add event above is the audit trail; the label is its projection, so no extra event.
  const shape = parseBailShape(body);
  if (shape) {
    const row = db.prepare("SELECT labels FROM tickets WHERE id=? AND project_id=?").get(ticketId, projectId) as { labels: string } | undefined;
    if (row) {
      const labels = JSON.parse(row.labels) as string[];
      if (labels.includes("blocked")) {
        const next = labels.filter((l) => !BAIL_SHAPE_SET.has(l) || l === shape); // keep a present `shape` in place, drop others
        if (!next.includes(shape)) next.push(shape);
        const changed = next.length !== labels.length || next.some((l, i) => l !== labels[i]);
        if (changed) db.prepare("UPDATE tickets SET labels=?, updated_at=? WHERE id=? AND project_id=?").run(JSON.stringify(next), t, ticketId, projectId);
      }
    }
  }
  return { id, createdAt: t };
}

// ─── daemon human-write primitives: narrow wrappers over the mechanics above ──

// Create a Todo ticket (no labels/assignee by default — a human can move/assign/label it after).
export function createTicket(
  db: DatabaseSync, projectId: string, actor: string,
  a: { title: string; description?: string; type?: string },
): WriteResult {
  const title = (a.title ?? "").trim();
  if (!title) return { ok: false, status: 400, error: "title required" };
  const type = a.type ?? "Feature";
  const id = insertTicket(db, projectId, actor,
    { title, description: a.description ?? "", type, state: "Todo", assignee: null, priority: 0, labels: [], duplicateOf: null, relatedTo: [], waiting_on: null },
    { title, type });
  return { ok: true, id };
}

// Add a comment (author = actor). A web form must not post an empty body → 400 (the MCP agent path does not
// enforce this; the guard is the daemon's policy, the INSERT mechanic is shared).
export function addComment(db: DatabaseSync, projectId: string, actor: string, id: string, body: string): WriteResult {
  if (!exists(db, projectId, id)) return { ok: false, status: 404, error: `no such ticket ${id}` };
  if (!(body ?? "").trim()) return { ok: false, status: 400, error: "comment body required" };
  const pol = rulingCommentPolicy(db, actor, body); // WS-C review 3: the web form is a comment writer too — same ruling policy
  if (pol.error !== null) return { ok: false, status: pol.status, error: pol.error };
  insertComment(db, projectId, actor, id, body);
  if (pol.ruling) recordRuling(db, projectId, actor, id, pol.ruling);
  return { ok: true, id };
}

// Move a ticket to a new state. Honors the STATES set (the tickets.state CHECK's mirror) — an unknown state is
// rejected, never written. A deliberate single-field intent: it reads the row and rewrites it with only `state`
// changed (so the shared UPDATE mechanic does the write). Does NOT apply the DL-24 assignTo directive — a human
// board move is an explicit state set (that directive is the agent save_issue path's).
export function moveTicket(db: DatabaseSync, projectId: string, actor: string, id: string, toState: string): WriteResult {
  if (!STATES.includes(toState as State)) return { ok: false, status: 400, error: `invalid state '${toState}'; one of ${STATES.join(", ")}` };
  const cur = rowFor(db, projectId, id);
  if (!cur) return { ok: false, status: 404, error: `no such ticket ${id}` };
  return updateTicketRow(db, projectId, actor, id, cur.state, { ...cur, state: toState }); // propagates the DL-38 gate
}

// Assign (or unassign) a ticket. Empty/whitespace → unassigned (null); a non-empty handle must be a known actor
// (mirrors the MCP unknown-assignee guard) — no "me" alias here (a web form names a handle). Reads the row and
// rewrites it with only `assignee` changed (state unchanged ⇒ the shared mechanic logs issue.update).
export function assignTicket(db: DatabaseSync, projectId: string, actor: string, id: string, assignee: string): WriteResult {
  const cur = rowFor(db, projectId, id);
  if (!cur) return { ok: false, status: 404, error: `no such ticket ${id}` };
  const raw = (assignee ?? "").trim();
  const resolved = raw === "" ? null : raw;
  if (resolved !== null && !actorExists(db, resolved)) return { ok: false, status: 400, error: `unknown assignee '${resolved}'` };
  return updateTicketRow(db, projectId, actor, id, cur.state, { ...cur, assignee: resolved }); // assignee-only ⇒ no transition ⇒ gate never fires
}
