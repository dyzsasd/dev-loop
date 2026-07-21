// boot-prefix tests — the runner-assembled §0a corpus (conventions-to-code phase 0).
// Contracts under test: (1) byte-determinism — same inputs ⇒ identical text+hash (the
// prompt-cache prerequisite); (2) bill consistency — the conventions slice measures
// EXACTLY what context-bill's conventionsLoad bills (one span authority, two consumers);
// (3) the §0a lessons slice (own + Shared, + Dev for split tiers); (4) per-backend
// contract-file selection; (5) fail-open on a malformed/missing SKILL.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBootCorpus, conventionsUnionText, lessonsSlice } from "../src/boot-prefix.ts";
import { parseConventions, parseSectionsLine, splitSkill, conventionsLoad, pluginRoot } from "../src/context-bill.ts";

const root = pluginRoot();
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── fixture data dir with a lessons file ──────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "devloop-boot-"));
mkdirSync(join(dataDir, "proj1"), { recursive: true });
const LESSONS = [
  "# lessons", "",
  "## Shared", "- shared rule", "",
  "## PM", "- pm rule", "",
  "## QA", "- qa rule", "",
  "## Dev", "- dev tier rule", "",
  "## junior-dev", "- junior rule", "",
].join("\n") + "\n";
writeFileSync(join(dataDir, "proj1", "lessons.md"), LESSONS);

// ── 1. determinism + marker contract ──────────────────────────────────────────────────────────────
const a = assembleBootCorpus(root, dataDir, "pm", "proj1", "service");
const b = assembleBootCorpus(root, dataDir, "pm", "proj1", "service");
ok(!!a && !!b, "assembly succeeds for pm/service");
if (a && b) {
  ok(a.text === b.text && a.hash === b.hash, "byte-deterministic: two assemblies are identical (the cache prerequisite)");
  ok(a.text.includes(`<!-- devloop-boot:begin agent=pm hash=${a.hash} -->`) && a.text.includes(`<!-- devloop-boot:end hash=${a.hash} -->`),
    "marker pair present and hash-stamped");
  ok(a.text.includes("do NOT re-read those files this fire"), "the inline §0a skip instruction rides the block");
  ok(a.bytes === Buffer.byteLength(a.text, "utf8"), "bytes matches the emitted text");
}

// ── 2. bill consistency — the slice measures exactly what the bill bills ─────────────────────────
const convText = readFileSync(join(root, "references", "conventions.md"), "utf8");
const conv = parseConventions(convText);
const pmSkill = readFileSync(join(root, "skills", "pm-agent", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
const pmAnchors = parseSectionsLine(splitSkill(pmSkill).prose).anchors;
const billBytes = conventionsLoad(conv, pmAnchors).bytes;
const slice = conventionsUnionText(convText, pmAnchors);
ok(slice.contentBytes === billBytes, `conventions slice content = conventionsLoad bill exactly (${slice.contentBytes} = ${billBytes})`);
ok(slice.bytes > slice.contentBytes && slice.bytes - slice.contentBytes < 2048,
  "gap markers are thin decoration (< 2KB over the billed content)");
ok(slice.text.includes("Topology at a glance"), "always-read Topology rides the slice");
ok(/⋮ \[not in your Sections set: .*§23/.test(slice.text) === !pmAnchors.includes("23"),
  "uncited sections appear only in gap markers (pm does not cite §23)");

// ── 3. lessons slice ──────────────────────────────────────────────────────────────────────────────
ok(lessonsSlice(LESSONS, "pm").includes("- pm rule") && lessonsSlice(LESSONS, "pm").includes("- shared rule"),
  "pm lessons slice = own section + Shared");
ok(!lessonsSlice(LESSONS, "pm").includes("- qa rule"), "pm lessons slice excludes other roles");
const jr = lessonsSlice(LESSONS, "junior-dev");
ok(jr.includes("- junior rule") && jr.includes("- dev tier rule") && jr.includes("- shared rule"),
  "junior-dev lessons slice adds ## Dev (split-tier rule, §0a step 4)");
if (a) ok(a.text.includes("- pm rule") && !a.text.includes("- qa rule"), "assembled corpus embeds the sliced lessons");

// ── 4. backend contract selection ─────────────────────────────────────────────────────────────────
const svc = assembleBootCorpus(root, dataDir, "pm", "proj1", "service");
const loc = assembleBootCorpus(root, dataDir, "pm", "proj1", "local");
const lin = assembleBootCorpus(root, dataDir, "pm", "proj1", "linear");
ok(!!svc && svc.text.includes("### references/backend-service.md"), "service backend embeds backend-service.md");
ok(!!loc && loc.text.includes("### references/backend-local.md"), "local backend embeds backend-local.md");
ok(!!lin && !lin.text.includes("### references/backend-service.md") && !lin.text.includes("### references/backend-local.md"),
  "linear backend embeds no contract file (the MCP is the native substrate)");

// ── 4b. config-aware selection (captured-context review 2026-07-20) ──────────────────────────────
// junior-dev declares §12c/§12d/§19/§24; a project with none of those features configured never
// ships them — declared stays the pull-mode superset, the assembler subsets per config.
const bare = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!bare && JSON.stringify(bare.pruned) === JSON.stringify(["5", "12c", "12d", "19", "24"]),
  `bare service config prunes §5 (queue pre-ranks) + the four feature spans (got: ${bare?.pruned.join(",")})`);
ok(!!bare && !bare.text.includes("## 19. Multiple repos") && /declared but OFF in this project's config: [^\]]*§19/.test(bare.text),
  "a pruned span's content is absent and its gap marker says config-off, not uncited");
const featured = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ name: "web" }], codex: { enabled: true }, deploy: { style: "release-pr" } });
ok(!!featured && JSON.stringify(featured.pruned) === JSON.stringify(["5"]),
  `a fully-featured service config still prunes §5 only (got: ${featured?.pruned.join(",")})`);
