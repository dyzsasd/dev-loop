// DL-90 — the read-only `dev-loop tickets` + `dev-loop ticket <id>` board-read CLI (hub/src/cli-tickets.ts).
// Drives the REAL `node src/cli-tickets.ts` against an ISOLATED temp hub DB (never ~/.dev-loop): asserts the
// list columns + board ordering (priority ASC, updated_at DESC) + the --all/--state/--q narrowing, the single-
// ticket detail + comments, the unknown-id / unseeded-project non-zero exits, and that a read writes NOTHING
// (no tickets mutated, no events emitted — AC5).
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";

const ROOT = "/tmp/hub-cli-tickets-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const DB = join(ROOT, "hub.db");

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// ── seed a project + a deterministic ticket set straight into the temp DB (direct SQL = full control over
//    state/priority/updated_at so the ordering assertions are exact; no event rows are written). ──
const db = openDb(DB);
const projectId = ensureSeed(db, "clitest", "CLI Test", "CT");
const insT = db.prepare(
  "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]',?,?,?)",
);
const t = (id: string, title: string, desc: string, type: string, state: string, assignee: string | null, prio: number, labels: string[], updated: string) =>
  insT.run(id, projectId, title, desc, type, state, assignee, prio, JSON.stringify(labels), "pm", "2026-01-01T00:00:00Z", updated);
// priority ASC, then updated_at DESC ⇒ default (non-terminal) order is [CT-2, CT-1, CT-3, CT-4]; CT-5 is Done (hidden).
t("CT-1", "Fix urgent login bug", "## Summary\nLogin throws 500 on submit.\n", "Bug", "Todo", "dev", 1, ["dev-loop", "Bug", "qa", "edge-case"], "2026-01-01T00:00:03Z"); // DL-93: carries `edge-case` so --label edge-case has a clean target
t("CT-2", "Add urgent export feature", "Export the board.", "Feature", "Todo", null, 1, ["dev-loop", "Feature", "pm"], "2026-01-01T00:00:05Z");
t("CT-3", "Medium polish improvement", "Tidy the header.", "Improvement", "In Progress", "dev", 3, ["dev-loop", "Improvement", "pm"], "2026-01-01T00:00:01Z");
t("CT-4", "Low priority nit", "Rename a field.", "Improvement", "In Review", null, 4, ["dev-loop", "Improvement", "qa"], "2026-01-01T00:00:02Z");
t("CT-5", "A finished thing", "Already done.", "Feature", "Done", null, 1, ["dev-loop", "Feature", "pm"], "2026-01-01T00:00:09Z");
// DL-92: a ticket carrying relations (related_to JSON array + duplicate_of scalar) — the t() helper hardcodes
// related_to='[]' and no duplicate_of, so insert CT-6 directly. Duplicate state keeps it out of the non-terminal lists.
db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,duplicate_of,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("CT-6", projectId, "A ticket with relations", "Has links.", "Bug", "Duplicate", null, 3, JSON.stringify(["dev-loop", "Bug", "qa"]), JSON.stringify(["CT-1", "CT-3"]), "CT-2", "qa", "2026-01-01T00:00:00Z", "2026-01-01T00:00:06Z");
db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES (?,?,?,?,?)")
  .run("c1", "CT-1", "qa", "Confirmed the 500 in the test env.", "2026-01-01T01:00:00Z");
db.close();

// run the REAL CLI with the isolated DB + an explicit project; returns {status, out} (out = stdout+stderr merged).
function cli(args: string[], project = "clitest"): { status: number | null; out: string } {
  const r = spawnSync("node", ["src/cli-tickets.ts", ...args], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: project },
  });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
// id-leading line lookups, collision-proof: an id is always followed by a space (padEnd column or " · "),
// so `id + " "` distinguishes CT-1 from CT-10 (raw indexOf/startsWith(id) would not).
const lineOf = (out: string, id: string) => out.split("\n").find((l) => l.startsWith(id + " ")) ?? "";
const rowIdx = (out: string, id: string) => out.split("\n").findIndex((l) => l.startsWith(id + " "));
const before = (out: string, a: string, b: string) => { const ia = rowIdx(out, a), ib = rowIdx(out, b); return ia >= 0 && ib >= 0 && ia < ib; };

