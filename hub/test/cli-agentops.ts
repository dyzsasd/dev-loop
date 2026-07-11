// A1 — the CLI WRITE layer (hub/src/cli-agentops.ts, D8 CLI-first steps 1–2) + the --json read extension
// (cli-tickets.ts). Drives the REAL `node src/cli.ts <verb> …` (so the ROUTES wiring, the ticket
// create/update re-route, and NEEDS_NODE_SQLITE are exercised too) against an ISOLATED temp hub DB.
// Asserts: the LAYER 0 op dispatcher round-trip (save_issue via `op` → visible via `tickets --json`); each
// sugar verb's happy path; the labels-REPLACE hazard; the relatedTo APPEND-only union; doc save's CAS
// CONFLICT → exit 3 with the {latestVersion,…} payload on stderr; the exit-code contract (2 usage · 1 domain
// · 4 identity/guard · 5 hub unavailable); the operator-in-a-fire cooperative write guard; the D1 --project
// override (dev → FORBIDDEN exit 1; steward → crosses); byte-PARITY sugar ≡ `op` dispatcher ≡ the stdio MCP
// server for list_issues/get_issue (+ field-parity for save_issue, whose updated_at necessarily differs);
// and the daemon transport (settings_json.hub.transport="daemon" → the op POSTs to the loopback daemon).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync, spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { openDb } from "../src/db.ts";
import { ensureSeed, ensureProject, findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";

const ROOT = "/tmp/hub-cli-agentops-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const DB = join(ROOT, "hub.db");

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// ── seed: the main project (direct-db), a sibling (the D1 override target), a daemon-transport project ──
{
  const db = openDb(DB);
  ensureSeed(db, "cwt", "CLI Write Test", "CW");
  ensureProject(db, "cwt2", "CW Sibling", "CX");
  const p3 = ensureProject(db, "cwt3", "CW Daemon", "CY");
  db.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify({ hub: { transport: "daemon" } }), p3);
  // db.ts regression (A1 step 5): every per-command writable connection must carry the 5s busy_timeout.
  const bt = (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;
  ok(bt === 5000, `openDb sets PRAGMA busy_timeout=5000 (got ${bt})`);
  db.close();
}

// run the REAL unified CLI (src/cli.ts routes to cli-agentops/cli-tickets) with an isolated env. Fire-marker
// vars are STRIPPED from the base env (the build-artifact leak lesson) so only an explicit override sets them.
function cliEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "cwt", DEVLOOP_ACTOR: "pm" };
  delete base.DEVLOOP_TEAM_SCOPE; delete base.DEVLOOP_DEV_SPLIT; delete base.DEVLOOP_HUB_PORT; delete base.DEVLOOP_PROJECTS_JSON;
  return { ...base, ...env } as NodeJS.ProcessEnv;
}
function cli(args: string[], env: Record<string, string | undefined> = {}, stdin?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("node", ["src/cli.ts", ...args], { encoding: "utf8", timeout: 60000, env: cliEnv(env), input: stdin ?? "" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
// ASYNC variant for the daemon-transport section: the daemon lives IN-PROCESS here, so a blocking spawnSync
// would freeze this process's event loop and the daemon could never answer (a guaranteed 30s timeout).
function cliAsync(args: string[], env: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("node", ["src/cli.ts", ...args], { env: cliEnv(env) });
    let out = "", errS = "";
    p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (errS += c));
    p.on("close", (code) => resolve({ status: code, stdout: out, stderr: errS }));
    p.stdin.end("");
  });
}
const j = (s: string): any => JSON.parse(s);
// the CLI's machine-readable stderr line (node's ExperimentalWarning banners share the stream — take the
// last JSON-looking line, which is what a mechanical caller would parse too).
const stderrJson = (s: string): any => {
  const line = s.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  try { return line ? JSON.parse(line) : {}; } catch { return {}; }
};

