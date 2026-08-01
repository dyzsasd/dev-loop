// boot-prefix tests — the runner-assembled §0a corpus (conventions-to-code phase 0).
// Contracts under test: (1) byte-determinism — same inputs ⇒ identical text+hash (the
// prompt-cache prerequisite); (2) bill consistency — the conventions slice measures
// EXACTLY what context-bill's conventionsLoad bills (one span authority, two consumers);
// (3) the §0a lessons slice (own + Shared, + Dev for split tiers); (4) per-backend
// contract-file selection; (5) fail-open on a malformed/missing SKILL.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
// ── real-workspace-shape regression (LOOP-236) ────────────────────────────────────────────────────
// The real dev-loop workspace shape: project.repos is ProjectRepoRef[] pointers, repo facts live
// in the workspace-level repos registry (flat autoMerge/deploy — NOT nested under .git/.deploy).
// The old `featured` fixture used top-level `deploy` + `repos:[{name}]` (no registry), which is
// NOT the real shape and couldn't catch the three bugs this ticket fixes.

// Fixture A: single repo, autoMerge=true, no deploy → §12c kept, §12d pruned, §19 pruned
// Mirrors the ACTUAL dev-loop workspace shape.
const realSingleAutoMerge = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ ref: "dev-loop" }] },
  { "dev-loop": { autoMerge: true, landing: "pr" } });
ok(!!realSingleAutoMerge && !realSingleAutoMerge.pruned.includes("12c"),
  "LOOP-236: real-shape single repo with autoMerge:true → §12c NOT pruned (flat field read)");
ok(!!realSingleAutoMerge && realSingleAutoMerge.pruned.includes("12d"),
  "LOOP-236: real-shape single repo with no deploy → §12d pruned");
ok(!!realSingleAutoMerge && realSingleAutoMerge.pruned.includes("19"),
  "LOOP-236: real-shape single repo → §19 pruned (≤1 repo, >1 semantics)");

// Fixture B: neither knob (no autoMerge, no deploy) → §12c AND §12d both pruned
const realNeitherKnob = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ ref: "r1" }] },
  { r1: { landing: "pr" } });
ok(!!realNeitherKnob && realNeitherKnob.pruned.includes("12c") && realNeitherKnob.pruned.includes("12d"),
  "LOOP-236: neither autoMerge nor deploy → §12c AND §12d pruned (pruning still works)");

// Fixture C: ≥2 repos → §19 kept
const realMultiRepo = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ ref: "r1" }, { ref: "r2" }] },
  { r1: { autoMerge: true }, r2: { autoMerge: true } });
ok(!!realMultiRepo && !realMultiRepo.pruned.includes("19"),
  "LOOP-236: ≥2 repos in registry → §19 NOT pruned (multi-repo)");

// Fixture D: ref not in registry → fail open, no throw, treated as no repos for that anchor
let dThrew = false;
let realGhostRef: ReturnType<typeof assembleBootCorpus> = null;
try { realGhostRef = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ ref: "ghost" }] }, {}); } catch { dThrew = true; }
ok(!dThrew, "LOOP-236: ref not in registry → no throw (fail open)");
ok(!!realGhostRef && realGhostRef.pruned.includes("12c"),
  "LOOP-236: ref not in registry → §12c pruned (no repos resolved, fail open)");

// Keep hash/size determinism check with new real-shape fixtures
const realSingle2 = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ ref: "dev-loop" }] },
  { "dev-loop": { autoMerge: true, landing: "pr" } });
ok(!!realSingleAutoMerge && !!realSingle2 && realSingleAutoMerge.text === realSingle2.text,
  "LOOP-236: same real-shape config ⇒ byte-identical (cache key holds)");
ok(!!bare && !!realSingleAutoMerge && bare.hash !== realSingleAutoMerge.hash,
  "LOOP-236: pruned-bare vs auto-merge-on have different hashes");

const featured = realMultiRepo; // alias for assertions below that use the 'featured' name
ok(!!featured && featured.text.includes("## 19. Multiple repos"),
  "multi-repo featured config ships §19");
