#!/usr/bin/env node
// `dev-loop settings list|get|set|unset` — the WRITER for the hub `projects.settings_json` row
// (LOOP-479; the LOOP-400 key rides the same path).
//
// Why this exists at all: `settings_json` is the daemon's per-project runtime switchboard. Seven key
// families are READ from it — `humanWrite.enabled` (daemon.ts, the whole human web-write surface),
// `workflow.transitions` (agentops.ts, the DL-24 assignTo directive), `humanBlockedReminderHours` /
// `noProgressWindowHours` / `fireHealth.*` (daemon.ts + daemon-notifiers.ts) — and before this verb
// only TWO could ever be written, each by a bespoke helper that hard-codes one key:
// `team-edit.ts` (`scratch`) and `bundle.ts` (`hub.transport`). Everything else was documented as an
// operator control in prose describing an action the operator could not take: `docs/DAEMON.md` named
// "seed / CLI / git" as the enablement path for `humanWrite`, and none of the three existed.
//
// So the surface here is a PATH writer, not a third bespoke helper — the shape the ticket asked for,
// so the next `settings_json` consumer needs no new command. Two deliberate constraints:
//
//   1. The path must match the ALLOW-LIST below. This is the same discipline as `team set`'s
//      SETTABLE: `settings_json` gates a localhost HTTP *write* surface and the notifier cadences, so
//      an arbitrary-path writer would be a config-injection primitive, not a convenience.
//   2. The two keys that ALREADY have writers are refused by name, pointing at their real owner.
//      `scratch` in particular is a PROJECTION of `projects.<key>.scratch` in dev-loop.json — writing
//      the row directly would desync the file from the row that destructive-guard keys its isolation
//      verdict on.
import { isMainEntry } from "./is-entry.ts";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspace, wsHubDb } from "./workspace.ts";
import { openDb, STATES } from "./db.ts"; // STATES: the one legal-state list, so a directive key is checked against the board's real states
import { findProject } from "./seed.ts";
import { activeFireMarker } from "./destructive-guard.ts"; // LOOP-367/417: the ONE fire-marker list, owned there
import { resolveIdentity } from "./resolve-project.ts";     // §11 DEVLOOP_PROJECT-then-cwd ladder, shared with every hub verb

function die(msg: string, code = 2): never { console.error(`dev-loop settings: ${msg}`); process.exit(code); }

// ── the allow-list ────────────────────────────────────────────────────────────
// `kind` decides how the argv STRING becomes the stored JSON value. `hours`/`count`/`ratio` are
// separate from a bare number because their zero/positivity rules differ and the readers disagree:
// `humanBlockedReminderHours: 0` is the documented OPT-OUT (conventions §3) and MUST round-trip as a
// stored 0 rather than being dropped as falsy, while `fireHealth.minFires: 0` is meaningless.
type SettingKind = "boolean" | "hours" | "count" | "ratio" | "json-object";
// `validate` is the SHAPE check a kind alone cannot express. It exists because this verb's failure mode is
// deferred: a structurally-valid-but-wrong value is stored happily here and only detonates later, in a
// consumer, on a code path the operator will not connect back to this command.
// `restart` marks the keys the daemon reads ONCE at bootstrap (daemon.ts:975-984) and hands to notifier
// timers that never re-read the row. Carried as data so the write itself can say so: an operator who tunes
// a cadence and sees no change would otherwise conclude the command did nothing.
type SettingSpec = { re: RegExp; kind: SettingKind; note: string; validate?: (v: unknown, path: string) => void; restart?: true };

