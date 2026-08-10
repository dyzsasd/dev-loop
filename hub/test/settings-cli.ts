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
import { openDb, actorExists } from "../src/db.ts"; // actorExists: the SHIPPED handle predicate resolveAssignTo uses — the roster arms assert against it, never a local list
import { ensureSeed, findProject } from "../src/seed.ts";
import { humanWriteEnabled } from "../src/daemon.ts";
import { resolveBlockedReminderHours, noProgressNotifyTick } from "../src/daemon-notifiers.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture
import { restartHint } from "../src/settings-cli.ts"; // the SHIPPED hint builder, never a local copy (LOOP-429)
import { TEAM_INTAKE_PROJECT } from "../src/team-config.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(hubRoot, "src", "cli.ts");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "dl-settings-")));
const SELF = fileURLToPath(import.meta.url);

// NOT `try { … } finally { process.exit(…) }`. That shape swallows every unexpected exception: control
// enters the finally, `process.exit` runs while `fails` is still 0 because no `ok()` ever recorded one,
// and run-all.ts reads exit 0 as a pass for a suite whose remaining assertions never executed. A bare
// block keeps the scope (and this file's indentation) while letting a throw propagate — node then exits
// non-zero and prints the stack. The exit status is taken AFTER the block completes normally.
{
  // The fault the harness self-test at the bottom injects. It must be thrown from INSIDE this block,
  // where a real unexpected exception happens (a failed JSON.parse of an empty stdout, a spawn that did
  // not run) — a throw sited above the block escapes any `finally` and would exit non-zero under BOTH
  // harness shapes, making the assertion unable to tell them apart. Mutation-tested: restoring the
  // finally-block exit with this line above the block leaves the suite green.
  if (process.env.DL_SETTINGS_SELFTEST_THROW) throw new Error("injected fault — harness self-test (LOOP-479)");
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

  // The EMPTY STRING is the same class and the easier one to get wrong: the column is NOT NULL but does not
  // forbid '', and a falsy `!row.settings_json` check reads it as "absent" and routes it to the {} default —
  // so the next `set` would overwrite a row the verb had promised to refuse. Only null may mean absent.
  const empty = openDb(dbPath);
  empty.prepare("UPDATE projects SET settings_json='' WHERE key='p'").run();
  empty.close();
  const onEmpty = run("set", "humanWrite.enabled", "true");
  ok(onEmpty.status !== 0 && /malformed settings_json/.test(onEmpty.stderr),
    `an EMPTY settings_json is malformed JSON, not "absent" — it is refused too (got ${onEmpty.status})`);
  const rawEmpty = openDb(dbPath);
  const stillEmpty = (rawEmpty.prepare("SELECT settings_json FROM projects WHERE key='p'").get() as { settings_json: string }).settings_json;
  rawEmpty.close();
  ok(stillEmpty === "", "…and that row is left untouched as well, not replaced with a fresh object");

  // Restore a readable row so the assertions below measure the verb, not the refusal above.
  const restore = openDb(dbPath);
  restore.prepare("UPDATE projects SET settings_json=? WHERE key=?").run(JSON.stringify({ scratch: true, hub: { transport: "daemon" } }), "p");
  restore.close();

  // ── The fire gate (LOOP-367's rule applied to this verb) ─────────────────────────────────────
  // `humanWrite.enabled` opens the board's HTTP write surface and `workflow.transitions` re-routes ticket
  // assignment; docs/DAEMON.md defines both as operator-set, "never by an agent". A writer an agent fire
  // could run would hand the key to the party being guarded, so `set`/`unset` refuse with a marker present.
  // Asserted through the REAL argv with a REAL marker — the same route an agent would take.
  const runInFire = (marker: string, ...args: string[]) => spawnSync(process.execPath, [CLI, "settings", ...args], {
    cwd: ROOT, encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: dbPath, DEVLOOP_PROJECT: "p", [marker]: "true" },
  });
  run("unset", "humanWrite.enabled"); // known-off starting point, written by the operator path
  const beforeFire = JSON.stringify(settingsRow());
  for (const marker of ["DEVLOOP_DEV_SPLIT", "DEVLOOP_TEAM_SCOPE"]) {
    const blocked = runInFire(marker, "set", "humanWrite.enabled", "true");
    ok(blocked.status === 4, `fire gate: \`set humanWrite.enabled true\` under ${marker} exits 4 (got ${blocked.status})`);
    ok(/refusing inside an agent fire/.test(blocked.stderr), `fire gate: …and says why, naming ${marker} (stderr: ${blocked.stderr.trim().slice(0, 80)})`);
    ok(!gateSaysEnabled(), `fire gate: …and the shipped humanWriteEnabled() gate is STILL false after the ${marker} attempt`);
    ok(runInFire(marker, "unset", "humanBlockedReminderHours").status === 4, `fire gate: \`unset\` is refused under ${marker} too, not just \`set\``);
  }
  ok(JSON.stringify(settingsRow()) === beforeFire, "fire gate: the settings_json row is byte-identical after every refused attempt — nothing was written");
  // Reads stay open inside a fire, deliberately: a diagnostic an agent cannot run is a gate that gets
  // routed around (the secret-cli rationale). These two MUST NOT start failing.
  ok(runInFire("DEVLOOP_DEV_SPLIT", "list", "--json").status === 0, "fire gate: `list` still works inside a fire — read-only, never gated");
  ok(runInFire("DEVLOOP_DEV_SPLIT", "get", "humanWrite.enabled").status === 0, "fire gate: `get` still works inside a fire — read-only, never gated");

  // ── Shape validation: values the writer accepts but a consumer cannot honour ──────────────────
  // `{"assignTo":true}` is valid JSON and a valid object; it detonates later in actorExists(), where
  // node:sqlite rejects a boolean bind and the whole ticket transition rolls back.
  const badDirective = run("set", "workflow.transitions", '{"Todo->In Progress":{"assignTo":true}}');
  ok(badDirective.status === 2 && /assignTo must be a string/.test(badDirective.stderr),
    `transitions: a boolean assignTo is refused at the writer, not stored to crash a later transition (got ${badDirective.status})`);
  const badKey = run("set", "workflow.transitions", '{"Todo=>In Progress":{"assignTo":"owner"}}');
  ok(badKey.status === 2 && /transition key/.test(badKey.stderr),
    "transitions: a key that is not \"<From>-><To>\" is refused — it would never match, so it would silently never fire");
  // The delimiter is the typo an operator NOTICES. These are the ones they don't: a well-formed key naming
  // a state that does not exist. The consumer looks the key up exactly, so it is just as inert.
  const badTo = run("set", "workflow.transitions", '{"Todo->Review":{"assignTo":"owner"}}');
  ok(badTo.status === 2 && /not a board state/.test(badTo.stderr),
    `transitions: a well-formed key naming a nonexistent To state is refused (got ${badTo.status})`);
  const badFrom = run("set", "workflow.transitions", '{"todo->In Review":{"assignTo":"owner"}}');
  ok(badFrom.status === 2 && /not a board state/.test(badFrom.stderr),
    "transitions: …and a miscased From state too — the check is both halves, against db.ts's STATES");
  ok(/Legal states:/.test(badTo.stderr), "transitions: …and the refusal prints the legal state list, so the operator can correct it without reading the source");
  // The last key shape that survives BOTH checks above: two real states, correct delimiter, and still
  // permanently inert. agentops.ts:366 reaches the directive lookup only inside `next.state !== cur.state`,
  // so a self-transition can never fire — as inert as `Todo->Review`, and harder for the operator to spot.
  const selfTransition = run("set", "workflow.transitions", '{"Todo->Todo":{"assignTo":"owner"}}');
  ok(selfTransition.status === 2 && /self-transition/.test(selfTransition.stderr),
    `transitions: a self-transition is refused — both halves name real states and the rule still could never fire (got ${selfTransition.status})`);
  const goodDirective = run("set", "workflow.transitions", '{"In Review->Done":{"assignTo":"owner"}}');
  ok(goodDirective.status === 0, `transitions: the valid directive is still accepted (got ${goodDirective.status}: ${goodDirective.stderr.trim()})`);
  ok(((settingsRow().workflow as { transitions?: Record<string, unknown> })?.transitions ?? {})["In Review->Done"] !== undefined,
    "transitions: …and it is stored under the workflow block");

  // ── The VALUE's last inert shape: a handle no actor answers to ────────────────────────────────
  // Every check above passes for `{"assignTo":"senor-dev"}` — nonempty string, real states, real
  // delimiter — and the consumer still assigns nobody: resolveAssignTo misses on actorExists() and
  // returns null. The two arms below are anchored to the SHIPPED predicate rather than to this file's
  // opinion of who exists, so the writer's verdict is asserted to agree with the consumer's, and a
  // roster change moves both sides at once.
  const consumerAccepts = (handle: string): boolean => {
    const db = openDb(dbPath);
    try { return actorExists(db, handle); } finally { db.close(); }
  };
  ok(consumerAccepts("senior-dev") && !consumerAccepts("senor-dev"),
    "transitions: (premise) the consumer's own actorExists() accepts 'senior-dev' and rejects the typo — the two arms below assert against ITS answer, not a hard-coded roster");
  const unknownHandle = run("set", "workflow.transitions", '{"Todo->In Progress":{"assignTo":"senor-dev"}}');
  ok(unknownHandle.status === 2 && /not an active actor/.test(unknownHandle.stderr),
    `transitions: a misspelled actor handle is refused — it would be stored, reported as set, and never assign anyone (got ${unknownHandle.status})`);
  ok(/senior-dev/.test(unknownHandle.stderr),
    "transitions: …and the refusal prints the live roster read from the db, so the operator can correct the typo without guessing");
  // The discrimination arm. Without it a validator that refused EVERY non-keyword handle — killing the
  // entire third form the directive supports — passes the assertion above. Mutation-tested: dropping
  // ASSIGN_TO_KEYWORDS' exemption or refusing all handles fails here.
  const realHandle = run("set", "workflow.transitions", '{"Todo->In Progress":{"assignTo":"senior-dev"}}');
  ok(realHandle.status === 0, `transitions: a REAL actor handle is still accepted (got ${realHandle.status}: ${realHandle.stderr.trim()})`);
  ok(((settingsRow().workflow as { transitions?: Record<string, { assignTo?: string }> })?.transitions ?? {})["Todo->In Progress"]?.assignTo === "senior-dev",
    "transitions: …and it is stored — the roster check narrows the third form, it does not remove it");
  const selfKeyword = run("set", "workflow.transitions", '{"Todo->In Progress":{"assignTo":"self"}}');
  ok(selfKeyword.status === 0, `transitions: "self" is a directive keyword, not a handle, and is not roster-checked (got ${selfKeyword.status}: ${selfKeyword.stderr.trim()})`);

  // ── The hours ceiling: a stored window the consumer's date arithmetic cannot represent ────────
  // Same class as everything above, one layer further out. `noProgressWindowHours` is multiplied by
  // 3,600,000 and reaches `new Date(nowMs - windowMs).toISOString()`, which THROWS past the ±8.64e15 ms
  // Date range. The throw is caught by the tick's `.catch` and retried, so the accepted setting does not
  // fail loudly — it disables the detector it was meant to configure, one log line per hour.
  const hugeHours = 3_000_000_000;
  const tooBig = run("set", "noProgressWindowHours", String(hugeHours));
  ok(tooBig.status === 2 && /cannot exceed 87600 hours/.test(tooBig.stderr),
    `hours: a window past the ceiling is refused at the writer (got ${tooBig.status}: ${tooBig.stderr.trim().slice(0, 90)})`);
  ok(/settings set noProgressWindowHours 0/.test(tooBig.stderr),
    "hours: …and the refusal names the opt-out that every reader DOES honour, so 'switch it off' has a real spelling");
  ok(run("set", "noProgressWindowHours", "87600").status === 0, "hours: the ceiling itself is accepted — the bound is inclusive, not off by one");
  ok(run("set", "noProgressWindowHours", "87601").status === 2, "hours: …and one hour past it is not");
  ok(run("set", "noProgressWindowHours", "0").status === 0, "hours: 0 (the documented opt-out) is still accepted");
  ok(run("set", "humanBlockedReminderHours", String(hugeHours)).status === 2 && run("set", "fireHealth.windowHours", String(hugeHours)).status === 2,
    "hours: the ceiling is a property of the KIND, not of one key — every hours setting feeds the same ms arithmetic");
  // The decisive half: the refused value is one the SHIPPED consumer cannot process. Run the real tick
  // (never a local copy of its arithmetic — LOOP-429) with the window the writer just rejected, and with
  // one it accepts. A `notify` target is required only because resolveTarget() short-circuits before the
  // date math; the throw lands on the sinceIso line, so no request is ever made.
  {
    const consumerDb = openDb(dbPath);
    const notify = { type: "slack", webhook: "http://127.0.0.1:1/never-reached" };
    const tick = (hours: number) => noProgressNotifyTick({
      writeDb: consumerDb, projectId, projectKey: "p", baseUrl: "http://127.0.0.1:8787",
      windowMs: hours * 3_600_000, nowMs: Date.now(), notify,
      fetchImpl: (async () => ({ ok: true, status: 200, text: async () => "ok" })) as unknown as Parameters<typeof noProgressNotifyTick>[0]["fetchImpl"],
    });
    let threw = "";
    await tick(hugeHours).catch((e: unknown) => { threw = String((e as Error)?.name ?? e); });
    ok(threw === "RangeError",
      `hours: the shipped no-progress tick THROWS a ${threw || "(nothing)"} on the window the writer refuses — the ceiling tracks a real consumer limit, not a taste call`);
    let acceptedThrew = "";
    await tick(87_600).catch((e: unknown) => { acceptedThrew = String((e as Error)?.name ?? e); });
    ok(acceptedThrew === "", `hours: …and the largest window the writer ACCEPTS runs clean through the same tick (got ${acceptedThrew})`);
    consumerDb.close();
  }

  // A ratio of 0 is refused because daemon.ts:983 applies the setting only when > 0 — storing it would show
  // the operator a value the running daemon silently replaces with the 0.5 default.
  const zeroThreshold = run("set", "fireHealth.threshold", "0");
  ok(zeroThreshold.status === 2 && /windowHours 0/.test(zeroThreshold.stderr),
    `fireHealth.threshold 0 is refused and names the opt-out the daemon DOES honour (got ${zeroThreshold.status})`);
  ok(run("set", "fireHealth.threshold", "0.25").status === 0, "…while a real threshold in (0,1] is still accepted");
  // The cadence keys are read once at daemon bootstrap, so the write says so at the point of use.
  // The hint must name a RUNNABLE command. `dev-loop hub restart` does not exist (hub.ts accepts
  // start|stop|status|ensure), and printing an unrunnable procedure is this ticket's own defect class —
  // the reason it was filed was a doc naming three enablement paths that did not exist.
  const cadenceOut = run("set", "humanBlockedReminderHours", "6").stdout;
  ok(/restart the daemon: DEVLOOP_PROJECT=p dev-loop daemon down && DEVLOOP_PROJECT=p dev-loop daemon up/.test(cadenceOut),
    "a restart-required key prints the restart hint on write (the daemon never re-reads the row)");
  ok(!/hub restart\b/.test(cadenceOut),
    "…and the hint does NOT name `hub restart`, which is not a subcommand — an unrunnable hint is the defect this ticket exists to remove");
  // `p` is a DELIVERY project, and `hub start|stop` dies on one (hub.ts:78-86) pointing at `daemon
  // up`/`down`. So the hub form here would be the same defect class as `hub restart`: well-formed,
  // discoverable, and refused when run. The hint is derived from the resolved key, so assert the wrong
  // branch is absent as well as the right one present — otherwise printing BOTH would pass.
  ok(!/hub stop && dev-loop hub start/.test(cadenceOut),
    "…and it does NOT print the `hub stop && hub start` form, which REFUSES a delivery project — the hint must follow the project whose row was written");
  ok(restartHint("p") !== restartHint(TEAM_INTAKE_PROJECT) && /dev-loop hub stop/.test(restartHint(TEAM_INTAKE_PROJECT)),
    "…and the _team workspace hub still gets the `hub` form — the two lifecycles are distinct verbs, not one command with a preferred spelling");
  // …and BOTH forms carry their own DEVLOOP_PROJECT. `--project` selects the row to write but does not
  // rewrite the environment, while hubCmd refuses start/stop on the AMBIENT value (`hub.ts:74-78`) — so
  // a bare `dev-loop hub stop` printed under `DEVLOOP_PROJECT=<delivery> … --project _team` dies in the
  // very shell it was handed to. A hint that is runnable only when the environment already agrees is
  // the same unrunnable-instruction defect this ticket exists to remove.
  for (const key of ["p", TEAM_INTAKE_PROJECT]) {
    const h = restartHint(key);
    ok(h.split("&&").every((cmd) => /DEVLOOP_PROJECT=/.test(cmd)),
      `restart hint for '${key}': every command carries its own DEVLOOP_PROJECT — self-contained, not true-only-if-the-env-agrees (${h.slice(0, 72)}…)`);
  }
  ok(restartHint(TEAM_INTAKE_PROJECT).includes(`DEVLOOP_PROJECT=${TEAM_INTAKE_PROJECT}`),
    "…and the _team hint names _team explicitly, so it overrides an inherited delivery-project value rather than inheriting it");
  ok(!/restart the daemon/.test(run("set", "humanWrite.enabled", "true").stdout),
    "…and a per-request key prints no restart hint at all — the hint distinguishes the two, it is not boilerplate");
  run("unset", "humanWrite.enabled");

  // ── The project ladder: --project, else DEVLOOP_PROJECT, else cwd (§11) ───────────────────────
  const fromCwd = spawnSync(process.execPath, [CLI, "settings", "list", "--json"], {
    cwd: join(ROOT, "repo"), encoding: "utf8", env: { ...scrubFireEnv(), DEVLOOP_HUB_DB: dbPath, DEVLOOP_WORKSPACE: ROOT },
  });
  ok(fromCwd.status === 0, `project ladder: with no DEVLOOP_PROJECT, standing in the project's repo resolves it (got ${fromCwd.status}: ${fromCwd.stderr.trim()})`);

  // ── AC4 — discoverability ────────────────────────────────────────────────────────────────────
  const help = run("--help");
  ok(help.status === 0 && /humanWrite\.enabled/.test(help.stdout) && /workflow\.transitions/.test(help.stdout),
    "AC4: `settings --help` names the settable paths");
  const top = spawnSync(process.execPath, [CLI, "--help"], { cwd: ROOT, encoding: "utf8", env: scrubFireEnv() });
  ok(/^\s+settings list\|get\|set\|unset/m.test(top.stdout), "AC4: the top-level `dev-loop --help` lists the verb");
  ok(!/hub stop && (dev-loop )?hub start/.test(top.stdout),
    "…and the top-level help no longer prescribes `hub stop && hub start`, which refuses a delivery project");

  // ── The harness's own exit path ──────────────────────────────────────────────────────────────
  // Asserted by re-running THIS file with the fault injected, not by re-creating the harness shape in
  // a fixture: a copy would be the LOOP-429 defect — a parity assertion whose two sides share a
  // re-implementation stays green with the real thing broken. The child throws at the top, so it never
  // reaches this spawn and cannot recurse.
  const selfTest = spawnSync(process.execPath, [SELF], {
    cwd: ROOT, encoding: "utf8", env: { ...scrubFireEnv(), DL_SETTINGS_SELFTEST_THROW: "1" },
  });
  ok(selfTest.status !== 0,
    `harness: an unexpected exception FAILS the suite (got exit ${selfTest.status}) — a finally-block process.exit would swallow it and report a pass for assertions that never ran`);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall settings-cli checks passed");
process.exit(fails ? 1 : 0);
