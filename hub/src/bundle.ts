#!/usr/bin/env node
// `dev-loop bundle export` + the `dev-loop up --bundle` loader (one-click §4) — implemented in the
// bundle task of this branch. This placeholder keeps `up`'s dispatch compiling until that commit lands.
import { pathToFileURL } from "node:url";

export async function bundleExport(_argv: string[]): Promise<number> {
  console.error("dev-loop bundle: the bundle author/loader lands later on this branch (one-click §4)");
  return 1;
}

export async function bundleLoad(_file: string, _dir: string, _opts: { forceReseed: boolean }): Promise<number> {
  console.error("dev-loop up --bundle: the bundle loader lands later on this branch (one-click §4)");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await bundleExport(process.argv.slice(2)));
}
