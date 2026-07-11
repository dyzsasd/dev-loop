// dev-loop hub daemon web UI — the roadmap doc view (DL-3/DL-14/DL-83), now a THIN ADAPTER over the
// kind-agnostic doc page (views/docs.ts — F4/D3 generalized the roadmap page into the docs system).
// GET /roadmap itself 302s onto /doc/<slug> (registry.ts); this export survives for the daemonviews
// façade contract (pre-split import paths keep resolving) and renders the SAME docPage body the doc
// route serves, so the two can never drift.
import { DatabaseSync } from "node:sqlite";
import { docPage, roadmapDocSlug } from "./docs.ts";

export function roadmapPage(db: DatabaseSync, projectId: string, projectKey: string, opts: { writable: boolean; canPublish: boolean; notice?: { kind: "error" | "ok"; msg: string }; submittedBody?: string; roadmapRepoFileStrategy?: string }): string {
  const slug = roadmapDocSlug(db, projectId); // server-resolved — never caller input (§17)
  const out = docPage(db, projectId, projectKey, slug, {
    canEdit: opts.writable, canPublish: opts.canPublish,
    notice: opts.notice, submittedBody: opts.submittedBody, roadmapRepoFileStrategy: opts.roadmapRepoFileStrategy,
  });
  // roadmap is a singleton kind at its own resolved slug, so docPage always renders (a create page
  // when the doc doesn't exist yet) — the redirect/noversion/null arms are unreachable here.
  return typeof out === "string" ? out : "";
}
