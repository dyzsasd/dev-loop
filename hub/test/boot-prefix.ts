// boot-prefix tests — the runner-assembled §0a corpus (conventions-to-code phase 0).
// Contracts under test: (1) byte-determinism — same inputs ⇒ identical text+hash (the
// prompt-cache prerequisite); (2) bill consistency — the conventions slice measures
// EXACTLY what context-bill's conventionsLoad bills (one span authority, two consumers);
// (3) the §0a lessons slice (own + Shared, + Dev for split tiers); (4) per-backend
// contract-file selection; (5) fail-open on a malformed/missing SKILL.
import { mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";

import { join } from "node:path";
import { assembleBootCorpus, assembleJobCorpus, conventionsUnionText, lessonsSlice } from "../src/boot-prefix.ts";
import { loadWorkspace, toLegacyView } from "../src/team-config.ts";
import { parseConventions, parseSectionsLine, splitSkill, conventionsLoad, pluginRoot, jobSlice, jobsOf, cheatSlice } from "../src/context-bill.ts";
import { tmpRoot } from "./tmp-root.ts";

const root = pluginRoot();
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── fixture data dir with a lessons file ──────────────────────────────────────────────────────────
const dataDir = tmpRoot("devloop-boot-");
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
  ok(/do NOT re-read\s+those files/.test(a.text) && a.text.includes("AUTHORITATIVE for §0a"), "the inline §0a skip instruction rides the block, and names itself authoritative for steps 1–4 (WS-A)");
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

// ── 4b. config-aware selection of the CLASSIC conventions union (captured-context review 2026-07-20) ──
// The whole-role classic boot (a bare `pm`/`qa` actor, or any migrated agent's fail-open fallback) subsets
// its declared Sections per THIS project's config: a span whose feature is off never ships. The migrated
// agents now JOB-boot (§6) and never take this path in production, but the pruning MECHANISM
// (resolveRepos + CONDITIONAL_SECTIONS) still governs the whole-role fallback, so it stays covered here —
// repointed to agents that still DECLARE the conditional anchors (pm: §5/§19/§24; ops: §12c/§19). The old
// junior-dev fixtures are retired: junior-dev's slimmed Sections no longer declare §5/§12c/§12d/§19, and it
// job-boots regardless (§6). §12d is declared by no SKILL any more; its deploy-fact resolution path is the
// SAME `resolveRepos`+deploy predicate §12c exercises below (deploy.style:release-pr), so its intent is ported.
const bare = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", {});
ok(!!bare && JSON.stringify(bare.pruned) === JSON.stringify(["5", "19", "24"]),
  `bare pm service config prunes §5 (queue pre-ranks) + §19 (single-repo) + §24 (codex off) (got: ${bare?.pruned.join(",")})`);
ok(!!bare && !bare.text.includes("## 19. Multiple repos") && /declared but OFF in this project's config: [^\]]*§19/.test(bare.text),
  "a pruned span's content is absent and its gap marker says config-off, not uncited");
const bareOps = assembleBootCorpus(root, dataDir, "ops", "proj1", "service", {});
ok(!!bareOps && bareOps.pruned.includes("12c") && bareOps.pruned.includes("19"),
  `bare ops service config prunes §12c (no autoMerge/deploy) + §19 (single-repo) (got: ${bareOps?.pruned.join(",")})`);

// ── real-workspace-shape regression (LOOP-236) ────────────────────────────────────────────────────
// The real dev-loop workspace shape: project.repos is ProjectRepoRef[] pointers, repo facts live
// in the workspace-level repos registry (flat autoMerge/deploy — NOT nested under .git/.deploy). §12c is
// the anchor whose predicate reads those flat facts, so it drives this regression; ops declares it.

// Fixture A: single repo, autoMerge=true, no deploy → §12c kept, §19 pruned (ops declares both).
const realSingleAutoMerge = assembleBootCorpus(root, dataDir, "ops", "proj1", "service",
  { repos: [{ ref: "dev-loop" }] },
  { "dev-loop": { autoMerge: true, landing: "pr" } });
ok(!!realSingleAutoMerge && !realSingleAutoMerge.pruned.includes("12c"),
  "LOOP-236: real-shape single repo with autoMerge:true → §12c NOT pruned (flat field read)");
ok(!!realSingleAutoMerge && realSingleAutoMerge.pruned.includes("19"),
  "LOOP-236: real-shape single repo → §19 pruned (≤1 repo, >1 semantics)");

// Fixture B: neither knob (no autoMerge, no deploy) → §12c pruned (the pruning still works)
const realNeitherKnob = assembleBootCorpus(root, dataDir, "ops", "proj1", "service",
  { repos: [{ ref: "r1" }] },
  { r1: { landing: "pr" } });
ok(!!realNeitherKnob && realNeitherKnob.pruned.includes("12c"),
  "LOOP-236: neither autoMerge nor deploy → §12c pruned (pruning still works)");

// Fixture C: ≥2 repos → §19 kept
const realMultiRepo = assembleBootCorpus(root, dataDir, "ops", "proj1", "service",
  { repos: [{ ref: "r1" }, { ref: "r2" }] },
  { r1: { autoMerge: true }, r2: { autoMerge: true } });
ok(!!realMultiRepo && !realMultiRepo.pruned.includes("19"),
  "LOOP-236: ≥2 repos in registry → §19 NOT pruned (multi-repo)");

// Fixture D: ref not in registry → fail open, no throw, treated as no repos for that anchor
let dThrew = false;
let realGhostRef: ReturnType<typeof assembleBootCorpus> = null;
try { realGhostRef = assembleBootCorpus(root, dataDir, "ops", "proj1", "service",
  { repos: [{ ref: "ghost" }] }, {}); } catch { dThrew = true; }
ok(!dThrew, "LOOP-236: ref not in registry → no throw (fail open)");
ok(!!realGhostRef && realGhostRef.pruned.includes("12c"),
  "LOOP-236: ref not in registry → §12c pruned (no repos resolved, fail open)");

// Keep hash/size determinism check with new real-shape fixtures
const realSingle2 = assembleBootCorpus(root, dataDir, "ops", "proj1", "service",
  { repos: [{ ref: "dev-loop" }] },
  { "dev-loop": { autoMerge: true, landing: "pr" } });
ok(!!realSingleAutoMerge && !!realSingle2 && realSingleAutoMerge.text === realSingle2.text,
  "LOOP-236: same real-shape config ⇒ byte-identical (cache key holds)");
ok(!!bareOps && !!realSingleAutoMerge && bareOps.hash !== realSingleAutoMerge.hash,
  "LOOP-236: pruned-bare vs auto-merge-on have different hashes");

// ── Fixture E (LOOP-279) — drive the REAL toLegacyView projection, not a hand-built argument ─────
// The production caller passes `cfg = toLegacyView(ws)`, then `assembleBootCorpus(…, cfg.projects[key],
// cfg.repos)`. LegacyProjectsConfig declares NO workspace-level `repos` registry, so that 7th argument is
// structurally `undefined` on every v2 workspace — the assembler must resolve repo facts from the INLINE
// per-project repos[] the projection emits (LOOP-279 was §12c pruned because it only read the absent
// registry). Build a workspace file, project it, pass BOTH arguments through. Exercised on `ops` (declares
// §12c/§19).
const lvTmpDirs: string[] = [];
function legacyViewArgs(repos: Record<string, object>, projectRepos: { ref: string }[]) {
  const tmp = realpathSync(tmpRoot("devloop-bootlv-"));
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
const lvBoot = assembleBootCorpus(root, dataDir, "ops", "proj1", lvSingle.backend,
  lvSingle.projectCfg, lvSingle.registry);
ok(!!lvBoot && !lvBoot.pruned.includes("12c"),
  "LOOP-279 AC1: real projection + autoMerge:true ⇒ §12c KEPT (pruned before the fix)");
ok(!!lvBoot && lvBoot.pruned.includes("19"),
  "LOOP-279 AC1: real projection, single repo ⇒ §19 pruned (one resolved repo, not zero)");

// AC5 — a genuine ≥2-repo project must KEEP §19, asserted through the real projection too. Before
// the fix this pruned §19 for the wrong reason: zero repos resolved, so `length > 1` was vacuously
// false. Neither knob set here, so §12c must still prune.
const lvMulti = legacyViewArgs(
  { "repo-a": { path: "a", landing: "direct" }, "repo-b": { path: "b", landing: "direct" } },
  [{ ref: "repo-a" }, { ref: "repo-b" }]);
const lvMultiBoot = assembleBootCorpus(root, dataDir, "ops", "proj1", lvMulti.backend,
  lvMulti.projectCfg, lvMulti.registry);
ok(!!lvMultiBoot && !lvMultiBoot.pruned.includes("19"),
  "LOOP-279 AC5: real projection, 2 repos ⇒ §19 KEPT");
ok(!!lvMultiBoot && lvMultiBoot.pruned.includes("12c"),
  "LOOP-279 AC5: real projection, neither knob ⇒ §12c pruned");

// AC5 — the deploy half of the §12c predicate resolves through the projection as well (ports the retired
// §12d deploy-fact coverage: same resolveRepos+deploy path).
const lvDeploy = legacyViewArgs(
  { "repo-d": { path: "d", landing: "pr", deploy: { style: "release-pr" } } },
  [{ ref: "repo-d" }]);
const lvDeployBoot = assembleBootCorpus(root, dataDir, "ops", "proj1", lvDeploy.backend,
  lvDeploy.projectCfg, lvDeploy.registry);
ok(!!lvDeployBoot && !lvDeployBoot.pruned.includes("12c"),
  "LOOP-279 AC5: real projection, deploy.style:release-pr ⇒ §12c KEPT (deploy-fact resolution)");

// AC6 — fail open on entries that resolve to nothing: no throw, and no pruning decision drawn from
// them (the assembler still returns a corpus).
const malformedRepos = assembleBootCorpus(root, dataDir, "ops", "proj1", "service",
  { repos: [null, 42, "dev-loop", {}, { ref: "absent-from-registry" }] }, undefined);
ok(!!malformedRepos,
  "LOOP-279 AC6: malformed/unresolvable repos entries ⇒ corpus still assembles, no throw");
ok(!!malformedRepos && malformedRepos.pruned.includes("12c"),
  "LOOP-279 AC6: nothing resolvable ⇒ §12c pruned, fail open");
for (const d of lvTmpDirs) rmSync(d, { recursive: true, force: true });

const featured = realMultiRepo; // alias for assertions below that use the 'featured' name
ok(!!featured && featured.text.includes("## 19. Multiple repos"),
  "multi-repo featured config ships §19");
ok(!!bareOps && !!featured && bareOps.bytes < featured.bytes,
  "pruning is config-deterministic and smaller (different hash, fewer bytes)");
const bare2 = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", {});
ok(!!bare && !!bare2 && bare.text === bare2.text, "same config ⇒ byte-identical (cache key holds)");
const linearPm = assembleBootCorpus(root, dataDir, "pm", "proj1", "linear", {});
ok(!!linearPm && !linearPm.pruned.includes("5") && linearPm.text.includes("## 5. Priority"),
  "a linear fire keeps the §5 ranking prose (no queue op there)");
// effective-span accounting: pm declares lint-forced parent+child pairs (§9 + §9a–c) — the header
// counts distinct shipped spans, not declared tokens.
if (a) {
  const m = /always-read \+ (\d+) spans of your (\d+) declared §/.exec(a.text);
  ok(!!m && Number(m[1]) < Number(m[2]), `pm header counts effective spans < declared (${m?.[1]} < ${m?.[2]})`);
}

// ── 4c. the dev tiers JOB-boot (LOOP-553 inheritance retired) ─────────────────────────────────────
// The split tiers used to CLASSIC-boot and inherit dev-agent's fire-start + ship-sequence marker spans;
// that content moved into the shared dev playbooks the dev/senior/junior JOB spans pull, so the tiers now
// JOB-boot. Assert the job-corpus shape: a dev/senior/junior job corpus carries the constitution + the
// right shared playbooks (the ship sequence, now a pulled playbook), is byte-deterministic per (actor,job),
// and a different job differs. (assembleJobCorpus is the delivery vehicle; the pushed path calls it too.)
{
  const constitution = readFileSync(join(root, "skills", "_constitution.md"), "utf8");
  const shipPlaybook = readFileSync(join(root, "skills", "playbooks", "ship.md"), "utf8").trim().slice(0, 120);
  // dev/ship — the canonical Step 0–7 ship sequence, now pulled from shared playbooks.
  const devShip1 = assembleJobCorpus(root, "dev", "ship");
  const devShip2 = assembleJobCorpus(root, "dev", "ship");
  ok(!!devShip1 && !!devShip2 && devShip1.text === devShip2.text && devShip1.hash === devShip2.hash,
    "dev/ship job corpus is byte-deterministic (the (actor,job) cache prefix holds)");
  ok(!!devShip1 && devShip1.text.includes("skills/_constitution.md") && devShip1.text.includes(constitution.trim().slice(0, 200)),
    "dev/ship carries the resident constitution VERBATIM");
  ok(!!devShip1 && devShip1.text.includes(shipPlaybook) && devShip1.text.includes("### skills/playbooks/ship.md"),
    "dev/ship inlines the shared SH-ship playbook it pulls (the ship sequence)");
  ok(!!devShip1 && devShip1.text.includes("### skills/playbooks/fire-start.md"),
    "dev/ship inlines the shared SH-fire-start playbook (the Step 0.5 merge pass, now a pulled playbook)");
  ok(!!devShip1 && devShip1.conventionsBytes === 0 && !devShip1.text.includes("## 19. Multiple repos"),
    "dev/ship drops the conventions union (the constitution is resident; reference stubs are read on demand)");
  // junior/implement carries the ship sequence AND its own read-implement playbook.
  const jrImpl = assembleJobCorpus(root, "junior-dev", "implement");
  ok(!!jrImpl && jrImpl.text.includes("### skills/playbooks/ship.md") && jrImpl.text.includes("### skills/playbooks/read-implement.md"),
    "junior-dev/implement inlines the shared ship + read-implement playbooks (no mid-fire pull)");
  ok(!!jrImpl && !!devShip1 && jrImpl.text !== devShip1.text && jrImpl.hash !== devShip1.hash,
    "junior-dev/implement differs from dev/ship (different work ⇒ different corpus + hash)");
  // senior-dev has TWO jobs (design vs directcode) chosen from the ticket Mode marker — they differ.
  const snDesign = assembleJobCorpus(root, "senior-dev", "design");
  const snDirect = assembleJobCorpus(root, "senior-dev", "directcode");
  ok(!!snDesign && snDesign.text.includes("### skills/playbooks/design-delegate.md") && !snDesign.text.includes("### skills/playbooks/ship.md"),
    "senior-dev/design pulls the design-delegate playbook, NOT the ship sequence (judgment-scaffold)");
  ok(!!snDirect && snDirect.text.includes("### skills/playbooks/ship.md") && !snDirect.text.includes("### skills/playbooks/design-delegate.md"),
    "senior-dev/directcode pulls the ship sequence, NOT the design playbook (mechanical escalation)");
  ok(!!snDesign && !!snDirect && snDesign.text !== snDirect.text && snDesign.hash !== snDirect.hash,
    "senior-dev design vs directcode are different corpora + hashes (the Mode pick selects between them)");
}
if (a) ok(!a.text.includes("skills/dev-agent/SKILL.md —"), "non-dev-tier corpora (pm) carry no inherited dev slice");

// ── 4d. LOOP-163 regression: new-path lessons delivery (INDEX + project shard) ───────────────────
// The legacy dataDir puts a lessons.md at join(dataDir, "proj1", "lessons.md") — that's the v1
// path. The new path is join(dataDir, "lessons", "INDEX.md") + join(dataDir, "lessons", "proj1.md").
// Verify the assembler reads from the new path and delivers sentinel rules into the corpus.
{
  const wsDir = tmpRoot("dl-bp-ws-");
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
    const emptyWs = tmpRoot("dl-bp-empty-");
    const cEmpty = assembleBootCorpus(root, emptyWs, "pm", "proj1", "service");
    ok(!!cEmpty, "LOOP-163 AC3: no lessons dir at all — assembles cleanly (fail open)");
    ok(!!cEmpty && cEmpty.lessonsBytes === 0, "LOOP-163 AC3: lessonsBytes=0 when no lessons files present");
    rmSync(emptyWs, { recursive: true, force: true });

    // AC3b: legacy path <dataDir>/<project>/lessons.md still contributes when present
    const legacyWs = tmpRoot("dl-bp-legacy-");
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

// ── 4e. WS-A A6 — the Resolved config block (§0a step 2) rides the corpus when the caller resolves it ──
{
  const resolved = {
    projectKey: "proj1", teamKey: "t", backend: "service", mode: "live", autonomy: "full", devSplit: true, intakeMode: "passive",
    deployPolicy: { dev: "auto", prod: "manual" }, strategyDoc: "docs/STRATEGY.md (repo file)",
    repos: [{ ref: "web", role: "primary", landing: "pr", defaultBranch: "main", autoMerge: true, deployStyle: "release-pr" }, { ref: "api", landing: "direct" }],
  };
  const withCfg = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", { repos: [{ ref: "web" }, { ref: "api" }] }, { web: { autoMerge: true }, api: {} }, undefined, resolved);
  const without = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", { repos: [{ ref: "web" }, { ref: "api" }] }, { web: { autoMerge: true }, api: {} });
  ok(!!withCfg && withCfg.text.includes("### Resolved config (§0a step 2, pre-assembled) — project: proj1 · team: t · backend: service"),
    "WS-A A6: the corpus carries the Resolved config header with project/team/backend");
  ok(!!withCfg && /- mode: live · autonomy: full · devSplit: true · intake.mode: passive/.test(withCfg.text), "WS-A A6: …the governing knobs");
  ok(!!withCfg && /- deployPolicy: dev=auto, prod=manual/.test(withCfg.text) && /- strategyDoc: docs\/STRATEGY\.md \(repo file\)/.test(withCfg.text), "WS-A A6: …deploy policy + the strategyDoc form label (never its content)");
  ok(!!withCfg && /- repos \(2 — multi-repo, §19\):\n  - web — role primary; landing pr; defaultBranch main; autoMerge on; deploy\.style release-pr\n  - api — landing direct; defaultBranch main \(default\)/.test(withCfg.text),
    "WS-A A6: …every repo with its landing mode, default branch and merge/deploy facts");
  ok(!!without && !without.text.includes("### Resolved config"), "WS-A A6: no resolver ⇒ no block (existing callers keep their bytes)");
  const again = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", { repos: [{ ref: "web" }, { ref: "api" }] }, { web: { autoMerge: true }, api: {} }, undefined, resolved);
  ok(!!withCfg && !!again && withCfg.text === again.text, "WS-A A6: the block is byte-deterministic (cache key holds)");
  ok(!!withCfg && withCfg.text.indexOf("### Resolved config") < withCfg.text.indexOf("### lessons"), "WS-A A6: the block sits between the conventions slice and the lessons");
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

// ── 6. job-scoped prompts (docs/design/job-scoped-prompts.md) ─────────────────────────────────────
// jobSlice / jobsOf are the one span authority; assembleBootCorpus(job) is the delivery vehicle. M1/M2.
{
  const pmSkill = readFileSync(join(root, "skills", "pm-agent", "SKILL.md"), "utf8");
  ok(JSON.stringify(jobsOf(pmSkill)) === JSON.stringify(["verify", "unblock", "groom", "review"]),
    `jobsOf(pm SKILL) = the four declared job markers, first-seen order (got ${jobsOf(pmSkill).join(",")})`);
  const vspan = jobSlice(pmSkill, "verify");
  ok(!!vspan && vspan.kind === "mechanical", `jobSlice parses the verify span's kind (got ${vspan?.kind})`);
  ok(!!vspan && vspan.pulls.includes("skills/playbooks/verify-close.md") && vspan.pulls.includes("references/conventions/verification.md"),
    "jobSlice parses the verify span's pulls: (shared playbook + reference stub)");
  ok(jobSlice(pmSkill, "nope") === null, "jobSlice returns null for an undeclared job (fail-open)");

  // (a) byte-determinism — the cache prerequisite for a (actor, job) prefix.
  const v1 = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", undefined, undefined, undefined, undefined, "verify");
  const v2 = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", undefined, undefined, undefined, undefined, "verify");
  ok(!!v1 && !!v2 && v1.text === v2.text && v1.hash === v2.hash,
    "assembleBootCorpus(…,'verify') is byte-deterministic across two calls (the cache prefix holds)");
  // (b) contains the constitution + the verify span + its pulled shared playbooks, and NOT groom/review.
  const constitution = readFileSync(join(root, "skills", "_constitution.md"), "utf8");
  ok(!!v1 && v1.text.includes(constitution.trim().slice(0, 200)) && v1.text.includes("skills/_constitution.md"),
    "…carries skills/_constitution.md VERBATIM (the resident kernel)");
  ok(!!v1 && v1.text.includes("### Job A — Verify") && v1.text.includes("kind: mechanical"),
    "…carries the verify job span (with its kind front-matter)");
  ok(!!v1 && v1.text.includes(readFileSync(join(root, "skills", "playbooks", "verify-close.md"), "utf8").trim().slice(0, 120))
    && v1.text.includes(readFileSync(join(root, "skills", "playbooks", "file-ticket.md"), "utf8").trim().slice(0, 120)),
    "…inlines the shared playbooks the verify span pulls (verify-close + file-ticket)");
  ok(!!v1 && !v1.text.includes("### Job B2 — Groom") && !v1.text.includes("### Job C — Review"),
    "…does NOT carry the groom or review spans (only this fire's job)");
  ok(!!v1 && !v1.text.includes("## 9. ") && v1.conventionsBytes === 0,
    "…drops the conventions union (the constitution is resident; reference stubs are read on demand)");
  ok(!!v1 && v1.text.includes("references/conventions/verification.md"),
    "…the reference stubs it pulls are NAMED (on-demand) but not inlined — the span's pulls: line rides the corpus");
  // (c) a different-job call yields a different prefix (correct — different work).
  const g = assembleBootCorpus(root, dataDir, "pm", "proj1", "service", undefined, undefined, undefined, undefined, "groom");
  ok(!!g && !!v1 && g.text !== v1.text && g.hash !== v1.hash,
    "a different job (groom) yields a different corpus + hash (pm/verify vs pm/groom differ)");
  ok(!!g && g.text.includes("### Job B2 — Groom") && !g.text.includes("### Job A — Verify"),
    "the groom corpus carries the groom span, not verify");
  // pushed corpus == the assembleJobCorpus the pull verb prints (one authority — pushed ≡ pulled). The pull
  // verb resolves the SAME workspace (dataDir + project), so the two carry the same §14 lessons + cheat.
  const pulled = assembleJobCorpus(root, "pm", "verify", dataDir, "proj1");
  ok(!!pulled && !!v1 && pulled.text === v1.text,
    "assembleJobCorpus (the pull verb's source) is byte-identical to the pushed job corpus");
  // fail-open: an undeclared job ⇒ null (runAgent then degrades to the classic full-SKILL boot).
  ok(assembleBootCorpus(root, dataDir, "pm", "proj1", "service", undefined, undefined, undefined, undefined, "nope") === null,
    "assembleBootCorpus(…,'nope') ⇒ null for an undeclared job (fail-open)");
}

// ── 6b. qa + steward job corpora (job-scoped prompts) — every migrated agent job-boots ─────────────
// qa (a two-lane agent) and the single-job stewards each load their job corpus the same way pm/dev do:
// byte-deterministic per (actor, job), carrying the constitution + the right shared playbooks.
{
  const constitution = readFileSync(join(root, "skills", "_constitution.md"), "utf8").trim().slice(0, 200);
  // qa/bughunt — the change-gated hunt lane's job.
  const qh1 = assembleJobCorpus(root, "qa", "bughunt");
  const qh2 = assembleJobCorpus(root, "qa", "bughunt");
  ok(!!qh1 && !!qh2 && qh1.text === qh2.text && qh1.hash === qh2.hash, "qa/bughunt job corpus is byte-deterministic");
  ok(!!qh1 && qh1.text.includes(constitution) && qh1.text.includes("### skills/playbooks/bug-hunt.md") && qh1.text.includes("### skills/playbooks/file-ticket.md"),
    "qa/bughunt carries the constitution + the shared bug-hunt + file-ticket playbooks it pulls");
  // qa/verify vs qa/unblock — the two maintenance-lane jobs differ. qv resolves the fixture workspace's
  // lessons (dataDir + proj1) so it stays byte-identical to the pushed corpus below (pushed ≡ pulled).
  const qv = assembleJobCorpus(root, "qa", "verify", dataDir, "proj1");
  const qu = assembleJobCorpus(root, "qa", "unblock");
  ok(!!qv && qv.text.includes("### skills/playbooks/verify-close.md"), "qa/verify pulls the verify-close playbook");
  ok(!!qu && qu.text.includes("### skills/playbooks/block-park.md"), "qa/unblock pulls the block-park playbook");
  ok(!!qv && !!qu && !!qh1 && qv.text !== qu.text && qv.text !== qh1.text && qv.hash !== qu.hash,
    "qa's three jobs (verify/unblock/bughunt) are distinct corpora + hashes");
  // pushed ≡ pulled (one authority) for a non-pm agent too.
  const qvPushed = assembleBootCorpus(root, dataDir, "qa", "proj1", "service", undefined, undefined, undefined, undefined, "verify");
  ok(!!qvPushed && !!qv && qvPushed.text === qv.text, "qa pushed job corpus ≡ assembleJobCorpus (the pull verb's source)");
  // a single-job steward: sweep/sweep.
  const sw = assembleJobCorpus(root, "sweep", "sweep");
  ok(!!sw && sw.text.includes(constitution) && sw.text.includes("### skills/playbooks/sweep.md")
    && sw.text.includes("### skills/playbooks/file-ticket.md") && sw.text.includes("### skills/playbooks/block-park.md"),
    "sweep/sweep carries the constitution + the sweep + file-ticket + block-park playbooks it pulls");
  ok(!!sw && sw.conventionsBytes === 0, "sweep/sweep drops the conventions union (constitution is resident)");
  // every other single-job steward assembles (communication/article, reflect/retro, ops/poll, architect/audit).
  for (const [agent, job] of [["communication", "article"], ["reflect", "retro"], ["ops", "poll"], ["architect", "audit"]] as const) {
    const c = assembleJobCorpus(root, agent, job);
    ok(!!c && c.text.includes(constitution) && c.bytes > 0, `${agent}/${job} job corpus assembles (constitution + its playbooks)`);
  }
}

// ── 6c. the two systemic gaps FIXED: a job corpus now carries the §14 lessons slice + the CLI cheat-sheet ──
// Audit gaps (every migrated agent): job fires DROPPED lessons (the loop's cross-fire learning, §14) and the
// GENERATED CLI cheat-sheet (exact dev-loop verb forms + flags + exit codes) — both live in the SKILL frame
// job-boot omits. The corpus must now inject both, keep byte-stability per (agent, job, workspace-config),
// and slice ## Dev for a split tier.
{
  // (a) the CLI cheat-sheet is per-AGENT (lifted from the SKILL) — present with NO workspace at all.
  const pmCheat = cheatSlice(readFileSync(join(root, "skills", "pm-agent", "SKILL.md"), "utf8"));
  ok(pmCheat.length > 0 && pmCheat.startsWith("<!-- cli-cheatsheet:begin agent=pm -->") && pmCheat.endsWith("<!-- cli-cheatsheet:end agent=pm -->"),
    "cheatSlice lifts the pm cli-cheatsheet block VERBATIM (markers inclusive — the byte-checked block)");
  const noWs = assembleJobCorpus(root, "pm", "verify");
  ok(!!noWs && noWs.text.includes("### CLI cheat-sheet (exact verb forms + exit codes)") && noWs.text.includes(pmCheat),
    "the job corpus carries the agent's exact CLI cheat-sheet block (no workspace needed — it comes from the SKILL)");
  ok(!!noWs && noWs.lessonsBytes === 0, "no workspace ⇒ lessonsBytes 0 (the cheat-sheet still ships)");

  // (b) with the fixture workspace's lessons (dataDir/proj1/lessons.md carries Shared/PM/QA/Dev/junior-dev),
  // the corpus carries the SLICED §14 lessons and reports the real injected bytes (not 0 — the audit bug).
  const withLessons = assembleJobCorpus(root, "pm", "verify", dataDir, "proj1");
  ok(!!withLessons && withLessons.lessonsBytes > 0, `lessonsBytes is the real injected count (>0) when lessons exist (got ${withLessons?.lessonsBytes})`);
  ok(!!withLessons && withLessons.text.includes("### lessons — your section + ## Shared") && withLessons.text.includes("- pm rule") && withLessons.text.includes("- shared rule"),
    "the corpus embeds the sliced lessons — the agent's own section + ## Shared (§0a step 4, the §14 learning loop)");
  ok(!!withLessons && !withLessons.text.includes("- qa rule"), "the lessons slice still excludes other roles (pm gets no ## QA)");
  ok(!!withLessons && !!noWs && withLessons.bytes > noWs.bytes && withLessons.lessonsBytes === Buffer.byteLength(lessonsSlice(LESSONS, "pm"), "utf8"),
    "the lessons-bearing corpus is larger, and lessonsBytes = the sliced-slice bytes exactly (the legacy proj1/lessons.md, sliced to pm)");

  // (c) byte-determinism per (agent, job, workspace-config): two identical calls ⇒ identical text + hash.
  const w2 = assembleJobCorpus(root, "pm", "verify", dataDir, "proj1");
  ok(!!withLessons && !!w2 && withLessons.text === w2.text && withLessons.hash === w2.hash,
    "two same-(agent, job, workspace) corpora are byte-identical (the A2 cache-prefix invariant holds WITH lessons+cheat)");

  // (d) a split dev tier gets ## Dev in its lessons slice (§0a step 4 for junior-dev/senior-dev).
  const jr = assembleJobCorpus(root, "junior-dev", "implement", dataDir, "proj1");
  ok(!!jr && jr.text.includes("- dev tier rule") && jr.text.includes("- junior rule") && jr.text.includes("- shared rule"),
    "a split dev tier's lessons slice adds ## Dev (dev-tier rule) alongside its own section + ## Shared");
  ok(!!jr && jr.text.includes("### CLI cheat-sheet") && jr.text.includes(cheatSlice(readFileSync(join(root, "skills", "junior-dev-agent", "SKILL.md"), "utf8"))),
    "the junior-dev job corpus also carries its own CLI cheat-sheet block");
}

console.log(fails === 0 ? "\nBOOT_PREFIX_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