// ═══ 1. LAYER 0 — the generic op dispatcher ═══════════════════════════════════════════════════════════════
const viaOp = cli(["op", "save_issue", "--args-json", JSON.stringify({ title: "Via op dispatcher", type: "Feature", labels: ["dev-loop", "Feature", "pm"], priority: 2 })]);
ok(viaOp.status === 0, `op save_issue → exit 0 (got ${viaOp.status}; stderr: ${viaOp.stderr.trim()})`);
const opTicket = viaOp.status === 0 ? j(viaOp.stdout) : {};
ok(opTicket.id === "CW-1" && opTicket.created_by === "pm" && opTicket.state === "Todo" && opTicket.priority === 2,
  "op save_issue → the op body as JSON on stdout (CW-1, created_by pm, Todo)");
const roundTrip = cli(["tickets", "--json"]);
ok(roundTrip.status === 0 && j(roundTrip.stdout).some((t: any) => t.id === "CW-1" && t.title === "Via op dispatcher"),
  "round-trip: the op-created ticket is visible via `tickets --json`");
// args on stdin (no --args-json, stdin piped)
const viaStdin = cli(["op", "get_issue"], {}, JSON.stringify({ id: "CW-1" }));
ok(viaStdin.status === 0 && j(viaStdin.stdout).id === "CW-1" && Array.isArray(j(viaStdin.stdout).comments),
  "op get_issue with JSON args on STDIN → the ticket + comments");
const badOp = cli(["op", "nonsense"]);
ok(badOp.status === 2 && /unknown op 'nonsense'/.test(badOp.stderr), `op <unknown> → usage exit 2 listing the ops (status ${badOp.status})`);
const badJson = cli(["op", "list_issues", "--args-json", "{nope"]);
ok(badJson.status === 2 && /not valid JSON/.test(badJson.stderr), `op --args-json '{nope' → usage exit 2 (status ${badJson.status})`);

// ═══ 2. sugar verbs — happy paths ═══════════════════════════════════════════════════════════════════════════
// ticket create (full flag surface)
const created = cli(["ticket", "create", "--title", "Sugar bug", "--type", "Bug", "--labels", "dev-loop,Bug,qa",
  "--priority", "1", "--assignee", "qa", "--description", "Repro: it explodes"]);
ok(created.status === 0, `ticket create → exit 0 (got ${created.status}; stderr: ${created.stderr.trim()})`);
const sugarBug = created.status === 0 ? j(created.stdout) : {};
ok(sugarBug.id === "CW-2" && sugarBug.type === "Bug" && sugarBug.priority === 1 && sugarBug.assignee === "qa"
  && sugarBug.description === "Repro: it explodes" && JSON.stringify(sugarBug.labels) === JSON.stringify(["dev-loop", "Bug", "qa"]),
  "ticket create → all flags land (type/labels/priority/assignee/description)");
// --description-file
const descFile = join(ROOT, "desc.md");
writeFileSync(descFile, "## From a file\nbody line\n");
const fromFile = cli(["ticket", "create", "--title", "File desc", "--type", "Improvement", "--description-file", descFile]);
ok(fromFile.status === 0 && j(fromFile.stdout).description === "## From a file\nbody line\n",
  "ticket create --description-file → the file content is the description verbatim");
// --blocked-by → the §9c 'Blocked-by:' marker comment after the create
const parked = cli(["ticket", "create", "--title", "Parked on externals", "--type", "Improvement", "--blocked-by", "CW-1,CW-2"]);
ok(parked.status === 0, `ticket create --blocked-by → exit 0 (got ${parked.status})`);
const parkedId = parked.status === 0 ? j(parked.stdout).id : "";
const parkedComments = cli(["comments", parkedId]);
ok(parkedComments.status === 0 && j(parkedComments.stdout).some((c: any) => c.body === "Blocked-by: CW-1\nBlocked-by: CW-2" && c.author === "pm"),
  "ticket create --blocked-by → writes the machine-parseable 'Blocked-by: <id>' marker comment (one line per id, §9c)");

