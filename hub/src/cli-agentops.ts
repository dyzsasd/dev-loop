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
import { activeFireMarker } from "./destructive-guard.ts"; // LOOP-367: ONE fire-marker list, owned there
import { readFileSync } from "node:fs";
import { isMainEntry } from "./is-entry.ts";
import { openDb, actorExists, listActorHandles, STATES } from "./db.ts";
import { isRulingShaped } from "./ticketwrite.ts"; // WS-C review 3: the ONE ruling grammar (the op layer parses it; this layer only needs the shape)
import { resolveIdentity } from "./resolve-project.ts";
import { ensureActors, findProject } from "./seed.ts";
import { resolveHubDbPath, tryResolveWorkspace } from "./workspace.ts";
import { reposOfProject, type RepoEntry, type Workspace } from "./team-config.ts";
import { agentOp, isAgentOp, AGENT_OPS, AGENT_WRITE_OPS, type AgentOp, type OpResult } from "./agentops.ts";
import { makeGhExec, defaultGhExec, annotateTicketLanding, GH_EXEC_TIMEOUT_MS } from "./landing.ts";
import { checkReviewAdmission } from "./review-admission.ts";
import { parseDocPointer } from "./design-parent.ts"; // LOOP-572: the §21a pointer grammar has ONE parse
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
      { inProgress, todo — your slice, blocked excluded; inReview — LANDING/REPAIR ONLY (merge green PRs/fix red) };
      pm { verify, unblock, backlog, todoDepth }; qa { verify, blocked }. Summaries — 'ticket <id>' fetches the one you pick.
  dev-loop ticket create --title T --type Bug|Feature|Improvement [--state S] [--description TEXT|'-'] [--description-file F]
                         [--labels a,b,c] [--priority 0-4] [--assignee A|me] [--blocked-by ids] [--related-to ids]
      --state defaults to Backlog (§5a funnel); pass --state Todo for §3 carve-outs. --blocked-by writes the §9c marker comment ('Blocked-by: <id>') AND sets the 'blocked' label (LOOP-190).
  dev-loop ticket update <id> [--state S] [--title T] [--labels FULL,SET] [--assignee A|me|''] [--priority 0-4]
                         [--description TEXT|'-'] [--description-file F] [--related-to +ids] [--duplicate-of ID|''] [--blocked-by ids] [--unblocked-by ids]
      HAZARD: labels REPLACE the full set (re-pass all). --blocked-by writes the §9c marker ('Blocked-by: <id>') AND adds 'blocked' to the ticket's CURRENT label set (no re-pass needed); --unblocked-by writes the retirement marker ('Unblocked-by: <id>'), bare-line form.
      HAZARD: relatedTo is an APPEND-ONLY union (§18) — --related-to ADDS links; existing ones are never removed.
  dev-loop comment add <id> (--body TEXT | --body-file F | '-' = stdin)
  dev-loop comments <id>
  dev-loop labels
  dev-loop label create <name> [--kind K]
  dev-loop project
  dev-loop events [--ticket ID] [--actor A] [--since ISO] [--limit N]
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
  if (path === "-") return readStdinAll();
  try { return readFileSync(path, "utf8"); } catch (e) { fail(`${flag} ${path}: ${(e as Error).message}`); }
}

