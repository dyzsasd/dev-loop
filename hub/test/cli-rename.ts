// LOOP-181 — CLI rename Phase A guard: the `kaizen` bin exists everywhere, the npm package name is
// frozen (brand ≠ engine), and NO command-shaped prose has flipped to `kaizen` yet — Phase B (LOOP-182,
// blocked on this) owns the ~176 prose occurrences. See LOOP-174's operator amendment for the phasing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hubRoot = join(dirname(fileURLToPath(import.meta.url)), ".."); // hub/
const repoRoot = join(hubRoot, "..");
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

const pkg = JSON.parse(readFileSync(join(hubRoot, "package.json"), "utf8")) as { name: string; bin: Record<string, string> };

// ── AC: the npm package name is byte-frozen. The brand is "Kaizen Factory"; the engine — package name,
//        env, config filenames, branch prefixes — stays `dev-loop`. Only the user-typed COMMAND renames. ──
ok(pkg.name === "@dyzsasd/dev-loop", `package name is unchanged (@dyzsasd/dev-loop), got ${JSON.stringify(pkg.name)}`);

// ── AC: the bin map ships all four names alongside each other. kaizen ≡ dev-loop and kaizen-hub ≡
//        dev-loop-hub map to the SAME entrypoint, so `kaizen --version` and `dev-loop --version` agree by
//        construction (there is no second version to drift). `dev-loop` is a permanent, never-removed alias. ──
ok(pkg.bin?.["dev-loop"] === "dist/cli.js", "bin: dev-loop → dist/cli.js (the permanent alias)");
ok(pkg.bin?.["dev-loop-hub"] === "dist/server.js", "bin: dev-loop-hub → dist/server.js");
ok(pkg.bin?.["kaizen"] === "dist/cli.js", "bin: kaizen → dist/cli.js");
ok(pkg.bin?.["kaizen-hub"] === "dist/server.js", "bin: kaizen-hub → dist/server.js");
ok(pkg.bin?.["kaizen"] === pkg.bin?.["dev-loop"] && pkg.bin?.["kaizen-hub"] === pkg.bin?.["dev-loop-hub"],
  "kaizen and dev-loop resolve to identical entrypoints (their --version output agrees by construction)");

// ── AC: NO command-shaped `kaizen …` prose in references/ or skills/ — Phase A leaves prose untouched;
//        Phase B flips it. A command is `kaizen ` followed by a subcommand letter or a `-`flag; this
//        deliberately does NOT match a future brand mention ("Kaizen Factory", capital) or the etymology
//        ("kaizen 改善", CJK after the space). grep exits 1 (no match) in the clean Phase-A state. ──
const proseRoots = ["references", "skills"].map((d) => join(repoRoot, d));
let matches = "";
try {
  matches = execFileSync("grep", ["-rInE", "kaizen [a-z-]", ...proseRoots], { encoding: "utf8" });
} catch (e) {
  const status = (e as { status?: number }).status;
  if (status === 1) matches = ""; // grep: no matches — the expected Phase-A state
  else throw e;                   // grep: a real error (unreadable path, usage) — never swallow it
}
const hits = matches.split("\n").filter((l) => l.trim().length > 0);
ok(hits.length === 0,
  `no command-shaped \`kaizen …\` prose in references/ + skills/ (Phase B owns prose); found ${hits.length}` +
  (hits.length ? ":\n  " + hits.slice(0, 8).join("\n  ") : ""));

console.log(fails === 0 ? "\nCLI_RENAME_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
