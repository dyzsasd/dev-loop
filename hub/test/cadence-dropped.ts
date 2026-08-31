// LOOP-90 — a configured cadence for an agent OUTSIDE the run set was dropped in silence.
//
// This is the third member of the documented-but-absent family, and the worst-behaved: the config is
// well-formed, correctly spelled, semantically meaningful, AND written by the product's own `team
// init`, which seeds four cadences into every new workspace while the default run set (`core`)
// contains exactly one of them.
//
// The output asymmetry IS the whole surface. Three cases, and only two of them said anything:
//   applied   → "cadence <a>=<d> (from config)" on stdout
//   malformed → "ignoring malformed cadence ..." warning
//   DROPPED   → nothing at all — the one case where the operator's intent is discarded silently
//
// run-agents.ts calls main() unconditionally (LOOP-58), so nothing can import it: this spawns the
// real scheduler and reads what it actually prints.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-cadence-"));

try {
  const ws = join(tmp, "ws");
  const repo = join(ws, "r");
  const env = { ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") } as NodeJS.ProcessEnv;
  const team = (args: string[], cwd: string) =>
    spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env, encoding: "utf8" });

  team(["init", "--dir", ws, "--key", "cad", "--backend", "linear", "--linear-team", "L1", "--yes"], tmp);
  mkdirSync(repo, { recursive: true });
  team(["add-project", "alpha", "--linear-project", "Alpha"], ws);
  team(["add-repo", "r", "--project", "alpha", "--path", "r"], ws);
  // Cadences for one SELECTED agent and two UNSELECTED ones — the exact shape `team init` produces.
  team(["set", "team.agents.sweep.cadence", "30m"], ws);
  team(["set", "team.agents.ops.cadence", "10m"], ws);
  team(["set", "team.agents.reflect.cadence", "1d"], ws);

  const fake = join(tmp, "fake.sh");
  writeFileSync(fake, "#!/bin/sh\necho ok\nexit 0\n");
  chmodSync(fake, 0o755);

  const run = (agents: string) => {
    const r = spawnSync("node", [join(hubRoot, "src", "run-agents.ts"), "--agents", agents, "--once", "--dry-run"],
      { cwd: ws, env: { ...env, DEVLOOP_CLAUDE_BIN: fake }, encoding: "utf8", timeout: 90_000 });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`;
  };

  // `sweep` is in `core`; `ops` and `reflect` are not.
  const core = run("core");
  ok(/cadence sweep=/.test(core), "LOOP-90 control: a cadence for a SELECTED agent is still applied and confirmed on stdout");
  ok(/NOT APPLIED/.test(core), `LOOP-90: the dropped cadences are NAMED — the case that used to print nothing at all`);
  ok(/ops/.test(core) && /reflect/.test(core), "LOOP-90: …and every dropped agent is listed, not just the first");
  // Check the DROPPED LIST specifically, not the whole line: the warning also names the run set for
  // context, and that legitimately contains `sweep`. A looser regex fails on correct output.
  const droppedList = /NOT APPLIED — ([^\n]*?) (?:is|are) outside/.exec(core)?.[1] ?? "";
  ok(droppedList !== "" && !droppedList.includes("sweep"),
    `LOOP-90: the APPLIED agent is not in the dropped list (list was "${droppedList}")`);
  ok(/--agents/.test(core), "LOOP-90: the warning carries the remedy (add them with --agents, or remove the cadence)");

  // With everything selected there is nothing to drop — the warning must be SILENT, or it is noise
  // that trains the operator to ignore it.
  const all = run("all");
  ok(!/NOT APPLIED/.test(all), "LOOP-90: with every configured agent selected, the warning is silent");
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nCADENCE_DROPPED_OK");
process.exit(fails ? 1 : 0);
