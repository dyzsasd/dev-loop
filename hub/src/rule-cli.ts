#!/usr/bin/env node
// `dev-loop rule <id> approve|reject|defer --reason "<the human's words>"` — the operator's ONE-SHOT ruling
// (WS-C harness control, review 3 of C5). Design record: references/operator-rulings.md.
//
// WHY ONE VERB. The ruling grammar shipped as a documented two-step — `comment add … "Ruling: …"` then a
// separate state verb — with nothing holding the two together. Each half alone is a failure the loop
// cannot see: a ruling comment with no state move leaves the ticket parked forever with an answer
// nobody acts on (the daemon keeps reminding, PM cannot move an operator-parked ticket); a state move
// with no ruling comment is a silent override PM's next fire reads as its own mistake to repair. And
// the doc's "leaving Human-Blocked IS the waiting_on clear" was a claim the write layer did not make
// (ticketwrite.ts now does). This verb composes the SAME two ops every sugar verb uses — the validated
// `Ruling:` comment first (the op layer refuses it from any agent identity), then the transition the
// rulings table prescribes — through cli-agentops' openHub/runOp seam, so it routes identically at home,
// over hub.transport:"daemon", and over an attach. No policy is re-implemented here: every gate
// (terminal-state reopen, verify, design-parent, handoff) still runs inside save_issue.
//
// OPERATOR-ONLY, the approvals-cli way (design approvals §2): refused inside a fire before anything is
// read, with NO flag/token/env that would let the caller proceed — a guard that documents its own
// bypass documents it to the party being guarded. The op layer's human-actor check is the second half
// (an agent handle outside a fire is refused there too, 403).
//
// An <id> that is an approval uuid DELEGATES to approvals-cli (`approve --request` / `revoke`) rather
// than re-implementing the store: those verbs carry the grantor-is-human rule, the expiry default and
// the scope refusals, and they are home-only by design (direct-db) — so that arm refuses over an attach.
//
// EXIT CODES: 0 ok · 1 domain (the op said no; body on stderr) · 2 usage · 4 refused inside a fire /
// identity · 5 hub unavailable.
import { isMainEntry } from "./is-entry.ts";
import { activeFireMarker } from "./destructive-guard.ts"; // the ONE fire-marker list, owned there
import { STATES, actorIsHuman, listHumanActorHandles } from "./db.ts";
import { openHub, runOp } from "./cli-agentops.ts";
import { approvalsCmd } from "./approvals-cli.ts";
import { RULING_VERDICTS, rulingBody, type RulingVerdict } from "./ticketwrite.ts";

const WAITING_ON = ["human-decision", "human-action", "external"] as const;
const DEFER_WAITING_ON_DEFAULT = "external"; // "not now; the reason says what would change the answer" — a date, a dependency, a decision elsewhere
const TERMINAL = new Set(["Done", "Canceled"]);
/** The shape `randomUUID()` writes into `approvals.id` — how an approval-id is told from a ticket id. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── the table (references/operator-rulings.md), as code ─────────────────────────────────────────
export interface RulingPlan { state: string; waitingOn?: string; assignee?: string; reason: string; next: string }
/**
 * What ONE ruling does to ONE ticket. Pure: the caller supplies the current row and the flags.
 *   approve → Todo (back in the pick set); Done when the item is In Review@operator (the acceptance edge);
 *             a Done/Canceled ticket REOPENS to Todo (operator-only in the write layer) and the reason is
 *             prefixed `reopen:` — the documented grammar for that ruling.
 *   reject  → Canceled (terminal; Sweep reaps the worktree). `--to Todo` = rework on an In Review item.
 *   defer   → stays (or becomes) Human-Blocked with waiting_on set (default `external`); `--to Backlog`
 *             is the "out of the pick set, PM re-ranks" alternative.
 * A ticket leaving the queue for Todo/Backlog while still assigned to the operator is UNASSIGNED: the
 * dev pick predicate is assignee-based (§18), so an operator-assigned Todo ticket is in nobody's slice.
 */
