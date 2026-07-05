// comms.ts — `dev-loop notify`: payload shapes, DRYRUN (never leaks the URL), env-missing + non-2xx paths.
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPayload, notify } from "../src/comms.ts";
import { loadWorkspace } from "../src/team-config.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-comms-")));

// ── pure payload shapes ──
{
  const slack = buildPayload("slack", { level: "warn", title: "T", text: "hello" }) as { text: string };
  ok(/\*\[warn\] T\*/.test(slack.text) && /hello/.test(slack.text), "slack payload is a text block with level+title");
  const lark = buildPayload("lark", { level: "error", text: "boom" }) as { msg_type: string; content: { text: string } };
  ok(lark.msg_type === "text" && /\[error\]/.test(lark.content.text) && /boom/.test(lark.content.text), "lark payload is msg_type:text with level");
}

const notifyCli = (args: string[], cwd: string, extra: Record<string, string> = {}) => {
  const r = spawnSync("node", [join(hubRoot, "src", "comms.ts"), ...args], { cwd, env: { ...process.env, ...extra }, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

(async () => {
try {
  // workspace with lark comms → env name DEVLOOP_TEST_HOOK
  const ws = join(tmp, "ws");
  spawnSync("node", [join(hubRoot, "src", "team.ts"), "init", "--dir", ws, "--key", "comms-team", "--backend", "linear", "--linear-team", "L", "--comms", "lark:DEVLOOP_TEST_HOOK"], { env: { ...process.env, DEVLOOP_HOME: join(tmp, "home") }, encoding: "utf8" });
  const env = { DEVLOOP_HOME: join(tmp, "home") };

  // ── DRYRUN: prints provider + env NAME + payload, never the URL ──
  const dry = notifyCli(["--title", "Daily", "--level", "warn", "the digest"], ws, { ...env, DEVLOOP_COMMS_DRYRUN: "1", DEVLOOP_TEST_HOOK: "https://secret.example/xyz-TOKEN" });
  ok(dry.code === 0 && /"dryRun":true/.test(dry.out) && /"env":"DEVLOOP_TEST_HOOK"/.test(dry.out), "DRYRUN prints provider + env NAME + payload");
  ok(!/secret\.example|xyz-TOKEN/.test(dry.out), "DRYRUN never prints the webhook URL (I5)");
  ok(/"msg_type":"text"/.test(dry.out) && /the digest/.test(dry.out), "DRYRUN payload carries the lark shape + message");

  // ── env missing → exit 3 ──
  const noenv = notifyCli(["hello"], ws, env);
  ok(noenv.code === 3 && /DEVLOOP_TEST_HOOK is not set/.test(noenv.out), "missing comms env → exit 3 with the env name");

  // ── real send to a local fake webhook — IN-PROCESS (a blocking spawnSync would freeze this same
  //    process's server, hanging the child's fetch until it times out). This still exercises the real
  //    fetch/status code in comms.ts.
  const wsObj = loadWorkspace(ws);
  const okServer = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { (okServer as unknown as { lastBody?: string }).lastBody = b; res.writeHead(200); res.end("ok"); }); });
  await new Promise<void>((r) => okServer.listen(0, "127.0.0.1", r));
  const okPort = (okServer.address() as { port: number }).port;
  process.env.DEVLOOP_TEST_HOOK = `http://127.0.0.1:${okPort}/hook`;
  const sentCode = await notify(wsObj, { level: "info", text: "ping" });
  ok(sentCode === 0, "a 2xx webhook response → exit 0");
  ok(/"msg_type":"text"/.test((okServer as unknown as { lastBody?: string }).lastBody ?? ""), "the webhook received the lark JSON payload");
  okServer.close();

  // ── non-2xx → exit 1 ──
  const errServer = createServer((_req, res) => { res.writeHead(500); res.end("nope-body"); });
  await new Promise<void>((r) => errServer.listen(0, "127.0.0.1", r));
  const errPort = (errServer.address() as { port: number }).port;
  process.env.DEVLOOP_TEST_HOOK = `http://127.0.0.1:${errPort}/hook`;
  const failedCode = await notify(wsObj, { level: "info", text: "ping" });
  ok(failedCode === 1, "a non-2xx webhook response → exit 1");
  errServer.close();
  delete process.env.DEVLOOP_TEST_HOOK;

  console.log(fails === 0 ? "\nCOMMS_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}
})();
