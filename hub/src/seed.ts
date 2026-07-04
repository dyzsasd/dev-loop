// Idempotent bootstrap: a project, the agent/operator actors, and the §4 label taxonomy.
// Run directly (`node src/seed.ts <key> <name>`) or called by the server on first run.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb, nowIso } from "./db.ts";

// The live dev-loop agents + the human operator.
// DL split (senior/junior dev): `senior-dev` + `junior-dev` join as ACTIVE actors; the legacy single
// `dev` STAYS ACTIVE (NOT retired) — it remains the canonical single-pane fallback for non-split
// projects (e.g. monpick on Linear), so adding the two-tier model breaks no existing project.
// Communication is an active outward actor for public article drafts; it writes drafts, not tickets.
// The ONE agent roster (A2): the scheduler's VALID_AGENTS derives from this, and the consistency test
// asserts skills/<agent>-agent dirs match it — so adding an agent is a single edit, not three in lock-step.
export const AGENT_HANDLES = ["pm", "qa", "dev", "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"] as const;
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
  // §21a sensitive-work routing: auth/permissions, payment/money, PII, secrets, data migration —
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
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  // --help/-h is the near-universal convention; guard it BEFORE binding argv[0] to `key`, or it
  // silently seeds a junk project literally keyed `--help` + its actors + labels (DL-88).
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: seed <key> <name> [PREFIX] [DBPATH]  — seed a project + actors + labels into the hub db");
    process.exit(0);
  }
  const [key = "demo", name = "Demo Project", prefix = "DL", dbPath = process.env.DEVLOOP_HUB_DB ?? "./hub.db"] = args;
  const db = openDb(dbPath);
  const id = ensureSeed(db, key, name, prefix);
  console.log(`seeded project ${key} (${id}) + actors + labels in ${dbPath}`);
  db.close();
}
