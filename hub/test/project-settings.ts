// LOOP-481 AC1/AC2 — `hub/src/project-settings.ts` is a LEAN LEAF, and stays one.
//
// The ticket's whole reason for existing is an import-graph constraint: `doctor` runs on every boot
// and needs `humanWriteEnabled`, but reaching it through `daemon.ts` would drag the daemon's graph
// (which reaches `zod` through the MCP tool definitions) into that path — the LOOP-58 shape. A
// comment saying "keep this lean" does not survive a future refactor; this suite measures it.
//
// Method, in the shape of the LOOP-58 run-agents load test: copy `hub/src` into a temp tree that has
// NO `node_modules`, and load the module there. Any bare specifier in the transitive graph fails to
// resolve, so the import throws — leanness becomes a load result rather than a code review.
//
// The control matters as much as the assertion. A harness that reported "lean" because it silently
// failed to run anything would look identical to a pass, so a witness module that imports `zod` is
// planted in the same tree and MUST fail. Without it, deleting node's resolution error (or pointing
// the harness at a tree that does have node_modules) would turn every arm green.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { humanWriteEnabled } from "../src/project-settings.ts";
import { openDb } from "../src/db.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(hubRoot, "..");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-project-settings-")));

try {
  // ── AC2 — the leaf loads from a tree with no node_modules ────────────────────────────────────
  // `src` only: no package.json from hub/, no node_modules anywhere up the chain from /tmp.
  const leanRoot = join(tmp, "lean");
  cpSync(join(hubRoot, "src"), join(leanRoot, "src"), { recursive: true });
  writeFileSync(join(leanRoot, "package.json"), JSON.stringify({ type: "module" })); // ESM for the copied .ts

  const loadInLeanTree = (rel: string) => {
    const r = spawnSync(
      "node",
      ["--input-type=module", "-e", `import(${JSON.stringify(join(leanRoot, rel))}).then(() => console.log("LOADED"))`],
      { encoding: "utf8", cwd: leanRoot },
    );
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  const leaf = loadInLeanTree("src/project-settings.ts");
  ok(leaf.code === 0 && /LOADED/.test(leaf.out),
    `AC2: project-settings.ts loads from a tree with NO node_modules — its graph reaches no package (exit ${leaf.code})${leaf.code === 0 ? "" : `\n${leaf.out.slice(0, 600)}`}`);

  // The control: same tree, same loader, a module that DOES reach a package. If this passes, the
  // harness cannot tell lean from fat and the assertion above proves nothing.
  writeFileSync(join(leanRoot, "src", "zz-fat-witness.ts"), `import { z } from "zod";\nexport const v = z;\n`);
  const witness = loadInLeanTree("src/zz-fat-witness.ts");
  ok(witness.code !== 0 && !/LOADED/.test(witness.out),
    `AC2 control: a module importing a package FAILS in the same tree, so the arm above is a real measurement, not a harness that loads nothing (exit ${witness.code})`);

  // ── AC1 — one definition, and doctor's path does not go through the daemon ───────────────────
  // Read as source text rather than by loading doctor.ts: what is asserted is which module the
  // symbol is imported FROM, and a successful load would not distinguish that.
  const doctorSrc = readFileSync(join(hubRoot, "src", "doctor.ts"), "utf8");
  const daemonSrc = readFileSync(join(hubRoot, "src", "daemon.ts"), "utf8");
  ok(/import\s*\{[^}]*\bhumanWriteEnabled\b[^}]*\}\s*from\s*"\.\/project-settings\.ts"/.test(doctorSrc),
    "AC1: doctor.ts imports humanWriteEnabled from the lean leaf");
  ok(/import\s*\{[^}]*\bhumanWriteEnabled\b[^}]*\}\s*from\s*"\.\/project-settings\.ts"/.test(daemonSrc),
    "AC1: daemon.ts imports it from the same leaf — one definition, two consumers");
  ok(!/from\s*"\.\/daemon\.ts"/.test(doctorSrc),
    "AC1: doctor.ts imports nothing from daemon.ts at all — the boot-path verb never pays for the server's graph");

  // No COPY of the predicate survives anywhere. The distinguishing string is the settings_json read
  // the gate IS (the optional-chained settings read below); a second one outside the leaf is LOOP-429.
  // Scanned off the filesystem rather than `git grep` on purpose — the latter searches TRACKED files,
  // so it would report "no copies" for a leaf that had not been `git add`ed yet: a pass for the wrong
  // reason, and exactly the state this file was first run in.
  // Assembled rather than written out, so this scanner does not match ITSELF on its own needle.
  // An exemption for this path would have worked too, but it would blind the check to a real copy
  // living here; concatenation keeps the scan total.
  const GATE_EXPR = "humanWrite?" + ".enabled";
  const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : scan(p);
    return e.isFile() && p.endsWith(".ts") && readFileSync(p, "utf8").includes(GATE_EXPR) ? [p] : [];
  });
  const copies = [...scan(join(hubRoot, "src")), ...scan(join(hubRoot, "test"))]
    .map((p) => p.slice(repoRoot.length + 1)).sort();
  ok(copies.length === 1 && copies[0] === "hub/src/project-settings.ts",
    `AC1: the gate expression exists in exactly ONE file — no copy drifted out (found: ${JSON.stringify(copies)})`);

  // ── The relocated predicate still behaves ────────────────────────────────────────────────────
  // Relocation is only safe if it is the SAME gate; assert the behaviour here so a move that also
  // changed semantics cannot pass on the import assertions alone.
  const db = openDb(join(tmp, "hub.db"));
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','loop','loop','t')").run();
  ok(humanWriteEnabled(db, "p") === false, "gate: absent settings_json ⇒ false (fails CLOSED)");
  db.prepare("UPDATE projects SET settings_json=? WHERE id='p'").run(JSON.stringify({ humanWrite: { enabled: true } }));
  ok(humanWriteEnabled(db, "p") === true, "gate: humanWrite.enabled true ⇒ true");
  db.prepare("UPDATE projects SET settings_json=? WHERE id='p'").run(JSON.stringify({ humanWrite: { enabled: "true" } }));
  ok(humanWriteEnabled(db, "p") === false, "gate: the STRING \"true\" is not permission — strict boolean only");
  db.prepare("UPDATE projects SET settings_json=? WHERE id='p'").run("{not json");
  ok(humanWriteEnabled(db, "p") === false, "gate: malformed settings_json ⇒ false, never a throw into a caller");
  ok(humanWriteEnabled(db, "no-such-project") === false, "gate: unknown project ⇒ false");
  db.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fails === 0 ? "\n✅ project-settings: all assertions passed" : `\n❌ project-settings: ${fails} assertion(s) failed`);
process.exit(fails === 0 ? 0 : 1);
