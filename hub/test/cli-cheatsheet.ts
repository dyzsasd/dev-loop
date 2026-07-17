// B2 [drift lint]: the per-agent CLI cheat-sheet blocks in skills/*/SKILL.md must BYTE-MATCH what
// hub/src/gen-cheatsheets.ts renders from the CLI's own usage strings (D9's named mitigation for
// "cheat-sheet defects hit all agents at once"). Any change to cli-agentops.ts/cli.ts usage text, to
// the generator's agent→verbs table, or a hand-edit inside the markers fails here until the operator
// re-runs `node hub/src/gen-cheatsheets.ts`. Root skills/ only — hub/skills is build output.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHEATSHEETS, SKILLS_DIR, markerBegin, markerEnd, renderBlocks, shortName, splice,
} from "../src/gen-cheatsheets.ts";

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
  // splice() on an in-sync file is the identity — the regeneration path is idempotent.
  ok(splice(body, dir, block) === body, `skills/${dir}/SKILL.md: regeneration is idempotent (splice is a no-op when in sync)`);
}

// 2) No stray cheat-sheet markers in skills outside the table (add-project, sync-*, …).
for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!d.isDirectory() || CHEATSHEETS[d.name]) continue;
  const body = readFileSync(join(SKILLS_DIR, d.name, "SKILL.md"), "utf8");
  ok(!body.includes("cli-cheatsheet:begin"), `skills/${d.name}/SKILL.md: no cheat-sheet marker (not in the generator table)`);
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
  const hasProject = block.includes("--project");
  if (STEWARDS.includes(dir)) {
    ok(spec.project === "steward" && hasProject && block.includes("stewards + the operator → any project"),
      `${dir}: steward block carries the D1 matrix --project wording`);
    ok(spec.verbs.includes("op") && block.includes("dev-loop op <op-name>"),
      `${dir}: steward block carries LAYER 0 (cross-project reads need it — tickets/ticket take no --project)`);
  } else if (dir === "pm-agent") {
    ok(spec.project === "pm" && hasProject && block.includes("`_team`-only") && block.includes('"project":"_team"'),
      `${dir}: pm block scopes --project to _team + the §9b team-intake job`);
  } else {
    ok(spec.project === "none" && !hasProject,
      `${dir}: delivery block never mentions --project (server-refused for this actor, D1)`);
  }
  if (spec.verbs.includes("ticket update")) {
    ok(block.includes("HAZARD: labels REPLACE the full set") && block.includes("APPEND-ONLY union"),
      `${dir}: ticket update carries BOTH write hazards (labels REPLACE / relatedTo append-only)`);
  }
  if (spec.verbs.includes("doc save")) {
    ok(block.includes("latestVersion") && block.includes("--version latest") && block.includes("exit `3`"),
      `${dir}: doc save carries the exit-3 CONFLICT recovery loop (doc get --version latest → re-apply → re-save)`);
  }
}

// 4) The five delivery/implementer sheets stay junior-shaped (no mirror/label/publish surface creep).
for (const dir of ["qa-agent", "junior-dev-agent", "dev-agent", "architect-agent", "senior-dev-agent"]) {
  const block = blocks.get(dir)!;
  ok(!block.includes("mirror push") && !block.includes("doc publish") && !block.includes("label create"),
    `${dir}: no steward/operator-only verbs (mirror push / doc publish / label create) leak into the sheet`);
}

console.log(fails === 0 ? "\nCLI_CHEATSHEET_OK" : `\n${fails} CHECK(S) FAILED — cheat-sheet blocks drift from the generator/CLI`);
process.exit(fails === 0 ? 0 : 1);
