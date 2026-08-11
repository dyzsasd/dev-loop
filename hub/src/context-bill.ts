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
import { STRATEGY_DOC_MAX_BYTES, INDEX_MAX_BYTES, INDEX_MAX_LINES, SHARD_MAX_BYTES, SHARD_MAX_LINES } from "./lessons.ts";
import { resolveWorkspace, wsHubDb } from "./workspace.ts";
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
  "dev-agent":           { lines: 271, bytes: 20_224 }, // canonical Step 0–7 ship sequence senior/junior inherit by reference (§21a); raised 260/18K → 266/19.5K for LOOP-277, then 266 → 268 lines for LOOP-553's fire-start marker pair, then 19_968 → 20_224 B for LOOP-580's Step 0 pr-arm clause (operator-applied §17, 2026-08-11) — headroom deliberately thin so regrowth trips here
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
/**
 * Per-agent CONVENTIONS ceilings (LOOP-238) — the ratchet, so a landed compression win cannot
 * silently regrow.
 *
 * Distinct from BUDGETS above, which bounds an agent's own SKILL prose. This bounds the far larger
 * input: the config-pruned §0a conventions slice that agent's fire receives. Conventions is 75% of
 * context at a measured $4.79/fire (LOOP-228), so it is the number worth a failing gate — and it had
 * none, which is how 20 rollup passes failed to bound it.
 *
 * SEEDED FROM MEASUREMENT, not from a target. These are today's actual pruned bytes on this
 * workspace, rounded up to the next KB. Headroom is deliberately ~1 KB: a ratchet with generous
 * slack does not ratchet, it just records a number nobody trips. A compression win LOWERS its row in
 * the same commit that lands it — that is what makes the win permanent rather than a moment.
 *
 * Measured 2026-08-06 via `dev-loop conventions --agent <a> --json` (LOOP-237's verb, which shares
 * the prune with the boot corpus, so this bounds what a fire actually receives).
 */
export const CONVENTIONS_BUDGETS: Record<string, number> = {
  "pm":            127 * 1024,  // actual 129,134 —   914 B headroom (re-measured 2026-08-10, LOOP-465)
  "qa":            119 * 1024,  // actual 121,350 —   506 B
  "senior-dev":    107 * 1024,  // actual 109,178 —   390 B
  "junior-dev":    105 * 1024,  // actual 107,375 —   145 B
  "sweep":         114 * 1024,  // actual 116,118 —   618 B
  "reflect":        79 * 1024,  // actual  80,510 —   386 B
  "ops":            99 * 1024,  // actual 100,720 —   656 B
  "architect":      77 * 1024,  // actual  77,904 —   944 B
  "communication":  63 * 1024,  // actual  63,992 —   520 B
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

// ─── the inherited dev slices (LOOP-553) ────────────────────────────────────────────────────────────
// The split tiers inherit dev-agent's fire-start (Step 0.5) and ship-sequence slices by marker pair.
// This extractor is the ONE parser both the assembler (boot-prefix.ts) and the bill use, so what
// ships and what is billed cannot drift. Markers missing ⇒ that slice is absent (fail-open).
export const DEV_SLICE_MARKERS = [
  { label: "Step 0.5", begin: "<!-- fire-start:begin -->", end: "<!-- fire-start:end -->" },
  { label: "Steps 4–6.5 + 7 + HARD LIMITS", begin: "<!-- ship-sequence:begin -->", end: "<!-- ship-sequence:end -->" },
] as const;
export function devInheritedSlices(devSkillText: string): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  for (const m of DEV_SLICE_MARKERS) {
    const b = devSkillText.indexOf(m.begin);
    const e = devSkillText.indexOf(m.end);
    if (b !== -1 && e > b) out.push({ label: m.label, text: devSkillText.slice(b + m.begin.length, e).trim() });
  }
  return out;
}

// ─── the bill ───────────────────────────────────────────────────────────────────────────────────────
export interface BillRow {
  skill: string;
  agent: boolean;            // *-agent dirs fire on the loop (cheat block + lessons); setup skills don't
  sections: string[];        // the declared Sections anchors (without §)
  prose: Measure; cheat: Measure; conventions: Measure; lessons: Measure;
  // null when the agent is not in STRATEGY_DOC_READERS; StrategyDocStat (bytes may be 0) when it is.
  strategyDoc: StrategyDocStat | null;
  // The dev-agent slices a split tier receives in its corpus (LOOP-553) — billed at worst case
  // (both slices), matching the lessons-cap doctrine; ZERO for every other row.
  inherited: Measure;
  total: Measure; tokens: number;
  budget: Budget; withinBudget: boolean;
}
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

export function contextBill(root = pluginRoot(), strategyDoc?: StrategyDocStat): Bill {
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
    const isReader = STRATEGY_DOC_READERS.has(dir);
    const rowStrategyDoc: StrategyDocStat | null = (isReader && strategyDoc) ? strategyDoc : null;
    const docBytes = rowStrategyDoc?.bytes ?? 0;
    const docLines = rowStrategyDoc?.lines ?? 0;
    const inherited: Measure = (dir === "senior-dev-agent" || dir === "junior-dev-agent")
      ? measureOf(splitLines(devInheritedSlices(readFileSync(join(root, "skills", "dev-agent", "SKILL.md"), "utf8")).map((sl) => sl.text).join("\n\n")))
      : ZERO;
    const total: Measure = {
      lines: prose.lines + cheat.lines + conventions.lines + lessons.lines + docLines + inherited.lines,
      bytes: prose.bytes + cheat.bytes + conventions.bytes + lessons.bytes + docBytes + inherited.bytes,
    };
    const budget = BUDGETS[dir] ?? { lines: 0, bytes: 0 }; // unknown dir → 0-budget (the lint fails it loudly)
    rows.push({
      skill: dir, agent, sections: sec.anchors, prose, cheat, conventions, lessons, inherited,
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
export function printContextBill(asJson: boolean, projectKey?: string): number {
  const strategyDoc = tryResolveStrategyDocStat(undefined, projectKey);
  let bill: Bill;
  try { bill = contextBill(undefined, strategyDoc); }
  catch (e) { console.error(`metrics --context: ${(e as Error).message}`); return 1; }
  if (asJson) { console.log(JSON.stringify(bill, null, 2)); return 0; }
  const m = (x: Measure) => `${x.lines}L/${x.bytes}B`;
  const docLabel = strategyDoc ? strategyDoc.label : "—";
  console.log(`per-agent per-fire context bill — SKILL prose + cheat sheet + conventions (always-read + cited §-spans) + lessons caps (§14; hub/src/lessons.ts) + strategyDoc for ${[...STRATEGY_DOC_READERS].join("/")} (§20 R2); ~tokens at ${BYTES_PER_TOKEN} B/token`);
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
      + pad(`${r.lessons.bytes}B`, 13) + pad(sdCol, 16) + pad(`${r.total.bytes}B`, 15) + pad(String(r.tokens), 9)
      + `${r.withinBudget ? "OK" : "OVER"} (≤${r.budget.lines}L/${r.budget.bytes}B)`);
  }
  if (bill.conventions.total.bytes > CONVENTIONS_WARN_BYTES)
    console.log(`\n⚠ references/conventions.md is ${bill.conventions.total.bytes}B — over the ${CONVENTIONS_WARN_BYTES}B warn threshold (see \`npm run context-budget\` for the per-section listing)`);
  return 0;
}
