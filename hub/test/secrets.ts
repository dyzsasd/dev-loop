// secrets.ts — the workspace-scoped secrets file (.dev-loop/secrets.env, §16 companion).
// Parser (quotes/comments/whitespace/export/no-interpolation), env>file precedence, absent-file no-op,
// the resolveWorkspace hydration hook, doctor's W12 resolvable/unresolvable branches (never the value),
// perms warning, and the end-to-end acceptance: webhook ONLY in secrets.env + clean shell ⇒ notify delivers.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSecretsEnv, loadWorkspaceSecrets, secretsInjectedKeys, wsSecretsPath } from "../src/secrets.ts";
import { resolveWorkspace, wsHubDb } from "../src/workspace.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { openDb } from "../src/db.ts";
import { secretCli, hasSecretLine, upsertSecretLine } from "../src/secret-cli.ts";
import { FIRE_MARKERS } from "../src/destructive-guard.ts"; // LOOP-417: assert over the OWNED list, not a copy
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers must never reach a spawned fixture

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
// doctorWorkspace's DOCTOR_CHECKS rows (LOOP-357) run after an await, so the sync capture above
// returns before any registry row has emitted. Anything asserted on a registry row needs this one.
const captureAsync = async (fn: () => unknown): Promise<string> => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => { lines.push(String(m)); };
  try { await fn(); } finally { console.log = orig; }
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

  // ── doctor W21: sensitive mis-tier backstop — service backend with hub.db (new in LOOP-81) ──
  {
    const mkWsSvc = (name: string, projKey: string): string => {
      const root = join(tmp, name);
      mkdirSync(join(root, ".dev-loop"), { recursive: true });
      writeFileSync(join(root, "dev-loop.json"), JSON.stringify({
        schemaVersion: 2,
        team: { key: name, backend: "service" },
        repos: {},
        projects: { [projKey]: { prefix: "W21" } },
      }));
      return root;
    };

    const root = mkWsSvc("w21-ws", "w21proj");
    const ws = loadWorkspace(root);
    const nowIso = new Date().toISOString();

    const db = openDb(wsHubDb(ws));
    db.prepare("INSERT INTO projects(id,key,name,ticket_prefix,ticket_seq,created_at) VALUES(?,?,?,?,0,?)").run("pid-w21", "w21proj", "W21 Proj", "W21", nowIso);
    db.close();

    const outSilent = capture(() => doctorWorkspace(loadWorkspace(root)));
    ok(!outSilent.includes("[W21]"), "doctor W21: no sensitive+junior-dev tickets → W21 silent");

    const db2 = openDb(wsHubDb(ws));
    db2.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES(?,?,?,?,1,?)").run("a-sr", "senior-dev", "agent", "Senior Dev", nowIso);
    db2.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "W21-1", "pid-w21", "sensitive feature", "", "Feature", "Todo", "junior-dev", 2,
      JSON.stringify(["dev-loop", "pm", "sensitive", "junior-dev"]), "[]", "pm", nowIso, nowIso
    );
    db2.close();

    const outWarn = capture(() => doctorWorkspace(loadWorkspace(root)));
    ok(/\[W21\]/.test(outWarn) && outWarn.includes("W21-1"), "doctor W21: sensitive+junior-dev ticket → W21 warn with ticket id");
  }

  // ── doctor W16/W21 opts.boardDb override: exercises the non-wsHubDb branch (LOOP-199) ──
  {
    const nowIso2 = new Date().toISOString();
    const bdRoot = join(tmp, "w21-boarddb-ws");
    mkdirSync(join(bdRoot, ".dev-loop"), { recursive: true });
    writeFileSync(join(bdRoot, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "w21-boarddb-ws", backend: "service" },
      repos: {},
      projects: { bdproj: { prefix: "BD" } },
    }));
    const bdWs = loadWorkspace(bdRoot);

    const boardDbPath = join(tmp, "l199-boarddb.db");
    const bDb = openDb(boardDbPath);
    bDb.prepare("INSERT INTO projects(id,key,name,ticket_prefix,ticket_seq,created_at) VALUES(?,?,?,?,0,?)").run("pid-bd", "bdproj", "BD Proj", "BD", nowIso2);
    bDb.prepare("INSERT INTO actors(id,handle,kind,display_name,active,created_at) VALUES(?,?,?,?,1,?)").run("a-sd-bd", "senior-dev", "agent", "Senior Dev", nowIso2);
    bDb.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "BD-1", "pid-bd", "sensitive feature bd", "", "Feature", "Todo", "junior-dev", 2,
      JSON.stringify(["dev-loop", "pm", "sensitive", "junior-dev"]), "[]", "pm", nowIso2, nowIso2,
    );
    bDb.close();

    // opts.boardDb set: W21 (and W16) read from the supplied db instead of wsHubDb (which is absent here)
    const outBoardDb = capture(() => doctorWorkspace(bdWs, { boardDb: boardDbPath }));
    ok(/\[W21\]/.test(outBoardDb) && outBoardDb.includes("BD-1"), "doctor W21 boardDb: opts.boardDb fires W21 from the supplied db (exercises the opts.boardDb ?? wsHubDb branch)");

    // opts.boardDb absent + no wsHubDb: existsSync false → W16/W21 silently skipped
    const outNoDb = capture(() => doctorWorkspace(bdWs));
    ok(!outNoDb.includes("[W21]"), "doctor W21 boardDb: no boardDb + no wsHubDb → W21 silently skipped");
  }

  // ── secret list: source column reflects env-wins + EMPTY, never a value (LOOP-166) ──
  // The `list` path had NO test before this run; its correct twin (doctor W12/W13, above) did. Assert
  // all three source/resolvability states AND that no stored/env value ever reaches stdout/stderr (§16).
  {
    delete process.env.DL_SECLIST_FILEONLY;
    delete process.env.DL_SECLIST_EMPTY;
    process.env.DL_SECLIST_SHADOW = "val-in-ENV"; // exported ⇒ env-wins: the real environment shadows the file
    const root = mkWs("seclist-ws", "DL_SECLIST_WEBHOOK",
      "DL_SECLIST_FILEONLY=val-fileonly\nDL_SECLIST_SHADOW=val-in-file\nDL_SECLIST_EMPTY=\n");
    process.env.DEVLOOP_WORKSPACE = root; // secretCli takes no cwd — DEVLOOP_WORKSPACE is resolveWorkspace()'s selector
    const captured: string[] = [];
    const ol = console.log, oe = console.error;
    console.log = (m?: unknown) => { captured.push(String(m)); };
    console.error = (m?: unknown) => { captured.push(String(m)); };
    let code = 1;
    try { code = await secretCli(["list"]); }
    finally { console.log = ol; console.error = oe; delete process.env.DEVLOOP_WORKSPACE; delete process.env.DL_SECLIST_SHADOW; }
    const out = captured.join("\n");
    ok(code === 0, "secret list: exits 0");
    ok(/^DL_SECLIST_FILEONLY {2}\(secrets\.env, resolvable\)$/m.test(out), "secret list: a file-only key → (secrets.env, resolvable)");
    ok(/^DL_SECLIST_SHADOW {2}\(env, resolvable\)$/m.test(out), "secret list: a key shadowed by the real env → (env, resolvable) — the fix (was reported secrets.env)");
    ok(/^DL_SECLIST_EMPTY {2}\(secrets\.env, EMPTY\)$/m.test(out), "secret list: an empty stored value → (secrets.env, EMPTY) — the fix (was reported resolvable)");
    ok(!/val-fileonly|val-in-file|val-in-ENV/.test(out), "secret list: never prints any stored/env VALUE (§16 credential surface)");
  }

  // ── LOOP-417: `set`/`unset` refuse inside a fire; `list` does not (destructive-guard's shared gate) ──
  // Every case runs the CLI as a real CHILD process, deliberately. In-process, the un-gated paths call
  // `die()` (process.exit) or block on `readStdin()`, so a mutation that removes the gate would ABORT this
  // harness rather than turn assertions red — the run would report zero failures and read as a pass. A
  // child turns each of those outcomes into an exit code this file can assert on (AC6).
  //
  // Assertions read the FILE BYTES, not just the exit code: a refusal that still wrote would satisfy an
  // exit-code-only test, and the bytes are the property the ticket is actually about.
  {
    const readBytes = (root: string): string => readFileSync(wsSecretsPath(root), "utf8");
    const runCliChild = (root: string, argv: string[], env: Record<string, string | undefined>, stdin = "") =>
      new Promise<{ code: number; out: string }>((resolve) => {
        // scrubFireEnv() is the base so no AMBIENT marker decides these cases — each one sets exactly
        // the marker it is about (LOOP-193).
        const childEnv = { ...scrubFireEnv(), DEVLOOP_WORKSPACE: root } as Record<string, string | undefined>;
        for (const [k, v] of Object.entries(env)) { if (v === undefined) delete childEnv[k]; else childEnv[k] = v; }
        const child = spawn("node", [join(hubRoot, "src", "secret-cli.ts"), ...argv], { cwd: root, env: childEnv as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
        child.stdin.end(stdin); // always end stdin, so an un-gated `set --stdin` completes instead of hanging
        child.on("close", (c) => resolve({ code: c ?? -1, out }));
      });

    // AC2 — both markers, both verbs. Parameterised over the OWNED FIRE_MARKERS list so a marker added
    // there without a matching gate shows up as a missing case rather than passing silently.
    for (const marker of FIRE_MARKERS) {
      const slug = marker.toLowerCase().replace(/_/g, "-"); // team.key grammar is /^[a-z0-9-]{2,32}$/ (E02)
      for (const sub of ["set", "unset"] as const) {
        const root = mkWs(`f-${slug}-${sub}`, "DL_417_HOOK", "DL_417_KEY=original-value\n");
        const before = readBytes(root);
        const { code, out } = await runCliChild(root, [sub, "DL_417_KEY", "--stdin"], { [marker]: "true" }, "new-value\n");
        ok(code === 4, `secret ${sub}: refuses inside a fire (${marker}) with exit 4 (got ${code})`);
        ok(out.includes(marker), `secret ${sub}: the refusal NAMES the marker it saw (${marker})`);
        ok(readBytes(root) === before, `secret ${sub}: refused under ${marker} and the secrets file is byte-identical`);
        ok(!out.includes("original-value") && !out.includes("new-value"), `secret ${sub}: the refusal echoes no VALUE, stored or offered (§16)`);
      }
    }

    // AC2 (ordering) — the gate must precede resolveWorkspace(), which HYDRATES secrets.env into
    // process.env (workspace.ts:66). Proven with a workspace that cannot be resolved at all: if the gate
    // runs first the exit is the fire refusal; if it runs second the unresolvable config decides the exit
    // and the file has already been read. This is the "before the secrets file is read" half of AC2.
    {
      const root = mkWs("f-order-ws", "DL_417_HOOK", "DL_417_KEY=original-value\n");
      writeFileSync(join(root, "dev-loop.json"), "{ this is not valid json");
      const { code, out } = await runCliChild(root, ["unset", "DL_417_KEY"], { DEVLOOP_DEV_SPLIT: "true" });
      ok(code === 4 && out.includes("DEVLOOP_DEV_SPLIT"), `secret unset: the fire gate precedes resolveWorkspace — an unresolvable workspace still exits 4 with the refusal (got ${code})`);
    }

    // AC2 (ordering) — and it precedes NAME validation, so no ordering of arguments reaches the write.
    // Un-gated, an invalid name exits 2 from die(); gated, it is the fire refusal.
    {
      const root = mkWs("f-order-name", "DL_417_HOOK", "DL_417_KEY=original-value\n");
      const { code, out } = await runCliChild(root, ["unset", "not-an-env-name"], { DEVLOOP_DEV_SPLIT: "true" });
      ok(code === 4 && out.includes("DEVLOOP_DEV_SPLIT"), `secret unset: the fire gate precedes name validation — an invalid name in a fire exits 4, not the usage 2 (got ${code})`);
    }

    // AC3 — `list` is UNAFFECTED under a set marker. Asserted directly, not assumed.
    {
      const root = mkWs("f-list", "DL_417_HOOK", "DL_417_LISTED=listed-value\n");
      const { code, out } = await runCliChild(root, ["list"], { DEVLOOP_DEV_SPLIT: "true" });
      ok(code === 0, `secret list: still exits 0 inside a fire — read-only, and a fire must keep diagnosing resolvability (got ${code})`);
      ok(out.includes("DL_417_LISTED"), "secret list: still names the stored key inside a fire");
      ok(!out.includes("listed-value"), "secret list: prints no VALUE inside a fire (§16)");
    }

    // AC4 — control: with NO marker set, `unset` behaves exactly as today.
    {
      const root = mkWs("f-ctl-unset", "DL_417_HOOK", "DL_417_KEY=original-value\nDL_417_KEEP=keep\n");
      const { code } = await runCliChild(root, ["unset", "DL_417_KEY"], {});
      ok(code === 0, `secret unset: control — no marker ⇒ exits 0 (got ${code})`);
      const after = readBytes(root);
      ok(!after.includes("DL_417_KEY"), "secret unset: control — the line is actually gone (the gate did not become an always-refuse)");
      ok(after.includes("DL_417_KEEP=keep"), "secret unset: control — unrelated keys are preserved");
    }

    // AC5 — `set` over an EXISTING name announces the replacement; a NEW name does not. AC4 for `set`
    // rides here: the control path still stores the value.
    {
      const root = mkWs("f-ctl-set", "DL_417_HOOK", "DL_417_KEY=original-value\n");
      const r1 = await runCliChild(root, ["set", "DL_417_KEY", "--stdin"], {}, "replacement-value\n");
      ok(r1.code === 0, `secret set: control — no marker ⇒ exits 0 (got ${r1.code})`);
      ok(/REPLACING/.test(r1.out), "secret set: an overwrite of a stored name announces the replacement (AC5 — was silent '✅ saved')");
      ok(!r1.out.includes("original-value") && !r1.out.includes("replacement-value"), "secret set: neither the replaced nor the new VALUE reaches the output (§16)");
      ok(readBytes(root).includes("DL_417_KEY=replacement-value"), "secret set: control — the new value is actually stored (the notice did not displace the write)");
      const r2 = await runCliChild(root, ["set", "DL_417_FRESH", "--stdin"], {}, "fresh-value\n");
      ok(r2.code === 0 && !/REPLACING/.test(r2.out), "secret set: a NEW name is not announced as a replacement (the notice tracks the replace branch, not every set)");
      ok(readBytes(root).includes("DL_417_FRESH=fresh-value"), "secret set: control — a new name is appended");
    }

    // hasSecretLine must agree with upsert's OWN replace branch across upsert's whole line grammar — the
    // notice's only job is to be true of the write it describes.
    {
      const grammar = "export DL_417_EXPORTED=a\n  DL_417_SPACED  =b\n# DL_417_COMMENT=c\n";
      const lineCount = (s: string) => s.split("\n").length;
      ok(hasSecretLine(grammar, "DL_417_EXPORTED") && lineCount(upsertSecretLine(grammar, "DL_417_EXPORTED", "z")) === lineCount(grammar),
        "hasSecretLine: an `export NAME=` line is a replace — agrees with upsert, which adds no line");
      ok(hasSecretLine(grammar, "DL_417_SPACED") && lineCount(upsertSecretLine(grammar, "DL_417_SPACED", "z")) === lineCount(grammar),
        "hasSecretLine: a whitespace-padded name is a replace — agrees with upsert");
      ok(!hasSecretLine(grammar, "DL_417_COMMENT") && lineCount(upsertSecretLine(grammar, "DL_417_COMMENT", "z")) === lineCount(grammar) + 1,
        "hasSecretLine: a commented-out name is NOT a replace — upsert appends, so the notice stays silent");
      ok(!hasSecretLine("", "DL_417_ANY"), "hasSecretLine: an empty file has no stored name");
    }
  }
  // ── acceptance: webhook ONLY in secrets.env, clean shell ⇒ `dev-loop notify` delivers ──
  (async () => {
    const server = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { (server as unknown as { lastBody?: string }).lastBody = b; res.writeHead(200); res.end("ok"); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const root = mkWs("e2e-ws", "DL_SECTEST_E2E", `DL_SECTEST_E2E=http://127.0.0.1:${port}/hook\n`);
    const childEnv = { ...scrubFireEnv() } as Record<string, string | undefined>;
    delete childEnv.DL_SECTEST_E2E; // the clean shell: the value exists NOWHERE but secrets.env
    const child = spawn("node", [join(hubRoot, "src", "comms.ts"), "--title", "test", "hello"], { cwd: root, env: childEnv as NodeJS.ProcessEnv });
    let childOut = "";
    child.stdout.on("data", (d) => (childOut += d)); child.stderr.on("data", (d) => (childOut += d));
    const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 1)));
    ok(code === 0, "e2e: notify exits 0 with the webhook only in secrets.env (clean shell)");
    ok(/hello/.test((server as unknown as { lastBody?: string }).lastBody ?? ""), "e2e: the webhook actually received the payload");
    ok(!childOut.includes(`127.0.0.1:${port}`), "e2e: notify output never echoes the webhook URL");
    server.close();

    // ── W39 (LOOP-430): a group/world-readable secrets.env is REPORTABLE from doctor ──────────
    // Drives the shipped check, never a re-implementation of the mode arithmetic (AC5).
    {
      const { checkSecretsPerms } = await import("../src/doctor.ts");
      const warnsOf = (root: string): string[] => {
        const got: string[] = [];
        checkSecretsPerms(loadWorkspace(root), (m) => got.push(m));
        return got;
      };

      const loose = mkWs("w39-loose", "DL_SECTEST_W39", "DL_SECTEST_W39=https://hook.example/w39-secret\n");
      chmodSync(wsSecretsPath(loose), 0o644);
      const looseWarns = warnsOf(loose);
      ok(looseWarns.length === 1, `AC1/AC5: a mode-644 secrets.env yields exactly ONE warn row (got ${looseWarns.length})`);
      const w = looseWarns[0] ?? "";
      ok(w.startsWith("[W39] "), `AC1: the row carries the W39 code (got ${JSON.stringify(w.slice(0, 12))})`);
      ok(w.includes(wsSecretsPath(loose)), "AC1: the row names the exact secrets.env path");
      ok(/mode 644\b/.test(w), `AC1: the row states the OBSERVED octal mode, not a constant (got ${JSON.stringify(w.match(/mode \d+/)?.[0] ?? "none")})`);
      ok(w.includes(`chmod 600 ${wsSecretsPath(loose)}`), "AC1: the row states the remedy");
      ok(!w.includes("w39-secret"), "§16: the W39 row never prints a stored VALUE");

      // AC3 — the check has no once-per-process latch (secrets.ts's stderr line does; this must not).
      ok(warnsOf(loose).length === 1, "AC3: the check reports AGAIN on a second call in the SAME process (no permsWarned latch)");

      // AC4 — 600 and absent are both legitimate, neither warns.
      const tight = mkWs("w39-tight", "DL_SECTEST_W39T", "DL_SECTEST_W39T=x\n"); // mkWs chmods 600
      ok((statSync(wsSecretsPath(tight)).mode & 0o777) === 0o600, `AC4 precondition: the tight fixture really is 600 (got ${(statSync(wsSecretsPath(tight)).mode & 0o777).toString(8)})`);
      ok(warnsOf(tight).length === 0, "AC4: a 600 secrets.env is NOT a warning");
      const absent = mkWs("w39-absent", "DL_SECTEST_W39A"); // no secrets.env written at all
      ok(!existsSync(wsSecretsPath(absent)), "AC4 precondition: the absent fixture really has no secrets.env");
      ok(warnsOf(absent).length === 0, "AC4: an absent secrets.env is NOT a warning");

      // AC1/AC2 end-to-end — the row reaches doctor's STDOUT through the LOOP-357 registry driver.
      const dOut = await captureAsync(() => doctorWorkspace(loadWorkspace(loose)));
      ok(/⚠️.*\[W39\]/.test(dOut) && dOut.includes(wsSecretsPath(loose)), "AC1/AC2: [W39] reaches doctor stdout via the check registry");
      ok(!dOut.includes("w39-secret"), "§16: doctor's stdout never prints the stored value");

      // AC6 — the verdict contract: warn-only. A warn must not flip doctor's ok.
      ok(!/^❌/m.test(dOut), "AC6: W39 is warn-only — it emits no ❌ row, so doctor's verdict is unchanged");
    }

    console.log(fails === 0 ? "\nSECRETS_OK" : `\n${fails} CHECK(S) FAILED`);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    process.exit(fails === 0 ? 0 : 1);
  })();
} catch (e) {
  console.error(e);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  process.exit(1);
};
