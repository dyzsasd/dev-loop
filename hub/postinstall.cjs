#!/usr/bin/env node
"use strict";

// LOOP-468: autostart removed from postinstall. Installing a package must not install a login item.
// The `dev-loop daemon install-autostart` verb is unchanged and remains the explicit way to set up
// autostart. This file still runs on npm install (for the Node version warning below), never fails.

const MIN_NODE = "23.6.0";

function nodeVersionOk(v) {
  const [maj = 0, min = 0, patch = 0] = String(v || "").split(".").map((x) => Number(x));
  return maj > 23 || (maj === 23 && (min > 6 || (min === 6 && patch >= 0)));
}

const v = process.versions.node;
if (!nodeVersionOk(v)) {
  // Warn once; never fail npm install.
  console.log(`[dev-loop] dev-loop needs Node >= ${MIN_NODE} (detected ${v}). Set DEVLOOP_NODE=/absolute/path/to/node to use a different runtime.`);
}

process.exit(0);