// ─── the hub connection + the server.ts identity pipeline (G1/G2 → exit 4; a busy db → exit 5) ──────────────
// `attachBase` (one-click §6.0): DEVLOOP_HUB_URL is set — the home is REMOTE. No local db opens, no
// local G1/G2 guards (the daemon runs its own), every op POSTs over the token-authed op-API.
export interface Hub { db?: DatabaseSync; projectId?: string; projectKey: string; actor: string; daemonTransport: boolean; attachBase?: URL }
const isBusy = (e: unknown): boolean => {
  const err = e as { errcode?: number; message?: string };
  return err.errcode === 5 || err.errcode === 6 || /SQLITE_BUSY|database is locked/i.test(err.message ?? ""); // 5=SQLITE_BUSY 6=SQLITE_LOCKED
};
// Exported (WS-C review 3) as the ONE transport seam: rule-cli.ts composes its one-shot from the same
// openHub + runOp every sugar verb uses, so a ruling routes identically at home, over hub.transport:
// "daemon", and over an attach — never a second copy of the identity pipeline.
export function openHub(): Hub {
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
  // Resolved ONCE, inside the try, and reused by the catch. The catch used to call resolveHubDbPath()
  // again to name the path — and when the resolver is what threw (no DEVLOOP_HUB_DB, no DEVLOOP_HOME, no
  // workspace: the shape 5592825 created by retiring the ~/.dev-loop fallback) it threw a SECOND time,
  // out of the catch, past process.exit(5). Measured: exit 1 and a stack trace whose top frame is this
  // very line, for every agent write verb. The exit-5 mapping this catch exists to provide never ran on
  // the most common way to reach it — an error handler that reuses the failing operation is not a handler.
  let dbPath: string | null = null;
  try {
    dbPath = resolveHubDbPath(); // workspace-aware ladder (P2 #1) — a bare `dev-loop op` at the workspace root must hit ITS board, not the global default
    db = openDb(dbPath);
    ensureActors(db); // idempotent (server.ts does the same) — the G1 guard below needs the roster present; INSERTs, so it belongs inside the busy mapping (codex #3)
  } catch (e) {
    // ANY failure to open the board is "hub unavailable" (exit 5). Busy was the only one mapped, so a
    // corrupt file (SQLITE_NOTADB), a permission denial (SQLITE_CANTOPEN) and a path that is a directory
    // all re-threw — and an escape from a CLI verb is not a neutral event: it left the contract entirely
    // and surfaced as a stack trace. Measured on the same workspace, same fault: `dev-loop tickets` gave
    // a trace while `dev-loop approvals`, which catches broadly, gave 5 and a sentence. Two answers to one
    // question, from one binary. Busy keeps its own message because "retry" is useful advice and "the file
    // is not a database" is not, but both are 5 — the board is what is unavailable either way.
    const msg = (e as Error).message ?? String(e);
    if (isBusy(e)) console.error(`dev-loop: hub db is busy past the 5s busy_timeout: ${msg}`);
    // `dbPath` is null when the RESOLVER threw, in which case its own message already says what to do.
    else console.error(dbPath === null ? `dev-loop: ${msg}` : `dev-loop: cannot open the board at ${dbPath} — ${msg}`);
    process.exit(5);
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
let iAmTheOperator = false; // set from the parsed --i-am-the-operator of the active verb
// WS-C review 3: a `Ruling:` comment inside a fire is refused with NO bypass — the approvals-cli
// posture (design approvals §2), not the cooperative one above. `--i-am-the-operator` exists so a
// human whose shell inherited a marker can still write; a RULING is the one comment whose whole value
// is that a fire could not have written it, so the flag must not reach it. The op layer additionally
// refuses any non-human actor (ticketwrite.ts rulingCommentPolicy); this guard is the marker half,
// which only the process that owns the env can see. Checked on the op, so `op save_comment` and
// `comment add` (and `rule`, which checks earlier) all meet it.
export function rulingFireRefusal(body: unknown, marker: string | null = activeFireMarker()): string | null {
  if (!marker || typeof body !== "string" || !isRulingShaped(body)) return null;
  return `refusing a Ruling: comment inside an agent fire (${marker} is set). A ruling is the human's act — the record is only worth reading because a fire cannot write one. Nothing has been written. To ask for a ruling, park the ticket Human-Blocked with a Bail-shape comment; the operator rules from their own console: dev-loop rule <id> approve|reject|defer --reason "<why>"`;
}
export async function runOp(hub: Hub, op: AgentOp, args: Record<string, unknown>): Promise<OpResult> {
  if (op === "save_comment") {
    const refusal = rulingFireRefusal(args.body);
    if (refusal) { console.error(`dev-loop: ${refusal}`); process.exit(4); }
  }
  if (AGENT_WRITE_OPS.has(op) && hub.actor === "operator" && !iAmTheOperator) {
    const marker = activeFireMarker();
    if (marker) {
      console.error(`dev-loop: refusing to write as 'operator' inside an agent fire (${marker} is set): DEVLOOP_ACTOR resolved to 'operator', so this write would be mis-attributed to the human. Set DEVLOOP_ACTOR to your agent handle, or pass --i-am-the-operator if you really are the operator.`);
      process.exit(4);
    }
  }
  if (hub.attachBase) { // §6.0: the remote hub — same op, same body, over the token-authed op-API
    const sent = hub.projectKey && args.project === undefined ? { ...args, project: hub.projectKey } : args;
    const out = await postOpUrl(hub.attachBase, op, sent, hub.actor);
    if (out.kind === "refused") { console.error(`dev-loop: ${out.detail}`); process.exit(5); } // LOOP-173: bearer would leak in cleartext — never sent
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
    if (out.kind === "refused") { console.error(`dev-loop: ${out.detail}`); process.exit(5); } // exhaustiveness: a loopback base never trips the LOOP-173 egress guard
    if (out.kind === "down") { console.error(`dev-loop: hub daemon for '${hub.projectKey}' is not reachable on 127.0.0.1${out.detail}.`); process.exit(5); }
    if (out.kind === "dormant") { console.error(`dev-loop: the daemon is running but its agent op-API is dormant for '${hub.projectKey}' — the project's settings_json says hub.transport:"daemon" here but the daemon disagrees. Restart it (DEVLOOP_PROJECT=${hub.projectKey} dev-loop daemon up) or check settings_json.`); process.exit(5); }
    return { status: out.status, body: out.body };
  }
  try { return await agentOp(op, hub.db!, hub.projectId!, hub.projectKey, hub.actor, args); }
  catch (e) {
    if (isBusy(e)) { console.error(`dev-loop: hub db is busy past the 5s busy_timeout (another writer holds the lock): ${(e as Error).message}`); process.exit(5); }
    console.error(`dev-loop: ${(e as Error).message}`);
    process.exit(1);
  }
}

// process.exit() discards the async stdout buffer when piped; await the drain callback before exiting.
function flushStdout(): Promise<void> {
  return new Promise<void>(resolve => process.stdout.write("", () => resolve()));
}

// stdout = JSON.stringify(body), the SAME bytes ok() puts in the MCP text — the parity contract the
// cli-agentops test asserts (sugar ≡ op dispatcher ≡ stdio). Errors go to stderr as the raw op body.
async function emit(op: AgentOp, r: OpResult): Promise<never> {
  if (r.status >= 200 && r.status < 300) { console.log(JSON.stringify(r.body)); await flushStdout(); process.exit(0); }
  console.error(JSON.stringify(r.body));
  process.exit(op === "doc.save" && r.status === 409 ? 3 : 1); // 3 = the doc CAS CONFLICT contract ({latestVersion,…} on stderr)
}

// ─── verb handlers (1.8 quality-gauntlet split) ─────────────────────────────────────────────────────────
// This used to be ONE switch inside main() — CC 162, CRAP 374, the worst row of the 1.7.0 self-audit.
// Now: one small function per verb (sub-verbs get their own), a flat dispatch table, and main() is a
// lookup. Bodies moved VERBATIM — the stdout parity contract (sugar ≡ op dispatcher ≡ stdio, asserted
// byte-exact by the cli-agentops test) is the refactor's regression net.
type VerbHandler = (rest: string[]) => Promise<never>;

async function verbOp(rest: string[]): Promise<never> {
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
  return emit(name, await runOp(openHub(), name, args));
}

function entryGhRepo(entry: RepoEntry | undefined): string | null {
  if (!entry?.autoMerge || entry.landing !== "pr" || !entry.remote) return null;
  const m = entry.remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

function resolveTicketGhRepo(labels: string[], ws: Workspace | null, projectKey: string): string | null {
  if (!ws) return null;
  const repoLabel = labels.find((l) => l.startsWith("repo:"));
  let projRepos: ReturnType<typeof reposOfProject> | null = null;
  if (!repoLabel) {
    try { projRepos = reposOfProject(ws, projectKey); } catch { return null; }
  }
  const ref = repoLabel ? repoLabel.slice(5) : (projRepos!.length === 1 ? projRepos![0]!.ref : null);
  if (!ref) return null;
  return entryGhRepo(ws.file.repos[ref]);
}

async function verbQueue(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, { ...COMMON });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const qargs: Record<string, unknown> = {};
  if (flags["--project"] !== undefined) qargs.project = str(flags, "--project");
  const hub = openHub();
  const result = await runOp(hub, "queue", qargs);
  if (result.status >= 200 && result.status < 300) {
    const body = result.body as Record<string, unknown>;
    const verify = body.verify as Array<{ id: string; labels: string[]; [k: string]: unknown }> | undefined;
    if (verify?.length) {
      const ws = tryResolveWorkspace();
      const ENRICH_TIMEOUT_MS = 15_000;
      const enrichDeadline = Date.now() + ENRICH_TIMEOUT_MS;
      for (const item of verify) {
        const remaining = enrichDeadline - Date.now();
        if (remaining <= 0) { item.landing = "unknown"; continue; }
        const ghRepo = resolveTicketGhRepo(item.labels, ws, hub.projectKey);
        if (!ghRepo) { item.landing = "unknown"; continue; }
        const callTimeout = Math.min(remaining, GH_EXEC_TIMEOUT_MS);
        item.landing = annotateTicketLanding(item.id, ghRepo, makeGhExec({ timeoutMs: callTimeout }));
      }
    }
  }
  return emit("queue", result);
}

async function ticketCreate(targs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(targs, {
    "--title": "v", "--type": "v", "--state": "v", "--description": "v", "--description-file": "v", "--labels": "v",
    "--priority": "v", "--assignee": "v", "--blocked-by": "v", "--related-to": "v", ...COMMON,
  });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const title = str(flags, "--title"); if (!title) fail("ticket create needs --title");
  const type = str(flags, "--type");
  if (!type || !(TYPES as readonly string[]).includes(type)) fail(`ticket create needs --type ${TYPES.join("|")}`);
  const stateFlag = str(flags, "--state");
  if (stateFlag !== undefined && !(STATES as readonly string[]).includes(stateFlag))
    fail(`--state must be one of: ${STATES.join(", ")}`);
  if (flags["--description"] !== undefined && flags["--description-file"] !== undefined) fail("pass --description OR --description-file, not both");
  const descFlag = str(flags, "--description");
  const description = descFlag !== undefined ? (descFlag === "-" ? readStdinAll() : descFlag)
    : flags["--description-file"] !== undefined ? readFileArg("--description-file", str(flags, "--description-file")!) : undefined;
  const args: Record<string, unknown> = { title, type, state: stateFlag ?? "Backlog" };
  if (description !== undefined) args.description = description;
  if (flags["--labels"] !== undefined) args.labels = csv(str(flags, "--labels")!);
  if (flags["--priority"] !== undefined) args.priority = intFlag("--priority", str(flags, "--priority")!, 0, 4);
  if (flags["--assignee"] !== undefined) args.assignee = str(flags, "--assignee");
  if (flags["--related-to"] !== undefined) args.relatedTo = csv(str(flags, "--related-to")!);
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  const blockedBy = flags["--blocked-by"] !== undefined ? csv(str(flags, "--blocked-by")!) : [];
  // LOOP-190 — `--blocked-by` wrote the §9c LEDGER edge and never set the `blocked` ENFORCEMENT
  // label, so the ticket it had just recorded as blocked was fully servable to its dev tier: every
  // serving path filters on the label (servable.ts, opQueue, todoDepth) and none of them reads the
  // marker comment. Twice on this board, both times on staged design children, both caught by hand.
  //
  // The label/marker split itself is DELIBERATE and is preserved — the label stays the enforcement
  // gate and the marker stays the parseable ledger the §9c tracker walks. This is not deriving one
  // from the other; it is the CREATE path writing both halves of the thing it was asked to record.
  if (blockedBy.length) {
    const labels = new Set<string>(Array.isArray(args.labels) ? (args.labels as string[]) : []);
    labels.add("blocked");
    args.labels = [...labels];
  }
  const hub = openHub();
  const r = await runOp(hub, "save_issue", args);
  if (!(r.status >= 200 && r.status < 300) || blockedBy.length === 0) return emit("save_issue", r);
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
  await flushStdout();
  process.exit(0);
}

async function ticketUpdate(targs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(targs, {
    "--state": "v", "--title": "v", "--description": "v", "--description-file": "v",
    "--labels": "v", "--assignee": "v", "--priority": "v",
    "--related-to": "v", "--duplicate-of": "v", "--blocked-by": "v", "--unblocked-by": "v", ...COMMON,
  });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  const id = pos[0];
  if (!id) fail("usage: dev-loop ticket update <id> [--state S] [--title T] [--description TEXT|'-'] [--description-file F] [--labels FULL,SET] [--assignee A] [--priority N] [--related-to +ids] [--duplicate-of ID] [--blocked-by ids] [--unblocked-by ids]");
  if (pos.length > 1) fail(`unexpected argument '${pos[1]}'`);
  if (flags["--description"] !== undefined && flags["--description-file"] !== undefined) fail("pass --description OR --description-file, not both");
  const descFlag = str(flags, "--description");
  const description = descFlag !== undefined ? (descFlag === "-" ? readStdinAll() : descFlag)
    : flags["--description-file"] !== undefined ? readFileArg("--description-file", str(flags, "--description-file")!) : undefined;
  const args: Record<string, unknown> = { id };
  if (flags["--state"] !== undefined) args.state = str(flags, "--state");
  if (flags["--title"] !== undefined) args.title = str(flags, "--title");
  if (description !== undefined) args.description = description;
  if (flags["--labels"] !== undefined) args.labels = csv(str(flags, "--labels")!); // HAZARD: labels REPLACE the full set (re-pass all)
  if (flags["--assignee"] !== undefined) args.assignee = str(flags, "--assignee"); // '' clears, 'me' = you (the op resolves both)
  if (flags["--priority"] !== undefined) args.priority = intFlag("--priority", str(flags, "--priority")!, 0, 4);
  if (flags["--related-to"] !== undefined) args.relatedTo = csv(str(flags, "--related-to")!); // HAZARD: APPEND-ONLY union (§18) — adds, never removes
  if (flags["--duplicate-of"] !== undefined) { const d = str(flags, "--duplicate-of")!; args.duplicateOf = d === "" ? null : d; }
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  // LOOP-287: `--unblocked-by` alone is a legitimate call — retiring an edge is a real update to the
  // §9c ledger even though it writes no ticket FIELD. Excluding it here is what made the flag exit 2.
  if (Object.keys(args).length === 1 + (args.project !== undefined ? 1 : 0)
      && flags["--unblocked-by"] === undefined && flags["--blocked-by"] === undefined)
    fail("nothing to update — pass at least one of --state/--title/--description/--description-file/--labels/--assignee/--priority/--related-to/--duplicate-of/--blocked-by/--unblocked-by");
  if (flags["--blocked-by"] !== undefined && flags["--unblocked-by"] !== undefined)
    fail("pass --blocked-by OR --unblocked-by, not both — one call cannot both open and retire an edge");
  const hub = openHub();
  // Review-admission gate (LOOP-110): refuse In Progress→In Review for pr+autoMerge tickets
  // whose PR is not MERGED. Fail-open on every error path — never a false refusal.
  if (args.state === "In Review") {
    const issueFetch = await runOp(hub, "get_issue", { id });
    let currentState = "", currentLabels: string[] = [];
    if (issueFetch.status === 200) {
      const b = issueFetch.body as { state?: string; labels?: unknown };
      if (typeof b.state === "string") currentState = b.state;
      if (Array.isArray(b.labels)) currentLabels = b.labels as string[];
    }
    const ws = tryResolveWorkspace();
    const result = checkReviewAdmission({
      ticketId: id, currentState, labels: currentLabels,
      workspace: ws, projectKey: hub.projectKey, exec: defaultGhExec,
    });
    if (!result.admitted) { console.error(result.message!); process.exit(1); }
  }
  // LOOP-287 — edge CREATION has had a canonical emitter since §9c shipped (`ticket create
  // --blocked-by` writes `Blocked-by: <id>` per line, correct BY CONSTRUCTION). Edge RETIREMENT had
  // none: every retirement on this board was hand-typed prose through `comment add`, which validates
  // nothing. blocked-by.ts anchors the keyword to the START of a line — deliberately, and asserted:
  // a mention inside a sentence or inside `**bold**` must not bind — so a marker written mid-sentence
  // is silently discarded and the edge stays live. 4 of the 6 retirements ever written were lost that
  // way, leaving dead edges live and their tickets parked.
  //
  // Symmetric with create: the flag emits the marker in the ONE form the parser reads.
  const unblockedBy = flags["--unblocked-by"] !== undefined ? csv(str(flags, "--unblocked-by")!) : [];
  // Edge CREATION on an EXISTING ticket had no verb. `create --blocked-by` writes both halves
  // (LOOP-190) and `update --unblocked-by` retires an edge (LOOP-287), but a block DISCOVERED after
  // the ticket was filed — the ordinary case — could only be recorded by hand: a `comment add` whose
  // marker the parser silently drops if it is not line-anchored, plus a `--labels` call that REPLACES
  // the whole set and quietly loses any label the caller forgot to re-pass.
  //
  // Both failure modes are on the live jinko-browser-use board. JBU-70/72/73 each name A1 (= JBU-69)
  // in their `Depends on` prose and carried neither marker nor label, so all three sat servable at a
  // pick position right behind the ticket they wait on; the next fires would have claimed and bailed.
  // Same shape as LOOP-190, one path over.
  const blockedBy = flags["--blocked-by"] !== undefined ? csv(str(flags, "--blocked-by")!) : [];
  if (blockedBy.length) {
    // The `blocked` label is the ENFORCEMENT half (every serving path filters on it; none reads the
    // marker). When the caller did not pass --labels we must union onto the ticket's CURRENT set —
    // writing `args.labels = ["blocked"]` would replace it. If the read fails we refuse rather than
    // write the marker alone: a ledger edge with no enforcement label is exactly LOOP-190's bug.
    let base: string[];
    if (flags["--labels"] !== undefined) {
      base = args.labels as string[];
    } else {
      const cur = await runOp(hub, "get_issue", { id });
      const curLabels = (cur.body as { labels?: unknown } | undefined)?.labels;
      if (cur.status !== 200 || !Array.isArray(curLabels)) {
        console.error(`ticket update --blocked-by: cannot read ${id}'s current labels (status ${cur.status}) — refusing, because writing the marker without the 'blocked' label leaves the ticket servable`);
        process.exit(1);
      }
      base = curLabels as string[];
    }
    args.labels = [...new Set([...base, "blocked"])];
  }
  const res = await runOp(hub, "save_issue", args);
  const markers = blockedBy.length ? blockedBy.map((b) => `Blocked-by: ${b}`)
    : unblockedBy.map((b) => `Unblocked-by: ${b}`);
  if (!(res.status >= 200 && res.status < 300) || markers.length === 0) return emit("save_issue", res);
  console.log(JSON.stringify(res.body));
  const c = await runOp(hub, "save_comment", {
    issueId: id, body: markers.join("\n"),
    ...(flags["--project"] !== undefined ? { project: str(flags, "--project") } : {}),
  });
  if (c.status < 200 || c.status >= 300) { console.error(JSON.stringify(c.body)); process.exit(1); }
  await flushStdout();
  process.exit(0);
}

async function verbTicket(rest: string[]): Promise<never> {
  const [verb, ...targs] = rest;
  if (verb === "create") return ticketCreate(targs);
  if (verb === "update") return ticketUpdate(targs);
  fail(`usage: dev-loop ticket create|update … (reads stay \`dev-loop ticket <id>\`)`);
}

async function verbComment(rest: string[]): Promise<never> {
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
  return emit("save_comment", await runOp(openHub(), "save_comment", args));
}

async function verbComments(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, COMMON);
  const id = pos[0];
  if (!id) fail("usage: dev-loop comments <id>");
  if (pos.length > 1) fail(`unexpected argument '${pos[1]}'`);
  const args: Record<string, unknown> = { issueId: id };
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("list_comments", await runOp(openHub(), "list_comments", args));
}

async function verbLabels(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, COMMON);
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const args: Record<string, unknown> = {};
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("list_issue_labels", await runOp(openHub(), "list_issue_labels", args));
}

