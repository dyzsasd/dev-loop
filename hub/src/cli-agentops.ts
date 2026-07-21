#!/usr/bin/env node
// `dev-loop op <name>` + the ticket/comment/doc/label/project/events/mirror sugar verbs — the CLI WRITE layer
// (D8 CLI-first steps 1–2, docs/design/2026-07-review-decisions.md; A1). LAYER 0 is the generic dispatcher:
// any AGENT_OPS member, raw JSON args in, the op body as JSON out — the same resolveIdentity + G1/G2 guard
// pipeline server.ts runs, dispatched through the SAME agentOp() choke point (so the D1 project-override
// matrix, the DL-24/DL-32/DL-38 gates and the doc CAS all apply identically to CLI, stdio and op-API callers).
// LAYER 1 is thin flag-parsing sugar over the SAME dispatch — each verb builds an args object and calls the
// one runOp(); no verb re-implements any policy. Parser conventions mirror cli-tickets.ts (DL-91/DL-93):
// a dangling value or an unknown flag is a LOUD usage error (exit 2), never a silently-swallowed arg.
//
// TRANSPORT: direct-db by default (openDb + agentOp, exactly like server.ts); when the booted project's
// settings_json says hub.transport:"daemon" (the daemon.ts agentApiEnabled rule, read fresh per command) the
// op POSTs to the loopback daemon op-API instead, through the SAME op-client.ts the shim uses (one client).
//
// EXIT CODES (the machine contract downstream SKILL cheat-sheets teach):
//   0 ok · 1 domain error (op 4xx/5xx; the error body as JSON on stderr) · 2 usage · 3 doc.save CAS CONFLICT
//   (the {latestVersion,latestAuthor,hint} payload as JSON on stderr) · 4 identity/guard failure (G1 phantom
//   actor / G2 unresolved-or-unseeded project / the operator-in-a-fire write guard) · 5 hub unavailable
//   (daemon down or dormant; hub.db busy past the 5s busy_timeout).
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { openDb, actorExists, listActorHandles } from "./db.ts";
import { resolveIdentity } from "./resolve-project.ts";
import { ensureActors, findProject } from "./seed.ts";
import { resolveHubDbPath } from "./workspace.ts";
import { agentOp, isAgentOp, AGENT_OPS, AGENT_WRITE_OPS, type AgentOp, type OpResult } from "./agentops.ts";
import { opRunfilePath, resolveOpPort, postOp, postOpUrl } from "./op-client.ts";

const TYPES = ["Bug", "Feature", "Improvement"] as const;

