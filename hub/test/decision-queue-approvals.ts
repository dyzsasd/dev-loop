// LOOP-393 (design approvals C3) — pending approval requests are TYPED entries in the operator's
// decision queue, not free-text prose.
//
// The suite asserts both directions of design §8's inertness claim: with zero approval rows the
// queue's payload is BYTE-identical to what it was before this change (so the unconditional
// rendering really is a no-op until first use), and with a pending row it appears on every surface
// the operator reads — `dev-loop metrics` (human + --json), the daemon reminder, and doctor's W20.
//
// In-process throughout: openDb on a temp file, no CLI spawn, so no fire-marker/env leak (LOOP-193)
// and no workspace resolution (LOOP-418) is involved. The two DB-reading surfaces take their handle
// as an argument, which is what makes that possible.
import { rmSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { decisionQueue, decisionItemEnteredAt, decisionEnteredAt, renderHuman, type DecisionItem } from "../src/metrics.ts";
import { requestApproval, grantApproval, revokeApproval } from "../src/approvals.ts";
import { checkDecisionQueueStall, describeDecisionOldest, nextStep } from "../src/doctor.ts";
import { blockedNotifyTick } from "../src/daemon-notifiers.ts";
import { operatorBrief } from "../src/operator-brief.ts";
import type { FetchImpl } from "../src/channel.ts";
import { tmpRoot } from "./tmp-root.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = tmpRoot("dl-dq-appr-");
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const KEY = "npm-publish:@dyzsasd/dev-loop:1.15.1";

function seed(name: string) {
  const db = openDb(join(tmp, name));
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','loop','loop','t')").run();
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p2','other','other','t')").run();
  const ticket = (id: string, pid: string, title: string, state: string, assignee: string | null, at: string) =>
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,'d','Feature',?,?,0,'[]','[]','pm',?,?)")
      .run(id, pid, title, state, assignee, at, at);
  ticket("T-1", "p", "approve me", "In Review", "operator", iso(NOW - 4 * DAY));
  ticket("T-2", "p", "parked", "Human-Blocked", null, iso(NOW - 2 * DAY));
  ticket("T-3", "p", "agent review", "In Review", "qa", iso(NOW - DAY));   // never the operator's
  ticket("T-9", "p2", "other project", "Human-Blocked", null, iso(NOW - DAY));
  return db;
}

