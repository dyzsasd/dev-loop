// `metrics --context --jobs` — the job-scoped per-fire load report.
//
// printJobLaneBill shipped with no test of any kind: hub/test grep found zero references to it, and its
// only caller sits behind a flag combination (`--context --jobs`) no suite exercised either. The 0.2%
// coverage the quality ratchet measured was the function's own declaration line, counted when the module
// loaded for a different suite. At CC 17 that scored CRAP 304.5 against a ceiling of 90 — the single
// worst row in the repo, and one of the three that held the ship gate red.
//
// It is a reporting function, so the assertions are about what it reports: the JSON shape a machine
// reads, the table a human reads, and the one branch that changes both — whether a workspace resolves,
// which decides if the LESSONS column carries real injected bytes or the plugin-static floor.
import { printJobLaneBill, JOB_BILL_AGENTS } from "../src/context-bill.ts";
import { tmpRoot } from "./tmp-root.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(hubRoot, "..");

// Capture what the function prints. It writes through console.log, so that is what is intercepted —
// asserting on a return value alone would say nothing about a function whose entire job is the report.
const capture = async (fn: () => Promise<number>): Promise<{ out: string; code: number }> => {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { const code = await fn(); return { out: lines.join("\n"), code }; }
  finally { console.log = real; }
};

ok(existsSync(join(pluginRoot, "skills", "pm-agent", "SKILL.md")),
  `fixture: the plugin root under test carries the SKILLs the bill reads (${pluginRoot})`);

// ── AC1: the JSON surface ─────────────────────────────────────────────────────────────────────────
{
  const { out, code } = await capture(() => printJobLaneBill(true, pluginRoot));
  ok(code === 0, `AC1: --json returns 0 (got ${code})`);
  let parsed: { jobLanes?: unknown[]; wholeRole?: Record<string, number> } = {};
  let threw = "";
  try { parsed = JSON.parse(out); } catch (e) { threw = (e as Error).message; }
  ok(threw === "", `AC1: --json emits parseable JSON and nothing else${threw && ` — ${threw}`}`);
  ok(Array.isArray(parsed.jobLanes) && parsed.jobLanes.length > 0,
    `AC1: it names the job lanes it billed (${Array.isArray(parsed.jobLanes) ? parsed.jobLanes.length : "not an array"} rows)`);
  const row = (parsed.jobLanes ?? [])[0] as Record<string, unknown> | undefined;
  ok(!!row && typeof row.agent === "string" && typeof row.job === "string" && typeof row.corpusBytes === "number"
     && typeof row.constantBytes === "number" && Array.isArray(row.pulledPlaybooks),
    `AC1: each row carries agent/job/bytes/pulls, the fields a reader bills against (${JSON.stringify(row ?? {}).slice(0, 120)})`);
  ok(!!parsed.wholeRole && JOB_BILL_AGENTS.every((a) => a in (parsed.wholeRole ?? {})),
    `AC1: the whole-role comparison covers every billed agent, so no lane is silently missing`);
  // The point of the report: a job corpus is the constitution + one job span, never the whole role.
  const bloated = (parsed.jobLanes as { agent: string; constantBytes: number }[])
    .filter((r) => r.constantBytes >= ((parsed.wholeRole ?? {})[r.agent] ?? Infinity));
  ok(bloated.length === 0,
    `AC1: no job corpus bills at or above its own whole-role load — that would mean the job scoping did nothing (${bloated.length} such rows)`);
}

// ── AC2: the human table ──────────────────────────────────────────────────────────────────────────
{
  const { out, code } = await capture(() => printJobLaneBill(false, pluginRoot));
  ok(code === 0, `AC2: the table form returns 0 (got ${code})`);
  ok(/AGENT\/JOB\s+KIND\s+CONSTANT\s+~TOKENS\s+LESSONS\s+PULLED PLAYBOOKS/.test(out),
    `AC2: the table has its header, so the columns are readable without the source`);
  ok(/whole-role \S+ load today: \d+B .* lighter \(heaviest \d+B → lightest \d+B\)/.test(out),
    `AC2: …and the whole-role comparison line states both ends of the range it is comparing`);
  ok(!/\[object Object\]|NaN|undefined/.test(out),
    `AC2: nothing renders as NaN/undefined/[object Object] (out: ${out.slice(0, 160)})`);
}

// ── AC3: the workspace branch ─────────────────────────────────────────────────────────────────────
// The one condition that changes what the LESSONS column MEANS. With no workspace the bill is the
// plugin-static floor and must say so, rather than printing a 0 a reader would take for a measurement.
{
  const saved = { ws: process.env.DEVLOOP_WORKSPACE, home: process.env.DEVLOOP_HOME };
  try {
    delete process.env.DEVLOOP_WORKSPACE;
    process.env.DEVLOOP_HOME = join(tmpRoot("dl-jobbill-"), "empty-home");
    mkdirSync(process.env.DEVLOOP_HOME, { recursive: true });
    writeFileSync(join(process.env.DEVLOOP_HOME, "registry.json"), "{}");
    const { out } = await capture(() => printJobLaneBill(false, pluginRoot));
    ok(/lessons: no workspace resolved/.test(out),
      `AC3: with no workspace the bill says the lessons figure is the plugin-static floor, not a measurement`);
    ok(/the plugin-static floor/.test(out) && /a real fire adds this project's §14 slice/.test(out),
      `AC3: …and says what a real fire would add on top, so the number is not read as the whole load`);
  } finally {
    if (saved.ws === undefined) delete process.env.DEVLOOP_WORKSPACE; else process.env.DEVLOOP_WORKSPACE = saved.ws;
    if (saved.home === undefined) delete process.env.DEVLOOP_HOME; else process.env.DEVLOOP_HOME = saved.home;
  }
}

console.log(fails === 0 ? "\nJOB_LANE_BILL_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
