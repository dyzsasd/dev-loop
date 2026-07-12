// dev-loop hub daemon web UI — the DOCS system (F4, decision D3; docs P1 + P6a).
//
// Four project-scoped pages over the hub `documents` / `document_versions` tables:
//   /docs                    — index: every hub doc with kind, title, published-vs-latest badge, author
//   /doc/<slug>              — viewer: rendered markdown, ?v=N version picker, status line, and — ONLY
//                              when the DL-29 double gate is open (humanWrite.enabled + a write actor) —
//                              the CAS draft-edit form + the operator-only publish button (docstore's
//                              operator gate stays the single authorization point)
//   /doc/<slug>/history      — the append-only version ledger (author / summary / base / date)
//   /doc/<slug>/diff?from=&to= — db.ts unifiedDiff rendered safely (every line esc()'d)
// /roadmap is a 302 onto the roadmap doc page (registry.ts); roadmapPage delegates here, so the old
// DL-3/DL-14/DL-83 behaviors (CAS edit, conflict text-preservation, divergence banner) live in ONE
// renderer. Pure read-only rendering through the query_only db — the /doc/* write routes are daemon.ts.
import { DatabaseSync } from "node:sqlite";
import { unifiedDiff } from "../db.ts";
import { DOC_KINDS, resolveDoc, latestVersion, type DocKind, type DocRow } from "../docstore.ts";
import { esc, href, renderMarkdown, noticeHtml } from "./ui.ts";

// The operator-publish-gated kinds — everything but `design` (a design draft IS the live design, so it
// is singleton-per-slug, never published; docstore.ts DL-split semantics). Singleton kinds double as
// the CREATE affordance: /doc/<kind> with no doc yet renders a first-draft form whose kind = the slug.
export const SINGLETON_KINDS: readonly DocKind[] = DOC_KINDS.filter((k) => k !== "design");
export const isSingletonKind = (s: string): s is DocKind => (SINGLETON_KINDS as readonly string[]).includes(s);

// The roadmap doc's canonical page path segment — its stored slug when the doc exists, else the kind
// itself (the create page). Used by the /roadmap → /doc/<slug> redirect (registry.ts) and the legacy
// /roadmap/save|publish aliases (daemon.ts), so both resolve the SAME server-side target (§17: the
// slug is never caller input on those paths).
export const roadmapDocSlug = (db: DatabaseSync, projectId: string): string =>
  resolveDoc(db, projectId, undefined, "roadmap")?.slug ?? "roadmap";

// docs P6a: how many gated docs have a draft AHEAD of their published current (design excluded — its
// drafts are live, never "pending publish"). Drives the header "N drafts pending" chip (page() opts).
// D6: archived docs never count — a retired doc must not keep a "pending" nag alive. (The archive op
// is design-only, which the kind filter already excludes; the explicit archived=0 is the structural
// belt so a row archived by any other path can never resurrect the chip.)
export function draftsPendingCount(db: DatabaseSync, projectId: string): number {
  const r = db.prepare(
    `SELECT COUNT(*) AS n FROM documents d WHERE d.project_id=? AND d.kind!='design' AND d.archived=0
       AND (SELECT COALESCE(MAX(v.version),0) FROM document_versions v WHERE v.doc_id=d.id) > d.current_version`,
  ).get(projectId) as { n: number };
  return Number(r.n);
}

const docHref = (projectKey: string, slug: string, sub = ""): string =>
  href(projectKey, `/doc/${encodeURIComponent(slug)}${sub}`);

// One version badge for the index rows: published-vs-latest at a glance ("published v12" +
// "draft v14 pending" when drafts trail; design is always its live latest draft).
function versionBadge(kind: string, published: number, latest: number): string {
  if (kind === "design") return `<span class="lbl">v${latest} · live draft</span>`;
  if (published > 0 && latest > published) return `<span class="lbl vpub">published v${published}</span> <span class="lbl vpend">draft v${latest} pending</span>`;
  if (published > 0) return `<span class="lbl vpub">published v${published}</span>`;
  return `<span class="lbl vpend">draft v${latest} (unpublished)</span>`;
}

