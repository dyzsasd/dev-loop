// `dev-loop metrics --since/--until` measures the era the operator asked for, in BOTH halves of the report.
//
// resolveEra maps the two flags to { windowMs: until - since, nowMs: until }. The board half and the
// renderer were handed that `nowMs`; the fire half was not, so fireMetrics fell back to its
// `nowMs = Date.now()` default and measured [now - windowMs, now] instead. The window LENGTH was right
// and its POSITION was wrong, so `windowDays` and the label agreed with the request while the fire counts,
// errors, cost and byAgent breakdown came from a different era — with nothing in the output to say so.
// LOOP-314 added these flags for before/after comparison, which is exactly what this defeated: both
// queries read the same trailing window and always reported no difference.
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubFireEnv } from "./env-scrub.ts";
import { tmpRoot } from "./tmp-root.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-metrics-era-"));
const env = () => ({ ...scrubFireEnv(), DEVLOOP_HOME: join(tmp, "home") });
const team = (args: string[], cwd: string) => spawnSync("node", [join(hubRoot, "src", "team.ts"), ...args], { cwd, env: env(), encoding: "utf8" });

const ws = join(tmp, "ws");
team(["init", "--dir", ws, "--key", "era-team", "--backend", "linear", "--linear-team", "Loop-1"], tmp);
team(["add-project", "alpha", "--linear-project", "Alpha", "--weight", "1"], ws);

const ledger = join(ws, ".dev-loop", "team", "fires.jsonl");
mkdirSync(dirname(ledger), { recursive: true });
const HOUR = 3_600_000;
const row = (agedMs: number) => JSON.stringify({
  ts: new Date(Date.now() - agedMs).toISOString(), agent: "pm", project: "alpha", codingAgent: "claude",
  provider: "anthropic", model: "claude-opus", effort: "high", durationMs: 1000, exitCode: 0,
  timedOut: false, fireId: `00000000-0000-0000-0000-${String(agedMs).padStart(12, "0")}`,
  usage: { source: "provider", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1, currency: "USD" },
});
// Two eras, deliberately disjoint: 3 fires ~30 h ago (the OLD era) and 7 fires in the last 2 h (RECENT).
const old = [31, 30.5, 30].map((h) => row(h * HOUR));
const recent = [1.9, 1.7, 1.5, 1.2, 1.0, 0.7, 0.4].map((h) => row(h * HOUR));
writeFileSync(ledger, [...old, ...recent].map((r) => r + "\n").join(""));

const metrics = (args: string[]) => {
  const r = spawnSync("node", [join(hubRoot, "src", "metrics.ts"), ...args], { cwd: ws, env: env(), encoding: "utf8" });
  try { return JSON.parse(r.stdout) as { windowDays: number; fires: { fires?: number; total?: number } }; }
  catch { return null; }
};

// An era covering ONLY the old fires. Its length (2 h) is deliberately the same order as the recent
// burst, so a report that measured [now - 2h, now] instead would answer 7 rather than 3.
const sinceOld = new Date(Date.now() - 31.5 * HOUR).toISOString();
const untilOld = new Date(Date.now() - 29.5 * HOUR).toISOString();
const era = metrics(["--since", sinceOld, "--until", untilOld, "--json"]);
ok(era !== null, "the era query returns JSON");
const count = (m: typeof era) => (m?.fires?.fires ?? m?.fires?.total ?? -1);
ok(Math.abs((era?.windowDays ?? 0) - 2 / 24) < 0.01, `the window length is the era's, not the default (${era?.windowDays})`);
ok(count(era) === 3, `the fire half counts the era's OWN fires, not the trailing window's (${count(era)} — expected 3, the last-2h answer would be 7)`);

// The complementary check: a trailing window still measures the trailing window.
const trailing = metrics(["--window", "2h", "--json"]);
ok(count(trailing) === 7, `--window is unaffected and still measures the last 2h (${count(trailing)})`);

// And an era covering the recent burst answers 7 — so the fix is not simply shifting everything back.
const sinceNew = new Date(Date.now() - 2 * HOUR).toISOString();
const untilNew = new Date().toISOString();
ok(count(metrics(["--since", sinceNew, "--until", untilNew, "--json"])) === 7,
  "an era over the recent burst counts 7 — the era window tracks the request, not a fixed offset");

console.log(fails === 0 ? "\nMETRICS_ERA_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