const usage = (): void => {
  console.log(`dev-loop — hub write layer: the generic op dispatcher + sugar verbs (agent-facing; D8 CLI-first)

LAYER 0 — any hub op, raw JSON:
  dev-loop op <op-name> [--args-json '<JSON>']
      Dispatch any hub op; args ride --args-json, or stdin when --args-json is absent and stdin is piped.
      Ops: ${AGENT_OPS.join(", ")}

LAYER 1 — sugar verbs (every verb prints the op result as JSON on stdout; errors as JSON on stderr):
  dev-loop queue
      Your FIRST board read: the work lists pre-ranked server-side (§5/§21b in code). dev tiers
      { inProgress, todo — your slice, blocked excluded }; pm { verify, unblock, backlog,
      todoDepth }; qa { verify, blocked }. Summaries — 'ticket <id>' fetches the one you pick.
  dev-loop ticket create --title T --type Bug|Feature|Improvement [--description TEXT|'-'] [--description-file F]
                         [--labels a,b,c] [--priority 0-4] [--assignee A|me] [--blocked-by ids] [--related-to ids]
      --blocked-by writes the §9c blocking-edge marker comment ('Blocked-by: <id>', one line per id) after the create.
  dev-loop ticket update <id> [--state S] [--title T] [--labels FULL,SET] [--assignee A|me|''] [--priority 0-4]
                         [--related-to +ids] [--duplicate-of ID|'']
      HAZARD: labels REPLACE the full set (re-pass all).
      HAZARD: relatedTo is an APPEND-ONLY union (§18) — --related-to ADDS links; existing ones are never removed.
  dev-loop comment add <id> (--body TEXT | --body-file F | '-' = stdin)
  dev-loop comments <id>
  dev-loop labels
  dev-loop label create <name> [--kind K]
  dev-loop project
  dev-loop events [--ticket ID] [--since ISO] [--limit N]
  dev-loop doc list [--kind K]
  dev-loop doc get (--slug S | --kind K) [--version N|latest]
  dev-loop doc history (--slug S | --kind K)
  dev-loop doc diff (--slug S | --kind K) --from N --to N
  dev-loop doc save --slug S --kind K --base-version N (--file F | stdin) [--title T] [--summary TEXT]
      Optimistic CAS: --base-version MUST equal the doc's LATEST version (drafts included — NOT the published
      version doc get returns by default), else exit 3 with the CONFLICT payload ({latestVersion,latestAuthor,
      hint}) as JSON on stderr. Recover: doc get --slug S --version latest, re-apply your change, re-save with
      --base-version <latestVersion>.
  dev-loop doc publish (--slug S | --kind K) --version N        OPERATOR-ONLY (cooperative role gate)
  dev-loop doc archive --slug S [--restore]
      DESIGN docs only (singleton kinds refuse) — D6 retention: an archived doc is hidden from the /docs
      index and the notifiers by default, NEVER deleted (doc get/history stay readable). --restore un-archives.
  dev-loop mirror push --team-id T --token-env NAME [--project-id P] [--state-map '<JSON>'] [--limit N]
      With --project-id, the PUBLISHED strategy/roadmap/decisions + LATEST design docs ALSO mirror as Linear
      Documents parented to that Linear project (one-way, hash-skipped; doc counts ride the 'docs' result field).
  dev-loop mirror poll --token-env NAME
      Comment→intake on the mirrored docs: files ONE needs-pm Backlog ticket per NEW human comment (doc slug +
      version + quote + URL) and per detected Linear-side body edit (overwritten next push — never written
      back). Dedup rides a machine-local acted-ledger; DRYRUN previews the would-file tickets.
  dev-loop mirror status

Every verb also accepts:
  --project <key>       act on that project instead of the booted one — role-gated SERVER-side (the D1 matrix:
                        stewards + the operator → any project; pm → "_team" only; every other agent → FORBIDDEN).
  --json                accepted for symmetry (JSON is already the default output of every verb here).
  --i-am-the-operator   bypass the operator-in-a-fire write guard (see exit 4 below).

Identity rides DEVLOOP_ACTOR (per pane); project DEVLOOP_PROJECT (or the cwd); db DEVLOOP_HUB_DB. Transport:
direct-db by default; when the project's settings_json says hub.transport:"daemon", ops POST to the loopback daemon.

Exit codes:
  0 ok · 1 domain error (op 4xx/5xx; body on stderr) · 2 usage · 3 doc.save CAS CONFLICT (payload on stderr)
  4 identity/guard (unknown actor; unresolved/unseeded project; a WRITE as 'operator' inside an agent fire —
    DEVLOOP_TEAM_SCOPE/DEVLOOP_DEV_SPLIT set — without --i-am-the-operator) · 5 hub unavailable (daemon down/
    dormant, or hub.db busy past the 5s busy_timeout)`);
};

// usage error (exit 2) — the cli-tickets.ts convention: loud, named, never a silent mis-parse (DL-91/DL-93).
function fail(msg: string): never {
  console.error(`dev-loop: ${msg}`);
  process.exit(2);
}

// ─── flag parsing (the cli-tickets.ts conventions, factored for N verbs) ────────────────────────────────────
// spec: flag → "v" (takes a value) | "b" (boolean). A lone "-" is a POSITIONAL (the stdin marker), any other
// -prefixed token must be in the spec (unknown flag → exit 2 — never swallowed as a positional, DL-93), and a
// value-flag with no following token is a dangling-value usage error (DL-91).
type FlagSpec = Record<string, "v" | "b">;
const COMMON: FlagSpec = { "--project": "v", "--json": "b", "--i-am-the-operator": "b" };
function parseFlags(argv: string[], spec: FlagSpec): { flags: Record<string, string | true>; pos: string[] } {
  const flags: Record<string, string | true> = {}; const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-" || !a.startsWith("-")) { pos.push(a); continue; }
    const kind = spec[a];
    if (!kind) fail(`unknown flag '${a}'`);
    if (kind === "b") { flags[a] = true; continue; }
    const v = argv[++i];
    if (v === undefined) fail(`${a} needs a value`);
    flags[a] = v;
  }
  return { flags, pos };
}
const str = (flags: Record<string, string | true>, name: string): string | undefined =>
  typeof flags[name] === "string" ? (flags[name] as string) : undefined;
