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
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONVENTIONS_BUDGETS } from "../src/context-bill.ts"; // LOOP-238: the conventions ratchet
import { conventionsSlice } from "../src/conventions-verb.ts";
import { loadWorkspace, type Workspace } from "../src/team-config.ts";
import { tryResolveWorkspace } from "../src/workspace.ts";
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
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, SHARD_MAX_BYTES, SHARD_MAX_LINES, STRATEGY_DOC_MAX_BYTES } from "../src/lessons.ts";
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
for (const f of ["notify.md", "investigation-protocol.md", "backend-service.md",
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

  // The DEFAULT resolver path (LOOP-406). The band fixtures below inject `resolveStat`, so nothing
  // else would notice if the default stopped being `tryResolveStrategyDocStat` — this call is the only
  // coverage that the two-argument production form still resolves the live workspace doc at all.
  // What it can assert is band-INDEPENDENT: this host's doc sits in whichever band it sits in (that is
  // the ticket's finding — an ambient doc is not a fixture), so it asserts the invariant that holds in
  // every band, plus the message shape of whichever line did emit.
  {
    const warns: string[] = [];
    const infos: string[] = [];
    const ws = tryResolveWorkspace();
    if (ws) {
      checkStrategyDocBudget(
        ws,
        (msg) => warns.push(msg),
        (msg) => infos.push(msg),
      );
      ok(warns.length + infos.length <= 1,
        `LOOP-406: the default resolver emits at most ONE line — the bands are exclusive (got ${warns.length} warn + ${infos.length} info)`);
      for (const line of warns) {
        ok(/\[W37\]/.test(line), "LOOP-282: the over-budget warning carries W37");
        ok(/budget/.test(line) && /KB/.test(line), "LOOP-282: …naming the measured bytes and the limit");
        ok(/strategy-archive/.test(line), "LOOP-282: …and the §20 R2 remediation");
      }
      for (const line of infos) {
        ok(!/\[W37\]/.test(line), "LOOP-353: soft advisory line does not carry W37");
        ok(/strategy-archive/.test(line), "LOOP-353: soft advisory names the §20 R2 remedy");
      }
    }
  }
}

// ── LOOP-353 / LOOP-406: W37 warning band — soft line before the hard budget ─────────────────────
// LOOP-353 shipped the band correctly and the tests for it as SIX assertions about constants
// (`warnAt > 0`, `x + 1 > x`, `WARN_FRACTION === 0.8`, …), none of which called the function. Measured
// on the merge commit 1673c9b: disabling the soft-band emission left the suite green. LOOP-406 removes
// those six and drives the real function through the `resolveStat` seam instead, so each band is
// exercised on every host rather than whichever one this workspace's live doc happens to sit in.
//
// The counts are asserted EXACTLY (=== 0 / === 1), never `if (x.length)` — a shape-branch is what let
// the pre-existing ambient block pass in every band, including with the feature deleted.
{
  // The band opens at 80% of the hard budget — LOOP-353's specified fraction, written here as the SPEC
  // literal rather than imported from STRATEGY_DOC_WARN_FRACTION. A fixture derived from the constant it
  // is checking moves with it, so a silent change of the fraction would stay green; derived from the spec,
  // fixtures 1 and 2 below fail the moment the product's band starts anywhere else. That is the
  // behavioural REPLACEMENT AC5 allows for LOOP-353's `WARN_FRACTION === 0.8` (a constant compared to its
  // own literal), and it is why that assertion is not simply deleted.
  const SPEC_WARN_FRACTION = 0.8;
  const warnAt = Math.round(STRATEGY_DOC_MAX_BYTES * SPEC_WARN_FRACTION);
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  // Drive the real check with a doc of exactly `bytes`, bypassing the ambient workspace.
  //
  // The workspace argument (LOOP-426: W37 measures the workspace it is PASSED, not the ambient env) is
  // poisoned rather than stubbed. `resolveStat` is meant to replace the ambient resolution ENTIRELY, so
  // nothing downstream of it may touch `ws`; if that ever stopped holding, these fixtures would quietly
  // go back to measuring the host's own doc — which is the exact defect LOOP-406 exists to remove. A
  // proxy that throws on any access turns that silent regression into a loud one.
  const POISONED_WS = new Proxy({} as Workspace, {
    get(_t, prop) { throw new Error(`LOOP-406: checkStrategyDocBudget read ws.${String(prop)} despite an injected resolveStat`); },
  });
  const run = (bytes: number) => {
    const warns: string[] = [];
    const infos: string[] = [];
    checkStrategyDocBudget(
      POISONED_WS,
      (msg) => warns.push(msg),
      (msg) => infos.push(msg),
      () => ({ bytes, lines: 10, label: "docs/STRATEGY.md" }),
    );
    return { warns, infos };
  };

  // Fixture 1 — under the soft threshold: silent. Boundary value (warnAt - 1), because the band edge
  // is where an `>` / `>=` slip lives; a comfortable 10 KB would pass against a broken comparison.
  {
    const { warns, infos } = run(warnAt - 1);
    ok(warns.length === 0, `LOOP-406 AC2: ${kb(warnAt - 1)} (one byte under the soft threshold) emits NO warning (got ${warns.length})`);
    ok(infos.length === 0, `LOOP-406 AC2: …and NO advisory either — under the band the check is silent (got ${infos.length})`);
  }

  // Fixture 2 — at the soft threshold, under the hard budget: exactly one info, no warn. This is the
  // fixture LOOP-353 AC4 asked for and never got: it fails against pre-LOOP-353 code (no soft band)
  // and against any tree where the soft emission is disabled.
  {
    const at = warnAt;
    const headroom = STRATEGY_DOC_MAX_BYTES - at;
    const { warns, infos } = run(at);
    ok(warns.length === 0, `LOOP-406 AC2: ${kb(at)} is within the hard budget — no W37 warning (got ${warns.length})`);
    ok(infos.length === 1, `LOOP-406 AC2: …and EXACTLY one soft advisory (got ${infos.length})`);
    const line = infos[0] ?? "";
    ok(line.includes(kb(at)), `LOOP-406 AC2: the advisory names the measured size ${kb(at)}`);
    ok(line.includes(kb(STRATEGY_DOC_MAX_BYTES)), `LOOP-406 AC2: …the budget ${kb(STRATEGY_DOC_MAX_BYTES)}`);
    ok(line.includes(kb(headroom)), `LOOP-406 AC2: …the remaining headroom ${kb(headroom)}`);
    ok(line.includes("§20 R2") && line.includes("strategy-archive/"), "LOOP-406 AC2: …and the §20 R2 remedy");
    ok(!line.includes("[W37]"), "LOOP-406 AC2: …carrying no W37 code — the soft band preserves DOCTOR_OK");
  }

  // Fixture 3 — over the hard budget: exactly one W37 warning and ZERO infos. The zero-infos half is
  // LOOP-353's AC2 exclusivity claim, which nothing tested; it fails if the hard branch stops
  // returning early and both lines emit.
  {
    const at = STRATEGY_DOC_MAX_BYTES + 1;
    const { warns, infos } = run(at);
    ok(warns.length === 1, `LOOP-406 AC2: one byte over the budget emits EXACTLY one warning (got ${warns.length})`);
    ok(infos.length === 0, `LOOP-406 AC2/AC4: …and ZERO advisories — the two bands are exclusive (got ${infos.length})`);
    ok((warns[0] ?? "").includes("[W37]"), "LOOP-406 AC2: …and it is W37");
  }

  // The hard budget is inclusive on the safe side: exactly AT the budget is WITHIN it. LOOP-282
  // asserted this as `!(under.bytes > STRATEGY_DOC_MAX_BYTES)` — the comparison restated, not the
  // function's answer to it. With the seam it can be asked of the function directly.
  {
    const { warns } = run(STRATEGY_DOC_MAX_BYTES);
    ok(warns.length === 0, `LOOP-406: exactly ${kb(STRATEGY_DOC_MAX_BYTES)} is WITHIN budget — the gate is not off by one (got ${warns.length} warning(s))`);
  }
}

console.log(fails === 0 ? "\nCONTEXT_BUDGET_OK" : `\n${fails} CHECK(S) FAILED — a SKILL is over budget or its Sections line drifted`);
process.exit(fails === 0 ? 0 : 1);
