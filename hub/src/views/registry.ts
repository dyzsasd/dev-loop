// dev-loop hub daemon web UI — the typed VIEW-ROUTE REGISTRY (F1).
//
// One entry per HTML page; daemon.ts consumes VIEW_ROUTES via matchViewRoute() instead of inlining
// per-path dispatch. F2 (D2 multi-project routing): daemon.ts resolves the project from the
// /p/<key>/ path prefix (bare paths fall back to the boot project), strips the prefix from `seg`,
// and builds the ViewCtx with the RESOLVED projectId/projectKey — so the pattern "/" below is a
// PROJECT BOARD (bare GET / is intercepted upstream as the hub project index and never reaches this
// table). Handlers are pure: they return a ViewOut (full HTML document or a JSON error) and never
// touch res — daemon.ts owns HTTP (htmlOut/json), write routes, and the /api/* surface.
// (hub/test/daemon.ts asserts every route end-to-end.)
import { DatabaseSync } from "node:sqlite";
import { page, esc, href } from "./ui.ts";
import { boardPage, type BoardFilters } from "./board.ts";
import { ticketPage } from "./ticket.ts";
import { activityPage } from "./activity.ts";
import { reportsRoot, reportsIndexPage, reportPage } from "./reports.ts";
import { docsIndexPage, docPage, docHistoryPage, docDiffPage, roadmapDocSlug } from "./docs.ts";

// Everything a view handler may need, resolved PER REQUEST by daemon.ts.
export interface ViewCtx {
  db: DatabaseSync;                  // the query_only read connection — handlers only SELECT
  projectId: string;                 // the RESOLVED project (the /p/<key>/ prefix, else the boot project — F2/D2)
  projectKey: string;
  url: URL;                          // parsed request URL (query string → board filters)
  params: Record<string, string>;    // RAW (still percent-encoded) segments captured by :name — the handler decodes (→ 400 on a malformed escape)
  humanWrite: () => boolean;         // canWrite && settings humanWrite.enabled — LAZY so only the routes that render write affordances pay the settings SELECT, and it stays a FRESH per-request read (DL-29)
  writable: boolean;                 // the daemon has a writeDb + actor (the DL-3 write surface exists)
  canPublish: boolean;               // writable && actor === "operator" (the DL-3 operator-publish gate)
  roadmapRepoFileStrategy?: string;  // DL-83 divergence banner input (resolved config, never request input)
  draftsPending: () => number;       // docs P6a: gated docs with a draft ahead of published (the header chip) — LAZY like humanWrite
}
export type ViewOut =
  | { kind: "html"; status: number; html: string }   // a full page() document
  | { kind: "json"; status: number; body: unknown }  // client errors on machine-ish path failures (malformed escape / bad report path) — matches the pre-registry contract
  | { kind: "redirect"; status: number; location: string }; // D3: /roadmap → the roadmap doc page; /doc/<kind> → the kind's canonical slug
export interface ViewRoute {
  method: "GET";                     // views are read-only; GET implies HEAD (see matchViewRoute)
  pattern: string;                   // "/" | literal segments | ":name" captures — e.g. "/ticket/:id"
  handler: (ctx: ViewCtx) => ViewOut;
}

// Defensively decode a single URL path segment. A malformed / incomplete percent-escape (e.g. "%",
// "%ZZ", an incomplete UTF-8 sequence "%E0%A4") makes decodeURIComponent throw a URIError — that is
// a CLIENT error, so callers surface 400 (the daemon's "bad request url" → 400 contract) instead of
// letting it fall through to the generic 500 catch (DL-7). Returns null when undecodable.
export function decodeSeg(seg: string): string | null {
  try { return decodeURIComponent(seg); } catch { return null; }
}

const html = (status: number, doc: string): ViewOut => ({ kind: "html", status, html: doc });
const MALFORMED: ViewOut = { kind: "json", status: 400, body: { error: "malformed percent-escape in path" } };