async function verbLabelCreate(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, { "--kind": "v", ...COMMON });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  if (pos[0] !== "create" || !pos[1]) fail("usage: dev-loop label create <name> [--kind K]");
  if (pos.length > 2) fail(`unexpected argument '${pos[2]}'`);
  const args: Record<string, unknown> = { name: pos[1] };
  if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("create_issue_label", await runOp(openHub(), "create_issue_label", args));
}

async function verbProject(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, COMMON);
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const args: Record<string, unknown> = {};
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("get_project", await runOp(openHub(), "get_project", args));
}

async function verbDependencyGraph(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, COMMON);
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const args: Record<string, unknown> = {};
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("dependency_graph", await runOp(openHub(), "dependency_graph", args));
}

async function verbEvents(rest: string[]): Promise<never> {
  const { flags, pos } = parseFlags(rest, { "--ticket": "v", "--actor": "v", "--since": "v", "--limit": "v", ...COMMON });
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const args: Record<string, unknown> = {};
  if (flags["--ticket"] !== undefined) args.ticketId = str(flags, "--ticket");
  if (flags["--actor"] !== undefined) args.actor = str(flags, "--actor");
  if (flags["--since"] !== undefined) args.since = str(flags, "--since");
  if (flags["--limit"] !== undefined) args.limit = intFlag("--limit", str(flags, "--limit")!, 1, 500);
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("list_events", await runOp(openHub(), "list_events", args));
}

