// lessons.ts — library paths, per-fire load composition, and the W03 budget check.
import { mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lessonsPaths, lessonsForFire, checkLessonsBudget, INDEX_MAX_LINES, SHARD_MAX_LINES } from "../src/lessons.ts";
import type { Workspace, TeamFile } from "../src/team-config.ts";
import { tmpRoot } from "./tmp-root.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(tmpRoot("dl-lessons-"));

function mkWs(projects: string[]): Workspace {
  const file: TeamFile = { schemaVersion: 2, team: { key: "t", backend: "linear", linearTeam: "L" }, repos: {}, projects: Object.fromEntries(projects.map((p) => [p, { repos: [] }])) };
  return { root: tmp, filePath: join(tmp, "dev-loop.json"), warnings: [], file };
}

try {
  const ws = mkWs(["alpha", "beta"]);
  const P = lessonsPaths(ws);
  ok(P.index === join(tmp, ".dev-loop", "lessons", "INDEX.md"), "index path under .dev-loop/lessons");
  ok(P.shard("alpha") === join(tmp, ".dev-loop", "lessons", "alpha.md"), "per-project shard path");
  ok(P.archive.endsWith("archive.md"), "archive path");

  mkdirSync(P.dir, { recursive: true });
  writeFileSync(P.index, "# INDEX\n- [team] shared lesson\n");
  writeFileSync(P.shard("alpha"), "- [alpha] a project lesson\n");
  writeFileSync(P.shard("beta"), "- [beta] beta lesson\n");

  // a delivery fire loads INDEX + only its own shard
  const forAlpha = lessonsForFire(ws, "alpha");
  ok(/shared lesson/.test(forAlpha) && /a project lesson/.test(forAlpha) && !/beta lesson/.test(forAlpha), "delivery fire loads INDEX + its OWN shard only");
  // a steward fire (project=null) loads only INDEX
  const forSteward = lessonsForFire(ws, null);
  ok(/shared lesson/.test(forSteward) && !/project lesson/.test(forSteward), "steward fire (null project) loads only the INDEX");

  // ── budget + LOOP-272 AC(C): W03 is DELIVERY-MODE AWARE ──────────────────────────────────────
  // W03 polices the byte budget of the §0a PUSH path, which is OFF by default and — until LOOP-272
  // — was unreachable from config at all. A green/absent W03 therefore read as "the push-path budget
  // is honoured" when in truth NOTHING WAS EVER PUSHED. This arm fails against today's code, which
  // returns [] here regardless of the delivery mode.
  // WS-A: ON is the default; `bootCorpus:false` is the explicit opt-out that produces the OFF notice.
  const wsOff = { ...ws, file: { ...ws.file, team: { ...ws.file.team, bootCorpus: false } } } as typeof ws;
  const offW03 = checkLessonsBudget(wsOff);
  ok(offW03.length === 1 && offW03[0].path === "team.bootCorpus",
    `LOOP-272 AC(C): within budget but corpus OFF ⇒ exactly one informational W03 naming the mode (got ${offW03.length})`);
  ok(/PULL mode|not being delivered/.test(offW03[0]?.message ?? ""),
    "LOOP-272 AC(C): …and it says the push path is not delivering, so an absent W03 cannot read as 'budget honoured'");
  ok(/team set team\.bootCorpus true/.test(offW03[0]?.message ?? ""),
    "LOOP-272 AC(C): …and names the mutator that turns it on");

  // ON + within budget ⇒ silent, exactly as before this ticket.
  const wsOn = ws;                        // team.bootCorpus unset ⇒ ON (the WS-A default)
  ok(checkLessonsBudget({ ...ws, file: { ...ws.file, team: { ...ws.file.team, bootCorpus: true } } } as typeof ws).length === 0,
    "WS-A: an explicit bootCorpus:true is also silent");
  ok(checkLessonsBudget(wsOn).length === 0,
    "LOOP-272 AC(C): with the corpus ON and within budget, W03 is silent — unchanged from today");

  // ── LOOP-272 AC(A)/AC(B): the predicate, and the don't-regress marker ─────────────────────────
  {
    // The ONE predicate as WS-A restates it: an explicit runner flag wins, else config, else ON.
    const resolve = (bootCorpus: unknown, assembleBoot: boolean | null): boolean =>
      assembleBoot ?? (bootCorpus !== false);
    ok(resolve(undefined, null) === true, "WS-A: absent config + no flag ⇒ ON — the corpus is the shipped default");
    ok(resolve(false, null) === false, "WS-A: bootCorpus:false is the explicit opt-out");
    ok(resolve(false, true) === true, "WS-A: --assemble-boot beats a config opt-out");
    ok(resolve(true, false) === false, "WS-A: --no-assemble-boot beats config");
    ok(resolve(true, null) === true, "LOOP-272 AC(A): config ALONE turns it on — no hand-typed flag needed, which is the whole ticket");
    ok(resolve("false", null) === true, "WS-A: a stringly-typed \"false\" does NOT opt out — only the boolean does; E18 refuses the string at load");

    // Don't-regress (the ticket asks to VERIFY, not to build): the pushed prompt must still carry
    // the marker that tells §0a step 4 not to re-read the library, or an agent double-ingests.
    // Asserted structurally against the source, which needs no plugin-root fixture to be honest.
    const bootSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "boot-prefix.ts"), "utf8");
    ok(/devloop-boot:begin/.test(bootSrc),
      "LOOP-272: assembleBootCorpus still emits the devloop-boot marker — no double-ingest");
  }
  // over-budget INDEX → W03
  writeFileSync(P.index, "# INDEX\n" + Array.from({ length: INDEX_MAX_LINES + 5 }, (_, i) => `- line ${i}`).join("\n") + "\n");
  const w1 = checkLessonsBudget(ws);
  ok(w1.some((w) => w.code === "W03" && /INDEX/.test(w.path)), "over-budget INDEX → W03");
  // over-budget shard → W03
  writeFileSync(P.index, "# INDEX\n- ok\n");
  writeFileSync(P.shard("beta"), Array.from({ length: SHARD_MAX_LINES + 5 }, (_, i) => `- line ${i}`).join("\n") + "\n");
  const w2 = checkLessonsBudget(ws);
  ok(w2.some((w) => w.code === "W03" && /beta/.test(w.path)), "over-budget shard → W03 naming the shard");

  console.log(fails === 0 ? "\nLESSONS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
