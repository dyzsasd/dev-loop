// lessons.ts — library paths, per-fire load composition, and the W03 budget check.
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lessonsPaths, lessonsForFire, checkLessonsBudget, INDEX_MAX_LINES, SHARD_MAX_LINES } from "../src/lessons.ts";
import type { Workspace, TeamFile } from "../src/team-config.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-lessons-")));

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

  // budget: within budget → no W03
  ok(checkLessonsBudget(ws).length === 0, "within budget → no W03");
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