async function docList(dargs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(dargs, { "--kind": "v", ...COMMON });
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const args: Record<string, unknown> = {};
  if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("doc.list", await runOp(openHub(), "doc.list", args));
}

async function docGetOrHistory(verb: "get" | "history", dargs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", "--pointer": "v", ...(verb === "get" ? { "--version": "v" } : {}), ...COMMON });
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const pointerVal = str(flags, "--pointer");
  const slugVal = str(flags, "--slug");
  const kindVal = str(flags, "--kind");
  if (!pointerVal && !slugVal && !kindVal) fail(`doc ${verb} needs --slug S or --kind K or --pointer hubDoc:kind/slug`);
  // `--pointer` excludes the pair; `--slug` and `--kind` do NOT exclude each other. Carrying the
  // three-way count forward would have made `doc get --kind design --slug <slug>` — the invocation
  // gen-cheatsheets.ts prints into junior-dev's own cheat-sheet for the Step-4 `Design:` read, and
  // the one this verb has always accepted — an exit-2 usage error. Caught by comparing the two
  // spellings' output (AC3); it is invisible to any test that only exercises --pointer.
  if (pointerVal && (slugVal || kindVal)) fail("--pointer, --slug, and --kind are mutually exclusive");

  const args: Record<string, unknown> = {};
  if (pointerVal) {
    const parsed = parseDocPointer(pointerVal);
    if (!parsed.ok) fail(parsed.message);
    // `parent <id>` is a WELL-FORMED §21a pointer that names a ticket, not a doc — so it gets its own
    // message routing the reader to the verb that can serve it, never the malformed-pointer error.
    // Telling someone their correct pointer is invalid sends them to fix the one thing that is right.
    if (parsed.pointer.form === "parent") fail(`pointer '${pointerVal}' names a ticket, not a hub doc — the parent ticket IS the design (§21a); read it with: dev-loop ticket ${parsed.pointer.parentId}`);
    args.kind = parsed.pointer.kind;
    args.slug = parsed.pointer.slug;
  } else {
    if (slugVal) {
      if (slugVal.includes("/") || slugVal.startsWith("hubDoc:")) {
        fail(`--slug '${slugVal}' looks like a Design: pointer — resolve it as --slug ${slugVal.split("/").pop()} --kind ${slugVal.split("/")[0]}`);
      }
      args.slug = slugVal;
    }
    if (kindVal) args.kind = kindVal;
  }

  const ver = str(flags, "--version");
  if (ver !== undefined) args.version = ver === "latest" ? "latest" : intFlag("--version", ver, 1);
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  const op: AgentOp = verb === "get" ? "doc.get" : "doc.history";
  return emit(op, await runOp(openHub(), op, args));
}

