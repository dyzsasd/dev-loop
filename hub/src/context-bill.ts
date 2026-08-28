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
//     caps + (STRATEGY_DOC_READERS only) the project's strategyDoc per §20 R2 = the estimated
//     per-fire boot load in lines/bytes (+ ~tokens at 4 bytes/token).
//     Strategy-doc attribution rule (§20 R2): PM re-reads the whole doc-base every fire; other
//     agents read it selectively on relevant tasks — not a fixed per-fire load. Only agents in
//     STRATEGY_DOC_READERS are charged. An absent/unreadable doc is reported as absent (0 bytes
//     added to the total) rather than silently omitted.
// Lessons budgets stay lessons.ts's (INDEX_MAX_* / SHARD_MAX_* — imported, never duplicated).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { strategyDocRelPath as strategyDocRelPathLeaf } from "./default-branch-push.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { STRATEGY_DOC_MAX_BYTES, INDEX_MAX_BYTES, INDEX_MAX_LINES, SHARD_MAX_BYTES, SHARD_MAX_LINES, lessonsSliceForFire } from "./lessons.ts";
import { deliveryProjects } from "./team-config.ts";
import { resolveWorkspace, tryResolveWorkspace, wsStateRoot, wsHubDb } from "./workspace.ts";
import { reposOfProject, type Workspace } from "./team-config.ts";

export interface Budget { lines: number; bytes: number }
export interface Measure { lines: number; bytes: number }
// The resolved size of a project's strategyDoc when readable (repo file). bytes/lines are 0 when the
// doc is configured but absent/unreadable (hub doc, Linear doc, or missing file); label says why.
export interface StrategyDocStat { bytes: number; lines: number; label: string }
// Agents mandated by §20 R2 to re-read the full strategy doc every fire.
export const STRATEGY_DOC_READERS = new Set(["pm-agent"]);

// ─── the budget table (template §7 — final numbers; prose = file minus the cheat-block span) ───────
export const BUDGETS: Record<string, Budget> = {
  "pm-agent":            { lines: 300, bytes: 22 * 1024 },
  "qa-agent":            { lines: 220, bytes: 16 * 1024 },
  "senior-dev-agent":    { lines: 220, bytes: 16 * 1024 },
  "junior-dev-agent":    { lines: 220, bytes: 16 * 1024 },
  "sweep-agent":         { lines: 220, bytes: 16 * 1024 },
  "dev-agent":           { lines: 200, bytes: 14 * 1024 }, // lean shell since the job-scoped rollout: the canonical Step 0–7 ship sequence moved into the shared dev playbooks (skills/playbooks/fire-start.md, ship.md, …) the dev/senior/junior job spans pull, so dev-agent no longer HOSTS the sequence senior/junior once inherited by marker (LOOP-553 retired). Budget dropped 268/19_968 → 200/14K to match its peers now that the body is a shell.
  "reflect-agent":       { lines: 200, bytes: 14 * 1024 },
  "ops-agent":           { lines: 200, bytes: 14 * 1024 },
  "architect-agent":     { lines: 200, bytes: 14 * 1024 },
  "communication-agent": { lines: 200, bytes: 14 * 1024 },
  "add-project":         { lines: 150, bytes: 10 * 1024 },
  "add-repo":            { lines: 150, bytes: 10 * 1024 },
  "sync-project":        { lines: 150, bytes: 10 * 1024 },
  "sync-repo":           { lines: 150, bytes: 10 * 1024 },
  "operator-console":    { lines: 160, bytes: 11 * 1024 }, // one-click §3: the conversational cockpit (operator-present, no cheat block)
  "playbooks":           { lines: 80, bytes: 6 * 1024 }, // job-scoped prompts: the SHARED-playbook library INDEX (skills/playbooks/SKILL.md); NOT a launchable agent — a fragment dir the boot assembler pulls per job. The per-playbook FILES are budgeted by their own job's pull, not here.
};
/**
 * Per-agent CONVENTIONS ceilings — 64 KB for every loop agent (WS-A prompt economy, 2026-08-27).
 *
 * Distinct from BUDGETS above, which bounds an agent's own SKILL prose. This bounds the far larger
 * input: the config-pruned §0a conventions slice that agent's fire receives — the byte-constant prefix
 * the boot corpus inlines on every fire, so the number a cache hit is priced on.
 *
 * Before WS-A this table was a per-agent RATCHET seeded from measurement (+~1 KB headroom, pm at
 * 127 KB). WS-A moved the large, rarely-needed section bodies out to `references/conventions/<slug>.md`
 * pointer files (read at their stub's trigger moment) and set ONE target for every lane instead: a
 * 64 KB slice is what keeps the whole constant segment (SKILL + corpus) inside a single cacheable
 * prefix on every lane. It is a TARGET the lint enforces, not a ratchet that follows the measurement —
 * a section that regrows past it is trimmed or externalized, never budgeted up. Measured after the
 * move (single-repo autoMerge fixture, hub/test/context-budget.ts): pm 63.9 KB, qa 63.0, sweep 58.1,
 * junior-dev 57.6, ops 55.0, senior-dev 54.8, architect 42.1, reflect 40.8, communication 34.4.
 */
