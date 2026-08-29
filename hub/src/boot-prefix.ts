// boot-prefix.ts — the runner-assembled boot corpus (conventions-to-code phase 0).
// Instead of every fire re-pulling conventions/lessons/backend-contract through N Read
// calls interleaved with model output (unstable prefix ⇒ no prompt-cache hits, and
// selective reading left to agent discipline), the scheduler assembles the EXACT §0a
// boot material into one deterministic block appended to the fire prompt:
//   • conventions: always-read (title/ToC + Topology) + the union of the agent's cited
//     §-spans — the same span math the context bill uses (context-bill.ts is the one
//     authority; this module never re-derives grammar).
//   • lessons: the agent's own section (+ ## Dev for split tiers) + ## Shared (§0a step 4).
//   • the per-backend contract file (§18 tripwire): backend-service.md / backend-local.md.
// The block is byte-deterministic for (agent, files-on-disk): same inputs ⇒ same bytes,
// so consecutive fires of one agent present an identical prompt prefix (cacheable).
// Fail-open: ANY assembly error returns null and the fire falls back to §0a pull mode.
import { existsSync, readFileSync } from "node:fs";
import { selfDriftLine, installedRootOf } from "./self-drift.ts"; // LOOP-249: does the source this fire reads describe the code it runs?
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseConventions, parseSectionsLine, splitSkill, jobSlice, cheatSlice, readConstitution, type JobSpan } from "./context-bill.ts";
import { lessonsSlice } from "./lessons.ts";
export { lessonsSlice, LESSONS_SECTION } from "./lessons.ts"; // the slicer moved to lessons.ts (one authority for the assembler AND the bill); re-exported for existing importers

export interface BootCorpus {
  text: string;        // the full marker-wrapped block to append to the prompt
  bytes: number;       // Buffer.byteLength(text)
  hash: string;        // sha256 of the corpus body (12 hex chars) — riding in the marker
  conventionsBytes: number; // the union slice alone (bill cross-check)
  lessonsBytes: number; // actual lessons bytes injected (delivery count, not cap — 0 when no lessons)
  pruned: string[];    // config-gated anchors dropped for THIS project (feature off)
}

// ── configuration-aware selection (captured-context review, 2026-07-20) ─────────────────────────
// A SKILL's `Sections:` line is the static SUPERSET — the pull-mode contract for every config.
// The assembler knows THIS project's config, so spans whose feature is off never ship: the §12c
// auto-merge pass on a project with no auto-merge is dead weight on every fire. The Sections
// grammar, the set-equality lint, and pull-mode behavior are untouched; pruning is assembler-only
// and fails OPEN (unreadable config ⇒ no pruning). Conservative v1 table — every predicate is
// "the feature is affirmatively configured somewhere in this project".
type ProjectCfg = Record<string, unknown> | null | undefined;
type ReposRegistry = Record<string, unknown> | null | undefined;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
// The repo facts every predicate below reads. They are the discriminator between the two entry
// shapes: a raw workspace `ProjectRepoRef` is `{ref, role?}` and carries NONE of them, while the
// legacy view builds an object literal with all of them — so the keys are OWN properties there even
// when the value is undefined, which is what makes presence (not truthiness) the correct test.
const REPO_FACT_KEYS = ["landing", "autoMerge", "mergeChecks", "build", "deploy", "ops"] as const;
const hasInlineFacts = (e: Record<string, unknown>): boolean =>
  REPO_FACT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(e, k));
// Resolve the project's repos[] to the fact-bearing objects the predicates read, from EITHER shape.
// The runtime caller (run-agents.ts) passes `toLegacyView(ws)`, whose LegacyProjectsConfig has no
// workspace-level `repos` registry at all — so the registry argument is `undefined` on every v2
// workspace and a registry-only resolution yields [] and prunes §12c with autoMerge:true sitting
// inline in the entry (LOOP-279). Hence: prefer the entry's own facts, use the registry only to
// resolve a bare pointer.
// Falls OPEN: an unresolvable ref ⇒ omit it (no throw, no pruning decision drawn from that entry).
const resolveRepos = (cfg: ProjectCfg, reg: ReposRegistry): Record<string, unknown>[] => {
  const r = asObj(cfg).repos;
  if (!Array.isArray(r)) return [];
  const registry = asObj(reg);
  return r
    .map((entry) => {
      const e = asObj(entry);
      // Legacy-view shape ({name, path, flat facts}) — the facts are already here; the registry
      // the production caller would have to synthesize for them does not exist.
      if (hasInlineFacts(e)) return e;
      // Bare pointer (raw workspace {ref} / a {name}-only entry) ⇒ resolve through the registry.
      const ref = typeof e.ref === "string" ? e.ref : (typeof e.name === "string" ? e.name : undefined);
      if (ref !== undefined && registry[ref]) return asObj(registry[ref]);
      return null;
    })
    .filter((e): e is Record<string, unknown> => e !== null);
};
const anyRepo = (repos: Record<string, unknown>[], pick: (o: Record<string, unknown>) => boolean): boolean =>
  repos.some(pick);