// comma-separated id/label list; a leading '+' (the append-mnemonic on --related-to) is stripped.
const csv = (v: string): string[] => v.replace(/^\+/, "").split(",").map((s) => s.trim()).filter(Boolean);
function intFlag(name: string, v: string, min: number, max?: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) fail(`${name} must be an integer${max !== undefined ? ` ${min}..${max}` : ` >= ${min}`} (got '${v}')`);
  return n;
}
const readStdinAll = (): string => readFileSync(0, "utf8"); // fd 0 — sync full-drain (a one-shot CLI, no stream ceremony)
function readFileArg(flag: string, path: string): string {
  try { return readFileSync(path, "utf8"); } catch (e) { fail(`${flag} ${path}: ${(e as Error).message}`); }
}

// ─── the hub connection + the server.ts identity pipeline (G1/G2 → exit 4; a busy db → exit 5) ──────────────
// `attachBase` (one-click §6.0): DEVLOOP_HUB_URL is set — the home is REMOTE. No local db opens, no
// local G1/G2 guards (the daemon runs its own), every op POSTs over the token-authed op-API.
interface Hub { db?: DatabaseSync; projectId?: string; projectKey: string; actor: string; daemonTransport: boolean; attachBase?: URL }
const isBusy = (e: unknown): boolean => {
  const err = e as { errcode?: number; message?: string };
  return err.errcode === 5 || err.errcode === 6 || /SQLITE_BUSY|database is locked/i.test(err.message ?? ""); // 5=SQLITE_BUSY 6=SQLITE_LOCKED
};
function openHub(): Hub {
  // ── ATTACH (§6.0): the remote hub is the SoR — skip every local open/guard. Identity still rides
  // DEVLOOP_ACTOR (default operator: the console's posture); the project may stay unresolved (the
  // daemon's boot project applies, or args.project targets one — the operator override).
  const hubUrl = process.env.DEVLOOP_HUB_URL?.trim();
  if (hubUrl) {
    let base: URL;
    try { base = new URL(hubUrl); if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("bad protocol"); }
    catch { console.error(`dev-loop: DEVLOOP_HUB_URL '${hubUrl}' is not a valid http(s) URL`); process.exit(2); }
    return { projectKey: process.env.DEVLOOP_PROJECT?.trim() ?? "", actor: process.env.DEVLOOP_ACTOR ?? "operator", daemonTransport: true, attachBase: base };
  }
  const { actor, projectKey, projectFromCwd, projectResolved } = resolveIdentity();
  if (!projectResolved) {
    console.error("dev-loop: no project resolved. Set DEVLOOP_PROJECT=<key>, or run from inside a repo configured in the workspace.");
    process.exit(4);
  }
  let db: DatabaseSync;
  try {
    db = openDb(resolveHubDbPath()); // workspace-aware ladder (P2 #1) — a bare `dev-loop op` at the workspace root must hit ITS board, not the global default
    ensureActors(db); // idempotent (server.ts does the same) — the G1 guard below needs the roster present; INSERTs, so it belongs inside the busy mapping (codex #3)
  } catch (e) {
    if (isBusy(e)) { console.error(`dev-loop: hub db is busy past the 5s busy_timeout: ${(e as Error).message}`); process.exit(5); }
    throw e;
  }
  if (!actorExists(db, actor)) { // G1 phantom-actor guard — a typo'd DEVLOOP_ACTOR must never write unattributably
    console.error(`dev-loop: DEVLOOP_ACTOR='${actor}' is not a known actor. Valid: ${listActorHandles(db).join(", ")}. Fix DEVLOOP_ACTOR in the launcher.`);
    process.exit(4);
  }
  const projectId = findProject(db, projectKey); // G2 phantom-project guard — never auto-create a board by typo
  if (!projectId) {
    const src = projectFromCwd ? `resolved from cwd '${process.cwd()}'` : `from DEVLOOP_PROJECT='${projectKey}'`;
    console.error(`dev-loop: project '${projectKey}' (${src}) is not seeded in the hub DB. Seed it once (\`dev-loop seed ${projectKey} "<name>" <UNIQUE_PREFIX>\`), or set DEVLOOP_PROJECT / run from inside the project repo.`);
    process.exit(4);
  }
  // hub.transport — the daemon.ts agentApiEnabled rule, read fresh per command (malformed config ⇒ direct).
  let daemonTransport = false;
  try {
    const row = db.prepare("SELECT settings_json FROM projects WHERE id=?").get(projectId) as { settings_json?: string } | undefined;
    daemonTransport = (JSON.parse(row?.settings_json ?? "{}") as { hub?: { transport?: string } })?.hub?.transport === "daemon";
  } catch { /* malformed settings_json ⇒ direct-db (the working default) */ }
  return { db, projectId, projectKey, actor, daemonTransport };
}

