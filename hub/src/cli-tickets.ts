#!/usr/bin/env node
// `dev-loop tickets` + `dev-loop ticket <id>` — the read-only TERMINAL board-read client (DL-90).
// The Vision (docs/STRATEGY.md §Vision) names the `dev-loop` CLI as one of the interchangeable board-READ
// clients (alongside the stdio MCP shim + the localhost web UI). The web UI binds 127.0.0.1 only (§16), so a
// terminal-first / SSH'd operator had no way to see the board. This closes that gap — the `gh issue list`/
// `gh issue view` of the hub. Opens the hub SoR the SAME way server.ts/seed.ts do (openDb + DEVLOOP_HUB_DB) and
// resolves the project via the SAME DEVLOOP_PROJECT/cwd ladder (resolveIdentity, §11). STRICTLY read-only:
// `PRAGMA query_only` after open makes any write/event throw; needs NO daemon and NO DEVLOOP_ACTOR (identity is
// irrelevant to a read). Routed from cli.ts (`tickets`/`ticket` → this file with the subcommand as argv[0]).
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { resolveIdentity } from "./resolve-project.ts";
import { findProject } from "./seed.ts";

const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]); // §3 terminal states — hidden unless --all
const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low", 0: "None" }; // §5 (mirrors daemonviews)
const prioOf = (p: number): string => PRIORITY[p] ?? String(p);
// owner = the §4 routing label (mirrors daemonviews.ownerOf); the CLI keeps a local copy to stay decoupled
// from the HTML views module, matching the codebase's existing per-module toTicket copies.
const ownerOf = (labels: string[]): string => (labels.includes("pm") ? "pm" : labels.includes("qa") ? "qa" : "—");
const parseArr = (j: string): string[] => { try { const a = JSON.parse(j); return Array.isArray(a) ? a : []; } catch { return []; } };

interface ListRow { id: string; title: string; type: string; state: string; assignee: string | null; priority: number; labels: string; updated_at: string }
interface DetailRow extends ListRow { description: string; created_at: string }

// `dev-loop tickets [--all] [--state <name>] [--q <text>|<text>]` — board list, one line per ticket.
function listTickets(db: DatabaseSync, projectId: string, args: string[]): number {
  let all = false, state: string | undefined, q: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") all = true;
    else if (a === "--state" || a === "--q") {
      const v = args[++i];
      if (v === undefined) { console.error(`dev-loop: ${a} needs a value`); return 2; } // a dangling flag is a usage error, not a silent no-filter
      if (a === "--state") state = v; else q = v;
    } else if (!a.startsWith("-") && q === undefined) q = a; // positional free-text (parity with the web board's `q`)
  }
  // board order (priority ASC, updated_at DESC) — verbatim from daemonviews.boardPage so the terminal view matches the web view.
  let rows = db.prepare(
    "SELECT id,title,type,state,assignee,priority,labels,updated_at FROM tickets WHERE project_id=? ORDER BY priority ASC, updated_at DESC",
  ).all(projectId) as ListRow[];
  if (!all && !state) rows = rows.filter((r) => !TERMINAL.has(r.state)); // default (only when no explicit --state): non-terminal only — an explicit --state always wins, incl. a terminal one (DL-91)
  if (state) rows = rows.filter((r) => r.state === state);
  if (q) { const needle = q.toLowerCase(); rows = rows.filter((r) => r.id.toLowerCase().includes(needle) || (r.title ?? "").toLowerCase().includes(needle)); }
  if (rows.length === 0) { console.log("No tickets."); return 0; }
  for (const r of rows) {
    console.log([
      r.id.padEnd(7), r.state.padEnd(13), r.type.padEnd(11),
      ownerOf(parseArr(r.labels)).padEnd(2), prioOf(r.priority).padEnd(6), r.title,
    ].join(" · "));
  }
  return 0;
}

// `dev-loop ticket <id>` — one ticket's full detail + its comments (chronological).
function showTicket(db: DatabaseSync, projectId: string, args: string[]): number {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { console.error("dev-loop: usage: dev-loop ticket <id>"); return 2; }
  // §2 isolation: scope by project_id so a read can never reach another project's ticket.
  const t = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as DetailRow | undefined;
  if (!t) { console.error(`dev-loop: ticket '${id}' not found in this project.`); return 1; }
  const labels = parseArr(t.labels);
  const out = [
    `${t.id} · ${t.title}`,
    `state: ${t.state}   type: ${t.type}   owner: ${ownerOf(labels)}   priority: ${prioOf(t.priority)}   assignee: ${t.assignee ?? "—"}`,
    `labels: ${labels.join(", ") || "—"}`,
    "",
    t.description?.trim() || "(no description)",
  ];
  const comments = db.prepare("SELECT author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as { author: string; body: string; created_at: string }[];
  out.push("", comments.length ? `── Comments (${comments.length}) ──` : "── No comments ──");
  for (const c of comments) out.push("", `${c.created_at} — ${c.author}`, c.body);
  console.log(out.join("\n"));
  return 0;
}

function main(): number {
  const [sub, ...rest] = process.argv.slice(2); // sub = "tickets" | "ticket" (cli.ts passes it as argv[0])
  const { projectKey, projectFromCwd } = resolveIdentity(); // a read needs no DEVLOOP_ACTOR
  const db = openDb(process.env.DEVLOOP_HUB_DB ?? `${homedir()}/.dev-loop/hub.db`);
  db.exec("PRAGMA query_only=1"); // AC5: structurally read-only — any write/event from here on throws
  const projectId = findProject(db, projectKey);
  if (!projectId) {
    const srcDesc = projectFromCwd ? `resolved from cwd '${process.cwd()}'` : `from DEVLOOP_PROJECT='${projectKey}'`;
    console.error(`dev-loop: project '${projectKey}' (${srcDesc}) is not seeded in the hub DB. Seed it once (\`dev-loop seed ${projectKey} "<name>" <UNIQUE_PREFIX>\`), or set DEVLOOP_PROJECT / run from inside the project repo.`);
    return 1;
  }
  return sub === "ticket" ? showTicket(db, projectId, rest) : listTickets(db, projectId, rest);
}

process.exit(main());