// `repos` is the UNION across every project in scope — the anyRepo predicates ask "does any repo in
// scope have this fact?", and a union answers that. `maxPerProject` is the largest repo count of any
// SINGLE project, which is a different question and the one §19 asks.
export const CONDITIONAL_SECTIONS: Record<string, { why: string; active: (cfg: ProjectCfg, backend: string, repos: Record<string, unknown>[], maxPerProject: number) => boolean }> = {
  "5": { // the pick ranking — the `queue` op computes it server-side on the hub backend
    why: "the queue op pre-ranks on service",
    active: (_cfg, backend) => backend !== "service",
  },
  "12c": { // auto-merge (flat autoMerge field) + release-PR deploy — only real when one of the two knobs is on
    why: "no autoMerge / deploy.style:\"release-pr\" configured",
    active: (_cfg, _backend, repos) => anyRepo(repos, (o) => o.autoMerge === true || asObj(o.deploy).style === "release-pr"),
  },
  "12d": { // deploy ceiling — meaningless when nothing can deploy
    why: "no deploy configured",
    active: (_cfg, _backend, repos) => anyRepo(repos, (o) => Object.keys(asObj(o.deploy)).length > 0),
  },
  "19": { // multi-repo model — strictly for projects with ≥2 repos
    why: "single-repo project",
    // MAX per project, not the union count (LOOP-275). §19 is about coordinating one change ACROSS
    // repos, which only arises when a single project is itself multi-repo. A team-scoped fire
    // spanning two SINGLE-repo projects touches two repos and still never faces that problem — and
    // the union count would say it does. The ticket permits either reading; this is the one that
    // matches what the section is for.
    active: (_cfg, _backend, _repos, maxPerProject) => maxPerProject > 1,
  },
  "24": { // Codex accelerant — opt-in via codex.enabled
    why: "codex not enabled",
    active: (cfg) => asObj(asObj(cfg).codex).enabled === true,
  },
};

// The conventions union as TEXT: always-read + cited spans, each line once, in file
// order; uncited gaps collapse to one thin marker line so the model knows the ToC has
// more and the §0a on-demand escape hatch still applies.
export function conventionsUnionText(convText: string, anchors: readonly string[], prunedSet?: ReadonlySet<string>): { text: string; bytes: number; contentBytes: number; effectiveSpans: number } {
  const conv = parseConventions(convText);
  const covered = new Uint8Array(conv.lines.length);
  const mark = (s: { start: number; end: number }): void => { for (let i = s.start; i <= s.end; i++) covered[i] = 1; };
  mark(conv.preamble);
  mark(conv.topology);
  const loaded = anchors.filter((a) => !prunedSet?.has(a));
  for (const a of loaded) {
    const hit = conv.anchors.get(a);
    if (!hit) throw new Error(`boot-prefix: no conventions anchor §${a}`);
    mark(hit.span);
  }
  // Effective spans: a ### child whose bare-number parent is also loaded adds no bytes — count the
  // distinct spans actually shipped, not the (lint-forced) declared pairs like §9 + §9c.
  const effectiveSpans = loaded.filter((a) => !(/[a-z]$/.test(a) && conv.anchors.get(a)?.level === 3 && loaded.includes(a.replace(/[a-z]$/, "")))).length;
  const out: string[] = [];
  let contentBytes = 0; // covered lines only, +1 per newline — the exact conventionsLoad measure
  let i = 0;
  while (i < conv.lines.length) {
    if (covered[i]) { out.push(conv.lines[i]); contentBytes += Buffer.byteLength(conv.lines[i], "utf8") + 1; i++; continue; }
    const uncited: string[] = [];
    const configOff: string[] = [];
    while (i < conv.lines.length && !covered[i]) {
      const m = /^#{2,3} (\d+[a-z]?)\. /.exec(conv.lines[i]);
      if (m) (prunedSet?.has(m[1]) ? configOff : uncited).push(`§${m[1]}`);
      i++;
    }
    const labels = [
      ...(uncited.length ? [`not in your Sections set: ${uncited.join(" ")}`] : []),
      ...(configOff.length ? [`declared but OFF in this project's config: ${configOff.join(" ")}`] : []),
    ];
    out.push("", `⋮ [${labels.join("; ") || "(section tail) not loaded"} — see the ToC above; read on demand per §0a]`, "");
  }
  const text = out.join("\n");
  return { text, bytes: Buffer.byteLength(text, "utf8"), contentBytes, effectiveSpans };
}

