// LOOP-550 — WHICH refusing row a verdict's reason is about.
//
// `consultApproval` chose it by rowid (`candidates.at(-1)`), so a request filed after a grant had
// lapsed reported "requested but not granted" and never mentioned the lapsed grant at all. The two
// situations call for different operator moves — re-grant with a longer window vs. grant for the
// first time — and the verdict could not tell them apart. `REASON_PRECEDENCE` decides it instead.
//
// THE PROPERTY THAT MAKES EVERY PRECEDENCE ASSERTION BELOW HONEST: each pair seeds the LOSER LAST.
// With the winner at the lower rowid, `candidates.at(-1)` returns the loser, so each assertion is red
// against the old code rather than green by coincidence of insertion order. A precedence test that
// seeds the winner last passes against a plain `at(-1)` and proves nothing.
import { realpathSync, rmSync } from "node:fs";

import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import {
  AUTHORISING_STATE, REASON_PRECEDENCE, consultApproval, coverageQuery, dischargeApproval,
  grantApproval, requestApproval, revokeApproval, type ApprovalState,
} from "../src/approvals.ts";
import { tmpRoot } from "./tmp-root.ts";

const tmp = realpathSync(tmpRoot("dl-approvals-reason-"));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const SHA = "3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab";
// Consulted two hours ahead of the writers' own clock, which is what separates a "1h" grant (expired
// by then) from a "24h" one (still live) without any sleeping.
const NOW = new Date(Date.now() + 2 * 3_600_000).toISOString();

