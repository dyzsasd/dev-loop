#!/usr/bin/env node
// `dev-loop secret set|list|unset` — the workspace secrets verb family (one-click Q1, design §2.5 step 4).
// The load-bearing property: the VALUE never appears on a command line, in shell history, in the chat
// transcript, or in a model context. `set` reads it from a hidden TTY prompt (raw mode, echo off) or from
// stdin (`--stdin` / piped input — the test path). Writes land in `<workspace>/.dev-loop/secrets.env`
// (chmod 600, §16's value home) via a LINE-LEVEL upsert that preserves the operator's comments and
// ordering — never a parse-and-rewrite that would flatten the file. `list` prints names + resolution
// source only (env-wins vs file), never a value.
//
// LOOP-417: `set` and `unset` are DESTRUCTIVE verbs and call destructive-guard's shared fire gate. They
// were the one measured member of LOOP-368's declared residual — a verb that destroys operator data
// while importing no guard — and the gate is that module's, not a second spelling of it, so LOOP-368's
// caller enumeration covers these verbs once it lands rather than needing a reconciliation.
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isMainEntry } from "./is-entry.ts";
import { resolveWorkspace } from "./workspace.ts";
import { wsSecretsPath, parseSecretsEnv, secretsInjectedKeys } from "./secrets.ts";
import { activeFireMarker } from "./destructive-guard.ts"; // LOOP-417: the ONE fire-marker list, owned there

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

// The subcommands that DESTROY a stored value. `set` belongs here as much as `unset` does: over an
// existing name it replaces the only copy, and §16 puts values nowhere else (names live in
// dev-loop.json, values only in .dev-loop/secrets.env, never in git) — so a fire's overwrite is as
// unrecoverable as its removal, and needs the human who still holds the original key to undo.
const DESTRUCTIVE_SUBS = new Set(["set", "unset"]);

function die(msg: string, code = 2): never { console.error(`dev-loop secret: ${msg}`); process.exit(code); }

