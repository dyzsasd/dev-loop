// boot-prefix tests — the runner-assembled §0a corpus (conventions-to-code phase 0).
// Contracts under test: (1) byte-determinism — same inputs ⇒ identical text+hash (the
// prompt-cache prerequisite); (2) bill consistency — the conventions slice measures
// EXACTLY what context-bill's conventionsLoad bills (one span authority, two consumers);
// (3) the §0a lessons slice (own + Shared, + Dev for split tiers); (4) per-backend
// contract-file selection; (5) fail-open on a malformed/missing SKILL.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBootCorpus, conventionsUnionText, lessonsSlice } from "../src/boot-prefix.ts";
import { loadWorkspace, toLegacyView } from "../src/team-config.ts";
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
const lin = assembleBootCorpus(root, dataDir, "pm", "proj1", "linear");
ok(!!svc && svc.text.includes("### references/backend-service.md"), "service backend embeds backend-service.md");
ok(!!lin && !lin.text.includes("### references/backend-service.md"),
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

// ── Fixture E (LOOP-279) — drive the REAL toLegacyView projection, not a hand-built argument ─────
// The production caller is run-agents.ts:959-961: `cfg = toLegacyView(ws)`, then
// `assembleBootCorpus(…, cfg.projects[key], cfg.repos)`. LegacyProjectsConfig declares NO
// workspace-level `repos` registry, so that 7th argument is structurally `undefined` on every v2
// workspace. The previous fixture hand-supplied a registry instead, asserting an input shape the
// runtime cannot produce — which is how LOOP-236 shipped green while §12c was pruned on the very
// workspace it was meant to fix. Build a workspace file, project it, pass BOTH arguments through.
const lvTmpDirs: string[] = [];
function legacyViewArgs(repos: Record<string, object>, projectRepos: { ref: string }[]) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "devloop-bootlv-")));
  lvTmpDirs.push(tmp);
  for (const r of Object.values(repos)) mkdirSync(join(tmp, (r as { path: string }).path), { recursive: true });
  writeFileSync(join(tmp, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    workspaceId: "test",
    team: { key: "test", backend: "service", mode: "live", autonomy: "full" },
    repos,
    projects: { proj1: { repos: projectRepos } },
  }));
  const cfg = toLegacyView(loadWorkspace(tmp)) as unknown as
    { projects: Record<string, Record<string, unknown>>; repos?: Record<string, unknown> };
  const projectCfg = cfg.projects.proj1;
  return {
    projectCfg,
    registry: cfg.repos,   // undefined at runtime — passing it through IS the point of this fixture
    backend: (projectCfg as { backend?: string }).backend ?? "linear",
  };
}

const lvSingle = legacyViewArgs(
  { "dev-loop": { path: "clone", landing: "pr", autoMerge: true, mergeChecks: ["Test (Node 24)"] } },
  [{ ref: "dev-loop" }]);
ok(lvSingle.registry === undefined,
  "LOOP-279: toLegacyView emits no workspace-level repos registry — the 7th argument is undefined at runtime");
ok(Array.isArray((lvSingle.projectCfg as { repos?: unknown }).repos)
  && ((lvSingle.projectCfg as { repos: Record<string, unknown>[] }).repos[0]!).autoMerge === true,
  "LOOP-279: the projection inlines autoMerge:true into projects.proj1.repos[0] (the facts are already there)");
const lvBoot = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", lvSingle.backend,
  lvSingle.projectCfg, lvSingle.registry);
ok(!!lvBoot && !lvBoot.pruned.includes("12c"),
  "LOOP-279 AC1: real projection + autoMerge:true ⇒ §12c KEPT (pruned before the fix)");
ok(!!lvBoot && lvBoot.pruned.includes("19"),
  "LOOP-279 AC1: real projection, single repo ⇒ §19 pruned (one resolved repo, not zero)");
ok(!!lvBoot && lvBoot.pruned.includes("12d"),
  "LOOP-279 AC1: real projection, no deploy configured ⇒ §12d pruned");

// AC5 — a genuine ≥2-repo project must KEEP §19, asserted through the real projection too. Before
// the fix this pruned §19 for the wrong reason: zero repos resolved, so `length > 1` was vacuously
// false. Neither knob set here, so §12c/§12d must still prune.
const lvMulti = legacyViewArgs(
  { "repo-a": { path: "a", landing: "direct" }, "repo-b": { path: "b", landing: "direct" } },
  [{ ref: "repo-a" }, { ref: "repo-b" }]);
const lvMultiBoot = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", lvMulti.backend,
  lvMulti.projectCfg, lvMulti.registry);
ok(!!lvMultiBoot && !lvMultiBoot.pruned.includes("19"),
  "LOOP-279 AC5: real projection, 2 repos ⇒ §19 KEPT");
ok(!!lvMultiBoot && lvMultiBoot.pruned.includes("12c") && lvMultiBoot.pruned.includes("12d"),
  "LOOP-279 AC5: real projection, neither knob ⇒ §12c AND §12d pruned");

