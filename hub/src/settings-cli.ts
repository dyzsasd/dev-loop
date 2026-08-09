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
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop settings: ${msg}`); process.exit(code); }

// ── the allow-list ────────────────────────────────────────────────────────────
// `kind` decides how the argv STRING becomes the stored JSON value. `hours`/`count`/`ratio` are
// separate from a bare number because their zero/positivity rules differ and the readers disagree:
// `humanBlockedReminderHours: 0` is the documented OPT-OUT (conventions §3) and MUST round-trip as a
// stored 0 rather than being dropped as falsy, while `fireHealth.minFires: 0` is meaningless.
type SettingKind = "boolean" | "hours" | "count" | "ratio" | "json-object";
export const SETTABLE_SETTINGS: ReadonlyArray<{ re: RegExp; kind: SettingKind; note: string }> = [
  // DL-29 — the human web-write surface. Off by default; this is the only switch that opens it.
  { re: /^humanWrite\.enabled$/, kind: "boolean", note: "opt-in human web-write (comment/move/assign/new-ticket/doc forms)" },
  // DL-24 — per-transition assignTo directives, keyed "<From>-><To>" (LOOP-400).
  { re: /^workflow\.transitions$/, kind: "json-object", note: 'DL-24 assignTo directives, e.g. {"In Review->Done":{"assignTo":"owner"}}' },
  // DL-26 / workflows P3 — the Human-Blocked reminder cadence. 0 = explicit opt-out (NOT "absent").
  { re: /^humanBlockedReminderHours$/, kind: "hours", note: "Human-Blocked reminder cadence; 0 = explicit opt-out, absent = 24h when team.comms is set" },
  // DL-76 — the loop no-progress circuit-breaker window.
  { re: /^noProgressWindowHours$/, kind: "hours", note: "no-progress circuit-breaker window; 0 = off" },
  // P0-1c — the fire-health notifier's tuning block.
  { re: /^fireHealth\.windowHours$/, kind: "hours", note: "fire-health window; 0 = opt out of the notifier" },
  { re: /^fireHealth\.minFires$/, kind: "count", note: "minimum fires in the window before fire-health reports" },
  { re: /^fireHealth\.threshold$/, kind: "ratio", note: "success-rate floor (0–1) below which fire-health fires" },
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
export function parseSettingValue(kind: SettingKind, raw: string, path: string): unknown {
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
      return n;
    }
    case "json-object": {
      let v: unknown;
      try { v = JSON.parse(raw); }
      catch (e) { return die(`${path} takes a JSON object: ${(e as Error).message}`); }
      if (v === null || typeof v !== "object" || Array.isArray(v)) return die(`${path} takes a JSON OBJECT, got ${Array.isArray(v) ? "an array" : typeof v}`);
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

function checkSettable(path: string): SettingKind {
  const hit = SETTABLE_SETTINGS.find((s) => s.re.test(path));
  if (hit) return hit.kind;
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
  if (!row.settings_json) return {};
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

The project defaults to $DEVLOOP_PROJECT; pass --project to name it explicitly.
Writes are ADDITIVE — every other key in the row survives untouched.
The daemon re-reads settings_json per request, so a flip takes effect with NO restart.

Settable paths:
${SETTABLE_SETTINGS.map((s) => `  ${s.re.source.replace(/^\^|\$$/g, "").replace(/\\/g, "")}\n      ${s.note}`).join("\n")}

Examples:
  dev-loop settings set humanWrite.enabled true      # open the board's comment/move/assign forms
  dev-loop settings set humanBlockedReminderHours 0  # explicit opt-out of the reminder
  dev-loop settings set workflow.transitions '{"In Review->Done":{"assignTo":"owner"}}'
  dev-loop settings unset humanWrite.enabled         # back to the off-by-default state`;

export function main(argv: string[]): void {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { console.log(USAGE); process.exit(sub ? 0 : 2); }

  const args: string[] = [];
  let projectKey: string | undefined, asJson = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--project") { projectKey = argv[++i]; if (!projectKey) die("--project needs a project key"); }
    else if (argv[i] === "--json") asJson = true;
    else if (argv[i].startsWith("--")) die(`unknown flag '${argv[i]}'\n\n${USAGE}`);
    else args.push(argv[i]);
  }
  const key = projectKey ?? process.env.DEVLOOP_PROJECT;
  if (!key) die("no project — pass --project <key> or set DEVLOOP_PROJECT");

  const ws = resolveWorkspace();
  const dbPath = process.env.DEVLOOP_HUB_DB || wsHubDb(ws);
  let db: DatabaseSync;
  try { db = openDb(dbPath); }
  catch (e) { die(`could not open the hub db at ${dbPath} (${(e as Error).message})`, 1); }
  try {
    if (!findProject(db, key)) die(`no hub row for project '${key}' in ${dbPath}`, 1);
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
        const kind = checkSettable(path);
        const value = parseSettingValue(kind, raw, path);
        const before = getPath(settings, path);
        setPath(settings, path, value);
        writeSettings(db, key, settings);
        console.log(`${key}: ${path} = ${JSON.stringify(value)}${before === undefined ? "" : ` (was ${JSON.stringify(before)})`}`);
        if (Object.keys(settings).length > 1) console.log(`  ${Object.keys(settings).length - 1} other settings_json key(s) preserved: ${Object.keys(settings).filter((k) => k !== path.split(".")[0]).join(", ") || "(same block)"}`);
        break;
      }
      case "unset": {
        if (args.length !== 1) die(`unset takes exactly one path\n\n${USAGE}`);
        checkSettable(args[0]);
        const removed = unsetPath(settings, args[0]);
        if (!removed) { console.log(`${key}: ${args[0]} was already absent — nothing written`); break; }
        writeSettings(db, key, settings);
        console.log(`${key}: ${args[0]} unset`);
        break;
      }
      default: die(`unknown subcommand '${sub}'\n\n${USAGE}`);
    }
  } finally { db.close(); }
}

if (isMainEntry(import.meta.url)) main(process.argv.slice(2));
