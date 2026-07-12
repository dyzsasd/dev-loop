// rotation.ts — smooth weighted round-robin: exact sequences, weight/enabled handling, cursor persistence,
// and the shared next-project picker (run + Agent View share one cursor).
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { smoothWRRStep, rotationCandidates, stewardProjects, pickAndAdvance, loadSchedulerState, type SchedulerState } from "../src/rotation.ts";
import type { Workspace, TeamFile } from "../src/team-config.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── pure WRR: drive N steps and collect the sequence ──
function sequence(cands: { key: string; weight: number }[], n: number): string {
  let cur: Record<string, number> = {};
  const out: string[] = [];
  for (let i = 0; i < n; i++) { const r = smoothWRRStep(cands, cur); cur = r.cur; out.push(r.pick ?? "-"); }
  return out.join(" ");
}

ok(sequence([{ key: "a", weight: 1 }, { key: "b", weight: 1 }], 6) === "a b a b a b", "1:1 weights alternate");
// True nginx smooth-WRR SPREADS the minority (it does not cluster): 2:1 → a b a a b a.
ok(sequence([{ key: "a", weight: 2 }, { key: "b", weight: 1 }], 6) === "a b a a b a", "2:1 weights → a b a a b a (smooth WRR)");
ok(sequence([{ key: "a", weight: 3 }, { key: "b", weight: 1 }], 8) === "a a b a a a b a", "3:1 weights → a a b a a a b a");
// The canonical nginx SWRR example — proves the algorithm is exactly right.
ok(sequence([{ key: "a", weight: 5 }, { key: "b", weight: 1 }, { key: "c", weight: 1 }], 7) === "a a b a c a a", "5:1:1 → a a b a c a a (canonical nginx SWRR)");
{ // a 2:1 run keeps the exact ratio over a longer window
  const s = sequence([{ key: "a", weight: 2 }, { key: "b", weight: 1 }], 30).split(" ");
  ok(s.filter((x) => x === "a").length === 20 && s.filter((x) => x === "b").length === 10, "2:1 holds the exact 2:1 ratio over 30 fires");
}
ok(sequence([{ key: "solo", weight: 1 }], 3) === "solo solo solo", "single candidate always picked");
ok(smoothWRRStep([], {}).pick === null, "no candidates → null pick (fire skipped)");

// deterministic tie-break: equal weights, the cursor never favors a non-lexicographic key
ok(sequence([{ key: "b", weight: 1 }, { key: "a", weight: 1 }], 4) === "a b a b", "tie-break is lexicographic + input order independent (candidates sorted)");

// ── rotationCandidates filters enabled + weight>0 + drops _team ──
function mkWs(projects: TeamFile["projects"]): Workspace {
  return { root: "/ws", filePath: "/ws/dev-loop.json", warnings: [], file: { schemaVersion: 2, team: { key: "t", backend: "linear", linearTeam: "L" }, repos: {}, projects } };
}
{
  const ws = mkWs({
    a: { repos: [] }, b: { repos: [], weight: 0 }, c: { repos: [], enabled: false }, d: { repos: [], weight: 2 }, _team: { repos: [] },
  });
  const cands = rotationCandidates(ws);
  ok(cands.map((c) => c.key).join(",") === "a,d", "candidates exclude weight:0, enabled:false, and _team");
  ok(cands.find((c) => c.key === "d")!.weight === 2, "candidate weight carried through");
  // T3.2: weight:0 = delivery paused, stewards continue — the steward list keeps b (weight:0) while
  // dropping c (enabled:false) and the _team intake row.
  ok(stewardProjects(ws).join(",") === "a,b,d", "stewardProjects keeps weight:0 (maintenance mode) and drops enabled:false + _team");
}

// ── hot-reload cursor prune: a stale cursor key for a removed project doesn't distort argmax ──
{
  const cands = [{ key: "a", weight: 1 }, { key: "b", weight: 1 }];
  const r = smoothWRRStep(cands, { a: 0, b: 0, ghost: 999 });
  ok(!("ghost" in r.cur), "smoothWRRStep prunes cursor entries for projects no longer in the candidate set");
}

// ── cursor persistence + shared picker via the real CLI ──
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-rot-")));
try {
  const HOME = join(tmp, "home");
  const root = join(tmp, "ws");
  mkdirSync(join(root, "ra"), { recursive: true });
  mkdirSync(join(root, "rb"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2, team: { key: "rot-team", backend: "linear", linearTeam: "L" },
    repos: { ra: { path: "ra" }, rb: { path: "rb" } },
    projects: { alpha: { weight: 2, repos: [{ ref: "ra", role: "primary" }] }, beta: { weight: 1, repos: [{ ref: "rb", role: "primary" }] } },
  }));
  const next = (agent: string) => {
    const r = spawnSync("node", [join(hubRoot, "src", "rotation.ts"), "--agent", agent], { cwd: root, env: { ...process.env, DEVLOOP_HOME: HOME }, encoding: "utf8" });
    return (r.stdout ?? "").trim();
  };
  // pm fires 6 times (2:1) → alpha beta alpha alpha beta alpha; cursor persisted across processes.
  const seq = [next("pm"), next("pm"), next("pm"), next("pm"), next("pm"), next("pm")].join(" ");
  ok(seq === "alpha beta alpha alpha beta alpha", "CLI next-project persists the cursor across processes (2:1 sequence)");
  // a DIFFERENT agent has an independent cursor (interleaving pm and qa must not desync either).
  const qa1 = next("qa");
  ok(qa1 === "alpha", "a different agent starts its own cursor (independent rotation)");

  // "run + Agent View share one cursor": load state, advance in-process, then the CLI continues it. After
  // 6 pm picks the cursor is back at [0,0], so pick 7 = alpha (in-proc), pick 8 = beta (CLI), pick 9 = alpha.
  const ws2 = { root: realpathSync(root), filePath: join(realpathSync(root), "dev-loop.json"), warnings: [], file: JSON.parse(spawnSync("node", ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1]))", join(root, "dev-loop.json")], { encoding: "utf8" }).stdout) } as Workspace;
  process.env.DEVLOOP_HOME = HOME;
  const st: SchedulerState = loadSchedulerState(ws2);
  const inProc = pickAndAdvance(ws2, "pm", st); // pick 7
  ok(inProc === "alpha", "in-process pickAndAdvance continues the SAME cursor the CLI advanced (shared rotation)");
  ok(next("pm") === "beta", "…the CLI then continues from the in-process advance (pick 8 = beta)");
  ok(next("pm") === "alpha", "…and pick 9 = alpha (shared pm cursor, uninterrupted)");

  console.log(fails === 0 ? "\nROTATION_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
