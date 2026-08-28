// B2 [drift lint]: the per-agent CLI cheat-sheet blocks in skills/*/SKILL.md must BYTE-MATCH what
// hub/src/gen-cheatsheets.ts renders from the CLI's own usage strings (D9's named mitigation for
// "cheat-sheet defects hit all agents at once"). Any change to cli-agentops.ts/cli.ts usage text, to
// the generator's agent→verbs table, or a hand-edit inside the markers fails here until the operator
// re-runs `node hub/src/gen-cheatsheets.ts`. Root skills/ only — hub/skills is build output.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHEATSHEETS, CORE_VERBS, OP_OF, SKILLS_DIR, markerBegin, markerEnd, mentionedVerbs, renderBlocks, shortName, skillProse, splice, verbsFor,
} from "../src/gen-cheatsheets.ts";
import { cheatSlice } from "../src/context-bill.ts"; // the ONE extractor the job corpus (boot-prefix) lifts the block with

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const blocks = renderBlocks();
// Coverage is DERIVED, never hard-coded: every skills/*-agent dir must be in the generator table
// (a new agent skill without a cheat-sheet fails here), and every table row must have a dir.
const agentDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.endsWith("-agent")).map((d) => d.name).sort();
ok(JSON.stringify(agentDirs) === JSON.stringify([...blocks.keys()].sort()),
  `the generator table covers exactly the skills/*-agent set (dirs: ${agentDirs.join(", ")})`);

// 1) Every agent SKILL carries exactly one marker pair, and the committed block byte-matches the render.
for (const [dir, block] of blocks) {
  const body = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  const b = markerBegin(shortName(dir)), e = markerEnd(shortName(dir));
  const i = body.indexOf(b), j = body.indexOf(e);
  ok(i !== -1 && j > i, `skills/${dir}/SKILL.md: has the cli-cheatsheet marker pair`);
  if (i === -1 || j <= i) continue;
  ok(body.indexOf(b, i + 1) === -1 && body.indexOf(e, j + 1) === -1, `skills/${dir}/SKILL.md: exactly ONE marker pair`);
  const committed = body.slice(i, j + e.length);
  ok(committed === block,
    `skills/${dir}/SKILL.md: cheat-sheet block byte-matches the generator${committed === block ? "" : " — run: node hub/src/gen-cheatsheets.ts"}`);
  // The job corpus (boot-prefix.assembleJobCorpus) lifts this block via context-bill.cheatSlice and ships
  // it VERBATIM. Assert that extractor returns EXACTLY the byte-checked block, so a job fire can never
  // carry a cheat-sheet different from the one this drift lint verifies against the CLI usage.
  ok(cheatSlice(body) === committed,
    `skills/${dir}/SKILL.md: cheatSlice extracts EXACTLY the byte-checked block (the corpus carries the verified verb forms)`);
  // splice() on an in-sync file is the identity — the regeneration path is idempotent.
  ok(splice(body, dir, block) === body, `skills/${dir}/SKILL.md: regeneration is idempotent (splice is a no-op when in sync)`);
}

// 2) No stray cheat-sheet markers in skills outside the table (add-project, sync-*, …).
for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!d.isDirectory() || CHEATSHEETS[d.name]) continue;
  const body = readFileSync(join(SKILLS_DIR, d.name, "SKILL.md"), "utf8");
  ok(!body.includes("cli-cheatsheet:begin"), `skills/${d.name}/SKILL.md: no cheat-sheet marker (not in the generator table)`);
  // A setup skill has no block ⇒ cheatSlice returns "" ⇒ the job/classic corpus skips it gracefully.
  ok(cheatSlice(body) === "", `skills/${d.name}/SKILL.md: cheatSlice returns "" (no block — the corpus skips it)`);
}

