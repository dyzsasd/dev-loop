// queue op tests — the task-shaped per-agent read (conventions-to-code: §5/§21b in code).
// Contracts: (1) dev tiers get THEIR slice only, §5-ranked (urgent bug → urgent feature →
// edge-case bug → bug → feature → improvement, FIFO within rank), `blocked` excluded, plus
// their own In Progress; (2) pm gets verify/unblock/backlog + the §5a todoDepth cap input;
// (3) qa gets verify + the project's blocked set; (4) other actors are refused 400;
// (5) summaries only — no description bodies ride the lists.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { insertTicket } from "../src/ticketwrite.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";
import { servableSlice, isDevTierActor } from "../src/servable.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const dir = mkdtempSync(join(tmpdir(), "devloop-queue-"));
const db = openDb(join(dir, "hub.db"));
const projectId = ensureSeed(db, "qproj", "Queue Project", "QQ");

interface T { title: string; type?: string; state?: string; assignee?: string | null; priority?: number; labels?: string[]; description?: string }
const mk = (t: T): string => insertTicket(db, projectId, "pm", {
  title: t.title, description: t.description ?? "body text", type: t.type ?? "Feature",
  state: (t.state ?? "Todo") as never, assignee: t.assignee ?? null, priority: t.priority ?? 0,
  labels: t.labels ?? ["dev-loop"], duplicateOf: null, relatedTo: [],
}, { title: t.title, type: t.type });

// the junior slice, filed out of pick order on purpose (queue must re-rank)
mk({ title: "improvement", type: "Improvement", assignee: "junior-dev" });
mk({ title: "feature", type: "Feature", assignee: "junior-dev" });
mk({ title: "plain bug", type: "Bug", assignee: "junior-dev" });
mk({ title: "edge bug", type: "Bug", assignee: "junior-dev", labels: ["dev-loop", "edge-case"] });
mk({ title: "urgent feature", type: "Feature", assignee: "junior-dev", priority: 1 });
mk({ title: "urgent bug", type: "Bug", assignee: "junior-dev", priority: 1 });
mk({ title: "blocked one", type: "Bug", assignee: "junior-dev", labels: ["dev-loop", "blocked"] });
mk({ title: "senior ticket", type: "Feature", assignee: "senior-dev" });
mk({ title: "junior wip", type: "Bug", state: "In Progress", assignee: "junior-dev" });
// pm/qa surfaces
mk({ title: "pm verify", state: "In Review", labels: ["dev-loop", "pm"] });
mk({ title: "qa verify", state: "In Review", labels: ["dev-loop", "qa"] });
mk({ title: "pm unblock", state: "Todo", labels: ["dev-loop", "blocked", "needs-pm"] });
mk({ title: "idea", state: "Backlog", labels: ["dev-loop", "pm"] });
mk({ title: "terminal blocked", state: "Canceled", labels: ["dev-loop", "blocked", "needs-pm"] });

const call = (actor: string): { status: number; body: Record<string, unknown> } => {
  const r = agentOp("queue", db, projectId, "qproj", actor, {}) as OpResult;
  return { status: r.status, body: r.body as Record<string, unknown> };
};
const titles = (rows: unknown): string[] => (rows as { title: string }[]).map((r) => r.title);

// ── 1. junior slice: §5 ranking, blocked excluded, senior's ticket invisible ─────────────────────
const jr = call("junior-dev");
ok(jr.status === 200, "junior-dev queue returns 200");
ok(JSON.stringify(titles(jr.body.todo)) === JSON.stringify(["urgent bug", "urgent feature", "edge bug", "plain bug", "feature", "improvement"]),
  `todo is the §5 pick order exactly (got: ${titles(jr.body.todo).join(" → ")})`);
ok(!titles(jr.body.todo).includes("blocked one"), "a `blocked` ticket never enters the pick set (§9)");
ok(!titles(jr.body.todo).includes("senior ticket"), "the senior slice is invisible to junior (§21b encoding)");
ok(JSON.stringify(titles(jr.body.inProgress)) === JSON.stringify(["junior wip"]), "own In Progress rides along (Step-0 orphan input)");
ok((jr.body.todo as { description: string }[]).every((t) => t.description === ""), "summaries only — no description bodies");

