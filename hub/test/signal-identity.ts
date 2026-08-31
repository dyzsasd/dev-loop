// Two guards that keep an operator's read or verb from acting on a false premise.
//
// 1. `dev-loop stop` signals — SIGTERM, then SIGKILL. A zero-signal probe only proves SOME process holds
//    the pid, so a stale run lock over a recycled pid made the verb kill an unrelated process: the exact
//    hazard stop.ts's own header says it was written to prevent. It now confirms identity first.
// 2. `dev-loop tickets --state <typo>` filtered to nothing and exited 0, which an operator cannot tell
//    from a genuinely clean board — the parser already refuses a dangling flag and an unknown flag for
//    that reason, and db.ts CHECKs the same state set on the write path.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pidInfo, pidMatchesRecord, parsePsLine } from "../src/pid-identity.ts";
import { STATES } from "../src/db.ts";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-signal-id-"));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra });
const team = (args: string[], cwd: string) =>
  spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
// Both verbs are exercised through the operator entry point (cli.ts), not their modules, so the test
// covers the dispatch an operator actually types.
const cli = (args: string[], cwd: string) => {
  const r = spawnSync("node", [join(hubRoot, "src", "cli.ts"), ...args], { cwd, env: env({ DEVLOOP_PROJECT: "alpha" }), encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };

(async () => {
  // ---- unit: the identity predicate itself -------------------------------------------------------
  // The stand-in for a recycled pid is ORPHANED deliberately (started by a shell that exits at once, so
  // it is reparented away from this test). A direct child would turn into a ZOMBIE when signalled, and a
  // zero-signal probe succeeds on a zombie — "still alive" would then pass even when the process HAD been
  // killed, which is precisely the assertion this test exists to make.
  const pidFile = join(tmp, "victim.pid");
  spawnSync("sh", ["-c", `sleep 45 >/dev/null 2>&1 & echo $! > ${pidFile}`], { encoding: "utf8" });
  await new Promise((r) => setTimeout(r, 300));
  const vpid = Number(readFileSync(pidFile, "utf8").trim());
  ok(Number.isInteger(vpid) && vpid > 0 && alive(vpid), `fixture: an orphaned stand-in process is running (pid ${vpid})`);
  ok(pidMatchesRecord(vpid, new Date().toISOString(), "sleep").ok, "a pid running the recorded program matches");
  ok(!pidMatchesRecord(vpid, new Date().toISOString(), "run-agents").ok, "a pid running some OTHER program does not match — this is the recycled-pid case");
  // ctime pads a single-digit day with a space, so `ps` emits TWO spaces after the month on the 1st-9th
  // and one on the 10th-31st. The first regex here allowed only one: for nine days of every month the
  // parse failed, startedAtMs came back null, and the birth-order check below was skipped in silence —
  // leaving the command hint as the only guard, which by construction cannot separate a recycled pid
  // running the SAME program. Asserted on fixed strings, not on today's date: the defect shipped and
  // survived a whole batch precisely because the suite only ever ran on days that hid it.
  const padded = parsePsLine("Tue Sep  1 00:09:07 2026     sleep 45");
  ok(padded.startedAtMs !== null, `a single-digit day (two spaces after the month) parses — the 1st-9th of every month${padded.startedAtMs === null ? " [regressed: startedAtMs null]" : ""}`);
  ok(padded.command === "sleep 45", `…and the command is split off cleanly, not left glued to the date (got ${JSON.stringify(padded.command)})`);
  const unpadded = parsePsLine("Sat Aug 29 19:18:15 2026     sleep 45");
  ok(unpadded.startedAtMs !== null && unpadded.command === "sleep 45", "a two-digit day parses the same way — the fix did not trade one padding for the other");
  ok(parsePsLine("Tue Sep  1 00:09:07 2026 x").startedAtMs === Date.parse("Tue Sep  1 00:09:07 2026"),
    "…and the parsed instant is the one ps reported, not a shifted or defaulted value");
  const garbage = parsePsLine("not a ps line at all");
  ok(garbage.startedAtMs === null && garbage.command === "not a ps line at all",
    "an unparseable line still yields the line as the command — an unreadable date must not erase the OTHER signal");

  const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  ok(!pidMatchesRecord(vpid, longAgo, "sleep").ok, "a pid that started AFTER the record was written does not match — the record cannot name it");
  ok(!pidMatchesRecord(2_147_483_600, new Date().toISOString(), "sleep").ok, "a pid that does not exist does not match");

  // ---- integration: `dev-loop stop` refuses a stale lock instead of killing the pid ---------------
  const ws = join(tmp, "ws");
  team(["init", "--dir", ws, "--key", "sig-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
  team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
  spawnSync("mkdir", ["-p", join(ws, "ra")]);
  team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);

  // A stale lock naming a LIVE pid that is not the scheduler — the recycled-pid shape.
  const lockPath = join(ws, ".dev-loop", "locks", "run.lock");
  spawnSync("mkdir", ["-p", dirname(lockPath)]);
  writeFileSync(lockPath, JSON.stringify({ pid: vpid, startedAt: new Date().toISOString() }));

  const stopped = cli(["stop"], ws);
  // Checked through ps, not a zero-signal probe: the point is that the process is still RUNNING its own
  // program, not merely that something holds the pid.
  ok((pidInfo(vpid)?.command ?? "").includes("sleep"), "the unrelated process is STILL RUNNING after `dev-loop stop` — it was not signalled");
  ok(stopped.code !== 0, `…and stop reports failure rather than claiming success (exit ${stopped.code})`);
  ok(/refusing to signal/.test(stopped.out), "…saying it refused to signal");
  ok(stopped.out.includes(lockPath), "…and naming the stale lock the operator has to clear");
  try { process.kill(vpid, "SIGKILL"); } catch { /* already gone */ }

  // ---- integration: a mistyped --state is a usage error, not an empty board ----------------------
  spawnSync("node", [join(hubRoot, "src", "cli.ts"), "seed", "alpha", "Alpha", "ALPHA"], { cwd: ws, env: env({ DEVLOOP_PROJECT: "alpha" }), encoding: "utf8" });
  const typo = cli(["tickets", "--state", "Human-blocked"], ws); // real state is "Human-Blocked"
  ok(typo.code === 2, `a mistyped --state exits 2, not 0 (exit ${typo.code})`);
  ok(!/No tickets/.test(typo.out), "…and does not answer with an empty board");
  ok(STATES.every((s) => typo.out.includes(s)), "…listing every legal state so the operator can correct it");
  const good = cli(["tickets", "--state", "Human-Blocked"], ws);
  ok(good.code === 0, `the correctly spelled state is still accepted (exit ${good.code})`);
  ok(/No tickets/.test(good.out), "…and an empty result now means the board really is empty");

  console.log(fails === 0 ? "\nSIGNAL_IDENTITY_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
