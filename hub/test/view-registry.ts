// F1 — the typed view-route registry seam (src/views/registry.ts). The daemon e2e suite
// (test/daemon.ts) proves every page renders byte-identically over HTTP; this unit test pins the
// registry CONTRACT the D2 multi-project routing builds on: the route table covers every HTML page,
// the pattern grammar captures RAW (still percent-encoded) segments, GET implies HEAD (node strips
// the body), and non-view methods/paths never match (they fall through to the daemon's own routes).
import { VIEW_ROUTES, matchViewRoute } from "../src/views/registry.ts";
import { href } from "../src/views/ui.ts";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "✅ " : "❌ ") + m); if (!c) fails++; };
const seg = (p: string) => p.split("/").filter(Boolean); // the daemon's normalization (trailing slashes pre-stripped)

// the table: one entry per HTML page, GET-only (F4/D3 added the docs system: /docs index, /doc/:slug
// viewer, history, diff; /roadmap stays as a 302 onto the roadmap doc page)
const patterns = VIEW_ROUTES.map((r) => r.pattern);
const EXPECT = ["/", "/roadmap", "/activity", "/reports", "/reports/:agent/:level/:date", "/ticket/:id",
  "/docs", "/doc/:slug", "/doc/:slug/history", "/doc/:slug/diff"];
ok(VIEW_ROUTES.length === EXPECT.length && EXPECT.every((p) => patterns.includes(p)),
  `the registry holds exactly the ${EXPECT.length} HTML view routes (got: ${patterns.join(" · ")})`);
ok(VIEW_ROUTES.every((r) => r.method === "GET"), "every view route is method:GET (views are read-only; writes stay daemon-owned)");

// literal + param matching
ok(matchViewRoute("GET", seg("/"))?.route.pattern === "/", "GET / matches the board entry (root path → [] segments)");
ok(matchViewRoute("GET", seg("/roadmap"))?.route.pattern === "/roadmap", "GET /roadmap matches its literal entry");
const t = matchViewRoute("GET", seg("/ticket/DL-1"));
ok(t?.route.pattern === "/ticket/:id" && t?.params.id === "DL-1", "GET /ticket/DL-1 → the ticket entry with params.id captured");
const r4 = matchViewRoute("GET", seg("/reports/dev-agent/daily/2026-01-01"));
ok(r4?.route.pattern === "/reports/:agent/:level/:date" && r4?.params.agent === "dev-agent" && r4?.params.level === "daily" && r4?.params.date === "2026-01-01",
  "a multi-param pattern captures every :name segment");
// F4 docs routes: the :slug capture + the literal history/diff tails disambiguate by segment count/literal
const dv = matchViewRoute("GET", seg("/doc/strategy"));
ok(dv?.route.pattern === "/doc/:slug" && dv?.params.slug === "strategy", "GET /doc/strategy → the doc viewer entry with params.slug captured");
ok(matchViewRoute("GET", seg("/doc/strategy/history"))?.route.pattern === "/doc/:slug/history", "GET /doc/:slug/history matches its literal-tail entry");
ok(matchViewRoute("GET", seg("/doc/strategy/diff"))?.route.pattern === "/doc/:slug/diff", "GET /doc/:slug/diff matches its literal-tail entry");
ok(matchViewRoute("GET", seg("/docs"))?.route.pattern === "/docs", "GET /docs matches the index entry (never the :slug capture)");

// params stay RAW — the handler decodes (and 400s a malformed escape, the DL-7 contract)
ok(matchViewRoute("GET", seg("/ticket/DL%2D1"))?.params.id === "DL%2D1", "params carry the RAW (still percent-encoded) segment — the handler decodes");

// method semantics: GET implies HEAD; anything else never matches a view route
ok(matchViewRoute("HEAD", seg("/activity")) !== null, "HEAD matches like GET (node strips the body — pre-registry dispatch parity)");
ok(matchViewRoute("POST", seg("/")) === null && matchViewRoute("DELETE", seg("/ticket/DL-1")) === null,
  "POST/DELETE never match a view route (writes are daemon-owned; the 405/write routes keep their behavior)");

// shape misses fall through (to the daemon's /api routes or the HTML 404)
ok(matchViewRoute("GET", seg("/ticket/a/b")) === null, "a segment-count mismatch → no match (→ the daemon's HTML 404)");
ok(matchViewRoute("GET", seg("/api/tickets")) === null, "an /api path never matches a view route (JSON surface untouched)");
ok(matchViewRoute("GET", seg("/reports/dev-agent")) === null, "a partial /reports path → no match");

// F2 (D2): href() — the ONE canonical project-URL builder every view link/form action rides.
// daemon.ts strips the /p/<key>/ prefix it emits, so these two halves are one contract.
ok(href("acme", "/") === "/p/acme/", 'href("acme","/") → "/p/acme/" (the project board)');
ok(href("acme") === "/p/acme/", "href defaults to the project root");
ok(href("acme", "/ticket/A-1") === "/p/acme/ticket/A-1", "href joins a project-local path");
ok(href("acme", "/?state=Todo&group=assignee") === "/p/acme/?state=Todo&group=assignee", "href passes a query-bearing path through verbatim");
ok(href("_team", "/activity") === "/p/_team/activity", "the _team intake pseudo-project routes like any project");
ok(href("we ird/", "/") === "/p/we%20ird%2F/", "href percent-encodes the key — a key can never escape its path segment");

console.log(fails === 0 ? "\nVIEW_REGISTRY_OK" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