// ticket update — state transition + the labels-REPLACE hazard + the relatedTo APPEND-only union
const upd = cli(["ticket", "update", "CW-2", "--state", "In Progress"]);
ok(upd.status === 0 && j(upd.stdout).state === "In Progress", "ticket update --state → transitions the ticket");
const replaced = cli(["ticket", "update", "CW-2", "--labels", "qa"]);
ok(replaced.status === 0 && JSON.stringify(j(replaced.stdout).labels) === JSON.stringify(["qa"]),
  "HAZARD proven: --labels REPLACES the full set (dev-loop/Bug dropped; only 'qa' remains)");
const rel1 = cli(["ticket", "update", "CW-2", "--related-to", "+CW-1"]);
ok(rel1.status === 0 && JSON.stringify(j(rel1.stdout).relatedTo) === JSON.stringify(["CW-1"]), "ticket update --related-to +CW-1 → link added");
const rel2 = cli(["ticket", "update", "CW-2", "--related-to", parkedId]);
ok(rel2.status === 0 && JSON.stringify(j(rel2.stdout).relatedTo.slice().sort()) === JSON.stringify(["CW-1", parkedId].sort()),
  "HAZARD proven: --related-to is an APPEND-only union (the earlier CW-1 link survives the second update)");
const dup = cli(["ticket", "update", parkedId, "--state", "Duplicate", "--duplicate-of", "CW-2"]);
ok(dup.status === 0 && j(dup.stdout).duplicateOf === "CW-2" && j(dup.stdout).state === "Duplicate", "ticket update --duplicate-of → the §8 dedupe scalar");
const noop = cli(["ticket", "update", "CW-2"]);
ok(noop.status === 2 && /nothing to update/.test(noop.stderr), `ticket update with no field flags → usage exit 2 (status ${noop.status})`);

// comment add — --body, then stdin '-'
const cmt = cli(["comment", "add", "CW-2", "--body", "from --body"]);
ok(cmt.status === 0 && j(cmt.stdout).author === "pm" && j(cmt.stdout).body === "from --body", "comment add --body → authored as the resolved actor");
const cmtStdin = cli(["comment", "add", "CW-2", "-"], {}, "from stdin\nline 2");
ok(cmtStdin.status === 0 && j(cmtStdin.stdout).body === "from stdin\nline 2", "comment add <id> - → body from stdin");
const cmts = cli(["comments", "CW-2"]);
ok(cmts.status === 0 && j(cmts.stdout).length === 2 && j(cmts.stdout)[0].body === "from --body",
  "comments <id> → the chronological comment list as JSON");

// labels / label create / project / events
const labels0 = cli(["labels"]);
ok(labels0.status === 0 && j(labels0.stdout).some((l: any) => l.name === "dev-loop"), "labels → the seeded taxonomy as JSON");
const mkLabel = cli(["label", "create", "cli-test-label", "--kind", "marker"]);
ok(mkLabel.status === 0 && j(mkLabel.stdout).name === "cli-test-label", "label create → the created label as JSON");
ok(j(cli(["labels"]).stdout).some((l: any) => l.name === "cli-test-label"), "labels → includes the just-created label");
const proj = cli(["project"]);
ok(proj.status === 0 && j(proj.stdout).key === "cwt" && j(proj.stdout).ticket_prefix === "CW", "project → the active project as JSON");
const evTicket = cli(["events", "--ticket", "CW-2", "--limit", "50"]);
ok(evTicket.status === 0 && j(evTicket.stdout).length > 0 && j(evTicket.stdout).every((e: any) => e.ticket_id === "CW-2"),
  "events --ticket → only that ticket's attribution rows");
const evLim = cli(["events", "--limit", "3"]);
ok(evLim.status === 0 && j(evLim.stdout).length === 3, "events --limit 3 → capped at 3 rows");
const evSince = cli(["events", "--since", "9999-01-01T00:00:00Z"]);
ok(evSince.status === 0 && j(evSince.stdout).length === 0, "events --since <future> → the client-side ISO filter empties the list");

