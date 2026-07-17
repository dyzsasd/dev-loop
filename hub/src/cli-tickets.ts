#!/usr/bin/env node
// `dev-loop tickets` + `dev-loop ticket <id>` — the read-only TERMINAL board-read client (DL-90).
// The Vision (docs/STRATEGY.md §Vision) names the `dev-loop` CLI as one of the interchangeable board-READ
// clients (alongside the stdio MCP shim + the localhost web UI). The web UI binds 127.0.0.1 only (§16), so a
// terminal-first / SSH'd operator had no way to see the board. This closes that gap — the `gh issue list`/
// `gh issue view` of the hub. Opens the hub SoR the SAME way server.ts/seed.ts do (openDb + DEVLOOP_HUB_DB) and
// resolves the project via the SAME DEVLOOP_PROJECT/cwd ladder (resolveIdentity, §11). STRICTLY read-only:
// `PRAGMA query_only` after open makes any write/event throw; needs NO daemon and NO DEVLOOP_ACTOR (identity is
// irrelevant to a read). Routed from cli.ts (`tickets`/`ticket` → this file with the subcommand as argv[0]).
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { resolveIdentity } from "./resolve-project.ts";
import { findProject } from "./seed.ts";
import { resolveHubDbPath } from "./workspace.ts";
// A1 (--json): the JSON mode dispatches the SAME list_issues/get_issue ops the MCP transports serve, so
// `tickets --json` is byte-identical to `dev-loop op list_issues` / the stdio ok() body (the parity contract).
// Reads stay reads: both ops only SELECT, so the query_only connection below still holds (AC5).
import { agentOp, type AgentOp, type OpResult } from "./agentops.ts";

const TERMINAL = new Set(["Done", "Canceled", "Duplicate"]); // §3 terminal states — hidden unless --all
const PRIORITY: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Medium", 4: "Low", 0: "None" }; // §5 (mirrors daemonviews)
const prioOf = (p: number): string => PRIORITY[p] ?? String(p);
// owner = the §4 routing label (mirrors daemonviews.ownerOf); the CLI keeps a local copy to stay decoupled
// from the HTML views module, matching the codebase's existing per-module toTicket copies.
const ownerOf = (labels: string[]): string => (labels.includes("pm") ? "pm" : labels.includes("qa") ? "qa" : "—");
const parseArr = (j: string): string[] => { try { const a = JSON.parse(j); return Array.isArray(a) ? a : []; } catch { return []; } };

interface ListRow { id: string; title: string; type: string; state: string; assignee: string | null; priority: number; labels: string; related_to: string; updated_at: string }
interface DetailRow extends ListRow { description: string; created_at: string; duplicate_of: string | null }

// A1: the read verbs' --json mode is a thin call-through to the SAME agentOp() the MCP transports dispatch —
// the printed line is JSON.stringify(body), byte-identical to `dev-loop op <op>` and to the stdio ok() text.
// list_issues/get_issue are the SYNC read ops (only channel/mirror ops are async), so the cast is safe.
function emitJson(db: DatabaseSync, projectId: string, projectKey: string, actor: string, op: AgentOp, args: Record<string, unknown>): number {
  const r = agentOp(op, db, projectId, projectKey, actor, args) as OpResult;
  if (r.status >= 200 && r.status < 300) { console.log(JSON.stringify(r.body)); return 0; }
  console.error(JSON.stringify(r.body));
  return 1;
}