// FIFO within rank: a second urgent bug filed later sorts after the first
mk({ title: "urgent bug 2", type: "Bug", assignee: "junior-dev", priority: 1 });
ok(titles(call("junior-dev").body.todo).indexOf("urgent bug") < titles(call("junior-dev").body.todo).indexOf("urgent bug 2"),
  "FIFO within a rank (oldest first — no starvation)");

// ── 2. senior slice ───────────────────────────────────────────────────────────────────────────────
ok(JSON.stringify(titles(call("senior-dev").body.todo)) === JSON.stringify(["senior ticket"]), "senior sees exactly its own slice");

// ── 2a. servableSlice: the SHARED predicate the scheduler's queue-depth fire-gate (LOOP-144) consumes
//    DIRECTLY. Asserting it here — not only through the queue op — proves a scheduler re-implementation can't
//    silently diverge from §5/§21b routing (AC1), and pins the two servability rules the gate depends on:
//    a `blocked` Todo is not work, and an own In Progress row IS (the Step-0 orphan-resume input). ─────────────
const srSlice = servableSlice(db, projectId, "senior-dev");
ok(JSON.stringify(titles(srSlice.todo)) === JSON.stringify(["senior ticket"]), "servableSlice(senior).todo = its own slice");
ok(srSlice.inProgress.length === 0, "servableSlice(senior).inProgress empty here (no own In Progress row)");
const jrSlice = servableSlice(db, projectId, "junior-dev");
ok(!titles(jrSlice.todo).includes("blocked one"), "servableSlice(junior): a `blocked` Todo is NOT servable (would-be starvation avoided)");
ok(!titles(jrSlice.todo).includes("senior ticket"), "servableSlice(junior): the senior slice is not servable to junior");
ok(JSON.stringify(titles(jrSlice.inProgress)) === JSON.stringify(["junior wip"]), "servableSlice(junior).inProgress = own In Progress (the Step-0 orphan-resume input the gate must still fire on)");
ok(JSON.stringify(titles(jrSlice.todo)) === JSON.stringify(titles(call("junior-dev").body.todo)),
  "PARITY: servableSlice(junior).todo ≡ queue op todo — the gate and the op share ONE predicate, not a copy (LOOP-144 AC1)");
ok(isDevTierActor("dev") && isDevTierActor("senior-dev") && isDevTierActor("junior-dev") && !isDevTierActor("pm") && !isDevTierActor("qa") && !isDevTierActor("architect"),
  "isDevTierActor: the three dev tiers only — pm/qa/architect are never queue-gated");

// ── 3. pm lists + todoDepth ───────────────────────────────────────────────────────────────────────
const pm = call("pm");
ok(titles(pm.body.verify).includes("pm verify") && !titles(pm.body.verify).includes("qa verify"), "pm verify = In Review + pm label only");
ok(JSON.stringify(titles(pm.body.unblock)) === JSON.stringify(["pm unblock"]), "pm unblock = blocked+needs-pm, terminal states excluded");
ok(titles(pm.body.backlog).includes("idea"), "pm backlog = the groom queue");
const depth = pm.body.todoDepth as { total: number; "senior-dev": number; "junior-dev": number; dev: number };
ok(depth["junior-dev"] === 7 && depth.total >= 8 && depth.dev >= 0,
  `todoDepth counts unblocked Todo per tier (junior=${depth["junior-dev"]}, total=${depth.total}, dev=${depth.dev})`);
ok("dev" in depth, "todoDepth carries a `dev` key (LOOP-251)");

// ── 4. qa lists ───────────────────────────────────────────────────────────────────────────────────
const qa = call("qa");
ok(titles(qa.body.verify).includes("qa verify") && !titles(qa.body.verify).includes("pm verify"), "qa verify = In Review + qa label only");
ok(titles(qa.body.blocked).includes("pm unblock") && titles(qa.body.blocked).includes("blocked one") && !titles(qa.body.blocked).includes("terminal blocked"),
  "qa blocked = every non-terminal blocked ticket (Job B routes by bail-shape)");

