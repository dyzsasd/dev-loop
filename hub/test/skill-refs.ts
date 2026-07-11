// P4 [coverage]: SKILL → conventions §-reference integrity. A botched find/replace once rewrote
// the literal prefix "§1" into 'the conventions "Topology at a glance" table' across dev-agent and
// qa-agent (§19 → …table9, §12a → …table2a — 11 dangling references). This lint guards both
// directions: (a) every §<digits><letter?> cited by a root SKILL resolves to a numbered section
// heading that actually exists in references/conventions.md, and (b) the corruption pattern
// ('…glance" table' fused to a word character) never reappears. Root skills/ only — hub/skills/
// is build output copied from it (see hub/package.json `build`).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", ".."); // hub/test → repo root
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// Anchors: "## 12. Dry-run vs live", "### 12a. Autonomy — …" → "12", "12a".
const conventions = readFileSync(join(root, "references", "conventions.md"), "utf8");
const anchors = new Set<string>();
for (const line of conventions.split("\n")) {
  const h = /^#{2,3} (\d+[a-z]?)\. /.exec(line);
  if (h) anchors.add(h[1]);
}
ok(anchors.size >= 30, `conventions.md yields a full anchor set (${anchors.size} numbered sections)`);

const skillDirs = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((d) => d.isDirectory());
ok(skillDirs.length > 0, `skills/ has skill directories (${skillDirs.length})`);
for (const dir of skillDirs) {
  const body = readFileSync(join(root, "skills", dir.name, "SKILL.md"), "utf8");
  const dangling = [...body.matchAll(/§(\d+[a-z]?)/g)].map((m) => m[1]).filter((ref) => !anchors.has(ref));
  ok(dangling.length === 0, `skills/${dir.name}/SKILL.md: every §-reference resolves${dangling.length ? ` (dangling: ${[...new Set(dangling)].map((r) => "§" + r).join(", ")})` : ""}`);
  const corrupt = body.match(/Topology at a glance" table\w/g) ?? [];
  ok(corrupt.length === 0, `skills/${dir.name}/SKILL.md: no '…glance" table<char>' corruption${corrupt.length ? ` (${corrupt.length} hit(s))` : ""}`);
}

console.log(fails === 0 ? "\nSKILL_REFS_OK" : `\n${fails} CHECK(S) FAILED — a §-reference is dangling or corrupted`);
process.exit(fails === 0 ? 0 : 1);