// GET /docs — every hub doc for the project, grouped by kind in DOC_KINDS order (design is
// multi-instance — one row per module slug). Each row: title → viewer, slug, version badge,
// latest author, updated-at. D6: archived (retired design) docs are HIDDEN by default —
// ?archived=1 shows them (badged), and the default view names how many are hidden (a discoverable
// footer link, never a silent hole in the registry). Nothing is ever deleted.
export function docsIndexPage(db: DatabaseSync, projectId: string, projectKey: string, showArchived = false): string {
  const rows = db.prepare(
    `SELECT d.kind,d.slug,d.title,d.current_version,d.archived,d.updated_at,
            (SELECT COALESCE(MAX(v.version),0) FROM document_versions v WHERE v.doc_id=d.id) AS latest,
            (SELECT v.author FROM document_versions v WHERE v.doc_id=d.id ORDER BY v.version DESC LIMIT 1) AS latest_author
       FROM documents d WHERE d.project_id=?${showArchived ? "" : " AND d.archived=0"} ORDER BY d.slug`,
  ).all(projectId) as { kind: string; slug: string; title: string; current_version: number; archived: number; updated_at: string; latest: number; latest_author: string | null }[];

  const sections = DOC_KINDS.map((kind) => {
    const docs = rows.filter((r) => r.kind === kind);
    if (!docs.length) return "";
    const items = docs.map((r) =>
      `<div class="rlevel"><span class="rkey">${esc(r.slug)}</span>`
      + `<a class="doclink" href="${esc(docHref(projectKey, r.slug))}">${esc(r.title)}</a>`
      + (r.archived ? `<span class="lbl">archived</span>` : "")
      + versionBadge(r.kind, r.current_version, r.latest)
      + `<span class="sub">by ${esc(r.latest_author ?? "—")} · <time datetime="${esc(r.updated_at)}">${esc(r.updated_at)}</time></span></div>`).join("");
    return `<section class="ragent"><h3>${esc(kind)}</h3>${items}</section>`;
  }).filter(Boolean).join("");

  // The hidden-archived footer: only on the default view, only when something IS hidden.
  const hiddenN = showArchived ? 0
    : Number((db.prepare("SELECT COUNT(*) AS n FROM documents WHERE project_id=? AND archived=1").get(projectId) as { n: number }).n);
  const archivedFoot = hiddenN > 0
    ? `<p class="empty">${hiddenN} archived doc${hiddenN === 1 ? "" : "s"} hidden — <a href="${esc(href(projectKey, "/docs?archived=1"))}">show archived</a></p>`
    : showArchived ? `<p class="empty"><a href="${esc(href(projectKey, "/docs"))}">hide archived</a></p>` : "";

  return `<a class="back" href="${esc(href(projectKey, "/"))}">← board</a><article class="detail"><h1>Documents</h1>`
    + (sections || `<p class="empty">No documents in ${esc(projectKey)} yet — agents create them via <code>doc.save</code> (hub.docs), or start one at <code>/doc/&lt;kind&gt;</code>.</p>`)
    + archivedFoot
    + `</article>`;
}

export interface DocPageOpts {
  canEdit: boolean;                  // the DL-29 double gate is open (humanWrite.enabled + a write actor) → render the CAS draft-edit form
  canPublish: boolean;               // canEdit-tier AND actor === operator → render the publish button on gated kinds
  version?: number;                  // ?v=N — view that exact version (default: the LATEST, draft or published)
  notice?: { kind: "error" | "ok"; msg: string };
  submittedBody?: string;            // DL-14: a rejected save re-renders with the typed text preserved
  roadmapRepoFileStrategy?: string;  // DL-83: the divergence banner input — applied ONLY when kind === "roadmap"
}
// "noversion" → the ?v the caller asked for doesn't exist (404); { redirect } → the slug names a
// singleton KIND whose doc lives under another slug (302 to the canonical one); null → no such doc.
export type DocPageOut = string | { redirect: string } | "noversion" | null;