// ── WS-A A6: the "Resolved config" block — §0a step 2, pre-assembled ───────────────────────────
// The scheduler already resolved every fact step 2 asks the agent to derive (project, backend, repos
// with their landing mode + default branch, autonomy/mode, deploy policy, devSplit, strategyDoc). Shipping
// them in the corpus makes step 2 a read, not a config walk. Byte-constant per (workspace config, project):
// nothing here is per-fire.
export interface ResolvedRepoFact { ref: string; role?: string; landing?: string; defaultBranch?: string; autoMerge?: boolean; deployStyle?: string }
export interface ResolvedFireConfig {
  projectKey: string;          // "" / "_team" on a team-scope fire
  teamKey?: string;
  backend: string;
  mode?: string; autonomy?: string; humanBlocked?: string; devSplit?: boolean; intakeMode?: string; docSystem?: string;
  deployPolicy?: Record<string, string>;
  strategyDoc?: string;        // the resolved form label ("docs/STRATEGY.md" / "hubDoc:strategy" / "linearDocument:…") — never doc CONTENT
  repos: ResolvedRepoFact[];
  teamProjects?: Array<{ key: string; enabled: boolean; weight: number; repos: string[] }>; // team-scope fires only
}
export function renderResolvedConfig(r: ResolvedFireConfig): string {
  const kv = (k: string, v: unknown): string | null => (v === undefined || v === null || v === "" ? null : `${k}: ${String(v)}`);
  const head = [kv("project", r.projectKey || "(team scope — no single project)"), kv("team", r.teamKey), kv("backend", r.backend)].filter(Boolean).join(" · ");
  const lines: string[] = [`### Resolved config (§0a step 2, pre-assembled) — ${head}`];
  // humanBlocked rides beside mode/autonomy: a fire that cannot see it would park a ticket for a human
  // who is not coming (§9). The three together are the governance posture of this fire.
  const knobs = [kv("mode", r.mode), kv("autonomy", r.autonomy), kv("humanBlocked", r.humanBlocked), kv("devSplit", r.devSplit === undefined ? undefined : r.devSplit ? "true" : "false"), kv("intake.mode", r.intakeMode), kv("docSystem", r.docSystem)].filter(Boolean);
  if (knobs.length) lines.push(`- ${knobs.join(" · ")}`);
  const dp = r.deployPolicy && Object.keys(r.deployPolicy).length ? Object.entries(r.deployPolicy).map(([e, v]) => `${e}=${v}`).join(", ") : null;
  lines.push(`- deployPolicy: ${dp ?? "(none — no ceiling)"}`);
  lines.push(`- strategyDoc: ${r.strategyDoc ?? "(none configured)"}`);
  if (r.repos.length) {
    lines.push(`- repos (${r.repos.length}${r.repos.length > 1 ? " — multi-repo, §19" : " — single-repo, the target is implicit"}):`);
    for (const x of r.repos) {
      const facts = [x.role ? `role ${x.role}` : null, `landing ${x.landing ?? "direct (default)"}`, `defaultBranch ${x.defaultBranch ?? "main (default)"}`, x.autoMerge ? "autoMerge on" : null, x.deployStyle ? `deploy.style ${x.deployStyle}` : null].filter(Boolean).join("; ");
      lines.push(`  - ${x.ref} — ${facts}`);
    }
  } else lines.push("- repos: (none)");
  if (r.teamProjects) {
    lines.push(`- enabled projects (team scope): ${r.teamProjects.map((p) => `${p.key}×${p.weight}${p.repos.length ? ` [${p.repos.join(", ")}]` : ""}`).join(", ") || "(none)"}`);
  }
  return lines.join("\n");
}

