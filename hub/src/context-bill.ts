#!/usr/bin/env node
// context-bill.ts — the per-fire context-size authority + bill (operator task #8: control the
// per-fire context size; design record docs/design/skill-template.md). One module owns the three
// things the section-selective boot rule (conventions §0a step 1) depends on:
//   • BUDGETS — the machine-readable per-SKILL prose ceilings (+ the cheat-block line ceiling).
//     THIS TABLE is the single enforcement authority; docs/design/skill-template.md §7 is its
//     design record (the prose rationale), deliberately NOT a parsed source — markdown-table
//     parsing is the fragile option. A budget change edits both, and hub/test/context-budget.ts
//     fails when a skills/ dir and this table disagree on coverage.
//   • The measurement primitives — the prose/cheat split on the cli-cheatsheet markers, the
//     `Sections:` line grammar (template §5), and the conventions §-span map (template §5 span
//     semantics: fence-aware, `###` lettered children nest inside their `##` parent, the
//     unnumbered "Topology at a glance" block is always-read, spans tile the file).
//   • contextBill() — what `dev-loop metrics --context` prints: per agent, SKILL prose + cheat
//     block + the UNION of its cited conventions spans (+ the always-read preamble) + the lessons
//     caps = the estimated per-fire boot load in lines/bytes (+ ~tokens at 4 bytes/token).
// Lessons budgets stay lessons.ts's (INDEX_MAX_* / SHARD_MAX_* — imported, never duplicated).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, SHARD_MAX_BYTES, SHARD_MAX_LINES } from "./lessons.ts";

export interface Budget { lines: number; bytes: number }
export interface Measure { lines: number; bytes: number }

// ─── the budget table (template §7 — final numbers; prose = file minus the cheat-block span) ───────
export const BUDGETS: Record<string, Budget> = {
  "pm-agent":            { lines: 300, bytes: 22 * 1024 },
  "qa-agent":            { lines: 220, bytes: 16 * 1024 },
  "senior-dev-agent":    { lines: 220, bytes: 16 * 1024 },
  "junior-dev-agent":    { lines: 220, bytes: 16 * 1024 },
  "sweep-agent":         { lines: 220, bytes: 16 * 1024 },
  "dev-agent":           { lines: 260, bytes: 18 * 1024 }, // hosts the canonical Step 0–7 ship sequence senior/junior inherit by reference (§21a)
  "reflect-agent":       { lines: 200, bytes: 14 * 1024 },
  "ops-agent":           { lines: 200, bytes: 14 * 1024 },
  "architect-agent":     { lines: 200, bytes: 14 * 1024 },
  "communication-agent": { lines: 200, bytes: 14 * 1024 },
  "add-project":         { lines: 150, bytes: 10 * 1024 },
  "add-repo":            { lines: 150, bytes: 10 * 1024 },
  "sync-project":        { lines: 150, bytes: 10 * 1024 },
  "sync-repo":           { lines: 150, bytes: 10 * 1024 },
  "operator-console":    { lines: 160, bytes: 11 * 1024 }, // one-click §3: the conversational cockpit (operator-present, no cheat block)
};
// Cheat-sheet blocks are generator-owned (gen-cheatsheets.ts); growth past this = trim the
// generator template, never the budget (sweep's block is already 91 lines).
export const CHEAT_MAX_LINES = 95;
// Warn-only ceiling on the whole conventions file — the lint prints the per-section byte listing
// but never fails on it (anchors are load-bearing; shrinking is an editorial task, not a gate).
export const CONVENTIONS_WARN_BYTES = 200 * 1024;
export const BYTES_PER_TOKEN = 4; // the bill's ~token estimate

// Line-based byte accounting: every physical line costs byteLength + 1 (its newline), so a file's
// prose + cheat measures sum exactly to the file size PROVIDED the file ends with a newline — the
// lint enforces that trailing newline on every measured file, keeping the invariant exact.
// `splitLines` drops the phantom "" element a trailing newline produces.
export const splitLines = (text: string): string[] => {
  const ls = text.split("\n");
  if (ls.length && ls[ls.length - 1] === "") ls.pop();
  return ls;
};
export const measureOf = (lines: readonly string[]): Measure =>
  ({ lines: lines.length, bytes: lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0) });