// Hidden TTY prompt: raw mode, echo suppressed, minimal backspace handling, Ctrl-C aborts.
function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(promptText);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => { stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", onData); };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "") { cleanup(); process.stderr.write("\n"); reject(new Error("aborted (Ctrl-C)")); return; }
        if (c === "\r" || c === "\n") { cleanup(); process.stderr.write("\n"); resolve(buf); return; }
        if (c === "" || c === "\b") { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// The line-key grammar `upsertSecretLine` uses to decide REPLACE-vs-APPEND. Module-level rather than
// inline so the AC5 replace notice is derived from the SAME predicate that performs the replace: a
// second spelling could announce a replacement the upsert does not make, or stay silent through one it
// does — and the notice's only job is to be true.
function secretLineKey(line: string): string | null {
  const body = line.trim().startsWith("export ") ? line.trim().slice("export ".length).trim() : line.trim();
  const eq = body.indexOf("=");
  if (eq <= 0) return null;
  const k = body.slice(0, eq).trim();
  return ENV_NAME_RE.test(k) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : null;
}

/** True iff `upsertSecretLine` would REPLACE an existing line for `name` rather than append one. */
export function hasSecretLine(content: string, name: string): boolean {
  const lines = content.length ? content.replace(/\r\n/g, "\n").split("\n") : [];
  return lines.some((l) => secretLineKey(l) === name);
}

// Line-level upsert: replace the first `NAME=…` line (tolerating `export ` and surrounding whitespace,
// matching parseSecretsEnv's grammar) or append. Comments, blank lines, and unrelated keys are preserved
// byte-for-byte — the file is the OPERATOR's file; this verb only owns the one line it touches.
export function upsertSecretLine(content: string, name: string, value: string): string {
  const lines = content.length ? content.replace(/\r\n/g, "\n").split("\n") : [];
  const idx = lines.findIndex((l) => secretLineKey(l) === name);
  if (idx >= 0) lines[idx] = `${name}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push(`${name}=${value}`);
    else if (lines.length) lines[lines.length - 1] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  return lines.join("\n") + (lines[lines.length - 1] === "" ? "" : "\n");
}

export function removeSecretLine(content: string, name: string): { content: string; removed: boolean } {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const keyOf = (line: string): string | null => {
    const body = line.trim().startsWith("export ") ? line.trim().slice("export ".length).trim() : line.trim();
    const eq = body.indexOf("=");
    return eq > 0 ? body.slice(0, eq).trim() : null;
  };
  const kept = lines.filter((l) => keyOf(l) !== name);
  return { content: kept.join("\n"), removed: kept.length !== lines.length };
}

export async function secretCli(argv = process.argv.slice(2)): Promise<number> {
  const [sub, name, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(`dev-loop secret — workspace secret values (.dev-loop/secrets.env, chmod 600; §16)

Usage:
  dev-loop secret set <ENV_NAME> [--stdin]   store a value: hidden TTY prompt (echo off), or stdin
  dev-loop secret list                       names + resolution source only — never a value
  dev-loop secret unset <ENV_NAME>           remove a stored value

The value NEVER rides a command-line argument — a key never lands in shell history or a chat
transcript. Config (dev-loop.json) stores env-var NAMES only; this file holds the VALUES.
Doctor W12/W13 report resolvability.

set/unset are operator-only: inside an agent fire they refuse (exit 4) — changing a credential is an
operator action, and secrets.env is the only copy of the value. list stays available to a fire.`);
    return 0;
  }

  // LOOP-417 (LOOP-368's AC7 residual, filled on LOOP-367's rule): a FIRE may not destroy operator
  // credentials — no flag and no token grants it. This sits BEFORE resolveWorkspace() deliberately:
  // that call hydrates .dev-loop/secrets.env into process.env (workspace.ts:66), so a gate placed
  // inside the `set`/`unset` branches would already have read the file it is protecting. Checked
  // before the NAME is validated too, so no ordering of arguments reaches the write, and before any
  // stdin read, so a piped value is never consumed by a command that will refuse.
  //
  // `list` is deliberately NOT gated: it is read-only and prints no value (§16), and a fire must keep
  // being able to diagnose resolvability — a gate that took that away would be routed around.
  //
  // No bypass, for the reason activeFireMarker() states: an escape hatch would be reached exactly the
  // way LOOP-367's token was, the guard documenting its own bypass to the party being guarded. The
  // suppressor is the ABSENCE of a fire marker — which a fire cannot arrange for itself, the operator
  // console gets by construction (up.ts deletes both markers before exec), and a test gets from
  // scrubFireEnv().
  if (DESTRUCTIVE_SUBS.has(sub)) {
    const marker = activeFireMarker();
    if (marker) {
      console.error(`dev-loop secret ${sub}: refusing inside an agent fire (${marker} is set). This verb ${sub === "unset" ? "removes" : "replaces"} a stored credential, and §16 makes secrets.env the only copy of the VALUE — re-entry needs the human, on a TTY, holding the original key. Nothing has been read or written. If a secret genuinely needs changing, file it on the board for the operator; to verify this verb, do it in a disposable workspace (mkdtemp + dev-loop team init --dir <tmp>) with the fire markers unset.`);
      return 4;
    }
  }

  const ws = resolveWorkspace();
  const path = wsSecretsPath(ws.root);

  if (sub === "list") {
    const file = existsSync(path) ? parseSecretsEnv(readFileSync(path, "utf8")) : {};
    const names = Object.keys(file).sort();
    if (!names.length) { console.log(`(no secrets stored in ${path})`); return 0; }
    // Which source actually WINS at runtime is the loader's own memo (secrets.ts / doctor W12/W13's
    // exported helper): a file key absent from `secretsInjectedKeys` was NOT injected — the real
    // environment already held it, so the ENV value wins ("env"); otherwise the file value is in
    // effect ("secrets.env"). Resolvability reflects the value ACTUALLY in effect — `process.env[n]`
    // is that value (env-wins applied at load), resolvable iff non-empty. The value is NEVER printed (§16).
    const injected = secretsInjectedKeys(ws.root);
    for (const n of names) {
      const source = injected.has(n) ? "secrets.env" : "env";
      const resolvable = (process.env[n] ?? "") !== "";
      console.log(`${n}  (${source}, ${resolvable ? "resolvable" : "EMPTY"})`);
    }
    return 0;
  }

  if (sub === "set") {
    if (!name) die("usage: dev-loop secret set <ENV_NAME> [--stdin]");
    if (!ENV_NAME_RE.test(name)) die(`'${name}' is not an ENV-VAR NAME (expected e.g. OPENROUTER_API_KEY)`);
    const useStdin = rest.includes("--stdin") || !process.stdin.isTTY;
    let value: string;
    try {
      value = useStdin ? (await readStdin()).replace(/\r?\n$/, "") : await promptHidden(`Value for ${name} (input hidden): `);
    } catch (e) { die((e as Error).message, 1); }
    if (!value) die("empty value — nothing stored", 1);
    // secrets.env is a LINE-oriented format (secrets.ts parser): an embedded newline/control char would
    // truncate the value at read time and inject stray lines — refuse rather than corrupt.
    if (/[\r\n\0]/.test(value)) die("the value contains a newline/control character — secrets.env is line-oriented; store multi-line material as a file and reference its PATH", 1);
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    // AC5: an overwrite is a destruction, and it announced itself only as `✅ saved`. Say so BEFORE the
    // write, so the line is on the operator's terminal even if the write then throws. The prior value is
    // of course never printed (§16) — the fact of the replacement is the whole message.
    if (hasSecretLine(existing, name)) console.log(`⚠️  ${name} already had a stored value in ${path} — REPLACING it (the previous value is not recoverable from here)`);
    writeFileSync(path, upsertSecretLine(existing, name, value), { mode: 0o600 });
    chmodSync(path, 0o600); // writeFileSync mode does not tighten an EXISTING file's perms
    console.log(`✅ ${name} saved to ${path} (chmod 600; value not echoed)`);
    if (process.env[name] !== undefined) console.log(`   note: ${name} is ALSO set in your environment — the env value wins at runtime (secrets.ts env-wins)`);
    return 0;
  }

  if (sub === "unset") {
    if (!name) die("usage: dev-loop secret unset <ENV_NAME>");
    if (!existsSync(path)) { console.log(`(no secrets file at ${path})`); return 0; }
    const { content, removed } = removeSecretLine(readFileSync(path, "utf8"), name);
    if (!removed) { console.log(`${name} was not stored in ${path}`); return 0; }
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`✅ ${name} removed from ${path}`);
    return 0;
  }

  die(`unknown subcommand '${sub}' (set|list|unset)`);
}

if (isMainEntry(import.meta.url)) {
  process.exit(await secretCli());
}