// ═══ 3. doc family — 1:1 + the CAS CONFLICT → exit 3 contract ══════════════════════════════════════════════
const dSave = cli(["doc", "save", "--slug", "notes", "--kind", "notes", "--base-version", "0"], {}, "hello");
ok(dSave.status === 0 && j(dSave.stdout).version === 1 && j(dSave.stdout).status === "draft", "doc save (stdin body, baseVersion 0) → draft v1");
const dConflict = cli(["doc", "save", "--slug", "notes", "--kind", "notes", "--base-version", "0"], {}, "clobber attempt");
ok(dConflict.status === 3, `doc save with a STALE base-version → exit 3, the CAS CONFLICT contract (got ${dConflict.status})`);
const conflictBody = stderrJson(dConflict.stderr);
ok(conflictBody.latestVersion === 1 && typeof conflictBody.hint === "string" && /^CONFLICT/.test(conflictBody.error ?? ""),
  "doc save CONFLICT → the machine-readable {latestVersion,latestAuthor,hint} payload as JSON on stderr");
const v2File = join(ROOT, "notes-v2.md");
writeFileSync(v2File, "hello v2");
const dSave2 = cli(["doc", "save", "--slug", "notes", "--kind", "notes", "--base-version", "1", "--file", v2File, "--summary", "v2"]);
ok(dSave2.status === 0 && j(dSave2.stdout).version === 2, "doc save --file with the CONFLICT-recovered base-version → v2");
const dGet = cli(["doc", "get", "--slug", "notes", "--version", "latest"]);
ok(dGet.status === 0 && j(dGet.stdout).version === 2 && j(dGet.stdout).body === "hello v2", `doc get --version latest → the newest draft`);
const dHist = cli(["doc", "history", "--slug", "notes"]);
ok(dHist.status === 0 && j(dHist.stdout).length === 2 && j(dHist.stdout)[0].version === 2, "doc history → the version ledger, newest first");
const dDiff = cli(["doc", "diff", "--slug", "notes", "--from", "1", "--to", "2"]);
ok(dDiff.status === 0 && j(dDiff.stdout).unified.includes("- hello") && j(dDiff.stdout).unified.includes("+ hello v2"), "doc diff → the unified line diff");
// codex #5: a selector-less doc diff/publish is a USAGE error (exit 2), never a confusing 404 domain error
const diffNoSel = cli(["doc", "diff", "--from", "1", "--to", "2"]);
ok(diffNoSel.status === 2 && /--slug S or --kind K/.test(diffNoSel.stderr), `doc diff without --slug/--kind → usage exit 2 (status ${diffNoSel.status})`);
const pubNoSel = cli(["doc", "publish", "--version", "1"]);
ok(pubNoSel.status === 2 && /--slug S or --kind K/.test(pubNoSel.stderr), `doc publish without --slug/--kind → usage exit 2 (status ${pubNoSel.status})`);
const pubDenied = cli(["doc", "publish", "--slug", "notes", "--version", "2"]); // actor pm — the operator gate refuses
ok(pubDenied.status === 1 && /FORBIDDEN/.test(pubDenied.stderr), `doc publish as pm → FORBIDDEN, domain exit 1 (got ${pubDenied.status})`);
const pubOk = cli(["doc", "publish", "--slug", "notes", "--version", "2"], { DEVLOOP_ACTOR: "operator" });
ok(pubOk.status === 0 && j(pubOk.stdout).current_version === 2 && j(pubOk.stdout).status === "current",
  "doc publish as operator → published (the single publish gate)");
const dList = cli(["doc", "list"]);
ok(dList.status === 0 && j(dList.stdout).some((d: any) => d.slug === "notes" && d.current_version === 2), "doc list → the registry row shows the published current");

// ═══ 4. mirror family (side-effect-free DRYRUN) ════════════════════════════════════════════════════════════
const mStatus = cli(["mirror", "status"]);
ok(mStatus.status === 0 && j(mStatus.stdout).mapped === 0 && j(mStatus.stdout).tickets > 0, "mirror status → coverage counts, no mapping yet");
const mPush = cli(["mirror", "push", "--team-id", "team-x", "--token-env", "DEVLOOP_LINEAR_TOKEN"], { DEVLOOP_MIRROR_DRYRUN: "1" });
ok(mPush.status === 0 && j(mPush.stdout).dryrun === true && Array.isArray(j(mPush.stdout).ops) && j(mPush.stdout).ops.length > 0,
  "mirror push (DRYRUN) → the would-push ops, no network, no mirror_map row");
