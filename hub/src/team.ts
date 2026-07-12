#!/usr/bin/env node
// `dev-loop team <sub>` dispatcher — init | import | repair (design impl §9.2). A thin router so cli.ts has
// one `team` route; each subcommand keeps its own arg parsing.
import { fileURLToPath } from "node:url";
import { teamInit } from "./team-init.ts";
import { teamImport } from "./team-import.ts";
import { teamRepair } from "./team-repair.ts";
import { addProject, addRepo, teamSet } from "./team-edit.ts";
import { WsValidationError } from "./team-config.ts";
import { WsNotFound } from "./workspace.ts";

function usage(): void {
  console.log(`dev-loop team <subcommand>

  init          create a workspace (pure CLI; no backend calls)
  import        fold a legacy projects.json into the current workspace (one-shot)
  repair        fix a workspace after a move/migration (worktrees, index, WAL)
  add-project   register a virtual project (validated write; auto-seeds the hub row on backend:"service")
  add-repo      register a repo + reference it from a project (validated write; --detect infers build/CI facts)
  set           validated single-field update over the operator-tunable paths (e.g. team.mode, team.linearTeam)

Run \`dev-loop team <sub> --help\` for each.`);
}

export async function team(argv = process.argv.slice(2)): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "init": return teamInit(rest);
      case "import": return teamImport(rest);
      case "repair": return teamRepair(rest);
      case "add-project": return await addProject(rest);
      case "add-repo": return addRepo(rest);
      case "set": return await teamSet(rest);
      case undefined: case "help": case "--help": case "-h": usage(); return 0;
      default: console.error(`dev-loop team: unknown subcommand '${sub}'\n`); usage(); return 2;
    }
  } catch (e) {
    // The operator entry point: a broken/missing dev-loop.json must print the E-code list (or the
    // team-init pointer), NEVER a raw stack trace.
    if (e instanceof WsValidationError || e instanceof WsNotFound) { console.error(`dev-loop team: ${e.message}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await team());
}