// `dev-loop tickets [--all] [--state S] [--type T] [--owner O] [--label L] [--q TEXT|TEXT] [--assignee A]
//  [--related-to ID] [--updated-since ISO] [--fields summary|full] [--limit N] [--json]` — board list.
function listTickets(db: DatabaseSync, projectId: string, projectKey: string, actor: string, args: string[]): number {
  let all = false, json = false;
  let state: string | undefined, q: string | undefined, type: string | undefined, owner: string | undefined, label: string | undefined;
  let assignee: string | undefined, relatedTo: string | undefined, updatedSince: string | undefined, fields: string | undefined, limit: number | undefined;
  const VALUE_FLAGS = new Set(["--state", "--q", "--type", "--owner", "--label", "--assignee", "--related-to", "--updated-since", "--fields", "--limit"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") all = true;
    else if (a === "--json") json = true; // A1: op-shaped JSON output (see below)
    else if (VALUE_FLAGS.has(a)) {
      const v = args[++i];
      if (v === undefined) { console.error(`dev-loop: ${a} needs a value`); return 2; } // a dangling flag is a usage error, not a silent no-filter (DL-91)
      if (a === "--state") state = v; else if (a === "--q") q = v; else if (a === "--type") type = v; else if (a === "--owner") owner = v; else if (a === "--label") label = v;
      else if (a === "--assignee") assignee = v; else if (a === "--related-to") relatedTo = v; else if (a === "--updated-since") updatedSince = v;
      else if (a === "--fields") {
        if (v !== "summary" && v !== "full") { console.error(`dev-loop: --fields must be 'summary' or 'full'`); return 2; }
        fields = v;
      } else { // --limit
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) { console.error(`dev-loop: --limit must be a positive integer`); return 2; }
        limit = n;
      }
    } else if (a.startsWith("-")) { console.error(`dev-loop: unknown flag '${a}'`); return 2; } // DL-93: reject unknown flags — never swallow the following arg as positional --q (the `--type Bug` footgun)
    else if (q === undefined) q = a; // positional free-text (parity with the web board's `q`)
  }
  // ── A1 --json: the op-shaped list — EXACTLY `op list_issues` (updated_at DESC, terminal states included,
  // the op's default cap) so the output byte-equals the op dispatcher / stdio for the same filters. --all is
  // meaningless here (nothing is hidden) and --owner is a render-side concept — both are human-view flags.
  if (json) {
    if (all || owner) { console.error("dev-loop: --all/--owner are human-view flags — not available with --json (the op output already includes terminal states; filter the JSON yourself)"); return 2; }
    // the op SILENTLY ignores an empty assignee (its truthy gate) — a no-op filter is a footgun, so refuse
    // it loudly here; the human view keeps '' = unassigned (a local render capability the op lacks).
    if (assignee !== undefined && assignee.trim() === "") { console.error("dev-loop: --assignee '' (unassigned) is not expressible in --json mode — the list_issues op ignores an empty assignee; use the human view"); return 2; }
    const a: Record<string, unknown> = {};
    if (state) a.state = state; if (type) a.type = type; if (label) a.label = label; if (q) a.query = q;
    if (assignee !== undefined) a.assignee = assignee; if (relatedTo) a.relatedTo = relatedTo;
    if (updatedSince) a.updatedSince = updatedSince; if (fields) a.fields = fields; if (limit !== undefined) a.limit = limit;
    return emitJson(db, projectId, projectKey, actor, "list_issues", a);
  }
  // board order (priority ASC, updated_at DESC) — verbatim from daemonviews.boardPage so the terminal view matches the web view.
  let rows = db.prepare(
    "SELECT id,title,type,state,assignee,priority,labels,related_to,updated_at FROM tickets WHERE project_id=? ORDER BY priority ASC, updated_at DESC",
  ).all(projectId) as unknown as ListRow[];
  if (!all && !state) rows = rows.filter((r) => !TERMINAL.has(r.state)); // default (only when no explicit --state): non-terminal only — an explicit --state always wins, incl. a terminal one (DL-91)
  if (state) rows = rows.filter((r) => r.state === state);
  if (type) rows = rows.filter((r) => r.type === type);                        // DL-93: exact type match (r.type already selected at the query); composes (AND) with the others & is orthogonal to the non-terminal default
  if (owner) rows = rows.filter((r) => ownerOf(parseArr(r.labels)) === owner);  // DL-93: owner via the §4 routing-label helper (same helper the render uses below)
  if (label) rows = rows.filter((r) => parseArr(r.labels).includes(label));     // DL-93: arbitrary label membership (e.g. --label blocked / edge-case / tech-debt)
  if (q) { const needle = q.toLowerCase(); rows = rows.filter((r) => r.id.toLowerCase().includes(needle) || (r.title ?? "").toLowerCase().includes(needle)); }
  // A1 filters (human mode mirrors the op semantics): assignee "me" → the resolved actor, "" → unassigned.
  if (assignee !== undefined) {
    const who = assignee === "me" ? actor : assignee.trim() === "" ? null : assignee;
    rows = rows.filter((r) => r.assignee === who);
  }
  if (relatedTo) rows = rows.filter((r) => parseArr(r.related_to).includes(relatedTo));
  if (updatedSince) rows = rows.filter((r) => r.updated_at >= updatedSince);
  if (limit !== undefined) rows = rows.slice(0, limit);
  // --fields is a payload-size knob for the JSON mode; the human list already renders summary lines (no-op here).
  if (rows.length === 0) { console.log("No tickets."); return 0; }
  for (const r of rows) {
    console.log([
      r.id.padEnd(7), r.state.padEnd(13), r.type.padEnd(11),
      ownerOf(parseArr(r.labels)).padEnd(2), prioOf(r.priority).padEnd(6), r.title,
    ].join(" · "));
  }
  return 0;
}

