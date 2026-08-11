// LOOP-451/LOOP-572 — the §21a `Design:` pointer as a parsed VALUE, and the `doc get|history
// --pointer` flag that consumes it.
//
// Two layers, deliberately both:
//   • UNIT — parseDocPointer() over the three §21a forms + the malformed tokens. It is imported
//     directly from src/design-parent.ts, which is possible only because the resolver lives there
//     rather than in cli-agentops.ts (that file ends in a top-level `await main()`, so importing it
//     would run the CLI).
//   • END-TO-END — the REAL `node src/cli.ts doc get …` against an isolated temp hub DB, because a
//     green predicate proves nothing about whether the flag is wired to it. AC3's round-trip is
//     asserted by COMPARING TWO OUTPUTS byte-for-byte, not by reasoning that they should match.
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { parseDocPointer } from "../src/design-parent.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const HUB = dirname(dirname(fileURLToPath(import.meta.url))); // …/hub — so cwd does not decide the run
const ROOT = "/tmp/hub-doc-pointer-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const DB = join(ROOT, "hub.db");

let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

// ═══ 1. UNIT — parseDocPointer over the three §21a forms (AC2) ══════════════════════════════════════
{
  const hub = parseDocPointer("hubDoc:design/scheduler-pause");
  ok(hub.ok && hub.pointer.form === "hubDoc" && hub.pointer.kind === "design" && hub.pointer.slug === "scheduler-pause",
    "form 1 — hubDoc:design/scheduler-pause → {hubDoc, design, scheduler-pause}");

  // Kind-general: §21a spells the form with `design` because that is the multi-instance kind, but the
  // flag addresses the doc op, which has more than one kind.
  const other = parseDocPointer("hubDoc:strategy/north-star");
  ok(other.ok && other.pointer.form === "hubDoc" && other.pointer.kind === "strategy" && other.pointer.slug === "north-star",
    "form 1 — a non-design kind resolves rather than being refused");

  const file = parseDocPointer("docs/design/scheduler-pause.md");
  ok(file.ok && file.pointer.form === "repoFile" && file.pointer.kind === "design" && file.pointer.slug === "scheduler-pause",
    "form 2 — docs/design/scheduler-pause.md → {repoFile, design, scheduler-pause}");

  const parent = parseDocPointer("parent LOOP-401");
  ok(parent.ok && parent.pointer.form === "parent" && parent.pointer.parentId === "LOOP-401",
    "form 3 — parent LOOP-401 → {parent, LOOP-401}");

  // The two doc spellings must land on the SAME slug — the invariant docSlugOf already holds, now
  // asserted through the new entry point so the two parses cannot drift apart silently.
  const a = parseDocPointer("hubDoc:design/scheduler-pause");
  const b = parseDocPointer("docs/design/scheduler-pause.md");
  ok(a.ok && b.ok && a.pointer.form !== "parent" && b.pointer.form !== "parent"
    && (a.pointer as { slug: string }).slug === (b.pointer as { slug: string }).slug,
    "forms 1 and 2 normalise to the same slug");

  // Inherited from the grammar's own history, and asserted here so a future edit cannot drop them:
  // the code-span wrap (LOOP-372) and the trailing full stop (LOOP-361) were both bought with live
  // misroutes. A fresh parser would not have had either.
  const wrapped = parseDocPointer("`hubDoc:design/scheduler-pause`");
  ok(wrapped.ok && wrapped.pointer.form === "hubDoc" && wrapped.pointer.slug === "scheduler-pause",
    "a code-span-wrapped pointer still binds (LOOP-372)");
  const dotted = parseDocPointer("docs/design/scheduler-pause.md.");
  ok(dotted.ok && dotted.pointer.form === "repoFile" && dotted.pointer.slug === "scheduler-pause",
    "a pointer at the end of a sentence still binds (LOOP-361)");
}