// ── the corpus lessons slice — ONE dir resolution + slice for BOTH the classic and job-scoped paths ──
// §14 cross-fire learning: the workspace lessons INDEX + this project's shard (+ the legacy v1 path),
// sliced to this agent's sections (own + ## Shared, + ## Dev for the split dev tiers — lessonsSlice).
// `dataDir` is the fire's state root (opts.dataDir = wsStateRoot(ws)), so join(dataDir,"lessons") is the
// same dir the context bill reads. No dataDir (no workspace resolved) ⇒ "" — the "no workspace ⇒ nothing"
// rule the bill mirrors with its W03 caps. Absent files are not errors (fail open per convention).
function corpusLessonsSlice(dataDir: string | undefined, project: string | undefined, agent: string): string {
  if (!dataDir) return "";
  const lessonsDir = join(dataDir, "lessons");
  const lessonsParts: string[] = [];
  const indexPath = join(lessonsDir, "INDEX.md");
  if (existsSync(indexPath)) lessonsParts.push(readFileSync(indexPath, "utf8"));
  if (project) {
    const shardPath = join(lessonsDir, `${project}.md`);
    if (existsSync(shardPath)) lessonsParts.push(readFileSync(shardPath, "utf8"));
    const legacyPath = join(dataDir, project, "lessons.md");
    if (existsSync(legacyPath)) lessonsParts.push(readFileSync(legacyPath, "utf8"));
  }
  const lessonsCombined = lessonsParts.join("\n\n");
  return lessonsCombined.trim() ? lessonsSlice(lessonsCombined, agent) : "";
}

// Job-scoped corpus (docs/design/job-scoped-prompts.md): when the scheduler picks a job for a fire, the
// fire loads the resident kernel (skills/_constitution.md, VERBATIM) + ONE job playbook (the marked span
// in the agent's SKILL) + the shared playbooks that span `pulls:` — NOT the whole SKILL and the 64 KB
// conventions union. Byte-stable per (agent, job): two pm/verify fires share this exact block, pm/verify
// vs pm/groom differ (correct — different work). One span authority (context-bill.jobSlice), so a pushed
// corpus and a `dev-loop playbook` pull are byte-identical. Fail-open: a missing span/file ⇒ null, and
// runAgent degrades to the classic full-SKILL boot. EXPORTED so the `dev-loop playbook` pull verb prints
// the byte-identical slice (same function, so pushed and pulled cannot drift — the "one authority" rule).
// `dataDir`/`project` (optional so the bill and existing callers keep their bytes): when given, the corpus
// carries this project's §14 lessons slice — the loop's cross-fire learning mechanism (§14), which a job
// fire DROPPED entirely before. Same resolution + lessonsSlice as the classic path (corpusLessonsSlice, one
// authority). A pushed fire passes them; the `dev-loop playbook` pull verb resolves the same workspace, so
// pushed ≡ pulled holds byte-for-byte on the same (agent, job, workspace-config).
export function assembleJobCorpus(root: string, agent: string, job: string, dataDir?: string, project?: string): BootCorpus | null {
  const skillRaw = readFileSync(join(root, "skills", `${agent}-agent`, "SKILL.md"), "utf8");
  const span: JobSpan | null = jobSlice(skillRaw, job);
  if (!span) return null; // this agent's SKILL declares no such job — fail open
  const parts: string[] = [];
  parts.push("### skills/_constitution.md — the resident kernel (loaded VERBATIM, gates every action)", readConstitution(root));
  parts.push(`### skills/${agent}-agent/SKILL.md — job:${job} playbook${span.kind ? ` (kind: ${span.kind})` : ""} (this fire's ONE job)`, span.text);
  // Inline ONLY the shared playbooks the span pulls (skills/playbooks/*), deduped, in order. The
  // reference stubs it also names (references/…) stay tier-3 — read on demand at their trigger, per the
  // span's own `pulls:` line (which rides span.text above).
  const inlined = span.pulls.filter((p) => p.startsWith("skills/playbooks/"));
  for (const rel of inlined) {
    const p = join(root, rel);
    if (!existsSync(p)) return null; // a pulled playbook the span promises is missing ⇒ fail open
    parts.push(`### ${rel} — shared playbook pulled by job:${job} (pre-read)`, readFileSync(p, "utf8"));
  }
  // The agent's CLI cheat-sheet (exact `dev-loop` verb forms + flags + the exit-code table) lives in the
  // SKILL FRAME, which job-boot drops — so migrated agents lost their exact verb syntax. It is small,
  // agent-specific and every job runs CLI verbs, so it rides the corpus VERBATIM (byte-identical to the
  // block cli-cheatsheet.ts byte-checks). A SKILL with no cheat block ⇒ skipped gracefully.
  const cheat = cheatSlice(skillRaw);
  if (cheat.trim()) parts.push("### CLI cheat-sheet (exact verb forms + exit codes)", cheat);
  // §14 lessons (§0a step 4) — the loop's cross-fire learning mechanism, which a job fire dropped before.
  // Same dir resolution + slice as the classic corpus (corpusLessonsSlice). No workspace ⇒ nothing.
  const lessonsSliced = corpusLessonsSlice(dataDir, project, agent);
  let lessonsBytes = 0;
  if (lessonsSliced.trim()) {
    parts.push(`### lessons — your section + ## Shared (§0a step 4, pre-read)`, lessonsSliced);
    lessonsBytes = Buffer.byteLength(lessonsSliced, "utf8");
  }
  const stubs = span.pulls.filter((p) => !p.startsWith("skills/playbooks/"));
  const body = parts.join("\n\n");
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  const text = [
    "", "",
    `<!-- devloop-boot:begin agent=${agent} job=${job} hash=${hash} -->`,
    `[JOB CORPUS — pre-assembled by the scheduler for the '${job}' job. AUTHORITATIVE: the resident`,
    "constitution, this job's playbook, the shared playbooks it pulls, your CLI cheat-sheet and your",
    "lessons slice are ALL below — do NOT re-read the full SKILL or the conventions union this fire.",
    "Board reads and the opening summary still run",
    stubs.length ? `fresh. Reference stubs (${stubs.join(", ")}) stay on-demand — read one only at its trigger, per §0a.]`
                 : "fresh. The §0a on-demand escape hatch is unchanged.]",
    "",
    body,
    "",
    `<!-- devloop-boot:end hash=${hash} -->`,
    "",
  ].join("\n");
  return { text, bytes: Buffer.byteLength(text, "utf8"), hash, conventionsBytes: 0, lessonsBytes, pruned: [] };
}

