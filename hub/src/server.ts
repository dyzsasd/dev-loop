#!/usr/bin/env node
// dev-loop hub — stdio MCP server. The loop's system of record for ONE project.
// Identity rides DEVLOOP_ACTOR (launcher-set per pane); project rides DEVLOOP_PROJECT; db DEVLOOP_HUB_DB.
// Tools mirror the Linear MCP op-shapes 1:1 so the agent SKILLs port unchanged (conventions §18).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { openDb, actorExists, listActorHandles } from "./db.ts";
import { ensureActors, ensureProject, findProject } from "./seed.ts";
import { createLabel } from "./labelstore.ts"; // DL-69: create_issue_label stays a native handler (see agentops.ts opCreateLabel — the only op server.ts does NOT dispatch through, to keep the stdio path byte-identical)
import { resolveProjectFromCwd, loadProjectsConfig, resolveIdentity } from "./resolve-project.ts";
import { agentOp, type OpResult, type AgentOp } from "./agentops.ts"; // DL-69: the SINGLE definition of every ticket/read policy — every op-backed handler below dispatches through agentOp()
import { ok, err, registerTools } from "./tooldefs.ts"; // DL-85: the ONE {name,description,inputSchema} registry + the shared ok()/err()

// ─── Environment / identity ──────────────────────────────────────────────────
const DB_PATH = process.env.DEVLOOP_HUB_DB ?? `${homedir()}/.dev-loop/hub.db`;
// DL-85: the DEVLOOP_ACTOR + DEVLOOP_PROJECT/cwd resolution lives ONCE in resolve-project.ts (was re-derived
// here AND in shim.ts). An EXPLICIT DEVLOOP_PROJECT wins; else cwd-resolve (DL-13: an agent launched inside a
// project folder auto-pins it); else the "demo" default. projectFromCwd drives the clearer not-seeded error below.
const { actor: ACTOR, projectKey: PROJECT_KEY, projectFromCwd } = resolveIdentity();

// `dev-loop-hub resolve-project [--cwd <path>]` (DL-13) — print the project KEY whose repo CONTAINS the
// cwd (default: process.cwd()), or exit non-zero with no output. The launcher reuses THIS matcher so the
// launcher, the hub fallback, and any prose agree on exactly ONE rule.
if (process.argv[2] === "resolve-project") {
  const cwd = process.argv[3] === "--cwd" && process.argv[4] ? process.argv[4] : process.cwd();
  const cfg = loadProjectsConfig();
  const key = cfg ? resolveProjectFromCwd(cwd, cfg) : null;
  if (key) { console.log(key); process.exit(0); }
  process.exit(1); // no match → empty stdout, non-zero → the launcher leaves DEVLOOP_PROJECT unset
}

// `dev-loop-hub doctor` — read-only health check (no server, no auto-create).
if (process.argv[2] === "doctor") {
  const { runDoctor } = await import("./doctor.ts");
  process.exit((await runDoctor(DB_PATH, { reconcile: true })) ? 0 : 1);
}

// `dev-loop-hub identity-check [--expect <actor>[/<project>]]` — P8 portability helper: print what THIS
// process's env resolves to (the per-agent identity the hub would attribute writes to) + whether the
// server would start. NOTE: this reflects the CURRENT process env; the REAL per-CLI gate is calling
// `whoami` THROUGH the CLI's MCP spawn (docs/PORTABILITY.md) — only that proves the CLI propagates env
// to the spawned subprocess. With `--expect` (or DEVLOOP_EXPECT_ACTOR / DEVLOOP_EXPECT_PROJECT) it ALSO
// catches MIS-attribution: a wrong-but-valid actor (Codex review) fails, not just an unknown one. Exit 1
// if the actor would be REFUSED (db present + unknown actor → the G1 guard) OR mismatches the expectation.
if (process.argv[2] === "identity-check") {
  const { existsSync } = await import("node:fs");
  const expFlag = process.argv[3] === "--expect" ? process.argv[4] : undefined;
  const expectActor = (expFlag?.split("/")[0]) || process.env.DEVLOOP_EXPECT_ACTOR || undefined;
  const expectProject = (expFlag?.split("/")[1]) || process.env.DEVLOOP_EXPECT_PROJECT || undefined;
  const dbPresent = existsSync(DB_PATH);
  let actorKnown: boolean | null = null;
  if (dbPresent) {
    try { const d = openDb(DB_PATH); actorKnown = actorExists(d, ACTOR); d.close(); } catch { actorKnown = null; }
  }
  const matchesExpectation = (!expectActor || expectActor === ACTOR) && (!expectProject || expectProject === PROJECT_KEY);
  const wouldStart = !dbPresent || actorKnown === true; // db absent ⇒ would be seeded; else the actor must be known
  const pass = wouldStart && matchesExpectation;
  console.log(JSON.stringify({ actor: ACTOR, project: PROJECT_KEY, db: DB_PATH, dbPresent, actorKnown, wouldStart, expectActor: expectActor ?? null, expectProject: expectProject ?? null, matchesExpectation, pass }));
  process.exit(pass ? 0 : 1);
}