// `dev-loop ticket <id> [--json]` — one ticket's full detail + its comments (chronological).
function showTicket(db: DatabaseSync, projectId: string, projectKey: string, actor: string, args: string[]): number {
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a.startsWith("-")) { console.error(`dev-loop: unknown flag '${a}'`); return 2; } // DL-93 discipline, same as the list verb
  }
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { console.error("dev-loop: usage: dev-loop ticket <id> [--json]"); return 2; }
  // A1 --json: EXACTLY `op get_issue` (the ticket + comments + referencedBy) — byte-parity with the op layer.
  if (json) return emitJson(db, projectId, projectKey, actor, "get_issue", { id });
  // §2 isolation: scope by project_id so a read can never reach another project's ticket.
  const t = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as DetailRow | undefined;
  if (!t) { console.error(`dev-loop: ticket '${id}' not found in this project.`); return 1; }
  const labels = parseArr(t.labels);
  const related = parseArr(t.related_to);                                  // DL-92: SELECT * already carries related_to (JSON array) + duplicate_of (scalar) — no new query
  const out = [
    `${t.id} · ${t.title}`,
    `state: ${t.state}   type: ${t.type}   owner: ${ownerOf(labels)}   priority: ${prioOf(t.priority)}   assignee: ${t.assignee ?? "—"}`,
    `labels: ${labels.join(", ") || "—"}`,
  ];
  if (related.length) out.push(`related: ${related.join(", ")}`);          // DL-92: ids render plainly so the operator can `dev-loop ticket <id>` to follow the chain (web detail / DL-8 parity)
  if (t.duplicate_of) out.push(`duplicate of: ${t.duplicate_of}`);         // DL-92: shown only when set — a relation-less ticket omits these lines (no awkward empty label)
  out.push("", t.description?.trim() || "(no description)");
  const comments = db.prepare("SELECT author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id) as { author: string; body: string; created_at: string }[];
  out.push("", comments.length ? `── Comments (${comments.length}) ──` : "── No comments ──");
  for (const c of comments) out.push("", `${c.created_at} — ${c.author}`, c.body);
  console.log(out.join("\n"));
  return 0;
}

