// LOOP-391 — approvals C1: the object model, the key grammar, and the store.
// Design: hubDoc:design/approvals (parent LOOP-383). One block per AC.
//
// The load-bearing assertions are AC3 (the grant-time key lint — design §4 calls it "a hard refusal,
// never a warning") and AC5 (expiry derived at consult time, so a stale row cannot authorise even
// though no sweeper has ever run). Everything else exists so those two cannot regress unnoticed.
import { realpathSync, rmSync } from "node:fs";

import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import {
  ACTION_CLASSES, AUTHORISING_STATE, ApprovalError, DEFAULT_EXPIRY, NEVER, WORKSPACE_SCOPE,
  actionClasses, consultApproval, deriveState, dischargeApproval, grantApproval, listApprovals,
  parseActionKey, parseDuration, requestApproval, resolveExpiry, revokeApproval,
  type ApprovalRow,
} from "../src/approvals.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-approvals-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const refuses = (fn: () => unknown, code: string): { hit: boolean; got: string } => {
  try { fn(); return { hit: false, got: "no throw" }; }
  catch (e) {
    const err = e as ApprovalError;
    return { hit: err instanceof ApprovalError && err.code === code, got: `${err?.name}/${(err as ApprovalError)?.code}: ${err?.message}` };
  }
};

const SHA = "3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab";
const uv = (db: import("node:sqlite").DatabaseSync): number =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

