// One-click §6.0 — ATTACH: the local CLI drives a REMOTE hub over the token-authed op-API. The e2e
// truth this suite pins: from a directory with NO workspace, NO hub db, NO DEVLOOP_HUB_DB — only
// DEVLOOP_HUB_URL + DEVLOOP_UI_TOKEN + an actor — reads AND attributed writes land on the remote
// board; the operator's D1 override reaches real projects through a `_team`-booted daemon; home-only
// verbs refuse with the home pointer; and a missing/wrong token maps to the clear exit-5 message.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";
import { startTestDaemon } from "./daemon-harness.ts";
import { scrubFireEnv } from "./env-scrub.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── LOOP-173 §16 egress guard: the §6.2 bearer must never ride plaintext http to a non-loopback host.
// Pure decision (plaintextBearerToRemote) + the postOpUrl egress that consults it BEFORE opening a
// socket. Fully hermetic: never-resolving / loopback hosts, no daemon, the token controlled in-process
// and the three env levers snapshot+restored so the daemon legs below are undisturbed (LOOP-156).
{
  const { plaintextBearerToRemote, plaintextBearerRefusal } = await import("../src/ui-token.ts");
  const { postOpUrl } = await import("../src/op-client.ts");
  const saved = { tok: process.env.DEVLOOP_UI_TOKEN, tokFile: process.env.DEVLOOP_UI_TOKEN_FILE, optIn: process.env.DEVLOOP_ATTACH_ALLOW_PLAINTEXT };
  delete process.env.DEVLOOP_UI_TOKEN; delete process.env.DEVLOOP_UI_TOKEN_FILE; delete process.env.DEVLOOP_ATTACH_ALLOW_PLAINTEXT;
  try {
    // the AC decision matrix — the predicate never resolves a hostname, so this needs no network
    ok(plaintextBearerToRemote(new URL("http://hub.internal:8787"), true) === true, "guard: plaintext + remote + token ⇒ REFUSE");
    ok(plaintextBearerToRemote(new URL("http://127.0.0.1:8787"), true) === false, "guard: plaintext + loopback + token ⇒ allow (the ssh -L tunnel posture)");
    ok(plaintextBearerToRemote(new URL("http://localhost:8787"), true) === false, "guard: plaintext + localhost + token ⇒ allow");
    ok(plaintextBearerToRemote(new URL("https://hub.internal:8787"), true) === false, "guard: https + remote + token ⇒ allow");
    ok(plaintextBearerToRemote(new URL("http://hub.internal:8787"), false) === false, "guard: plaintext + remote + NO token ⇒ allow (nothing to leak)");
    ok(plaintextBearerToRemote(new URL("ftp://hub.internal:8787"), true) === true, "guard: non-http/https scheme (ftp) + remote + token ⇒ REFUSE — only https is safe; every other scheme rides plaintext http (codex P2)");
    ok(plaintextBearerToRemote(new URL("ftp://127.0.0.1:8787"), true) === false, "guard: non-https + loopback + token ⇒ allow (the tunnel exemption is scheme-agnostic)");
    process.env.DEVLOOP_ATTACH_ALLOW_PLAINTEXT = "1";
    ok(plaintextBearerToRemote(new URL("http://hub.internal:8787"), true) === false, "guard: DEVLOOP_ATTACH_ALLOW_PLAINTEXT=1 ⇒ the explicit opt-in allows plaintext");
    delete process.env.DEVLOOP_ATTACH_ALLOW_PLAINTEXT;

    // The refusal's tunnel remedy must target the URL's EFFECTIVE remote port, not a hardcoded 8787:
    // for a default-port `http://hub.example` (port 80) the old `ssh -L 8787:localhost:8787` reaches
    // nothing (codex P2). Keep a convenient LOCAL 8787; derive only the REMOTE end (80 here). An
    // explicit port is used for both ends unchanged. The host is single-quoted (metachar case below).
    ok(/ssh -L 8787:localhost:80 'hub\.example'/.test(plaintextBearerRefusal(new URL("http://hub.example"))),
      "refusal: default-port http derives the REMOTE tunnel port (80), keeping a convenient local 8787 — not a hardcoded 8787:8787");
    ok(/ssh -L 9000:localhost:9000 'hub\.example'/.test(plaintextBearerRefusal(new URL("http://hub.example:9000"))),
      "refusal: an explicit non-default port is used for BOTH tunnel ends unchanged");

    // codex P2: a reverse-proxy path prefix must survive into BOTH remedies — postOpUrl targets
    // `${pathname}/api/op/...`, so a hub under `/dev-loop` needs the https + loopback URLs to keep it.
    const pathRefusal = plaintextBearerRefusal(new URL("http://hub.example/dev-loop"));
    ok(/https:\/\/hub\.example\/dev-loop\b/.test(pathRefusal) && /--attach http:\/\/127\.0\.0\.1:8787\/dev-loop\b/.test(pathRefusal),
      "refusal: a reverse-proxy path prefix is preserved in the TLS and loopback remedy URLs (codex P2)");
    ok(/https:\/\/hub\.example(?![\w./])/.test(plaintextBearerRefusal(new URL("http://hub.example"))),
      "refusal: a bare host (pathname '/') gains no spurious trailing slash in the remedy URL");

    // codex P2: a WHATWG URL permits shell metacharacters in the hostname (`http://evil;id` ⇒ host
    // `evil;id`), so the COPYABLE ssh remedy single-quotes it — a copy-paste must not execute `;id`.
    const metaRefusal = plaintextBearerRefusal(new URL("http://evil;id:8899"));
    ok(/ssh -L 8899:localhost:8899 'evil;id'/.test(metaRefusal),
      "refusal: a shell-metacharacter hostname is single-quoted in the ssh remedy (codex P2)");
    ok(!/localhost:8899 evil;id/.test(metaRefusal),
      "refusal: the metacharacter hostname is NEVER emitted bare (unquoted) into the copyable command");

    // egress: postOpUrl SHORT-CIRCUITS to "refused" without opening a socket. hub.invalid never resolves,
    // so unguarded the token case would reach DNS and return "down"; guarded it returns "refused" with no
    // request at all. Loopback falls through to a real (dead-port) attempt → NOT refused.
    process.env.DEVLOOP_UI_TOKEN = "egress-canary-not-a-real-secret";
    const refused = await postOpUrl(new URL("http://hub.invalid:8787"), "get_project", {}, "operator");
    ok(refused.kind === "refused" && /cleartext/.test((refused as { detail?: string }).detail ?? ""),
      "egress: postOpUrl(plaintext remote, token) ⇒ refused BEFORE any request, risk named in the detail");
    const refusedFtp = await postOpUrl(new URL("ftp://hub.invalid:8787"), "get_project", {}, "operator");
    ok(refusedFtp.kind === "refused", "egress: postOpUrl(non-https remote ftp, token) ⇒ refused BEFORE any request — the guard is not http-only (codex P2)");
    const loopOut = await postOpUrl(new URL("http://127.0.0.1:59321"), "get_project", {}, "operator");
    ok(loopOut.kind !== "refused", "egress: postOpUrl(plaintext LOOPBACK, token) is NOT refused — the tunnel posture still connects");
  } finally {
    for (const [k, key] of [["tok", "DEVLOOP_UI_TOKEN"], ["tokFile", "DEVLOOP_UI_TOKEN_FILE"], ["optIn", "DEVLOOP_ATTACH_ALLOW_PLAINTEXT"]] as const) {
      const v = saved[k]; if (v === undefined) delete process.env[key]; else process.env[key] = v;
    }
  }
}

