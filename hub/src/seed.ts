// Idempotent bootstrap: a project, the agent/operator actors, and the §4 label taxonomy.
// Run directly (`node src/seed.ts <key> <name>`) or called by the server on first run.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb, nowIso } from "./db.ts";

// The current dev-loop agents + the human operator. `director` is added when that ships.
const AGENT_HANDLES = ["pm", "qa", "dev", "sweep", "reflect", "ops", "architect", "signal"];

// §4 label taxonomy (+ the `notified` workflow label from §9 notify).
const LABELS: Array<{ name: string; kind: string }> = [
  { name: "dev-loop", kind: "marker" },
  { name: "Feature", kind: "type" }, { name: "Bug", kind: "type" }, { name: "Improvement", kind: "type" },
  { name: "pm", kind: "owner" }, { name: "qa", kind: "owner" },
  { name: "edge-case", kind: "subtype" }, { name: "incident", kind: "subtype" },
  { name: "tech-debt", kind: "subtype" }, { name: "signal", kind: "subtype" }, { name: "coverage", kind: "subtype" },
  { name: "blocked", kind: "workflow" }, { name: "needs-pm", kind: "workflow" },
  { name: "needs-qa", kind: "workflow" }, { name: "notified", kind: "workflow" },
];

export function ensureActors(db: DatabaseSync): void {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO actors(id,handle,kind,display_name,active,created_at) VALUES (?,?,?,?,1,?)",
  );
  for (const h of AGENT_HANDLES) ins.run(randomUUID(), h, "agent", h.toUpperCase(), nowIso());
  ins.run(randomUUID(), "operator", "human", "Operator", nowIso());
}

export function ensureProject(db: DatabaseSync, key: string, name: string, prefix = "DL"): string {
  const existing = db.prepare("SELECT id FROM projects WHERE key=?").get(key) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO projects(id,key,name,ticket_prefix,ticket_seq,created_at) VALUES (?,?,?,?,0,?)",
  ).run(id, key, name, prefix, nowIso());
  const insL = db.prepare("INSERT OR IGNORE INTO labels(id,project_id,name,kind) VALUES (?,?,?,?)");
  for (const l of LABELS) insL.run(randomUUID(), id, l.name, l.kind);
  return id;
}

export function ensureSeed(db: DatabaseSync, key: string, name: string, prefix = "DL"): string {
  ensureActors(db);
  return ensureProject(db, key, name, prefix);
}

// CLI: node src/seed.ts <key> <name> [prefix] [dbpath]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [key = "demo", name = "Demo Project", prefix = "DL", dbPath = process.env.DEVLOOP_HUB_DB ?? "./hub.db"] =
    process.argv.slice(2);
  const db = openDb(dbPath);
  const id = ensureSeed(db, key, name, prefix);
  console.log(`seeded project ${key} (${id}) + actors + labels in ${dbPath}`);
  db.close();
}