// ── 1. `tickets` — non-terminal by default, board ordering, columns ──
const list = cli(["tickets"]);
ok(list.status === 0, `tickets → exit 0 (got ${list.status})`);
ok(["CT-1", "CT-2", "CT-3", "CT-4"].every((id) => list.out.includes(id)) && !list.out.includes("CT-5"),
  "tickets → lists the 4 non-terminal tickets, hides the Done CT-5");
ok(before(list.out, "CT-2", "CT-1") && before(list.out, "CT-1", "CT-3") && before(list.out, "CT-3", "CT-4"),
  "tickets → board order: priority ASC then updated_at DESC ([CT-2, CT-1, CT-3, CT-4])");
const l2 = lineOf(list.out, "CT-2");
ok(["CT-2", "Todo", "Feature", "pm", "Urgent", "Add urgent export feature"].every((c) => l2.includes(c)),
  "tickets → each line carries id · state · type · owner · priority · title");
ok(lineOf(list.out, "CT-1").includes("qa"), "tickets → owner column reflects the qa routing label");

// ── 2. `--all` includes terminal; ordering still holds (CT-5 leads its priority-1 group by newest updated_at) ──
const all = cli(["tickets", "--all"]);
ok(all.out.includes("CT-5") && before(all.out, "CT-5", "CT-2") && before(all.out, "CT-2", "CT-1"),
  "tickets --all → includes Done CT-5, ordered newest-first within the priority-1 group");

// ── 3. `--state` filter ──
const todo = cli(["tickets", "--state", "Todo"]);
ok(todo.out.includes("CT-1") && todo.out.includes("CT-2") && !todo.out.includes("CT-3") && !todo.out.includes("CT-4"),
  "tickets --state Todo → only the two Todo tickets");
// DL-91 regression: an explicit TERMINAL --state must list its tickets WITHOUT --all — the non-terminal default
// filter must not pre-strip them (the state-agnostic `!all && !state` gate, identical branch for Canceled/Duplicate).
const doneOnly = cli(["tickets", "--state", "Done"]);
ok(doneOnly.out.includes("CT-5") && !doneOnly.out.includes("CT-1") && !doneOnly.out.includes("CT-3"),
  "tickets --state Done → lists the Done CT-5 alone, no --all needed (DL-91: explicit --state overrides the non-terminal default)");

// ── 4. free-text `--q` (title) and positional (id) ──
const ql = cli(["tickets", "--q", "login"]);
ok(ql.out.includes("CT-1") && !ql.out.includes("CT-2"), "tickets --q login → matches the title, case-insensitive");
const qpos = cli(["tickets", "CT-3"]);
ok(qpos.out.includes("CT-3") && !qpos.out.includes("CT-1"), "tickets <positional> → matches the id");
const dangling = cli(["tickets", "--state"]);
ok(dangling.status === 2 && /needs a value/i.test(dangling.out), `tickets --state (no value) → usage error exit 2, not a silent unfiltered list (status ${dangling.status})`);

// ── 4b. DL-93: --type / --owner / --label filters, AND-composition, and flag validation (dangling + unknown) ──
const byType = cli(["tickets", "--type", "Improvement"]);
ok(byType.out.includes("CT-3") && byType.out.includes("CT-4") && !byType.out.includes("CT-1") && !byType.out.includes("CT-2"),
  "tickets --type Improvement → only the (non-terminal) Improvements CT-3, CT-4");
ok(!byType.out.includes("CT-5"), "tickets --type Improvement → orthogonal to state: the non-terminal default still hides the Done CT-5 (a Feature) — and would hide a Done Improvement too");
const byOwner = cli(["tickets", "--owner", "qa"]);
ok(byOwner.out.includes("CT-1") && byOwner.out.includes("CT-4") && !byOwner.out.includes("CT-2") && !byOwner.out.includes("CT-3") && !byOwner.out.includes("CT-6"),
  "tickets --owner qa → only the non-terminal qa-owned (CT-1, CT-4); not pm-owned CT-2/CT-3, not the terminal qa Duplicate CT-6");
const byLabel = cli(["tickets", "--label", "edge-case"]);
ok(byLabel.out.includes("CT-1") && !byLabel.out.includes("CT-2") && !byLabel.out.includes("CT-3") && !byLabel.out.includes("CT-4"),
  "tickets --label edge-case → only the ticket carrying that arbitrary label (CT-1), not by type/owner");
