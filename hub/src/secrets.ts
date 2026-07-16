// Workspace-scoped secrets — `<workspace>/.dev-loop/secrets.env` (§16 companion).
//
// dev-loop.json stores env-var NAMES only (§16: it is agent-ingested + shareable), so the VALUES need
// a workspace-local, non-agent-visible home — otherwise the webhook lives in machine-global shell state
// and a workspace that moves machines (or an operator who never exported it) silently loses the ENTIRE
// notification layer: `notify` no-ops, the daemon Human-Blocked reminder never fires, the §22a digest
// never delivers. `.dev-loop/` is already the machine-local, never-committed data home (I4/§17), so the
// file rides the same guarantees. Format: dotenv subset — `KEY=VALUE`, full-line `#` comments, blank
// lines, an optional `export ` prefix (accepted and stripped), surrounding single/double quotes stripped.
// NO interpolation, NO inline comments (a webhook URL may legally contain `#`).
//
// Loading contract (resolveWorkspace calls loadWorkspaceSecrets after discovery, so every entry point —
// cli / daemon / run-agents — inherits it, and the agent fires they spawn inherit process.env):
//   • a key is set ONLY if not already in process.env — the real environment always wins;
//   • an absent file is a silent no-op (zero behavior change for existing workspaces);
//   • values are NEVER logged — any diagnostic carries key names / the file path only.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

export function wsSecretsPath(root: string): string { return join(root, ".dev-loop", "secrets.env"); }

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Pure dotenv-subset parser. A malformed line (no `=`, bad key) is SKIPPED, never a throw — a typo in
// one line must not take down workspace resolution for every consumer.
export function parseSecretsEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Which keys the loader ACTUALLY injected per workspace root (i.e. absent from the real env at load
// time) — doctor reports the resolution source as `(env)` vs `(secrets.env)` from this. Per-process,
// like the env itself: a value edit in the file needs a restart to take effect (env-wins includes our
// own earlier injection — deliberate, so precedence never flips mid-process).
const injectedByRoot = new Map<string, Set<string>>();
const permsWarned = new Set<string>();

export function secretsInjectedKeys(root: string): ReadonlySet<string> {
  return injectedByRoot.get(root) ?? new Set();
}

// Hydrate process.env from `<root>/.dev-loop/secrets.env`. Idempotent; called on every workspace
// resolution (cheap: one read), so a daemon/scheduler that re-resolves keeps working after the file
// first appears.
export function loadWorkspaceSecrets(root: string): void {
  const p = wsSecretsPath(root);
  let content: string;
  try { content = readFileSync(p, "utf8"); } catch { return; } // absent ⇒ no-op
  warnLoosePerms(p);
  const injected = injectedByRoot.get(root) ?? new Set<string>();
  injectedByRoot.set(root, injected);
  for (const [k, v] of Object.entries(parseSecretsEnv(content))) {
    if (process.env[k] === undefined) { process.env[k] = v; injected.add(k); }
  }
}

// The file holds live credentials: warn (never fail) when group/world bits are set. stderr only —
// stdout is the MCP protocol channel for some callers. Once per path per process (the daemon and the
// run loop re-resolve constantly).
function warnLoosePerms(p: string): void {
  if (platform() === "win32" || permsWarned.has(p)) return;
  try {
    const mode = statSync(p).mode;
    if (mode & 0o077) {
      permsWarned.add(p);
      console.error(`[dev-loop] ${p} is readable by group/others (mode ${(mode & 0o777).toString(8)}) — it holds secrets; tighten it: chmod 600 ${p}`);
    }
  } catch { /* raced away between read and stat — nothing to warn about */ }
}
