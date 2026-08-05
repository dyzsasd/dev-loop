// LOOP-97 — ONE search predicate, so the two surfaces cannot answer the same query differently.
//
//   axis                | web ?q= (before) | agent query (before)
//   --------------------|------------------|---------------------
//   ticket id           | yes              | NO
//   title               | yes              | yes
//   description         | first 5,000 only | full (uncapped)
//   COMMENT BODIES      | NO               | yes
//   multi-word          | one substring    | whitespace-split, AND-ed
//
// Both failure modes were SILENT: an empty result reads as "no such ticket", never as "this surface
// does not index that". A human searching a phrase that appears only in a comment got nothing; an
// agent searching a ticket id got nothing.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { ensureSeed, findProject } from "../src/seed.ts";
import { agentOp, type OpResult } from "../src/agentops.ts";
import { boardPage } from "../src/views/board.ts";
import { ticketSearchClause, SEARCH_DESC_CAP, SEARCH_CORPUS_LABEL } from "../src/ticket-search.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "dl-onesearch-")));
let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };

try {
  const db = openDb(join(tmp, "hub.db"));
  ensureSeed(db, "os", "One Search", "OS");
  const pid = findProject(db, "os")!;
  let n = 0;
  const mk = (title: string, description: string): string => {
    const id = `OS-${++n}`;
    db.prepare("INSERT INTO tickets(id,project_id,title,description,type,state,assignee,priority,labels,related_to,created_by,created_at,updated_at) VALUES(?,?,?,?,'Bug','Todo',null,2,'[]','[]','pm','t','t')")
      .run(id, pid, title, description);
    return id;
  };
  const comment = (ticketId: string, body: string) =>
    db.prepare("INSERT INTO comments(id,ticket_id,author,body,created_at) VALUES(?,?,'pm',?,'t')").run(`c-${ticketId}-${Math.random()}`, ticketId, body);

  const plain = mk("an ordinary ticket", "nothing special here");
  const commentOnly = mk("a ticket about nothing", "body says nothing either");
  comment(commentOnly, "review failed: the zephyrine handler regressed");
  const twoWords = mk("daemon health probe wiring", "the probe reaches the daemon");
  const decoy = mk("daemon only", "nothing else here at all"); // matches ONLY "daemon" — my first decoy said "no probe of any kind", which matches both terms
  const longTail = mk("a long one", "x".repeat(SEARCH_DESC_CAP + 500) + " needleBeyondCap");
  const pctLiteral = mk("percent case", "a literal 100% value");

  // list_issues returns a BARE ARRAY (okR(out)), not an { issues } envelope — the envelope shape is
  // opt-in via envelope:true. Reading the wrong shape silently yields [] and every assertion passes
  // for the wrong reason, which is how my first version of this file "passed".
  const agentQuery = (q: string): string[] =>
    ((agentOp("list_issues", db, pid, "os", "pm", { query: q }) as OpResult).body as { id: string }[]).map((t) => t.id);
  const webQuery = (q: string): string => boardPage(db, pid, "os", { q }, false);

  // ── the two SILENT failures the ticket exists for ────────────────────────────────────────────
  ok(agentQuery(commentOnly).includes(commentOnly),
    "LOOP-97: the agent path matches a TICKET ID — an agent searching for its own ticket id used to get nothing");
  ok(webQuery("zephyrine").includes(commentOnly),
    "LOOP-97: the web path matches a COMMENT BODY — a phrase appearing only in a comment used to return nothing");

  // …and the controls proving neither is vacuous.
  ok(!webQuery("zephyrine").includes(plain), "LOOP-97 control: …and does not match an unrelated ticket");
  ok(agentQuery("zephyrine").includes(commentOnly), "LOOP-97: the agent path still matches comments (unchanged)");
  ok(webQuery(commentOnly.toLowerCase()).includes(commentOnly), "LOOP-97: the web path still matches ids (unchanged)");

  // ── multi-word: split on whitespace, AND the terms ───────────────────────────────────────────
  const bothTerms = webQuery("daemon probe");
  ok(bothTerms.includes(twoWords), "LOOP-97: the web path splits on whitespace and ANDs the terms");
  ok(!bothTerms.includes(decoy),
    "LOOP-97: …and a ticket matching only ONE term is excluded — AND, not OR");
  ok(agentQuery("daemon probe").includes(twoWords) && !agentQuery("daemon probe").includes(decoy),
    "LOOP-97: the agent path behaves identically on the same query");

  // ── the description cap is ONE constant on BOTH paths ────────────────────────────────────────
  // Before: the web capped at 5,000 and the agent did not, so this exact ticket matched on one
  // surface and not the other with nothing saying why.
  ok(!agentQuery("needleBeyondCap").includes(longTail) && !webQuery("needleBeyondCap").includes(longTail),
    "LOOP-97: a match only BEYOND the cap misses on BOTH surfaces — identical behaviour, whichever way it is settled");
  ok(agentQuery("a long one").includes(longTail), "LOOP-97 control: …while the same ticket is still findable by title");

  // ── LIKE metacharacters stay literal on both paths ───────────────────────────────────────────
  ok(agentQuery("100%").includes(pctLiteral) && webQuery("100%").includes(pctLiteral),
    "LOOP-97: a literal % matches literally on both paths");
  ok(agentQuery("100%").length === 1,
    `LOOP-97: …and does NOT wildcard — escaping is preserved (matched ${agentQuery("100%").length})`);
  ok(agentQuery("nothing_special").length === 0,
    "LOOP-97: …proved by an underscore query that would match 'nothing special' if it wildcarded");

  // ── the predicate itself ─────────────────────────────────────────────────────────────────────
  ok(ticketSearchClause("") === null && ticketSearchClause("   ") === null && ticketSearchClause(undefined) === null,
    "LOOP-97: a blank query produces no clause at all — the caller adds nothing to its WHERE");
  {
    const c = ticketSearchClause("alpha beta")!;
    ok(c.binds.length === 8, `LOOP-97: two terms × four fields = eight binds (got ${c.binds.length})`);
    ok((c.sql.match(/EXISTS/g) ?? []).length === 2, "LOOP-97: …each term gets its own comment EXISTS");
    ok(c.sql.includes(String(SEARCH_DESC_CAP)), "LOOP-97: …and the one shared cap constant");
  }

  // ── AC: neither call site keeps a hand-rolled LIKE chain ─────────────────────────────────────
  {
    const agentops = readFileSync(join(here, "..", "src", "agentops.ts"), "utf8");
    const board = readFileSync(join(here, "..", "src", "views", "board.ts"), "utf8");
    const handRolled = /lower\((?:id|title)\) LIKE|title LIKE \? ESCAPE/;
    ok(!handRolled.test(agentops), "LOOP-97: agentops.ts has no hand-rolled LIKE chain left");
    ok(!handRolled.test(board), "LOOP-97: views/board.ts has no hand-rolled LIKE chain left");
    ok(agentops.includes("ticketSearchClause") && board.includes("ticketSearchClause"),
      "LOOP-97: …both build their WHERE from the shared helper");
  }

  // ── the input must not promise a narrower corpus than it delivers ────────────────────────────
  {
    const page = webQuery("");
    ok(page.includes(SEARCH_CORPUS_LABEL),
      `LOOP-97: the search input describes what is ACTUALLY searched ("${SEARCH_CORPUS_LABEL}")`);
    ok(!/search id \/ title \/ description"/.test(page),
      "LOOP-97: …and no longer omits comments from that promise");
  }
  db.close();
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nONE_SEARCH_OK");
process.exit(fails ? 1 : 0);
