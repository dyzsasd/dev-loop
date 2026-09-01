// A draining scheduler must not exit until every in-flight fire has SETTLED — its ledger row written and
// its log tail flushed — not merely until every child process has exited.
//
// `activeChildren` is emptied on the OS `exit` event, while recordFire() runs later, inside finalize(),
// after up to a 150 ms grace for the pipes to drain. The four exit gates read `activeChildren.size === 0`,
// so with two fires in flight the first fire's .finally() could process.exit(0) out from under the second
// fire's grace window: that fire's ledger row and log tail were silently dropped. The money and the work
// were real; only the record was missing. This is also why breaker-state.ts's "run 5" assertions failed
// only under full-suite load — the loaded machine widened the window.
//
// The race is made deterministic here rather than waited for: fire 1 leaves a background grandchild
// holding stdout open after it exits, so its `close` (and therefore its finalize) is deferred; fire 2
// exits cleanly a moment later, inside fire 1's grace window, and its .finally() is what used to exit.
// Driven as a subprocess like team-scheduler.ts — run-agents' main() is unconditional, so it cannot be
// imported. Run from /tmp, never inside the live workspace.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-stop-settle-"));
const HOME = join(tmp, "home");
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME, ...extra });
const team = (args: string[], cwd: string) =>
  spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "settle-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
spawnSync("mkdir", ["-p", join(ws, "ra")]);
team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);

// Fire 1 exits at 1.0 s but forks a grandchild that keeps the inherited stdout open for another second,
// so the pipe's `close` — and with it finalize() and recordFire() — is deferred past its 150 ms grace.
// Fire 2 exits cleanly at 1.1 s, inside that window, and drains at once.
const claimDir = join(tmp, "first-fire");
const fakeBin = join(tmp, "fake-claude.sh");
// mkdir is the atomic claim: the two fires start in the same tick, so a read-modify-write counter file
// races and both invocations take the same branch.
writeFileSync(fakeBin, `#!/bin/sh
if mkdir "${claimDir}" 2>/dev/null; then sleep 1; ( sleep 1 ) & echo "LINGERING fire exits with a pipe still held open"; exit 0
else sleep 1.1; echo "CLEAN fire exits inside the lingering fire's grace window"; exit 0; fi
`);
chmodSync(fakeBin, 0o755);

const r = spawnSync("node", [
  join(hubRoot, "src", "run-agents.ts"),
  "--agents", "pm,qa", "--max-fires", "2", "--stagger", "0", "--no-daemon",
], { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: fakeBin }), encoding: "utf8", timeout: 90_000 });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
const rows = existsSync(ledger)
  ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { agent: string })
  : [];
const agents = rows.map((x) => x.agent).sort();

ok(/CLEAN fire exits/.test(out), "fixture: the clean fire exited inside the lingering fire's grace window");
ok(rows.length === 2, `both in-flight fires are ledgered when the scheduler drains (${rows.length} row(s): ${agents.join(", ") || "none"})`);
ok(agents.join(",") === "pm,qa", `…one row per lane, neither dropped (${agents.join(",") || "none"})`);
ok((r.status ?? 1) === 0, `the drained scheduler still exits 0 (${r.status})`);
ok(/LINGERING fire exits/.test(out), "the deferred fire's log tail reached the run log — truncation drops the tail as well as the row");

if (fails) console.log(`\n--- scheduler output ---\n${out.split("\n").slice(-12).join("\n")}`);
console.log(fails === 0 ? "\nSTOP_SETTLE_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
