// LOOP-395 — approvals C6: the CONSULTING consumer, `approvals --covers <key>`.
// Design: hubDoc:design/approvals (parent LOOP-383). One block per AC.
//
// THE TWO ASSERTIONS THAT CARRY THIS SUITE ARE AC2 AND AC3, AND THEY MUST BE READ TOGETHER.
// AC2 asserts one grant still covers the fourth retry — but a BLANKET PERMISSION passes AC2 exactly
// as well as the design does, so AC2 alone measures nothing. AC3 is the discriminator: the next
// version is a different end state and is NOT covered by the same grant. Design §5 is explicit that
// these are one property, not a trade-off: "covers a retry" and "does not cover a second, different
// action" both follow from the key naming an end state (§4). A suite that dropped AC3 would go green
// against an implementation that answered `covered` for every key it was ever handed.
//
// The third load-bearing property is negative and easy to lose: this query LEDGERS NOTHING
// (design §14 decision 4). It is asserted by counting `events` across the queries, not by reading the
// code — `record:false` is one argument away from silently flipping, and the symptom would be an
// attempt ledger the operator console reads as four dispatches when it was four questions.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import {
  consultApproval, coverageQuery, dischargeApproval, grantApproval, requestApproval, revokeApproval,
  type CoverageVerdict,
} from "../src/approvals.ts";
import { VERB_FLAGS } from "../src/approvals-cli.ts";
import { operatorBrief } from "../src/operator-brief.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(hubRoot, "..");
const CLI = join(hubRoot, "src", "cli.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-approvals-covers-")));
const DB = join(tmp, "hub.db");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// The release case from design §5, verbatim — the grant the operator gave once as "发版放行".
const PKG = "@dyzsasd/dev-loop";
const RELEASE = `npm-publish:${PKG}:1.15.1`;
const NEXT_RELEASE = `npm-publish:${PKG}:1.15.2`;
const SHA = "3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab";