// ── 4a. Mode:design routing (LOOP-59) — design parent routes to PM regardless of label ──────────
// Mirrors LOOP-48's shape: filed with qa label (no pm); senior-dev added Mode:design marker.
// Queue-side guard must override the stale label: PM sees it, QA never does.
mk({ title: "design parent stale label", state: "In Review",
  labels: ["dev-loop", "qa", "senior-dev"],
  description: "Mode: design\n\nTwo children: LOOP-54 / LOOP-55.\n" });
const pmDesign = call("pm");
ok(titles(pmDesign.body.verify).includes("design parent stale label"),
  "LOOP-59: Mode:design parent routes into pm.verify regardless of stale qa label");
ok(titles(pmDesign.body.verify).includes("pm verify"),
  "LOOP-59: existing pm-labelled ticket still in pm.verify (no regression)");
const qaDesign = call("qa");
ok(!titles(qaDesign.body.verify).includes("design parent stale label"),
  "LOOP-59: Mode:design parent excluded from qa.verify (QA has no design-gate authority)");
ok(titles(qaDesign.body.verify).includes("qa verify"),
  "LOOP-59: normal qa-labelled ticket still in qa.verify (no regression)");

// ── 4b. Child-pointer design routing (LOOP-294) — reverse link when body-prefix not written ────
// LOOP-286 shape: In Review, Bug, qa label, NO Mode:design body, plus a Backlog child
// whose description says `Design: parent <parent-id>`. Today this parent incorrectly routes
// to qa.verify (and NOT to pm.verify) — the exact inverse of the correct routing.
const parentId = mk({ title: "design parent via child", state: "In Review",
  labels: ["dev-loop", "Bug", "qa", "senior-dev"],
  description: "bug description, not Mode: design" });
const childId = mk({ title: "staged child", state: "Backlog", assignee: "junior-dev",
  labels: ["dev-loop", "qa"],
  description: `Design: parent ${parentId}\n\nbody` });
// Wire the child's relatedTo to the parent id
db.prepare("UPDATE tickets SET related_to=? WHERE id=?").run(JSON.stringify([parentId]), childId);
const pmWithChild = call("pm");
ok(titles(pmWithChild.body.verify).includes("design parent via child"),
  "LOOP-294 AC2: child-link design parent routes into pm.verify (reverse link)");
const qaWithChild = call("qa");
ok(!titles(qaWithChild.body.verify).includes("design parent via child"),
  "LOOP-294 AC2: child-link design parent excluded from qa.verify (no QA gate authority)");
// LOOP-59 regression: Mode:design body still routes correctly (no child needed)
ok(titles(pmWithChild.body.verify).includes("design parent stale label"),
  "LOOP-294 AC3: Mode:design parent still routes to pm.verify (LOOP-59 regression guard)");
ok(!titles(qaWithChild.body.verify).includes("design parent stale label"),
  "LOOP-294 AC3: Mode:design parent still excluded from qa.verify (LOOP-59 regression guard)");
// AC4: ordinary tickets untouched
ok(titles(pmWithChild.body.verify).includes("pm verify"),
  "LOOP-294 AC4: ordinary pm-labelled ticket still in pm.verify");
ok(titles(qaWithChild.body.verify).includes("qa verify"),
  "LOOP-294 AC4: ordinary qa-labelled ticket still in qa.verify");
ok(!titles(pmWithChild.body.verify).includes("qa verify"),
  "LOOP-294 AC4: ordinary qa-labelled ticket NOT in pm.verify");
// ── 5. refusals ───────────────────────────────────────────────────────────────────────────────────
ok(call("reflect").status === 400, "queue refuses actors without a pick contract (reflect)");

// ── 6. tier-label ⇒ assignee derivation on create (field regression, 2026-07-22/23) ──────────────
// A `senior-dev`/`junior-dev` LABEL with assignee:null used to strand the ticket outside every
// assignee-based queue slice (§18). save_issue now materializes the tier label as the assignee at
// create time — an explicit assignee still wins, and unlabeled tickets stay unassigned.
const create = (args: Record<string, unknown>): OpResult =>
  agentOp("save_issue", db, projectId, "qproj", "architect", args) as unknown as OpResult;