// D5: `mirror poll` reaches mirror.pollComments; with no pushed docs it is a clean no-op (no Linear read,
// so no live endpoint needed) — the deep poller behavior lives in test/mirror.ts against the mock Linear.
const mPoll = cli(["mirror", "poll", "--token-env", "DEVLOOP_LINEAR_TOKEN"], { DEVLOOP_LINEAR_TOKEN: "lin_x", DEVLOOP_MIRROR_DRYRUN: "1" });
ok(mPoll.status === 0 && j(mPoll.stdout).docs === 0 && j(mPoll.stdout).filed === 0 && j(mPoll.stdout).dryrun === true,
  "mirror poll (DRYRUN, no pushed docs) → clean no-op poll result");
const mPollBad = cli(["mirror", "poll"]);
ok(mPollBad.status === 2 && /--token-env/.test(mPollBad.stderr), "mirror poll without --token-env → usage exit 2");

// ═══ 5. exit-code contract ═════════════════════════════════════════════════════════════════════════════════
const unknownFlag = cli(["ticket", "create", "--bogus", "x"]);
ok(unknownFlag.status === 2 && /unknown flag '--bogus'/.test(unknownFlag.stderr), `unknown flag → usage exit 2 (status ${unknownFlag.status})`);
for (const [verb, argv] of [["labels", ["labels", "garbage"]], ["project", ["project", "garbage"]], ["comments", ["comments", "CW-2", "garbage"]], ["label create", ["label", "create", "x", "garbage"]]] as const) {
  const stray = cli([...argv]);
  ok(stray.status === 2 && /unexpected argument 'garbage'/.test(stray.stderr), `${verb} rejects stray positionals loudly (status ${stray.status})`);
}
const dangling = cli(["comment", "add", "CW-2", "--body"]);
ok(dangling.status === 2 && /--body needs a value/.test(dangling.stderr), `dangling value flag → usage exit 2 (status ${dangling.status})`);
const domain = cli(["op", "get_issue", "--args-json", JSON.stringify({ id: "NOPE-1" })]);
ok(domain.status === 1 && /no such ticket/.test(domain.stderr), `op-level 404 → domain exit 1, the error body on stderr (status ${domain.status})`);
const phantom = cli(["ticket", "create", "--title", "x", "--type", "Bug"], { DEVLOOP_ACTOR: "ghost" });
ok(phantom.status === 4 && /not a known actor/.test(phantom.stderr), `phantom DEVLOOP_ACTOR → identity exit 4 (G1) (status ${phantom.status})`);
const unseeded = cli(["project"], { DEVLOOP_PROJECT: "ghostproj" });
ok(unseeded.status === 4 && /not seeded/.test(unseeded.stderr), `unseeded DEVLOOP_PROJECT → guard exit 4 (G2) (status ${unseeded.status})`);
// D1 --project override: a delivery actor is FORBIDDEN (server-side matrix; the CLI only passes the arg) …
const forbidden = cli(["ticket", "update", "CW-2", "--title", "renamed", "--project", "cwt2"], { DEVLOOP_ACTOR: "dev" });
ok(forbidden.status === 1 && /FORBIDDEN/.test(forbidden.stderr), `--project override as dev → FORBIDDEN, domain exit 1 (status ${forbidden.status})`);
// … while a steward crosses (any existing project key), proving the CLI enforces NOTHING client-side.
const steward = cli(["op", "get_project", "--project", "cwt2"], { DEVLOOP_ACTOR: "sweep" });
ok(steward.status === 0 && j(steward.stdout).key === "cwt2", "op get_project --project cwt2 as sweep → the D1 matrix admits stewards");

