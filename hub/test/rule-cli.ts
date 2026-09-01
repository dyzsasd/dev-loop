// WS-C harness control, review 3 (C5) — `dev-loop rule`, the operator's one-shot ruling, and the write-layer
// guarantees it rests on. Drives the REAL `node src/cli.ts rule …` (so the ROUTES wiring, ATTACH_OK and
// NEEDS_NODE_SQLITE are exercised) against an ISOLATED temp hub DB seeded like cli-tickets.ts.
//
// The four failure modes of the documented two-step form, each pinned here:
//   1. ruling comment posted, state never moved  → `rule` does both in ONE call (approve/reject/defer round trips);
//   2. state moved without a ruling comment      → every `rule` leaves the `Ruling:` record first;
//   3. waiting_on stale across a re-park         → the write layer clears it on EVERY exit from Human-Blocked
//                                                  and defaults it on every entry (asserted through the CLI);
//   4. an AGENT posting `Ruling:` to fake a ruling → refused at the op layer (agent identity) and at the CLI
//                                                  under a fire marker, with NO --i-am-the-operator bypass.
// Every refusal is additionally asserted against the STORE (rows/events unchanged) — an exit code alone
// cannot tell a refusal from a write that also printed one.
import { spawnSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { requestApproval, listApprovals } from "../src/approvals.ts";
import { planRuling, parseArgs } from "../src/rule-cli.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { tmpRoot } from "./tmp-root.ts";
const CLI = join(hubRoot, "src", "cli.ts");
const tmp = realpathSync(tmpRoot("dl-rule-cli-"));
const DB = join(tmp, "hub.db");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

interface Run { code: number; out: string; err: string }
function cli(args: string[], env: Record<string, string | undefined> = {}): Run {
  const base: Record<string, string | undefined> = { ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "rt", DEVLOOP_ACTOR: "operator" };
  const r = spawnSync("node", [CLI, ...args], { cwd: tmp, env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const j = (s: string): any => { try { return JSON.parse(s); } catch { return null; } };
const lastJsonLine = (s: string): any => { const line = s.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{")); return line ? j(line) : null; };

// ── the store, read fresh per question ────────────────────────────────────────────────────────────
type Row = { state: string; assignee: string | null; waiting_on: string | null; labels: string };
const row = (id: string): Row | undefined => { const db = openDb(DB); try { return db.prepare("SELECT state,assignee,waiting_on,labels FROM tickets WHERE id=?").get(id) as Row | undefined; } finally { db.close(); } };
const comments = (id: string): { author: string; body: string }[] => { const db = openDb(DB); try { return db.prepare("SELECT author,body FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as { author: string; body: string }[]; } finally { db.close(); } };
const events = (id: string, kind: string): { actor: string; data: string }[] => { const db = openDb(DB); try { return db.prepare("SELECT actor,data FROM events WHERE ticket_id=? AND kind=? ORDER BY id").all(id, kind) as { actor: string; data: string }[]; } finally { db.close(); } };
const counts = (): string => { const db = openDb(DB); try { return JSON.stringify([db.prepare("SELECT count(*) c FROM comments").get(), db.prepare("SELECT count(*) c FROM events").get(), db.prepare("SELECT count(*) c FROM tickets").get()]); } finally { db.close(); } };

try {
  // ── seed: project + actors (ensureSeed), tickets straight into the table (full control over waiting_on) ──
  let projectId = "";
  {
    const db = openDb(DB);
    projectId = ensureSeed(db, "rt", "Rule Test", "RT");
    const ins = db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,waiting_on,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]',?,'pm','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')");
    const t = (id: string, state: string, assignee: string | null, waitingOn: string | null, labels: string[] = []) =>
      ins.run(id, projectId, `ticket ${id}`, "d", "Feature", state, assignee, 2, JSON.stringify(labels), waitingOn);
    t("RT-1", "Human-Blocked", "operator", "human-decision");   // approve → Todo
    t("RT-2", "In Review", "operator", null);                  // approve → Done (the acceptance edge)
    t("RT-3", "Human-Blocked", "operator", "human-action");     // reject → Canceled
    t("RT-4", "Human-Blocked", "operator", "human-decision");   // defer → stays, waiting_on external
    t("RT-5", "Human-Blocked", "operator", "human-decision");   // defer --to Backlog
    t("RT-6", "Todo", "junior-dev", null);                      // the agent / fire refusals
    t("RT-7", "Human-Blocked", "operator", "human-decision");   // a BARE Ruling: comment (two-step fallback)
    t("RT-8", "Human-Blocked", "operator", "human-decision");   // defer --waiting-on human-action
    t("RT-9", "Done", "qa", null);                              // approve on a terminal ticket = reopen
    t("RT-10", "In Review", "operator", null);                  // reject --to Todo = rework
    t("RT-11", "Human-Blocked", "operator", "external", ["junior-dev"]); // approve → Todo, tier restore re-derives the assignee
    t("RT-12", "Todo", null, null);                             // the write-layer entry default, via ticket update
    t("RT-13", "In Review", "operator", null);                  // defer on an In Review item parks it
    db.prepare("UPDATE projects SET ticket_seq=100 WHERE id=?").run(projectId); // the direct inserts bypassed nextTicketId — creates below allocate RT-101+
    db.close();
  }

  // ── pure table: planRuling (the rulings table as code) ────────────────────────────────────────────
  {
    const p = (v: "approve" | "reject" | "defer", state: string, assignee: string | null = "operator", to?: string, w?: string) => planRuling(v, { state, assignee }, "why", to, w);
    const a = p("approve", "Human-Blocked");
    ok(typeof a !== "string" && a.state === "Todo" && a.assignee === "" && a.waitingOn === undefined, "plan: approve on Human-Blocked → Todo, operator UNASSIGNED so the dev pick set sees it");
    const ir = p("approve", "In Review");
    ok(typeof ir !== "string" && ir.state === "Done" && ir.assignee === undefined, "plan: approve on In Review@operator → Done (assignee untouched)");
    const re = p("approve", "Done", "qa");
    ok(typeof re !== "string" && re.state === "Todo" && re.reason === "reopen: why", "plan: approve on a Done ticket = reopen to Todo, reason prefixed 'reopen:' (the documented grammar)");
    const rj = p("reject", "Human-Blocked");
    ok(typeof rj !== "string" && rj.state === "Canceled" && rj.assignee === undefined, "plan: reject → Canceled");
    const rw = p("reject", "In Review", "operator", "Todo");
    ok(typeof rw !== "string" && rw.state === "Todo" && rw.assignee === "", "plan: reject --to Todo = rework, unassigned from the operator");
    const d = p("defer", "Human-Blocked");
    ok(typeof d !== "string" && d.state === "Human-Blocked" && d.waitingOn === "external" && d.assignee === undefined, "plan: defer stays Human-Blocked, waiting_on external by default");
    const dp = p("defer", "In Review");
    ok(typeof dp !== "string" && dp.state === "Human-Blocked" && dp.assignee === "operator", "plan: defer on a non-parked ticket PARKS it (Human-Blocked, assignee operator)");
    const db_ = p("defer", "Human-Blocked", "operator", "Backlog");
    ok(typeof db_ !== "string" && db_.state === "Backlog" && db_.waitingOn === undefined && db_.assignee === "", "plan: defer --to Backlog leaves the park (no waiting_on), unassigned");
    ok(typeof p("defer", "Human-Blocked", "operator", "Backlog", "external") === "string", "plan: --waiting-on with a non-Human-Blocked target is refused as a contradiction");
    const pa = parseArgs(["RT-1", "approve", "--reason", "x", "--reason", "y"]);
    ok(pa.error !== null && /more than once/.test(pa.error), "parse: a repeated flag is refused, not last-one-wins");
    ok(parseArgs(["RT-1", "approve", "--reason", ""]).error !== null, "parse: an empty --reason (unset shell variable) is refused");
    ok(parseArgs(["RT-1", "approve", "--reason", "ab"]).error !== null, "parse: a control character in --reason is refused");
    ok(parseArgs(["RT-1", "approve", "--reason=two\nlines"]).error === null, "parse: a newline inside a longer reason is fine");
  }

  // ── 1. approve on Human-Blocked: ONE call = the Ruling: comment + Todo + waiting_on cleared + unassigned ──
  {
    const r = cli(["rule", "RT-1", "approve", "--reason", "ship the CSV export; the filter is RT-47"]);
    ok(r.code === 0, `rule approve exits 0 (got ${r.code}; ${r.err.trim().slice(0, 200)})`);
    ok(/ruled approve on RT-1: Human-Blocked → Todo/.test(r.out), `text mode names the transition (got: ${r.out.trim().split("\n")[0]})`);
    const t = row("RT-1")!;
    ok(t.state === "Todo", `RT-1 is Todo (got ${t.state})`);
    ok(t.waiting_on === null, `RT-1 waiting_on is CLEARED on leaving Human-Blocked (got ${String(t.waiting_on)})`);
    ok(t.assignee === null, `RT-1 is unassigned from the operator so a dev tier can pick it (got ${String(t.assignee)})`);
    const c = comments("RT-1");
    ok(c.length === 1 && c[0]!.author === "operator" && c[0]!.body === "Ruling: approve — ship the CSV export; the filter is RT-47",
      `the Ruling: record is on the ticket, authored by the operator, in the fixed grammar (got ${JSON.stringify(c)})`);
    const ev = events("RT-1", "issue.ruling");
    ok(ev.length === 1 && ev[0]!.actor === "operator" && j(ev[0]!.data)?.ruling === "approve" && j(ev[0]!.data)?.waitingOnCleared === "human-decision",
      `an issue.ruling ledger event carries the verdict + the cleared discriminator (got ${JSON.stringify(ev)})`);
    ok(events("RT-1", "issue.transition").some((e) => j(e.data)?.from === "Human-Blocked" && j(e.data)?.to === "Todo"), "the transition event is the ordinary issue.transition (the state verb ran through save_issue)");
  }

  // ── 2. approve on In Review@operator → Done; --json carries the whole record ─────────────────────
  {
    const r = cli(["rule", "RT-2", "approve", "--reason", "verified on staging", "--json"]);
    const body = j(r.out);
    ok(r.code === 0 && body?.from === "In Review" && body?.to === "Done" && body?.ruling === "approve", `rule approve on In Review → Done, --json {from,to,ruling} (got ${r.code}: ${r.out.trim().slice(0, 160)})`);
    ok(body?.comment?.author === "operator" && body?.ticket?.state === "Done" && typeof body?.next === "string", "--json carries the comment body, the updated ticket and the 'what the loop does next' line");
    ok(row("RT-2")!.state === "Done", "RT-2 is Done in the store");
  }

  // ── 3. reject → Canceled ───────────────────────────────────────────────────────────────────────────
  {
    const r = cli(["rule", "RT-3", "reject", "--reason", "out of scope this quarter"]);
    const t = row("RT-3")!;
    ok(r.code === 0 && t.state === "Canceled" && t.waiting_on === null, `rule reject → Canceled, waiting_on cleared (got ${r.code}, ${t.state}, ${String(t.waiting_on)})`);
    ok(comments("RT-3")[0]?.body === "Ruling: reject — out of scope this quarter", "the reject ruling is the record");
  }

  // ── 4. defer → stays Human-Blocked, waiting_on := external (the comment cleared it; the verb re-sets it) ──
  {
    const r = cli(["rule", "RT-4", "defer", "--reason", "wait for the pricing decision on 2026-09-03"]);
    const t = row("RT-4")!;
    ok(r.code === 0 && t.state === "Human-Blocked" && t.waiting_on === "external", `rule defer stays Human-Blocked with waiting_on external (got ${r.code}, ${t.state}, ${String(t.waiting_on)})`);
    ok(/waiting_on: external/.test(r.out), "text mode shows the discriminator the ticket now waits on");
    ok(j(events("RT-4", "issue.ruling")[0]?.data ?? "{}")?.waitingOnCleared === "human-decision", "…the ruling record shows the OLD discriminator it replaced");
    const r8 = cli(["rule", "RT-8", "defer", "--reason", "I must rotate the key first", "--waiting-on", "human-action"]);
    ok(r8.code === 0 && row("RT-8")!.waiting_on === "human-action", `defer --waiting-on human-action (a decision became an action) (got ${r8.code}, ${String(row("RT-8")!.waiting_on)})`);
    const r5 = cli(["rule", "RT-5", "defer", "--reason", "not this quarter", "--to", "Backlog"]);
    const t5 = row("RT-5")!;
    ok(r5.code === 0 && t5.state === "Backlog" && t5.waiting_on === null && t5.assignee === null, `defer --to Backlog leaves the park: Backlog, waiting_on cleared, unassigned (got ${r5.code}, ${t5.state}, ${String(t5.waiting_on)}, ${String(t5.assignee)})`);
    const r13 = cli(["rule", "RT-13", "defer", "--reason", "hold the merge until the vendor answers"]);
    const t13 = row("RT-13")!;
    ok(r13.code === 0 && t13.state === "Human-Blocked" && t13.assignee === "operator" && t13.waiting_on === "external", `defer on an In Review item PARKS it for the operator (got ${r13.code}, ${t13.state}/${String(t13.assignee)}/${String(t13.waiting_on)})`);
  }

  // ── 5. reopen (approve on Done) and rework (reject --to Todo) ─────────────────────────────────────
  {
    const r = cli(["rule", "RT-9", "approve", "--reason", "the regression is back in prod"]);
    const t = row("RT-9")!;
    ok(r.code === 0 && t.state === "Todo", `approve on a Done ticket reopens it to Todo — the operator-only edge the write layer admits (got ${r.code}, ${t.state}; ${r.err.trim().slice(0, 120)})`);
    ok(comments("RT-9")[0]?.body === "Ruling: approve — reopen: the regression is back in prod", "the reopen ruling carries the documented 'reopen:' prefix");
    const rw = cli(["rule", "RT-10", "reject", "--reason", "the AC list is missing the mobile case", "--to", "Todo"]);
    const t10 = row("RT-10")!;
    ok(rw.code === 0 && t10.state === "Todo" && t10.assignee === null, `reject --to Todo = rework: Todo, unassigned from the operator (got ${rw.code}, ${t10.state}/${String(t10.assignee)})`);
    const r11 = cli(["rule", "RT-11", "approve", "--reason", "go"]);
    const t11 = row("RT-11")!;
    ok(r11.code === 0 && t11.state === "Todo" && t11.assignee === "junior-dev", `unassigning the operator lets tier-restore (LOOP-223) re-derive the assignee from the tier label (got ${t11.state}/${String(t11.assignee)})`);
  }

  // ── 6. the invariant: refused inside a fire, no bypass, nothing written ──────────────────────────
  {
    const before = counts();
    for (const marker of ["DEVLOOP_DEV_SPLIT", "DEVLOOP_TEAM_SCOPE"] as const) {
      const r = cli(["rule", "RT-6", "approve", "--reason", "x"], { [marker]: "true" });
      ok(r.code === 4 && /refusing inside an agent fire/.test(r.err) && r.err.includes(marker), `rule under ${marker} → exit 4 naming the marker (got ${r.code})`);
      ok(!/--i-am-the-operator|--force|--yes/.test(r.err), `…and the refusal names NO bypass`);
    }
    const asAgent = cli(["rule", "RT-6", "approve", "--reason", "x"], { DEVLOOP_ACTOR: "pm" });
    ok(asAgent.code === 4 && /agent identity/.test(asAgent.err), `rule as DEVLOOP_ACTOR=pm (no fire) → exit 4: a ruling is the human's act (got ${asAgent.code})`);
    ok(counts() === before, "every refusal above left the store untouched (comments/events/tickets unchanged)");
    ok(row("RT-6")!.state === "Todo" && comments("RT-6").length === 0, "RT-6 carries no ruling and did not move");
  }

  // ── 7. the same guard on the BARE comment path (the two-step fallback) ────────────────────────────
  {
    const before = counts();
    const fake = cli(["comment", "add", "RT-6", "--body", "Ruling: approve — sneaky"], { DEVLOOP_ACTOR: "pm" });
    ok(fake.code === 1 && /agent identity/.test(lastJsonLine(fake.err)?.error ?? ""), `comment add "Ruling: …" as pm → refused at the op layer, exit 1 (got ${fake.code})`);
    const look = cli(["comment", "add", "RT-6", "--body", "ruling: approve — lookalike"], { DEVLOOP_ACTOR: "junior-dev" });
    ok(look.code === 1, `a lookalike ('ruling:') from an agent is refused too, not stored as prose (got ${look.code})`);
    const opPath = cli(["op", "save_comment", "--args-json", JSON.stringify({ issueId: "RT-6", body: "Ruling: approve — via op" })], { DEVLOOP_ACTOR: "senior-dev" });
    ok(opPath.code === 1, `op save_comment with a Ruling: body as senior-dev → refused (got ${opPath.code})`);
    // the operator's own bypass flag must NOT reach a ruling
    const fireOp = cli(["comment", "add", "RT-6", "--body", "Ruling: approve — from a fire", "--i-am-the-operator"], { DEVLOOP_DEV_SPLIT: "true" });
    ok(fireOp.code === 4 && /refusing a Ruling: comment inside an agent fire/.test(fireOp.err), `comment add Ruling: under a fire marker WITH --i-am-the-operator → exit 4 (the flag does not reach a ruling) (got ${fireOp.code})`);
    const fireRaw = cli(["op", "save_comment", "--args-json", JSON.stringify({ issueId: "RT-6", body: "Ruling: reject — raw op" }), "--i-am-the-operator"], { DEVLOOP_TEAM_SCOPE: "1" });
    ok(fireRaw.code === 4, `op save_comment Ruling: under a fire marker with --i-am-the-operator → exit 4 too (got ${fireRaw.code})`);
    const malformed = cli(["comment", "add", "RT-6", "--body", "Ruling: maybe — later"]);
    ok(malformed.code === 1 && /must read exactly/.test(lastJsonLine(malformed.err)?.error ?? ""), `a malformed Ruling: from the operator is refused rather than stored half-parseable (got ${malformed.code})`);
    const noReason = cli(["comment", "add", "RT-6", "--body", "Ruling: approve"]);
    ok(noReason.code === 1 && /reason/.test(lastJsonLine(noReason.err)?.error ?? ""), `a Ruling: with no reason is refused (got ${noReason.code})`);
    ok(counts() === before, "none of the refused comments landed (store unchanged)");
    // …while an ordinary comment under the same flags still works — the refusal is ruling-specific
    const plain = cli(["comment", "add", "RT-6", "--body", "not a ruling, just a note", "--i-am-the-operator"], { DEVLOOP_DEV_SPLIT: "true" });
    ok(plain.code === 0 && j(plain.out)?.author === "operator", "an ordinary comment with --i-am-the-operator under a marker still lands (the existing cooperative guard is unchanged)");
  }

  // ── 8. a bare valid Ruling: from the operator: recorded, waiting_on cleared, state NOT moved ──────
  {
    const r = cli(["comment", "add", "RT-7", "--body", "Ruling: approve — will do, moving it next"]);
    const body = j(r.out);
    ok(r.code === 0 && body?.ruling?.verdict === "approve" && body?.ruling?.waitingOnCleared === "human-decision" && body?.ruling?.state === "Human-Blocked",
      `comment add with a valid Ruling: → 200 with ruling {verdict, state, waitingOnCleared} (got ${r.code}: ${r.out.trim().slice(0, 200)})`);
    const t = row("RT-7")!;
    ok(t.state === "Human-Blocked" && t.waiting_on === null, `RT-7 stays Human-Blocked (a comment never moves state) with waiting_on cleared (got ${t.state}/${String(t.waiting_on)})`);
    ok(events("RT-7", "issue.ruling").length === 1, "the issue.ruling event was logged for the bare comment");
    // then the two-step's second half: the state verb — exit clears nothing further, and it is idempotent
    const mv = cli(["ticket", "update", "RT-7", "--state", "Todo"]);
    ok(mv.code === 0 && row("RT-7")!.state === "Todo" && row("RT-7")!.waiting_on === null, "ticket update --state Todo completes the two-step; waiting_on stays null (idempotent clear)");
  }

  // ── 9. the write-layer halves through the plain sugar verb (no `rule` involved) ─────────────────
  {
    const park = cli(["ticket", "update", "RT-12", "--state", "Human-Blocked", "--assignee", "operator"], { DEVLOOP_ACTOR: "pm" });
    ok(park.code === 0 && row("RT-12")!.waiting_on === "human-decision", `entering Human-Blocked with nothing set defaults waiting_on to human-decision (got ${park.code}, ${String(row("RT-12")!.waiting_on)})`);
    const edit = cli(["op", "save_issue", "--args-json", JSON.stringify({ id: "RT-12", waitingOn: "external" })], { DEVLOOP_ACTOR: "pm" });
    ok(edit.code === 0 && row("RT-12")!.waiting_on === "external", "an explicit waitingOn edit inside Human-Blocked is honored");
    const resume = cli(["ticket", "update", "RT-12", "--state", "Todo", "--assignee", ""]);
    ok(resume.code === 0 && row("RT-12")!.waiting_on === null, `leaving Human-Blocked through ticket update clears waiting_on (got ${String(row("RT-12")!.waiting_on)})`);
    const repark = cli(["ticket", "update", "RT-12", "--state", "Human-Blocked"], { DEVLOOP_ACTOR: "pm" });
    ok(repark.code === 0 && row("RT-12")!.waiting_on === "human-decision", `a RE-park for a different reason gets a fresh default, never the stale 'external' (got ${String(row("RT-12")!.waiting_on)})`);
    const created = cli(["op", "save_issue", "--args-json", JSON.stringify({ title: "parked at birth", type: "Bug", state: "Human-Blocked", waitingOn: "external" })], { DEVLOOP_ACTOR: "pm" });
    const cid = j(created.out)?.id as string | undefined;
    ok(created.code === 0 && !!cid && row(cid)!.waiting_on === "external", `save_issue CREATE honors waitingOn (was dropped before) (got ${String(cid && row(cid)!.waiting_on)})`);
    const created2 = cli(["op", "save_issue", "--args-json", JSON.stringify({ title: "parked at birth, no discriminator", type: "Bug", state: "Human-Blocked" })], { DEVLOOP_ACTOR: "pm" });
    const cid2 = j(created2.out)?.id as string | undefined;
    ok(created2.code === 0 && !!cid2 && row(cid2)!.waiting_on === "human-decision", "…and a create straight into Human-Blocked without one gets the default");
    const created3 = cli(["op", "save_issue", "--args-json", JSON.stringify({ title: "plain todo", type: "Bug" })], { DEVLOOP_ACTOR: "pm" });
    const cid3 = j(created3.out)?.id as string | undefined;
    ok(created3.code === 0 && !!cid3 && row(cid3)!.waiting_on === null, "a Todo create stays NULL — the discriminator belongs to the state");
  }

  // ── 10. usage errors, each a loud exit 2 with nothing written ───────────────────────────────────
  {
    const before = counts();
    const cases: [string[], RegExp][] = [
      [["rule", "RT-6", "approve"], /--reason/],
      [["rule", "RT-6", "maybe", "--reason", "x"], /one of approve, reject, defer/],
      [["rule", "RT-6", "approve", "--reason", "x", "--bogus"], /unknown flag/],
      [["rule", "RT-6", "approve", "--reason", "x", "--waiting-on", "external"], /only applies to defer/],
      [["rule", "RT-6", "defer", "--reason", "x", "--waiting-on", "later"], /--waiting-on must be one of/],
      [["rule", "RT-6", "approve", "--reason", "x", "--to", "Nowhere"], /--to must be one of/],
      [["rule", "RT-6", "defer", "--reason", "x", "--to", "Backlog", "--waiting-on", "external"], /only applies when the ruling leaves the ticket Human-Blocked/],
      [["rule", "RT-6", "approve", "--reason", "x", "extra"], /unexpected argument/],
      [["rule", "RT-6"], /usage/],
      [["rule"], /dev-loop rule <ticket-id>/],
    ];
    for (const [args, re] of cases) {
      const r = cli(args);
      ok(r.code === 2 && re.test(r.err + r.out), `${args.join(" ")} → usage exit 2 (${re}) (got ${r.code}: ${(r.err || r.out).trim().split("\n")[0]?.slice(0, 120)})`);
    }
    const help = cli(["rule", "--help"]);
    ok(help.code === 0 && /Human-Blocked \(the park\)/.test(help.out) && /approval-id/.test(help.out), "rule --help prints the table + the approval arm, exit 0");
    const missing = cli(["rule", "RT-999", "approve", "--reason", "x"]);
    ok(missing.code === 1 && /no such ticket/.test(missing.err), `an unknown ticket → domain exit 1 with the op's body (got ${missing.code})`);
    ok(counts() === before, "no usage error wrote anything");
  }

  // ── 11. an approval-id delegates to approvals-cli — never a second copy of the store ───────────────
  {
    const SHA = "3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab";
    const db = openDb(DB);
    const reqA = requestApproval(db, { projectId, actionKey: `push:main:${SHA}`, requestedBy: "senior-dev", ticketId: "RT-6" });
    const reqB = requestApproval(db, { projectId, actionKey: "npm-publish:@dyzsasd/dev-loop:9.9.9", requestedBy: "senior-dev", ticketId: "RT-6" });
    const reqC = requestApproval(db, { projectId, actionKey: "reopen:RT-3", requestedBy: "pm", ticketId: "RT-3" });
    db.close();
    const find = (id: string) => { const d = openDb(DB); try { return listApprovals(d, {}).find((r) => r.id === id); } finally { d.close(); } };
    const g = cli(["rule", reqA.id, "approve", "--reason", "go ahead, that sha is reviewed"]);
    ok(g.code === 0 && find(reqA.id)?.state === "granted" && find(reqA.id)?.note === "go ahead, that sha is reviewed" && find(reqA.id)?.grantor === "operator",
      `rule <approval-id> approve → approvals-cli approve --request: GRANTED, note = the reason, grantor operator (got ${g.code}; ${(g.err || g.out).trim().slice(0, 120)})`);
    const rv = cli(["rule", reqB.id, "reject", "--reason", "not this version"]);
    ok(rv.code === 0 && find(reqB.id)?.state === "revoked", `rule <approval-id> reject → approvals-cli revoke: REVOKED (got ${rv.code})`);
    const df = cli(["rule", reqC.id, "defer", "--reason", "later"]);
    ok(df.code === 2 && /no defer/.test(df.err) && find(reqC.id)?.state === "requested", `rule <approval-id> defer → usage exit 2, the request stays pending (got ${df.code})`);
    const scoped = cli(["rule", reqC.id, "approve", "--reason", "x", "--to", "Todo"]);
    ok(scoped.code === 2 && /does not apply to an approval id/.test(scoped.err), "--to/--waiting-on/--project with an approval id are refused (the request carries its own scope)");
    const fire = cli(["rule", reqC.id, "approve", "--reason", "x"], { DEVLOOP_DEV_SPLIT: "true" });
    ok(fire.code === 4 && find(reqC.id)?.state === "requested", `the fire refusal fires BEFORE the approval arm too (got ${fire.code})`);
    const attach = cli(["rule", reqC.id, "approve", "--reason", "x"], { DEVLOOP_HUB_URL: "http://127.0.0.1:1", DEVLOOP_HUB_DB: undefined });
    ok(attach.code === 2 && /WORKSPACE HOME/.test(attach.err) && !/this verb runs at the WORKSPACE HOME/.test(attach.err), `over an attach the approval arm refuses itself (home-only), while cli.ts admits the verb (got ${attach.code}: ${attach.err.trim().slice(0, 140)})`);
  }

  // ── 12. a TICKET ruling travels over an attach: cli.ts admits `rule`, the op seam tries the remote ──
  {
    const r = cli(["rule", "RT-6", "approve", "--reason", "x"], { DEVLOOP_HUB_URL: "http://127.0.0.1:1", DEVLOOP_HUB_DB: undefined });
    ok(r.code === 5 && /not reachable/.test(r.err) && !/WORKSPACE HOME/.test(r.err), `rule <ticket> with DEVLOOP_HUB_URL set reaches the remote seam (exit 5 unreachable here), not the home-only refusal (got ${r.code}: ${r.err.trim().slice(0, 120)})`);
    ok(row("RT-6")!.state === "Todo" && comments("RT-6").filter((c) => c.body.startsWith("Ruling:")).length === 0, "…and wrote nothing to the LOCAL board");
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(fails === 0 ? "\nRULE_CLI_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