// ═══ 2. UNIT — a malformed token is a TYPED failure, never a silent undefined (AC2) ═════════════════
{
  // Each arm names the code it must produce: the point of the code is that these are DIFFERENT
  // failures. A parser that collapsed them all to one would still pass an `!ok` assertion.
  const cases: [string, string][] = [
    ["", "empty"],
    ["   ", "empty"],
    ["hubDoc:design", "hubdoc-shape"],          // kind, no slug
    ["hubDoc:/scheduler-pause", "hubdoc-shape"], // slug, no kind
    ["hubDoc:design/a/b", "hubdoc-shape"],       // an extra segment must REFUSE, not truncate to a/b
    ["docs/scheduler-pause.md", "repofile-shape"], // not under docs/design/
    ["docs/design/", "repofile-shape"],
    ["parent", "parent-shape"],                  // the form with no id
    ["LOOP-401", "unrecognized"],                // a bare id is not a pointer
    ["hubDocdesign/x", "unrecognized"],
  ];
  for (const [raw, code] of cases) {
    const r = parseDocPointer(raw);
    ok(!r.ok && r.code === code, `malformed '${raw}' → typed failure code '${code}' (got ${r.ok ? "ok" : r.code})`);
    ok(!r.ok && typeof r.message === "string" && r.message.length > 0, `malformed '${raw}' carries a message`);
  }
  // The return is never undefined for ANY input — the property the AC names, checked as a property.
  for (const raw of ["", "x", "hubDoc:", "parent ", "docs/design/x.md"]) {
    ok(parseDocPointer(raw) !== undefined && typeof parseDocPointer(raw).ok === "boolean",
      `parseDocPointer('${raw}') returns a discriminated result, not undefined`);
  }
}