const derived = create({ title: "design: contracts package", labels: ["dev-loop", "Improvement", "qa", "senior-dev"] });
ok(derived.status === 200 && (derived.body as { assignee?: string }).assignee === "senior-dev",
  "create with senior-dev LABEL and no assignee derives assignee=senior-dev");
const derivedJr = create({ title: "refactor: hoist shared types", labels: ["dev-loop", "junior-dev"] });
ok((derivedJr.body as { assignee?: string }).assignee === "junior-dev",
  "create with junior-dev LABEL and no assignee derives assignee=junior-dev");
const explicitWins = create({ title: "explicit beats label", labels: ["dev-loop", "junior-dev"], assignee: "senior-dev" });
ok((explicitWins.body as { assignee?: string }).assignee === "senior-dev",
  "an explicit assignee beats the tier label");
const noTier = create({ title: "no tier label", labels: ["dev-loop"] });
ok((noTier.body as { assignee?: string | null }).assignee === null,
  "no tier label ⇒ assignee stays null (unchanged behavior)");
const derivedInQueue = call("senior-dev");
ok(titles(derivedInQueue.body.todo).includes("design: contracts package"),
  "the derived ticket lands in the senior queue slice (the strand is gone)");

// ── 7. §8 exact-title dedupe on create (1.8 — field regression MEETPOIN-98/103) ──────────────────
const dupHit = create({ title: "design: contracts package", labels: ["dev-loop"] });
ok(dupHit.status === 409 && /already exists/.test(String((dupHit.body as { error?: string }).error ?? JSON.stringify(dupHit.body))),
  `an exact-title duplicate of a NON-TERMINAL ticket is refused 409 (got ${dupHit.status})`);
const dupSpaced = create({ title: "  DESIGN: Contracts Package  ", labels: ["dev-loop"] });
ok(dupSpaced.status === 409, "dedupe normalizes trim+case (spaced/uppercased variant also 409)");
const dupForced = create({ title: "design: contracts package", labels: ["dev-loop"], allowDuplicate: true });
ok(dupForced.status === 200, "allowDuplicate:true is the deliberate-refile escape hatch");
const doneId = create({ title: "was done once", labels: ["dev-loop"] });
agentOp("save_issue", db, projectId, "qproj", "pm", { id: (doneId.body as { id: string }).id, state: "Done" });
ok(create({ title: "was done once", labels: ["dev-loop"] }).status === 200,
  "a TERMINAL (Done) ticket's title is free to reuse (dedupe is non-terminal only)");

