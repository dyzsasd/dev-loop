// A suite's temp tree is removed when the suite ends — and no suite creates one outside the helper.
//
// Suites built their workspaces with `mkdtempSync(join(tmpdir(), "dl-…"))` and mostly never removed
// them. Each tree holds a whole workspace (hub.db, worktrees, node fixtures), so the residue compounds:
// 3264 directories and 1.3 GB over four days on the maintainer's machine, the oldest three days old.
// Every suite passed the whole time. The runner has no view of what a suite leaves on disk — the same
// class of blind spot as a fire's leaked background process (fire-group-reap.ts).
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpRoot } from "./tmp-root.ts";
import { codeOnly } from "./code-only.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// Fixtures are written at runtime, NOT committed under test/, because AC4 below asserts over the tracked
// suites and a fixture that deliberately leaks would be indistinguishable from a real regression.
const stage = tmpRoot("dl-tmproot-sweep-");
const helper = join(here, "tmp-root.ts");
const fixture = (name: string, body: string) => {
  const p = join(stage, name);
  writeFileSync(p, body);
  return p;
};
const runFixture = (p: string) => {
  const r = spawnSync("node", [p], { encoding: "utf8", timeout: 60_000 });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status, path: (r.stdout ?? "").trim().split("\n").pop() ?? "" };
};

// AC1 — the helper's whole point.
const viaHelper = runFixture(fixture("via-helper.mjs", `
import { tmpRoot } from ${JSON.stringify(helper)};
const d = tmpRoot("dl-sweep-probe-");
if (!(await import("node:fs")).existsSync(d)) { console.error("fixture broken: dir absent while running"); process.exit(9); }
console.log(d);
process.exit(0);
`));
ok(viaHelper.status === 0 && viaHelper.path !== "", `fixture: a suite using tmpRoot ran and reported its tree (${viaHelper.status})${viaHelper.status === 0 ? "" : `\n${viaHelper.out.slice(-400)}`}`);
ok(viaHelper.path !== "" && !existsSync(viaHelper.path), `AC1: the tree is gone once the suite exits (${viaHelper.path})`);

// AC2 — CONTROL: the same probe without the helper MUST leave residue. Without this arm AC1 would pass
// just as happily against a broken existsSync or a mistyped path.
const raw = runFixture(fixture("raw.mjs", `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
console.log(mkdtempSync(join(tmpdir(), "dl-sweep-control-")));
process.exit(0);
`));
ok(raw.path !== "" && existsSync(raw.path), `AC2: control — a raw mkdtempSync tree DOES survive its process, so AC1 is a real check`);
if (raw.path && existsSync(raw.path)) (await import("node:fs")).rmSync(raw.path, { recursive: true, force: true });

// AC3 — a failing suite is the common case for residue: it is the run someone re-runs, over and over.
const failing = runFixture(fixture("failing.mjs", `
import { tmpRoot } from ${JSON.stringify(helper)};
console.log(tmpRoot("dl-sweep-failing-"));
process.exit(1);
`));
ok(failing.status === 1, `fixture: the failing probe exited non-zero (${failing.status})`);
ok(failing.path !== "" && !existsSync(failing.path), `AC3: …and its tree is swept anyway (${failing.path})`);