interface Run { code: number; out: string; err: string }
function run(args: string[], actor = "operator", fire?: "DEVLOOP_DEV_SPLIT"): Run {
  const env: Record<string, string | undefined> = {
    ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "ap", DEVLOOP_ACTOR: actor,
  };
  if (fire) env[fire] = "true";
  const r = spawnSync("node", [CLI, ...args], { cwd: tmp, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const events = (db: DatabaseSync): number => (db.prepare("SELECT count(*) c FROM events").get() as { c: number }).c;
const attempts = (db: DatabaseSync, key: string): number =>
  (db.prepare("SELECT count(*) c FROM events WHERE kind = 'approval.attempt' AND data LIKE ?").get(`%${key}%`) as { c: number }).c;

try {
  const db = openDb(DB);
  ensureSeed(db, "ap", "Approvals", "AP");
  const pid = findProject(db, "ap")!;

  // The clock is REAL, and deliberately so. `grantApproval` stamps `granted_at`/`expires_at` from the
  // wall clock with no injectable now (writes are not the thing design §6 makes injectable — READS
  // are), so a hardcoded instant here would make every expiry assertion depend on the hour the suite
  // happens to run: a fixed NOW of 08:00Z and a `1h` grant issued at 07:43 expires at 08:43, and the
  // arm below passes at 07:43 and fails at 09:00. Every instant this suite reads with is therefore
  // expressed as an offset from the grant it is about.
  const NOW = (): string => new Date().toISOString();
  const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
  const HOUR = 3_600_000;

  // ── AC2 — the release case: four attempts, one grant, still covered ─────────────────────────────
  //
  // Design §5's answer to "is it single-use?". The four dispatches differed in MECHANICS (patch →
  // explicit → resume-from-branch); the end state never changed, so the key never changed. If an
  // approval were consumed by an attempt the operator would have re-granted three times — and if the
  // expiry were doing the work, this block would pass while AC3 failed.
  {
    const grant = grantApproval(db, {
      projectId: pid, actionKey: RELEASE, grantor: "operator",
      note: "发版放行", expires: "7d",
    });
    for (let i = 1; i <= 4; i++) {
      const attempt = consultApproval(db, RELEASE, NOW(), { projectId: pid, actor: "operator" });
      ok(attempt.authorises, `AC2 dispatch ${i} of 4 is authorised by the SAME grant (no re-grant between attempts)`);
      ok(attempt.attemptRecorded, `AC2 dispatch ${i} is ledgered as an approval.attempt — attempts are recorded, never subtractive`);
    }
    ok(attempts(db, RELEASE) === 4, `AC2 all four attempts are on the ledger (${attempts(db, RELEASE)})`);

    const v = coverageQuery(db, RELEASE, NOW(), { projectId: pid });
    ok(v.covered && v.verdict === "covered", `AC2 after four recorded attempts the grant STILL covers the key (verdict=${v.verdict})`);
    ok(v.approval?.id === grant.id, "AC2 the verdict names the covering approval, not merely a boolean");
    ok(v.reason === null, "AC2 a covered verdict carries no reason — reason is null exactly when covered");
    ok(v.nearest.length === 0, "AC2 a covered verdict reports no near miss");
  }

  // ── AC3 — a DIFFERENT version is a different end state ──────────────────────────────────────────
  //
  // The discriminator. Without this block, "one grant covers every retry" is indistinguishable from
  // "this grant covers everything". The near-miss is asserted too: answering a bare "no approval
  // exists" would be true and useless — it reads exactly like never having granted anything, which
  // is the hand-derivation this ticket exists to retire.
  {
    const v = coverageQuery(db, NEXT_RELEASE, NOW(), { projectId: pid });
    ok(!v.covered && v.verdict === "not-covered", `AC3 the 1.15.2 key is NOT covered by the 1.15.1 grant (verdict=${v.verdict})`);
    ok(v.approval === null, "AC3 there is no row for the asked key — the grant is a different end state, not this one in another state");
    ok(v.nearest.length === 1 && v.nearest[0].key === RELEASE,
      `AC3 the neighbouring grant is reported as a near miss, by key (${JSON.stringify(v.nearest.map((n) => n.key))})`);
    ok(v.nearest[0]?.differs.version?.granted === "1.15.1" && v.nearest[0]?.differs.version?.asked === "1.15.2",
      "AC3 the near miss names WHICH component differs and both of its values");
    ok(v.nearest[0]?.differs.package === undefined, "AC3 a component that MATCHES is not reported as differing");
    ok((v.reason ?? "").includes("DIFFERENT end state") && (v.reason ?? "").includes("1.15.1"),
      `AC3 the reason says a granted approval names a different end state (${JSON.stringify(v.reason)})`);
  }

  // ── AC1 — the typed verdict: one reason per way an approval fails to cover ──────────────────────
  //
  // AC1 lists five: no grant, expired, revoked, discharged, and a key naming a different end state
  // (the block above). Each is asserted to produce a DISTINCT reason, because a single "not covered"
  // string would send the operator to grant a key that is already granted-and-revoked.
  {
    const none = coverageQuery(db, `push:main:${SHA}`, NOW(), { projectId: pid });
    ok(!none.covered && none.approval === null && none.state === null,
      "AC1 no grant at all: not-covered, no approval, no state");
    ok((none.reason ?? "").includes("no approval exists"), `AC1 …and the reason says so (${JSON.stringify(none.reason)})`);
    ok(none.nearest.length === 0, "AC1 a key of a class with no grants at all has no near miss");

    const expiredKey = `push:main:${"a".repeat(40)}`;
    grantApproval(db, { projectId: pid, actionKey: expiredKey, grantor: "operator", expires: "1h" });
    const later = at(1.5 * HOUR); // past a 1h grant issued a moment ago, at whatever hour this runs
    const exp = coverageQuery(db, expiredKey, later, { projectId: pid });
    ok(!exp.covered && exp.state === "expired", `AC1 expired: not-covered with state=expired (${exp.state})`);
    ok((exp.reason ?? "").includes("expired at"), "AC1 …and the reason carries the expiry instant");
    // Derived at consult time, never by a sweeper (design §6) — the same row was covering an hour earlier.
    ok(coverageQuery(db, expiredKey, at(0), { projectId: pid }).covered,
      "AC1 the SAME row covered before its expiry — expiry is evaluated against the clock, not stored");

    const revokedKey = `push:main:${"b".repeat(40)}`;
    const rk = grantApproval(db, { projectId: pid, actionKey: revokedKey, grantor: "operator" });
    revokeApproval(db, rk.id, "operator", "changed my mind");
    const rev = coverageQuery(db, revokedKey, NOW(), { projectId: pid });
    ok(!rev.covered && rev.state === "revoked" && (rev.reason ?? "").includes("revoked by operator"),
      `AC1 revoked: not-covered, state=revoked, reason names the revoker (${JSON.stringify(rev.reason)})`);

    const dischargedKey = `push:main:${"c".repeat(40)}`;
    const dk = grantApproval(db, { projectId: pid, actionKey: dischargedKey, grantor: "operator" });
    dischargeApproval(db, dk.id, "operator");
    const dis = coverageQuery(db, dischargedKey, NOW(), { projectId: pid });
    ok(!dis.covered && dis.state === "discharged" && (dis.reason ?? "").includes("end state was already reached"),
      `AC1 discharged: not-covered, state=discharged, reason says the end state was reached (${dis.state})`);

    const requestedKey = `push:main:${"d".repeat(40)}`;
    requestApproval(db, { projectId: pid, actionKey: requestedKey, requestedBy: "senior-dev", ticketId: "LOOP-395" });
    const req = coverageQuery(db, requestedKey, NOW(), { projectId: pid });
    ok(!req.covered && req.state === "requested" && (req.reason ?? "").includes("not granted"),
      "AC1 requested-but-not-granted is not coverage — a filed ask authorises nothing");

    const reasons = new Set([none.reason, exp.reason, rev.reason, dis.reason, req.reason]);
    ok(reasons.size === 5, `AC1 the five refusals produce five DISTINCT reasons (${reasons.size}/5)`);
  }

  // ── AC1/§14.4 — the query records NOTHING ──────────────────────────────────────────────────────
  //
  // A coverage question is not an attempt. Counted, not read off the source: `record:false` is one
  // argument away from flipping, and the damage is silent — the ledger the console reads to see what
  // was attempted would count the times somebody asked.
  {
    const before = events(db);
    const beforeAttempts = attempts(db, RELEASE);
    for (let i = 0; i < 5; i++) {
      coverageQuery(db, RELEASE, NOW(), { projectId: pid });
      coverageQuery(db, NEXT_RELEASE, NOW(), { projectId: pid });
    }
    ok(events(db) === before, `§14.4 ten coverage queries append ZERO ledger rows (${before} → ${events(db)})`);
    ok(attempts(db, RELEASE) === beforeAttempts,
      `§14.4 …and the release's attempt count is untouched, so the four dispatches still read as four (${beforeAttempts})`);
  }

  // ── Scope — a workspace-scoped grant covers a project query; another project's does not ─────────
  //
  // Design §14 decision 3. The release grant is exactly the workspace shape, so getting this wrong
  // refuses an approval the operator did give.
  {
    ensureSeed(db, "other", "Other", "OT");
    const otherPid = findProject(db, "other")!;
    const wsKey = `npm-publish:${PKG}:2.0.0`;
    grantApproval(db, { projectId: null, actionKey: wsKey, grantor: "operator" });
    ok(coverageQuery(db, wsKey, NOW(), { projectId: pid }).covered,
      "scope: a WORKSPACE-scoped grant covers a query made in a project — it covers every project by definition");

    const foreignKey = `npm-publish:${PKG}:3.0.0`;
    grantApproval(db, { projectId: otherPid, actionKey: foreignKey, grantor: "operator" });
    ok(!coverageQuery(db, foreignKey, NOW(), { projectId: pid }).covered,
      "scope: another PROJECT's grant does not cover this project's query");
    ok(coverageQuery(db, foreignKey, NOW(), { projectId: otherPid }).covered,
      "scope: …and it does cover a query made in the project that holds it — the narrowing discriminates, it is not a blanket refusal");
  }
  db.close();

  // ── AC4 — CLI: exits 0 in BOTH directions, with the verdict in the payload ──────────────────────
  {
    const covered = run(["approvals", "--covers", RELEASE, "--json"]);
    ok(covered.code === 0, `AC4 a COVERED query exits 0 (got ${covered.code}; ${covered.err.trim().slice(0, 200)})`);
    let cv: CoverageVerdict | null = null;
    try { cv = JSON.parse(covered.out) as CoverageVerdict; } catch { /* asserted below */ }
    ok(cv?.covered === true && cv?.verdict === "covered", "AC4 …and the verdict is in the JSON payload");

    const not = run(["approvals", "--covers", NEXT_RELEASE, "--json"]);
    ok(not.code === 0, `AC4 a NOT-COVERED query ALSO exits 0 — the answer is the payload, not the exit code (got ${not.code})`);
    let nv: CoverageVerdict | null = null;
    try { nv = JSON.parse(not.out) as CoverageVerdict; } catch { /* asserted below */ }
    ok(nv?.covered === false && nv?.verdict === "not-covered", "AC4 …and the refusal is typed in the payload");
    ok((nv?.nearest ?? []).some((n) => n.key === RELEASE), "AC4 the near miss survives the CLI's JSON boundary");

    // Agent-callable: a read grants nothing, and a fire that could not ASK would route around the
    // module (design §1). The two writing verbs are refused in the same fire — asserted here so a
    // future widening of this verb cannot quietly take the grant path with it.
    const inFire = run(["approvals", "--covers", RELEASE, "--json"], "senior-dev", "DEVLOOP_DEV_SPLIT");
    ok(inFire.code === 0, `AC4 agent-callable inside a fire (got ${inFire.code}; ${inFire.err.trim().slice(0, 160)})`);
    ok((JSON.parse(inFire.out || "{}") as CoverageVerdict).covered === true, "AC4 …and it answers the same verdict an operator gets");
    ok(run(["approve", RELEASE], "senior-dev", "DEVLOOP_DEV_SPLIT").code === 4,
      "AC4 the same fire still cannot GRANT — reading is open, authorising is not");

    // Human-readable form: the verdict word is the first thing on the line.
    const plain = run(["approvals", "--covers", NEXT_RELEASE]);
    ok(plain.code === 0 && plain.out.startsWith("NOT-COVERED"), `AC4 the text form leads with the verdict (${JSON.stringify(plain.out.split("\n")[0])})`);
    ok(plain.out.includes("1.15.1"), "AC4 …and names the neighbouring grant, so the operator is not left to hunt for it");

    // A malformed key is a USAGE error, not a not-covered verdict: reporting `covered:false` would
    // read as "not granted yet" and invite granting a key the grant-time lint refuses (design §4).
    const capability = run(["approvals", "--covers", "push:main", "--json"]);
    ok(capability.code === 2, `AC4 a key naming a CAPABILITY is a usage error, not a verdict (got ${capability.code})`);
    ok(capability.out.trim() === "", "AC4 …and prints no verdict on stdout that a script could read as an answer");

    // One question or a filtered listing, never both silently.
    ok(run(["approvals", "--covers", RELEASE, "--state", "granted"]).code === 2,
      "AC4 --covers with a listing filter is refused rather than resolved by precedence");
    ok(run(["approvals", "--covers", RELEASE, "extra"]).code === 2, "AC4 a stray positional is refused");
    ok(VERB_FLAGS.approvals.has("covers"), "AC4 --covers is declared for 'approvals' in VERB_FLAGS — the per-verb table the stray-flag check reads");
    ok(!VERB_FLAGS.approve.has("covers") && !VERB_FLAGS.revoke.has("covers") && !VERB_FLAGS.request.has("covers"),
      "AC4 …and for no other verb, so it cannot be typed at a writer and read by nobody");
    ok(run(["approvals", "--help"]).out.includes("--covers"), "AC4 --covers is in the verb's own help");
  }

  // ── AC5 — the console is told to RECORD a chat-granted approval ─────────────────────────────────
  //
  // Asserted against operatorBrief()'s generated text — this is product code that generates the
  // console guidance (design §13). No SKILL file is touched by this ticket, and the block below
  // asserts that too.
  {
    const brief = operatorBrief();
    ok(brief.includes("dev-loop approve <key> --note"), "AC5 the brief tells the console to RECORD a chat approval with its --note");
    ok(brief.includes("发版放行"), "AC5 …using the release case as the worked example, in the operator's own words");
    ok(brief.includes("dev-loop approvals --covers <key>"), "AC5 …and to CHECK a retry with --covers instead of re-deriving it");
    ok(/END STATE|end state/.test(brief) && brief.includes("push:main"),
      "AC5 the brief states the key grammar and names the illegal capability form — the one refusal the console will hit");
    ok(brief.includes("exit 4") || brief.includes("refuse"), "AC5 …and that granting is refused inside a fire, which is why a grant is worth consulting");
  }

  // ── AC6 — nothing here claims the publish is gated ──────────────────────────────────────────────
  //
  // Design §7's measured finding: the publish runs from a workflow_dispatch workflow with no hub-side
  // seam, so no approval object can gate it. This block DERIVES that from the workflow rather than
  // trusting the prose — if someone later adds a hub gate there, the design section is stale and this
  // says so instead of letting a coverage query be mistaken for enforcement.
  {
    const wf = readFileSync(join(repoRoot, ".github", "workflows", "release-npm.yml"), "utf8");
    ok(wf.includes("workflow_dispatch"),
      "AC6 the publish is still human-dispatched — the premise of the whole 'consulting consumer' framing");
    ok(!/dev-loop\s+(approve|approvals|revoke|request)\b/.test(wf),
      "AC6 the workflow consults NO approval — this ticket gates nothing, and the design says why it cannot");
  }

  console.log(fails === 0 ? "\nAPPROVALS_COVERS_OK" : `\n${fails} FAILED`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
