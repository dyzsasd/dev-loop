#!/usr/bin/env node
// `dev-loop secret set|list|unset` — the workspace secrets verb family (one-click Q1, design §2.5 step 4).
// The load-bearing property: the VALUE never appears on a command line, in shell history, in the chat
// transcript, or in a model context. `set` reads it from a hidden TTY prompt (raw mode, echo off) or from
// stdin (`--stdin` / piped input — the test path). Writes land in `<workspace>/.dev-loop/secrets.env`
// (chmod 600, §16's value home) via a LINE-LEVEL upsert that preserves the operator's comments and
// ordering — never a parse-and-rewrite that would flatten the file. `list` prints names + resolution
// source only (env-wins vs file), never a value.
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "./workspace.ts";
import { wsSecretsPath, parseSecretsEnv } from "./secrets.ts";

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

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

// Line-level upsert: replace the first `NAME=…` line (tolerating `export ` and surrounding whitespace,
// matching parseSecretsEnv's grammar) or append. Comments, blank lines, and unrelated keys are preserved
// byte-for-byte — the file is the OPERATOR's file; this verb only owns the one line it touches.
export function upsertSecretLine(content: string, name: string, value: string): string {
  const lines = content.length ? content.replace(/\r\n/g, "\n").split("\n") : [];
  const keyOf = (line: string): string | null => {
    const body = line.trim().startsWith("export ") ? line.trim().slice("export ".length).trim() : line.trim();
    const eq = body.indexOf("=");
    if (eq <= 0) return null;
    const k = body.slice(0, eq).trim();
    return ENV_NAME_RE.test(k) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : null;
  };
  const idx = lines.findIndex((l) => keyOf(l) === name);
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
Doctor W12/W13 report resolvability.`);
    return 0;
  }
  const ws = resolveWorkspace();
  const path = wsSecretsPath(ws.root);

  if (sub === "list") {
    const file = existsSync(path) ? parseSecretsEnv(readFileSync(path, "utf8")) : {};
    const names = Object.keys(file).sort();
    if (!names.length) { console.log(`(no secrets stored in ${path})`); return 0; }
    for (const n of names) {
      // env-wins semantics (secrets.ts): a real-environment value shadows the file's
      const source = process.env[n] !== undefined && !Object.prototype.hasOwnProperty.call(file, n) ? "env" : "secrets.env";
      console.log(`${n}  (${source}${process.env[n] !== undefined ? ", resolvable" : file[n] ? ", resolvable" : ", EMPTY"})`);
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
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await secretCli());
}