// ─── the ONE dispatch every verb funnels through ────────────────────────────────────────────────────────────
// Cooperative accident guard (per the D8 design): a fire environment always carries DEVLOOP_TEAM_SCOPE (steward
// fires) or DEVLOOP_DEV_SPLIT (every run-agents fire env + both MCP injections) — so a WRITE arriving as
// 'operator' inside one means DEVLOOP_ACTOR was stripped/lost and the write would be MIS-ATTRIBUTED to the
// human. Refuse (exit 4) unless --i-am-the-operator says otherwise. Cooperative like G1 (§18) — not anti-spoof.
const FIRE_MARKERS = ["DEVLOOP_TEAM_SCOPE", "DEVLOOP_DEV_SPLIT"] as const;
let iAmTheOperator = false; // set from the parsed --i-am-the-operator of the active verb
async function runOp(hub: Hub, op: AgentOp, args: Record<string, unknown>): Promise<OpResult> {
  if (AGENT_WRITE_OPS.has(op) && hub.actor === "operator" && !iAmTheOperator) {
    const marker = FIRE_MARKERS.find((m) => (process.env[m] ?? "") !== "");
    if (marker) {
      console.error(`dev-loop: refusing to write as 'operator' inside an agent fire (${marker} is set): DEVLOOP_ACTOR resolved to 'operator', so this write would be mis-attributed to the human. Set DEVLOOP_ACTOR to your agent handle, or pass --i-am-the-operator if you really are the operator.`);
      process.exit(4);
    }
  }
  if (hub.attachBase) { // §6.0: the remote hub — same op, same body, over the token-authed op-API
    const sent = hub.projectKey && args.project === undefined ? { ...args, project: hub.projectKey } : args;
    const out = await postOpUrl(hub.attachBase, op, sent, hub.actor);
    if (out.kind === "down") { console.error(`dev-loop: remote hub ${hub.attachBase.origin} is not reachable${out.detail}. Check DEVLOOP_HUB_URL / the tunnel / the server.`); process.exit(5); }
    if (out.kind === "dormant") { console.error(`dev-loop: ${hub.attachBase.origin} answers but its op-API is dormant — the home's project rows need settings_json.hub.transport:"daemon" (a bundle load seeds this; else seed it at the home).`); process.exit(5); }
    if (out.status === 401) { console.error(`dev-loop: ${hub.attachBase.origin} requires the bearer token — set DEVLOOP_UI_TOKEN (or _FILE) to the home's token (§6.2).`); process.exit(5); }
    return { status: out.status, body: out.body };
  }
  if (hub.daemonTransport) { // config said daemon: POST to the loopback op-API through the shared op-client
    const port = resolveOpPort(hub.projectKey);
    if (port === null) {
      console.error(`dev-loop: hub.transport is "daemon" for '${hub.projectKey}' but no daemon is reachable (no lifecycle runfile at ${opRunfilePath(hub.projectKey)}, and DEVLOOP_HUB_PORT is unset). Start it: DEVLOOP_PROJECT=${hub.projectKey} dev-loop daemon up`);
      process.exit(5);
    }
    const out = await postOp(port, op, args, hub.actor);
    if (out.kind === "down") { console.error(`dev-loop: hub daemon for '${hub.projectKey}' is not reachable on 127.0.0.1${out.detail}.`); process.exit(5); }
    if (out.kind === "dormant") { console.error(`dev-loop: the daemon is running but its agent op-API is dormant for '${hub.projectKey}' — the project's settings_json says hub.transport:"daemon" here but the daemon disagrees. Restart it (dev-loop daemon up) or check settings_json.`); process.exit(5); }
    return { status: out.status, body: out.body };
  }
  try { return await agentOp(op, hub.db!, hub.projectId!, hub.projectKey, hub.actor, args); }
  catch (e) {
    if (isBusy(e)) { console.error(`dev-loop: hub db is busy past the 5s busy_timeout (another writer holds the lock): ${(e as Error).message}`); process.exit(5); }
    console.error(`dev-loop: ${(e as Error).message}`);
    process.exit(1);
  }
}