// ── 8. inReview — LOOP-112: the dev tier's landing/repair list ───────────────────────────────────
// Seed one In Review ticket per assignee (junior-dev, senior-dev, pm) to confirm isolation.
// Also seed a sensitive In Review ticket for junior to confirm the Layer-2 filter applies.
{
  mk({ title: "ir-junior", state: "In Review", assignee: "junior-dev", labels: ["dev-loop", "qa", "junior-dev"] });
  mk({ title: "ir-senior", state: "In Review", assignee: "senior-dev", labels: ["dev-loop", "qa", "senior-dev"] });
  mk({ title: "ir-pm", state: "In Review", assignee: "pm", labels: ["dev-loop", "pm"] });
  mk({ title: "ir-sensitive", state: "In Review", assignee: "junior-dev", labels: ["dev-loop", "sensitive", "qa", "junior-dev"] });

  const jrQ = call("junior-dev");
  const srQ = call("senior-dev");

  // (a) each dev tier sees only its own In Review tickets
  ok(titles(jrQ.body.inReview).includes("ir-junior"),
    "LOOP-112: junior inReview contains its own In Review ticket");
  ok(!titles(jrQ.body.inReview).includes("ir-senior"),
    "LOOP-112: junior inReview does NOT contain senior's In Review ticket");
  ok(!titles(jrQ.body.inReview).includes("ir-pm"),
    "LOOP-112: junior inReview does NOT contain pm-assigned In Review ticket (AC3)");

  // (b) senior sees only its own
  ok(titles(srQ.body.inReview).includes("ir-senior"),
    "LOOP-112: senior inReview contains its own In Review ticket");
  ok(!titles(srQ.body.inReview).includes("ir-junior"),
    "LOOP-112: senior inReview does NOT contain junior's In Review ticket");
  ok(!titles(srQ.body.inReview).includes("ir-pm"),
    "LOOP-112: senior inReview does NOT contain pm-assigned In Review ticket");

  // (c) Layer-2 filter: sensitive In Review is excluded from junior
  ok(!titles(jrQ.body.inReview).includes("ir-sensitive"),
    "LOOP-112: sensitive In Review ticket is excluded from junior inReview (Layer-2)");

  // (d) todo and inProgress are UNCHANGED — inReview never adds to the pick list
  ok(!titles(call("junior-dev").body.todo).includes("ir-junior"),
    "LOOP-112: an In Review ticket does not appear in todo (not a pick list, AC4)");
  ok(!titles(call("junior-dev").body.inProgress).includes("ir-junior"),
    "LOOP-112: an In Review ticket does not appear in inProgress (AC4)");

  // (e) pm/qa branch is unchanged — no inReview key added to pm/qa response
  ok((call("pm").body as Record<string, unknown>).inReview === undefined,
    "LOOP-112: pm queue has no inReview key (pm/qa branch untouched, AC5)");
  ok((call("qa").body as Record<string, unknown>).inReview === undefined,
    "LOOP-112: qa queue has no inReview key (pm/qa branch untouched, AC5)");
}

// ── 9. LOOP-254: urgent Improvement gets a rank slot above ordinary Improvements ────────────────
// The §5 pick order read `priority` in only 2 of 6 ranks (both gated on `type`); every servable
// Improvement was rank 5, served pure created_at FIFO. Operator ruling (2026-08-01): a p1
// Improvement ranks strictly above ordinary Improvements and strictly below Features.
{
  // AC4: a LATER-created p1 Improvement must serve BEFORE an EARLIER-created p2 Improvement.
  // Create the p2 first (older), then the p1 (newer) — under today's rank-5-only both fall to
  // pure created_at FIFO, so the newer p1 sorts AFTER the older p2 → this assertion fails before
  // the fix (verify that before fixing, LOOP-254 AC4).
  mk({ title: "urgent improvement p2 (older)", type: "Improvement", assignee: "junior-dev", priority: 2 });
  mk({ title: "urgent improvement p1 (newer)", type: "Improvement", assignee: "junior-dev", priority: 1 });
  const order = titles(call("junior-dev").body.todo);
  ok(order.indexOf("urgent improvement p1 (newer)") < order.indexOf("urgent improvement p2 (older)"),
    "LOOP-254 AC4: a later-created p1 Improvement serves before an earlier-created p2 Improvement");
  // AC2 guard: ranks 0–4 relative order unchanged — the existing exact-order assertion above
  // (urgent bug → urgent feature → edge bug → plain bug → feature) still holds with the new rows:
  ok(order.indexOf("urgent bug") < order.indexOf("urgent feature")
    && order.indexOf("urgent feature") < order.indexOf("edge bug")
    && order.indexOf("edge bug") < order.indexOf("plain bug")
    && order.indexOf("plain bug") < order.indexOf("feature")
    && order.indexOf("feature") < order.indexOf("urgent improvement p1 (newer)"),
    "LOOP-254 AC2: ranks 0–4 relative order unchanged; urgent Improvement sits below Feature");
  // AC3: FIFO within the new rank — two p1 Improvements sort by created_at
  mk({ title: "urgent improvement p1 second", type: "Improvement", assignee: "junior-dev", priority: 1 });
  const order2 = titles(call("junior-dev").body.todo);
  ok(order2.indexOf("urgent improvement p1 (newer)") < order2.indexOf("urgent improvement p1 second"),
    "LOOP-254 AC3: FIFO within the new urgent-Improvement rank (oldest first)");
}

console.log(fails === 0 ? "\nQUEUE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