// AND-composition: type+owner intersect (CT-6 is also Bug/qa but Duplicate → hidden by the non-terminal default)
const compose = cli(["tickets", "--type", "Bug", "--owner", "qa"]);
ok(compose.out.includes("CT-1") && !compose.out.includes("CT-6") && !compose.out.includes("CT-2"),
  "tickets --type Bug --owner qa → AND-composed to the non-terminal Bug owned by qa (CT-1), not the Duplicate CT-6 nor pm's CT-2");
// composition with an explicit terminal --state lets that slice through (DL-91): Bug + Duplicate = CT-6 only
const composeTerminal = cli(["tickets", "--type", "Bug", "--state", "Duplicate"]);
ok(composeTerminal.out.includes("CT-6") && !composeTerminal.out.includes("CT-1"),
  "tickets --type Bug --state Duplicate → composes with an explicit terminal --state (CT-6 only, not the Todo CT-1)");
// each new flag obeys the DL-91 dangling-value rule (exit 2), like --state/--q
for (const f of ["--type", "--owner", "--label"]) {
  const d = cli(["tickets", f]);
  ok(d.status === 2 && /needs a value/i.test(d.out), `tickets ${f} (no value) → usage error exit 2 (status ${d.status})`);
}
// the footgun fix (DL-93): an UNKNOWN flag is rejected (exit 2) and never swallows its following arg as positional --q
const unknown = cli(["tickets", "--bogus", "CT-2"]);
ok(unknown.status === 2 && /unknown flag/i.test(unknown.out),
  `tickets --bogus CT-2 → unknown flag rejected (exit 2), its value NOT swallowed as free-text --q (status ${unknown.status})`);

// ── 5. `ticket <id>` detail + comment ──
const det = cli(["ticket", "CT-1"]);
ok(det.status === 0, `ticket CT-1 → exit 0 (got ${det.status})`);
ok(["CT-1", "Fix urgent login bug", "Todo", "Bug", "qa", "Urgent", "dev", "dev-loop", "Login throws 500"].every((s) => det.out.includes(s)),
  "ticket CT-1 → renders title/state/type/owner/priority/assignee/labels + description body");
ok(det.out.includes("Confirmed the 500") && det.out.includes("Comments (1)"), "ticket CT-1 → renders its comment (chronological)");
// ── 5b. DL-92: detail shows relations (relatedTo + duplicateOf); a relation-less ticket omits them ──
const rel = cli(["ticket", "CT-6"]);
ok(rel.status === 0 && /related: CT-1, CT-3/.test(rel.out) && /duplicate of: CT-2/.test(rel.out),
  "ticket CT-6 → renders 'related: CT-1, CT-3' + 'duplicate of: CT-2' (DL-92: follow-the-chain parity with the web detail / DL-8)");
ok(!/related:/.test(det.out) && !/duplicate of:/.test(det.out),
  "ticket CT-1 (no relations) → omits the related/duplicate lines entirely (neutral form, never an empty label)");

// ── 6. unknown id → non-zero exit + a clear message ──
const miss = cli(["ticket", "CT-999"]);
ok(miss.status !== 0 && /not found/i.test(miss.out), `ticket CT-999 → non-zero exit + 'not found' (status ${miss.status})`);

// ── 7. an unseeded/unresolved project → non-zero exit + actionable message ──
const ghost = cli(["tickets"], "ghost-not-seeded");
ok(ghost.status !== 0 && /not seeded/i.test(ghost.out), `tickets (unseeded project) → non-zero exit + actionable error (status ${ghost.status})`);

// ── 8. STRICTLY read-only — after all the reads above, nothing was mutated and no events were emitted (AC5) ──
const after = openDb(DB);
const tcount = (after.prepare("SELECT count(*) AS c FROM tickets WHERE project_id=?").get(projectId) as { c: number }).c;
const ecount = (after.prepare("SELECT count(*) AS c FROM events WHERE project_id=?").get(projectId) as { c: number }).c;
after.close();
ok(tcount === 6 && ecount === 0, `read-only: tickets unchanged (6) + zero events emitted (got ${tcount} tickets, ${ecount} events)`);

console.log(fails === 0 ? "\nCLI_TICKETS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