try {
  const dbPath = join(tmp, "hub.db");
  const db: DatabaseSync = openDb(dbPath);
  ensureSeed(db, "ap", "Approvals", "AP");
  const pid = findProject(db, "ap")!;

  /** Seed ONE row for `key` deriving `state` at NOW, and return its id. Rowid order = call order. */
  const seed = (key: string, state: ApprovalState): string => {
    if (state === "requested") return requestApproval(db, { projectId: pid, actionKey: key, requestedBy: "junior-dev" }).id;
    const row = grantApproval(db, {
      projectId: pid, actionKey: key, grantor: "operator",
      expires: state === "expired" ? "1h" : "24h",
    });
    if (state === "revoked") revokeApproval(db, row.id, "operator");
    if (state === "discharged") dischargeApproval(db, row.id, "operator");
    return row.id;
  };
  /** Seed a whole key in one call, in the given rowid order. */
  const seedKey = (key: string, states: readonly ApprovalState[]): string[] => states.map((s) => seed(key, s));
  const consult = (key: string) => consultApproval(db, key, NOW, { projectId: pid, record: false });

  // ── AC1 + AC2 — the reported case: an expired grant, then a request. Both facts, one verdict. ───
  {
    const key = `push:ac1:${SHA}`;
    const [expiredId, requestId] = seedKey(key, ["expired", "requested"]); // the request is LAST
    const v = consult(key);
    const reason = v.reason ?? "";
    const expiresAt = v.approval?.expires_at ?? "";

    ok(v.authorises === false, "AC1: an expired grant plus a later request does not authorise");
    ok(v.state === "expired" && v.approval?.id === expiredId,
      `AC1: …and the verdict is ABOUT the expired grant, not the newer request (state=${v.state}, id=${v.approval?.id})`);
    ok(reason.includes(expiredId!) && /expired at/.test(reason) && expiresAt !== "" && reason.includes(expiresAt),
      `AC1: …the reason names the expired grant's id AND the timestamp it expired at (${reason})`);
    ok(!/^approval \S+ for \S+ is requested but not granted$/.test(reason),
      "AC1: …and is not the request-only sentence that hid it");
    ok(reason.includes(requestId!) && /request \(/.test(reason),
      `AC2: …while STILL naming the pending request — replacing one omission with the other is not a fix (${reason})`);

    // The surface the ticket is written against. `coverageQuery` passes `consultApproval`'s reason
    // through, so `--covers` is only fixed if the pass-through is asserted, not assumed.
    const c = coverageQuery(db, key, NOW, { projectId: pid });
    ok(c.covered === false && c.state === "expired" && c.reason === reason,
      `AC1: …and \`approvals --covers\` reports the same verdict verbatim (covered=${c.covered}, state=${c.state})`);
  }

  // ── AC3 — one ordered list, and every ADJACENT PAIR asserted on its own ────────────────────────
  //
  // Per pair, not one walk of the whole order: a single 4-row case passes as long as `expired` sorts
  // first and says nothing about `revoked` > `discharged`, which is the pair a reorder breaks.
  {
    ok(REASON_PRECEDENCE.join(">") === "expired>revoked>discharged>requested",
      `AC3: the precedence is ONE ordered list in code (${REASON_PRECEDENCE.join(" > ")})`);

    const pairs: [ApprovalState, ApprovalState][] = [["expired", "revoked"], ["revoked", "discharged"], ["discharged", "requested"]];
    for (const [winner, loser] of pairs) {
      const key = `push:ac3-${winner}-${loser}:${SHA}`;
      const [winnerId] = seedKey(key, [winner, loser]); // loser LAST — `at(-1)` would return it
      const v = consult(key);
      ok(v.state === winner && v.approval?.id === winnerId,
        `AC3: ${winner} > ${loser} — with the ${loser} row at the HIGHER rowid, the reason is still about the ${winner} one (got ${v.state})`);
    }
  }

  // ── AC4 — an authorising row still wins, and the verdict names IT ──────────────────────────────
  //
  // The arm a precedence reorder is most likely to break: `expired` now sorts first of all, and if the
  // list were ever consulted before the authorising filter, a live grant sitting beside a lapsed one
  // would start refusing a push the operator did approve.
  {
    const key = `push:ac4:${SHA}`;
    const [liveId] = seedKey(key, ["granted", "expired"]); // the EXPIRED row is last, and outranks by list
    const v = consult(key);
    ok(v.authorises === true && v.state === AUTHORISING_STATE && v.approval?.id === liveId,
      `AC4: a live grant beside an expired one authorises, and the verdict names the LIVE grant (authorises=${v.authorises}, id=${v.approval?.id})`);
    ok(v.reason === null, "AC4: …with reason null, exactly when it authorises — the §5 invariant is untouched");

    const c = coverageQuery(db, key, NOW, { projectId: pid });
    ok(c.covered === true && c.approval?.id === liveId && c.reason === null,
      "AC4: …and `--covers` reports covered against the live grant");
  }

  // ── AC5 — `authorises` did not move for ANY state combination ─────────────────────────────────
  //
  // Derived rather than listed: for every non-empty subset of the five states, in BOTH rowid
  // directions, `authorises` must equal "a live grant is present" and nothing else. That is the whole
  // truth table this change was not allowed to touch, so a reason-selection bug that leaked into the
  // decision cannot hide in a combination the existing suite happens not to seed.
  {
    const ALL: ApprovalState[] = ["requested", "granted", "revoked", "discharged", "expired"];
    let checked = 0, moved = 0;
    for (let mask = 1; mask < 1 << ALL.length; mask++) {
      const combo = ALL.filter((_, i) => mask & (1 << i));
      for (const [dir, states] of [["asc", combo], ["desc", [...combo].reverse()]] as const) {
        const key = `push:ac5-${mask}-${dir}:${SHA}`;
        seedKey(key, states);
        const v = consult(key);
        const want = combo.includes(AUTHORISING_STATE);
        checked++;
        if (v.authorises !== want) { moved++; console.log(`   ↳ ${dir} [${combo.join(",")}] → authorises=${v.authorises}, want=${want}`); }
        // A refusal must always carry a reason, and an authorisation never one — the same invariant,
        // asserted across the same truth table rather than only on the two cases above.
        if ((v.reason === null) !== v.authorises) { moved++; console.log(`   ↳ ${dir} [${combo.join(",")}] → reason/authorises disagree`); }
      }
    }
    ok(moved === 0 && checked === 62,
      `AC5: \`authorises\` is exactly "a live grant is present" across all ${checked} state combinations × rowid orders (${moved} moved)`);
  }

  // ── The multi-request wording — named, and counted when there is more than one ─────────────────
  {
    const key = `push:multi:${SHA}`;
    const ids = seedKey(key, ["expired", "requested", "requested"]);
    const reason = consult(key).reason ?? "";
    ok(/2 requests are pending \(latest /.test(reason) && reason.includes(ids.at(-1)!),
      `AC2: two pending requests are counted, and the latest is the one named (${reason})`);
  }

  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nAll approvals-reason checks passed." : `\n${fails} approvals-reason check(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