// stdout = JSON.stringify(body), the SAME bytes ok() puts in the MCP text — the parity contract the
// cli-agentops test asserts (sugar ≡ op dispatcher ≡ stdio). Errors go to stderr as the raw op body.
function emit(op: AgentOp, r: OpResult): never {
  if (r.status >= 200 && r.status < 300) { console.log(JSON.stringify(r.body)); process.exit(0); }
  console.error(JSON.stringify(r.body));
  process.exit(op === "doc.save" && r.status === 409 ? 3 : 1); // 3 = the doc CAS CONFLICT contract ({latestVersion,…} on stderr)
}

// ─── main ───────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<never> {
  const [sub, ...rest] = process.argv.slice(2); // cli.ts passes the verb as argv[0] (the cli-tickets routing shape)
  // leading --help/-h (e.g. `dev-loop op --help`, `dev-loop doc save --help`) prints the full write-layer
  // usage; checked on the LEADING positions only so a later flag VALUE that happens to be '-h' isn't swallowed.
  if (!sub || sub === "help" || rest.slice(0, 2).some((a) => a === "--help" || a === "-h")) { usage(); process.exit(sub ? 0 : 2); }

  // Every verb parses first (usage errors need no db), then opens the hub once and funnels through runOp.
  switch (sub) {
    // ── LAYER 0: the generic dispatcher ──
    case "op": {
      const { flags, pos } = parseFlags(rest, { "--args-json": "v", ...COMMON });
      iAmTheOperator = flags["--i-am-the-operator"] === true;
      const name = pos[0];
      if (!name) fail("usage: dev-loop op <op-name> [--args-json '<JSON>'] (or pipe the JSON args on stdin)");
      if (!isAgentOp(name)) fail(`unknown op '${name}'. Ops: ${AGENT_OPS.join(", ")}`);
      if (pos.length > 1) fail(`unexpected argument '${pos[1]}'`);
      let raw = str(flags, "--args-json");
      if (raw === undefined && !process.stdin.isTTY) { const s = readStdinAll().trim(); if (s) raw = s; } // stdin JSON when piped
      let args: Record<string, unknown> = {};
      if (raw !== undefined) {
        let v: unknown;
        try { v = JSON.parse(raw); } catch { fail("--args-json / stdin is not valid JSON"); }
        if (!v || typeof v !== "object" || Array.isArray(v)) fail("op args must be a JSON object");
        args = v as Record<string, unknown>;
      }
      const project = str(flags, "--project");
      if (project !== undefined) args.project = project; // the explicit flag wins over an args-JSON key
      emit(name, await runOp(openHub(), name, args));
    }

    // ── LAYER 1: queue — the pre-ranked per-agent work lists (§5/§21b in code) ──
    case "queue": {
      const { flags, pos } = parseFlags(rest, { ...COMMON });
      iAmTheOperator = flags["--i-am-the-operator"] === true;
      if (pos.length) fail(`unexpected argument '${pos[0]}'`);
      const qargs: Record<string, unknown> = {};
      if (flags["--project"] !== undefined) qargs.project = str(flags, "--project");
      emit("queue", await runOp(openHub(), "queue", qargs));
    }

    // ── LAYER 1: ticket create | ticket update ──
    case "ticket": {
      const [verb, ...targs] = rest;
      if (verb === "create") {
        const { flags, pos } = parseFlags(targs, {
          "--title": "v", "--type": "v", "--description": "v", "--description-file": "v", "--labels": "v",
          "--priority": "v", "--assignee": "v", "--blocked-by": "v", "--related-to": "v", ...COMMON,
        });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const title = str(flags, "--title"); if (!title) fail("ticket create needs --title");
        const type = str(flags, "--type");
        if (!type || !(TYPES as readonly string[]).includes(type)) fail(`ticket create needs --type ${TYPES.join("|")}`);
        if (flags["--description"] !== undefined && flags["--description-file"] !== undefined) fail("pass --description OR --description-file, not both");
        const descFlag = str(flags, "--description");
        const description = descFlag !== undefined ? (descFlag === "-" ? readStdinAll() : descFlag)
          : flags["--description-file"] !== undefined ? readFileArg("--description-file", str(flags, "--description-file")!) : undefined;
        const args: Record<string, unknown> = { title, type };
        if (description !== undefined) args.description = description;
        if (flags["--labels"] !== undefined) args.labels = csv(str(flags, "--labels")!);
        if (flags["--priority"] !== undefined) args.priority = intFlag("--priority", str(flags, "--priority")!, 0, 4);
        if (flags["--assignee"] !== undefined) args.assignee = str(flags, "--assignee");
        if (flags["--related-to"] !== undefined) args.relatedTo = csv(str(flags, "--related-to")!);
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        const blockedBy = flags["--blocked-by"] !== undefined ? csv(str(flags, "--blocked-by")!) : [];
        const hub = openHub();
        const r = await runOp(hub, "save_issue", args);
        if (!(r.status >= 200 && r.status < 300) || blockedBy.length === 0) emit("save_issue", r);
        // §9c blocking edges: on service there is no native relation — the machine-parseable marker comment
        // ('Blocked-by: <id>' on its own line, conventions §9c step 2) IS the edge. Print the create body
        // first (stdout carries the ticket either way), then write the marker; a failed marker → exit 1.
        console.log(JSON.stringify(r.body));
        const id = (r.body as { id: string }).id;
        const c = await runOp(hub, "save_comment", {
          issueId: id, body: blockedBy.map((b) => `Blocked-by: ${b}`).join("\n"),
          ...(flags["--project"] !== undefined ? { project: str(flags, "--project") } : {}),
        });
        if (c.status < 200 || c.status >= 300) { console.error(JSON.stringify(c.body)); process.exit(1); }
        process.exit(0);
      }
      if (verb === "update") {
        const { flags, pos } = parseFlags(targs, {
          "--state": "v", "--title": "v", "--labels": "v", "--assignee": "v", "--priority": "v",
          "--related-to": "v", "--duplicate-of": "v", ...COMMON,
        });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        const id = pos[0];
        if (!id) fail("usage: dev-loop ticket update <id> [--state S] [--title T] [--labels FULL,SET] [--assignee A] [--priority N] [--related-to +ids] [--duplicate-of ID]");
        if (pos.length > 1) fail(`unexpected argument '${pos[1]}'`);
        const args: Record<string, unknown> = { id };
        if (flags["--state"] !== undefined) args.state = str(flags, "--state");
        if (flags["--title"] !== undefined) args.title = str(flags, "--title");
        if (flags["--labels"] !== undefined) args.labels = csv(str(flags, "--labels")!); // HAZARD: labels REPLACE the full set (re-pass all)
        if (flags["--assignee"] !== undefined) args.assignee = str(flags, "--assignee"); // '' clears, 'me' = you (the op resolves both)
        if (flags["--priority"] !== undefined) args.priority = intFlag("--priority", str(flags, "--priority")!, 0, 4);
        if (flags["--related-to"] !== undefined) args.relatedTo = csv(str(flags, "--related-to")!); // HAZARD: APPEND-ONLY union (§18) — adds, never removes
        if (flags["--duplicate-of"] !== undefined) { const d = str(flags, "--duplicate-of")!; args.duplicateOf = d === "" ? null : d; }
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        if (Object.keys(args).length === 1 + (args.project !== undefined ? 1 : 0))
          fail("nothing to update — pass at least one of --state/--title/--labels/--assignee/--priority/--related-to/--duplicate-of");
        emit("save_issue", await runOp(openHub(), "save_issue", args));
      }
      fail(`usage: dev-loop ticket create|update … (reads stay \`dev-loop ticket <id>\`)`);
    }

    // ── comment add <id> ──
    case "comment": {
      const { flags, pos } = parseFlags(rest, { "--body": "v", "--body-file": "v", ...COMMON });
      iAmTheOperator = flags["--i-am-the-operator"] === true;
      if (pos[0] !== "add") fail("usage: dev-loop comment add <id> (--body TEXT | --body-file F | '-' = stdin)");
      const id = pos[1];
      if (!id || id === "-") fail("comment add needs a ticket id");
      const bodyFlag = str(flags, "--body");
      const body = bodyFlag !== undefined ? (bodyFlag === "-" ? readStdinAll() : bodyFlag)
        : flags["--body-file"] !== undefined ? readFileArg("--body-file", str(flags, "--body-file")!)
        : pos[2] === "-" ? readStdinAll() : undefined;
      if (body === undefined) fail("comment add needs --body TEXT, --body-file F, or '-' (stdin)");
      const args: Record<string, unknown> = { issueId: id, body };
      if (flags["--project"] !== undefined) args.project = str(flags, "--project");
      emit("save_comment", await runOp(openHub(), "save_comment", args));
    }

    // ── comments <id> ──
    case "comments": {
      const { flags, pos } = parseFlags(rest, COMMON);
      const id = pos[0];
      if (!id) fail("usage: dev-loop comments <id>");
      if (pos.length > 1) fail(`unexpected argument '${pos[1]}'`);
      const args: Record<string, unknown> = { issueId: id };
      if (flags["--project"] !== undefined) args.project = str(flags, "--project");
      emit("list_comments", await runOp(openHub(), "list_comments", args));
    }

    // ── labels | label create <name> ──
    case "labels": {
      const { flags, pos } = parseFlags(rest, COMMON);
      if (pos.length) fail(`unexpected argument '${pos[0]}'`);
      const args: Record<string, unknown> = {};
      if (flags["--project"] !== undefined) args.project = str(flags, "--project");
      emit("list_issue_labels", await runOp(openHub(), "list_issue_labels", args));
    }
    case "label": {
      const { flags, pos } = parseFlags(rest, { "--kind": "v", ...COMMON });
      iAmTheOperator = flags["--i-am-the-operator"] === true;
      if (pos[0] !== "create" || !pos[1]) fail("usage: dev-loop label create <name> [--kind K]");
      if (pos.length > 2) fail(`unexpected argument '${pos[2]}'`);
      const args: Record<string, unknown> = { name: pos[1] };
      if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
      if (flags["--project"] !== undefined) args.project = str(flags, "--project");
      emit("create_issue_label", await runOp(openHub(), "create_issue_label", args));
    }

    // ── project ──
    case "project": {
      const { flags, pos } = parseFlags(rest, COMMON);
      if (pos.length) fail(`unexpected argument '${pos[0]}'`);
      const args: Record<string, unknown> = {};
      if (flags["--project"] !== undefined) args.project = str(flags, "--project");
      emit("get_project", await runOp(openHub(), "get_project", args));
    }

    // ── events [--ticket ID] [--since ISO] [--limit N] ──
    case "events": {
      const { flags, pos } = parseFlags(rest, { "--ticket": "v", "--since": "v", "--limit": "v", ...COMMON });
      if (pos.length) fail(`unexpected argument '${pos[0]}'`);
      const args: Record<string, unknown> = {};
      if (flags["--ticket"] !== undefined) args.ticketId = str(flags, "--ticket");
      if (flags["--limit"] !== undefined) args.limit = intFlag("--limit", str(flags, "--limit")!, 1, 500);
      if (flags["--project"] !== undefined) args.project = str(flags, "--project");
      const since = str(flags, "--since");
      const r = await runOp(openHub(), "list_events", args);
      // --since is CLIENT-side (the op has no since arg): filter the returned rows by created_at. Applied only
      // on success — an error body passes through emit untouched.
      if (since !== undefined && r.status === 200 && Array.isArray(r.body))
        r.body = (r.body as { created_at: string }[]).filter((e) => e.created_at >= since);
      emit("list_events", r);
    }

    // ── doc list|get|history|diff|save|publish — doc.* 1:1 ──
    case "doc": {
      const [verb, ...dargs] = rest;
      if (verb === "list") {
        const { flags, pos } = parseFlags(dargs, { "--kind": "v", ...COMMON });
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const args: Record<string, unknown> = {};
        if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("doc.list", await runOp(openHub(), "doc.list", args));
      }
      if (verb === "get" || verb === "history") {
        const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", ...(verb === "get" ? { "--version": "v" } : {}), ...COMMON });
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        if (flags["--slug"] === undefined && flags["--kind"] === undefined) fail(`doc ${verb} needs --slug S or --kind K`);
        const args: Record<string, unknown> = {};
        if (flags["--slug"] !== undefined) args.slug = str(flags, "--slug");
        if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
        const ver = str(flags, "--version");
        if (ver !== undefined) args.version = ver === "latest" ? "latest" : intFlag("--version", ver, 1);
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        const op: AgentOp = verb === "get" ? "doc.get" : "doc.history";
        emit(op, await runOp(openHub(), op, args));
      }
      if (verb === "diff") {
        const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", "--from": "v", "--to": "v", ...COMMON });
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        if (flags["--slug"] === undefined && flags["--kind"] === undefined) fail("doc diff needs --slug S or --kind K"); // a selector-less diff is a usage error (exit 2), not a 404 (codex #5)
        if (flags["--from"] === undefined || flags["--to"] === undefined) fail("doc diff needs --from N and --to N");
        const args: Record<string, unknown> = { from: intFlag("--from", str(flags, "--from")!, 1), to: intFlag("--to", str(flags, "--to")!, 1) };
        if (flags["--slug"] !== undefined) args.slug = str(flags, "--slug");
        if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("doc.diff", await runOp(openHub(), "doc.diff", args));
      }
      if (verb === "save") {
        const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", "--base-version": "v", "--file": "v", "--title": "v", "--summary": "v", ...COMMON });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const slug = str(flags, "--slug"); if (!slug) fail("doc save needs --slug S");
        const kind = str(flags, "--kind"); if (!kind) fail("doc save needs --kind K");
        if (flags["--base-version"] === undefined) fail("doc save needs --base-version N (the optimistic-CAS key: the doc's LATEST version, drafts included; 0 creates)");
        const baseVersion = intFlag("--base-version", str(flags, "--base-version")!, 0);
        const body = flags["--file"] !== undefined ? readFileArg("--file", str(flags, "--file")!)
          : !process.stdin.isTTY ? readStdinAll() : fail("doc save needs --file F or a piped stdin body");
        const args: Record<string, unknown> = { slug, kind, body, baseVersion };
        if (flags["--title"] !== undefined) args.title = str(flags, "--title");
        if (flags["--summary"] !== undefined) args.summary = str(flags, "--summary");
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("doc.save", await runOp(openHub(), "doc.save", args)); // a 409 CAS CONFLICT → exit 3, payload on stderr
      }
      if (verb === "publish") {
        const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", "--version": "v", ...COMMON });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        if (flags["--slug"] === undefined && flags["--kind"] === undefined) fail("doc publish needs --slug S or --kind K"); // usage (exit 2), not a 404 (codex #5)
        if (flags["--version"] === undefined) fail("doc publish needs --version N");
        const args: Record<string, unknown> = { version: intFlag("--version", str(flags, "--version")!, 1) };
        if (flags["--slug"] !== undefined) args.slug = str(flags, "--slug");
        if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("doc.publish", await runOp(openHub(), "doc.publish", args));
      }
      if (verb === "archive") {
        // D6: a metadata flip on a retired DESIGN doc (slug-only — design is multi-instance; the op
        // refuses singleton kinds server-side). --restore maps to archived:false; the default archives.
        const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--restore": "b", ...COMMON });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const slug = str(flags, "--slug"); if (!slug) fail("doc archive needs --slug S");
        const args: Record<string, unknown> = { slug };
        if (flags["--restore"] === true) args.archived = false;
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("doc.archive", await runOp(openHub(), "doc.archive", args));
      }
      fail("usage: dev-loop doc list|get|history|diff|save|publish|archive …");
    }

    // ── mirror push|poll|status ──
    case "mirror": {
      const [verb, ...margs] = rest;
      if (verb === "push") {
        const { flags, pos } = parseFlags(margs, { "--team-id": "v", "--token-env": "v", "--project-id": "v", "--state-map": "v", "--limit": "v", ...COMMON });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const teamId = str(flags, "--team-id"); if (!teamId) fail("mirror push needs --team-id T");
        const tokenEnv = str(flags, "--token-env"); if (!tokenEnv) fail("mirror push needs --token-env NAME (the env-var NAME, never the secret)");
        const args: Record<string, unknown> = { teamId, tokenEnv };
        if (flags["--project-id"] !== undefined) args.projectId = str(flags, "--project-id");
        if (flags["--state-map"] !== undefined) {
          let m: unknown;
          try { m = JSON.parse(str(flags, "--state-map")!); } catch { fail("--state-map is not valid JSON"); }
          if (!m || typeof m !== "object" || Array.isArray(m)) fail("--state-map must be a JSON object (hub State → Linear state id)");
          args.stateMap = m;
        }
        if (flags["--limit"] !== undefined) args.limit = intFlag("--limit", str(flags, "--limit")!, 1, 500);
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("mirror.push", await runOp(openHub(), "mirror.push", args));
      }
      if (verb === "poll") {
        const { flags, pos } = parseFlags(margs, { "--token-env": "v", ...COMMON });
        iAmTheOperator = flags["--i-am-the-operator"] === true;
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const tokenEnv = str(flags, "--token-env"); if (!tokenEnv) fail("mirror poll needs --token-env NAME (the env-var NAME, never the secret)");
        const args: Record<string, unknown> = { tokenEnv };
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("mirror.pollComments", await runOp(openHub(), "mirror.pollComments", args));
      }
      if (verb === "status") {
        const { flags, pos } = parseFlags(margs, COMMON);
        if (pos.length) fail(`unexpected argument '${pos[0]}'`);
        const args: Record<string, unknown> = {};
        if (flags["--project"] !== undefined) args.project = str(flags, "--project");
        emit("mirror.status", await runOp(openHub(), "mirror.status", args));
      }
      fail("usage: dev-loop mirror push|poll|status …");
    }

    default:
      fail(`unknown verb '${sub}'`);
  }
}

await main();
