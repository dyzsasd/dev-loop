#!/usr/bin/env node
// gen-cheatsheets.ts — the per-agent CLI cheat-sheet generator (D8/D9 CLI-first step 3, B2;
// docs/design/2026-07-review-decisions.md). On `backend:"service"` + `interface:"cli"` an agent fire
// has NO hub MCP — the `dev-loop` write layer (cli-agentops.ts) IS its board access — so every agent
// SKILL carries a machine-generated cheat-sheet block scoped to the ops THAT agent uses. D9's accepted
// risk is "cheat-sheet defects hit all agents at once"; the named mitigation is generating the block
// FROM THE CLI'S OWN USAGE STRINGS, so this file never re-types a flag: it spawns `cli-agentops.ts help`
// + `cli.ts help`, parses their usage text into per-verb entries, and renders each agent's block from
// (a) those captured strings and (b) the ONE agent→verbs table below. The blocks live between
// `<!-- cli-cheatsheet:begin agent=<name> -->` … `end` markers in skills/<agent>/SKILL.md (the ROOT
// skills/ — hub/skills is build output); hub/test/cli-cheatsheet.ts asserts the committed blocks
// byte-match this generator's output, so CLI-vs-SKILL drift fails the suite until you re-run:
//   node hub/src/gen-cheatsheets.ts            # regenerate every block in place
//   node hub/src/gen-cheatsheets.ts --check    # exit 1 if any committed block drifts
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainEntry } from "./is-entry.ts";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (dev) | dist (published — the generator is a source-tree tool; the test only runs in-repo)
const repoRoot = join(here, "..", "..");
export const SKILLS_DIR = join(repoRoot, "skills");

