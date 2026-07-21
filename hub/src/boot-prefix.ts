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
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseConventions, parseSectionsLine, splitSkill, splitLines } from "./context-bill.ts";

export interface BootCorpus {
  text: string;        // the full marker-wrapped block to append to the prompt
  bytes: number;       // Buffer.byteLength(text)
  hash: string;        // sha256 of the corpus body (12 hex chars) — riding in the marker
  conventionsBytes: number; // the union slice alone (bill cross-check)
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
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const repoList = (cfg: ProjectCfg): Record<string, unknown>[] => {
  const r = asObj(cfg).repos;
  return Array.isArray(r) ? r.map(asObj) : [];
};
const anyRepoOrTop = (cfg: ProjectCfg, pick: (o: Record<string, unknown>) => boolean): boolean =>
  pick(asObj(cfg)) || repoList(cfg).some(pick);
export const CONDITIONAL_SECTIONS: Record<string, { why: string; active: (cfg: ProjectCfg, backend: string) => boolean }> = {
  "5": { // the pick ranking — the `queue` op computes it server-side on the hub backend
    why: "the queue op pre-ranks on service",
    active: (_cfg, backend) => backend !== "service",
  },
  "12c": { // auto-merge + release-PR deploy — only real when one of the two knobs is on
    why: "no git.autoMerge / deploy.style:\"release-pr\" configured",
    active: (cfg) => anyRepoOrTop(cfg, (o) => asObj(o.git).autoMerge === true || asObj(o.deploy).style === "release-pr"),
  },
  "12d": { // deploy ceiling — meaningless when nothing can deploy
    why: "no deploy configured",
    active: (cfg) => anyRepoOrTop(cfg, (o) => Object.keys(asObj(o.deploy)).length > 0),
  },
  "19": { // multi-repo model — strictly opt-in via repos[]
    why: "single-repo project (no repos[])",
    active: (cfg) => repoList(cfg).length > 0,
  },
  "24": { // Codex accelerant — opt-in via codex.enabled
    why: "codex not enabled",
    active: (cfg) => asObj(asObj(cfg).codex).enabled === true,
  },
};

// §14 layout: one `## <Section>` per role + `## Shared`. The agent-id → section-name map
// mirrors the init scaffold order in conventions §14.
const LESSONS_SECTION: Record<string, string> = {
  pm: "PM", qa: "QA", dev: "Dev", "senior-dev": "senior-dev", "junior-dev": "junior-dev",
  sweep: "Sweep", reflect: "Reflect", ops: "Ops", architect: "Architect",
  communication: "Communication",
};

// Extract `## <name>` sections from a lessons file, preserving file order. Missing
// sections are skipped silently (a young lessons file may not carry every heading yet).
export function lessonsSlice(text: string, agent: string): string {
  const want = new Set<string>(["Shared"]);
  const own = LESSONS_SECTION[agent];
  if (own) want.add(own);
  if (agent === "senior-dev" || agent === "junior-dev") want.add("Dev");
  const lines = splitLines(text);
  const out: string[] = [];
  let keep = false;
  for (const l of lines) {
    const m = /^## (.+?)\s*$/.exec(l);
    if (m) keep = want.has(m[1]);
    if (keep) out.push(l);
  }
  return out.join("\n");
}

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

export function assembleBootCorpus(
  root: string, dataDir: string, agent: string, project: string, backend: string, projectCfg?: ProjectCfg,
): BootCorpus | null {
  try {
    const skillRaw = readFileSync(join(root, "skills", `${agent}-agent`, "SKILL.md"), "utf8");
    const sec = parseSectionsLine(splitSkill(skillRaw.replace(/^---\n[\s\S]*?\n---\n/, "")).prose);
    if (sec.errors.length) return null; // malformed Sections line ⇒ pull mode
    // config-aware selection: drop declared spans whose feature is off in THIS project
    const pruned = sec.anchors.filter((a) => CONDITIONAL_SECTIONS[a] && !CONDITIONAL_SECTIONS[a].active(projectCfg, backend));
    const conv = conventionsUnionText(readFileSync(join(root, "references", "conventions.md"), "utf8"), sec.anchors, new Set(pruned));

    const parts: string[] = [];
    const prunedNote = pruned.length
      ? ` (config-pruned, read on demand if ever relevant: ${pruned.map((a) => `§${a} — ${CONDITIONAL_SECTIONS[a].why}`).join("; ")})`
      : "";
    parts.push(
      `### references/conventions.md — always-read + ${conv.effectiveSpans} spans of your ${sec.anchors.length} declared § (§0a step 1, pre-read)${prunedNote}`,
      conv.text,
    );

    const lessonsPath = join(dataDir, project, "lessons.md");
    if (project && existsSync(lessonsPath)) {
      const slice = lessonsSlice(readFileSync(lessonsPath, "utf8"), agent);
      if (slice.trim()) parts.push(`### lessons.md — your section + ## Shared (§0a step 4, pre-read)`, slice);
    }

    const backendFile = backend === "service" ? "backend-service.md" : backend === "local" ? "backend-local.md" : null;
    if (backendFile) {
      const p = join(root, "references", backendFile);
      if (existsSync(p)) parts.push(`### references/${backendFile} — the §18 backend contract (pre-read)`, readFileSync(p, "utf8"));
    }

    // Split tiers inherit dev's ship sequence (§21c) — ship the marker-delimited slice IN the
    // corpus so the inheritance is deterministic instead of a ~21KB mid-fire pull. Marker pair
    // missing ⇒ skip silently (the SKILL's pull-mode instruction still covers the fire).
    if (agent === "senior-dev" || agent === "junior-dev") {
      const devSkill = readFileSync(join(root, "skills", "dev-agent", "SKILL.md"), "utf8");
      const b = devSkill.indexOf("<!-- ship-sequence:begin -->");
      const e = devSkill.indexOf("<!-- ship-sequence:end -->");
      if (b !== -1 && e > b) {
        parts.push(
          "### skills/dev-agent/SKILL.md — Steps 4–6.5 + 7 + HARD LIMITS (your inherited ship sequence, §21c, pre-read)",
          devSkill.slice(b + "<!-- ship-sequence:begin -->".length, e).trim(),
        );
      }
    }

    const body = parts.join("\n\n");
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    const text = [
      "",
      "",
      `<!-- devloop-boot:begin agent=${agent} hash=${hash} -->`,
      "[BOOT CORPUS — pre-assembled by the scheduler. This block IS your §0a boot reading:",
      "the conventions selective read (step 1), the lessons read (step 4), and the backend",
      "contract read are ALREADY below — do NOT re-read those files this fire. Every other",
      "boot step (config, report start, board state) still executes fresh. The §0a",
      "uncited-section escape hatch is unchanged.]",
      "",
      body,
      "",
      `<!-- devloop-boot:end hash=${hash} -->`,
      "",
    ].join("\n");
    return { text, bytes: Buffer.byteLength(text, "utf8"), hash, conventionsBytes: conv.contentBytes, pruned };
  } catch {
    return null; // fail open — the fire boots in classic pull mode
  }
}