// `workflow.transitions` maps "<From>-><To>" → { assignTo }. Both halves are checked:
//   · the VALUE, because `{"assignTo":true}` parses as a fine JSON object and then reaches actorExists()
//     (agentops.ts:106-116), where node:sqlite refuses a boolean bind parameter — so the directive does not
//     misbehave, it THROWS, and it throws inside the ticket-transition transaction, rolling the move back.
//     A stored setting that makes a legitimate state move fail is worse than a rejected argv.
//   · the KEY, because a misspelled state pair (`"Todo→In Progress"`, `"todo->in progress"`) simply never
//     matches, so the directive silently never fires. That is this ticket's own defect class — a control
//     that reads as configured and does nothing — and refusing it at the writer is the only place it shows.
//     Both HALVES are checked against the real `STATES` list, not just the delimiter: `Todo->Review` has a
//     perfectly good `->` and still never fires, because the consumer does an exact `${from}->${to}` lookup
//     and `Review` is not a state. A delimiter-only check would refuse the typo an operator notices and
//     accept the one they do not.
const TRANSITION_KEY_RE = /^([^>]+)->(.+)$/;
function validateTransitions(v: unknown, path: string): void {
  for (const [k, dir] of Object.entries(v as Record<string, unknown>)) {
    const m = TRANSITION_KEY_RE.exec(k);
    if (!m) die(`${path}: '${k}' is not a "<From>-><To>" transition key (ASCII '->', both states non-empty) — it would never match a transition`);
    for (const [half, state] of [["From", m[1]], ["To", m[2]]] as const) {
      if (!(STATES as readonly string[]).includes(state)) die(`${path}: '${k}' names '${state}' as its ${half} state, which is not a board state — the consumer looks the key up exactly, so this directive would never fire. Legal states: ${STATES.join(", ")}`);
    }
    if (dir === null || typeof dir !== "object" || Array.isArray(dir)) die(`${path}: '${k}' must map to an object like {"assignTo":"owner"}, got ${dir === null ? "null" : Array.isArray(dir) ? "an array" : typeof dir}`);
    const assignTo = (dir as Record<string, unknown>).assignTo;
    if (assignTo !== undefined && assignTo !== null && typeof assignTo !== "string") die(`${path}: '${k}'.assignTo must be a string ("owner", "self", or an actor handle), got ${typeof assignTo}`);
    if (typeof assignTo === "string" && assignTo === "") die(`${path}: '${k}'.assignTo is empty — use "owner", "self", or an actor handle, or omit the key`);
  }
}

export const SETTABLE_SETTINGS: ReadonlyArray<SettingSpec> = [
  // DL-29 — the human web-write surface. Off by default; this is the only switch that opens it.
  { re: /^humanWrite\.enabled$/, kind: "boolean", note: "opt-in human web-write (comment/move/assign/new-ticket/doc forms)" },
  // DL-24 — per-transition assignTo directives, keyed "<From>-><To>" (LOOP-400).
  { re: /^workflow\.transitions$/, kind: "json-object", note: 'DL-24 assignTo directives, e.g. {"In Review->Done":{"assignTo":"owner"}}', validate: validateTransitions },
  // DL-26 / workflows P3 — the Human-Blocked reminder cadence. 0 = explicit opt-out (NOT "absent").
  { re: /^humanBlockedReminderHours$/, kind: "hours", note: "Human-Blocked reminder cadence; 0 = explicit opt-out, absent = 24h when team.comms is set" , restart: true },
  // DL-76 — the loop no-progress circuit-breaker window.
  { re: /^noProgressWindowHours$/, kind: "hours", note: "no-progress circuit-breaker window; 0 = off" , restart: true },
  // P0-1c — the fire-health notifier's tuning block.
  { re: /^fireHealth\.windowHours$/, kind: "hours", note: "fire-health window; 0 = opt out of the notifier" , restart: true },
  { re: /^fireHealth\.minFires$/, kind: "count", note: "minimum fires in the window before fire-health reports" , restart: true },
  { re: /^fireHealth\.threshold$/, kind: "ratio", note: "success-rate floor (0–1) below which fire-health fires" , restart: true },
];
// Keys that are real, read by the product, and OWNED elsewhere. Refused with their owner named, so an
// operator who tries the obvious thing is told where the switch actually lives instead of getting the
// generic "not settable" wall.
const OWNED_ELSEWHERE: ReadonlyArray<{ re: RegExp; owner: string }> = [
  { re: /^scratch$/, owner: "`dev-loop team set projects.<key>.scratch <bool>` — the row is a projection of dev-loop.json, and destructive-guard keys its isolation verdict on it" },
  { re: /^hub\.transport$/, owner: "`dev-loop bundle` / the workspace transport config — flipping it here would point agents at a daemon the config does not describe" },
];

const PLAIN_DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/; // LOOP-245: Number("0x64") === 100 — reject hex/octal/exponent