// ── ATTACH (§6.0): the read verbs over the remote op-API. `--json` stays EXACTLY the op body (the A1
// parity contract); the human view renders a compact table from the same body — the console's daily
// read, not a byte-clone of the local renderer.
async function attachMain(base: URL, sub: string, rest: string[]): Promise<number> {
  const { postOpUrl } = await import("./op-client.ts");
  const actor = process.env.DEVLOOP_ACTOR ?? "operator";
  const project = process.env.DEVLOOP_PROJECT?.trim();
  const asJson = rest.includes("--json");
  const op = sub === "ticket" ? "get_issue" : "list_issues";
  const args: Record<string, unknown> = {};
  if (project) args.project = project;
  if (sub === "ticket") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) { console.error("usage: dev-loop ticket <id> [--json]"); return 2; }
    args.id = id;
  } else {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]; const next = () => rest[++i];
      if (a === "--state") args.state = next();
      else if (a === "--type") args.type = next();
      else if (a === "--label") args.label = next();
      else if (a === "--assignee") args.assignee = next();
      else if (a === "--q") args.q = next();
      else if (a === "--limit") args.limit = Number(next());
      else if (a !== "--json") { console.error(`dev-loop tickets (attach): unsupported flag '${a}' — the attach read surface is the op surface (list_issues args)`); return 2; }
    }
  }
  const out = await postOpUrl(base, op, args, actor);
  if (out.kind === "down") { console.error(`dev-loop: remote hub ${base.origin} is not reachable${out.detail}`); return 5; }
  if (out.kind === "dormant") { console.error(`dev-loop: ${base.origin} op-API is dormant — seed settings_json.hub.transport:"daemon" at the home`); return 5; }
  if (out.status === 401) { console.error(`dev-loop: ${base.origin} requires the bearer token — set DEVLOOP_UI_TOKEN (§6.2)`); return 5; }
  if (out.status < 200 || out.status >= 300) { console.error(JSON.stringify(out.body)); return 1; }
  if (asJson) { console.log(JSON.stringify(out.body)); return 0; }
  if (sub === "ticket") {
    const t = out.body as { id?: string; state?: string; type?: string; title?: string; assignee?: string | null; comments?: Array<{ author: string; body: string }> };
    console.log(`${t.id}  [${t.state}] ${t.type}  ${t.title}${t.assignee ? `  @${t.assignee}` : ""}`);
    for (const c of t.comments ?? []) console.log(`  — ${c.author}: ${c.body.split("\n")[0].slice(0, 120)}`);
  } else {
    for (const t of (out.body as Array<{ id: string; state: string; type: string; title: string; assignee?: string | null }>))
      console.log(`${t.id.padEnd(10)} ${(`[${t.state}]`).padEnd(14)} ${t.type.padEnd(12)} ${t.title.slice(0, 80)}${t.assignee ? `  @${t.assignee}` : ""}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const [sub, ...rest] = process.argv.slice(2); // sub = "tickets" | "ticket" (cli.ts passes it as argv[0])
  const hubUrl = process.env.DEVLOOP_HUB_URL?.trim();
  if (hubUrl) {
    let base: URL;
    try { base = new URL(hubUrl); } catch { console.error(`dev-loop: DEVLOOP_HUB_URL '${hubUrl}' is not a valid URL`); return 2; }
    return attachMain(base, sub, rest);
  }
  // a read needs no DEVLOOP_ACTOR to run; the resolved actor only parameterizes assignee:"me" + attribution-free reads
  const { actor, projectKey, projectFromCwd, projectResolved } = resolveIdentity();
  if (!projectResolved) {
    console.error("dev-loop: no project resolved. Set DEVLOOP_PROJECT=<key>, or run from inside a repo configured in ~/.dev-loop/projects.json.");
    return 1;
  }
  const db = openDb(resolveHubDbPath()); // workspace-aware ladder (P2 #1) — same resolver as op/seed/doctor
  db.exec("PRAGMA query_only=1"); // AC5: structurally read-only — any write/event from here on throws
  const projectId = findProject(db, projectKey);
  if (!projectId) {
    const srcDesc = projectFromCwd ? `resolved from cwd '${process.cwd()}'` : `from DEVLOOP_PROJECT='${projectKey}'`;
    console.error(`dev-loop: project '${projectKey}' (${srcDesc}) is not seeded in the hub DB. Seed it once (\`dev-loop seed ${projectKey} "<name>" <UNIQUE_PREFIX>\`), or set DEVLOOP_PROJECT / run from inside the project repo.`);
    return 1;
  }
  return sub === "ticket" ? showTicket(db, projectId, projectKey, actor, rest) : listTickets(db, projectId, projectKey, actor, rest);
}

process.exit(await main());