// GET /doc/<slug> — the kind-agnostic doc page (the roadmapPage generalization). View + version
// picker always; edit/publish controls only per the gates above. slug/kind are NEVER form fields on
// the write side — daemon.ts derives kind from the stored row (or the singleton-kind slug), §17/DL-9.
export function docPage(db: DatabaseSync, projectId: string, projectKey: string, slug: string, opts: DocPageOpts): DocPageOut {
  const d = resolveDoc(db, projectId, slug);
  if (!d && !isSingletonKind(slug)) return null;
  if (!d) {
    const byKind = resolveDoc(db, projectId, undefined, slug);
    if (byKind) return { redirect: byKind.slug }; // the kind's doc lives at its own slug — one canonical URL
  }
  const kind = d?.kind ?? slug;                     // singleton create page: kind = the slug (server-derived)
  const latest = d ? latestVersion(db, d.id) : 0;
  const published = d?.current_version ?? 0;
  const viewV = opts.version ?? latest;
  const viewed = d && viewV > 0
    ? db.prepare("SELECT version,body,status,author,created_at FROM document_versions WHERE doc_id=? AND version=?").get(d.id, viewV) as Record<string, any> | undefined
    : undefined;
  if (opts.version !== undefined && !viewed) return "noversion";
  const latestRow = viewV === latest ? viewed
    : (d ? db.prepare("SELECT body,author,status FROM document_versions WHERE doc_id=? AND version=?").get(d.id, latest) as Record<string, any> | undefined : undefined);
  const title = d?.title ?? (slug.charAt(0).toUpperCase() + slug.slice(1));

  // DL-83: the north-star divergence banner, now living on the roadmap-kind DOC page (D3 moved the
  // roadmap form here). Neutral + informational — never hides the view/edit/publish controls.
  const divergence = kind === "roadmap" && opts.roadmapRepoFileStrategy
    ? `<p class="notice n-info">This project's north-star is the repo file <code>${esc(opts.roadmapRepoFileStrategy)}</code> — this hub roadmap is <b>not read by the agents</b> under the current config (no <code>hub.docs</code>, no <code>director</code>), so edits here won't steer the loop.</p>`
    : "";
  const notice = noticeHtml(opts.notice);

  let meta = "", view = "";
  if (latest === 0) {
    view = `<p class="empty">No ${esc(kind)} document yet${opts.canEdit ? " — saving below creates the first draft" : ""}.</p>`;
  } else {
    // version picker: ?v=N links (last 12 at most; /history holds the full ledger), viewed one marked.
    const first = Math.max(1, latest - 11);
    const picker = (first > 1 ? "… " : "") + Array.from({ length: latest - first + 1 }, (_, i) => first + i).map((n) =>
      n === viewV ? `<b class="vcur">v${n}</b>` : `<a href="${esc(docHref(projectKey, slug, `?v=${n}`))}">v${n}</a>`).join(" ");
    const diffLink = latest > 1
      ? ` · <a href="${esc(docHref(projectKey, slug, `/diff?from=${published > 0 && published < latest ? published : latest - 1}&to=${latest}`))}">diff</a>`
      : "";
    meta = `<dl class="meta"><dt>Status</dt><dd>${esc(d!.status)}</dd>`
      + `<dt>Latest version</dt><dd>v${latest} (${esc(latestRow?.status === "current" ? "published" : "draft")}) · by ${esc(latestRow?.author ?? "—")}</dd>`
      + `<dt>Published</dt><dd>${kind === "design" ? "— (design is live at its latest draft, never publish-gated)" : published > 0 ? `v${published}` : "none — draft only"}</dd>`
      + `<dt>Updated</dt><dd><time datetime="${esc(d!.updated_at)}">${esc(d!.updated_at)}</time></dd>`
      + `<dt>Versions</dt><dd class="vlinks">${picker} · <a href="${esc(docHref(projectKey, slug, "/history"))}">history</a>${diffLink}</dd></dl>`;
    const oldNotice = viewV !== latest
      ? `<p class="notice n-info">Viewing v${viewV} — the latest is v${latest}. <a href="${esc(docHref(projectKey, slug))}">view latest</a></p>`
      : "";
    const heading = viewV === latest
      ? (latest === published ? `Published (v${latest})` : `Draft (v${latest}, unpublished)`)
      : `Version ${viewV}${viewV === published ? " (published)" : " (draft)"}`;
    view = oldNotice + `<h3>${heading}</h3>`
      + (viewed?.body ? `<div class="doc">${renderMarkdown(viewed.body)}</div>` : `<p class="empty">(empty)</p>`);
  }

  // The write affordances — DL-29 double gate only (absent otherwise; the POST routes are equally
  // gated in daemon.ts, so a hidden form can't be replayed around the gate). The edit always bases
  // on the LATEST version (the CAS key), whatever ?v is being viewed; DL-14 keeps rejected text.
  let controls = "";
  if (opts.canEdit) {
    controls = `<h3>Edit — saves a DRAFT (never publishes)</h3>`
      + `<form method="post" action="${esc(docHref(projectKey, slug, "/save"))}">`
      + `<input type="hidden" name="baseVersion" value="${latest}">` // server-derived CAS base; a stale base is rejected, never overwritten
      + `<textarea name="body" rows="16" spellcheck="false">${esc(opts.submittedBody ?? latestRow?.body ?? "")}</textarea>`
      + `<label>Summary (optional) <input type="text" name="summary" placeholder="what changed"></label>`
      + `<button type="submit">Save draft</button></form>`;
    if (kind !== "design" && latest > published) {
      controls += opts.canPublish
        ? `<form method="post" action="${esc(docHref(projectKey, slug, "/publish"))}" class="pub"><input type="hidden" name="version" value="${latest}">`
          + `<button type="submit">Publish v${latest} → current</button></form>` // bound to the EXACT version the operator is looking at
        : `<p class="empty">Publishing a draft → current is <b>operator-only</b>. This daemon runs as a non-operator actor, so the publish control is hidden (§16/§17).</p>`;
    }
  }

  return `<a class="back" href="${esc(href(projectKey, "/docs"))}">← docs</a><article class="detail">`
    + `<div class="card-top"><span class="id">${esc(kind)}</span><span class="badge">${esc(d?.status ?? "—")}</span>${d?.archived ? `<span class="badge">archived</span>` : ""}</div>`
    + `<h1>${esc(title)}</h1>` + divergence + notice + meta + view + controls + `</article>`;
}

