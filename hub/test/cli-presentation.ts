// The CLI's PRESENTATION contract — four defects that all reached the operator as noise or as a
// crash on surfaces the docs teach as the way to use this tool. Every check spawns the real CLI:
// the fixes live in cli.ts's spawn line + cli-bootstrap.ts, so nothing here can be proven by import.
//
//   LOOP-44  — every verb opened with node's "SQLite is an experimental feature" on stderr, so the
//              documented agent contract ("errors as JSON on stderr") was false on every SUCCESS.
//   LOOP-283 — six verbs answered "you are not in a workspace" with a 6-frame stack dump.
//   LOOP-284 — `doctor` alone did the opposite: DOCTOR_OK + exit 0 over an unrelated board.
//   LOOP-154 — `--help` was a daemon-spawn vector on two verbs.
//   LOOP-248 — a restart hint that omits DEVLOOP_PROJECT can restart the WRONG project's daemon.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(hubRoot, "src", "cli.ts");
let fails = 0;
const ok = (c: boolean, m: string): void => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-cli-pres-")));
// A directory with NO workspace above it, and a HOME of its own so the global-db fallback can never
// touch the operator's real board. DEVLOOP_WORKSPACE in particular must be scrubbed: workspace
// resolution prefers it over the cwd walk-up, which would make "workspace-less" a lie (LOOP-156).
const bare = join(tmp, "bare"); mkdirSync(bare, { recursive: true });
const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra } as NodeJS.ProcessEnv);

const cli = (args: string[], cwd = bare, extra: Record<string, string> = {}, timeout = 60_000) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: baseEnv(extra), timeout });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", signal: r.signal };
};

// ── LOOP-283: the six verbs that dumped a stack ────────────────────────────────────────────────
// The guidance text is already correct INSIDE the thrown message; only the framing was lost. A
// clean answer is: one line, prefixed with the verb, no `at <frame>`, no `Node.js v<ver>` trailer.
const WORKSPACE_LESS_VERBS: string[][] = [
  ["metrics"], ["metrics", "--json"], ["next-project", "--agent", "pm"],
  ["hub", "status"], ["team", "repair"], ["doc-land"], ["secret", "list"],
];
for (const argv of WORKSPACE_LESS_VERBS) {
  const r = cli(argv);
  const label = `dev-loop ${argv.join(" ")}`;
  const clean = /no dev-loop\.json found from .* upward\./.test(r.err)
    && !/\n\s+at /.test(r.err) && !/Node\.js v/.test(r.err);
  ok(clean, `LOOP-283: '${label}' outside a workspace → one actionable line, no stack (got: ${JSON.stringify(r.err.split("\n")[0]?.slice(0, 90) ?? "")})`);
  ok(r.code !== 0, `LOOP-283 AC5: '${label}' still exits non-zero (${r.code})`);
}

// The control: `team import` already behaved, and must be untouched.
ok(/no dev-loop\.json found/.test(cli(["team", "import"]).err), "LOOP-283: the `team import` control still prints its clean refusal");

// AC4 — a NON-workspace exception must still surface Node's default fatal output, byte-shape intact.
// Proven directly against the bootstrap rather than through a verb, so the fixture is deterministic.
const thrower = join(tmp, "thrower.ts");
writeFileSync(thrower, `throw new TypeError("something genuinely internal");\n`);
const bootstrap = pathToFileURL(join(hubRoot, "src", "cli-bootstrap.ts")).href;
const raw = spawnSync(process.execPath, ["--import", bootstrap, thrower], { encoding: "utf8", env: baseEnv() });
ok(/TypeError: something genuinely internal/.test(raw.stderr ?? "") && /\n\s+at /.test(raw.stderr ?? "") && /Node\.js v/.test(raw.stderr ?? ""),
  "LOOP-283 AC4: a non-workspace error keeps its stack AND the `Node.js v` trailer (nothing is swallowed)");