// operator-in-a-fire cooperative write guard (DEVLOOP_ACTOR stripped inside a fire env → actor 'operator')
const fireRefused = cli(["comment", "add", "CW-2", "--body", "oops"], { DEVLOOP_ACTOR: undefined, DEVLOOP_DEV_SPLIT: "true" });
ok(fireRefused.status === 4 && /refusing to write as 'operator'/.test(fireRefused.stderr),
  `a write as 'operator' with a fire marker (DEVLOOP_DEV_SPLIT) → guard exit 4 (status ${fireRefused.status})`);
const fireRefused2 = cli(["ticket", "update", "CW-2", "--priority", "3"], { DEVLOOP_ACTOR: "operator", DEVLOOP_TEAM_SCOPE: "1" });
ok(fireRefused2.status === 4, `explicit DEVLOOP_ACTOR=operator + DEVLOOP_TEAM_SCOPE → also refused (status ${fireRefused2.status})`);
const fireOverride = cli(["comment", "add", "CW-2", "--body", "really me", "--i-am-the-operator"], { DEVLOOP_ACTOR: undefined, DEVLOOP_DEV_SPLIT: "true" });
ok(fireOverride.status === 0 && j(fireOverride.stdout).author === "operator", "--i-am-the-operator → the guard yields, write attributed to operator");
const fireRead = cli(["comments", "CW-2"], { DEVLOOP_ACTOR: undefined, DEVLOOP_DEV_SPLIT: "true" });
ok(fireRead.status === 0, "reads are NEVER blocked by the fire guard (comments works as operator inside a fire env)");

// ═══ 6. PARITY — sugar ≡ op dispatcher ≡ stdio MCP (list_issues / get_issue / save_issue) ═════════════════
async function stdioCall(actor: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const c = new Client({ name: `cliaop-${actor}`, version: "0.0.0" });
  await c.connect(new StdioClientTransport({
    command: "node", args: ["src/server.ts"],
    env: { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "cwt", DEVLOOP_HUB_DB: DB },
  }));
  const r: any = await c.callTool({ name, arguments: args });
  await c.close();
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
}
// sugar ≡ op (byte-equal stdout for the same call)
const parityList1 = cli(["tickets", "--json"]).stdout.trim();
const parityList2 = cli(["op", "list_issues"]).stdout.trim();
ok(parityList1.length > 2 && parityList1 === parityList2, "PARITY: `tickets --json` ≡ `op list_issues` (byte-equal)");
const parityGet1 = cli(["ticket", "CW-2", "--json"]).stdout.trim();
const parityGet2 = cli(["op", "get_issue", "--args-json", JSON.stringify({ id: "CW-2" })]).stdout.trim();
ok(parityGet1.length > 2 && parityGet1 === parityGet2, "PARITY: `ticket <id> --json` ≡ `op get_issue` (byte-equal)");
const parityCmts1 = cli(["comments", "CW-2"]).stdout.trim();
const parityCmts2 = cli(["op", "list_comments", "--args-json", JSON.stringify({ issueId: "CW-2" })]).stdout.trim();
ok(parityCmts1.length > 2 && parityCmts1 === parityCmts2, "PARITY: `comments <id>` ≡ `op list_comments` (byte-equal)");
// filtered list parity (the flag→arg mapping matches the op schema names)
const parityFilt1 = cli(["tickets", "--json", "--type", "Bug", "--fields", "summary", "--limit", "5"]).stdout.trim();
const parityFilt2 = cli(["op", "list_issues", "--args-json", JSON.stringify({ type: "Bug", fields: "summary", limit: 5 })]).stdout.trim();
ok(parityFilt1.length > 2 && parityFilt1 === parityFilt2, "PARITY: filtered `tickets --json` ≡ `op list_issues` with the same args");
// cli ≡ stdio (the three-way extension): reads byte-equal; save_issue field-equal minus updated_at (each
// save stamps its own write time, so byte-equality is impossible for two sequential writes BY DESIGN).
const stdioList = await stdioCall("dev", "list_issues", {});
ok(!stdioList.isError && stdioList.text === parityList2, "PARITY: stdio list_issues text ≡ `op list_issues` stdout (byte-equal)");
const stdioGet = await stdioCall("dev", "get_issue", { id: "CW-2" });
ok(!stdioGet.isError && stdioGet.text === parityGet2, "PARITY: stdio get_issue text ≡ `op get_issue` stdout (byte-equal)");
const saveArgs = { id: "CW-2", title: "Parity rename", priority: 2 };
const cliSave = j(cli(["op", "save_issue", "--args-json", JSON.stringify(saveArgs)], { DEVLOOP_ACTOR: "dev" }).stdout);
const stdioSave = j((await stdioCall("dev", "save_issue", saveArgs)).text);
delete cliSave.updated_at; delete stdioSave.updated_at;
ok(JSON.stringify(cliSave) === JSON.stringify(stdioSave), "PARITY: cli save_issue ≡ stdio save_issue (same body minus the per-write updated_at)");

