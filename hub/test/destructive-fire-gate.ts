// destructive-fire-gate.ts — LOOP-368. Every caller of destructive-guard refuses inside a fire.
//
// LOOP-367 added the question "may a FIRE destroy this at all?" to `board restore`. Three other verbs
// call the same gate and kept asking only "did you mean THIS target?", answered by a naming token —
// and one of them, `team remove-project`, is the verb that cascade-deleted 301 tickets from the live
// board on 2026-08-04. The token is not the wrong question; it is the SECOND question.
//
// This suite is deliberately BINDING rather than four independent per-verb tests (AC6). It discovers
// the gate's callers FROM THE SOURCE and requires every one of them to have a case here. A fifth
// destructive verb that imports the gate is covered the moment it is written; if it is added without
// a case, this suite goes red and names it. What it cannot see is a verb that destroys operator data
// WITHOUT importing the gate — that residual gap is stated in destructive-guard.ts's docstring and
// asserted below (AC7), because a promise of coverage is worth less than an honest boundary.
//
// Never run against a real workspace: every fixture is a mkdtemp throwaway with its own hub.db, and
// the markers are set explicitly per arm on top of a scrubbed env.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolationVerdict, workspaceIsolationVerdict, confirmationToken, FIRE_MARKERS } from "../src/destructive-guard.ts";
import type { Workspace } from "../src/team-config.ts";
import { scrubFireEnv } from "./env-scrub.ts"; // LOOP-193: fire markers reach a fixture only when an arm sets them

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(hubRoot, "src");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "dl-fire-gate-")));
const HOME = join(ROOT, "home");
const MARKERS = ["DEVLOOP_DEV_SPLIT", "DEVLOOP_TEAM_SCOPE"] as const;
const noFire = () => ({ ...scrubFireEnv(), DEVLOOP_HOME: HOME }) as NodeJS.ProcessEnv;
const inFire = (marker: string) => ({ ...noFire(), [marker]: "1" }) as NodeJS.ProcessEnv;

/** Run the CLI. `timeout` is a safety net: if a gate ever FAILS to refuse, `up --bundle` would go on
 *  to launch a console and hang the suite instead of failing it. */
const cli = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
  const r = spawnSync("node", [join(SRC, "cli.ts"), ...args], { cwd, env, encoding: "utf8", timeout: 90_000 });
  // `stdout` is kept separate from the combined stream: node's type-stripping ExperimentalWarning and
  // doctor's W-codes go to stderr, so a verb whose CONTRACT is "prints the path it wrote" can only be
  // read off stdout. Reading the last line of the combined stream gets a warning instead.
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
};