// Plugin layout: repo root in dev (hub/src/../../), package root when published (dist/../).
const here = dirname(fileURLToPath(import.meta.url));
export function pluginRoot(): string {
  for (const c of [join(here, "..", ".."), join(here, "..")]) {
    if (existsSync(join(c, "skills")) && existsSync(join(c, "references", "conventions.md"))) return c;
  }
  throw new Error("context-bill: cannot locate skills/ + references/conventions.md next to this module");
}

// ─── SKILL parsing ──────────────────────────────────────────────────────────────────────────────────
export interface SkillParts { prose: string[]; cheat: string[] }
// Markers match the EXACT full line gen-cheatsheets.ts emits — a prose sentence merely mentioning
// "cli-cheatsheet:begin" must never truncate the measured prose (codex review 2026-07-12).
const MARKER_BEGIN = /^<!-- cli-cheatsheet:begin agent=[a-z][a-z-]* -->$/;
const MARKER_END = /^<!-- cli-cheatsheet:end agent=[a-z][a-z-]* -->$/;
// Prose = the file minus the generator-owned cheat-sheet marker span (markers inclusive). Setup
// skills have no block → cheat is empty. Byte-matching the block is cli-cheatsheet.ts's job; we only
// refuse to mis-measure (duplicate or unbalanced markers throw instead of silently under-counting).
export function splitSkill(body: string): SkillParts {
  const lines = splitLines(body);
  const begins = lines.flatMap((l, i) => (MARKER_BEGIN.test(l) ? [i] : []));
  const ends = lines.flatMap((l, i) => (MARKER_END.test(l) ? [i] : []));
  if (begins.length > 1 || ends.length > 1) throw new Error("duplicate cli-cheatsheet markers");
  const b = begins[0] ?? -1, e = ends[0] ?? -1;
  if ((b === -1) !== (e === -1) || e < b) throw new Error("unbalanced cli-cheatsheet markers");
  if (b === -1) return { prose: lines, cheat: [] };
  return { prose: [...lines.slice(0, b), ...lines.slice(e + 1)], cheat: lines.slice(b, e + 1) };
}

// The `Sections:` line (template §5): exactly one, column 0, space-separated §<digits><letter?>
// anchors, unique, ascending (bare before lettered: §12 < §12a < §13). Returns anchors WITHOUT the §.
export interface SectionsLine { anchors: string[]; errors: string[] }
const anchorKey = (a: string): [number, string] | null => {
  const m = /^(\d+)([a-z]?)$/.exec(a);
  return m ? [Number(m[1]), m[2]] : null;
};
export function parseSectionsLine(prose: readonly string[]): SectionsLine {
  const sectionLines = prose.filter((l) => l.startsWith("Sections:"));
  if (sectionLines.length !== 1) return { anchors: [], errors: [`expected exactly one 'Sections:' line at column 0, found ${sectionLines.length}`] };
  const errors: string[] = [];
  const anchors: string[] = [];
  for (const tok of sectionLines[0].replace(/^Sections:/, "").trim().split(/\s+/)) {
    const m = /^§(\d+[a-z]?)$/.exec(tok);
    if (!m) { errors.push(`bad Sections token '${tok}' (want §<digits><letter?>)`); continue; }
    anchors.push(m[1]);
  }
  for (let i = 1; i < anchors.length; i++) {
    const p = anchorKey(anchors[i - 1])!, k = anchorKey(anchors[i])!;
    if (p[0] > k[0] || (p[0] === k[0] && p[1] >= k[1]))
      errors.push(`Sections anchors not unique+ascending at '§${anchors[i]}' (after '§${anchors[i - 1]}')`);
  }
  return { anchors, errors };
}

// Every §-anchor the prose cites, EXCLUDING the Sections: line itself (the template's set-equality
// compares the line against "the rest of the file"; generated cheat blocks are excluded upstream —
// they cite §-anchors of their own, e.g. §9c in the --blocked-by help line, which not every agent
// declares). The (?![0-9a-zA-Z]) boundary keeps a malformed token (§12ab, §12A) from being
// mis-read as a shorter valid anchor — malformedRefs() below FAILS the lint on those instead.
export const citedAnchors = (prose: readonly string[]): Set<string> =>
  new Set([...prose.filter((l) => !l.startsWith("Sections:")).join("\n").matchAll(/§(\d+[a-z]?)(?![0-9a-zA-Z])/g)].map((m) => m[1]));

