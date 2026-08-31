// "metered" means one thing, everywhere.
//
// A fire carrying usage is METERED; a fire whose usage also has a non-zero costUsd is PRICED. metrics.ts
// has always had both counts under distinct names, but `dev-loop status` published the PRICED count under
// the name `meteredFires` — so the same 24 h window read "(184 metered)" from status and "201 of 208
// metered fires" from metrics, and `status --json`'s `cost.meteredFires` meant something different from
// the identically named field in metrics. A zero-cost failure (a rate-limit refusal) is exactly the row
// that separates them, which is why the gap is not hypothetical.
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-metered-"));
const env = () => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "metered-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);

const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
mkdirSync(dirname(ledger), { recursive: true });
const HOUR = 3_600_000;
const row = (agedMs: number, costUsd: number | null, exitCode = 0) => JSON.stringify({
  ts: new Date(Date.now() - agedMs).toISOString(), agent: "pm", project: "alpha", codingAgent: "claude",
  provider: "anthropic", model: "claude-opus", effort: "high", durationMs: 1000, exitCode,
  timedOut: false, fireId: `00000000-0000-0000-0000-${String(agedMs).padStart(12, "0")}`,
  ...(costUsd === null ? {} : { usage: { source: "provider", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd, currency: "USD" } }),
});
// 5 priced fires, 2 metered-but-unpriced (zero-cost rate-limit refusals), 1 with no usage at all.
const rows = [
  row(1 * HOUR, 1), row(2 * HOUR, 1), row(3 * HOUR, 1), row(4 * HOUR, 1), row(5 * HOUR, 1),
  row(6 * HOUR, 0, 1), row(7 * HOUR, 0, 1),
  row(8 * HOUR, null, 1),
];
writeFileSync(ledger, rows.map((r) => r + "\n").join(""));

const status = JSON.parse(spawnSync("node", [join(hubRoot, "src", "cli.ts"), "status", "--json"], { cwd: ws, env: env(), encoding: "utf8" }).stdout) as
  { cost24h?: { meteredFires?: number; pricedFires?: number; costUsd?: number | null } };
const metrics = JSON.parse(spawnSync("node", [join(hubRoot, "src", "metrics.ts"), "--window", "24h", "--json"], { cwd: ws, env: env(), encoding: "utf8" }).stdout) as
  { fires?: { meteredFires?: number; costMeteredFires?: number } };

ok(metrics.fires?.meteredFires === 7, `fixture: metrics counts 7 metered fires — the ones carrying usage (${metrics.fires?.meteredFires})`);
ok(metrics.fires?.costMeteredFires === 5, `fixture: …of which 5 are priced (${metrics.fires?.costMeteredFires})`);

ok(status.cost24h?.meteredFires === metrics.fires?.meteredFires,
  `status and metrics agree on what "metered" counts (status ${status.cost24h?.meteredFires} vs metrics ${metrics.fires?.meteredFires})`);
ok(status.cost24h?.pricedFires === metrics.fires?.costMeteredFires,
  `…and status reports the priced count under its own name (${status.cost24h?.pricedFires})`);

// The human line shows both when they differ — the gap is the information.
const human = spawnSync("node", [join(hubRoot, "src", "cli.ts"), "status"], { cwd: ws, env: env(), encoding: "utf8" }).stdout;
ok(/5 priced \/ 7 metered/.test(human), `the rendered line distinguishes them (${(human.match(/fires 24h:.*/) ?? ["<no line>"])[0]})`);

console.log(fails === 0 ? "\nMETERED_VS_PRICED_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
