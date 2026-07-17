// One-click §6.0 — ATTACH: the local CLI drives a REMOTE hub over the token-authed op-API. The e2e
// truth this suite pins: from a directory with NO workspace, NO hub db, NO DEVLOOP_HUB_DB — only
// DEVLOOP_HUB_URL + DEVLOOP_UI_TOKEN + an actor — reads AND attributed writes land on the remote
// board; the operator's D1 override reaches real projects through a `_team`-booted daemon; home-only
// verbs refuse with the home pointer; and a missing/wrong token maps to the clear exit-5 message.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed } from "../src/seed.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = mkdtempSync(join(tmpdir(), "dl-attach-"));
let daemon: ReturnType<typeof spawn> | null = null;
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
  daemon = spawn(process.execPath, [join(hubRoot, "src", "daemon.ts")], {
    env: { ...process.env, DEVLOOP_HUB_DB: DB, DEVLOOP_PROJECT: "_team", DEVLOOP_ACTOR: "operator", DEVLOOP_DAEMON_PORT: "0", DEVLOOP_UI_TOKEN: "attach-tok-1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const HUB = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`daemon never announced its port:\n${out}`)), 15_000);
    daemon!.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    daemon!.stderr!.on("data", (d) => { out += d; });
    daemon!.on("exit", (c) => { clearTimeout(timer); reject(new Error(`daemon exited ${c}:\n${out}`)); });
  });

  // ── the "laptop": an empty dir, no workspace, no local db lever ──
  const laptop = join(ROOT, "laptop"); mkdirSync(laptop);
  const cli = (args: string[], env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], {
      cwd: laptop, encoding: "utf8",
      env: { ...process.env, DEVLOOP_HUB_URL: HUB, DEVLOOP_UI_TOKEN: "attach-tok-1", DEVLOOP_HUB_DB: undefined, DEVLOOP_ACTOR: undefined, DEVLOOP_PROJECT: "shop", ...env } as NodeJS.ProcessEnv,
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
  daemon?.kill("SIGTERM");
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "attach: all checks passed");
process.exit(fails ? 1 : 0);