// §-tokens the citation regex would mis-read or under-read (codex review 2026-07-12): §12ab / §12A
// are not valid anchors, and the range shorthand §9a–c would count only its first member — write
// both out (§9a–§9c). A plain-hyphen compound (§21a-correct) stays legal prose.
export function malformedRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/§\d+[a-zA-Z]*/g)) {
    const tok = m[0];
    const nxt = text.slice(m.index + tok.length, m.index + tok.length + 2);
    if (!/^§\d+[a-z]?$/.test(tok)) out.push(tok);
    else if (/^[–—][0-9a-z]/.test(nxt)) out.push(tok + nxt);
  }
  return out;
}

// ─── conventions span map (template §5 span semantics) ──────────────────────────────────────────────
export interface Span { start: number; end: number } // inclusive 0-based indices into `lines`
export interface Conventions {
  lines: string[];
  anchors: Map<string, { level: number; span: Span }>;
  preamble: Span; // file start → the line before the first numbered heading (title + ToC)
  topology: Span; // the unnumbered "## Topology at a glance" block — always-read, not citable
}
export function parseConventions(text: string): Conventions {
  const lines = splitLines(text);
  interface Head { idx: number; level: number; anchor: string | null; topology: boolean }
  const heads: Head[] = [];
  // Fence tracking is CommonMark-shaped (codex review 2026-07-12): an opener records its char +
  // length (info string allowed); only a BARE fence of the same char, at least as long, closes it —
  // a ~~~ line inside a ``` block, or a ``` inside a ````, stays fence content.
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (f) {
      if (!fence) fence = { ch: f[1][0], len: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === "") fence = null;
      continue;
    }
    if (fence) continue; // headings inside code fences (§6 ticket templates, §18 report samples) don't count
    const m = /^(#{2,3}) (.+)$/.exec(lines[i]);
    if (!m) continue;
    const num = /^(\d+[a-z]?)\. /.exec(m[2]);
    heads.push({ idx: i, level: m[1].length, anchor: num ? num[1] : null, topology: /^Topology at a glance\b/.test(m[2]) });
  }
  const numbered = heads.filter((h) => h.anchor);
  const topo = heads.find((h) => h.topology);
  if (!numbered.length || !topo) throw new Error("conventions.md: numbered anchors or the Topology block not found — the boot preamble moved?");
  // A span runs from its heading to the line before the next numbered heading of the same or
  // shallower level; the Topology heading also terminates (it is its own always-read block, so §0
  // and §0a never double-count it). `###` lettered children therefore nest inside their `##` parent.
  const spanEnd = (h: Head): number => {
    for (const t of heads) {
      if (t.idx <= h.idx) continue;
      if (t.topology || (t.anchor && t.level <= h.level)) return t.idx - 1;
    }
    return lines.length - 1;
  };
  const anchors = new Map<string, { level: number; span: Span }>();
  for (const h of numbered) anchors.set(h.anchor!, { level: h.level, span: { start: h.idx, end: spanEnd(h) } });
  return { lines, anchors, preamble: { start: 0, end: numbered[0].idx - 1 }, topology: { start: topo.idx, end: spanEnd(topo) } };
}
export const spanMeasure = (c: Conventions, s: Span): Measure => measureOf(c.lines.slice(s.start, s.end + 1));

// What a fire actually reads of conventions under the §0a rule: the always-read preamble + Topology
// plus the UNION of the cited spans — each line counted once (citing §9 and §9c overlaps; §0 ⊃ §0a).
export function conventionsLoad(c: Conventions, anchors: readonly string[]): Measure {
  const covered = new Uint8Array(c.lines.length);
  const mark = (s: Span): void => { for (let i = s.start; i <= s.end; i++) covered[i] = 1; };
  mark(c.preamble); mark(c.topology);
  for (const a of anchors) {
    const hit = c.anchors.get(a);
    if (!hit) throw new Error(`no conventions anchor §${a}`);
    mark(hit.span);
  }
  let ln = 0, bytes = 0;
  for (let i = 0; i < c.lines.length; i++) if (covered[i]) { ln++; bytes += Buffer.byteLength(c.lines[i], "utf8") + 1; }
  return { lines: ln, bytes };
}

// ─── the bill ───────────────────────────────────────────────────────────────────────────────────────
export interface BillRow {
  skill: string;
  agent: boolean;            // *-agent dirs fire on the loop (cheat block + lessons); setup skills don't
  sections: string[];        // the declared Sections anchors (without §)
  prose: Measure; cheat: Measure; conventions: Measure; lessons: Measure;
  total: Measure; tokens: number;
  budget: Budget; withinBudget: boolean;
}
export interface Bill { conventions: { anchors: number; total: Measure; alwaysRead: Measure }; rows: BillRow[] }

