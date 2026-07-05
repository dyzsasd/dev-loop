// Consistency guard suite — mechanical checks for the drift classes that have already shipped twice
// (stale Director/Signal references after agent removals; "29 tools" comments over a 23-tool registry;
// per-SKILL roster copies frozen at authorship-time loop size; a stale skills/ build copy published to npm).
// Each check is cheap text analysis over the repo — the point is that these failures land in CI, not in
// the next audit.
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
const OPERATOR_SKILLS = ["add-project", "add-repo", "sync-project", "sync-repo"]; // legacy `init` removed at 1.0 (team init + add-project/add-repo replace it)
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

console.log(fails === 0 ? "\nCONSISTENCY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