// GET /doc/<slug>/history — the document_versions ledger, newest first: status, author, summary,
// CAS base, date; each row links its view (?v=N) and a diff against its predecessor.
export function docHistoryPage(db: DatabaseSync, projectId: string, projectKey: string, slug: string): string | null {
  const d = resolveDoc(db, projectId, slug);
  if (!d) return null;
  const vers = db.prepare("SELECT version,status,summary,base_version,author,created_at FROM document_versions WHERE doc_id=? ORDER BY version DESC").all(d.id) as Record<string, any>[];
  const rows = vers.map((v) =>
    `<div class="rlevel"><span class="rkey">v${v.version}</span>`
    + (Number(v.version) === d.current_version ? `<span class="lbl vpub">published</span>` : `<span class="lbl">draft</span>`)
    + `<span class="who">${esc(v.author)}</span>`
    + `<span class="sub">${esc(v.summary || "—")} · base v${v.base_version} · <time datetime="${esc(v.created_at)}">${esc(v.created_at)}</time></span> `
    + `<a class="lbl" href="${esc(docHref(projectKey, slug, `?v=${v.version}`))}">view</a>`
    + (Number(v.version) > 1 ? ` <a class="lbl" href="${esc(docHref(projectKey, slug, `/diff?from=${v.version - 1}&to=${v.version}`))}">diff v${v.version - 1}→v${v.version}</a>` : "")
    + `</div>`).join("");
  return `<a class="back" href="${esc(docHref(projectKey, slug))}">← ${esc(d.title)}</a><article class="detail">`
    + `<div class="card-top"><span class="id">${esc(d.kind)}</span><span class="badge">history</span></div>`
    + `<h1>${esc(d.title)} — versions</h1>` + (rows || `<p class="empty">No versions yet.</p>`) + `</article>`;
}

// GET /doc/<slug>/diff?from=N&to=N — db.ts unifiedDiff (pure JS, zero dep) rendered read-only.
// EVERY line is esc()'d before the +/- class wrap, so doc bodies can never inject markup here.
export function docDiffPage(db: DatabaseSync, projectId: string, projectKey: string, slug: string, from: number, to: number): string | "noversion" | null {
  const d = resolveDoc(db, projectId, slug);
  if (!d) return null;
  const body = (v: number) => db.prepare("SELECT body FROM document_versions WHERE doc_id=? AND version=?").get(d.id, v) as { body: string } | undefined;
  const a = body(from), b = body(to);
  if (!a || !b) return "noversion";
  const lines = unifiedDiff(a.body, b.body).split("\n").map((l) => {
    const cls = l.startsWith("+ ") ? "da" : l.startsWith("- ") ? "dd" : "dc";
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join(""); // the line classes are display:block — no literal \n, or <pre> would double-space
  return `<a class="back" href="${esc(docHref(projectKey, slug, "/history"))}">← history</a> · <a class="back" href="${esc(docHref(projectKey, slug))}">${esc(d.title)}</a><article class="detail">`
    + `<div class="card-top"><span class="id">${esc(d.kind)}</span><span class="badge">diff</span></div>`
    + `<h1>${esc(d.title)}: v${from} → v${to}</h1>`
    + `<pre class="diff"><code>${lines}</code></pre></article>`;
}