export function planRuling(verdict: RulingVerdict, cur: { state: string; assignee: string | null }, reason: string, to?: string, waitingOn?: string): RulingPlan | string {
  const state = to ?? (verdict === "approve" ? (cur.state === "In Review" ? "Done" : "Todo") : verdict === "reject" ? "Canceled" : "Human-Blocked");
  if (waitingOn !== undefined && state !== "Human-Blocked") return `--waiting-on only applies when the ruling leaves the ticket Human-Blocked (this one goes to ${state})`;
  const plan: RulingPlan = { state, reason, next: "" };
  if (state === "Human-Blocked") {
    plan.waitingOn = waitingOn ?? DEFER_WAITING_ON_DEFAULT;
    if (cur.state !== "Human-Blocked") plan.assignee = "operator";
    plan.next = `stays in your decision queue as ${plan.waitingOn}; nothing auto-unparks it — rule again when the condition in your reason is met`;
  } else if (state === "Todo" || state === "Backlog") {
    if (cur.assignee === "operator") plan.assignee = "";
    plan.next = state === "Todo" ? "back in the dev pick set; PM sees the Ruling: comment on its next verify pass" : "out of the pick set; PM re-ranks it on its next backlog pass with your reason attached";
  } else if (state === "Done") plan.next = "throughput counts it; the acceptance edge is recorded";
  else if (state === "Canceled") plan.next = "terminal; Sweep reaps the worktree; reopening later is a ruling too";
  else plan.next = `moved to ${state}`;
  if (TERMINAL.has(cur.state) && !TERMINAL.has(state) && !/^reopen:/i.test(reason)) plan.reason = `reopen: ${reason}`;
  return plan;
}

// ─── arg parsing (the approvals-cli rules: a repeated / empty / dangling flag is a usage error) ────
interface Parsed { pos: string[]; flags: Record<string, string | true>; error: string | null }
const VALUE_FLAGS = new Set(["reason", "to", "waiting-on", "project"]);
const BOOL_FLAGS = new Set(["json", "help"]);
export function parseArgs(argv: readonly string[]): Parsed {
  const pos: string[] = []; const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--")) {
      if (a.trim() === "") return { pos, flags, error: "an argument is empty — an unset shell variable expands to nothing, and a ruling must not land on the part that was left out" };
      pos.push(a); continue;
    }
    const eq = a.indexOf("="); const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOL_FLAGS.has(name)) { if (eq >= 0) return { pos, flags, error: `--${name} takes no value` }; flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) return { pos, flags, error: `unknown flag '--${name}'` };
    if (Object.hasOwn(flags, name)) return { pos, flags, error: `--${name} was given more than once — the two values contradict each other, so neither is assumed` };
    const raw = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    if (raw === undefined) return { pos, flags, error: `--${name} needs a value` };
    if (eq < 0 && raw.startsWith("--")) return { pos, flags, error: `--${name} needs a value, but the next argument is the flag '${raw}' (write --${name}=<value> if the value really starts with '--')` };
    // A reason is shown to PM, the digest and the next human verbatim; a control character (other than a
    // newline/tab in a longer reason) would let the line read as something it is not.
    if (/[^\P{Cc}\n\t]|\p{Cf}/u.test(raw)) return { pos, flags, error: `--${name} contains a control character — the ruling is read back later exactly as written, so it must be exactly what it looks like` };
    if (raw.trim() === "") return { pos, flags, error: `--${name} is empty — omit it if you mean to omit it` };
    flags[name] = raw; if (eq < 0) i++;
  }
  return { pos, flags, error: null };
}
const str = (f: Record<string, string | true>, k: string): string | undefined => typeof f[k] === "string" ? (f[k] as string) : undefined;