// codex #6: the op silently ignores an empty assignee — the JSON mode refuses it loudly instead of no-op filtering
const emptyAssignee = cli(["tickets", "--json", "--assignee", ""]);
ok(emptyAssignee.status === 2 && /not expressible in --json mode/.test(emptyAssignee.stderr),
  `tickets --json --assignee '' → usage exit 2, never a silent no-filter (status ${emptyAssignee.status})`);

// ═══ 7. daemon transport — settings_json.hub.transport="daemon" flips the CLI to the loopback op-API ═══════
// (project cwt3 opted in at seed time above)
const noDaemon = cli(["ticket", "create", "--title", "x", "--type", "Bug"], { DEVLOOP_PROJECT: "cwt3" });
ok(noDaemon.status === 5 && /daemon/.test(noDaemon.stderr), `daemon transport with NO daemon reachable → exit 5 hub-unavailable (status ${noDaemon.status})`);
// codex #4: a corrupt runfile port (out of the 0<port<65536 bound) must resolve to "no port" → the same exit 5
{
  const runDir = join(ROOT, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "daemon-cwt3.json"), JSON.stringify({ port: 70000 }));
  const corruptPort = cli(["project"], { DEVLOOP_PROJECT: "cwt3", DEVLOOP_RUN_DIR: runDir });
  ok(corruptPort.status === 5 && /daemon/.test(corruptPort.stderr), `a corrupt runfile port (70000) → exit 5 hub-unavailable, no sync throw (status ${corruptPort.status})`);
}
{
  const rdb = openDb(DB); rdb.exec("PRAGMA query_only=ON");
  const wdb = openDb(DB);
  const p3 = findProject(rdb, "cwt3")!;
  const server = createDaemon({ db: rdb, projectId: p3, projectKey: "cwt3", writeDb: wdb, actor: "operator" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = String((server.address() as { port: number }).port);
  const viaDaemon = await cliAsync(["ticket", "create", "--title", "Via daemon", "--type", "Bug", "--labels", "dev-loop,Bug,qa"],
    { DEVLOOP_PROJECT: "cwt3", DEVLOOP_ACTOR: "qa", DEVLOOP_HUB_PORT: port });
  ok(viaDaemon.status === 0 && j(viaDaemon.stdout).id === "CY-1" && j(viaDaemon.stdout).created_by === "qa",
    `daemon transport: ticket create POSTs to the loopback op-API, attributed via X-Devloop-Actor (status ${viaDaemon.status}; stderr: ${viaDaemon.stderr.trim()})`);
  const daemonDomain = await cliAsync(["op", "get_issue", "--args-json", JSON.stringify({ id: "NOPE-1" })],
    { DEVLOOP_PROJECT: "cwt3", DEVLOOP_HUB_PORT: port });
  ok(daemonDomain.status === 1 && /no such ticket/.test(daemonDomain.stderr),
    "daemon transport: an op-level 404 forwards as domain exit 1 (same contract as direct-db)");
  server.close(); rdb.close(); wdb.close();
}

console.log(fails === 0 ? "\nCLI_AGENTOPS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