export const VIEW_ROUTES: ViewRoute[] = [
  // GET / — the PROJECT board (DL-2): server-rendered HTML, read-only, columns by state. DL-20:
  // optional server-side filter/search via the query string (state/type/label/assignee + free-text q).
  // F2: reached bare (boot fallback is intercepted — bare / is the hub index) or as /p/<key>/.
  {
    method: "GET", pattern: "/", handler: (c) => {
      const sp = c.url.searchParams;
      const filters: BoardFilters = { state: sp.get("state") ?? undefined, type: sp.get("type") ?? undefined, label: sp.get("label") ?? undefined, assignee: sp.get("assignee") ?? undefined, q: sp.get("q") ?? undefined };
      // DL-31: validate ?group to the single known view ("assignee" → swimlanes); anything else ⇒ default board.
      const group = sp.get("group") === "assignee" ? "assignee" : undefined;
      return html(200, page(`${c.projectKey} · board`, c.projectKey, boardPage(c.db, c.projectId, c.projectKey, filters, c.humanWrite(), group), { active: "board", drafts: c.draftsPending() }));
    },
  },
  // GET /roadmap — a 302 onto the roadmap DOC page (D3: the doc system superseded the dedicated
  // roadmap page; its slug is server-resolved). Old bookmarks and the bare boot-fallback path land
  // on the same generalized /doc/<slug> renderer.
  {
    method: "GET", pattern: "/roadmap", handler: (c) =>
      ({ kind: "redirect", status: 302, location: href(c.projectKey, `/doc/${encodeURIComponent(roadmapDocSlug(c.db, c.projectId))}`) }),
  },
  // GET /activity — read-only activity & throughput over the events ledger (DL-17). Pure SELECTs
  // through the query_only db; Date.now() injected here so activityPage stays pure/testable.
  {
    method: "GET", pattern: "/activity", handler: (c) =>
      html(200, page(`activity · ${c.projectKey}`, c.projectKey, activityPage(c.db, c.projectId, c.projectKey, Date.now()), { active: "activity", drafts: c.draftsPending() })),
  },
  // GET /reports — the agent reports index (DL-10, read-only filesystem view; empty state if absent).
  {
    method: "GET", pattern: "/reports", handler: (c) =>
      html(200, page(`reports · ${c.projectKey}`, c.projectKey, reportsIndexPage(reportsRoot(c.projectKey), c.projectKey), { active: "reports", drafts: c.draftsPending() })),
  },
  // GET /reports/<agent>/<level>/<date> — one report, read-only (path-validated → 400 traversal, 404 absent).
  {
    method: "GET", pattern: "/reports/:agent/:level/:date", handler: (c) => {
      const agent = decodeSeg(c.params.agent), level = decodeSeg(c.params.level), date = decodeSeg(c.params.date);
      if (agent === null || level === null || date === null) return MALFORMED;
      const r = reportPage(reportsRoot(c.projectKey), c.projectKey, agent, level, date);
      if (r === "badpath") return { kind: "json", status: 400, body: { error: "invalid report path" } };
      if (r === null) return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, "/reports"))}">← reports</a><p class="empty">No report ${esc(agent)}/${esc(level)}/${esc(date)}.</p>`, { active: "reports" }));
      return html(200, page(`${date} · ${agent} · ${c.projectKey}`, c.projectKey, r.html, { active: "reports", drafts: c.draftsPending() }));
    },
  },
  // GET /ticket/:id — the web UI detail view (DL-2): full description + comments.
  {
    method: "GET", pattern: "/ticket/:id", handler: (c) => {
      const id = decodeSeg(c.params.id);
      if (id === null) return MALFORMED;
      const inner = ticketPage(c.db, c.projectId, c.projectKey, id, c.humanWrite());
      if (!inner) return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, "/"))}">← board</a><p class="empty">No ticket ${esc(id)} in ${esc(c.projectKey)}.</p>`, { active: "board" }));
      return html(200, page(`${id} · ${c.projectKey}`, c.projectKey, inner, { active: "board", drafts: c.draftsPending() }));
    },
  },
  // ── F4 (D3): the docs system — index / viewer / history / diff (views/docs.ts) ──
  // GET /docs — every hub doc with kind, title, published-vs-latest badge, author, updated-at.
  // D6: archived docs are hidden by default; ?archived=1 shows them (any other value ⇒ default hide).
  {
    method: "GET", pattern: "/docs", handler: (c) =>
      html(200, page(`docs · ${c.projectKey}`, c.projectKey, docsIndexPage(c.db, c.projectId, c.projectKey, c.url.searchParams.get("archived") === "1"), { active: "docs", drafts: c.draftsPending() })),
  },
  // GET /doc/:slug — the kind-agnostic doc viewer (+ ?v=N picker; gated CAS edit + operator publish).
  {
    method: "GET", pattern: "/doc/:slug", handler: (c) => {
      const slug = decodeSeg(c.params.slug);
      if (slug === null) return MALFORMED;
      const vRaw = c.url.searchParams.get("v");
      let version: number | undefined;
      if (vRaw !== null) {
        version = Number(vRaw);
        if (!Number.isInteger(version) || version < 1) return { kind: "json", status: 400, body: { error: "v must be a positive integer" } };
      }
      const out = docPage(c.db, c.projectId, c.projectKey, slug, {
        canEdit: c.humanWrite(), canPublish: c.humanWrite() && c.canPublish, // the DL-29 double gate; publish additionally operator-only
        version, roadmapRepoFileStrategy: c.roadmapRepoFileStrategy,
      });
      if (out === null) return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, "/docs"))}">← docs</a><p class="empty">No document <code>${esc(slug)}</code> in ${esc(c.projectKey)}.</p>`, { active: "docs" }));
      if (out === "noversion") return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, `/doc/${encodeURIComponent(slug)}`))}">← ${esc(slug)}</a><p class="empty">No version ${version} of <code>${esc(slug)}</code>.</p>`, { active: "docs" }));
      if (typeof out !== "string") return { kind: "redirect", status: 302, location: href(c.projectKey, `/doc/${encodeURIComponent(out.redirect)}`) }; // /doc/<kind> → the kind's canonical slug
      return html(200, page(`${slug} · ${c.projectKey}`, c.projectKey, out, { active: "docs", drafts: c.draftsPending() }));
    },
  },
  // GET /doc/:slug/history — the append-only version ledger (author / summary / base / date).
  {
    method: "GET", pattern: "/doc/:slug/history", handler: (c) => {
      const slug = decodeSeg(c.params.slug);
      if (slug === null) return MALFORMED;
      const inner = docHistoryPage(c.db, c.projectId, c.projectKey, slug);
      if (inner === null) return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, "/docs"))}">← docs</a><p class="empty">No document <code>${esc(slug)}</code> in ${esc(c.projectKey)}.</p>`, { active: "docs" }));
      return html(200, page(`history · ${slug} · ${c.projectKey}`, c.projectKey, inner, { active: "docs", drafts: c.draftsPending() }));
    },
  },
  // GET /doc/:slug/diff?from=N&to=N — unified diff between two versions, esc()'d line by line.
  {
    method: "GET", pattern: "/doc/:slug/diff", handler: (c) => {
      const slug = decodeSeg(c.params.slug);
      if (slug === null) return MALFORMED;
      const from = Number(c.url.searchParams.get("from")), to = Number(c.url.searchParams.get("to"));
      if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1) {
        return { kind: "json", status: 400, body: { error: "diff requires ?from=N&to=N (positive integers)" } };
      }
      const inner = docDiffPage(c.db, c.projectId, c.projectKey, slug, from, to);
      if (inner === null) return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, "/docs"))}">← docs</a><p class="empty">No document <code>${esc(slug)}</code> in ${esc(c.projectKey)}.</p>`, { active: "docs" }));
      if (inner === "noversion") return html(404, page("Not found", c.projectKey, `<a class="back" href="${esc(href(c.projectKey, `/doc/${encodeURIComponent(slug)}/history`))}">← history</a><p class="empty">No version v${from}→v${to} of <code>${esc(slug)}</code>.</p>`, { active: "docs" }));
      return html(200, page(`diff · ${slug} · ${c.projectKey}`, c.projectKey, inner, { active: "docs", drafts: c.draftsPending() }));
    },
  },
];

// Match a request against VIEW_ROUTES. `seg` is the daemon's normalized segment list
// (path.split("/").filter(Boolean) — trailing slashes already stripped, "" ⇒ []); segments are
// compared RAW (still percent-encoded) against literal pattern segments, exactly like the previous
// inline `path === "/x"` / `seg[0] === "x"` checks, so an encoded literal ("/%72eports") still
// misses — byte-identical routing. HEAD matches like GET (node:http strips the body), matching the
// pre-registry dispatch where the method gate allowed HEAD through to the same handlers.
export function matchViewRoute(method: string, seg: string[]): { route: ViewRoute; params: Record<string, string> } | null {
  if (method !== "GET" && method !== "HEAD") return null;
  for (const route of VIEW_ROUTES) {
    const pseg = route.pattern.split("/").filter(Boolean);
    if (pseg.length !== seg.length) continue;
    const params: Record<string, string> = {};
    let hit = true;
    for (let i = 0; i < pseg.length; i++) {
      if (pseg[i].startsWith(":")) params[pseg[i].slice(1)] = seg[i];
      else if (pseg[i] !== seg[i]) { hit = false; break; }
    }
    if (hit) return { route, params };
  }
  return null;
}
