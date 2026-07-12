// P4 documents: versioning, diff, optimistic-CAS CONFLICT, operator-publish gate,
// unpublished-draft fallback, per-project isolation — across distinct actor processes.
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

for (const c of [pm, reflect, operator, beta, dq, pmR, reflectR, operatorR, dArch]) await c.close();
console.log(fails === 0 ? "\nHUB_DOCS_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