// argv string → the JSON value to store. Every failure is a hard refusal, never a coercion.
export function parseSettingValue(kind: SettingKind, raw: string, path: string, validate?: (v: unknown, path: string) => void): unknown {
  switch (kind) {
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return die(`${path} takes true|false, got '${raw}'`);
    case "hours": case "count": case "ratio": {
      if (!PLAIN_DECIMAL_RE.test(raw)) return die(`${path} takes a plain decimal number, got '${raw}'`);
      const n = Number(raw);
      if (!Number.isFinite(n)) return die(`${path}: '${raw}' is not a finite number`);
      if (n < 0) return die(`${path} cannot be negative, got ${n}`);
      if (kind === "count" && (n <= 0 || !Number.isInteger(n))) return die(`${path} takes a positive integer, got '${raw}'`);
      if (kind === "ratio" && n > 1) return die(`${path} is a ratio in 0–1, got ${n}`);
      // A ratio of 0 is refused rather than stored, because the reader will not honour it: daemon bootstrap
      // applies the setting only when `Number(fh.threshold) > 0` (daemon.ts:983), so a stored 0 is silently
      // replaced by the 0.5 default on the next restart — the operator would read `settings get` and see a
      // value the running daemon is not using. It is meaningless anyway (a success rate is never below 0,
      // so the notifier could never fire), and the real opt-out already exists and is honoured.
      if (kind === "ratio" && n === 0) return die(`${path} cannot be 0 — the daemon only applies a threshold above 0, so a stored 0 would be silently replaced by the 0.5 default on restart. To switch the fire-health notifier off, use: dev-loop settings set fireHealth.windowHours 0`);
      return n;
    }
    case "json-object": {
      let v: unknown;
      try { v = JSON.parse(raw); }
      catch (e) { return die(`${path} takes a JSON object: ${(e as Error).message}`); }
      if (v === null || typeof v !== "object" || Array.isArray(v)) return die(`${path} takes a JSON OBJECT, got ${Array.isArray(v) ? "an array" : typeof v}`);
      validate?.(v, path);
      return v;
    }
  }
}

// ── the path walk ─────────────────────────────────────────────────────────────
// Deliberately additive: `set` creates only the intermediate objects its own path needs and touches no
// sibling. This is the `syncScratchProjectRow` discipline generalised — the row is read, ONE leaf
// changes, the row is written back whole.
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = root;
  for (const seg of parts.slice(0, -1)) {
    const next = node[seg];
    if (next === undefined || next === null) node[seg] = {};
    else if (typeof next !== "object" || Array.isArray(next)) die(`cannot set ${path}: '${seg}' already holds a ${Array.isArray(next) ? "array" : typeof next}, not an object`);
    node = node[seg] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}