// 3) Content contract (belt + braces over the byte-match — these catch a bad TABLE edit, which the
//    byte-match alone would happily regenerate into every SKILL).
const STEWARDS = ["sweep-agent", "reflect-agent", "ops-agent", "communication-agent"];
for (const [dir, block] of blocks) {
  const spec = CHEATSHEETS[dir];
  ok(block.includes("dev-loop project --json"), `${dir}: block opens with the fail-closed identity check (dev-loop project --json)`);
  ok(block.includes("**STOP this fire**") && block.includes("do NOT touch the repo"),
    `${dir}: exit-4 identity failure says STOP + never touch the repo (fail closed)`);
  ok(/0 ok · 1 domain error .*· 2 usage · 3 doc\.save CAS CONFLICT/.test(block), `${dir}: carries the exit-code contract from the CLI usage`);
  // `dev-loop conventions --agent <a> [--project <k>]` is a read-only config selector, not the D1 board
  // override — the --project check below is about the WRITE-layer override wording only.
  const hasProject = block.split("\n").filter((l) => !/^dev-loop conventions /.test(l)).join("\n").includes("--project");
  if (STEWARDS.includes(dir)) {
    ok(spec.project === "steward" && hasProject && block.includes("stewards + the operator → any project"),
      `${dir}: steward block carries the D1 matrix --project wording`);
    ok(verbsFor(spec, skillProse(dir)).includes("op") && block.includes("dev-loop op <op-name>"),
      `${dir}: steward block carries LAYER 0 (cross-project reads need it — tickets/ticket take no --project)`);
  } else if (dir === "pm-agent") {
    ok(spec.project === "pm" && hasProject && block.includes("`_team`-only") && block.includes('"project":"_team"'),
      `${dir}: pm block scopes --project to _team + the §9b team-intake job`);
  } else {
    ok(spec.project === "none" && !hasProject,
      `${dir}: delivery block never mentions --project (server-refused for this actor, D1)`);
  }
  // WS-A A5 — the rendered verb set is exactly core ∪ job floor ∪ prose mentions: every verb the prose
  // names is on the sheet, and nothing outside the union leaks in.
  const rendered = verbsFor(spec, skillProse(dir));
  const mentioned = mentionedVerbs(skillProse(dir));
  ok(mentioned.every((v) => rendered.includes(v)), `${dir}: every dev-loop verb / §18 op the prose names is on the sheet (${mentioned.join(", ") || "none"})`);
  ok(CORE_VERBS.every((v) => rendered.includes(v)) && block.includes("dev-loop notify") && block.includes("dev-loop conventions --agent"),
    `${dir}: the always-on core (queue, ticket, tickets, comment add, notify, conventions) is rendered`);
  // An entry is rendered as its `# <op>` comment line — that is the leak signature (the identity check's
  // `dev-loop project --json` line is not an entry and must not count).
  const leaked = Object.keys(OP_OF).filter((v) => !rendered.includes(v) && block.includes(`\n# ${OP_OF[v]}\n`));
  ok(leaked.length === 0, `${dir}: no verb outside core ∪ floor ∪ prose leaks into the sheet${leaked.length ? ` (${leaked.join(", ")})` : ""}`);
  if (rendered.includes("ticket update")) {
    ok(block.includes("HAZARD: labels REPLACE the full set") && block.includes("APPEND-ONLY union"),
      `${dir}: ticket update carries BOTH write hazards (labels REPLACE / relatedTo append-only)`);
  }
  if (rendered.includes("doc save")) {
    ok(block.includes("latestVersion") && block.includes("--version latest") && block.includes("exit `3`"),
      `${dir}: doc save carries the exit-3 CONFLICT recovery loop (doc get --version latest → re-apply → re-save)`);
  }
}

// 3b) WS-A A5 — the prose-derivation itself (fixture, no CLI spawn).
ok(JSON.stringify(mentionedVerbs("run `dev-loop ticket update <id> --state Todo`, then `dev-loop doc get`").sort()) === JSON.stringify(["doc get", "ticket update"]),
  "mentionedVerbs: two-word verbs resolve exactly (ticket update, doc get)");
ok(JSON.stringify(mentionedVerbs("a `save_issue` create and a `mirror.push` call").sort()) === JSON.stringify(["mirror push", "ticket create", "ticket update"]),
  "mentionedVerbs: canonical §18 op names map back to verbs (save_issue ⇒ both ticket verbs; mirror.push ⇒ mirror push)");
ok(mentionedVerbs("dev-loop metrics --window 24h and dev-loop push --repo x").length === 0, "mentionedVerbs: non-sheet verbs (metrics, push) are ignored");
ok(JSON.stringify(verbsFor({ verbs: ["op"], project: "none", scope: "" }, "").slice(0, CORE_VERBS.length)) === JSON.stringify([...CORE_VERBS]),
  "verbsFor: the core floor comes first, in a stable order");

// 4) The five delivery/implementer sheets stay junior-shaped (no mirror/label/publish surface creep).
for (const dir of ["qa-agent", "junior-dev-agent", "dev-agent", "architect-agent", "senior-dev-agent"]) {
  const block = blocks.get(dir)!;
  ok(!block.includes("mirror push") && !block.includes("doc publish") && !block.includes("label create"),
    `${dir}: no steward/operator-only verbs (mirror push / doc publish / label create) leak into the sheet`);
}

console.log(fails === 0 ? "\nCLI_CHEATSHEET_OK" : `\n${fails} CHECK(S) FAILED — cheat-sheet blocks drift from the generator/CLI`);
process.exit(fails === 0 ? 0 : 1);
