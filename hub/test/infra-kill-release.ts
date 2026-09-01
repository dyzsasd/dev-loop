// A claim held by a fire that INFRASTRUCTURE killed goes back to Todo.
//
// The release fired only for the in-process watchdogs (timeout, stall, per-fire budget). A provider-side
// kill — session-limit above all, and the same for spend-limit / rate-limit / auth / network — left the
// ticket In Progress with nothing owning it: `pick` reads Todo, so no lane ever returns to it, and no
// doctor check reports the stranded claim. The distinction was never a contract, only which killer
// happened to be a timer; the agent's judgement ended the fire in neither case. In the jinko-browser-use
// workspace session-limit was 20 of 30 failures in 24 h, so this was the common shape, not the rare one.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-infra-kill-"));
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra });
const cliPath = join(hubRoot, "src", "cli.ts");
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const cli = (args: string[], cwd: string, extra: Record<string, string> = {}) =>
  spawnSync("node", [cliPath, ...args], { cwd, env: env({ DEVLOOP_PROJECT: "alpha", ...extra }), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "infra-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
spawnSync("mkdir", ["-p", join(ws, "ra")]);
team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);
cli(["seed", "alpha", "Alpha", "ALPHA"], ws);

const created = cli(["ticket", "create", "--title", "Claimed then killed by the provider", "--type", "Improvement", "--assignee", "pm", "--priority", "1"], ws);
const id = (created.stdout.match(/\bALPHA-\d+\b/) ?? [])[0] ?? "";
ok(id !== "", `fixture: a ticket exists to be claimed (${id || created.stdout.trim() + created.stderr.trim()})`);
cli(["ticket", "update", id, "--state", "Todo"], ws);

// The agent CLI claims the ticket the way a real fire does — through the op API, inside the fire, so the
// transition event carries this fire's DEVLOOP_FIRE_ID — and is then killed by the provider's session
// limit. The tail is the literal string Claude Code emits (breaker.ts tailErrorClass).
const bin = join(tmp, "session-limited.sh");
writeFileSync(bin, `#!/bin/sh
node "${cliPath}" ticket update ${id} --state "In Progress" >/dev/null 2>&1
echo "You've hit your session limit · resets 12:20am (Europe/Paris)"
exit 1
`);
chmodSync(bin, 0o755);

const run = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--once"],
  { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: bin }), encoding: "utf8", timeout: 120_000 });
const runOut = `${run.stdout ?? ""}${run.stderr ?? ""}`;

const shown = cli(["ticket", id], ws).stdout;
const claimed = /In Progress/.test(shown);
ok(!claimed, `the claim is not left In Progress after a session-limit kill (${claimed ? "still In Progress" : "released"})`);
ok(/\bTodo\b/.test(shown), `…it is back in Todo, reclaimable by the next fire${/\bTodo\b/.test(shown) ? "" : `\n${shown.slice(0, 400)}`}`);

// The kill must still be recorded as the failure it was — releasing the claim is not the same as
// forgiving the fire, and the taxonomy is what the breaker and the failure counters read.
const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
const rows = spawnSync("cat", [ledger], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { errorClass?: string });
ok(rows.some((r) => r.errorClass === "session-limit"), `the fire is still ledgered as session-limit (${rows.map((r) => r.errorClass ?? "none").join(", ")})`);

// The note left on the ticket must name the cause the ledger recorded. The mapping defaulted to the
// literal "timeout/stall", so every class added to the union was silently mislabelled — a reader of the
// ticket was told the fire timed out while the fire's own row said session-limit.
const note = spawnSync("node", [cliPath, "comments", id], { cwd: ws, env: env({ DEVLOOP_PROJECT: "alpha" }), encoding: "utf8" }).stdout;
ok(/session limit/i.test(note), `the release note names the provider session limit${/session limit/i.test(note) ? "" : `\n${note.slice(-300)}`}`);
ok(!/timeout\/stall/.test(note), "…and does not claim the fire timed out or stalled");

// ---- the operator's own stop is the same shape: the claim must not outlive the fire ----------------
const created2 = cli(["ticket", "create", "--title", "Claimed then stopped by the operator", "--type", "Improvement", "--assignee", "pm", "--priority", "1"], ws);
const id2 = (created2.stdout.match(/\bALPHA-\d+\b/) ?? [])[0] ?? "";
cli(["ticket", id2 ? "update" : "update", id2, "--state", "Todo"], ws);
const marker = join(tmp, "claimed");
const slowBin = join(tmp, "claim-then-hang.sh");
writeFileSync(slowBin, `#!/bin/sh
node "${cliPath}" ticket update ${id2} --state "In Progress" >/dev/null 2>&1
touch "${marker}"
exec sleep 30
`);
chmodSync(slowBin, 0o755);
const sched = spawn("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", "pm", "--interval", "pm=1s", "--stagger", "0"],
  { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: slowBin }), stdio: ["ignore", "pipe", "pipe"] });
let schedOut = "";
sched.stdout.on("data", (d) => { schedOut += d; }); sched.stderr.on("data", (d) => { schedOut += d; });
const schedExit = new Promise<number | null>((res) => sched.on("exit", (c) => res(c)));
for (let i = 0; i < 120 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 250));
ok(existsSync(marker), "fixture: the fire claimed a ticket and is still running when the stop arrives");
sched.kill("SIGTERM");
await Promise.race([schedExit, new Promise((r) => setTimeout(r, 25_000))]);

const shown2 = cli(["ticket", id2], ws).stdout;
ok(!/In Progress/.test(shown2), `an operator stop does not strand the claim it interrupted (${/In Progress/.test(shown2) ? "still In Progress" : "released"})`);
const note2 = spawnSync("node", [cliPath, "comments", id2], { cwd: ws, env: env({ DEVLOOP_PROJECT: "alpha" }), encoding: "utf8" }).stdout;
ok(/operator stopped the scheduler/.test(note2), "…and the note says the operator stopped it, not that infrastructure killed it");

if (fails) console.log(`\n--- run output ---\n${runOut.split("\n").slice(-10).join("\n")}\n--- sched ---\n${schedOut.split("\n").slice(-8).join("\n")}`);
console.log(fails === 0 ? "\nINFRA_KILL_RELEASE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
