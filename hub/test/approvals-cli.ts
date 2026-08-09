// LOOP-392 — approvals C2: the verb surface, and the fire-refused grant that makes the design safe.
// Design: hubDoc:design/approvals (parent LOOP-383). One block per AC.
//
// The load-bearing block is AC2/AC3 read TOGETHER. Design §2 names one invariant — a fire must not be
// able to grant itself an approval — and the failure mode a refusal-only test cannot see is an
// implementation that refuses EVERYTHING: that would satisfy "approve is refused" while destroying
// `request`, which is the agent's only way to ask, and with it §1's "file it and move on". So every
// gate here is asserted in BOTH directions, and each refusal additionally asserts that the STORE did
// not change — an exit code alone cannot tell a refusal from a write that also printed one.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { listApprovals, type ApprovalListItem } from "../src/approvals.ts";
import { TOKEN_PREFIX } from "../src/destructive-guard.ts";
import { FIRE_REFUSED_VERBS, VERB_FLAGS, VERBS } from "../src/approvals-cli.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(hubRoot, "src", "cli.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-approvals-cli-")));
const DB = join(tmp, "hub.db");

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const SHA = "3f1c0de9ab4471e2c0d5b6a7e8f90123456789ab";
const PUSH_KEY = `push:main:${SHA}`;

interface Run { code: number; out: string; err: string }

/**
 * Spawn the real CLI. `fire` names the marker to set — the whole point of the suite, so it is an
 * explicit argument rather than something inherited: scrubFireEnv() strips the markers this suite is
 * itself running under, and each case then puts back exactly the one it means to test.
 */