const USAGE = `dev-loop rule <ticket-id> approve|reject|defer --reason "<the human's words>" [--to <state>]
                                    [--waiting-on human-decision|human-action|external] [--project <key>] [--json]
dev-loop rule <approval-id> approve|reject --reason "<words>" [--json]

  Rule on ONE decision-queue item in ONE call: the validated \`Ruling: <verdict> — <reason>\` comment
  (the record every later reader finds) AND the state verb the rulings table prescribes. Both or
  neither: a ruling nobody acts on, or a move nobody explained, is not an available argv.

  OPERATOR-ONLY — refused inside an agent fire (exit 4) by design, with no flag that lets a fire
  through; the op layer also refuses a Ruling: comment from any agent identity.

  ticket, by current state:        approve            reject              defer
    Human-Blocked (the park)   →   Todo               Canceled            stays; waiting_on := --waiting-on (external)
    In Review @operator        →   Done               Canceled (--to Todo = rework)   Human-Blocked (external)
    Done / Canceled (reopen)   →   Todo, reason prefixed "reopen:"   —   —
  --to <state> overrides the target (e.g. defer --to Backlog: PM re-ranks it). A Todo/Backlog target still
  assigned to the operator is unassigned so the dev tiers can pick it (§18). waiting_on is cleared by the
  write layer on every exit from Human-Blocked and defaults to human-decision on every entry.

  approval-id (a uuid from \`dev-loop approvals\` / status.decisionQueue.approvalRequests):
    approve → dev-loop approve --request <id> --note "<reason>"      reject → dev-loop revoke <id> --note "<reason>"
    defer   → nothing to run: an approval request just stays pending, ageing, until you rule.
    Home-only (direct-db), so this arm refuses over an attach.

  System proposals keep their own verb: dev-loop system resolve <id> --status accepted|rejected|applied.

Exit codes: 0 ok · 1 domain (the op refused; its body on stderr) · 2 usage · 4 refused inside a fire /
identity · 5 hub unavailable.`;

function flush(): Promise<void> { return new Promise<void>((r) => process.stdout.write("", () => r())); }
async function exit(code: number): Promise<never> { await flush(); process.exit(code); }
const fail = async (msg: string): Promise<never> => { console.error(`dev-loop rule: ${msg}`); return exit(2); };