// AC5 — the deploy half of the §12c predicate resolves through the projection as well.
const lvDeploy = legacyViewArgs(
  { "repo-d": { path: "d", landing: "pr", deploy: { style: "release-pr" } } },
  [{ ref: "repo-d" }]);
const lvDeployBoot = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", lvDeploy.backend,
  lvDeploy.projectCfg, lvDeploy.registry);
ok(!!lvDeployBoot && !lvDeployBoot.pruned.includes("12c") && !lvDeployBoot.pruned.includes("12d"),
  "LOOP-279 AC5: real projection, deploy.style:release-pr ⇒ §12c AND §12d KEPT");

// AC6 — fail open on entries that resolve to nothing: no throw, and no pruning decision drawn from
// them (the assembler still returns a corpus).
const malformedRepos = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [null, 42, "dev-loop", {}, { ref: "absent-from-registry" }] }, undefined);
ok(!!malformedRepos,
  "LOOP-279 AC6: malformed/unresolvable repos entries ⇒ corpus still assembles, no throw");
ok(!!malformedRepos && malformedRepos.pruned.includes("12c"),
  "LOOP-279 AC6: nothing resolvable ⇒ §12c pruned, fail open");
for (const d of lvTmpDirs) rmSync(d, { recursive: true, force: true });

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
const jrFull = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ ref: "dev-loop" }] }, { "dev-loop": { autoMerge: true, landing: "pr" } });
ok(!!jrFull && jrFull.text.includes("your inherited fire-start + ship sequence, §21c, pre-read")
  && jrFull.text.includes("### Step 5.5 — Self-review the diff") && jrFull.text.includes("## HARD LIMITS"),
  "junior corpus carries dev's Steps 4–6.5 + 7 + HARD LIMITS (no mid-fire pull)");
ok(!!jrFull && jrFull.text.includes("### Step 0.5 — Merge eligible loop PRs")
  && jrFull.text.includes("NEVER re-freshen a PR merge-guard holds"),
  "junior corpus carries dev's Step 0.5 incl. the re-freshen safety rule (LOOP-553, autoMerge on)");
const jrNoMerge = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!jrNoMerge && !jrNoMerge.text.includes("### Step 0.5 — Merge eligible loop PRs")
  && jrNoMerge.text.includes("### Step 5.5 — Self-review the diff"),
  "no autoMerge/release-pr ⇒ the Step 0.5 slice is pruned with §12c, the ship sequence still ships (LOOP-553)");
ok(!!jrFull && !jrFull.text.includes("### Step 0 — Reclaim your orphans (crash recovery)"),
  "the slice excludes dev's Steps 0–3 (junior has its own pick/claim/groom)");
if (a) ok(!a.text.includes("skills/dev-agent/SKILL.md —"), "non-dev-tier corpora (pm) carry no inherited dev slice");

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

// ── LOOP-275: a TEAM-SCOPED steward fire spans every enabled project ──────────────────────────────
// The §19 predicate ("multi-repo model") evaluated only the representative project — the FIRST
// enabled one — so a team fire whose first enabled project is single-repo had §19 pruned even with a
// later enabled project holding two. The steward then reasoned about a workspace it had been told
// was single-repo. Corroborated by LOOP-236's Codex P2 review, deferred from that ticket.
{
  // Entries must carry an inline FACT key, or resolveRepos treats them as bare pointers and looks
  // them up in a registry we do not pass — which is a legitimate resolution path, not this test's
  // subject. `landing` is the cheapest fact that makes them resolvable the way a real entry is.
  const single = { repos: [{ name: "only", path: "only", landing: "pr" }] };
  const multi = { repos: [{ name: "a", path: "a", landing: "pr" }, { name: "b", path: "b", landing: "pr" }] };

  const has19 = (cfg: Record<string, unknown>, extras?: Record<string, unknown>[]): boolean => {
    const c = assembleBootCorpus(root, dataDir, "sweep", "p", "service", cfg, undefined, extras);
    return !!c && !/§19 — single-repo project/.test(c.text);
  };

  // The control first: single-repo alone genuinely prunes §19, so the assertion below is not vacuous.
  ok(!has19(single), "LOOP-275 control: a single-repo project prunes §19 — the pruning itself still works");
  ok(has19(multi), "LOOP-275 control: a multi-repo project keeps §19");

  // The measured shape: representative project single-repo, a LATER enabled project multi-repo.
  ok(has19(single, [multi]),
    "LOOP-275: a team-scoped fire whose FIRST enabled project is single-repo still keeps §19 when a later enabled project has ≥2 repos");
  ok(!has19(single, [single]),
    "LOOP-275: a team scope where EVERY enabled project is single-repo still PRUNES §19 — the count is the max of any one project, not the union, because §19 is about coordinating a change ACROSS repos and that never arises inside a single-repo project");
  ok(has19(multi, [single]),
    "LOOP-275: order does not matter — the union is over every enabled project, not just the first two");
}

console.log(fails === 0 ? "\nBOOT_PREFIX_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
