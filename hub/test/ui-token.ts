// One-click P1 (§6.2) — the daemon bearer gate + bind knob. Covers: bearerOk shapes; a tokened daemon
// 401s every surface except /api/health and honors the correct token; a bearer-authed request bypasses
// the LOCAL_HOST write guard (the reverse-proxy/attach posture); a token-LESS daemon is byte-identical
// to the pre-token surface (foreign-Host op still 403s, reads still open); and the boot fail-closed
// refusal — a widened bind without a token must not start.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { bearerOk, isLoopbackHost } from "../src/ui-token.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── unit: bearerOk / isLoopbackHost ─────────────────────────────────────────
ok(bearerOk("Bearer s3cret", "s3cret"), "bearerOk: exact match passes");
ok(!bearerOk("Bearer wrong1", "s3cret"), "bearerOk: wrong token fails");
ok(!bearerOk("s3cret", "s3cret") && !bearerOk(undefined, "s3cret") && !bearerOk("Basic s3cret", "s3cret"),
  "bearerOk: non-Bearer shapes fail");
ok(isLoopbackHost("127.0.0.1") && isLoopbackHost("localhost") && !isLoopbackHost("0.0.0.0") && !isLoopbackHost("10.0.0.5"),
  "isLoopbackHost: loopback vs routable");

const DB = "/tmp/dl-ui-token/hub.db";
rmSync("/tmp/dl-ui-token", { recursive: true, force: true });
const seedConn = openDb(DB);
const projectId = ensureSeed(seedConn, "tok", "Token Project", "TOK");
seedConn.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify({ hub: { transport: "daemon" } }), projectId);
seedConn.close();

async function startDaemon(env: Record<string, string | undefined>): Promise<{ base: string; close: () => void }> {
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const { createDaemon } = await import("../src/daemon.ts");
  const db = openDb(DB); db.exec("PRAGMA query_only=ON");
  const writeDb = openDb(DB);
  const server = createDaemon({ db, projectId, projectKey: "tok", writeDb, actor: "operator" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => { server.close(); db.close(); writeDb.close(); } };
}
const get = (base: string, path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });
// Raw http.request for the op legs: undici's fetch strips a caller-set `host` header (forbidden header),
// so a "foreign Host" faked through fetch never reaches the daemon — the guard would pass vacuously.
import { request as rawRequest } from "node:http";
const op = (base: string, name: string, headers: Record<string, string> = {}, host?: string) =>
  new Promise<{ status: number }>((resolve, reject) => {
    const u = new URL(base);
    const req = rawRequest(
      { hostname: u.hostname, port: u.port, method: "POST", path: `/api/op/${name}`,
        headers: { "content-type": "application/json", "content-length": 2, "x-devloop-actor": "pm", ...(host ? { host } : {}), ...headers } },
      (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); },
    );
    req.on("error", reject);
    req.end("{}");
  });

// ── tokened daemon ──────────────────────────────────────────────────────────
{
  const d = await startDaemon({ DEVLOOP_UI_TOKEN: "tok-123", DEVLOOP_UI_TOKEN_FILE: undefined });
  ok((await get(d.base, "/")).status === 401, "tokened: GET / without token → 401");
  ok((await get(d.base, "/")).headers ? (await get(d.base, "/", {})).headers.get("www-authenticate") === "Bearer" : false,
    "tokened: 401 carries WWW-Authenticate: Bearer");
  ok((await get(d.base, "/api/health")).status === 200, "tokened: /api/health stays token-exempt (probe surface)");
  ok((await get(d.base, "/", { authorization: "Bearer tok-123" })).status === 200, "tokened: correct bearer → 200 read");
  ok((await get(d.base, "/", { authorization: "Bearer nope" })).status === 401, "tokened: wrong bearer → 401");
  ok((await op(d.base, "list_issues")).status === 401, "tokened: op POST without bearer → 401");
  const authed = await op(d.base, "list_issues", { authorization: "Bearer tok-123" }, "board.example.com");
  ok(authed.status === 200, `tokened: bearer + FOREIGN Host op → 200 (bearer bypasses the Host guard; got ${authed.status})`);
  d.close();
}

// ── token-less daemon: byte-identical pre-token behavior ────────────────────
{
  const d = await startDaemon({ DEVLOOP_UI_TOKEN: undefined, DEVLOOP_UI_TOKEN_FILE: undefined });
  ok((await get(d.base, "/")).status === 200, "token-less: GET / open (unchanged default)");
  const foreign = await op(d.base, "list_issues", {}, "evil.example.com");
  ok(foreign.status === 403, `token-less: foreign-Host op → 403 (the existing guard, unchanged; got ${foreign.status})`);
  ok((await op(d.base, "list_issues")).status === 200, "token-less: local op without Origin → 200 (unchanged)");
  d.close();
}

// ── boot fail-closed: widened bind without a token refuses to start ─────────
{
  const run = (env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [join(hubRoot, "src", "daemon.ts")], {
      env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "tok", DEVLOOP_DAEMON_PORT: "0", DEVLOOP_UI_TOKEN: "", DEVLOOP_UI_TOKEN_FILE: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 4000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    // a SUCCESSFUL boot never exits on its own — kill it once the listen line appears
    child.stdout.on("data", () => { if (/dev-loop-hub for 'tok'/.test(out)) child.kill("SIGTERM"); });
  });
  const refused = await run({ DEVLOOP_DAEMON_HOST: "0.0.0.0" });
  ok(refused.code === 1 && /refusing to bind 0\.0\.0\.0/.test(refused.out),
    `boot: 0.0.0.0 without token → exit 1 + refusal (got ${refused.code})`);
  const tokened = await run({ DEVLOOP_DAEMON_HOST: "0.0.0.0", DEVLOOP_UI_TOKEN: "tok-xyz" });
  ok(/bearer-token required/.test(tokened.out) && !/refusing to bind/.test(tokened.out),
    "boot: 0.0.0.0 WITH token → starts and announces the token posture");
  const localDefault = await run({});
  ok(/localhost-only/.test(localDefault.out) && !/refusing/.test(localDefault.out),
    "boot: no knob → loopback default, unchanged wording");
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "ui-token: all checks passed");
process.exit(fails ? 1 : 0);