try {
  // ── AC2 — the inertness claim, asserted rather than assumed ───────────────────────────────────
  // With zero approval rows the payload must be EXACTLY what the pre-LOOP-393 implementation
  // returned: the four keys, in order, and the two ticket entries oldest-first. This is the
  // mutation-killer for the whole change — adding `kind:"ticket"` to the ticket arm, reordering, or
  // interleaving requests ahead of tickets all fail here.
  const db = seed("inert.db");
  const EXPECTED_EMPTY = JSON.stringify([
    { id: "T-1", title: "approve me", state: "In Review", updatedAt: iso(NOW - 4 * DAY) },
    { id: "T-2", title: "parked", state: "Human-Blocked", updatedAt: iso(NOW - 2 * DAY) },
  ]);
  ok(JSON.stringify(decisionQueue(db, "p")) === EXPECTED_EMPTY,
    `AC2: with zero approval rows the payload is byte-identical to the pre-change shape (got ${JSON.stringify(decisionQueue(db, "p"))})`);

  // ── AC1 — a pending request joins the set, typed ───────────────────────────────────────────────
  const req = requestApproval(db, { projectId: "p", actionKey: KEY, requestedBy: "senior-dev", ticketId: "T-1" });
  db.prepare("UPDATE approvals SET requested_at=? WHERE id=?").run(iso(NOW - 6 * DAY), req.id);
  const dq = decisionQueue(db, "p");
  ok(dq.length === 3, `AC1: the request joins the existing two entries (got ${dq.length})`);
  const item = dq.find((i) => i.kind === "approval");
  ok(item !== undefined, "AC1: the request is present and carries the typed discriminator kind:'approval'");
  ok(item?.kind === "approval" && item.actionKey === KEY && item.ticketId === "T-1" && item.requestedBy === "senior-dev",
    `AC1: it carries its action key + attached ticket (got ${JSON.stringify(item)})`);
  ok(item?.kind === "approval" && item.id === req.id,
    "AC1: its id is the approval row's id — what `dev-loop approve --request <id>` takes");
  // The discriminator is what tells the arms apart — never a title parse. A ticket entry has no
  // `kind` key AT ALL (which is also what keeps AC2 true).
  ok(dq.filter((i) => i.kind === undefined).length === 2 && !Object.hasOwn(dq[0]!, "kind"),
    "AC1: ticket entries carry no `kind` key at all, so the discriminator is unambiguous");
  ok(JSON.stringify(dq.slice(0, 2)) === EXPECTED_EMPTY,
    "AC2: the existing entries keep their shape AND their order once a request is present");

  // ── AC3 — the wait is requested_at, through the shared reader ─────────────────────────────────
  ok(item?.kind === "approval" && item.enteredAt === iso(NOW - 6 * DAY),
    `AC3: enteredAt is the request's requested_at (got ${item?.kind === "approval" ? item.enteredAt : "n/a"})`);
  ok(decisionItemEnteredAt(db, item as DecisionItem) === iso(NOW - 6 * DAY),
    "AC3: decisionItemEnteredAt returns requested_at for a request");
  // The mutation this kills: routing a request through decisionEnteredAt (the ticket reader) dates
  // it to the epoch — its id is an approval uuid, so no ledger row and no tickets row match it, and
  // the fallback chain bottoms out at 1970. It would then be the permanent "oldest" on every board.
  ok(decisionEnteredAt(db, req.id, "requested") === new Date(0).toISOString(),
    "AC3 (mutation guard): the TICKET reader really does date an approval id to the epoch — so the split reader is load-bearing");
  ok(decisionItemEnteredAt(db, dq[0] as DecisionItem) === decisionEnteredAt(db, "T-1", "In Review"),
    "AC3: a ticket entry still resolves through the ledger reader, unchanged");

  // ── scope — each row lands in exactly one project's queue ─────────────────────────────────────
  ok(!decisionQueue(db, "p2").some((i) => i.kind === "approval"),
    "scope: a project-scoped request does not leak into another project's queue");
  const wsReq = requestApproval(db, { projectId: null, actionKey: "push:dev-loop/LOOP-1:abc123", requestedBy: "junior-dev", ticketId: "T-9" });
  ok(decisionQueue(db, "p2").some((i) => i.kind === "approval" && i.id === wsReq.id),
    "scope: a WORKSPACE-scoped request surfaces in the queue of the project owning its ticket");
  ok(!decisionQueue(db, "p").some((i) => i.kind === "approval" && i.id === wsReq.id),
    "scope: …and in that project ONLY — never duplicated across every project");

  // ── a ruled-on request leaves the queue ───────────────────────────────────────────────────────
  const granted = requestApproval(db, { projectId: "p", actionKey: "reopen:T-2", requestedBy: "pm", ticketId: "T-2" });
  grantApproval(db, { requestId: granted.id, grantor: "operator" });
  ok(!decisionQueue(db, "p").some((i) => i.kind === "approval" && i.id === granted.id),
    "a GRANTED request is no longer pending, so it leaves the queue");
  const killed = requestApproval(db, { projectId: "p", actionKey: "reopen:T-3", requestedBy: "pm", ticketId: "T-3" });
  revokeApproval(db, killed.id, "operator");
  ok(!decisionQueue(db, "p").some((i) => i.kind === "approval" && i.id === killed.id),
    "a REVOKED request leaves the queue too — the predicate is the shared derived state, not a hand-rolled one");

  // ── AC4 (metrics render) — the human line names the request by its action key ─────────────────
  const lines: string[] = [];
  const origLog = console.log;
  const fakeWs = { file: { team: { key: "loop" }, repos: {}, projects: {} } } as never;
  const fakeFires = { windowMs: 7 * DAY, fires: 0, failures: 0, timeouts: 0, suspectErrors: 0, interrupted: 0, discardedFires: 0, discardedCostUsd: null, successRate: null, byAgent: {}, byProject: {}, byErrorClass: {}, meteredFires: 0, costMeteredFires: 0, costUsd: null, meteringOnsetTs: null };
  const fakeRollup = { throughput: 0, verifyFails: 0, acceptRate: null, blockedNow: 0, sequencedNow: 0, bugsFiled: 0, escaped: 0 };
  console.log = (...args: unknown[]) => lines.push(String(args[0] ?? ""));
  try {
    renderHuman(fakeWs, 7 * DAY, fakeFires as never, {
      teamRollup: fakeRollup,
      decisionQueue: [{ ...(item as DecisionItem), project: "loop" }, { ...dq[0]!, project: "loop" }],
    }, NOW);
  } finally { console.log = origLog; }
  const dqLine = lines.find((l) => l.startsWith("decision queue")) ?? "";
  ok(dqLine.includes(`${KEY}[request] 6d`),
    `AC4: the metrics line labels a request by its action key + wait, not by a uuid (got: ${dqLine})`);
  ok(dqLine.includes("T-1[approve] 4d"), "AC4: the ticket entries render exactly as before");

  // ── AC5 — the console brief says how to rule on a typed request ───────────────────────────────
  const bullet = operatorBrief().split("\n- ").find((b) => b.includes("Your decision queue")) ?? "";
  ok(bullet.includes("dev-loop approve --request"),
    "AC5: the decision-queue bullet names `dev-loop approve --request <id>` for a typed request");
  ok(bullet.includes("dev-loop revoke"), "AC5: …and `dev-loop revoke` for ending one");
  ok(bullet.includes("kind") && bullet.includes("actionKey"),
    "AC5: …and tells the operator which field marks an approval entry, so they need not parse a title");

  // ── AC6 — doctor's W20 counts requests; a request-only queue is not an empty queue ────────────
  const warns: string[] = [];
  const ctx = {
    ws: { file: { team: { key: "loop", comms: { webhookEnv: "X" } }, repos: {}, projects: { loop: {} } }, root: tmp },
    opts: {}, boardDb: "", out: { pass: () => {}, fail: () => {}, warn: (m: string) => warns.push(m), info: () => {} },
    openBoardDb: () => db,
  } as never;
  // A board whose ONLY queue items are requests: park nothing, un-assign the operator ticket.
  const db2 = openDb(join(tmp, "reqonly.db"));
  db2.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','loop','loop','t')").run();
  db2.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-1','p','t','d','Feature','Todo','junior-dev',0,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  const only = requestApproval(db2, { projectId: "p", actionKey: KEY, requestedBy: "senior-dev", ticketId: "T-1" });
  db2.prepare("UPDATE approvals SET requested_at=? WHERE id=?").run(iso(Date.now() - 3 * DAY), only.id);
  const ctx2 = { ...(ctx as unknown as Record<string, unknown>), openBoardDb: () => db2 } as never;
  ok(decisionQueue(db2, "p").length === 1, "AC6 precondition: the board's only queue item is the request");
  const stall = checkDecisionQueueStall(ctx2);
  ok(stall !== null && stall.count === 1,
    `AC6: a queue holding ONLY approval requests is reported, not read as empty (got ${JSON.stringify(stall)})`);
  ok(warns.some((w) => w.startsWith("[W20]") && w.includes("approval request") && w.includes(KEY)),
    `AC6: W20 names the request by its action key (got ${JSON.stringify(warns)})`);
  ok(warns.some((w) => w.includes(`dev-loop approve --request ${only.id}`)) && !warns.some((w) => w.includes(`/ticket/${only.id}`)),
    "AC6: W20 prescribes the grant verb — never a /ticket/<approval-uuid> URL, which 404s");
  // The NEXT line must prescribe the SAME action W20 did — one computed answer threaded through,
  // not a second derivation that can drift. The fixture ws clears every rung above the day-2
  // decision rung (backend/project/repo/mode) so the queue hint is the line actually reached.
  const nextWs = { file: { team: { key: "loop", backend: "service", mode: "live" }, repos: { r: {} }, projects: { loop: {} } }, root: tmp } as never;
  const nextLine = nextStep(nextWs, [], [], undefined, stall);
  ok(nextLine.includes(`dev-loop approve --request ${only.id}`) && !nextLine.includes(`/ticket/${only.id}`),
    `AC6: the NEXT line prescribes the SAME action W20 did — one computed answer, threaded, not two (got: ${nextLine})`);
  // …and with no ruleOn computed (a caller predating this change) it is byte-identical to before.
  ok(nextStep(nextWs, [], [], undefined, { oldest: { id: "T-7", enteredAt: iso(NOW), state: "Human-Blocked" }, count: 1 })
    .includes("http://127.0.0.1:8787/ticket/T-7"),
    "AC6: a stall with no ruleOn keeps the original ticket-URL NEXT line");

  // describeDecisionOldest, both arms, directly — the ticket arm must stay byte-identical.
  // LOOP-481: "today's wording" is now the humanWrite:TRUE arm — the board CAN rule, so the URL is
  // the right prescription and must not have moved a byte.
  const t = describeDecisionOldest({ id: "T-1", title: "x".repeat(70), state: "Human-Blocked", updatedAt: "t" }, { humanWrite: true, projectKey: "loop" });
  ok(t.stateLabel === "blocked" && t.ruleOn === "http://127.0.0.1:8787/ticket/T-1" && t.named === `T-1 "${"x".repeat(57)}…"`,
    `ticket arm of the W20 renderer is unchanged (truncated at 60, board URL, blocked label) — got ${JSON.stringify(t)}`);

  // ── LOOP-481 AC3/AC4/AC5 — doctor must not prescribe a page that cannot perform the action ────
  //
  // The board's write forms sit behind the per-project `humanWrite.enabled` gate. Unset (the default,
  // and the state of every project in this workspace) that page renders zero `<form>`, so linking it
  // as the way to RULE is a dead end. Asserted on the RENDERED lines, per AC5: a test that read the
  // branch condition would pass with the emitted string still wrong.
  //
  // The assertion is not "the URL is absent" — AC4 keeps it as a READ link. It is "the URL is not the
  // PRESCRIBED action", so both arms are measured by extracting exactly the span each line offers as
  // the thing to do. That span is what a mutation swapping the arms would change.
  {
    const prescribedInW20 = (line: string) => line.split("— rule on it: ")[1]?.split("; full queue:")[0] ?? "";
    const prescribedInNext = (line: string) => line.split(/\): /)[1] ?? "";
    const URL_T5 = "http://127.0.0.1:8787/ticket/T-5";

    const mkStall = (dbName: string, humanWrite: boolean) => {
      const d = openDb(join(tmp, dbName));
      d.prepare("INSERT INTO projects(id,key,name,created_at,settings_json) VALUES('p','loop','loop','t',?)")
        // '{}' is the column's own DEFAULT — i.e. exactly what a real project row holds while the
        // operator has never touched the flag. Not NULL: the column is NOT NULL, and a fixture that
        // cannot exist on a live board proves nothing about one.
        .run(humanWrite ? JSON.stringify({ humanWrite: { enabled: true } }) : "{}");
      d.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-5','p','parked on the operator','d','Feature','Human-Blocked',NULL,0,'[]','[]','pm',?,?)")
        .run(iso(NOW - 2 * DAY), iso(NOW - 2 * DAY));
      const lines: string[] = [];
      const c = {
        ws: { file: { team: { key: "loop", comms: { webhookEnv: "X" } }, repos: {}, projects: { loop: {} } }, root: tmp },
        opts: {}, boardDb: "", out: { pass: () => {}, fail: () => {}, warn: (m: string) => lines.push(m), info: () => {} },
        openBoardDb: () => d,
      } as never;
      const s = checkDecisionQueueStall(c);
      return { stall: s, w20: lines.find((l) => l.startsWith("[W20]")) ?? "", next: nextStep(nextWs, [], [], undefined, s ?? undefined) };
    };

    // AC4/AC5 — flag unset. This FAILS on main, where both spans are the bare URL.
    const off = mkStall("hw-off.db", false);
    ok(off.stall !== null && off.w20 !== "", `AC5 precondition: the fixture produces a W20 line (got ${JSON.stringify(off.w20)})`);
    const offW20 = prescribedInW20(off.w20);
    ok(offW20.startsWith("dev-loop ") && !offW20.startsWith("http"),
      `AC4/AC5: with humanWrite off, W20 prescribes a CLI surface that can act — not the read-only page (prescribed: ${JSON.stringify(offW20)})`);
    ok(offW20.includes(`dev-loop ticket update T-5 --state`) && offW20.includes(`dev-loop comment add T-5`),
      `AC4: …and it names both halves of the ruling — the comment and the state move (got ${JSON.stringify(offW20)})`);
    ok(off.w20.includes("dev-loop settings set humanWrite.enabled true --project loop"),
      `AC4: …and how to make the board itself able to rule, naming this project (got ${JSON.stringify(off.w20)})`);
    ok(off.w20.includes(URL_T5),
      "AC4: the URL survives as a read link — the operator keeps the cheap way to LOOK, it just is not the prescribed action");
    const offNext = prescribedInNext(off.next);
    ok(offNext.startsWith("dev-loop ") && !offNext.startsWith("http"),
      `AC4/AC5: the NEXT line prescribes the same CLI surface — the two lines cannot disagree (got: ${JSON.stringify(off.next)})`);

    // AC3 — flag ON: the page can rule, so both lines keep today's URL wording, byte-identical.
    const on = mkStall("hw-on.db", true);
    ok(prescribedInW20(on.w20) === URL_T5,
      `AC3: with humanWrite ON, W20 prescribes exactly the board URL as before (got ${JSON.stringify(prescribedInW20(on.w20))})`);
    ok(prescribedInNext(on.next) === URL_T5,
      `AC3: …and so does the NEXT line (got ${JSON.stringify(on.next)})`);
  }

  // ── AC4 (daemon) — the reminder counts requests, once per cadence ─────────────────────────────
  const dbN = seed("notify.db");
  dbN.prepare("INSERT INTO channels(id,project_id,provider,config_ref,secret_ref,channel_ref,enabled,created_at,updated_at) VALUES('c','p','slack','TESTTOK',NULL,'C1',1,'t','t')").run();
  process.env.TESTTOK = "xoxb-test";
  const sentLines: string[] = [];
  const okFetch: FetchImpl = (async (_u: unknown, init: { body?: string }) => {
    sentLines.push(String(init?.body ?? ""));
    return { status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as unknown as FetchImpl;
  const rq = requestApproval(dbN, { projectId: "p", actionKey: KEY, requestedBy: "senior-dev", ticketId: "T-1" });
  const tickArgs = { writeDb: dbN, projectId: "p", projectKey: "loop", baseUrl: "http://127.0.0.1:8787", cadenceMs: 24 * 3_600_000, fetchImpl: okFetch };
  const sent1 = await blockedNotifyTick({ ...tickArgs, nowMs: Date.now() });
  const markerCount = () => (dbN.prepare("SELECT count(*) c FROM events WHERE kind='approval_request.notified'").get() as { c: number }).c;
  ok(sent1 === 3, `AC4: the tick counts the request alongside the two ticket items (3 sends, got ${sent1})`);
  ok(markerCount() === 1, `AC4: exactly one approval_request.notified marker was written (got ${markerCount()})`);
  ok(sentLines.some((b) => b.includes(KEY) && b.includes(`dev-loop approve --request ${rq.id}`)),
    "AC4: the reminder names the action key and the grant verb");
  ok(!sentLines.some((b) => b.includes("human-blocked") && b.includes(KEY)),
    "AC4: the request does not borrow the Human-Blocked wording — its marker kind and its line are its own");
  const sent2 = await blockedNotifyTick({ ...tickArgs, nowMs: Date.now() + 60_000 });
  ok(sent2 === 0 && markerCount() === 1, `AC4: a second tick inside the cadence re-sends nothing (got ${sent2} sends)`);
  const sent3 = await blockedNotifyTick({ ...tickArgs, nowMs: Date.now() + 25 * 3_600_000 });
  ok(sent3 === 3 && markerCount() === 2, `AC4: past the cadence it reminds again (got ${sent3} sends, ${markerCount()} markers)`);
  grantApproval(dbN, { requestId: rq.id, grantor: "operator" });
  const sent4 = await blockedNotifyTick({ ...tickArgs, nowMs: Date.now() + 50 * 3_600_000 });
  ok(sent4 === 2, `AC4: once the operator grants it, the reminder stops (got ${sent4} sends)`);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(fails === 0 ? "\nAll decision-queue approval tests passed" : `\n${fails} test(s) failed`);
process.exit(fails === 0 ? 0 : 1);