async function docDiff(dargs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", "--from": "v", "--to": "v", ...COMMON });
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  if (flags["--slug"] === undefined && flags["--kind"] === undefined) fail("doc diff needs --slug S or --kind K"); // a selector-less diff is a usage error (exit 2), not a 404 (codex #5)
  if (flags["--from"] === undefined || flags["--to"] === undefined) fail("doc diff needs --from N and --to N");
  const args: Record<string, unknown> = { from: intFlag("--from", str(flags, "--from")!, 1), to: intFlag("--to", str(flags, "--to")!, 1) };
  if (flags["--slug"] !== undefined) args.slug = str(flags, "--slug");
  if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("doc.diff", await runOp(openHub(), "doc.diff", args));
}

async function docSave(dargs: string[]): Promise<never> {
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
  return emit("doc.save", await runOp(openHub(), "doc.save", args)); // a 409 CAS CONFLICT → exit 3, payload on stderr
}

async function docPublish(dargs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--kind": "v", "--version": "v", ...COMMON });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  if (flags["--slug"] === undefined && flags["--kind"] === undefined) fail("doc publish needs --slug S or --kind K"); // usage (exit 2), not a 404 (codex #5)
  if (flags["--version"] === undefined) fail("doc publish needs --version N");
  const args: Record<string, unknown> = { version: intFlag("--version", str(flags, "--version")!, 1) };
  if (flags["--slug"] !== undefined) args.slug = str(flags, "--slug");
  if (flags["--kind"] !== undefined) args.kind = str(flags, "--kind");
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("doc.publish", await runOp(openHub(), "doc.publish", args));
}