try {
  const dbPath = join(tmp, "hub.db");
  const db = openDb(dbPath);
  ensureSeed(db, "ap", "Approvals", "AP");
  const pid = findProject(db, "ap")!;

  // ── AC1 — the table is created by the SCHEMA const, and retro-adds with NO user_version bump ────
  //
  // The proof is the fast path in migrate(): a DB already at SCHEMA_VERSION returns before any
  // migration runs. So drop the table on such a DB, reopen, and if it is back it can ONLY have come
  // from the SCHEMA re-exec — the `removed_projects` idiom (db.ts, the comment at its CREATE).
  {
    const before = uv(db);
    db.exec("DROP TABLE approvals");
    ok(!tableExists(db, "approvals"), "AC1: fixture is a genuine pre-LOOP-391 DB (approvals absent, user_version already current)");
    db.close();

    const reopened = openDb(dbPath);
    const after = uv(reopened);
    ok(tableExists(reopened, "approvals"), "AC1: reopening an existing hub.db retro-adds `approvals` — the SCHEMA const, not a migration");
    ok(after === before, `AC1: PRAGMA user_version unchanged across the retro-add (${before} → ${after})`);

    // Design §3's field set, exactly — and `state` deliberately absent (§6: derived on read).
    const cols = (reopened.prepare("PRAGMA table_info(approvals)").all() as unknown as { name: string; notnull: number }[]);
    const names = cols.map((c) => c.name).sort();
    const want = [
      "action_key", "discharged_at", "expires_at", "granted_at", "grantor", "id", "note",
      "project_id", "requested_at", "requested_by", "revoked_at", "revoked_by", "ticket_id",
    ];
    ok(JSON.stringify(names) === JSON.stringify(want), `AC1: field set is design §3 (got ${names.join(",")})`);
    ok(!names.includes("state"), "AC1: `state` is NOT a column — §6 derives it on read, so a stale row cannot read `granted`");
    ok(cols.find((c) => c.name === "project_id")!.notnull === 0, "AC1: project_id is nullable — §3's workspace-scoped action");
    ok(cols.find((c) => c.name === "action_key")!.notnull === 1, "AC1: action_key is NOT NULL — an approval without a key authorises nothing");
    reopened.close();
  }

  // Everything below runs on a fresh handle to the same file (AC1 closed the first one).
  const d = openDb(dbPath);
  const events = (kind: string): { data: string }[] =>
    d.prepare("SELECT data FROM events WHERE kind = ? ORDER BY id").all(kind) as unknown as { data: string }[];

  // ── AC2 — the action-class registry + parseActionKey ───────────────────────────────────────────
  {
    ok(actionClasses().join(",") === "board-restore,npm-publish,push,remove-project,reopen",
      `AC2: the registry is design §4's five classes (got ${actionClasses().join(",")})`);

    const p = parseActionKey("push:main:" + SHA);
    ok(p.ok && p.parsed.actionClass === "push", "AC2: parseActionKey returns the class");
    ok(p.ok && p.parsed.components.branch === "main" && p.parsed.components.sha === SHA,
      "AC2: …and the components, NAMED per the registry (branch, sha)");
    ok(p.ok && p.parsed.endState === "that sha is on that branch", "AC2: …and the end state the key names");

    // A scoped npm package carries `@` and `/` but never `:`, so the plain split is correct.
    const npm = parseActionKey("npm-publish:@dyzsasd/dev-loop:1.15.1");
    ok(npm.ok && npm.parsed.components.package === "@dyzsasd/dev-loop" && npm.parsed.components.version === "1.15.1",
      "AC2: a scoped package name survives the split (@dyzsasd/dev-loop, 1.15.1)");

    // Every registered class round-trips — a class added without components would fail here.
    for (const [cls, spec] of Object.entries(ACTION_CLASSES)) {
      const key = [cls, ...spec.components.map((c) => `x-${c}`)].join(":");
      const r = parseActionKey(key);
      ok(r.ok && r.parsed.values.length === spec.components.length, `AC2: '${cls}' round-trips its ${spec.components.length} declared component(s)`);
    }

    const typed = (k: string, code: string) => {
      const r = parseActionKey(k);
      ok(!r.ok && r.code === code, `AC2: ${JSON.stringify(k)} → typed error ${code}${r.ok ? " (got ok)" : ` (got ${r.code})`}`);
    };
    typed("nonsense:x", "unknown-action-class");
    typed("push:main", "missing-component");
    typed("push:main:" + SHA + ":extra", "extra-component");
    typed("push::" + SHA, "empty-component");
    typed("", "unknown-action-class");
    const missing = parseActionKey("push:main");
    ok(!missing.ok && /capability, not an end state/.test(missing.message) && /<sha>/.test(missing.message),
      "AC2: the missing-component message names WHICH component and why (§4's capability-vs-end-state rule)");
  }

  // ── AC3 — grantApproval REFUSES at grant time. Hard refusal, never a warning (§4). ─────────────
  {
    const capability = refuses(() => grantApproval(d, { projectId: pid, actionKey: "push:main", grantor: "operator" }), "missing-component");
    ok(capability.hit, `AC3: grantApproval REFUSES 'push:main' — a capability, not an end state (${capability.got})`);

    const unknown = refuses(() => grantApproval(d, { projectId: pid, actionKey: "nonsense:x", grantor: "operator" }), "unknown-action-class");
    ok(unknown.hit, `AC3: grantApproval REFUSES an unknown action class (${unknown.got})`);

    const granted = grantApproval(d, { projectId: pid, actionKey: `push:main:${SHA}`, grantor: "operator", note: "chat: 放行" });
    ok(granted.action_key === `push:main:${SHA}` && granted.grantor === "operator" && !!granted.granted_at,
      "AC3: 'push:main:<sha>' is ACCEPTED — the instance component makes it an end state");
    ok(granted.requested_by === null && granted.requested_at === null,
      "AC3: an unprompted operator grant leaves requested_by/requested_at NULL (§3)");
    ok(refuses(() => grantApproval(d, { projectId: pid, actionKey: "reopen", grantor: "operator" }), "missing-component").hit,
      "AC3: a bare class with no components is refused too");

    // Nothing was written by either refusal — a refused grant must not leave a row behind.
    ok(listApprovals(d, { actionKey: "push:main" }).length === 0 && listApprovals(d, { actionKey: "nonsense:x" }).length === 0,
      "AC3: a refused grant writes NO row — the refusal is before the insert");

    // The key is the security boundary, so its lint runs FIRST: a grant that is wrong in both ways
    // must report the key, not the expiry, or the §4 defect gets fixed as a flag typo.
    const both = refuses(
      () => grantApproval(d, { projectId: pid, actionKey: "push:main", grantor: "operator", expires: "forever" }),
      "missing-component",
    );
    ok(both.hit, `AC3: a bad key + a bad expiry reports the KEY — §4's lint precedes the §6 one (${both.got})`);
  }

  // ── AC4 — consultApproval returns a VERDICT, not a boolean ─────────────────────────────────────
  {
    const now = "2026-08-06T20:00:00.000Z";
    const yes = consultApproval(d, `push:main:${SHA}`, now, { projectId: pid, actor: "junior-dev" });
    ok(yes.authorises === true, "AC4: a granted, unexpired approval authorises");
    ok(yes.state === AUTHORISING_STATE && yes.approval !== null && yes.approval!.action_key === `push:main:${SHA}`,
      "AC4: …the verdict carries the matching ROW and its derived state");
    ok(yes.reason === null, "AC4: …and no reason, exactly when it authorises");

    const none = consultApproval(d, `push:release:${SHA}`, now, { projectId: pid, actor: "junior-dev" });
    ok(none.authorises === false && none.approval === null && none.state === null,
      "AC4: an unapproved key does not authorise");
    ok(typeof none.reason === "string" && none.reason.includes("no approval exists"),
      `AC4: …and says WHY (${none.reason})`);

    const bad = consultApproval(d, "push:main", now, { projectId: pid, actor: "junior-dev" });
    ok(bad.authorises === false && /capability, not an end state/.test(bad.reason ?? ""),
      "AC4: a malformed key fails CLOSED, and reports the key defect rather than a bare 'no approval'");

    ok(typeof yes.authorises === "boolean" && "reason" in yes && "state" in yes && "approval" in yes,
      "AC4: the verdict is an object with all four fields — a consumer cannot branch on a bare boolean");

    // Scope: a workspace-scoped grant covers every project (that is what workspace-scoped MEANS), and
    // another project's grant covers none but its own. Both directions, because getting either wrong
    // is a real refusal — one too broad, one a false negative on an approval the operator did give.
    ensureSeed(d, "other", "Other", "OT");
    const otherPid = findProject(d, "other")!;
    grantApproval(d, { projectId: null, actionKey: "remove-project:scratchpad", grantor: "operator" });
    grantApproval(d, { projectId: otherPid, actionKey: "board-restore:other:snap-1", grantor: "operator" });
    ok(consultApproval(d, "remove-project:scratchpad", now, { projectId: pid, record: false }).authorises,
      "AC4: a workspace-scoped grant authorises a consult from inside a project");
    const foreign = consultApproval(d, "board-restore:other:snap-1", now, { projectId: pid, record: false });
    ok(!foreign.authorises && foreign.approval === null,
      "AC4: …and another project's grant does not — the narrowing is real, not decorative");
    ok(consultApproval(d, "board-restore:other:snap-1", now, { projectId: otherPid, record: false }).authorises,
      "AC4: …while its own project still sees it");
  }

  // ── AC5 — expiry at CONSULT time, against the passed `now`. No sweeper runs, ever. ─────────────
  {
    const g = grantApproval(d, { projectId: pid, actionKey: "reopen:AP-9", grantor: "operator", expires: "24h" });
    const grantedAt = Date.parse(g.granted_at!);
    const before = new Date(grantedAt + 60_000).toISOString();
    const after = new Date(Date.parse(g.expires_at!) + 1_000).toISOString();

    ok(consultApproval(d, "reopen:AP-9", before, { projectId: pid, record: false }).authorises,
      "AC5: inside the window it authorises");

    const late = consultApproval(d, "reopen:AP-9", after, { projectId: pid, record: false });
    ok(late.state === "expired" && late.authorises === false,
      `AC5: past expires_at the SAME row derives 'expired' and does not authorise (got ${late.state})`);
    ok(/expired at/.test(late.reason ?? ""), `AC5: …and the reason names the expiry (${late.reason})`);

    // The point of §6: no cleanup job has run, and none exists. The row is untouched on disk.
    const raw = d.prepare("SELECT revoked_at, discharged_at FROM approvals WHERE id = ?").get(g.id) as { revoked_at: string | null; discharged_at: string | null };
    ok(raw.revoked_at === null && raw.discharged_at === null,
      "AC5: the expired row was never mutated — expiry is derived, not swept");
    ok(deriveState({ ...g, expires_at: null } as ApprovalRow, after) === "granted",
      "AC5: …and with expires_at NULL the same clock does not expire it");
  }

  // ── AC6 — the five verbs, the ledger, and attempts that never subtract (§5) ────────────────────
  {
    for (const fn of [requestApproval, grantApproval, revokeApproval, dischargeApproval, listApprovals]) {
      ok(typeof fn === "function", `AC6: ${fn.name} exists`);
    }

    const req = requestApproval(d, {
      projectId: pid, actionKey: "board-restore:ap:snap-7", requestedBy: "qa", ticketId: "AP-1", note: "post-incident",
    });
    ok(deriveState(req, "2026-08-06T20:00:00.000Z") === "requested" && req.requested_by === "qa",
      "AC6: requestApproval files a `requested` row an agent cannot grant itself");
    ok(events("approval.request").length === 1, "AC6: …and appends `approval.request` to the events ledger");

    const g2 = grantApproval(d, { requestId: req.id, grantor: "operator", expires: "7d" });
    ok(g2.grantor === "operator" && g2.requested_by === "qa",
      "AC6: grantApproval promotes the standing request, preserving who asked");
    ok(events("approval.grant").some((e) => JSON.parse(e.data).fromRequest === true),
      "AC6: …and ledgers `approval.grant` marked fromRequest");

    // §5: attempts are RECORDED, never subtractive. One grant covers a retry because the KEY bounds
    // it — the release case (four dispatches, one end state) is exactly this shape.
    const N = 5;
    const attemptsBefore = events("approval.attempt").length;
    for (let i = 0; i < N; i++) {
      const v = consultApproval(d, "board-restore:ap:snap-7", "2026-08-06T20:00:00.000Z", { projectId: pid, actor: "ops" });
      ok(v.authorises && v.attemptRecorded, `AC6: attempt ${i + 1}/${N} still authorises and is ledgered`);
    }
    const attemptsAfter = events("approval.attempt").length;
    ok(attemptsAfter === attemptsBefore + N,
      `AC6: ${N} attempts appended exactly ${N} \`approval.attempt\` rows (${attemptsBefore} → ${attemptsAfter}) — recorded, not consumed`);

    const dis = dischargeApproval(d, g2.id, "ops", "restore completed");
    ok(deriveState(dis, "2026-08-06T20:00:00.000Z") === "discharged", "AC6: dischargeApproval ends it at the observed end state (§5 exit 1)");
    ok(events("approval.discharge").length === 1, "AC6: …and ledgers `approval.discharge`");
    const after = consultApproval(d, "board-restore:ap:snap-7", "2026-08-06T20:00:00.000Z", { projectId: pid, record: false });
    ok(!after.authorises && after.state === "discharged" && /already reached/.test(after.reason ?? ""),
      "AC6: a discharged approval authorises nothing further");

    const r3 = requestApproval(d, { projectId: pid, actionKey: "remove-project:scratch", requestedBy: "sweep" });
    const rev = revokeApproval(d, r3.id, "operator", "not now");
    ok(deriveState(rev, "2026-08-06T20:00:00.000Z") === "revoked" && rev.revoked_by === "operator",
      "AC6: revokeApproval ends it early (§5 exit 3) — legal from `requested`");
    ok(events("approval.revoke").length === 1, "AC6: …and ledgers `approval.revoke`");

    // The state machine is a DAG: a terminal row refuses both terminating verbs, so `revoked_at` and
    // `discharged_at` can never both be set and deriveState's precedence is never load-bearing.
    ok(refuses(() => revokeApproval(d, r3.id, "operator"), "not-revocable").hit, "AC6: a revoked approval cannot be revoked again");
    ok(refuses(() => dischargeApproval(d, r3.id, "ops"), "not-dischargeable").hit, "AC6: …nor discharged");
    ok(refuses(() => grantApproval(d, { requestId: g2.id, grantor: "operator" }), "not-grantable").hit, "AC6: a discharged approval cannot be re-granted");
    ok(refuses(() => grantApproval(d, { requestId: g2.id, actionKey: "reopen:AP-1", grantor: "operator" }), "ambiguous-grant").hit,
      "AC6: requestId + actionKey together is REFUSED, not resolved by precedence — the operator must know which end state they granted");
    ok(refuses(() => revokeApproval(d, "no-such-id", "operator"), "not-found").hit, "AC6: an unknown id is a typed not-found, never a silent no-op");

    ok(listApprovals(d, { projectId: pid }).length >= 4, "AC6: listApprovals returns the project's rows");
    ok(listApprovals(d, { projectId: pid, states: ["revoked"] }).every((a) => a.state === "revoked"),
      "AC6: …filtered by DERIVED state");
    ok(listApprovals(d, { projectId: pid }).every((a) => typeof a.state === "string"),
      "AC6: …each item carrying its derived state");

    // A read is not an event on the board: §3 names five kinds and none of them is a list.
    const beforeList = d.prepare("SELECT count(*) c FROM events").get() as { c: number };
    listApprovals(d, { projectId: pid });
    const afterList = d.prepare("SELECT count(*) c FROM events").get() as { c: number };
    ok(beforeList.c === afterList.c, "AC6: listApprovals appends NO ledger row — reading the board is not an event on it");

    // A workspace-scoped approval still ledgers: events.project_id is NOT NULL, so it lands under the
    // named WORKSPACE_SCOPE rather than losing the audit line.
    const wsCount = (): number =>
      (d.prepare("SELECT count(*) c FROM events WHERE project_id = ? AND kind = 'approval.grant'").get(WORKSPACE_SCOPE) as { c: number }).c;
    const wsBefore = wsCount();
    const wsg = grantApproval(d, { projectId: null, actionKey: "npm-publish:@dyzsasd/dev-loop:1.15.1", grantor: "operator" });
    ok(wsg.project_id === null, "AC6: a workspace-scoped approval stores project_id NULL (§3)");
    ok(wsCount() === wsBefore + 1, `AC6: …and its ledger row lands under WORKSPACE_SCOPE, not dropped (${wsBefore} → ${wsCount()})`);

    // §5's release case, end to end: ONE key, four dispatches, still one approval.
    for (const mechanic of ["patch", "explicit", "resume-from-branch", "retry"]) {
      const v = consultApproval(d, "npm-publish:@dyzsasd/dev-loop:1.15.1", "2026-08-06T20:00:00.000Z", { projectId: null, actor: "operator" });
      ok(v.authorises, `AC6/§5: the '${mechanic}' dispatch is covered by the SAME grant — the key bounds it, not the expiry`);
    }
  }

  // ── AC7 — the default expiry is 24h; `never` must be spelled out ───────────────────────────────
  {
    ok(DEFAULT_EXPIRY === "24h", "AC7: DEFAULT_EXPIRY is 24h (§6)");
    ok(parseDuration("24h") === 86_400_000 && parseDuration("7d") === 604_800_000 && parseDuration("30m") === 1_800_000,
      "AC7: durations parse (24h / 7d / 30m)");
    ok(parseDuration("later") === null && parseDuration("0h") === null && parseDuration("-1d") === null,
      "AC7: a non-duration is null, not a silent 0");

    const from = "2026-08-06T00:00:00.000Z";
    ok(resolveExpiry(undefined, from) === "2026-08-07T00:00:00.000Z",
      `AC7: omitting --expires yields 24h, never unbounded (got ${resolveExpiry(undefined, from)})`);
    ok(resolveExpiry(NEVER, from) === null, "AC7: --expires never stores NULL");
    // A duration that parses cleanly can still land outside the range a Date can represent, and
    // `toISOString()` answers that with a bare RangeError — which the CLI, catching ApprovalError and
    // nothing else, let escape. `--expires 99999999d` is a plausible way to write "effectively never", and
    // it left the usage-error path entirely: a stack trace instead of the documented exit 2.
    ok(refuses(() => resolveExpiry("99999999d", from), "bad-expiry").hit,
      "an --expires beyond the representable date range is a typed bad-expiry, not a bare RangeError");
    ok(refuses(() => resolveExpiry("300000000d", from), "bad-expiry").hit,
      "…and so is an absurd one — the CLI's catch only sees ApprovalError");
    ok((resolveExpiry("3650d", from) ?? "").startsWith("20"),
      `…while a long-but-representable duration still resolves (got ${resolveExpiry("3650d", from)})`);
    ok(refuses(() => resolveExpiry("forever", from), "bad-expiry").hit,
      "AC7: only the exact word 'never' is unbounded — 'forever' is refused, not silently accepted");

    const dflt = grantApproval(d, { projectId: pid, actionKey: "reopen:AP-42", grantor: "operator" });
    const delta = Date.parse(dflt.expires_at!) - Date.parse(dflt.granted_at!);
    ok(delta === 86_400_000, `AC7: a grant with no --expires expires 24h after granted_at (got ${delta}ms)`);

    const forever = grantApproval(d, { projectId: pid, actionKey: "reopen:AP-43", grantor: "operator", expires: NEVER });
    ok(forever.expires_at === null, "AC7: an explicit `never` grant stores expires_at NULL");
    ok(consultApproval(d, "reopen:AP-43", "2099-01-01T00:00:00.000Z", { projectId: pid, record: false }).authorises,
      "AC7: …and it still authorises decades later — which is why it must be spelled out");
  }

  d.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function tableExists(db: import("node:sqlite").DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

console.log(fails === 0 ? "\nALL APPROVALS TESTS PASSED" : `\n${fails} APPROVALS TEST(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
