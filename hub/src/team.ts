#!/usr/bin/env node
// `dev-loop team <sub>` dispatcher — init | import | repair (design impl §9.2). A thin router so cli.ts has
// one `team` route; each subcommand keeps its own arg parsing.
import { fileURLToPath } from "node:url";
import { teamInit } from "./team-init.ts";
import { teamImport } from "./team-import.ts";
import { teamRepair } from "./team-repair.ts";

function usage(): void {
  console.log(`dev-loop team <subcommand>

  init     create a workspace (pure CLI; no backend calls)
  import   fold a legacy projects.json into the current workspace (one-shot)
  repair   fix a workspace after a move/migration (worktrees, index, WAL)

Run \`dev-loop team <sub> --help\` for each.`);
}

export function team(argv = process.argv.slice(2)): number {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "init": return teamInit(rest);
    case "import": return teamImport(rest);
    case "repair": return teamRepair(rest);
    case undefined: case "help": case "--help": case "-h": usage(); return 0;
    default: console.error(`dev-loop team: unknown subcommand '${sub}'\n`); usage(); return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(team());
}
