// LOOP-93: the operator debug logs (run.log + runner-logs/<agent>.log) get the §16 owner-only perms posture
// LOOP-62 gave fires.jsonl — created 0600 (dir 0700), a PRE-EXISTING loose one warned-once-never-chmod'd, and
// the 50MB rotation must not recreate at the default umask. Every check is a real subprocess fire: run-agents.ts
// runs main() unconditionally (LOOP-58 removed the entry guard), so nothing can import hardenLedgerPerms — the
// warn-once-PER-PROCESS semantics (AC3) are proven by firing twice in ONE scheduler process (--max-fires 2).
// The core create-perms regression (runner-logs 0600/0700 after a fresh fire) also lives in test/team-scheduler.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, statSync, chmodSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// win32 has no POSIX mode bits — the hardening is a documented no-op there (as the src is), so this suite is moot.
if (platform() === "win32") { console.log("✅ LOOP-93: win32 has no POSIX mode bits — log-perms hardening is a no-op, skipping\n\nLOG_PERMS_OK"); process.exit(0); }

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-logperms-")));
const HOME = join(tmp, "home");
const ws = join(tmp, "ws");
const env = (extra: Record<string, string> = {}) => ({ ...process.env, DEVLOOP_HOME: HOME, ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const run = (args: string[], extra: Record<string, string> = {}, timeoutMs = 60_000) => {
  const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), ...args], { cwd: ws, env: env(extra), encoding: "utf8", timeout: timeoutMs });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const ownerOnly = (p: string) => (statSync(p).mode & 0o077) === 0; // no group/other bits at all

// ── fixture: a SINGLE-project workspace (deterministic runner-log path) + a fake claude bin ──
team(["init", "--dir", ws, "--key", "logperms", "--backend", "linear", "--linear-team", "L1"], tmp);
mkdirSync(join(ws, "ra"), { recursive: true });
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);
const fakeBin = join(tmp, "fake-claude.sh");
writeFileSync(fakeBin, "#!/bin/sh\necho 'fire ok'\nexit 0\n"); chmodSync(fakeBin, 0o755);
const CLI = { DEVLOOP_CLAUDE_BIN: fakeBin };

const dataDir = join(ws, ".dev-loop");
const rlDir = join(dataDir, "alpha", "runner-logs");
const rlLog = join(rlDir, "pm.log");
const ledger = join(dataDir, "team", "fires.jsonl");
const fireCount = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).length : 0);
const warnsFor = (out: string, p: string) => out.split("\n").filter((l) => l.includes("is readable by group/others") && l.includes(p)).length;

// ── AC1 — a fresh fire creates runner-logs/ 0700 and <agent>.log 0600 (on a0afe6e both were 0644) ──
const f1 = run(["--agents", "pm", "--once"], CLI);
ok(f1.code === 0 && existsSync(rlLog), "AC1: a --once fire writes runner-logs/pm.log");
ok(ownerOnly(rlDir), `AC1: runner-logs/ created owner-only 0700 (got ${mode(rlDir)})`);
ok(ownerOnly(rlLog), `AC1: runner-logs/pm.log created owner-only 0600 (got ${mode(rlLog)})`);

// ── AC2 + AC3 — a PRE-EXISTING group/world-readable log is WARNED (never chmod'd), and warned ONCE per process.
//    Two fires in one scheduler process (--max-fires 2, single project) hit the same path twice; the warn-once set
//    must suppress the second. On a0afe6e the logs emit no such warning at all (0 ≠ 1). ──
chmodSync(rlLog, 0o644);                                   // the operator's own loosely-permissioned file
const before = fireCount();
const two = run(["--agents", "pm", "--max-fires", "2", "--interval", "pm=1s", "--stagger", "0"], CLI, 60_000);
ok(fireCount() - before >= 2, `AC3 setup: two fires ran in ONE process (${fireCount() - before})`);
ok((statSync(rlLog).mode & 0o777) === 0o644, `AC2: a pre-existing loose log is NOT chmod'd behind the operator's back (still ${mode(rlLog)})`);
ok(warnsFor(two.out, rlLog) === 1, `AC2+AC3: the loose log warns EXACTLY once across the two same-process fires (got ${warnsFor(two.out, rlLog)})`);
const warnLine = two.out.split("\n").find((l) => l.includes("is readable by group/others") && l.includes(rlLog)) ?? "";
ok(/mode 644/.test(warnLine) && new RegExp(`chmod 600 ${rlLog.replace(/[.]/g, "\\$&")}`).test(warnLine),
  "AC2: the warning names the path, the current mode (644) and the chmod remedy (chmod 600 <path>)");

// ── AC4 — the 50MB rotation must PRESERVE 0600: a rotated log is recreated owner-only, not at the umask.
//    Pre-fill the log past the threshold (sparse ftruncate — size only, instant) at 0600; the next fire rotates it
//    to .1 and the fresh log must be 0600. On a0afe6e the recreated log lands at the default umask (0644). ──
chmodSync(rlLog, 0o600);
{ const fd = openSync(rlLog, "r+"); ftruncateSync(fd, 51 * 1024 * 1024); closeSync(fd); }
const rot = run(["--agents", "pm", "--once"], CLI);
ok(rot.code === 0 && existsSync(`${rlLog}.1`), "AC4: a >50MB log is rotated to .1");
ok(ownerOnly(rlLog), `AC4: the rotated-then-recreated log is owner-only 0600, not the umask default (got ${mode(rlLog)})`);

// ── AC1 (run.log) — the --background launcher creates run.log owner-only. The PARENT creates + hardens it
//    synchronously before detaching, so it exists the instant the launcher returns; the detached child is bounded
//    by --max-fires 1 (and stopped below). On a0afe6e run.log is opened at the default umask (0644). ──
const runLog = join(dataDir, "run.log");
spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--background", "--agents", "pm", "--max-fires", "1", "--interval", "pm=1s", "--stagger", "0"], { cwd: ws, env: env(CLI), encoding: "utf8", timeout: 30_000 });
ok(existsSync(runLog), "AC1: --background creates run.log");
ok(existsSync(runLog) && ownerOnly(runLog), `AC1: run.log created owner-only 0600 (got ${existsSync(runLog) ? mode(runLog) : "absent"})`);
spawnSync("node", [join(hubRoot, "src", "stop.ts")], { cwd: ws, env: env(), encoding: "utf8", timeout: 20_000 }); // stop the detached scheduler (best-effort; --max-fires 1 self-terminates anyway)

if (fails) { console.log(`\n${fails} CHECK(S) FAILED`); process.exit(1); }
console.log("\nLOG_PERMS_OK");