// TRANSITIONAL ceiling. WS-A A3 set a uniform 64 KB target; review-2's fidelity audit then RESTORED 8
// invariants A3 had over-compressed away, and Decision-1 added the §9 bail-shape-label docs — legitimately
// pushing pm (66.6 KB) and qa (68.8 KB) over 64 KB. Fidelity beats an arbitrary byte target, so the ceiling
// is loosened to 70 KB rather than re-dropping restored rules. This whole per-agent conventions-UNION bound
// is superseded by the job-scoped corpus (constitution + one playbook ≈ 18 KB): a migrated agent (pm) no
// longer loads the union at all, and rollout step h removes it for qa/sweep/dev too — at which point this
// ceiling and CONVENTIONS_BUDGETS go away. See docs/design/job-scoped-prompts.md.
export const CONVENTIONS_TARGET_BYTES = 70 * 1024;
export const CONVENTIONS_BUDGETS: Record<string, number> = {
  "pm":            CONVENTIONS_TARGET_BYTES,
  "qa":            CONVENTIONS_TARGET_BYTES,
  "senior-dev":    CONVENTIONS_TARGET_BYTES,
  "junior-dev":    CONVENTIONS_TARGET_BYTES,
  "sweep":         CONVENTIONS_TARGET_BYTES,
  "reflect":       CONVENTIONS_TARGET_BYTES,
  "ops":           CONVENTIONS_TARGET_BYTES,
  "architect":     CONVENTIONS_TARGET_BYTES,
  "communication": CONVENTIONS_TARGET_BYTES,
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

// ─── job spans (job-scoped prompts, docs/design/job-scoped-prompts.md) ────────────────────────────────
// A SKILL/RUNBOOK wraps each of an agent's jobs in `<!-- job:<slug>:begin -->…<!-- job:<slug>:end -->`.
// jobSlice is ONE span authority for the assembler (boot-prefix.ts), the pull verb (playbook-verb.ts) and
// any bill, so what a pushed fire loads and what a `dev-loop playbook` pull prints cannot drift. The SKILL
// is the source of truth for the set of valid jobs (jobsOf scans its begin markers). Missing/malformed
// markers ⇒ null, fail-open.
//
// (The retired LOOP-553 DEV_SLICE_MARKERS / devInheritedSlices mechanism lived here: the split tiers used to
// inherit dev-agent's fire-start + ship-sequence marker spans at classic-boot. That content moved into the
// shared playbooks (skills/playbooks/fire-start.md, ship.md, …) the dev/senior/junior JOB spans pull, so the
// tiers now job-boot and the marker-inheritance path — and its `inherited` bill column — are gone.)
export const CONSTITUTION_FILE = join("skills", "_constitution.md"); // the resident kernel, loaded VERBATIM every job fire
export const readConstitution = (root: string): string => readFileSync(join(root, "skills", "_constitution.md"), "utf8");

const jobBegin = (job: string): string => `<!-- job:${job}:begin -->`;
const jobEnd = (job: string): string => `<!-- job:${job}:end -->`;
const JOB_BEGIN_RE = /<!--\s*job:([a-z0-9][a-z0-9-]*):begin\s*-->/g;

export interface JobSpan {
  job: string;
  kind: string;      // the span's `kind:` front-matter — "mechanical" | "judgment-scaffold" ("" if omitted)
  pulls: string[];   // the span's `pulls:` list, in order (shared playbooks + reference stubs, deduped)
  text: string;      // the span body between the markers, trimmed (markers excluded)
}

// Every job an agent's SKILL declares, in first-seen order — the SKILL IS the source of truth (design §M1).
export function jobsOf(skillText: string): string[] {
  const out: string[] = [];
  for (const m of skillText.matchAll(JOB_BEGIN_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// The agent-specific CLI cheat-sheet block a job corpus carries VERBATIM (job-scoped prompts): the exact
// `dev-loop` verb forms + flags + the exit-code table gen-cheatsheets.ts renders, which lives in the SKILL
// FRAME that job-boot otherwise drops. ONE extractor — same `splitSkill` marker authority the bill measures
// with and cli-cheatsheet.ts byte-checks against the generator — so the corpus, the bill and the drift lint
// can never disagree on where the block starts and ends. Returns "" when the SKILL has no cheat block
// (setup skills, or any SKILL without cli-cheatsheet markers) — the corpus then skips it gracefully.
export function cheatSlice(skillText: string): string {
  return splitSkill(skillText).cheat.join("\n");
}

// Extract + parse ONE job span. Returns null when the marker pair is absent or malformed (fail-open).
export function jobSlice(skillText: string, job: string): JobSpan | null {
  const begin = jobBegin(job), end = jobEnd(job);
  const b = skillText.indexOf(begin);
  const e = skillText.indexOf(end);
  if (b === -1 || e <= b) return null;
  const text = skillText.slice(b + begin.length, e).trim();
  const lines = text.split("\n");
  const kindLine = lines.find((l) => l.startsWith("kind:"));
  const pullsLine = lines.find((l) => l.startsWith("pulls:"));
  const kind = kindLine ? kindLine.slice("kind:".length).trim() : "";
  const pulls: string[] = [];
  if (pullsLine) for (const p of pullsLine.slice("pulls:".length).split(",").map((s) => s.trim()).filter(Boolean)) if (!pulls.includes(p)) pulls.push(p);
  return { job, kind, pulls, text };
}

// ─── the bill ───────────────────────────────────────────────────────────────────────────────────────
export interface BillRow {
  skill: string;
  agent: boolean;            // *-agent dirs fire on the loop (cheat block + lessons); setup skills don't
  sections: string[];        // the declared Sections anchors (without §)
  prose: Measure; cheat: Measure; conventions: Measure; lessons: Measure;
  // WS-A A4: how the lessons column was priced — "actual" = the bytes the fire's corpus inlines
  // (INDEX + shard, sliced to this agent), "cap" = the W03 ceiling (no workspace to measure against).
  lessonsBasis: "actual" | "cap";
  // null when the agent is not in STRATEGY_DOC_READERS; StrategyDocStat (bytes may be 0) when it is.
  strategyDoc: StrategyDocStat | null;
  total: Measure; tokens: number;
  budget: Budget; withinBudget: boolean;
}
// WS-A A4: an optional per-agent resolver for the ACTUAL lessons bytes a fire inlines. Absent (or
// returning null) ⇒ the row bills the W03 caps, exactly as before.
export type LessonsResolver = (agent: string) => Measure | null;
export interface Bill {
  conventions: { anchors: number; total: Measure; alwaysRead: Measure };
  // The resolved strategy-doc stat passed to contextBill(); absent when no workspace was available.
  strategyDoc?: StrategyDocStat;
  rows: BillRow[];
}

const ZERO: Measure = { lines: 0, bytes: 0 };
// Lessons are billed at their worst-case CAPS (lessons.ts W03 budgets: INDEX always + one project
// shard), not the current file sizes — the bill is the guaranteed ceiling, not today's weather.
const LESSONS_CAP: Measure = { lines: INDEX_MAX_LINES + SHARD_MAX_LINES, bytes: INDEX_MAX_BYTES + SHARD_MAX_BYTES };

export function contextBill(root = pluginRoot(), strategyDoc?: StrategyDocStat, lessonsActual?: LessonsResolver): Bill {
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
    // setup skills are operator-attended, no §14 lessons read. Loop agents bill the ACTUAL inlined slice when
    // a resolver can measure it (WS-A A4), else the W03 caps (the guaranteed ceiling — the old doctrine).
    const actual = agent && lessonsActual ? lessonsActual(dir.replace(/-agent$/, "")) : null;
    const lessons = agent ? (actual ?? LESSONS_CAP) : ZERO;
    const lessonsBasis: "actual" | "cap" = agent && actual ? "actual" : "cap";
    const isReader = STRATEGY_DOC_READERS.has(dir);
    const rowStrategyDoc: StrategyDocStat | null = (isReader && strategyDoc) ? strategyDoc : null;
    const docBytes = rowStrategyDoc?.bytes ?? 0;
    const docLines = rowStrategyDoc?.lines ?? 0;
    const total: Measure = {
      lines: prose.lines + cheat.lines + conventions.lines + lessons.lines + docLines,
      bytes: prose.bytes + cheat.bytes + conventions.bytes + lessons.bytes + docBytes,
    };
    const budget = BUDGETS[dir] ?? { lines: 0, bytes: 0 }; // unknown dir → 0-budget (the lint fails it loudly)
    rows.push({
      skill: dir, agent, sections: sec.anchors, prose, cheat, conventions, lessons, lessonsBasis,
      strategyDoc: rowStrategyDoc,
      total, tokens: Math.ceil(total.bytes / BYTES_PER_TOKEN),
      budget,
      withinBudget: prose.lines <= budget.lines && prose.bytes <= budget.bytes && cheat.lines <= CHEAT_MAX_LINES,
    });
  }
  rows.sort((a, b) => b.total.bytes - a.total.bytes);
  return {
    conventions: { anchors: conv.anchors.size, total: measureOf(conv.lines), alwaysRead: conventionsLoad(conv, []) },
    strategyDoc,
    rows,
  };
}

// Resolve a DocRef to a repo-relative path string; returns null for hub/Linear forms (unreadable).
// Defined in ./default-branch-push.ts (LOOP-567) and re-exported here for this module's consumers —
// one definition, so the context bill and the push gate cannot disagree about the doc path.
export { strategyDocRelPath } from "./default-branch-push.ts";

// Extract the hubDoc slug from a docRef like { hubDoc: "design/my-design" }.
// Returns null when the docRef is not a hubDoc form or the slug is empty.
function hubDocSlug(docRef: unknown): string | null {
  if (docRef && typeof docRef === "object" && "hubDoc" in (docRef as object)) {
    const v = (docRef as Record<string, unknown>).hubDoc;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }
  return null;
}

// Lean hub-doc reader: reads a strategy doc body from the hub.db on disk.
// Does NOT load the daemon or MCP layer — direct SQLite query only.
// Returns the published body text, or null if the doc doesn't exist or isn't published.
function readHubDocBody(ws: Workspace, projectKey: string, slug: string): string | null {
  const dbPath = wsHubDb(ws);
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const proj = db.prepare("SELECT id FROM projects WHERE key=?").get(projectKey) as { id: string } | undefined;
    if (!proj) return null;
    const doc = db.prepare("SELECT id, current_version FROM documents WHERE project_id=? AND slug=? AND kind='strategy'").get(proj.id, slug) as { id: string; current_version: number } | undefined;
    if (!doc || doc.current_version === 0) return null;
    const v = db.prepare("SELECT body FROM document_versions WHERE doc_id=? AND version=?").get(doc.id, doc.current_version) as { body: string } | undefined;
    return v?.body ?? null;
  } finally {
    db.close();
  }
}

// Best-effort resolution of the workspace's strategy doc for the context bill.
// When projectKey is given, resolves only that project's doc; otherwise uses the first project
// that has a strategyDoc configured (the legacy behaviour, except hub docs are now read from disk).
// Returns undefined when no workspace is available; returns a stat with bytes=0 when the doc
// is configured but unreadable (Linear form, missing hub db, or file not found).
export function tryResolveStrategyDocStat(cwd?: string, projectKey?: string, ws?: Workspace): StrategyDocStat | undefined {
  try {
    const resolved = ws ?? resolveWorkspace(cwd);
    const keys = projectKey ? [projectKey] : Object.keys(resolved.file.projects);
    for (const key of keys) {
      const project = resolved.file.projects[key];
      const docRef = project?.strategyDoc;
      if (!docRef) continue;
      // Check for hubDoc form — read from hub.db on disk (no daemon needed)
      const hubSlug = hubDocSlug(docRef);
      if (hubSlug) {
        const body = readHubDocBody(resolved, key, hubSlug);
        if (body === null) {
          return { bytes: 0, lines: 0, label: `absent (hubDoc — not found in hub store)` };
        }
        const docLines = splitLines(body);
        return { bytes: measureOf(docLines).bytes, lines: docLines.length, label: `hubDoc:${hubSlug} (${key})` };
      }
      // Check for Linear form — always absent (requires live session)
      if (docRef && typeof docRef === "object" && "linearDocument" in (docRef as object)) {
        return { bytes: 0, lines: 0, label: "absent (linearDoc — readable only in a live session)" };
      }
      if (typeof docRef === "string" && /linear\.app\/.*\/document\//.test(docRef)) {
        return { bytes: 0, lines: 0, label: "absent (linearDoc — readable only in a live session)" };
      }
      const relPath = strategyDocRelPathLeaf(docRef);
      if (!relPath) continue;
      // Repo file — stat it from the first (primary) repo of this project
      const repos = reposOfProject(resolved, key);
      const repoPath = (repos.find((r) => r.role === "primary") ?? repos.find((r) => r.role === "docs") ?? repos[0])?.absPath;
      if (!repoPath) continue;
      const docPath = join(repoPath, relPath);
      if (!existsSync(docPath)) {
        return { bytes: 0, lines: 0, label: `absent (${relPath} not found in ${repos[0]?.ref ?? "??"})` };
      }
      const text = readFileSync(docPath, "utf8");
      const docLines = splitLines(text);
      return { bytes: measureOf(docLines).bytes, lines: docLines.length, label: relPath };
    }
  } catch { /* no workspace or resolution error — absent is fine */ }
  return undefined;
}

// `dev-loop metrics --context` — the operator-facing render (kept here so metrics.ts stays thin).
// Accepts an optional projectKey to resolve that project's strategy doc (LOOP-355).
// WS-A A4: the lessons bytes a fire on THIS workspace actually inlines — INDEX + the project's shard,
// sliced per agent. undefined when no workspace resolves (the bill then falls back to the W03 caps).
export function tryResolveLessonsActual(cwd?: string, projectKey?: string): LessonsResolver | undefined {
  try {
    const ws = resolveWorkspace(cwd);
    const key = projectKey ?? deliveryProjects(ws)[0] ?? null;
    return (agent: string) => { const m = lessonsSliceForFire(ws, agent, key); return { lines: m.lines, bytes: m.bytes }; };
  } catch { return undefined; }
}

// `dev-loop metrics --context --jobs` — the job-scoped-prompt measurement (docs/design/job-scoped-prompts.md).
// For EVERY migrated loop agent's job it prints the pushed constant-segment bytes a fire loads (constitution +
// the job span + the shared playbooks it pulls) against the whole-role classic-boot load the context bill
// reports — the before/after the design promises. Kept here (not metrics.ts) so the one bill authority owns
// the number.
// The migrated loop agents, in scheduler-roster order — every one job-boots now (pm/qa via their lanes, the
// dev tiers + single-job stewards fire as themselves with a resolved job). The SKILL is the source of truth
// for the set of jobs (jobsOf scans its begin markers), so this bill and the scheduler cannot drift on which
// jobs exist.
export const JOB_BILL_AGENTS = ["pm", "qa", "dev", "senior-dev", "junior-dev", "sweep", "reflect", "ops", "architect", "communication"] as const;
export async function printJobLaneBill(asJson: boolean, root = pluginRoot()): Promise<number> {
  // Dynamic import: boot-prefix imports THIS module (context-bill), so a top-level import would be a
  // cycle; a runtime import sidesteps it and keeps the plain --context path from loading crypto/self-drift.
  const { assembleJobCorpus } = await import("./boot-prefix.ts");
  // Enumerate each agent's jobs from its SKILL markers (jobsOf) — one source of truth, no hand-kept list.
  const jobsByAgent: Record<string, readonly string[]> = {};
  for (const agent of JOB_BILL_AGENTS) jobsByAgent[agent] = jobsOf(readFileSync(join(root, "skills", `${agent}-agent`, "SKILL.md"), "utf8"));
  type JobRow = { agent: string; job: string; kind: string; corpusBytes: number; constantBytes: number; lessonsBytes: number; pulledPlaybooks: string[] };
  const rows: JobRow[] = [];
  const HEADER_BYTES = 435; // the readPrompt job-mode constant header (byte-stable per job, ±1B for the job name)
  // A job corpus now carries the agent's CLI cheat-sheet (always) + this project's §14 lessons (when a
  // workspace resolves). Resolve it best-effort so the reported bytes are the HONEST per-fire load; no
  // workspace ⇒ dataDir undefined ⇒ cheat only (the plugin-static number). The cheat block is per-agent
  // constant and the lessons per-(agent,project) constant, so the byte is still stable per fire.
  const ws = tryResolveWorkspace();
  const dataDir = ws ? wsStateRoot(ws) : undefined;
  const billProject = ws ? deliveryProjects(ws)[0] : undefined;
  for (const [agent, jobs] of Object.entries(jobsByAgent)) {
    const skill = readFileSync(join(root, "skills", `${agent}-agent`, "SKILL.md"), "utf8");
    for (const job of jobs) {
      const span = jobSlice(skill, job);
      const corpus = assembleJobCorpus(root, agent, job, dataDir, billProject);
      if (!span || !corpus) continue;
      rows.push({ agent, job, kind: span.kind, corpusBytes: corpus.bytes, constantBytes: corpus.bytes + HEADER_BYTES,
        lessonsBytes: corpus.lessonsBytes,
        pulledPlaybooks: span.pulls.filter((p) => p.startsWith("skills/playbooks/")) });
    }
  }
  const bill = contextBill(root);
  const wholeRole: Record<string, number> = {};
  for (const agent of Object.keys(jobsByAgent)) wholeRole[agent] = bill.rows.find((r) => r.skill === `${agent}-agent`)?.total.bytes ?? 0;
  if (asJson) { console.log(JSON.stringify({ jobLanes: rows, wholeRole }, null, 2)); return 0; }
  console.log(`job-scoped per-fire load — pushed constant segment (skills/_constitution.md + the job span + its pulled shared playbooks + the agent CLI cheat-sheet + this project's §14 lessons slice) per agent job vs the whole-role classic-boot load; ~tokens at ${BYTES_PER_TOKEN} B/token`);
  console.log(dataDir ? `lessons: resolved from ${billProject ? `project '${billProject}'` : "the workspace"} (LESSONS column = the actual injected bytes)`
                     : `lessons: no workspace resolved — cheat-sheet included, lessons 0 (the plugin-static floor; a real fire adds this project's §14 slice)`);
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(pad("AGENT/JOB", 24) + pad("KIND", 20) + pad("CONSTANT", 16) + pad("~TOKENS", 10) + pad("LESSONS", 10) + "PULLED PLAYBOOKS");
  for (const r of rows) {
    console.log(pad(`${r.agent}/${r.job}`, 24) + pad(r.kind, 20) + pad(`${r.constantBytes}B`, 16) + pad(String(Math.ceil(r.constantBytes / BYTES_PER_TOKEN)), 10)
      + pad(`${r.lessonsBytes}B`, 10) + r.pulledPlaybooks.map((p) => p.replace("skills/playbooks/", "")).join(", "));
  }
  for (const [agent, bytes] of Object.entries(wholeRole)) {
    const mine = rows.filter((r) => r.agent === agent);
    if (!mine.length || bytes === 0) continue;
    const lightest = Math.min(...mine.map((r) => r.constantBytes));
    const heaviest = Math.max(...mine.map((r) => r.constantBytes));
    console.log(`\nwhole-role ${agent} load today: ${bytes}B (~${(bytes / 1024).toFixed(1)}KB) — job-scoped is ${(bytes / heaviest).toFixed(1)}×–${(bytes / lightest).toFixed(1)}× lighter (heaviest ${heaviest}B → lightest ${lightest}B)`);
  }
  return 0;
}

export function printContextBill(asJson: boolean, projectKey?: string): number {
  const strategyDoc = tryResolveStrategyDocStat(undefined, projectKey);
  const lessonsActual = tryResolveLessonsActual(undefined, projectKey);
  let bill: Bill;
  try { bill = contextBill(undefined, strategyDoc, lessonsActual); }
  catch (e) { console.error(`metrics --context: ${(e as Error).message}`); return 1; }
  if (asJson) { console.log(JSON.stringify(bill, null, 2)); return 0; }
  const m = (x: Measure) => `${x.lines}L/${x.bytes}B`;
  const docLabel = strategyDoc ? strategyDoc.label : "—";
  console.log(`per-agent per-fire context bill — SKILL prose + cheat sheet + conventions (always-read + cited §-spans; target ≤${CONVENTIONS_TARGET_BYTES}B/agent) + lessons (${lessonsActual ? "ACTUAL inlined bytes on this workspace" : "W03 caps — no workspace"}; §14; hub/src/lessons.ts) + strategyDoc for ${[...STRATEGY_DOC_READERS].join("/")} (§20 R2); ~tokens at ${BYTES_PER_TOKEN} B/token`);
  console.log(`conventions.md: ${bill.conventions.anchors} anchors, ${m(bill.conventions.total)} total; always-read (title/ToC + Topology): ${m(bill.conventions.alwaysRead)}`);
  // LOOP-282 — show the doc AGAINST its budget, in the same OK / over-budget shape the SKILL rows
  // use. A byte count with no ceiling beside it is what let 114 KB read as unremarkable for 20 rollup
  // passes: the number was on screen the whole time and nothing said it was too big.
  const sdVerdict = !strategyDoc ? "" : strategyDoc.bytes > STRATEGY_DOC_MAX_BYTES
    ? `  ⚠ OVER by ${strategyDoc.bytes - STRATEGY_DOC_MAX_BYTES}B (budget ${STRATEGY_DOC_MAX_BYTES}B — §20 R2: roll superseded sections into strategy-archive/)`
    : `  OK (budget ${STRATEGY_DOC_MAX_BYTES}B)`;
  console.log(`strategyDoc: ${docLabel}${strategyDoc && strategyDoc.bytes > 0 ? ` (${strategyDoc.bytes}B / ${strategyDoc.lines}L)` : strategyDoc ? " (0B — absent/unreadable)" : " (no workspace)"}${sdVerdict}\n`);
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(pad("SKILL", 22) + pad("PROSE", 15) + pad("CHEAT", 13) + pad("CONVENTIONS", 22) + pad("LESSONS", 13) + pad("STRATEGY-DOC", 16) + pad("TOTAL", 15) + pad("~TOKENS", 9) + "PROSE BUDGET");
  for (const r of bill.rows) {
    const sdCol = r.strategyDoc ? `${r.strategyDoc.bytes}B` : "—";
    console.log(pad(r.skill, 22) + pad(m(r.prose), 15) + pad(m(r.cheat), 13) + pad(`${r.sections.length}§ → ${m(r.conventions)}`, 22)
      + pad(`${r.lessons.bytes}B${r.lessonsBasis === "cap" && r.agent ? " (cap)" : ""}`, 13) + pad(sdCol, 16) + pad(`${r.total.bytes}B`, 15) + pad(String(r.tokens), 9)
      + `${r.withinBudget ? "OK" : "OVER"} (≤${r.budget.lines}L/${r.budget.bytes}B)`);
  }
  if (bill.conventions.total.bytes > CONVENTIONS_WARN_BYTES)
    console.log(`\n⚠ references/conventions.md is ${bill.conventions.total.bytes}B — over the ${CONVENTIONS_WARN_BYTES}B warn threshold (see \`npm run context-budget\` for the per-section listing)`);
  return 0;
}