const ZERO: Measure = { lines: 0, bytes: 0 };
// Lessons are billed at their worst-case CAPS (lessons.ts W03 budgets: INDEX always + one project
// shard), not the current file sizes — the bill is the guaranteed ceiling, not today's weather.
const LESSONS_CAP: Measure = { lines: INDEX_MAX_LINES + SHARD_MAX_LINES, bytes: INDEX_MAX_BYTES + SHARD_MAX_BYTES };

export function contextBill(root = pluginRoot()): Bill {
  const convText = readFileSync(join(root, "references", "conventions.md"), "utf8");
  const conv = parseConventions(convText);
  const rows: BillRow[] = [];
  const dirs = readdirSync(join(root, "skills")).filter((d) => statSync(join(root, "skills", d)).isDirectory()).sort();
  for (const dir of dirs) {
    const parts = splitSkill(readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8"));
    const sec = parseSectionsLine(parts.prose);
    if (sec.errors.length) throw new Error(`skills/${dir}/SKILL.md: ${sec.errors[0]}`);
    const agent = dir.endsWith("-agent");
    const prose = measureOf(parts.prose), cheat = measureOf(parts.cheat);
    const conventions = conventionsLoad(conv, sec.anchors);
    const lessons = agent ? LESSONS_CAP : ZERO; // setup skills are operator-attended, no §14 lessons read
    const total: Measure = {
      lines: prose.lines + cheat.lines + conventions.lines + lessons.lines,
      bytes: prose.bytes + cheat.bytes + conventions.bytes + lessons.bytes,
    };
    const budget = BUDGETS[dir] ?? { lines: 0, bytes: 0 }; // unknown dir → 0-budget (the lint fails it loudly)
    rows.push({
      skill: dir, agent, sections: sec.anchors, prose, cheat, conventions, lessons,
      total, tokens: Math.ceil(total.bytes / BYTES_PER_TOKEN),
      budget,
      withinBudget: prose.lines <= budget.lines && prose.bytes <= budget.bytes && cheat.lines <= CHEAT_MAX_LINES,
    });
  }
  rows.sort((a, b) => b.total.bytes - a.total.bytes);
  return {
    conventions: { anchors: conv.anchors.size, total: measureOf(conv.lines), alwaysRead: conventionsLoad(conv, []) },
    rows,
  };
}

// `dev-loop metrics --context` — the operator-facing render (kept here so metrics.ts stays thin).
export function printContextBill(asJson: boolean): number {
  let bill: Bill;
  try { bill = contextBill(); }
  catch (e) { console.error(`metrics --context: ${(e as Error).message}`); return 1; }
  if (asJson) { console.log(JSON.stringify(bill, null, 2)); return 0; }
  const m = (x: Measure) => `${x.lines}L/${x.bytes}B`;
  console.log(`per-agent per-fire context bill — SKILL prose + cheat sheet + conventions (always-read + cited §-spans) + lessons caps (§14; hub/src/lessons.ts); ~tokens at ${BYTES_PER_TOKEN} B/token`);
  console.log(`conventions.md: ${bill.conventions.anchors} anchors, ${m(bill.conventions.total)} total; always-read (title/ToC + Topology): ${m(bill.conventions.alwaysRead)}\n`);
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(pad("SKILL", 22) + pad("PROSE", 15) + pad("CHEAT", 13) + pad("CONVENTIONS", 22) + pad("LESSONS", 13) + pad("TOTAL", 15) + pad("~TOKENS", 9) + "PROSE BUDGET");
  for (const r of bill.rows) {
    console.log(pad(r.skill, 22) + pad(m(r.prose), 15) + pad(m(r.cheat), 13) + pad(`${r.sections.length}§ → ${m(r.conventions)}`, 22)
      + pad(`${r.lessons.bytes}B`, 13) + pad(`${r.total.bytes}B`, 15) + pad(String(r.tokens), 9)
      + `${r.withinBudget ? "OK" : "OVER"} (≤${r.budget.lines}L/${r.budget.bytes}B)`);
  }
  if (bill.conventions.total.bytes > CONVENTIONS_WARN_BYTES)
    console.log(`\n⚠ references/conventions.md is ${bill.conventions.total.bytes}B — over the ${CONVENTIONS_WARN_BYTES}B warn threshold (see \`npm run context-budget\` for the per-section listing)`);
  return 0;
}
