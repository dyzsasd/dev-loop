// One-click Q1 — the two first-class mutators. `team add-provider` (E16-validated write + opencode.json
// sync + the secret-set pointer) and `dev-loop secret set|list|unset` (stdin path; hidden-prompt is the
// same write path behind a TTY read). Also the upsert/remove line-editors' comment/order preservation.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { upsertSecretLine, removeSecretLine } from "../src/secret-cli.ts";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── unit: the line editors preserve operator content ────────────────────────
{
  const orig = "# comms\nDEVLOOP_COMMS_WEBHOOK=https://hooks.example/x\n\nexport OLD_KEY=abc\n";
  const up = upsertSecretLine(orig, "NEW_KEY", "v1");
  ok(up.includes("# comms\n") && up.includes("DEVLOOP_COMMS_WEBHOOK=https://hooks.example/x") && up.includes("NEW_KEY=v1"),
    "upsert: appends a new key, preserves comments + existing lines");
  const up2 = upsertSecretLine(up, "OLD_KEY", "def");
  ok(up2.includes("OLD_KEY=def") && !up2.includes("export OLD_KEY=abc"), "upsert: replaces an existing (export-prefixed) key in place");
  ok((up2.match(/OLD_KEY=/g) ?? []).length === 1, "upsert: never duplicates a key");
  const rm = removeSecretLine(up2, "NEW_KEY");
  ok(rm.removed && !rm.content.includes("NEW_KEY") && rm.content.includes("# comms"), "remove: drops exactly the one line");
  ok(!removeSecretLine("A=1\n", "B").removed, "remove: absent key reports removed:false");
}

// ── e2e in a scratch workspace ──────────────────────────────────────────────
const ROOT = mkdtempSync(join(tmpdir(), "dl-secret-provider-"));
try {
  const ws = join(ROOT, "ws");
  mkdirSync(ws, { recursive: true });
  const cli = (args: string[], opts: { input?: string } = {}) =>
    spawnSync(process.execPath, [join(hubRoot, "src", "cli.ts"), ...args], { cwd: ws, encoding: "utf8", input: opts.input });
  ok(cli(["team", "init", "--dir", ws, "--key", "sec", "--backend", "service", "--yes"]).status === 0, "setup: team init");

  // add-provider
  const ap = cli(["team", "add-provider", "synth", "--base-url", "https://api.synth.example/v1", "--auth-env", "SYNTH_KEY", "--models", "m1, m2"]);
  ok(ap.status === 0 && /provider 'synth' registered \(2 models\)/.test(ap.stdout), `add-provider: registers (got ${ap.stdout.split("\n")[0]})`);
  ok(/launch strings: synth\/m1, synth\/m2/.test(ap.stdout), "add-provider: prints the agents{}.model launch strings");
  ok(/next: dev-loop secret set SYNTH_KEY/.test(ap.stdout), "add-provider: points at secret set when the env is unresolvable");
  const cfg = JSON.parse(readFileSync(join(ws, "dev-loop.json"), "utf8"));
  ok(cfg.team.providers.synth.kind === "openai-compatible" && cfg.team.providers.synth.authTokenEnv === "SYNTH_KEY",
    "add-provider: E16-shaped entry landed in dev-loop.json");
  const oc = JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8"));
  ok(oc.provider.synth.options.apiKey === "{env:SYNTH_KEY}", "add-provider: opencode.json synced in the same verb");
  ok(cli(["team", "add-provider", "synth", "--base-url", "https://x.example", "--auth-env", "X_K", "--models", "m"]).status === 1,
    "add-provider: duplicate id refused without --force");
  const bad = cli(["team", "add-provider", "bad", "--base-url", "https://x.example", "--auth-env", "https://leak", "--models", "m"]);
  ok(bad.status === 1 && /E16/.test(`${bad.stdout}${bad.stderr}`), "add-provider: a URL in --auth-env is rejected by E16 re-validation (§16)");

  // secret set/list/unset (stdin path — the hidden prompt shares the write path)
  writeFileSync(join(ws, ".dev-loop", "secrets.env"), "# operator comment\nEXISTING=keep\n");
  const st = cli(["secret", "set", "SYNTH_KEY", "--stdin"], { input: "sk-test-value\n" });
  ok(st.status === 0 && /SYNTH_KEY saved/.test(st.stdout) && !/sk-test-value/.test(`${st.stdout}${st.stderr}`),
    "secret set: stores from stdin and NEVER echoes the value");
  const senv = readFileSync(join(ws, ".dev-loop", "secrets.env"), "utf8");
  ok(senv.includes("SYNTH_KEY=sk-test-value") && senv.includes("# operator comment") && senv.includes("EXISTING=keep"),
    "secret set: line-level upsert preserved the operator's file");
  ok((statSync(join(ws, ".dev-loop", "secrets.env")).mode & 0o777) === 0o600, "secret set: secrets.env is chmod 600");
  ok(cli(["secret", "set", "lower_case", "--stdin"], { input: "x\n" }).status === 2, "secret set: a non-ENV-NAME is refused");
  const ls = cli(["secret", "list"]);
  ok(ls.status === 0 && /SYNTH_KEY/.test(ls.stdout) && !/sk-test-value/.test(ls.stdout), "secret list: names only, never values");
  ok(cli(["secret", "unset", "SYNTH_KEY"]).status === 0 && !readFileSync(join(ws, ".dev-loop", "secrets.env"), "utf8").includes("SYNTH_KEY"),
    "secret unset: removes the line");

  // doctor W13 closes the loop: set the key again → resolvable via secrets.env
  cli(["secret", "set", "SYNTH_KEY", "--stdin"], { input: "sk-live\n" });
  const doc = cli(["doctor"]);
  ok(/provider 'synth' auth SYNTH_KEY resolvable \(secrets\.env\)/.test(`${doc.stdout}${doc.stderr}`),
    "doctor: W13 reports the add-provider + secret set pair resolvable");
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(fails ? `${fails} CHECK(S) FAILED` : "secret-provider: all checks passed");
process.exit(fails ? 1 : 0);
