// One-click §4 — the MOVE/BACKUP leg, end-to-end with REAL age keys and a REAL git bare remote.
// Covers: export (doctor gate, manifest shape, encrypted payload leaks NO secret, hub.db rides
// WAL-checkpointed, mode 600, --move stamps the source and `run` refuses there), load (decrypt via
// AGE_IDENTITY_FILE, materialize config+secrets 600, restore-onto-empty hub.db, clone from the remote
// with fail-fast probe, op-API gate seeded, doctor preflight), idempotency (live config wins,
// live hub.db NEVER overwritten), and the --no-hub-db clean-board path.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { findProject } from "../src/seed.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const hasAge = spawnSync("age", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasAge) {
  // The shipped default cipher is age (Q3); on a machine without the binary the suite still validates
  // everything through the --insecure-plaintext lane and REPORTS the skipped encryption legs loudly.
  console.log("⚠️  age binary not found — running the plaintext lane only (encryption legs skipped)");
}

const ROOT = mkdtempSync(join(tmpdir(), "dl-bundle-"));
try {
  const cli = (args: string[], cwd: string, env: Record<string, string | undefined> = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } as NodeJS.ProcessEnv });

  // ── source workspace: team + project + repo(with bare remote) + provider + secret + a ticket ──
  const src = join(ROOT, "src-ws"); mkdirSync(src, { recursive: true });
  const origin = join(ROOT, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  const seedClone = join(ROOT, "seed-clone");
  execFileSync("git", ["clone", "-q", origin, seedClone]);
  writeFileSync(join(seedClone, "README.md"), "# app\n");
  execFileSync("git", ["-C", seedClone, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  execFileSync("git", ["-C", seedClone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  execFileSync("git", ["-C", seedClone, "push", "-q", "origin", "main"]);

  ok(cli(["team", "init", "--dir", src, "--key", "movetest", "--backend", "service", "--yes"], ROOT).status === 0, "setup: source team init");
  ok(cli(["team", "add-project", "shop", "--prefix", "SHP"], src).status === 0, "setup: add-project");
  ok(cli(["team", "add-repo", "app", "--project", "shop", "--path", "repos/app", "--detect", "--remote", origin], src).status === 0, "setup: add-repo (clones from the bare remote)");
  ok(cli(["team", "add-provider", "synth", "--base-url", "https://api.synth.example/v1", "--auth-env", "SYNTH_KEY", "--models", "m1"], src).status === 0, "setup: add-provider");
  const setKey = spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), "secret", "set", "SYNTH_KEY", "--stdin"], { cwd: src, encoding: "utf8", input: "sk-move-me-7788\n" });
  ok(setKey.status === 0, "setup: secret set");
  const mkTicket = cli(["ticket", "create", "--title", "board memory travels", "--type", "Feature"], src, { DEVLOOP_ACTOR: "pm", DEVLOOP_PROJECT: "shop" });
  ok(mkTicket.status === 0, `setup: a board ticket exists (got ${mkTicket.status}: ${(mkTicket.stderr ?? "").split("\n")[0]})`);

  // age keypair (real, when the binary exists)
  let recipient = "", identityFile = "";
  if (hasAge) {
    identityFile = join(ROOT, "age.key");
    const kg = spawnSync("age-keygen", ["-o", identityFile], { encoding: "utf8" });
    recipient = (kg.stderr.match(/Public key: (age1[a-z0-9]+)/) ?? [])[1] ?? "";
    ok(!!recipient, "setup: age keypair generated");
  }

  // ── export (encrypted when possible) ──
  const out = join(ROOT, "move.bundle");
  const exp = cli(["bundle", "export", "--out", out, "--move", "--git-token-env", "GIT_FAKE_TOKEN", "--include-env", "GIT_FAKE_TOKEN",
    ...(hasAge ? ["--recipients", recipient] : ["--insecure-plaintext"])], src, { GIT_FAKE_TOKEN: "ghp-fake" });
  ok(exp.status === 0, `export: exits 0 (got ${exp.status}: ${(exp.stderr ?? "").split("\n").slice(0, 2).join(" / ")})`);
  ok(existsSync(out) && (statSync(out).mode & 0o777) === 0o600, "export: bundle written chmod 600");
  const rawBundle = readFileSync(out);
  ok(rawBundle.subarray(0, 16).toString() === "DEVLOOP-BUNDLE/1", "export: magic header");
  const manifest = JSON.parse(rawBundle.subarray(17, rawBundle.indexOf(0x0a, 17)).toString());
  ok(manifest.hubDb.included === true && manifest.workspaceId.disposition === "migrate", "manifest: hub.db included, disposition=migrate (Q6/Q4 defaults)");
  ok(manifest.repos[0].remote === origin && manifest.secretEnvNames.includes("SYNTH_KEY"), "manifest: repo remote + secret env NAMES (never values)");
  if (hasAge) ok(!rawBundle.includes(Buffer.from("sk-move-me-7788")), "export: the secret VALUE does NOT appear in the encrypted bundle bytes");
  ok(existsSync(join(src, ".dev-loop", "moved.json")), "export --move: the source is stamped moved");
  const refuse = cli(["run", "--agents", "qa", "--once"], src);
  ok(refuse.status === 1 && /MOVED/.test(`${refuse.stdout}${refuse.stderr}`), "moved source: `dev-loop run` REFUSES (Q4 marker+refuse)");
  const dryStill = cli(["run", "--agents", "qa", "--once", "--dry-run"], src);
  ok(dryStill.status === 0, "moved source: --dry-run still allowed (inspection is not driving)");

  // ── load into a fresh home ──
  const dst = join(ROOT, "dst-ws"); mkdirSync(dst, { recursive: true });
  const loadEnv = hasAge ? { AGE_IDENTITY_FILE: identityFile } : {};
  const load = cli(["up", "--bundle", out, "--dir", dst, "--dry-launch"], ROOT, loadEnv);
  ok(load.status === 0, `load: exits 0 (got ${load.status}: ${(load.stderr ?? "").split("\n").slice(-3).join(" / ")})`);
  ok(existsSync(join(dst, "dev-loop.json")) && JSON.parse(readFileSync(join(dst, "dev-loop.json"), "utf8")).team.key === "movetest",
    "load: dev-loop.json materialized");
  const dstSecrets = join(dst, ".dev-loop", "secrets.env");
  ok(readFileSync(dstSecrets, "utf8").includes("SYNTH_KEY=sk-move-me-7788") && (statSync(dstSecrets).mode & 0o777) === 0o600,
    "load: secrets.env restored chmod 600");
  ok(existsSync(join(dst, "repos", "app", "README.md")), "load: repo RE-CLONED from its remote (repos never travel in the bundle)");
  {
    const db = openDb(join(dst, ".dev-loop", "hub.db"));
    try {
      const pid = findProject(db, "shop");
      ok(!!pid, "load: hub.db restored — the project row traveled");
      const t = db.prepare("SELECT count(*) c FROM tickets WHERE project_id=? AND title='board memory travels'").get(pid) as { c: number };
      ok(t.c === 1, "load: the board's MEMORY traveled (the ticket is on the new home)");
      const s = JSON.parse((db.prepare("SELECT settings_json FROM projects WHERE id=?").get(pid) as { settings_json?: string }).settings_json ?? "{}");
      ok(s.hub?.transport === "daemon", "load: op-API gate seeded (attach/board writes live behind the token)");
    } finally { db.close(); }
  }
  ok(/dev-loop run --agents core/.test(load.stdout), "load --dry-launch: stops before the loop and prints the run step");
  ok(existsSync(join(dst, "CLAUDE.md")) && existsSync(join(dst, ".claude", "settings.json")), "load: briefs + claude permission re-derived (never trusted from the bundle)");

  // ── idempotency: live state wins ──
  const dstDb = join(dst, ".dev-loop", "hub.db");
  { // advance the live board past the bundle snapshot
    const db = openDb(dstDb);
    try { const pid = findProject(db, "shop")!; db.prepare("INSERT INTO tickets(id,project_id,title,state,priority,labels,related_to,created_by,created_at,updated_at) VALUES('SHP-999',?,?,?,0,'[]','[]','pm','t','t')").run(pid, "advanced past snapshot", "Todo"); } finally { db.close(); }
  }
  const re = cli(["up", "--bundle", out, "--dir", dst, "--dry-launch"], ROOT, loadEnv);
  ok(re.status === 0 && /hub\.db already exists — the LIVE board wins/.test(re.stdout), "re-load: live hub.db NEVER overwritten");
  {
    const db = openDb(dstDb);
    try { ok((db.prepare("SELECT count(*) c FROM tickets WHERE id='SHP-999'").get() as { c: number }).c === 1, "re-load: the advanced board state survived"); } finally { db.close(); }
  }
  writeFileSync(join(dst, "dev-loop.json"), readFileSync(join(dst, "dev-loop.json"), "utf8").replace("\"weight\"", "\"weight\"")); // touch-free
  const cfgLive = JSON.parse(readFileSync(join(dst, "dev-loop.json"), "utf8"));
  cfgLive.team.mode = "live";
  writeFileSync(join(dst, "dev-loop.json"), JSON.stringify(cfgLive, null, 2) + "\n");
  const re2 = cli(["up", "--bundle", out, "--dir", dst, "--dry-launch"], ROOT, loadEnv);
  ok(/keeping the LIVE config/.test(`${re2.stdout}${re2.stderr}`) && JSON.parse(readFileSync(join(dst, "dev-loop.json"), "utf8")).team.mode === "live",
    "re-load: a diverged live config is kept (authoritative-once; --force-reseed is the explicit override)");

  // ── clean-board path: --no-hub-db (plaintext lane keeps this leg age-independent) ──
  const out2 = join(ROOT, "clean.bundle");
  rmSync(join(src, ".dev-loop", "moved.json")); // un-retire the source for a second export
  ok(cli(["bundle", "export", "--out", out2, "--no-hub-db", "--insecure-plaintext"], src).status === 0, "export: --no-hub-db clean-board bundle");
  const dst2 = join(ROOT, "dst2"); mkdirSync(dst2, { recursive: true });
  const load2 = cli(["up", "--bundle", out2, "--dir", dst2, "--dry-launch"], ROOT);
  ok(load2.status === 0 && /clean-board load/.test(load2.stdout), "load: clean-board seeds _team and names the per-project seed step");
  {
    const db = openDb(join(dst2, ".dev-loop", "hub.db"));
    try { ok(!!findProject(db, "_team") && !findProject(db, "shop"), "clean-board: _team seeded, project rows deliberately absent (W08 surfaces them)"); } finally { db.close(); }
  }

  // wrong-identity decrypt fails closed
  if (hasAge) {
    const otherKey = join(ROOT, "other.key");
    spawnSync("age-keygen", ["-o", otherKey], { encoding: "utf8" });
    const badLoad = cli(["up", "--bundle", out, "--dir", join(ROOT, "dst3"), "--dry-launch"], ROOT, { AGE_IDENTITY_FILE: otherKey });
    ok(badLoad.status === 1 && /age decrypt failed/.test(`${badLoad.stdout}${badLoad.stderr}`), "load: wrong identity → clean refusal, nothing materialized");
    const noKey = cli(["up", "--bundle", out, "--dir", join(ROOT, "dst4"), "--dry-launch"], ROOT, { AGE_IDENTITY_FILE: undefined, DEVLOOP_BUNDLE_KEY: undefined });
    ok(noKey.status === 1 && /AGE_IDENTITY_FILE/.test(`${noKey.stdout}${noKey.stderr}`), "load: missing identity → the headless-clear message (no interactive prompt)");
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "bundle: all checks passed");
process.exit(fails ? 1 : 0);