export function assembleBootCorpus(
  root: string, dataDir: string, agent: string, project: string, backend: string,
  projectCfg?: ProjectCfg, reposRegistry?: ReposRegistry,
  // LOOP-275 — a TEAM-SCOPED steward fire spans every enabled project, but the caller can only pass
  // one `projectCfg` (the representative first-enabled one), so the repo-shaped predicates saw a
  // single project's repos. §19 ("multi-repo model") was therefore pruned from a team-scoped fire
  // whenever the FIRST enabled project happened to be single-repo — even with a later enabled
  // project holding two. The steward then reasoned about a workspace it had been told was
  // single-repo. Corroborated by LOOP-236's Codex P2 review and deferred from that ticket as
  // out of scope.
  //
  // Repos only, deliberately. The cfg-shaped predicates (§24 reads codex.enabled) still resolve
  // against the representative project; widening those is a different question about which
  // project's settings govern a team fire, and this ticket does not answer it.
  teamScopeCfgs?: ProjectCfg[],
  // WS-A A6: the scheduler-resolved config facts (§0a step 2). Optional so every existing caller and
  // fixture keeps its bytes; when present the block rides between the conventions slice and lessons.
  resolved?: ResolvedFireConfig,
  // Job-scoped prompts (docs/design/job-scoped-prompts.md): when set, the fire loads the constitution +
  // this ONE job's playbook + the shared playbooks it pulls, and the conventions union / config / lessons
  // are DROPPED (the constitution is resident, the job span names what to pull). Absent ⇒ today's behavior
  // byte-for-byte unchanged. A pm lane threads its scheduler-picked job here.
  job?: string,
): BootCorpus | null {
  try {
    if (job) return assembleJobCorpus(root, agent, job, dataDir, project); // job-scoped path — everything else below is the classic §0a corpus
    const skillRaw = readFileSync(join(root, "skills", `${agent}-agent`, "SKILL.md"), "utf8");
    const sec = parseSectionsLine(splitSkill(skillRaw.replace(/^---\n[\s\S]*?\n---\n/, "")).prose);
    if (sec.errors.length) return null; // malformed Sections line ⇒ pull mode
    // config-aware selection: drop declared spans whose feature is off in THIS project
    // The union across every enabled project for a team-scoped fire; just this project otherwise.
    // A union rather than a max: the predicates ask "does ANY repo have this fact?", so aggregating
    // the objects answers §12c/§12d correctly too, where a count alone would not.
    const repoGroups = (teamScopeCfgs?.length ? [projectCfg, ...teamScopeCfgs] : [projectCfg])
      .map((c) => resolveRepos(c, reposRegistry));
    const repos = repoGroups.flat();
    const maxPerProject = repoGroups.reduce((m, g) => Math.max(m, g.length), 0);
    const pruned = sec.anchors.filter((a) => CONDITIONAL_SECTIONS[a] && !CONDITIONAL_SECTIONS[a].active(projectCfg, backend, repos, maxPerProject));
    const conv = conventionsUnionText(readFileSync(join(root, "references", "conventions.md"), "utf8"), sec.anchors, new Set(pruned));

    const parts: string[] = [];
    const prunedNote = pruned.length
      ? ` (config-pruned, read on demand if ever relevant: ${pruned.map((a) => `§${a} — ${CONDITIONAL_SECTIONS[a].why}`).join("; ")})`
      : "";
    parts.push(
      `### references/conventions.md — always-read + ${conv.effectiveSpans} spans of your ${sec.anchors.length} declared § (§0a step 1, pre-read)${prunedNote}`,
      conv.text,
    );

    if (resolved) parts.push(renderResolvedConfig(resolved));

    // Lessons: the workspace lessons dir (INDEX + project shard) + the legacy v1 path, sliced to this
    // agent (corpusLessonsSlice — the ONE resolution the job-scoped path also uses). Absent files are not
    // errors (fail open per convention).
    const lessonsSliced = corpusLessonsSlice(dataDir, project, agent);
    let lessonsBytes = 0;
    if (lessonsSliced.trim()) {
      parts.push(`### lessons — your section + ## Shared (§0a step 4, pre-read)`, lessonsSliced);
      lessonsBytes = Buffer.byteLength(lessonsSliced, "utf8");
    }

    const backendFile = backend === "service" ? "backend-service.md" : backend === "local" ? "backend-local.md" : null;
    if (backendFile) {
      const p = join(root, "references", backendFile);
      if (existsSync(p)) parts.push(`### references/${backendFile} — the §18 backend contract (pre-read)`, readFileSync(p, "utf8"));

    // LOOP-249 — one advisory line when the repo this fire READS is not the code it is RUNNING.
    // An agent diagnosing dev-loop's own behaviour reads the workspace source while executing the
    // installed package; three verdicts named the wrong writer because of that gap. Emitted ONLY
    // when the content actually differs, so a non-self-hosting workspace pays nothing and says
    // nothing, and a repo merely AHEAD of the installed version with identical built output is
    // silent. Advisory: it never fails a fire and costs no network call.
    {
      const drift = selfDriftLine(root, installedRootOf(dirname(fileURLToPath(import.meta.url))));
      if (drift) parts.push(drift);
    }
    }

    // (The retired LOOP-553 split-tier inheritance lived here: senior-dev/junior-dev classic-boot used to
    // append dev-agent's fire-start + ship-sequence marker spans. That content moved into the shared dev
    // playbooks the dev/senior/junior JOB spans pull, so the tiers now job-boot; this classic-boot path is
    // only the fail-open fallback and no longer re-derives an inherited slice.)

    const body = parts.join("\n\n");
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    const text = [
      "",
      "",
      `<!-- devloop-boot:begin agent=${agent} hash=${hash} -->`,
      "[BOOT CORPUS — pre-assembled by the scheduler; this inline block is AUTHORITATIVE for §0a",
      "steps 1–4: the conventions selective read (step 1), the resolved config (step 2), the",
      "backend contract (step 3) and the lessons read (step 4) are ALREADY below — do NOT re-read",
      "those files or re-derive that config this fire. Steps 5–6 (report start, the opening",
      "summary) and every board read still execute fresh. The §0a uncited-section escape hatch and",
      "the pointer-stub reads (references/conventions/<slug>.md at their trigger moment) are unchanged.]",
      "",
      body,
      "",
      `<!-- devloop-boot:end hash=${hash} -->`,
      "",
    ].join("\n");
    return { text, bytes: Buffer.byteLength(text, "utf8"), hash, conventionsBytes: conv.contentBytes, lessonsBytes, pruned };
  } catch {
    return null; // fail open — the fire boots in classic pull mode
  }
}