try {
  // ══ 1. The gate itself: the fire question is answered FIRST, and nothing answers it back ════════
  //
  // Every assertion here runs with the naming TOKEN present. A guard that only holds when the caller
  // forgot the token is not a guard — the 2026-08-06 fire supplied the token 39 seconds after the
  // refusal named it.
  {
    const wsOf = (projects: Record<string, { scratch?: boolean }>) =>
      ({ file: { projects, team: { key: "wskey" } } } as unknown as Workspace);
    const tok = confirmationToken("p");

    for (const marker of MARKERS) {
      const env = { [marker]: "1" } as NodeJS.ProcessEnv;
      const withToken = isolationVerdict(wsOf({ p: {} }), "p", [tok], env);
      ok(withToken.refusal !== null && withToken.fireMarker === marker,
        `AC2 (${marker}): isolationVerdict refuses inside a fire even WITH the exact naming token`);
      ok(withToken.tokenPresent === true,
        `AC2 (${marker}): …and it is not refusing because it failed to see the token — tokenPresent is true`);
      ok((withToken.refusal ?? "").includes(marker),
        `AC2 (${marker}): …and the refusal names the marker it saw`);
      ok(/does NOT grant this|no bypass/.test(withToken.refusal ?? ""),
        `AC2 (${marker}): …and states that the token does not override it`);
      ok(!new RegExp(`pass ${tok}`).test(withToken.refusal ?? ""),
        `AC2 (${marker}): …and never offers the token as the remedy — naming a bypass to the gated party is the LOOP-367 failure`);

      // scratch is the gate's discriminator for the TOKEN question. It is not an answer to this one:
      // `team repair --reap`'s candidates are scratch by definition, so a scratch exemption would
      // leave that verb entirely ungated.
      ok(isolationVerdict(wsOf({ p: { scratch: true } }), "p", [], env).refusal !== null,
        `AC2 (${marker}): …and scratch:true does not satisfy it either`);

      const wv = workspaceIsolationVerdict(wsOf({}), [confirmationToken("wskey")], env);
      ok(wv.refusal !== null && wv.fireMarker === marker && wv.tokenPresent === true,
        `AC1 (${marker}): workspaceIsolationVerdict asks the SAME question — one definition, both verdicts`);
    }

    // AC4 control: with no marker, both verdicts behave exactly as before.
    ok(isolationVerdict(wsOf({ p: {} }), "p", [tok], {}).refusal === null,
      "AC4: no marker — the token still allows a non-scratch project");
    ok(isolationVerdict(wsOf({ p: { scratch: true } }), "p", [], {}).refusal === null,
      "AC4: no marker — scratch:true still passes tokenless (the gate is still a gate, not a wall)");
    ok(isolationVerdict(wsOf({ p: {} }), "p", [], {}).refusal !== null,
      "AC4: no marker — a non-scratch project with no token is still refused, for the ORIGINAL reason");
    ok(isolationVerdict(wsOf({ p: {} }), "p", [], {}).fireMarker === null,
      "AC4: …and that refusal is not mislabelled as a fire refusal");
    ok(workspaceIsolationVerdict(wsOf({}), [confirmationToken("wskey")], {}).refusal === null,
      "AC4: no marker — the workspace token still clears --force-reseed");

    // The suppressor is the ABSENCE of a marker (LOOP-367): an EMPTY value is not a fire, or every
    // caller with a stale exported empty var silently loses the verb.
    ok(isolationVerdict(wsOf({ p: {} }), "p", [tok], { DEVLOOP_DEV_SPLIT: "" }).refusal === null,
      "AC4: an EMPTY marker is not a fire — the operator keeps the verb");

    // The marker list has ONE definition, and this suite covers all of it. A marker added to
    // FIRE_MARKERS without an arm here would leave the new one untested.
    ok(FIRE_MARKERS.length === MARKERS.length && FIRE_MARKERS.every((m) => (MARKERS as readonly string[]).includes(m)),
      `AC6: every marker in FIRE_MARKERS has an arm in this suite (${FIRE_MARKERS.join(", ")})`);
  }

  // ══ 2. AC6 — the caller inventory, discovered from source and BOUND to the cases below ══════════
  // Discovery is "imports the module AND CALLS a verdict function", read off the code with comments
  // stripped. Both halves of that were learned the hard way, in this order:
  //
  //  1. A named-import regex misses `import * as dg from "./destructive-guard.ts"` + `dg.isolationVerdict(…)`.
  //     A caller invisible to the inventory is the one failure this suite must not have, so the match
  //     was loosened to "names a verdict anywhere".
  //  2. That immediately over-matched `up.ts`, which imports TOKEN_PREFIX and mentions
  //     `workspaceIsolationVerdict` in a COMMENT explaining who consumes the token. It calls nothing.
  //     This is LOOP-372's defect exactly — an unanchored body scan making anything that *mentions* a
  //     thing into an instance of it — reproduced inside the test written to bind a different gate.
  //
  // So: strip comments, then require a CALL. The set-equality assertion below is what caught (2); a
  // subset check would have shipped it.
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");   // [^:] keeps `https://` intact
  const IMPORTS_GATE = (s: string) => {
    const code = stripComments(s);
    return /from\s*"\.\/destructive-guard\.ts"/.test(code)
      && /\b(?:isolationVerdict|workspaceIsolationVerdict)\s*\(/.test(code);
  };
  const gateCallers = readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && f !== "destructive-guard.ts")
    .filter((f) => IMPORTS_GATE(readFileSync(join(SRC, f), "utf8")))
    .sort();

  // Each case is one verb that reaches the gate, with the fixture state that must survive a refusal.
  // `survives()` is a per-case fingerprint rather than one shared rule, because the four verbs
  // threaten different bytes — and one of them (repair) legitimately rewrites hub.db while refusing.
  // Every case is expected to exit 4, the documented identity/guard code.
  interface Case { verb: string; argv: () => string[]; cwd: () => string; survives: () => string }
  const CASES: Record<string, Case> = {} as Record<string, Case>;

  // ── fixture A: a workspace with a real project, a scratch reap candidate, and a board snapshot ──
  const ws = join(ROOT, "ws");
  mkdirSync(HOME, { recursive: true });
  cli(["team", "init", "--dir", ws, "--key", "firegate", "--backend", "service"], ROOT, noFire());
  cli(["team", "add-project", "real", "--prefix", "REAL"], ws, noFire());
  cli(["team", "add-project", "disposable", "--prefix", "DISP", "--scratch"], ws, noFire());
  const wsCfg = join(ws, "dev-loop.json");
  const wsDb = join(ws, ".dev-loop", "hub.db");
  ok(existsSync(wsCfg) && JSON.parse(readFileSync(wsCfg, "utf8")).projects.disposable?.scratch === true,
    "fixture: the workspace has a real project and a scratch 0-ticket 0-repo reap candidate");

  const snapOut = cli(["board", "snapshot", "--reason", "manual"], ws, noFire());
  const snapPath = snapOut.stdout.trim().split("\n").pop() ?? "";
  ok(snapOut.code === 0 && existsSync(snapPath), `fixture: a board snapshot exists for the restore case (${snapOut.code})`);

  // ── fixture B: a populated live workspace + a bundle to reseed it from ──
  const bws = join(ROOT, "bundle-src");
  cli(["team", "init", "--dir", bws, "--key", "bundlews", "--backend", "service"], ROOT, noFire());
  const bundleFile = join(ROOT, "fixture.dlb");
  const exported = cli(["bundle", "export", "--out", bundleFile, "--insecure-plaintext"], bws, noFire());
  ok(exported.code === 0 && existsSync(bundleFile), `fixture: a plaintext bundle was exported (${exported.code})`);
  const live = join(ROOT, "live-ws");
  mkdirSync(live, { recursive: true });
  cli(["up", "--bundle", bundleFile, "--dir", live, "--dry-launch"], ROOT, noFire());
  const liveSecrets = join(live, ".dev-loop", "secrets.env");
  writeFileSync(liveSecrets, "LOCAL_ONLY_KEY=fixture-value-not-a-credential\n", { mode: 0o600 });
  ok(existsSync(join(live, "dev-loop.json")), "fixture: a populated live workspace exists for --force-reseed to threaten");

  CASES["team-edit.ts"] = {
    verb: "team remove-project (the 2026-08-04 verb)",
    argv: () => ["team", "remove-project", "real", "--force", confirmationToken("real")],
    cwd: () => ws,
    survives: () => `${readFileSync(wsCfg, "utf8")}|${readFileSync(wsDb).length}`,
  };
  CASES["team-repair.ts"] = {
    verb: "team repair --reap",
    argv: () => ["team", "repair", "--reap"],
    cwd: () => ws,
    // The reap's damage is a DELETED config key + its db rows; the config bytes carry that. hub.db
    // bytes cannot be used here — the benign half truncates the WAL, which legitimately rewrites it.
    survives: () => readFileSync(wsCfg, "utf8"),
  };
  CASES["bundle.ts"] = {
    verb: "up --bundle --force-reseed",
    argv: () => ["up", "--bundle", bundleFile, "--dir", live, "--force-reseed", confirmationToken("bundlews")],
    cwd: () => ROOT,
    survives: () => `${readFileSync(join(live, "dev-loop.json"), "utf8")}|${readFileSync(liveSecrets, "utf8")}`,
  };
  CASES["board.ts"] = {
    verb: "board restore (LOOP-367's own — asserted here as a CALLER, not re-implemented)",
    argv: () => ["board", "restore", "--from", snapPath, confirmationToken("firegate")],
    cwd: () => ws,
    survives: () => readFileSync(wsDb).toString("base64"),
  };

  const mapped = Object.keys(CASES).sort();
  ok(JSON.stringify(gateCallers) === JSON.stringify(mapped),
    `AC6: the gate's callers discovered from source are exactly the cases asserted here — discovered [${gateCallers.join(", ")}], cased [${mapped.join(", ")}]`);
  ok(gateCallers.length === 4, `AC6: …and there are ${gateCallers.length} of them (a change to this number is a deliberate act, not a drift)`);
  // The discovery must be able to MISS something, or the equality above is vacuous.
  ok(!IMPORTS_GATE(`import { activeFireMarker } from "./destructive-guard.ts";`),
    "AC6: the discovery does not count a file that imports the module WITHOUT a verdict function (cli-agentops.ts)");
  ok(IMPORTS_GATE(`import { confirmationToken, isolationVerdict, commitBothHalves } from "./destructive-guard.ts";\nconst v = isolationVerdict(ws, key, rest);`),
    "AC6: …and does count one that imports a verdict among other names and calls it");
  ok(IMPORTS_GATE(`import * as dg from "./destructive-guard.ts";\nconst v = dg.workspaceIsolationVerdict(ws, argv);`),
    "AC6: …and does count a NAMESPACE import — a caller the inventory cannot see is the one failure this suite must not have");
  ok(!IMPORTS_GATE(`// mentions isolationVerdict in prose but imports nothing`),
    "AC6: …and does not count prose that merely names a verdict without importing the module");
  // up.ts's exact shape: it imports TOKEN_PREFIX and explains in a comment who consumes the token.
  // Counting it would be LOOP-372's over-match — a mention read as an instance.
  ok(!IMPORTS_GATE(`import { TOKEN_PREFIX } from "./destructive-guard.ts";\n// settled by \`workspaceIsolationVerdict\`'s exact match\nconst x = 1;`),
    "AC6: …and does not count a file that imports the module and only MENTIONS a verdict in a comment (up.ts)");
  ok(!IMPORTS_GATE(`import { isolationVerdict } from "./destructive-guard.ts";\n/* isolationVerdict(a, b) inside a block comment */`),
    "AC6: …and a call inside a BLOCK comment is prose too — the scan reads code, not commentary");

  // ══ 3. Every caller CONSUMES the verdict's refusal ══════════════════════════════════════════════
  // The inheritance in AC1 is only real if the caller acts on `refusal`. A caller that read only
  // `scratch`/`tokenPresent` would import the gate and silently opt out of the fire question.
  for (const f of gateCallers)
    ok(/\.refusal/.test(readFileSync(join(SRC, f), "utf8")),
      `AC1: ${f} consumes verdict.refusal — so it inherits the fire question rather than re-spelling it`);

  // ══ 4. End-to-end: each caller refuses inside a fire, WITH the token, and destroys nothing ══════
  for (const marker of MARKERS) {
    for (const [file, c] of Object.entries(CASES)) {
      const before = c.survives();
      const r = cli(c.argv(), c.cwd(), inFire(marker));
      ok(r.code === 4, `AC6 (${marker}) ${file}: \`${c.verb}\` WITH the naming token exits 4 inside a fire (got ${r.code}) ${r.out.slice(-160).replace(/\n/g, " ")}`);
      // The exit code alone does NOT discriminate: `--force-reseed` also exits 4 when the bundle
      // would drop a live secret key, so a fire arm asserting only `code === 4` stays green with the
      // fire gate removed. Measured — it is why this line exists. The refusal must be THIS one.
      ok(/refusing inside an agent fire/.test(r.out),
        `AC6 (${marker}) ${file}: …and it is the FIRE refusal that stopped it, not some other guard that also exits 4`);
      ok(r.out.includes(marker), `AC6 (${marker}) ${file}: …and the refusal names the marker that triggered it`);
      ok(c.survives() === before, `AC6 (${marker}) ${file}: …and the data it would have destroyed is byte-identical afterwards`);
    }
  }

  // ══ 5. AC5 — the previews report the SAME verdict the live path enforces ════════════════════════
  {
    const prev = cli(["team", "remove-project", "real", "--dry-run", "--force", confirmationToken("real")], ws, inFire("DEVLOOP_DEV_SPLIT"));
    ok(/WOULD REFUSE/.test(prev.out) && /DEVLOOP_DEV_SPLIT/.test(prev.out),
      `AC5: remove-project --dry-run previews the FIRE refusal, naming the marker (${prev.out.slice(-160).replace(/\n/g, " ")})`);
    ok(!/needs --i-understand-this-deletes-real/.test(prev.out),
      "AC5: …and does NOT tell the fire that a token is what it needs — the preview cannot hand out a bypass the live path refuses");
    // The preview prints TWO lines about the gate — the `isolation :` fact line and the `→ WOULD
    // REFUSE` verdict line — and they are rendered separately. Asserted separately for that reason:
    // with only the verdict line asserted, reverting the fact line to "NOT scratch — needs <token>"
    // left every assertion green (measured), which is a preview still handing out the bypass.
    ok(/isolation : REFUSED — inside an agent fire/.test(prev.out),
      `AC5: …and the preview's isolation FACT line says the same thing as its verdict line (${prev.out.split("\n").find((l) => l.includes("isolation :")) ?? "no isolation line"})`);

    const bprev = cli(["up", "--bundle", bundleFile, "--dir", live, "--force-reseed", "--dry-launch"], ROOT, inFire("DEVLOOP_DEV_SPLIT"));
    ok(/REFUSED/.test(bprev.out) && /DEVLOOP_DEV_SPLIT/.test(bprev.out),
      `AC5: --force-reseed --dry-launch previews the fire refusal from the same verdict (${bprev.out.slice(-160).replace(/\n/g, " ")})`);

    const rprev = cli(["team", "repair", "--reap", "--dry-run"], ws, inFire("DEVLOOP_DEV_SPLIT"));
    ok(rprev.code === 0 && /DEVLOOP_DEV_SPLIT/.test(rprev.out),
      `AC5: team repair --reap --dry-run reports the refusal but stays 0 — a preview is not a failure (${rprev.code})`);
  }

  // ══ 6. AC3 — team repair's BENIGN half keeps working inside a fire ══════════════════════════════
  // /dev-loop:sync-repo runs `team repair` without --reap. If the refusal sat at verb entry, that
  // would break for every fire, and this ticket would have traded one hazard for a daily one.
  {
    const cfgBefore = readFileSync(wsCfg, "utf8");
    const benign = cli(["team", "repair"], ws, inFire("DEVLOOP_DEV_SPLIT"));
    ok(benign.code === 0, `AC3: \`team repair\` WITHOUT --reap completes normally inside a fire (code ${benign.code}) ${benign.out.slice(-160).replace(/\n/g, " ")}`);
    ok(/REPAIR_OK/.test(benign.out), "AC3: …and reports its normal completion line, so the non-destructive fixups all ran");
    ok(readFileSync(wsCfg, "utf8") === cfgBefore, "AC3: …and the scratch project is still there — the reap did not happen");
  }

  // ══ 7. AC7 — the module states the boundary this suite actually enforces ════════════════════════
  {
    const src = readFileSync(join(SRC, "destructive-guard.ts"), "utf8");
    ok(/callers of this module/i.test(src),
      "AC7: the module records that the enforced inventory is 'callers of this module'");
    ok(/uncovered, by construction/i.test(src),
      "AC7: …and that a destructive verb which does NOT import it is uncovered — an honest boundary, not an implied guarantee");
    ok(/destructive-fire-gate\.ts/.test(src),
      "AC7: …and names the suite that enforces the claim, so the docstring and the test cannot drift apart silently");
  }

  // ══ 8. AC4 — with the markers cleared, every verb behaves exactly as today ══════════════════════
  // Runs LAST: these arms genuinely destroy the fixture, which is the proof that the arms above were
  // refused by the gate and not by a broken fixture.
  {
    const reap = cli(["team", "repair", "--reap"], ws, noFire());
    ok(reap.code === 0 && !JSON.parse(readFileSync(wsCfg, "utf8")).projects.disposable,
      `AC4: markers cleared — \`team repair --reap\` reaps the scratch project as it always has (code ${reap.code})`);

    const rm = cli(["team", "remove-project", "real", "--force", confirmationToken("real")], ws, noFire());
    ok(rm.code === 0 && !JSON.parse(readFileSync(wsCfg, "utf8")).projects.real,
      `AC4: markers cleared — \`team remove-project\` with its token removes the project (code ${rm.code}) ${rm.out.slice(-140).replace(/\n/g, " ")}`);

    const restore = cli(["board", "restore", "--from", snapPath, confirmationToken("firegate")], ws, noFire());
    ok(restore.code === 0 && /restored \d+ ticket/.test(restore.out),
      `AC4: markers cleared — \`board restore\` with its token restores (code ${restore.code}) ${restore.out.slice(-140).replace(/\n/g, " ")}`);

    // Asserted on the POSITIVE signal, not on the absence of "REFUSED". `up` used to die at argv
    // parsing on the token itself ("unknown option"), and an absence-of-REFUSED assertion is green
    // for that too — it cannot tell "the token cleared the gate" from "the token never reached it".
    // That is exactly how the defect survived LOOP-316's own arm.
    const reseed = cli(["up", "--bundle", bundleFile, "--dir", live, "--force-reseed", confirmationToken("bundlews"), "--dry-launch"], ROOT, noFire());
    ok(/allowed \(token present\)/.test(reseed.out),
      `AC4: markers cleared — \`--force-reseed\` with its token clears the isolation gate, and SAYS so (${reseed.out.slice(-160).replace(/\n/g, " ")})`);
    ok(!/unknown option/.test(reseed.out),
      "AC4: …and the token parses at all — a refusal whose named remedy the CLI rejects is a gate with no key");
    ok(!reseed.out.includes("fixture-value-not-a-credential"),
      "§16: a secret VALUE never appears in any output this suite produces");

    // The linchpin of the whole design, asserted rather than assumed: `dev-loop up` DELETES both
    // markers before exec'ing the operator console, so "no marker" is precisely "not a fire" — a
    // suppressor a fire cannot arrange for itself. If this ever regressed, the operator's own console
    // would be gated as a fire and every verb above would become unreachable for the one caller
    // entitled to run it. Measured on the launch `up` reports, not on the source.
    const console_ = cli(["up", "--dir", ws, "--dry-launch"], ws, inFire("DEVLOOP_DEV_SPLIT"));
    const removed = /"envRemoved":\s*\[([^\]]*)\]/.exec(console_.stdout)?.[1] ?? "";
    ok(FIRE_MARKERS.every((m) => removed.includes(m)),
      `AC4: the operator console path is unmoved — 'up' still strips every fire marker before launching it (envRemoved: ${removed.replace(/\s+/g, " ").trim() || "ABSENT"})`);
  }

  console.log(fails === 0 ? "\nDESTRUCTIVE_FIRE_GATE_OK" : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
} finally {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
}