function run(args: string[], fire?: "DEVLOOP_DEV_SPLIT" | "DEVLOOP_TEAM_SCOPE"): Run {
  const env: Record<string, string | undefined> = {
    ...scrubFireEnv(),
    DEVLOOP_HUB_DB: DB,
    DEVLOOP_PROJECT: "ap",
    DEVLOOP_ACTOR: fire ? "senior-dev" : "operator",
  };
  if (fire) env[fire] = "true";
  const r = spawnSync("node", [CLI, ...args], { cwd: tmp, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** The store as the CLI left it — every refusal is checked against this, not against its own output. */
function rows(): ApprovalListItem[] {
  const db = openDb(DB);
  try { return listApprovals(db, {}); } finally { db.close(); }
}
const byKey = (k: string): ApprovalListItem | undefined => rows().filter((r) => r.action_key === k).at(-1);

try {
  { const db = openDb(DB); ensureSeed(db, "ap", "Approvals", "AP"); db.close(); }

  // ── AC1 — the four verbs exist and do what they say ──────────────────────────────────────────────
  {
    const granted = run(["approve", PUSH_KEY, "--note", "release cut"]);
    ok(granted.code === 0, `AC1 approve exits 0 (got ${granted.code}; ${granted.err.trim().slice(0, 160)})`);
    const row = byKey(PUSH_KEY);
    ok(row?.state === "granted", `AC1 approve leaves a GRANTED row (state=${row?.state})`);
    ok(row?.grantor === "operator", `AC1 the grantor is the human identity, not the store's default (grantor=${row?.grantor})`);
    // §6: omission is bounded, never unbounded — the property that keeps a grant from becoming a capability.
    ok(!!row?.expires_at, "AC1 an omitted --expires still bounds the grant (expires_at is set)");

    const listed = run(["approvals", "--json"]);
    ok(listed.code === 0, `AC1 approvals exits 0 (got ${listed.code})`);
    let parsed: ApprovalListItem[] = [];
    let parseOk = true;
    try { parsed = JSON.parse(listed.out) as ApprovalListItem[]; } catch { parseOk = false; }
    ok(parseOk && Array.isArray(parsed), "AC1 --json output is the op body: a parseable JSON array on stdout");
    ok(parsed.some((r) => r.action_key === PUSH_KEY && r.state === "granted"),
      "AC1 the listing carries the granted row with its DERIVED state");

    const requested = run(["request", "npm-publish:@dyzsasd/dev-loop:1.15.1", "--ticket", "AP-1"]);
    ok(requested.code === 0, `AC1 request exits 0 (got ${requested.code}; ${requested.err.trim().slice(0, 160)})`);
    const req = byKey("npm-publish:@dyzsasd/dev-loop:1.15.1");
    ok(req?.state === "requested" && req.ticket_id === "AP-1",
      `AC1 request files a PENDING row against its ticket (state=${req?.state}, ticket=${req?.ticket_id})`);
    ok(req?.granted_at === null, "AC1 a request authorises nothing — granted_at stays NULL");

    // The two grant shapes: a fresh key, and an agent's standing request.
    const fromReq = run(["approve", "--request", req!.id]);
    ok(fromReq.code === 0, `AC1 approve --request grants a standing request (got ${fromReq.code}; ${fromReq.err.trim().slice(0, 160)})`);
    ok(byKey("npm-publish:@dyzsasd/dev-loop:1.15.1")?.state === "granted", "AC1 the requested row becomes granted");

    const revoked = run(["revoke", PUSH_KEY]);
    ok(revoked.code === 0, `AC1 revoke <key> exits 0 (got ${revoked.code}; ${revoked.err.trim().slice(0, 160)})`);
    ok(byKey(PUSH_KEY)?.state === "revoked", `AC1 revoke <key> resolves the key and ends it (state=${byKey(PUSH_KEY)?.state})`);
  }

  // ── AC1 (cont.) — a flag whose value would be silently ignored is a LOUD usage error ─────────────
  //
  // C1 refuses requestId + actionKey together rather than resolving by precedence, because silently
  // dropping one lets the operator believe they authorised something they did not. The same reasoning
  // binds the CLI's own flag combinations, so they are refused rather than quietly discarded.
  {
    const req = run(["request", "reopen:AP-42", "--ticket", "AP-42"], "DEVLOOP_DEV_SPLIT");
    ok(req.code === 0, `AC1 fixture: a request to re-target (got ${req.code})`);
    const id = byKey("reopen:AP-42")!.id;

    const both = run(["approve", "reopen:AP-42", "--request", id]);
    ok(both.code === 2, `AC1 <key> together with --request is a usage error (got ${both.code})`);

    for (const extra of [["--ticket", "AP-99"], ["--project", "ap"], ["--workspace"]]) {
      const r = run(["approve", "--request", id, ...extra]);
      ok(r.code === 2, `AC1 ${extra[0]} with --request is refused, not ignored (got ${r.code})`);
    }
    ok(byKey("reopen:AP-42")?.state === "requested",
      `AC1 none of those refusals granted anything (state=${byKey("reopen:AP-42")?.state})`);

    const allPlusScope = run(["approvals", "--all", "--workspace"]);
    ok(allPlusScope.code === 2, `AC1 --all with a narrower scope flag is a usage error (got ${allPlusScope.code})`);

    ok(run(["approve", "--request", id]).code === 0, "AC1 the same request grants cleanly once the flags are unambiguous");
    ok(byKey("reopen:AP-42")?.state === "granted", "AC1 and it is granted");
  }

  // ── AC2 — approve and revoke are FIRE-REFUSED (design §2, the module's one invariant) ────────────
  //
  // Asserted on the STORE, not on the exit code: an implementation that printed a refusal and wrote
  // anyway is exactly the regression this module cannot survive, and it passes an exit-code-only test.
  {
    const liveKey = `push:main:${"a".repeat(40)}`;
    ok(run(["approve", liveKey]).code === 0, "AC2 fixture: the grant lands with no marker set");
    const before = rows().length;

    for (const marker of ["DEVLOOP_DEV_SPLIT", "DEVLOOP_TEAM_SCOPE"] as const) {
      const r = run(["approve", `push:main:${"b".repeat(40)}`], marker);
      ok(r.code === 4, `AC2 approve refuses under ${marker} with exit 4 (got ${r.code})`);
      ok(r.err.includes(marker), `AC2 the refusal names the marker it saw (${marker})`);
      ok(rows().length === before, `AC2 approve under ${marker} wrote NOTHING (${rows().length} rows, expected ${before})`);
    }

    for (const marker of ["DEVLOOP_DEV_SPLIT", "DEVLOOP_TEAM_SCOPE"] as const) {
      const r = run(["revoke", liveKey], marker);
      ok(r.code === 4, `AC2 revoke refuses under ${marker} with exit 4 (got ${r.code})`);
      ok(byKey(liveKey)?.state === "granted",
        `AC2 revoke under ${marker} left the approval GRANTED (state=${byKey(liveKey)?.state})`);
    }

    // The set the code gates on is the set this suite names — not two lists that can drift apart.
    ok([...FIRE_REFUSED_VERBS].sort().join(",") === "approve,revoke",
      `AC2 the fire-refused set is exactly {approve, revoke} (got {${[...FIRE_REFUSED_VERBS].sort().join(", ")}})`);
  }

  // ── AC3 — request and approvals ARE agent-callable, and approve works without a marker ───────────
  //
  // The control for AC2. Without these three, "refuses everything" is indistinguishable from correct.
  {
    const asked = run(["request", `reopen:AP-9`, "--ticket", "AP-9"], "DEVLOOP_DEV_SPLIT");
    ok(asked.code === 0, `AC3 request SUCCEEDS inside a fire (got ${asked.code}; ${asked.err.trim().slice(0, 200)})`);
    ok(byKey("reopen:AP-9")?.state === "requested", "AC3 the in-fire request actually landed a row");
    ok(byKey("reopen:AP-9")?.requested_by === "senior-dev",
      `AC3 the request is attributed to the asking agent (requested_by=${byKey("reopen:AP-9")?.requested_by})`);

    const read = run(["approvals"], "DEVLOOP_DEV_SPLIT");
    ok(read.code === 0, `AC3 approvals SUCCEEDS inside a fire (got ${read.code}; ${read.err.trim().slice(0, 200)})`);
    ok(read.out.includes("reopen:AP-9"), "AC3 the in-fire listing actually returns rows");

    const grantOutsideFire = run(["approve", `reopen:AP-10`]);
    ok(grantOutsideFire.code === 0,
      `AC3 approve SUCCEEDS with no marker — the refusal is the fire, not the verb (got ${grantOutsideFire.code})`);
    ok(byKey("reopen:AP-10")?.state === "granted", "AC3 the out-of-fire grant actually landed");
  }

  // ── AC4 — the refusal names the operator's path and NO bypass ────────────────────────────────────
  {
    const r = run(["approve", `push:main:${"c".repeat(40)}`], "DEVLOOP_DEV_SPLIT");
    // Control first: an empty string trivially contains no bypass token, so absence alone proves nothing.
    ok(r.err.includes("dev-loop request"),
      "AC4 the refusal names what the caller may legitimately do instead (dev-loop request)");
    ok(/operator/i.test(r.err), "AC4 the refusal names who can grant it");

    // Every shape by which a caller could make THIS invocation proceed: a confirmation token, an
    // override flag, or an instruction to clear the marker it is gated on.
    const BYPASS = [TOKEN_PREFIX, "--i-am-the-operator", "--force", "--yes", "--override", "--no-verify",
      "unset ", "env -u", "DEVLOOP_DEV_SPLIT=", "DEVLOOP_TEAM_SCOPE="];
    const leaked = BYPASS.filter((t) => r.err.includes(t));
    ok(leaked.length === 0, `AC4 the refusal documents no bypass (leaked: ${leaked.join(", ") || "none"})`);
  }

  // ── AC5 — every verb's --help carries the key grammar, legal AND illegal ─────────────────────────
  {
    for (const v of VERBS) {
      const h = run([v, "--help"]);
      ok(h.code === 0, `AC5 ${v} --help exits 0 (got ${h.code})`);
      ok(h.out.includes(`push:main:${SHA}`), `AC5 ${v} --help shows the LEGAL worked key (push:main:<sha>)`);
      ok(/ILLEGAL\s+push:main\b/.test(h.out), `AC5 ${v} --help shows push:main as the ILLEGAL counter-example`);
      ok(h.out.includes("END STATE"), `AC5 ${v} --help states the rule the examples illustrate`);
    }
  }

  // ── AC6 — the §4 grant-time lint surfaces as a usage error, not a stack trace ────────────────────
  {
    const capability = run(["approve", "push:main"]);
    ok(capability.code === 2, `AC6 a key naming a capability is a USAGE error (exit 2; got ${capability.code})`);
    ok(capability.err.includes("<branch>:<sha>"),
      `AC6 the refusal prints the registry's expected shape (got: ${capability.err.trim().slice(0, 200)})`);
    ok(!/^\s+at /m.test(capability.err), "AC6 it is a message, not a stack trace");
    ok(rows().every((r) => r.action_key !== "push:main"), "AC6 the illegal key was not written");

    const unknown = run(["approve", "deploy:prod:v1"]);
    ok(unknown.code === 2, `AC6 an unknown action class is a usage error (got ${unknown.code})`);
    ok(unknown.err.includes("npm-publish") && unknown.err.includes("remove-project"),
      "AC6 the refusal enumerates the legal classes");

    const badExpiry = run(["approve", `push:main:${"d".repeat(40)}`, "--expires", "soon"]);
    ok(badExpiry.code === 2, `AC6 a malformed --expires is a usage error (got ${badExpiry.code})`);
    ok(badExpiry.err.includes("never"), "AC6 the expiry refusal names the one word that means unbounded");

    // A request is linted at the same boundary — design §4: a capability key must never reach the
    // operator's queue looking grantable.
    const badRequest = run(["request", "push:main", "--ticket", "AP-1"], "DEVLOOP_DEV_SPLIT");
    ok(badRequest.code === 2, `AC6 request lints the key too (got ${badRequest.code})`);
    ok(rows().every((r) => r.action_key !== "push:main"), "AC6 no capability key entered the store by either path");
  }

  // ── Review findings (Codex, PR #280) — the three defects the verb surface shipped with ───────────
  //
  // All three share one shape: an argument the caller wrote is read by a code path that was never
  // told what it meant, so the command succeeds while doing something other than what was typed. Each
  // is asserted in BOTH directions — the refusal AND the control that still works — because a fix
  // that simply refused more would be indistinguishable here from a correct one.
  {
    // P1 — key-based revocation searched EVERY project. Granting in 'bp' and revoking with
    // --project ap exited 0 and ended bp's grant: an authorization cancelled in a project the
    // operator never named, which they would then believe was still in force.
    { const db = openDb(DB); ensureSeed(db, "bp", "Approvals B", "BP"); db.close(); }
    const OTHER = `push:main:${"e".repeat(40)}`;
    ok(run(["approve", OTHER, "--project", "bp"]).code === 0, "P1 fixture: a grant scoped to project bp");
    ok(byKey(OTHER)?.state === "granted", "P1 fixture: bp's grant is live");

    const crossProject = run(["revoke", OTHER, "--project", "ap"]);
    ok(crossProject.code === 1, `P1 revoking bp's key from project ap finds nothing to revoke (got ${crossProject.code})`);
    ok(byKey(OTHER)?.state === "granted",
      `P1 bp's grant is UNTOUCHED by a revoke aimed at ap (state=${byKey(OTHER)?.state})`);
    ok(crossProject.err.includes("ap"), "P1 the refusal names the scope it searched, so the operator can see why");

    // Control A: the SAME key revokes cleanly from its own project — the fix scopes, it does not break revoke.
    ok(run(["revoke", OTHER, "--project", "bp"]).code === 0, "P1 control: the owning project revokes it");
    ok(byKey(OTHER)?.state === "revoked", `P1 control: and it is revoked (state=${byKey(OTHER)?.state})`);

    // Control B: a workspace-scoped grant covers every project, so it MUST stay revocable from one —
    // the over-narrow fix (project rows only) fails exactly here.
    const WS = `push:main:${"f".repeat(40)}`;
    ok(run(["approve", WS, "--workspace"]).code === 0, "P1 control: a workspace-scoped grant");
    ok(run(["revoke", WS]).code === 0, "P1 control: a workspace-scoped grant is revocable from project scope");
    ok(byKey(WS)?.state === "revoked", `P1 control: and it ended (state=${byKey(WS)?.state})`);

    // An explicit id already carries its scope, so a scope flag with it could only be ignored.
    const ID = `reopen:AP-55`;
    ok(run(["request", ID, "--ticket", "AP-55"], "DEVLOOP_DEV_SPLIT").code === 0, "P1 fixture: a request to revoke by id");
    const rid = byKey(ID)!.id;
    ok(run(["revoke", rid, "--project", "ap"]).code === 2, "P1 --project with an explicit id is refused, not ignored");
    ok(byKey(ID)?.state === "requested", `P1 that refusal revoked nothing (state=${byKey(ID)?.state})`);
    ok(run(["revoke", rid]).code === 0, "P1 control: the same id revokes cleanly with no scope flag");
  }
  {
    // P2 — one union of every verb's flags meant a flag for another verb parsed and was then read by
    // nobody: `request … --expires never --state granted --all` exited 0 having applied none of them.
    const KEY = "reopen:AP-77";
    const strays = run(["request", KEY, "--ticket", "AP-77", "--expires", "never", "--state", "granted", "--all"]);
    ok(strays.code === 2, `P2 flags that do not apply to 'request' are a usage error (got ${strays.code})`);
    ok(!byKey(KEY), "P2 and nothing was written while those flags were being ignored");
    for (const f of ["--expires", "--state", "--all"]) {
      ok(strays.err.includes(f), `P2 the refusal names ${f}, so the caller knows which flag did nothing`);
    }
    // Control: the same command without the strays still works — the allowlist admits its own verb's flags.
    ok(run([                       "request", KEY, "--ticket", "AP-77", "--note", "n"]).code === 0,
      "P2 control: request with only its own flags still succeeds");
    ok(byKey(KEY)?.state === "requested", "P2 control: and it landed");
    // Control: a flag legal for ANOTHER verb is legal for the verb that owns it.
    ok(run(["approvals", "--state", "granted"]).code === 0, "P2 control: --state is accepted by the verb that reads it");

    // The table the code gates on is the table this suite names — not two lists that can drift apart.
    for (const v of VERBS) ok(VERB_FLAGS[v].has("json") && VERB_FLAGS[v].has("help"),
      `P2 every verb admits --json/--help (${v})`);
  }
  {
    // P3 — a value flag swallowed a following option: `request <key> --ticket --workspace` recorded
    // "--workspace" as the ticket AND lost the scope flag, writing a project-scoped row from a
    // command that asked for a workspace-scoped one.
    const KEY = "reopen:AP-88";
    const dangling = run(["request", KEY, "--ticket", "--workspace"]);
    ok(dangling.code === 2, `P3 a value flag followed by another option is a usage error (got ${dangling.code})`);
    ok(!rows().some((r) => r.ticket_id === "--workspace"), "P3 no row recorded a flag as its ticket id");
    ok(!byKey(KEY), "P3 and the malformed invocation wrote nothing at all");
    ok(dangling.err.includes("--workspace"), "P3 the refusal names the token it refused to swallow");

    // Control: the '=' form still carries a value that genuinely begins with '--'.
    const eqForm = run(["request", KEY, "--ticket=--odd-but-real"]);
    ok(eqForm.code === 0, `P3 control: --flag=<value> still accepts a value starting with '--' (got ${eqForm.code}; ${eqForm.err.trim().slice(0, 160)})`);
    ok(byKey(KEY)?.ticket_id === "--odd-but-real", `P3 control: and it is stored verbatim (ticket=${byKey(KEY)?.ticket_id})`);
  }

  console.log(fails ? `\n${fails} assertion(s) failed` : "\nAPPROVALS_CLI_OK");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
