// secrets.ts — the workspace-scoped secrets file (.dev-loop/secrets.env, §16 companion).
// Parser (quotes/comments/whitespace/export/no-interpolation), env>file precedence, absent-file no-op,
// the resolveWorkspace hydration hook, doctor's W12 resolvable/unresolvable branches (never the value),
// perms warning, and the end-to-end acceptance: webhook ONLY in secrets.env + clean shell ⇒ notify delivers.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSecretsEnv, loadWorkspaceSecrets, secretsInjectedKeys, wsSecretsPath } from "../src/secrets.ts";
import { resolveWorkspace } from "../src/workspace.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-secrets-")));
process.env.DEVLOOP_HOME = join(tmp, "home");
delete process.env.DEVLOOP_WORKSPACE;
delete process.env.DEVLOOP_TEAM;

// A minimal valid workspace dir with team.comms naming `envName`, secrets.env content optional.
const mkWs = (name: string, envName: string, secrets?: string): string => {
  const root = join(tmp, name);
  mkdirSync(join(root, ".dev-loop"), { recursive: true });
  writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
    schemaVersion: 2,
    team: { key: name, backend: "linear", linearTeam: "L", comms: { provider: "lark", webhookEnv: envName } },
    repos: {}, projects: {},
  }));
  if (secrets !== undefined) { writeFileSync(wsSecretsPath(root), secrets); chmodSync(wsSecretsPath(root), 0o600); }
  return root;
};
const capture = (fn: () => void): string => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
};