const ROOT = mkdtempSync(join(tmpdir(), "dl-attach-"));
try {
  // ── the "remote home": a seeded hub + a token-gated daemon booted on _team, in its OWN process —
  // the CLI legs below use spawnSync, which blocks THIS event loop; an in-process daemon would starve.
  const DB = join(ROOT, "hub.db");
  const seed = openDb(DB);
  const teamId = ensureSeed(seed, "_team", "Team Intake", "TEAM");
  const shopId = ensureSeed(seed, "shop", "Shop", "SHP");
  for (const id of [teamId, shopId])
    seed.prepare("UPDATE projects SET settings_json=? WHERE id=?").run(JSON.stringify({ hub: { transport: "daemon" } }), id);
  seed.close();
  const { url: HUB } = await startTestDaemon({
    DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "_team", DEVLOOP_ACTOR: "operator",
    DEVLOOP_DAEMON_PORT: "0", DEVLOOP_UI_TOKEN: "attach-tok-1",
  });

  // ── the "laptop": an empty dir, no workspace, no local db lever ──
  const laptop = join(ROOT, "laptop"); mkdirSync(laptop);
  const cli = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], {
      cwd: laptop, encoding: "utf8",
      env: { ...scrubFireEnv(), DEVLOOP_HUB_URL: HUB, DEVLOOP_UI_TOKEN: "attach-tok-1", DEVLOOP_PROJECT: "shop", ...env } as NodeJS.ProcessEnv,
    });

  // write: create a ticket ON THE REMOTE as the operator (the D1 operator override through the _team boot)
  const mk = cli(["ticket", "create", "--title", "filed from the laptop", "--type", "Feature"]);
  ok(mk.status === 0, `attach write: ticket create exits 0 (got ${mk.status}: ${(mk.stderr ?? "").split("\n")[0]})`);
  const created = JSON.parse(mk.stdout || "{}") as { id?: string };
  ok(!!created.id?.startsWith("SHP-"), `attach write: the ticket landed on the REMOTE 'shop' board (got ${created.id})`);
  {
    const check = openDb(DB);
    try {
      const row = check.prepare("SELECT created_by FROM tickets WHERE id=?").get(created.id!) as { created_by?: string } | undefined;
      ok(row?.created_by === "operator", "attach write: attributed to the operator (X-Devloop-Actor rode the op)");
    } finally { check.close(); }
  }

  // read: tickets/ticket over the op surface — json parity + the compact human view
  const listJson = cli(["tickets", "--json"]);
  ok(listJson.status === 0 && (JSON.parse(listJson.stdout) as unknown[]).length >= 1, "attach read: tickets --json = the op list_issues body");
  const listHuman = cli(["tickets"]);
  ok(listHuman.status === 0 && listHuman.stdout.includes("filed from the laptop"), "attach read: the human view renders from the same body");
  const show = cli(["ticket", created.id!]);
  ok(show.status === 0 && show.stdout.includes("filed from the laptop"), "attach read: ticket <id> over get_issue");

  // op verb: any op by name, project override included
  const proj = cli(["op", "get_project", "--args-json", "{}"]);
  ok(proj.status === 0 && /"shop"/.test(proj.stdout), "attach op: get_project resolves the overridden project");

  // Acting AS AN AGENT over attach: the D1 matrix still governs — attach never widens an AGENT's
  // reach. pm targeting a sibling project through the _team boot is FORBIDDEN (exactly as on the home);
  // a steward (sweep) passes; the operator (above) overrides freely. Honest attribution, honest gates.
  const asPm = cli(["comment", "add", created.id!, "--body", "pm note from afar"], { DEVLOOP_ACTOR: "pm" });
  ok(asPm.status !== 0 && /FORBIDDEN/.test(`${asPm.stdout}${asPm.stderr}`),
    "attach: DEVLOOP_ACTOR=pm hitting a sibling project is FORBIDDEN — the D1 matrix is not widened by attach");
  const asSweep = cli(["comment", "add", created.id!, "--body", "sweep note from afar"], { DEVLOOP_ACTOR: "sweep" });
  ok(asSweep.status === 0, `attach: a STEWARD actor overrides per the matrix (got ${asSweep.status}: ${(asSweep.stderr ?? "").split("\n")[0]})`);

  // home-only verbs refuse, with the home pointer
  for (const verb of [["run", "--agents", "qa", "--once"], ["doctor"], ["team", "set", "team.mode", "live"], ["secret", "list"], ["bundle", "export", "--out", "x"], ["metrics"]]) {
    const r = cli(verb);
    ok(r.status === 2 && /WORKSPACE HOME/.test(r.stderr), `attach gate: \`dev-loop ${verb[0]}\` refuses over attach`);
  }

  // token discipline: wrong/missing token → the clear exit-5 pointer (never a hang, never a silent 401)
  const noTok = cli(["tickets", "--json"], { DEVLOOP_UI_TOKEN: undefined, DEVLOOP_UI_TOKEN_FILE: undefined });
  ok(noTok.status === 5 && /bearer token/.test(noTok.stderr), "attach: missing token → exit 5 naming DEVLOOP_UI_TOKEN");
  const badTok = cli(["ticket", "create", "--title", "x", "--type", "Bug"], { DEVLOOP_UI_TOKEN: "wrong" });
  ok(badTok.status === 5 && /bearer token/.test(badTok.stderr),
    `attach: wrong token → same clear refusal (got ${badTok.status}; err: ${(badTok.stderr ?? "").split("\n").filter((l) => !/Experimental|trace-/.test(l)).slice(0, 2).join(" | ")})`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "attach: all checks passed");
process.exit(fails ? 1 : 0);