const wsThrower = join(tmp, "ws-thrower.ts");
writeFileSync(wsThrower, `const e = new Error("no dev-loop.json found from /x upward."); e.name = "WsNotFound"; throw e;\n`);
const wsRaw = spawnSync(process.execPath, ["--import", bootstrap, wsThrower], { encoding: "utf8", env: baseEnv({ DEVLOOP_CLI_VERB: "metrics" }) });
ok((wsRaw.stderr ?? "").split("\n").some((l) => l.startsWith("dev-loop metrics: no dev-loop.json found")) && !/Node\.js v/.test(wsRaw.stderr ?? ""),
  "LOOP-283: the bootstrap names the verb the operator typed (DEVLOOP_CLI_VERB)");

// ── LOOP-44: node:sqlite's ExperimentalWarning must not ride every successful call ─────────────
// Asserted on the SQLite text specifically — that is the warning LOOP-44 measured, and it is the one
// the operator sees, because the PUBLISHED package is .js. The sibling "Type Stripping" notice fires
// only on a source run (`node src/*.ts`, i.e. this suite and dev), and it is unreachable by design:
// node emits it while stripping the entry file, BEFORE any user code — including an --import hook —
// has run. Nothing in-process can suppress it, and a blanket --disable-warning=ExperimentalWarning
// would also hide a genuinely new experimental feature the operator should hear about.
const SQLITE_WARN = /SQLite is an experimental feature/;
const docSqlite = cli(["doctor"]); // reaches server.ts → node:sqlite, the exact path LOOP-44 measured
ok(!SQLITE_WARN.test(docSqlite.err), `LOOP-44: 'dev-loop doctor' no longer opens with the node:sqlite ExperimentalWarning (got ${JSON.stringify(docSqlite.err.slice(0, 140))})`);
const rawSqlite = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], { encoding: "utf8", env: baseEnv() });
ok(SQLITE_WARN.test(rawSqlite.stderr ?? ""), "LOOP-44 control: node itself still emits the warning — the suppression is ours, not a runtime change");
const optedIn = cli(["version"], bare, { DEVLOOP_NODE_WARNINGS: "1" });
ok(optedIn.code === 0, "LOOP-44: DEVLOOP_NODE_WARNINGS=1 is an opt-back-in escape hatch, not a crash");
// A NON-runtime warning must still get through — the filter is two exact texts, not a mute button.
const warnProbe = join(tmp, "warn.ts");
writeFileSync(warnProbe, `process.emitWarning("a genuine deprecation", "DeprecationWarning");\n`);
const probed = spawnSync(process.execPath, ["--import", bootstrap, warnProbe], { encoding: "utf8", env: baseEnv() });
ok(/a genuine deprecation/.test(probed.stderr ?? ""), "LOOP-44: a non-runtime warning still reaches stderr (the filter is narrow)");

// ── LOOP-284: doctor must not answer DOCTOR_OK for a scope it never checked ────────────────────
const docBare = cli(["doctor"]);
ok(/DOCTOR_NO_WORKSPACE/.test(docBare.out), "LOOP-284 AC2: workspace-less doctor prints a DISTINCT verdict token, not DOCTOR_OK");
ok(!/DOCTOR_OK/.test(docBare.out), "LOOP-284 AC2: a scripted reader grepping DOCTOR_OK cannot match the workspace-less run");
ok(/no dev-loop workspace found from/.test(docBare.out) && docBare.out.includes(bare),
  "LOOP-284 AC1: the run names the cwd it searched, as a first-class line");
ok(/reading the machine-global board instead/.test(docBare.out), "LOOP-284 AC1: it also names the db it fell back to");
ok(docBare.code !== 0, `LOOP-284 AC3: the workspace-less pre-flight exits non-zero (${docBare.code})`);