try {
  // ── parser: quotes / comments / whitespace / export / CRLF / no interpolation ──
  {
    const p = parseSecretsEnv([
      "# full-line comment",
      "",
      "PLAIN=hello",
      "  SPACED  =  padded value  ",
      'DQ="double quoted"',
      "SQ='single quoted'",
      "export EXPORTED=stripped",
      "NOINTERP=$OTHER and ${OTHER}",
      "URLISH=https://h.example/path?a=1#frag",
      "EMPTY=",
      "=novalue-key",
      "not a kv line",
      "1BADKEY=x",
      "CRLF=windows\r",
    ].join("\n"));
    ok(p.PLAIN === "hello", "parser: bare KEY=VALUE");
    ok(p.SPACED === "padded value", "parser: surrounding whitespace trimmed on key and value");
    ok(p.DQ === "double quoted" && p.SQ === "single quoted", "parser: single/double quotes stripped");
    ok(p.EXPORTED === "stripped", "parser: `export ` prefix accepted and stripped");
    ok(p.NOINTERP === "$OTHER and ${OTHER}", "parser: NO interpolation — $refs stay literal");
    ok(p.URLISH === "https://h.example/path?a=1#frag", "parser: a URL value keeps its # fragment (no inline comments)");
    ok(p.EMPTY === "", "parser: empty value parses as empty string");
    ok(!("1BADKEY" in p) && !("" in p) && Object.keys(p).length === 9, "parser: malformed lines are skipped, never a throw");
    ok(p.CRLF === "windows", "parser: CRLF line endings handled");
  }

  // ── loader: absent file is a no-op; env ALWAYS wins over the file ──
  {
    const bare = join(tmp, "no-secrets-ws");
    mkdirSync(bare, { recursive: true });
    loadWorkspaceSecrets(bare); // no .dev-loop/secrets.env at all
    ok(secretsInjectedKeys(bare).size === 0, "loader: absent file ⇒ no-op, nothing injected");

    const root = join(tmp, "loader-ws");
    mkdirSync(join(root, ".dev-loop"), { recursive: true });
    writeFileSync(wsSecretsPath(root), "DL_SECTEST_FILEONLY=from-file\nDL_SECTEST_BOTH=from-file\n");
    chmodSync(wsSecretsPath(root), 0o600);
    delete process.env.DL_SECTEST_FILEONLY;
    process.env.DL_SECTEST_BOTH = "from-env";
    loadWorkspaceSecrets(root);
    ok(process.env.DL_SECTEST_FILEONLY === "from-file", "loader: a key absent from the env is injected from the file");
    ok(process.env.DL_SECTEST_BOTH === "from-env", "precedence: the same key in both ⇒ the env value wins");
    ok(secretsInjectedKeys(root).has("DL_SECTEST_FILEONLY") && !secretsInjectedKeys(root).has("DL_SECTEST_BOTH"), "loader: the injected-keys memo records only file-sourced keys");
  }

  // ── perms warning: group/world-readable warns on stderr (path only), 600 stays silent ──
  if (process.platform !== "win32") {
    const root = join(tmp, "perms-ws");
    mkdirSync(join(root, ".dev-loop"), { recursive: true });
    writeFileSync(wsSecretsPath(root), "DL_SECTEST_PERM=v-secret-perm\n");
    chmodSync(wsSecretsPath(root), 0o644);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (m?: unknown) => { errs.push(String(m)); };
    try { loadWorkspaceSecrets(root); } finally { console.error = orig; }
    ok(errs.some((l) => l.includes("chmod 600") && l.includes(wsSecretsPath(root))), "perms: a group/world-readable file warns with the path + fix");
    ok(!errs.join("\n").includes("v-secret-perm"), "perms: the warning never carries a value");
  }

  // ── resolveWorkspace hydrates secrets (the one hook every entry point shares) ──
  {
    delete process.env.DL_SECTEST_RESOLVE;
    const root = mkWs("resolve-ws", "DL_SECTEST_RESOLVE", "DL_SECTEST_RESOLVE=via-resolve\n");
    resolveWorkspace(root);
    ok(process.env.DL_SECTEST_RESOLVE === "via-resolve", "resolveWorkspace loads secrets.env into process.env");
  }

  // ── doctor W12: resolvable via secrets.env / via env / unresolvable — never the value ──
  {
    delete process.env.DL_SECTEST_DOC_FILE;
    const fromFile = mkWs("doc-file-ws", "DL_SECTEST_DOC_FILE", "DL_SECTEST_DOC_FILE=https://hook.example/doc-secret\n");
    const outFile = capture(() => doctorWorkspace(loadWorkspace(fromFile)));
    ok(/✅.*DL_SECTEST_DOC_FILE resolvable \(secrets\.env\)/.test(outFile), "doctor: file-supplied webhook → resolvable (secrets.env)");
    ok(!outFile.includes("doc-secret"), "doctor: the resolvable line never prints the value");

    process.env.DL_SECTEST_DOC_ENV = "https://hook.example/env-secret";
    const fromEnv = mkWs("doc-env-ws", "DL_SECTEST_DOC_ENV");
    const outEnv = capture(() => doctorWorkspace(loadWorkspace(fromEnv)));
    ok(/✅.*DL_SECTEST_DOC_ENV resolvable \(env\)/.test(outEnv), "doctor: env-supplied webhook → resolvable (env)");
    ok(!outEnv.includes("env-secret"), "doctor: never prints the env value either");
    delete process.env.DL_SECTEST_DOC_ENV;

    delete process.env.DL_SECTEST_DOC_NONE;
    const nowhere = mkWs("doc-none-ws", "DL_SECTEST_DOC_NONE");
    const outNone = capture(() => doctorWorkspace(loadWorkspace(nowhere)));
    ok(/⚠️.*\[W12\] comms env DL_SECTEST_DOC_NONE unresolvable/.test(outNone) && outNone.includes(wsSecretsPath(nowhere)), "doctor: unresolvable → W12 warn naming the exact secrets.env path");
  }

  // ── acceptance: webhook ONLY in secrets.env, clean shell ⇒ `dev-loop notify` delivers ──
  (async () => {
    const server = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { (server as unknown as { lastBody?: string }).lastBody = b; res.writeHead(200); res.end("ok"); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const root = mkWs("e2e-ws", "DL_SECTEST_E2E", `DL_SECTEST_E2E=http://127.0.0.1:${port}/hook\n`);
    const childEnv = { ...process.env } as Record<string, string | undefined>;
    delete childEnv.DL_SECTEST_E2E; // the clean shell: the value exists NOWHERE but secrets.env
    const child = spawn("node", [join(hubRoot, "src", "comms.ts"), "--title", "test", "hello"], { cwd: root, env: childEnv as NodeJS.ProcessEnv });
    let childOut = "";
    child.stdout.on("data", (d) => (childOut += d)); child.stderr.on("data", (d) => (childOut += d));
    const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 1)));
    ok(code === 0, "e2e: notify exits 0 with the webhook only in secrets.env (clean shell)");
    ok(/hello/.test((server as unknown as { lastBody?: string }).lastBody ?? ""), "e2e: the webhook actually received the payload");
    ok(!childOut.includes(`127.0.0.1:${port}`), "e2e: notify output never echoes the webhook URL");
    server.close();

    console.log(fails === 0 ? "\nSECRETS_OK" : `\n${fails} CHECK(S) FAILED`);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    process.exit(fails === 0 ? 0 : 1);
  })();
} catch (e) {
  console.error(e);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
}