// ─── the ONE agent → verbs table (the only hand-maintained mapping) ─────────────────────────────────
// Verb keys index the parsed usage entries; "tickets"/"ticket" are the cli-tickets read verbs,
// "notify"/"conventions" are cli.ts verbs, all others are cli-agentops write-layer verbs. `project`
// names the D1 override guidance the block gets: the four stewards (booted `_team`) get the full steward
// override; pm gets the `_team`-only team-intake wording (§9b); every delivery agent gets NO `--project`
// mention at all (server-refused).
//
// WS-A A5 — a sheet renders ONLY the verbs that agent uses. The rendered set for an agent is the union of
//   (1) CORE_VERBS — the always-on floor every fire needs (queue, ticket, tickets, comment add, notify,
//       conventions);
//   (2) every `dev-loop <verb>` (or canonical §18 op name) the SKILL's PROSE mentions — derived, so a
//       verb the prose names can never be missing from the sheet (mentionedVerbs);
//   (3) the spec's `verbs` — the JOB-IMPLIED floor: verbs the prose describes by op or by job ("file a
//       Bug", "claim", "hand off") rather than by CLI name. Hand-maintained, per agent, deliberately small.
// Nothing outside that union is rendered. hub/test/cli-cheatsheet.ts asserts (2) ⊆ rendered and that no
// verb outside the union leaks in.
export interface CheatSpec { verbs: readonly string[]; project: "steward" | "pm" | "none"; scope: string }
export const CORE_VERBS: readonly string[] = ["queue", "tickets", "ticket", "comment add", "notify", "conventions"];
export const CHEATSHEETS: Record<string, CheatSpec> = {
  "pm-agent": {
    verbs: ["ticket create", "ticket update", "comments", "doc get", "doc save"],
    project: "pm",
    scope: "Your ops: `queue` FIRST (verify/unblock/backlog/todoDepth pre-listed), board reads for Jobs A/B/B2/C, `save_issue` create (file Features/Improvements, intake children) and update (verify/groom/promote, unblock), comments, and the hub `strategy`/`roadmap` docs — `doc save` writes a DRAFT only (`doc.publish` stays the operator's).",
  },
  "qa-agent": {
    verbs: ["ticket create", "ticket update", "comments"],
    project: "none",
    scope: "Your ops: `queue` FIRST (verify + blocked pre-listed), board reads for Jobs A/B/C, `save_issue` update (claim, re-test → Done, close+supersede, unblock) and create (file Bugs + the verify-fail follow-ups), and comments (claims, evidence, sign-offs).",
  },
  "senior-dev-agent": {
    verbs: ["ticket create", "ticket update", "comments", "doc get", "doc save", "doc archive"],
    project: "none",
    scope: "Your ops: `queue` FIRST (your ranked slice + In Progress), `save_issue` update (claim, block, hand-off) and create (spawn the staged `Backlog` children), comments, and the hub `design` doc-kind — `dev-loop doc save --kind design --slug <module>` (multi-instance, NOT publish-gated: your saved draft IS the live design, §21a); retire a module's design doc with `doc archive` (D6: hidden by default, never deleted; `--restore` brings it back).",
  },
  "junior-dev-agent": {
    verbs: ["ticket create", "ticket update", "doc get"],
    project: "none",
    scope: "Your ops: `queue` FIRST (your ranked slice + In Progress), `save_issue` update (claim, block, In-Review hand-off), comments, and `doc get --kind design --slug <slug>` (the `Design:` pointer read, Step 4). The ONLY tickets you create are your own same-tier split / `[coverage]` follow-ups (dev-agent Step 4) — you never spawn design children or route work.",
  },
  "dev-agent": {
    verbs: ["ticket create", "ticket update", "doc get"],
    project: "none",
    scope: "Your ops: `queue` FIRST (the ranked queue + In Progress), `save_issue` update (claim, block, In-Review hand-off), comments, split / `[coverage]` follow-up creates (Step 4), and hub-doc reads where the project runs `hub.docs`.",
  },
  "sweep-agent": {
    verbs: ["op", "ticket update", "labels", "label create", "mirror push", "mirror poll", "mirror status"],
    project: "steward",
    scope: "Your ops: board reads (Jobs 1–4), `save_issue` update for the re-label/re-route/orphan-reset fixes (never a create — you file no new work), comments, label reads/provisioning, and Job 5's `mirror.push`/`mirror.pollComments`/`mirror.status` (the poller's needs-pm intake tickets are the ONE sanctioned exception to \"file no new work\" — they carry a human's words, not yours).",
  },
  "reflect-agent": {
    verbs: ["op", "events", "doc get", "ticket create"],
    project: "steward",
    scope: "Your ops: read-only evidence gathering — board reads, the `list_events` window (your §18 activity feed), and hub-doc reads. Your ONLY board writes: the single `[reflect-proposal]` hand-off ticket (Job 3) and the rare team-mode PM-nudge comment.",
  },
  "ops-agent": {
    verbs: ["op", "ticket create", "ticket update", "comments"],
    project: "steward",
    scope: "Your ops: the `incident` dedupe scan (reads), `save_issue` create (file ONE confirmed incident Bug) and update (refresh/escalate the open one), and dated status comments (refresh, recovered, suspected-trigger notes).",
  },
  "architect-agent": {
    verbs: ["ticket create", "comments"],
    project: "none",
    scope: "Your ops: the dedupe scan (reads), `save_issue` create (file the capped `tech-debt` Improvements), and comments (bump an existing ticket instead of refiling). You never update/transition tickets — observe-and-file only (§21).",
  },
  "communication-agent": {
    verbs: ["op", "project", "doc list", "doc get"],
    project: "steward",
    scope: "Your ops are READ-ONLY: project facts, board reads and published `strategy`/`roadmap` docs for the article/digest sources. Your outward push stays `dev-loop notify` (never a hand-rolled webhook), and your only writes are the draft file + your report.",
  },
};