async function docArchive(dargs: string[]): Promise<never> {
  // D6: a metadata flip on a retired DESIGN doc (slug-only — design is multi-instance; the op
  // refuses singleton kinds server-side). --restore maps to archived:false; the default archives.
  const { flags, pos } = parseFlags(dargs, { "--slug": "v", "--restore": "b", ...COMMON });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const slug = str(flags, "--slug"); if (!slug) fail("doc archive needs --slug S");
  const args: Record<string, unknown> = { slug };
  if (flags["--restore"] === true) args.archived = false;
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("doc.archive", await runOp(openHub(), "doc.archive", args));
}

async function verbDoc(rest: string[]): Promise<never> {
  const [verb, ...dargs] = rest;
  if (verb === "list") return docList(dargs);
  if (verb === "get" || verb === "history") return docGetOrHistory(verb, dargs);
  if (verb === "diff") return docDiff(dargs);
  if (verb === "save") return docSave(dargs);
  if (verb === "publish") return docPublish(dargs);
  if (verb === "archive") return docArchive(dargs);
  fail("usage: dev-loop doc list|get|history|diff|save|publish|archive …");
}

async function mirrorPush(margs: string[]): Promise<never> {
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
  return emit("mirror.push", await runOp(openHub(), "mirror.push", args));
}