// Remove the leaf, then prune parents the removal just emptied — so `unset fireHealth.windowHours` on
// a block with no other key leaves `{}`, not `{"fireHealth":{}}`. An empty container reads to every
// consumer as "absent" anyway; leaving it behind only makes `settings list` lie about what is set.
export function unsetPath(root: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  const chain: Record<string, unknown>[] = [root];
  for (const seg of parts.slice(0, -1)) {
    const next = chain[chain.length - 1][seg];
    if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) return false;
    chain.push(next as Record<string, unknown>);
  }
  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(chain[chain.length - 1], leaf)) return false;
  delete chain[chain.length - 1][leaf];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length > 0) break;
    delete chain[i - 1][parts[i - 1]];
  }
  return true;
}
export function getPath(root: Record<string, unknown>, path: string): unknown {
  let node: unknown = root;
  for (const seg of path.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

function checkSettable(path: string): SettingSpec {
  const hit = SETTABLE_SETTINGS.find((s) => s.re.test(path));
  if (hit) return hit;
  const owned = OWNED_ELSEWHERE.find((s) => s.re.test(path));
  if (owned) die(`'${path}' is not settable here — it is written by ${owned.owner}`);
  die(`'${path}' is not a settable settings path. Settable:\n${SETTABLE_SETTINGS.map((s) => `  ${s.re.source.replace(/^\^|\$$/g, "").replace(/\\/g, "")}  — ${s.note}`).join("\n")}`);
}

// ── the store ─────────────────────────────────────────────────────────────────
// A malformed settings_json is REFUSED, never silently replaced. The alternative — the fail-open
// `catch { settings = {} }` the bespoke helpers use — would have this verb DESTROY every key an
// operator hand-wrote the moment one of them was unparseable (LOOP-368: a fire may not destroy
// operator data through any verb).
export function readSettings(db: DatabaseSync, key: string): Record<string, unknown> {
  const row = db.prepare("SELECT settings_json FROM projects WHERE key=?").get(key) as { settings_json: string | null } | undefined;
  if (!row) die(`no hub row for project '${key}' — seed it first: dev-loop seed ${key} "<Project Name>" <PREFIX>`, 1);
  // `== null` and NOT a falsy check: the column is NOT NULL but does not forbid the empty string, and `''`
  // is MALFORMED JSON, not "absent". A falsy test would route it to the `{}` default and the next `set`
  // would overwrite it — precisely the data-destruction this function's refusal exists to prevent.
  if (row.settings_json == null) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(row.settings_json); }
  catch (e) { die(`project '${key}' has a malformed settings_json and this verb will not overwrite it (${(e as Error).message}).\n  inspect it: sqlite3 -readonly <workspace>/.dev-loop/hub.db "SELECT settings_json FROM projects WHERE key='${key}';"`, 1); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) die(`project '${key}' has a settings_json that is not a JSON object — refusing to overwrite it`, 1);
  return parsed as Record<string, unknown>;
}
export function writeSettings(db: DatabaseSync, key: string, settings: Record<string, unknown>): void {
  db.prepare("UPDATE projects SET settings_json=? WHERE key=?").run(JSON.stringify(settings), key);
}

// ── the verb ──────────────────────────────────────────────────────────────────
const USAGE = `dev-loop settings — read/write the hub project's runtime switchboard (projects.settings_json)

Usage:
  dev-loop settings list [--project <key>] [--json]
  dev-loop settings get <path> [--project <key>]
  dev-loop settings set <path> <value> [--project <key>]
  dev-loop settings unset <path> [--project <key>]

The project resolves from --project, else $DEVLOOP_PROJECT, else the repo you are standing in.
Writes are ADDITIVE — every other key in the row survives untouched.

WHEN A CHANGE TAKES EFFECT differs by key, so this verb reports it rather than promising one rule:
  humanWrite.enabled, workflow.transitions   take effect immediately — read per request/per write.
  humanBlockedReminderHours, noProgressWindowHours, fireHealth.*
                                             need a daemon restart ('dev-loop hub stop && dev-loop hub
                                             start' — there is no 'hub restart' subcommand): the daemon
                                             reads these ONCE at
                                             bootstrap and passes the numbers into the notifier timers,
                                             which never re-read the row.

Settable paths:
${SETTABLE_SETTINGS.map((s) => `  ${s.re.source.replace(/^\^|\$$/g, "").replace(/\\/g, "")}\n      ${s.note}`).join("\n")}

Examples:
  dev-loop settings set humanWrite.enabled true      # open the board's comment/move/assign forms
  dev-loop settings set humanBlockedReminderHours 0  # explicit opt-out of the reminder
  dev-loop settings set workflow.transitions '{"In Review->Done":{"assignTo":"owner"}}'
  dev-loop settings unset humanWrite.enabled         # back to the off-by-default state`;

// `set`/`unset` MUTATE the switchboard; `list`/`get` only read it. Only the mutators are fire-refused,
// for secret-cli's reason: a read-only diagnostic a fire cannot run is a gate that gets routed around.
const MUTATING_SUBS = new Set(["set", "unset"]);

export function main(argv: string[]): void {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { console.log(USAGE); process.exit(sub ? 0 : 2); }

  // LOOP-479 / LOOP-367's rule: a FIRE may not write this row. `humanWrite.enabled` is the switch that
  // opens the board's HTTP write surface, and `workflow.transitions` re-routes ticket assignment — both
  // are operator controls whose whole documented contract is "never by an agent" (docs/DAEMON.md). A verb
  // that let an agent flip them would make the gate decorative: the party being guarded would hold the key.
  //
  // Placed BEFORE flag parsing, workspace resolution, and the settable-path check deliberately (the
  // secret-cli ordering): no argument order reaches the write, and the refusal cannot be mistaken for
  // "that path is not settable" — an agent must not learn a spelling that would have worked.
  //
  // No bypass flag, for the reason activeFireMarker() states. The suppressor is the ABSENCE of a fire
  // marker: a fire cannot arrange that for itself, the operator console gets it by construction (up.ts
  // clears both markers before exec), and a test gets it from scrubFireEnv().
  if (MUTATING_SUBS.has(sub)) {
    const marker = activeFireMarker();
    if (marker) {
      console.error(`dev-loop settings ${sub}: refusing inside an agent fire (${marker} is set). This verb writes the hub project's operator switchboard — humanWrite.enabled opens the board's HTTP write surface and workflow.transitions re-routes ticket assignment, which docs/DAEMON.md defines as operator-set, never agent-set. Nothing has been read or written. If a setting genuinely needs changing, file it on the board for the operator; to verify this verb, run it from the operator console or in a disposable workspace (mkdtemp + dev-loop team init --dir <tmp>) with the fire markers unset.`);
      process.exit(4);
    }
  }

  const args: string[] = [];
  let projectKey: string | undefined, asJson = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--project") { projectKey = argv[++i]; if (!projectKey) die("--project needs a project key"); }
    else if (argv[i] === "--json") asJson = true;
    else if (argv[i].startsWith("--")) die(`unknown flag '${argv[i]}'\n\n${USAGE}`);
    else args.push(argv[i]);
  }
  // The §11 ladder, not a bare env read: an operator standing in a configured project's repo must not have
  // to pass --project when every other hub verb resolves it from cwd (resolveIdentity — cli-tickets.ts,
  // cli-agentops.ts, shim.ts all share it). An explicit --project still wins over both.
  const key = projectKey ?? (resolveIdentity().projectKey || undefined);
  if (!key) die("no project — pass --project <key>, set DEVLOOP_PROJECT, or run inside a configured project's repo");

  const ws = resolveWorkspace();
  const dbPath = process.env.DEVLOOP_HUB_DB || wsHubDb(ws);
  let db: DatabaseSync;
  try { db = openDb(dbPath); }
  catch (e) { die(`could not open the hub db at ${dbPath} (${(e as Error).message})`, 1); }
  try {
    if (!findProject(db, key)) die(`no hub row for project '${key}' in ${dbPath}`, 1);
    // The read-modify-write is ONE atomic unit, or the verb is a lost-update generator: `settings_json`
    // has three other whole-row writers (team-edit's syncScratchProjectRow, bundle's hub.transport, and a
    // concurrent `settings set`). Read outside the lock and a sibling's key can land between our read and
    // our UPDATE, where our stale copy erases it — breaking the exact guarantee this verb advertises
    // ("every other key survives untouched"). BEGIN IMMEDIATE takes the write lock BEFORE the read, so the
    // row we parse is the row we replace. Failure paths call die() → process.exit, and SQLite rolls an open
    // transaction back when the connection dies, so no partial write can survive a refusal.
    const mutating = MUTATING_SUBS.has(sub);
    if (mutating) db.exec("BEGIN IMMEDIATE");
    const settings = readSettings(db, key);
    switch (sub) {
      case "list": {
        if (asJson) { console.log(JSON.stringify(settings)); break; }
        const keys = Object.keys(settings);
        if (!keys.length) { console.log(`settings_json for '${key}' is empty — nothing is set. See: dev-loop settings --help`); break; }
        console.log(JSON.stringify(settings, null, 2));
        break;
      }
      case "get": {
        if (args.length !== 1) die(`get takes exactly one path\n\n${USAGE}`);
        const v = getPath(settings, args[0]);
        // `undefined` is the ABSENT signal and JSON.stringify renders it as nothing at all, which would
        // be indistinguishable from a stored empty string on stdout. Say "absent" in words.
        console.log(v === undefined ? `absent (${args[0]} is not set for '${key}')` : JSON.stringify(v));
        break;
      }
      case "set": {
        if (args.length !== 2) die(`set takes a path and a value\n\n${USAGE}`);
        const [path, raw] = args;
        const spec = checkSettable(path);
        const value = parseSettingValue(spec.kind, raw, path, spec.validate);
        const before = getPath(settings, path);
        setPath(settings, path, value);
        writeSettings(db, key, settings);
        console.log(`${key}: ${path} = ${JSON.stringify(value)}${before === undefined ? "" : ` (was ${JSON.stringify(before)})`}`);
        if (Object.keys(settings).length > 1) console.log(`  ${Object.keys(settings).length - 1} other settings_json key(s) preserved: ${Object.keys(settings).filter((k) => k !== path.split(".")[0]).join(", ") || "(same block)"}`);
        if (spec.restart) console.log(`  ⚠️  not in effect yet — restart the daemon: dev-loop hub stop && dev-loop hub start. ${path} is read once at bootstrap and the notifier timers never re-read the row.`);
        break;
      }
      case "unset": {
        if (args.length !== 1) die(`unset takes exactly one path\n\n${USAGE}`);
        const spec = checkSettable(args[0]);
        const removed = unsetPath(settings, args[0]);
        if (!removed) { console.log(`${key}: ${args[0]} was already absent — nothing written`); break; }
        writeSettings(db, key, settings);
        console.log(`${key}: ${args[0]} unset`);
        if (spec.restart) console.log(`  ⚠️  not in effect yet — restart the daemon: dev-loop hub stop && dev-loop hub start. ${args[0]} is read once at bootstrap and the notifier timers never re-read the row.`);
        break;
      }
      default: die(`unknown subcommand '${sub}'\n\n${USAGE}`);
    }
    if (mutating) db.exec("COMMIT");
  } catch (e) {
    if (MUTATING_SUBS.has(sub)) { try { db.exec("ROLLBACK"); } catch { /* no transaction open — nothing to undo */ } }
    throw e;
  } finally { db.close(); }
}

if (isMainEntry(import.meta.url)) main(process.argv.slice(2));
