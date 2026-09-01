// An operator's stop is not an agent failure — including when the child dies ON the forwarded signal.
//
// LOOP-155 classifies an interrupted fire on the fact that WE sent the signal, which is right, but the
// implementation also required `exitCode === 0`. That hands the classification back to the child: a CLI
// with no signal handler — or, the case that shows up under load, a shell that had not installed its trap
// yet when the signal arrived — dies on the signal instead of exiting 0. Those kills were ledgered as
// genuine agent failures with an empty output tail, which feeds the breaker a false streak and lets a
// healthy lane be ranked dead. The owner's pause of the jinko-browser-use loop produced exactly this
// shape: 222 ms fires recorded as `exitCode 1` with `(no-output)`.
//
// Driven as a subprocess like breaker-state.ts — run-agents' main() is unconditional.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-interrupt-"));
const env = (extra: Record<string, string> = {}) => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home"), ...extra });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ws = join(tmp, "ws");
  team(["init", "--dir", ws, "--key", "int-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
  team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);
  spawnSync("mkdir", ["-p", join(ws, "ra")]);
  team(["add-repo", "ra", "--project", "alpha", "--path", "ra", "--role", "primary"], ws);

  // The agent CLI installs NO signal handler — the shape a real CLI has before its handler is ready.
  // It marks the disk so the test can wait for the fire to be genuinely running before signalling.
  const marker = join(tmp, "fire-running");
  const bin = join(tmp, "no-trap.sh");
  // `exec` so the DIRECT child is the signal-less program itself: a shell that merely waits on a
  // foreground command would swallow the SIGINT and outlive it, which is not the shape under test.
  writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\nexec sleep 30\n`);
  chmodSync(bin, 0o755);

  const child = spawn("node", [join(hubRoot, "src", "run-agents.ts"),
    "--agents", "pm", "--interval", "pm=1s", "--stagger", "0", "--breaker", "2"],
    { cwd: ws, env: env({ DEVLOOP_CLAUDE_BIN: bin }), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((res) => child.on("exit", (c) => res(c)));

  for (let i = 0; i < 120 && !existsSync(marker); i++) await sleep(250);
  ok(existsSync(marker), "fixture: a fire is genuinely running before the stop is sent");

  child.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(25_000).then(() => "timeout" as const)]);
  ok(code === 0, `the scheduler drains and exits 0 (${code})`);

  const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
  const rows = existsSync(ledger)
    ? readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { interrupted?: boolean; exitCode?: number; errorClass?: string })
    : [];
  ok(rows.length > 0, `the interrupted fire is ledgered at all (${rows.length} row(s))`);
  const charged = rows.filter((r) => r.interrupted !== true);
  ok(charged.length === 0,
    `no fire killed by the operator's stop is charged to the agent (${charged.length} charged: ${JSON.stringify(charged.slice(0, 2))})`);

  // The breaker must not have learned a failure from the operator's own stop.
  const bfile = join(ws, ".dev-loop", "team", "breaker.json");
  const snapshot = existsSync(bfile) ? JSON.parse(readFileSync(bfile, "utf8")) as { agents?: Record<string, { consecutiveFailures?: number; state?: string }> } : null;
  const pm = snapshot?.agents?.["pm"];
  ok(!pm || (pm.consecutiveFailures ?? 0) === 0, `the breaker records no failure streak for the stopped lane (${JSON.stringify(pm ?? null)})`);

  if (fails) console.log(`\n--- scheduler output ---\n${out.split("\n").slice(-10).join("\n")}`);
  console.log(fails === 0 ? "\nINTERRUPT_CLASSIFICATION_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
})();