// ═══ 3. END-TO-END — seed an isolated hub with a real design doc ════════════════════════════════════
{
  const db = openDb(DB);
  ensureSeed(db, "dpt", "Doc Pointer Test", "DP");
  db.close();
}
function cli(args: string[], env: Record<string, string | undefined> = {}, stdin?: string): { status: number | null; stdout: string; stderr: string } {
  const base: Record<string, string | undefined> = { ...scrubFireEnv(), DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "dpt", DEVLOOP_ACTOR: "senior-dev" };
  delete base.DEVLOOP_TEAM_SCOPE; delete base.DEVLOOP_DEV_SPLIT; delete base.DEVLOOP_HUB_PORT; delete base.DEVLOOP_PROJECTS_JSON;
  const r = spawnSync("node", [join(HUB, "src/cli.ts"), ...args], { cwd: HUB, encoding: "utf8", timeout: 60000, env: { ...base, ...env } as NodeJS.ProcessEnv, input: stdin ?? "" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const SLUG = "scheduler-pause";
const saved = cli(["doc", "save", "--slug", SLUG, "--kind", "design", "--base-version", "0"], {}, "# Scheduler pause\n\nthe living design.\n");
ok(saved.status === 0, `fixture: doc save --kind design --slug ${SLUG} → exit 0 (got ${saved.status}; ${saved.stderr.trim().slice(-200)})`);

// ═══ 4. AC3 — the round-trip is asserted by comparing OUTPUTS ═══════════════════════════════════════
{
  const viaFlags = cli(["doc", "get", "--slug", SLUG, "--kind", "design"]);
  const viaPointer = cli(["doc", "get", "--pointer", `hubDoc:design/${SLUG}`]);
  ok(viaFlags.status === 0 && viaPointer.status === 0, `both spellings exit 0 (flags ${viaFlags.status}, pointer ${viaPointer.status})`);
  ok(viaPointer.stdout === viaFlags.stdout && viaPointer.stdout.length > 0,
    "AC3 — `doc get --pointer hubDoc:design/<slug>` and `--slug <slug> --kind design` produce the SAME BYTES");
  // The control for that assertion: a DIFFERENT slug must NOT match. Without it, a resolver that
  // ignored --pointer entirely and always read the same doc would pass the equality above.
  const otherSlug = cli(["doc", "save", "--slug", "other-module", "--kind", "design", "--base-version", "0"], {}, "# Other\n");
  ok(otherSlug.status === 0, "fixture: a second design doc exists");
  const viaOther = cli(["doc", "get", "--pointer", "hubDoc:design/other-module"]);
  ok(viaOther.status === 0 && viaOther.stdout !== viaFlags.stdout,
    "control — a pointer at a different slug returns different bytes (the flag is read, not ignored)");

  // The repo-file spelling addresses the same hub doc (forms 1 and 2 name one design, §21a).
  const viaFile = cli(["doc", "get", "--pointer", `docs/design/${SLUG}.md`]);
  ok(viaFile.status === 0 && viaFile.stdout === viaFlags.stdout,
    "AC3 — the repo-file spelling resolves to the same doc, same bytes");

  // `doc history` takes the flag too (dfff4ff wired both verbs; a test on `get` alone would not say so).
  const histFlags = cli(["doc", "history", "--slug", SLUG]);
  const histPointer = cli(["doc", "history", "--pointer", `hubDoc:design/${SLUG}`]);
  ok(histFlags.status === 0 && histPointer.stdout === histFlags.stdout && histPointer.stdout.length > 0,
    "AC3 — `doc history --pointer` round-trips identically");
}

// ═══ 5. AC4 — the wrong-form --slug error names the correct invocation ══════════════════════════════
{
  const wrong = cli(["doc", "get", "--slug", `design/${SLUG}`]);
  ok(wrong.status === 2, `--slug design/<slug> → usage error exit 2 (got ${wrong.status})`);
  ok(wrong.stderr.includes(`--slug ${SLUG} --kind design`),
    `AC4 — the error names the correct invocation '--slug ${SLUG} --kind design'`);
  ok(wrong.stderr.includes(SLUG), `AC4 — the error contains the literal resolved slug '${SLUG}'`);
  // The hubDoc: spelling passed to --slug is caught by the same guard.
  const wrongHub = cli(["doc", "get", "--slug", `hubDoc:design/${SLUG}`]);
  ok(wrongHub.status === 2 && wrongHub.stderr.includes("looks like a Design: pointer"),
    "AC4 — `--slug hubDoc:design/<slug>` is caught by the same guard");
}

// ═══ 6. The flag's own contract: exclusivity, absence, and the parent form ══════════════════════════
{
  const both = cli(["doc", "get", "--pointer", `hubDoc:design/${SLUG}`, "--kind", "design"]);
  ok(both.status === 2 && both.stderr.includes("mutually exclusive"), "--pointer with --kind → exit 2, mutually exclusive");
  const bothSlug = cli(["doc", "get", "--pointer", `hubDoc:design/${SLUG}`, "--slug", SLUG]);
  ok(bothSlug.status === 2 && bothSlug.stderr.includes("mutually exclusive"), "--pointer with --slug → exit 2, mutually exclusive");

  // REGRESSION (LOOP-572): --slug and --kind do NOT exclude each other. `doc get --kind design
  // --slug <slug>` is what gen-cheatsheets.ts prints into junior-dev's cheat-sheet for the Step-4
  // `Design:` read, and what this verb accepted before --pointer existed. A three-way exclusivity
  // check turned it into an exit-2 usage error, which no --pointer-only test can see.
  const pair = cli(["doc", "get", "--kind", "design", "--slug", SLUG]);
  ok(pair.status === 0, `--kind design --slug <slug> together → exit 0, NOT a usage error (got ${pair.status}; ${pair.stderr.trim().split("\n").pop()})`);
  const none = cli(["doc", "get"]);
  ok(none.status === 2 && none.stderr.includes("--pointer"), "no selector → exit 2, and the message advertises --pointer");
  const bad = cli(["doc", "get", "--pointer", "hubDoc:design"]);
  ok(bad.status === 2 && bad.stderr.includes("hubDoc:<kind>/<slug>"), "a malformed pointer → exit 2 naming the expected form");

  // A `parent <id>` pointer is WELL-FORMED and simply does not name a doc. It must not be reported as
  // malformed — that would send the reader to fix the one part that is correct.
  const asParent = cli(["doc", "get", "--pointer", "parent LOOP-401"]);
  ok(asParent.status === 2, "`--pointer parent <id>` → exit 2 (doc get cannot serve a ticket)");
  ok(asParent.stderr.includes("dev-loop ticket LOOP-401"), "the parent form routes to `dev-loop ticket <id>`");
  ok(!asParent.stderr.includes("malformed") && !asParent.stderr.includes("unrecognized"),
    "the parent form is NOT reported as malformed — it is valid, just not a doc");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