// `dev-loop-hub daemon <up|down|status>` — DL-41 per-project daemon lifecycle (the named command the
// DL-42 auto-start hook invokes). Delegated to daemon-lifecycle.ts (DL-74 extracted it from daemon.ts);
// importing it is side-effect-free here (that module is pure declarations — no top-level boot), so the
// MCP boot path below is 100% untouched — the bare `dev-loop-hub` (argv[2] undefined) skips this block.
if (process.argv[2] === "daemon") {
  const { daemonLifecycle, LIFECYCLE_SUBS } = await import("./daemon-lifecycle.ts");
  const sub = process.argv[3] ?? "";
  if (!(LIFECYCLE_SUBS as readonly string[]).includes(sub)) {
    console.error(`[hub] usage: dev-loop-hub daemon <${LIFECYCLE_SUBS.join("|")}> (got '${sub || "—"}')`);
    process.exit(2);
  }
  await daemonLifecycle(sub as (typeof LIFECYCLE_SUBS)[number]); // resolves project from env/cwd; calls process.exit
}

const db = openDb(DB_PATH);
ensureActors(db); // the configured agents + operator are always present (needed for attribution + the guard below)

// P3/G1 — phantom-actor guard: a typo'd DEVLOOP_ACTOR would silently write an unattributable
// author into created_by / events.actor / comments.author. Refuse to start instead (exit non-zero
// ⇒ the MCP client can't connect ⇒ the failure is visible to the launching pane).
if (!actorExists(db, ACTOR)) {
  console.error(`[hub] DEVLOOP_ACTOR='${ACTOR}' is not a known actor. Valid: ${listActorHandles(db).join(", ")}. Fix DEVLOOP_ACTOR in the launcher.`);
  process.exit(1);
}

// P3/G2 — phantom-project guard: a typo'd DEVLOOP_PROJECT must NOT silently auto-create an empty
// board the agent then works in by mistake. The project must already exist; create it deliberately
// once (`node src/seed.ts <key> <name> <UNIQUE_PREFIX>`) or opt in with DEVLOOP_CREATE_PROJECT=1.
const projectId =
  process.env.DEVLOOP_CREATE_PROJECT === "1"
    ? ensureProject(db, PROJECT_KEY, process.env.DEVLOOP_PROJECT_NAME ?? PROJECT_KEY, process.env.DEVLOOP_TICKET_PREFIX ?? "DL")
    : findProject(db, PROJECT_KEY);
if (!projectId) {
  // DL-13: a cwd-RESOLVED project that isn't seeded errors LOUDLY here (clear source) — it must not have
  // silently fallen through to `demo` (it didn't: a cwd match returns the real key, which lands here).
  const src = projectFromCwd ? `resolved from cwd '${process.cwd()}'` : `from DEVLOOP_PROJECT='${PROJECT_KEY}'`;
  console.error(`[hub] project '${PROJECT_KEY}' (${src}) is not seeded in the hub DB. Create it once: \`node ${import.meta.dirname}/seed.ts ${PROJECT_KEY} "<name>" <UNIQUE_PREFIX>\` (or set DEVLOOP_CREATE_PROJECT=1). Refusing to auto-create a phantom board.`);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// ok()/err() (the MCP result shape) are imported from tooldefs.ts (DL-85) — one definition, shared with shim.ts.

// ─── DL-69 dispatch-sharing: every op-backed handler is a thin call-through to the shared agentOp() ──────
// Each ticket/read policy lives ONCE in agentops.ts; dispatch() forwards the zod-validated args to agentOp()
// and maps the returned { status, body } to the MCP ok()/err() shape via toMcp() — the SAME mapping the DL-55
// stdio shim applies to the op-API HTTP response (200 → ok(body); non-200 → err(body.error)), so a dispatched
// handler is BYTE-IDENTICAL to the pre-refactor native one (the differential-parity suite, shim ≡ stdio for all
// 29 tools, is the structural guard). agentOp reads NO env/mode/transport (the agentops.ts contract): server.ts
// owns the DEVLOOP_ACTOR identity + the G1 guard (above) and passes ACTOR in; the daemon op-API owns its own
// pipeline around the SAME ops. whoami + create_issue_label stay native below (see the makeHandler overrides).
const toMcp = (r: OpResult) => (r.status === 200 ? ok(r.body) : err((r.body as { error: string }).error));
const dispatch = async (op: AgentOp, a: unknown) =>
  toMcp(await agentOp(op, db, projectId, PROJECT_KEY, ACTOR, (a ?? {}) as Record<string, unknown>));

const server = new McpServer({ name: "dev-loop-hub", version: "0.1.0" });

// ─── register the 29 tools from the ONE shared registry (DL-85) ────────────────────────────────────────────
// tooldefs.ts owns every tool's { name, description, inputSchema }; this server supplies only the per-name
// handler. The DEFAULT handler dispatches the op through agentOp() (above). Two tools are NATIVE (not ops):
//   • whoami — answered locally from THIS process's resolved identity ({actor, project, db}).
//   • create_issue_label — DL-69 kept native (a direct createLabel call) so the stdio path stays byte-identical
//     and does NOT emit the op-API-only label.create event; every other tool dispatches through agentOp().
registerTools(server, (name) => {
  if (name === "whoami") return () => ok({ actor: ACTOR, project: PROJECT_KEY, db: DB_PATH });
  if (name === "create_issue_label") {
    return (a) => {
      const { name: labelName, kind } = a as { name: string; kind?: string };
      const r = createLabel(db, projectId, { name: labelName, kind });
      return r.ok ? ok(r.data) : err(r.error);
    };
  }
  return (a) => dispatch(name as AgentOp, a);
});

await server.connect(new StdioServerTransport());