// verb key → the canonical §18 op name(s) it invokes (rendered as the `#` comment line per entry).
export const OP_OF: Record<string, string> = {
  "tickets": "list_issues", "ticket": "get_issue", "op": "ANY op by name (LAYER 0 — raw JSON args)",
  "ticket create": "save_issue (create)", "ticket update": "save_issue (update)",
  "comment add": "save_comment", "comments": "list_comments",
  "labels": "list_issue_labels", "label create": "create_issue_label",
  "project": "get_project", "events": "list_events", "queue": "queue",
  "doc list": "doc.list", "doc get": "doc.get", "doc history": "doc.history", "doc diff": "doc.diff",
  "doc save": "doc.save", "doc publish": "doc.publish", "doc archive": "doc.archive",
  "mirror push": "mirror.push", "mirror poll": "mirror.pollComments", "mirror status": "mirror.status",
  // cli.ts verbs (not §18 ops): the team comms push and the §0a on-demand conventions slice.
  "notify": "team comms push (team.comms — the §9 operator channel / §22a digest)",
  "conventions": "§0a on-demand conventions slice (the pull half; a boot corpus already carries yours)",
};
// The verb keys a SKILL's prose can name, longest first so "ticket create" wins over "ticket".
const VERB_KEYS = Object.keys(OP_OF).sort((a, b) => b.length - a.length);
const OP_TO_VERB: Record<string, string[]> = {};
for (const [verb, op] of Object.entries(OP_OF)) {
  const m = /^([a-z_.]+)/.exec(op);
  if (m && !/^(ANY|team|§)/.test(op)) (OP_TO_VERB[m[1]] ??= []).push(verb);
}
// WS-A A5 — the verbs a SKILL's PROSE names: `dev-loop <verb>` mentions plus canonical op names
// (`save_issue`, `doc.get`, `mirror.push`, …). `save_issue` alone maps to BOTH ticket verbs — the prose
// decides create vs update in words the regex cannot read, so both flag surfaces ship.
export function mentionedVerbs(prose: string): string[] {
  const out = new Set<string>();
  for (const m of prose.matchAll(/dev-loop ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*)?)/g)) {
    const words = m[1].split(" ");
    const key = VERB_KEYS.find((k) => k === m[1]) ?? VERB_KEYS.find((k) => k === words[0]);
    if (key) out.add(key);
  }
  for (const [op, verbs] of Object.entries(OP_TO_VERB)) {
    if (new RegExp(`(^|[^a-z_.])${op.replace(/\./g, "\\.")}(?![a-z_.])`).test(prose)) for (const v of verbs) out.add(v);
  }
  return [...out];
}
// The rendered set, in a stable order: core first, then the spec floor, then prose-derived extras.
export function verbsFor(spec: CheatSpec, prose: string): string[] {
  const out: string[] = [];
  for (const v of [...CORE_VERBS, ...spec.verbs, ...mentionedVerbs(prose)]) if (!out.includes(v)) out.push(v);
  return out;
}

export const shortName = (dir: string): string => dir.replace(/-agent$/, "");
export const markerBegin = (agent: string): string => `<!-- cli-cheatsheet:begin agent=${agent} -->`;
export const markerEnd = (agent: string): string => `<!-- cli-cheatsheet:end agent=${agent} -->`;

// ─── capture + parse the CLIs' own usage text (the D9 single source of truth) ───────────────────────
function captureUsage(entry: string): string {
  const r = spawnSync(process.execPath, [join(here, entry), "help"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) throw new Error(`${entry} help failed (exit ${r.status}): ${r.stderr ?? ""}`);
  return r.stdout;
}

// "ticket create --title T …" → "ticket create"; "comments <id>" → "comments" (≤2 lowercase words).
const keyOf = (rest: string): string => {
  const words: string[] = [];
  for (const t of rest.split(/\s+/)) { if (words.length < 2 && /^[a-z][a-z-]*$/.test(t)) words.push(t); else break; }
  return words.join(" ");
};

interface WriteUsage { entries: Map<string, string[]>; projectFlag: string[]; exitCodes: string[] }
// The cli-agentops usage layout: `  dev-loop <verb> …` entry lines with deeper-indented
// continuation/annotation lines; then `Every verb also accepts:` (the COMMON flags — we keep the
// `--project` entry, the D1 matrix wording); then `Exit codes:` (the machine contract).
function parseWriteUsage(text: string): WriteUsage {
  const entries = new Map<string, string[]>(); const projectFlag: string[] = []; const exitCodes: string[] = [];
  let mode: "verbs" | "flags" | "exit" = "verbs"; let cur: string[] | null = null; let inProject = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Every verb also accepts:")) { mode = "flags"; cur = null; continue; }
    if (line.startsWith("Exit codes:")) { mode = "exit"; cur = null; continue; }
    if (mode === "verbs") {
      const m = /^ {2}dev-loop (\S.*)$/.exec(line);
      if (m) { cur = [line]; entries.set(keyOf(m[1]), cur); continue; }
      if (cur && /^ {3,}\S/.test(line)) { cur.push(line); continue; }
      cur = null;
    } else if (mode === "flags") {
      if (/^ {2}--project /.test(line)) { inProject = true; projectFlag.push(line); continue; }
      if (inProject && /^ {3,}\S/.test(line) && !/^ {2}--/.test(line)) { projectFlag.push(line); continue; }
      inProject = false;
    } else if (/^ {2}\S/.test(line) || /^ {3,}\S/.test(line)) exitCodes.push(line);
  }
  if (!entries.size || !projectFlag.length || !exitCodes.length) throw new Error("cli-agentops usage parse came up empty — did the usage layout change?");
  return { entries, projectFlag, exitCodes };
}

