// LOOP-479 — `dev-loop settings`: the writer for the hub `projects.settings_json` switchboard.
//
// The defect this suite pins: seven key families were READ by the daemon and writable by NO command,
// so `docs/DAEMON.md`'s "operator-set via seed / CLI / git" named three paths that did not exist and
// the whole human web-write surface rendered zero forms with no way to turn it on.
//
// Two rules govern how it asserts, both learned the hard way:
//   · Every write goes through the REAL CLI (spawned argv), never `main()` and never a direct
//     `UPDATE projects SET settings_json`. The defect WAS "no command can do this" — a test that
//     writes the row itself would pass on the unfixed tree (AC6 says so explicitly).
//   · Every read-back runs the SHIPPED consumer predicate (`humanWriteEnabled` from daemon.ts,
//     `resolveBlockedReminderHours` from daemon-notifiers.ts), never a local copy of it. A parity
//     assertion whose two sides share a re-implemented predicate is green with the gate deleted
//     (LOOP-429).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { humanWriteEnabled } from "../src/daemon.ts";
import { resolveBlockedReminderHours } from "../src/daemon-notifiers.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(hubRoot, "src", "cli.ts");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "dl-settings-")));
try {
  mkdirSync(join(ROOT, "repo"), { recursive: true });
  mkdirSync(join(ROOT, ".dev-loop"), { recursive: true });
  writeFileSync(join(ROOT, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "sett", backend: "service" },
    repos: { repo: { path: "repo" } },
    projects: { p: { repos: [{ ref: "repo", role: "primary" }] } },
  }));
  const dbPath = join(ROOT, ".dev-loop", "hub.db");
  const seed = openDb(dbPath);
  ensureSeed(seed, "p", "Settings fixture", "SET");
  const projectId = findProject(seed, "p")!;
  // Pre-existing keys, written the way the two bespoke helpers write them. Every later assertion of
  // "additive, never a replacement" is measured against THESE surviving.
  seed.prepare("UPDATE projects SET settings_json=? WHERE key=?")
    .run(JSON.stringify({ scratch: true, hub: { transport: "daemon" } }), "p");
  seed.close();

  // The CLI, as an operator runs it: real argv, cwd inside the fixture workspace, fire markers scrubbed.
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, "settings", ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: dbPath, DEVLOOP_PROJECT: "p" },
  });
  const settingsRow = (): Record<string, unknown> => {
    const db = openDb(dbPath);
    try { return JSON.parse((db.prepare("SELECT settings_json FROM projects WHERE key='p'").get() as { settings_json: string }).settings_json); }
    finally { db.close(); }
  };
  // The shipped gate, run against the same db the CLI just wrote.
  const gateSaysEnabled = (): boolean => {
    const db = openDb(dbPath);
    try { return humanWriteEnabled(db, projectId); } finally { db.close(); }
  };

  // ── AC1/AC3/AC6 — the switch is reachable, and the SHIPPED gate is what flips ────────────────
  ok(!gateSaysEnabled(), "AC3: off by default — the shipped gate reads false before any write");

  const on = run("set", "humanWrite.enabled", "true");
  ok(on.status === 0, `AC1: \`settings set humanWrite.enabled true\` exits 0 (got ${on.status}: ${on.stderr.trim()})`);
  ok(gateSaysEnabled(), "AC1/AC6: …and daemon.ts's own humanWriteEnabled() now returns TRUE — the gate the web forms are behind");

  // Additive, not a replacement — the syncScratchProjectRow discipline, on a row that already had keys.
  const after = settingsRow();
  ok(after.scratch === true && (after.hub as { transport?: string })?.transport === "daemon",
    "AC1: the pre-existing scratch + hub.transport keys SURVIVED the write (additive, never a replacement)");

  const off = run("set", "humanWrite.enabled", "false");
  ok(off.status === 0 && !gateSaysEnabled(), "AC1: …and back to false — the shipped gate returns FALSE again");
  ok(run("unset", "humanWrite.enabled").status === 0 && !gateSaysEnabled(), "AC1: unset removes the key and the gate stays false");
  ok(!("humanWrite" in settingsRow()), "unset prunes the emptied parent block rather than leaving {} behind");

  // ── AC2 — the SAME path writer reaches the other key shapes (PM's three-shape amendment) ─────
  // Shape 2: a nested JSON OBJECT (workflow.transitions — LOOP-400's key, the second instance of
  // this class). AC2 exists so the fix is a path writer, not a second bespoke helper.
  const tr = run("set", "workflow.transitions", '{"In Review->Done":{"assignTo":"owner"}}');
  const stored = (settingsRow().workflow as { transitions?: Record<string, { assignTo?: string }> })?.transitions;
  ok(tr.status === 0 && stored?.["In Review->Done"]?.assignTo === "owner",
    "AC2: workflow.transitions (LOOP-400) round-trips as a nested object through the same writer");

  // Shape 3: a scalar whose 0 is MEANINGFUL. conventions §3 documents `0` as the explicit opt-out, so
  // a writer that dropped it as falsy would store nothing and silently re-enable the 24h reminder.
  const zero = run("set", "humanBlockedReminderHours", "0");
  const row3 = settingsRow();
  ok(zero.status === 0 && row3.humanBlockedReminderHours === 0,
    "AC2: humanBlockedReminderHours=0 is STORED as 0, not dropped as falsy");
  ok(resolveBlockedReminderHours(row3, /* commsConfigured */ true) === 0,
    "AC2: …and the shipped resolveBlockedReminderHours() reads it as the opt-out even with comms configured — the documented opt-out is now exercisable");
  ok(resolveBlockedReminderHours({}, true) === 24,
    "AC2 control: absent still means the 24h comms-aware default — 0 and absent stay DISTINGUISHABLE");
  ok(settingsRow().scratch === true, "AC1: scratch still survives after four more writes");

  // ── refusals — the allow-list is the point, not a formality ──────────────────────────────────
  const unknown = run("set", "humanWrite.enabledd", "true");
  ok(unknown.status !== 0 && /not a settable settings path/.test(unknown.stderr), "refuses an unknown path and prints the settable list");
  const owned = run("set", "scratch", "false");
  ok(owned.status !== 0 && /team set projects/.test(owned.stderr), "refuses `scratch` by NAME, pointing at its real writer (the row is a projection of dev-loop.json)");
  ok(settingsRow().scratch === true, "…and the refused write did not touch the row");
  ok(run("set", "hub.transport", "stdio").status !== 0, "refuses hub.transport — owned by bundle/workspace transport config");
  ok(run("set", "humanWrite.enabled", "yes").status !== 0, "refuses a non-boolean for a boolean path (no truthiness coercion)");
  // LOOP-245: Number("0x18") === 24 — a hex value must not silently become a cadence.
  ok(run("set", "humanBlockedReminderHours", "0x18").status !== 0, "refuses hex for a numeric path (LOOP-245)");
  ok(run("set", "humanBlockedReminderHours", "-1").status !== 0, "refuses a negative cadence");
  ok(run("set", "fireHealth.threshold", "2").status !== 0, "refuses a ratio above 1");
  ok(run("set", "fireHealth.minFires", "1.5").status !== 0, "refuses a non-integer count");
  ok(run("set", "workflow.transitions", "[1,2]").status !== 0, "refuses an ARRAY where a JSON object is required");
  ok(run("set", "workflow.transitions", "{oops").status !== 0, "refuses unparseable JSON");

  // ── get / list ────────────────────────────────────────────────────────────────────────────────
  ok(/^absent /.test(run("get", "humanWrite.enabled").stdout), "get says 'absent' in words for an unset path (JSON.stringify(undefined) would print nothing)");
  const listed = run("list", "--json");
  ok(listed.status === 0 && JSON.parse(listed.stdout).scratch === true, "list --json emits the whole row");

  // ── a malformed row is REFUSED, never silently replaced (LOOP-368) ───────────────────────────
  const bad = openDb(dbPath);
  bad.prepare("UPDATE projects SET settings_json='{not json' WHERE key='p'").run();
  bad.close();
  const onBad = run("set", "humanWrite.enabled", "true");
  ok(onBad.status !== 0 && /malformed settings_json/.test(onBad.stderr), "a malformed settings_json is REFUSED with an inspect hint — the verb never overwrites operator data it could not read");
  const raw = openDb(dbPath);
  const stillBad = (raw.prepare("SELECT settings_json FROM projects WHERE key='p'").get() as { settings_json: string }).settings_json;
  raw.close();
  ok(stillBad === "{not json", "…and the unreadable row is left byte-identical, not clobbered");

  // ── AC4 — discoverability ────────────────────────────────────────────────────────────────────
  const help = run("--help");
  ok(help.status === 0 && /humanWrite\.enabled/.test(help.stdout) && /workflow\.transitions/.test(help.stdout),
    "AC4: `settings --help` names the settable paths");
  const top = spawnSync(process.execPath, [CLI, "--help"], { cwd: ROOT, encoding: "utf8", env: scrubFireEnv() });
  ok(/^\s+settings list\|get\|set\|unset/m.test(top.stdout), "AC4: the top-level `dev-loop --help` lists the verb");
} finally {
  console.log(fails ? `\n${fails} check(s) failed` : "\nall settings-cli checks passed");
  process.exit(fails ? 1 : 0);
}