// AC4 — the db-selection ladder is untouched, and a DELIBERATE global-db run is still possible:
// with DEVLOOP_HUB_DB explicitly set the caller named the target, so the skipped workspace checks
// are ANNOUNCED but the verdict is not failed. Only the accidental case (no workspace, no explicit
// db) is the defect LOOP-284 measured.
{
  const pinnedDb = join(tmp, "pinned.db");
  const seeded = cli(["seed", "pin", "Pinned", "PIN"], bare, { DEVLOOP_HUB_DB: pinnedDb });
  ok(seeded.code === 0, `LOOP-284 AC4 fixture: seeded an explicit db (${seeded.code}) ${seeded.err.slice(-200)}`);
  const docPinned = cli(["doctor"], bare, { DEVLOOP_HUB_DB: pinnedDb });
  ok(/no dev-loop workspace found from/.test(docPinned.out), "LOOP-284 AC4: an explicit-db run still ANNOUNCES that workspace checks were skipped");
  ok(/DOCTOR_OK/.test(docPinned.out) && docPinned.code === 0,
    `LOOP-284 AC4: …but a deliberate DEVLOOP_HUB_DB run is not failed (code=${docPinned.code})`);
}

// AC5 — a REAL workspace is byte-for-byte unaffected: still DOCTOR_OK, still exit 0.
const ws = join(tmp, "ws");
const init = cli(["team", "init", "--dir", ws, "--key", "clipres", "--backend", "linear", "--linear-team", "L1", "--yes"], tmp);
ok(init.code === 0, `LOOP-284 AC5 fixture: team init succeeded (${init.code}) ${init.err.slice(0, 200)}`);
const docWs = cli(["doctor"], ws);
ok(/DOCTOR_OK/.test(docWs.out) && !/DOCTOR_NO_WORKSPACE/.test(docWs.out), "LOOP-284 AC5: doctor inside a workspace is unchanged — DOCTOR_OK");
ok(docWs.code === 0, `LOOP-284 AC5: and still exits 0 (${docWs.code})`);

// ── LOOP-154: `--help` must never be an ACTION ─────────────────────────────────────────────────
// Both cases used to reach a real `server.listen`. A short timeout is part of the assertion: before
// the fix `daemon --help` either hung holding a port or died on an unhandled EADDRINUSE.
const dHelp = cli(["daemon", "--help"], ws, {}, 25_000);
ok(dHelp.code === 0 && /usage: dev-loop daemon/.test(dHelp.out) && dHelp.signal === null,
  `LOOP-154: 'daemon --help' prints help and exits 0 without binding (code=${dHelp.code} signal=${dHelp.signal})`);

const stateRoot = join(ws, ".dev-loop");
const runfilesBefore = existsSync(stateRoot) ? readdirSync(stateRoot).filter((f) => f.startsWith("daemon-")).length : 0;
const hHelp = cli(["hub", "start", "--help"], ws, {}, 25_000);
const runfilesAfter = existsSync(stateRoot) ? readdirSync(stateRoot).filter((f) => f.startsWith("daemon-")).length : 0;
ok(hHelp.code === 0 && /usage: dev-loop hub/.test(hHelp.out), `LOOP-154: 'hub start --help' prints help instead of STARTING (code=${hHelp.code})`);
ok(runfilesAfter === runfilesBefore, `LOOP-154: 'hub start --help' created no daemon runfile (${runfilesBefore} → ${runfilesAfter})`);

// ── LOOP-248: both dormant/unreachable hints in runOp qualify the project ──────────────────────
// A source assertion is the honest shape here: the branch needs a running-but-dormant daemon, and
// the defect is that ONE of two sibling strings in the same function forgot the qualifier.
const agentops = readFileSync(join(hubRoot, "src", "cli-agentops.ts"), "utf8");
const bareHints = agentops.split("\n").filter((l) => /dev-loop daemon up/.test(l) && !/DEVLOOP_PROJECT=/.test(l));
ok(bareHints.length === 0, `LOOP-248: every 'dev-loop daemon up' hint in cli-agentops.ts is qualified with DEVLOOP_PROJECT (${bareHints.length} bare)`);

console.log(fails ? `\n${fails} FAILED` : "\nCLI_PRESENTATION_OK");
process.exit(fails ? 1 : 0);