ok(!!bare && !!featured && bare.bytes < featured.bytes,
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

// ── 4d. LOOP-163 regression: new-path lessons delivery (INDEX + project shard) ───────────────────
// The legacy dataDir puts a lessons.md at join(dataDir, "proj1", "lessons.md") — that's the v1
// path. The new path is join(dataDir, "lessons", "INDEX.md") + join(dataDir, "lessons", "proj1.md").
// Verify the assembler reads from the new path and delivers sentinel rules into the corpus.
{
  const wsDir = mkdtempSync(join(tmpdir(), "dl-bp-ws-"));
  try {
    // Create the new-path lessons structure (workspace-style: .dev-loop/lessons/)
    mkdirSync(join(wsDir, "lessons"), { recursive: true });
    writeFileSync(join(wsDir, "lessons", "INDEX.md"), [
      "# Team lessons — INDEX", "",
      "## Shared", "- SENTINEL_INDEX_SHARED shared rule", "",
      "## PM", "- SENTINEL_INDEX_PM pm rule", "",
    ].join("\n") + "\n");
    writeFileSync(join(wsDir, "lessons", "proj1.md"), [
      "# Lessons — project `proj1`", "",
      "## Shared", "- SENTINEL_SHARD_SHARED shard shared rule", "",
      "## PM", "- SENTINEL_SHARD_PM shard pm rule", "",
      "## QA", "- SENTINEL_SHARD_QA shard qa rule (different-agent — must not appear in pm slice)", "",
    ].join("\n") + "\n");
    // Different project shard — must NOT appear in a proj1 fire
    writeFileSync(join(wsDir, "lessons", "other-proj.md"), [
      "# Lessons — project `other-proj`", "",
      "## Shared", "- SENTINEL_OTHER_PROJ different project rule", "",
    ].join("\n") + "\n");

    // AC1: INDEX.md + project shard both appear in the assembled corpus for proj1/pm
    const c1 = assembleBootCorpus(root, wsDir, "pm", "proj1", "service");
    ok(!!c1, "LOOP-163 AC1: corpus assembles with new-path lessons (wsDir has no legacy path)");
    ok(!!c1 && c1.text.includes("SENTINEL_INDEX_SHARED"), "LOOP-163 AC1: INDEX ## Shared rule delivered into corpus");
    ok(!!c1 && c1.text.includes("SENTINEL_SHARD_SHARED"), "LOOP-163 AC1: project shard ## Shared rule delivered into corpus");
    ok(!!c1 && c1.text.includes("SENTINEL_INDEX_PM"), "LOOP-163 AC1: INDEX ## PM rule delivered into corpus");
    ok(!!c1 && c1.text.includes("SENTINEL_SHARD_PM"), "LOOP-163 AC1: project shard ## PM rule delivered into corpus");

    // AC2: a different project's shard DOES NOT appear in a proj1 fire
    ok(!!c1 && !c1.text.includes("SENTINEL_OTHER_PROJ"), "LOOP-163 AC2: other project shard excluded from proj1 fire");

    // AC2b: QA rules are excluded from the PM slice (lessonsSlice still filters correctly)
    ok(!!c1 && !c1.text.includes("SENTINEL_SHARD_QA"), "LOOP-163 AC2b: different-role section excluded by lessonsSlice");

    // AC4: lessonsBytes is a non-zero delivery count when lessons are present
    ok(!!c1 && c1.lessonsBytes > 0, `LOOP-163 AC4: lessonsBytes is a delivery count > 0 (got ${c1?.lessonsBytes})`);

    // AC3: absent INDEX (no lessons at all) is not an error — assembles cleanly, lessonsBytes=0
    const emptyWs = mkdtempSync(join(tmpdir(), "dl-bp-empty-"));
    const cEmpty = assembleBootCorpus(root, emptyWs, "pm", "proj1", "service");
    ok(!!cEmpty, "LOOP-163 AC3: no lessons dir at all — assembles cleanly (fail open)");
    ok(!!cEmpty && cEmpty.lessonsBytes === 0, "LOOP-163 AC3: lessonsBytes=0 when no lessons files present");
    rmSync(emptyWs, { recursive: true, force: true });

    // AC3b: legacy path <dataDir>/<project>/lessons.md still contributes when present
    const legacyWs = mkdtempSync(join(tmpdir(), "dl-bp-legacy-"));
    mkdirSync(join(legacyWs, "proj1"), { recursive: true });
    writeFileSync(join(legacyWs, "proj1", "lessons.md"), [
      "# lessons", "",
      "## Shared", "- SENTINEL_LEGACY_SHARED v1 legacy rule", "",
    ].join("\n") + "\n");
    const cLegacy = assembleBootCorpus(root, legacyWs, "pm", "proj1", "service");
    ok(!!cLegacy && cLegacy.text.includes("SENTINEL_LEGACY_SHARED"), "LOOP-163 AC3b: legacy lessons.md still contributes (v1 compat)");
    rmSync(legacyWs, { recursive: true, force: true });
  } finally {
    rmSync(wsDir, { recursive: true, force: true });
  }
}

// ── 5. fail-open ──────────────────────────────────────────────────────────────────────────────────
ok(assembleBootCorpus(root, dataDir, "no-such-agent", "proj1", "service") === null,
  "missing SKILL ⇒ null (the fire falls back to §0a pull mode)");
ok(assembleBootCorpus(root, dataDir, "pm", "", "linear") !== null,
  "team-scope fire (empty project) still assembles — lessons simply absent");

console.log(fails === 0 ? "\nBOOT_PREFIX_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