export async function ruleCmd(argv: readonly string[]): Promise<never> {
  const { pos, flags, error } = parseArgs(argv);
  if (flags.help === true || (!pos.length && !error)) { console.log(USAGE); return exit(flags.help === true ? 0 : 2); }
  if (error) return fail(error);

  // ── THE INVARIANT — checked FIRST, before the id is parsed, before any db opens ─────────────────
  const marker = activeFireMarker();
  if (marker) {
    console.error(`dev-loop rule: refusing inside an agent fire (${marker} is set). A ruling is the human's act — the record is only worth reading because a fire cannot write one. Nothing has been read or written. To ask for a ruling, park the ticket Human-Blocked with a Bail-shape comment; the operator rules from their own console.`);
    return exit(4);
  }

  const [id, verdictRaw, ...extra] = pos;
  if (!id || !verdictRaw) return fail(`usage: dev-loop rule <id> ${RULING_VERDICTS.join("|")} --reason "<why>" (run: dev-loop rule --help)`);
  if (extra.length) return fail(`unexpected argument '${extra[0]}'`);
  if (!(RULING_VERDICTS as readonly string[]).includes(verdictRaw)) return fail(`the ruling must be one of ${RULING_VERDICTS.join(", ")} (got '${verdictRaw}')`);
  const verdict = verdictRaw as RulingVerdict;
  const reason = str(flags, "reason");
  if (!reason) return fail(`--reason "<the human's words>" is required — the record must read back later without this conversation`);
  const json = flags.json === true;

  // ── an approval request: delegate, never duplicate ────────────────────────────────────────────
  if (UUID.test(id)) {
    if (process.env.DEVLOOP_HUB_URL?.trim()) return fail(`'${id}' is an approval id, and approvals are ruled at the WORKSPACE HOME (direct-db verbs) — run this on the home host, not over an attach (DEVLOOP_HUB_URL is set)`);
    for (const f of ["to", "waiting-on", "project"]) if (str(flags, f) !== undefined) return fail(`--${f} does not apply to an approval id — the stored request already carries its key, ticket and scope`);
    if (verdict === "defer") return fail(`an approval request has no defer: nothing waits on it (the fire moved on), so it simply stays in the queue until you approve or reject it — leave it, or: dev-loop revoke ${id} --note "<why>"`);
    const args = verdict === "approve" ? ["approve", "--request", id, "--note", reason] : ["revoke", id, "--note", reason];
    if (json) args.push("--json");
    return exit(approvalsCmd(args));
  }

  // ── a ticket: comment, then the transition — through the ONE seam every sugar verb uses ──────────
  const to = str(flags, "to");
  if (to !== undefined && !(STATES as readonly string[]).includes(to)) return fail(`--to must be one of: ${STATES.join(", ")} (got '${to}')`);
  const waitingOn = str(flags, "waiting-on");
  if (waitingOn !== undefined && !(WAITING_ON as readonly string[]).includes(waitingOn)) return fail(`--waiting-on must be one of: ${WAITING_ON.join(", ")} (got '${waitingOn}')`);
  if (waitingOn !== undefined && verdict !== "defer") return fail(`--waiting-on only applies to defer — approve/reject leave Human-Blocked, and the write layer clears waiting_on on the way out`);
  const hub = openHub();
  // G2 (the approvals-cli question): the caller is a HUMAN, not merely a known actor. Over an attach the
  // remote op layer answers the same question (403 → exit 1); at home, answer it before any write.
  if (hub.db && !actorIsHuman(hub.db, hub.actor)) {
    console.error(`dev-loop rule: DEVLOOP_ACTOR='${hub.actor}' is an agent identity, and a ruling is the human's act — a ruling recorded against an agent would be read by PM's next pass as the human's answer. Human identities in this workspace: ${listHumanActorHandles(hub.db).join(", ") || "(none seeded)"}. Nothing has been written.`);
    return exit(4);
  }
  const project = str(flags, "project");
  const scoped = (a: Record<string, unknown>): Record<string, unknown> => (project !== undefined ? { ...a, project } : a);
  const got = await runOp(hub, "get_issue", scoped({ id }));
  if (got.status < 200 || got.status >= 300) { console.error(JSON.stringify(got.body)); return exit(1); }
  const cur = got.body as { state: string; assignee: string | null; waiting_on: string | null };
  const plan = planRuling(verdict, cur, reason, to, waitingOn);
  if (typeof plan === "string") return fail(plan);

  const comment = await runOp(hub, "save_comment", scoped({ issueId: id, body: rulingBody(verdict, plan.reason) }));
  if (comment.status < 200 || comment.status >= 300) { console.error(JSON.stringify(comment.body)); return exit(1); }

  // The comment above already CLEARED waiting_on on a Human-Blocked ticket (the op layer's ruling record),
  // so a defer always re-sets it explicitly — never "keep what was there", which is now null.
  const update: Record<string, unknown> = { id };
  if (plan.state !== cur.state) update.state = plan.state;
  if (plan.waitingOn !== undefined) update.waitingOn = plan.waitingOn;
  if (plan.assignee !== undefined) update.assignee = plan.assignee;
  let ticket: unknown = got.body;
  if (Object.keys(update).length > 1) {
    const moved = await runOp(hub, "save_issue", scoped(update));
    if (moved.status < 200 || moved.status >= 300) {
      console.error(JSON.stringify(moved.body));
      console.error(`dev-loop rule: the ruling comment is recorded (${(comment.body as { id: string }).id}) but the state verb was refused — the ticket is still ${cur.state}. Fix the cause above, then finish it: dev-loop ticket update ${id} --state ${plan.state}`);
      return exit(1);
    }
    ticket = moved.body;
  }
  const t = ticket as { state: string; waiting_on: string | null; assignee: string | null };
  if (json) {
    console.log(JSON.stringify({ id, ruling: verdict, reason: plan.reason, from: cur.state, to: t.state, waitingOn: t.waiting_on, assignee: t.assignee, next: plan.next, comment: comment.body, ticket }));
  } else {
    console.log(`ruled ${verdict} on ${id}: ${cur.state} → ${t.state}${t.state === "Human-Blocked" ? ` (waiting_on: ${t.waiting_on})` : ""}  ·  comment ${(comment.body as { id: string }).id}`);
    console.log(`  next: ${plan.next}`);
  }
  return exit(0);
}

if (isMainEntry(import.meta.url)) await ruleCmd(process.argv.slice(2));
