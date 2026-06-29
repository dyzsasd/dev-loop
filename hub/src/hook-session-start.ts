#!/usr/bin/env node
// SessionStart hook entry for packaged Claude plugin installs.
//
// The hook may be invoked by whatever `node` appears first on PATH. Keep this file free of node:sqlite
// imports so even an older Node can run it, find a compatible runtime, and then start the real daemon.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCompatibleNode } from "./node-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url)); // hub/src (source) | dist (published)
const ext = fileURLToPath(import.meta.url).endsWith(".js") ? ".js" : ".ts";
const node = findCompatibleNode();

if (node) {
  spawnSync(node, [join(here, `cli${ext}`), "daemon", "up"], { stdio: "ignore", env: { ...process.env, DEVLOOP_NODE: node } });
}

// Hooks must never make a Claude session fail to start. Missing/old Node or a non-service project is a no-op.
process.exit(0);