ok(!!featured && featured.text.includes("## 19. Multiple repos") && featured.text.includes("## 24. Codex"),
  "feature-on spans ship");
ok(!!bare && !!featured && bare.hash !== featured.hash && bare.bytes < featured.bytes,
  "pruning is config-deterministic and smaller (different hash, fewer bytes)");
const bare2 = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!bare && !!bare2 && bare.text === bare2.text, "same config ⇒ byte-identical (cache key holds)");
const linearJr = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "linear", {});
ok(!!linearJr && !linearJr.pruned.includes("5") && linearJr.text.includes("## 5. Priority"),
  "a linear fire keeps the §5 ranking prose (no queue op there)");
// effective-span accounting: pm declares lint-forced parent+child pairs (§9 + §9a–c) — the header
// counts distinct shipped spans, not declared tokens.
if (a) {
  const m = /always-read \+ (\d+) spans of your (\d+) declared §/.exec(a.text);
  ok(!!m && Number(m[1]) < Number(m[2]), `pm header counts effective spans < declared (${m?.[1]} < ${m?.[2]})`);
}

// ── 4c. the inherited ship sequence rides split-tier corpora (§21c) ───────────────────────────────
const jrFull = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!jrFull && jrFull.text.includes("your inherited ship sequence, §21c, pre-read")
  && jrFull.text.includes("### Step 5.5 — Self-review the diff") && jrFull.text.includes("## HARD LIMITS"),
  "junior corpus carries dev's Steps 4–6.5 + 7 + HARD LIMITS (no mid-fire pull)");
ok(!!jrFull && !jrFull.text.includes("### Step 0 — Reclaim your orphans (crash recovery)"),
  "the slice excludes dev's Steps 0–3 (junior has its own pick/claim/groom)");
if (a) ok(!a.text.includes("inherited ship sequence"), "non-dev-tier corpora (pm) carry no ship sequence");

// ── 5. fail-open ──────────────────────────────────────────────────────────────────────────────────
ok(assembleBootCorpus(root, dataDir, "no-such-agent", "proj1", "service") === null,
  "missing SKILL ⇒ null (the fire falls back to §0a pull mode)");
ok(assembleBootCorpus(root, dataDir, "pm", "", "linear") !== null,
  "team-scope fire (empty project) still assembles — lessons simply absent");

console.log(fails === 0 ? "\nBOOT_PREFIX_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