// The two DL-90 read verbs from `dev-loop help` (cli.ts) — re-prefixed `dev-loop ` so they render as
// runnable commands, continuation alignment preserved.
function parseReadUsage(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>(); let cur: string[] | null = null;
  for (const line of text.split("\n")) {
    const head = /^ {2}(tickets \[|ticket <id>|notify \[|conventions --agent)/.exec(line);
    if (head) {
      cur = ["dev-loop " + line.slice(2)];
      out.set(head[1].split(/[ <\[]/)[0], cur);
      continue;
    }
    if (cur && /^ {3,}\S/.test(line)) { cur.push(" ".repeat("dev-loop ".length) + line.slice(2)); continue; }
    cur = null;
  }
  for (const v of ["tickets", "ticket", "notify", "conventions"]) if (!out.has(v)) throw new Error(`cli.ts usage parse missed the '${v}' verb — did the usage layout change?`);
  return out;
}

// Generator-authored JSON-mode annotations on the read verbs (the A1 parity contract; the flag
// surface itself stays verbatim from the CLI above them).
const READ_NOTES: Record<string, string[]> = {
  "tickets": ["    --json = EXACTLY the op list_issues body (updated_at DESC, terminal states included, cap 250); --all/--owner/--assignee '' are human-view only."],
  "ticket": ["    --json = EXACTLY the op get_issue body (the ticket + its comments + referencedBy)."],
};

const dedent2 = (lines: string[]): string[] => lines.map((l) => l.slice(2));

// ─── render one agent's block (markers included, no trailing newline) ───────────────────────────────
const READ_VERBS = new Set(["tickets", "ticket", "notify", "conventions"]);
export function renderBlock(dir: string, spec: CheatSpec, w: WriteUsage, reads: Map<string, string[]>, prose = ""): string {
  const agent = shortName(dir);
  const entryLines: string[] = [];
  for (const verb of verbsFor(spec, prose)) {
    const src = READ_VERBS.has(verb) ? reads.get(verb) : w.entries.get(verb);
    if (!src) throw new Error(`${dir}: no usage entry for verb '${verb}' — the table and the CLI usage drifted`);
    const op = OP_OF[verb];
    if (!op) throw new Error(`${dir}: verb '${verb}' has no OP_OF entry — the # comment must be the canonical §18 op name, never a guess`);
    // WS-A A5: no blank separator between entries — the `#` op line already delimits, and the block
    // has a 95-line ceiling (CHEAT_MAX_LINES) that the two always-on core verbs would otherwise breach.
    entryLines.push(`# ${op}`);
    // The LAYER 0 "Ops: <full list>" annotation is dropped from the sheets (token weight; the list
    // is one `dev-loop op --help` away) — everything else renders verbatim from the usage text.
    const body = READ_VERBS.has(verb) ? [...src, ...(READ_NOTES[verb] ?? [])] : dedent2(src).filter((l) => !/^\s+Ops: /.test(l));
    entryLines.push(...body);
  }

  const parts: string[] = [
    markerBegin(agent),
    `## CLI cheat-sheet — \`backend:"service"\`, \`interface:"cli"\` (§18)`,
    "",
    "<!-- GENERATED from the CLI usage strings by hub/src/gen-cheatsheets.ts (D9) — never hand-edit between the markers; hub/test/cli-cheatsheet.ts byte-checks this block. -->",
    "",
    "On a CLI-interface fire (D8 — no hub MCP; `hub.agentInterface` decides per coding agent) every §18 op below",
    "is a `dev-loop` command: JSON on stdout, errors as JSON on stderr, identity from the fire env",
    "(`DEVLOOP_ACTOR`/`DEVLOOP_PROJECT`/`DEVLOOP_HUB_DB` — never touch these). Full write-layer surface: `dev-loop op --help`.",
    "",
    "**FIRST — verify identity, fail closed.** Before ANY other board or repo action, run:",
    "",
    "```text",
    "dev-loop project --json        # get_project as the acting actor — the CLI whoami",
    "```",
    "",
    "Exit `4` (identity/guard: phantom `DEVLOOP_ACTOR`, unresolved/unseeded project) or `5` (hub",
    "unavailable) ⇒ **STOP this fire**: report the failure, make NO writes, and do NOT touch the repo or",
    "fall back to direct file/db access — a mis-attributed write is worse than a lost fire.",
    "",
    spec.scope,
    "",
    "```text",
    ...entryLines,
    "```",
    "",
    "Respect `mode` (§12) yourself — the CLI has no dry-run gate: in `dry-run`, make no write-verb calls.",
  ];

  if (verbsFor(spec, prose).includes("doc save")) {
    parts.push("",
      "**`doc save` exit `3` (CONFLICT) — the recovery loop is mandatory, never a blind retry:** `doc get",
      "--slug <S> --kind <K> --version latest` → re-apply YOUR change → re-save with",
      "`--base-version <latestVersion>` (from the CONFLICT payload; the CAS keys on the LATEST draft).");
  }

  if (spec.project === "steward") {
    parts.push("",
      "**Cross-project steward override (D1, §18):** you boot as `_team`; every write-layer verb takes",
      "`--project <key>` (role-gated SERVER-side — a refused actor learns nothing about which keys exist):",
      "",
      "```text",
      ...dedent2(w.projectFlag),
      "```",
      "",
      "`tickets`/`ticket <id>` take no `--project` — a cross-project read rides LAYER 0: `dev-loop op",
      "list_issues --args-json '{\"project\":\"<key>\",\"label\":\"dev-loop\"}'` (same for `op get_issue`).",
      "Omit `--project` entirely to act on the `_team` board itself.");
  } else if (spec.project === "pm") {
    parts.push("",
      "**`--project` is `_team`-only for you, and ONLY inside the §9b team-intake job (D1):**",
      "",
      "```text",
      ...dedent2(w.projectFlag),
      "```",
      "",
      "The intake scan rides LAYER 0 (the read verbs take no `--project`): `dev-loop op list_issues",
      "--args-json '{\"project\":\"_team\",\"label\":\"needs-pm\"}'`; the parent back-link is `dev-loop comment",
      "add <id> --project _team --body \"…\"`. Never point the override at a sibling project's board — every",
      "key but `_team` is refused server-side (FORBIDDEN, exit 1).");
  }

  parts.push("",
    "Exit codes (every write-layer verb):",
    "",
    "```text",
    ...dedent2(w.exitCodes),
    "```",
    markerEnd(agent));
  return parts.join("\n");
}

// The SKILL's prose (the file minus its generated block) — the input the WS-A verb derivation reads.
export function skillProse(dir: string): string {
  const body = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  const b = markerBegin(shortName(dir)), e = markerEnd(shortName(dir));
  const i = body.indexOf(b), j = body.indexOf(e);
  return i === -1 || j === -1 ? body : body.slice(0, i) + body.slice(j + e.length);
}
export function renderBlocks(): Map<string, string> {
  const w = parseWriteUsage(captureUsage("cli-agentops.ts"));
  const reads = parseReadUsage(captureUsage("cli.ts"));
  const out = new Map<string, string>();
  for (const [dir, spec] of Object.entries(CHEATSHEETS)) out.set(dir, renderBlock(dir, spec, w, reads, skillProse(dir)));
  return out;
}

// Replace the marked region in place, or append a new block ("\n---\n\n" separated) on first run.
export function splice(body: string, dir: string, block: string): string {
  const b = markerBegin(shortName(dir)), e = markerEnd(shortName(dir));
  const i = body.indexOf(b), j = body.indexOf(e);
  if ((i === -1) !== (j === -1) || (i !== -1 && j < i)) throw new Error(`${dir}/SKILL.md: unbalanced cli-cheatsheet markers`);
  if (i !== -1 && (body.indexOf(b, i + 1) !== -1 || body.indexOf(e, j + 1) !== -1))
    throw new Error(`${dir}/SKILL.md: duplicate cli-cheatsheet markers — remove the extra pair before regenerating`);
  if (i !== -1) return body.slice(0, i) + block + body.slice(j + e.length);
  return (body.endsWith("\n") ? body : body + "\n") + "\n---\n\n" + block + "\n";
}

if (isMainEntry(import.meta.url)) {
  const check = process.argv.includes("--check");
  let drifted = 0;
  for (const [dir, block] of renderBlocks()) {
    const path = join(SKILLS_DIR, dir, "SKILL.md");
    const body = readFileSync(path, "utf8");
    const next = splice(body, dir, block);
    if (next === body) { console.log(`unchanged  skills/${dir}/SKILL.md`); continue; }
    drifted++;
    if (check) { console.log(`DRIFT      skills/${dir}/SKILL.md`); continue; }
    writeFileSync(path, next);
    console.log(`updated    skills/${dir}/SKILL.md`);
  }
  if (check && drifted) { console.error(`\n${drifted} cheat-sheet block(s) drift from the CLI usage — run: node hub/src/gen-cheatsheets.ts`); process.exit(1); }
  console.log(check ? "\nall cheat-sheet blocks match the generator" : `\n${drifted} file(s) updated`);
}