// AC4 — the structural arm, and the one that keeps this fix from rotting: a suite added next month that
// calls mkdtempSync directly reintroduces the leak silently. Reads the tracked files, so an untracked
// scratch file in test/ cannot trip it.
const tracked = spawnSync("git", ["ls-files", "test"], { cwd: join(here, ".."), encoding: "utf8" }).stdout
  .split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".ts")).map((l) => l.replace(/^test\//, ""));
ok(tracked.length > 50, `fixture: git ls-files resolved the tracked suites (${tracked.length} found)`);
// Scanned through codeOnly (the repo's one source-to-executable-text reduction), so a comment or a
// fixture string that QUOTES the old pattern — this file's own header does — is not read as a call.
// Matching raw source would make the guard unmaintainable: every suite that documents the leak would
// have to be exempted, and an exemption list is what stops a guard from guarding.
// Keyed on the CALL, not on the argument expression. The first version matched
// `mkdtempSync(join(tmpdir()` literally, which a rewrite of the same call slips past six ways — a
// namespace import (`fs.mkdtempSync`), `path.join(...)`, string concatenation, a variable holding the
// prefix, the async `mkdtemp`, a template literal. A guard that reads one spelling of a call reports
// "clean" for the other six, which is worse than no guard: it looks like coverage.
// The rule a suite has to follow is simply "get temp roots from tmpRoot", so the guard is now the same
// sentence: no tracked suite calls mkdtemp at all. `codeOnly` keeps prose and fixture strings out — this
// file's own header quotes the old pattern, and its AC2 fixture builds the forbidden call on purpose.
const MKDTEMP_CALL = /\bmkdtemp(Sync)?\s*\(/;
const direct = tracked.filter((f) => f !== "tmp-root.ts"
  && MKDTEMP_CALL.test(codeOnly(readFileSync(join(here, f), "utf8"))));
ok(direct.length === 0, `AC4: no tracked suite calls mkdtemp at all — temp roots come from the helper (offenders: ${direct.join(", ") || "none"})`);

// …and the detector itself is checked against the spellings the literal one missed. Without this, a
// later "simplification" back to a single literal would leave AC4 green and blind again.
const SPELLINGS: [string, string][] = [
  ["namespace import", 'const d = fs.mkdtempSync(join(tmpdir(), "dl-x-"));'],
  ["qualified join", 'const d = mkdtempSync(path.join(os.tmpdir(), "dl-x-"));'],
  ["string concat", 'const d = mkdtempSync(tmpdir() + "/dl-x-");'],
  ["prefix in a variable", 'const p = join(tmpdir(), "dl-x-"); const d = mkdtempSync(p);'],
  ["async form", 'const d = await mkdtemp(join(tmpdir(), "dl-x-"));'],
  ["template literal", 'const d = mkdtempSync(`${tmpdir()}/dl-x-`);'],
];
const missed = SPELLINGS.filter(([, code]) => !MKDTEMP_CALL.test(code)).map(([name]) => name);
ok(missed.length === 0, `AC4: the detector catches every spelling of the call, not one (missed: ${missed.join(", ") || "none"})`);
// The literal it replaced, kept as the control: an arm claiming the new detector is BETTER has to show
// the old one failing. Measured at 5 of 6, not 6 — the namespace-import spelling still matched, because
// the pattern was unanchored and `fs.` is just a prefix in front of it. The review that surfaced this
// counted six; five is the number the code gives.
const oldDetector = /mkdtempSync\(\s*join\(\s*tmpdir\(\)/;
const oldMissed = SPELLINGS.filter(([, code]) => !oldDetector.test(code)).map(([name]) => name);
ok(oldMissed.length === 5 && !oldMissed.includes("namespace import"),
  `…and the literal it replaced missed ${oldMissed.length} of ${SPELLINGS.length} — all but the namespace import, which an unanchored match caught by accident (missed: ${oldMissed.join(", ")})`);

// AC5 — the helper is registered as a non-suite, or the runner counts it as a phantom passing test.
const listed = JSON.parse(spawnSync("node", [join(here, "run-all.ts"), "--list"], { encoding: "utf8" }).stdout || "{}");
ok(Object.hasOwn(listed.nonSuites ?? {}, "tmp-root.ts"), "AC5: tmp-root.ts is declared in NON_SUITES");
ok(!(listed.discovered ?? []).includes("tmp-root.ts"), "AC5: …so the runner does not run it as a suite");

// AC6 — the sweep must not reach beyond what it created. A helper that removed its PARENT would take
// $TMPDIR with it; this pins the blast radius to the handed-out directories.
const sibling = tmpRoot("dl-sweep-sibling-");
ok(existsSync(sibling) && readdirSync(stage).length > 0, "AC6: a second tree and the staging tree coexist — the sweep is per-directory, not a parent wipe");


// ── A killed suite cannot sweep, so the runner must ───────────────────────────────────────────────
// tmp-root.ts installs no signal handler on purpose (several suites assert on signal delivery), which
// leaves the one signal the runner itself sends — the hang ceiling's SIGKILL — with no in-suite cleanup.
// Six trees from six different suites were found surviving a day of local runs. run-all now hands each
// suite a manifest path and drains it afterwards. Measured end to end: a real run-all, over a real
// hanging suite, killed by a real (shortened) ceiling.
{
  const dir = tmpRoot("dl-runner-drain-");
  for (const f of ["run-all.ts", "tmp-root.ts", "env-scrub.ts", "daemon-pids.ts"]) {
    copyFileSync(join(here, f), join(dir, f));
  }
  // Takes a temp root, announces it, then never returns — the shape the ceiling exists to kill.
  writeFileSync(join(dir, "zz-hang.ts"), [
    `import { tmpRoot } from "./tmp-root.ts";`,
    `const t = tmpRoot("dl-drain-victim-");`,
    `console.log("VICTIM_ROOT=" + t);`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"));

  const run = spawnSync("node", [join(dir, "run-all.ts")], {
    env: { ...scrubFireEnv(), DEVLOOP_SUITE_TIMEOUT_MS: "4000" },
    encoding: "utf8", timeout: 120_000,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const victim = /VICTIM_ROOT=(\S+)/.exec(out)?.[1] ?? "";

  ok(victim !== "", `AC7 fixture: the hanging suite took a temp root and named it (${victim || "not announced"})`);
  ok(/exceeded 4s and was killed/.test(out), `AC7 fixture: the ceiling actually SIGKILLed it, so no in-suite hook ran`);
  ok(victim !== "" && !existsSync(victim), `AC7: the runner removed the tree the killed suite could not (${victim})`);
  ok(/🧹 zz-hang\.ts ended without sweeping 1 temp root/.test(out), `AC7: …and said so, instead of accumulating it silently`);
}

console.log(fails === 0 ? "\ntmp-root-sweep: OK" : `\ntmp-root-sweep: ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