async function mirrorPoll(margs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(margs, { "--token-env": "v", ...COMMON });
  iAmTheOperator = flags["--i-am-the-operator"] === true;
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const tokenEnv = str(flags, "--token-env"); if (!tokenEnv) fail("mirror poll needs --token-env NAME (the env-var NAME, never the secret)");
  const args: Record<string, unknown> = { tokenEnv };
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("mirror.pollComments", await runOp(openHub(), "mirror.pollComments", args));
}

async function mirrorStatus(margs: string[]): Promise<never> {
  const { flags, pos } = parseFlags(margs, COMMON);
  if (pos.length) fail(`unexpected argument '${pos[0]}'`);
  const args: Record<string, unknown> = {};
  if (flags["--project"] !== undefined) args.project = str(flags, "--project");
  return emit("mirror.status", await runOp(openHub(), "mirror.status", args));
}

async function verbMirror(rest: string[]): Promise<never> {
  const [verb, ...margs] = rest;
  if (verb === "push") return mirrorPush(margs);
  if (verb === "poll") return mirrorPoll(margs);
  if (verb === "status") return mirrorStatus(margs);
  fail("usage: dev-loop mirror push|poll|status …");
}

const VERBS: Record<string, VerbHandler> = {
  op: verbOp,            // LAYER 0: the generic dispatcher
  queue: verbQueue,      // LAYER 1: the pre-ranked per-agent work lists (§5/§21b in code)
  dependency_graph: verbDependencyGraph, // LOOP-105: read-only §9c/W5 dependency-graph surface
  ticket: verbTicket,    // create | update (reads stay cli-tickets)
  comment: verbComment,
  comments: verbComments,
  labels: verbLabels,
  label: verbLabelCreate,
  project: verbProject,
  events: verbEvents,
  doc: verbDoc,          // list|get|history|diff|save|publish|archive — doc.* 1:1
  mirror: verbMirror,    // push|poll|status
};

// ─── main ───────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<never> {
  const [sub, ...rest] = process.argv.slice(2); // cli.ts passes the verb as argv[0] (the cli-tickets routing shape)
  // leading --help/-h (e.g. `dev-loop op --help`, `dev-loop doc save --help`) prints the full write-layer
  // usage; checked on the LEADING positions only so a later flag VALUE that happens to be '-h' isn't swallowed.
  if (!sub || sub === "help" || rest.slice(0, 2).some((a) => a === "--help" || a === "-h")) { usage(); await flushStdout(); process.exit(sub ? 0 : 2); }
  const handler = VERBS[sub];
  if (!handler) fail(`unknown verb '${sub}'`);
  return handler(rest);
}

// Guarded (WS-C review 3) because rule-cli.ts imports openHub/runOp from here; every existing spawn
// (`cli.ts` → this file, `node src/cli-agentops.ts` in the tests) still enters main() — argv[1] is this file.
if (isMainEntry(import.meta.url)) await main();
