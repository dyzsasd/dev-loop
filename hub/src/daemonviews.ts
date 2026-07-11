// dev-loop hub daemon — the web-UI view layer FAÇADE (F1 refactor, 2026-07 review).
//
// The implementation moved to hub/src/views/*:
//   ui.ts        — esc(), href() (the D2 /p/<key>/ URL builder), the tokens-v2 STYLE sheet, page()
//                  shell (switcher + nav), renderMarkdown, shared helpers (toTicket / ownerOf /
//                  prioOf / noticeHtml / countPill / stateDot)
//   board.ts     — boardPage (kanban board, filters, swimlanes, summary band)
//   ticket.ts    — ticketPage (detail, relations, comments, human-write forms)
//   docs.ts      — docsIndexPage / docPage / docHistoryPage / docDiffPage / draftsPendingCount
//                  (the F4/D3 docs system: kind-agnostic viewer + CAS edit + operator publish)
//   roadmap.ts   — roadmapPage (a thin adapter over docs.ts docPage for kind:"roadmap")
//   activity.ts  — activityPage (+ eventData), the events-ledger analytics
//   reports.ts   — reportsRoot / reportsIndexPage / reportPage (§22 filesystem tree)
//   projects.ts  — projectIndexPage (the F2/D2 multi-project landing at bare /)
//   registry.ts  — VIEW_ROUTES / matchViewRoute / decodeSeg, the typed view-route table daemon.ts
//                  dispatches (the D2 multi-project seam)
//
// This module re-exports the public surface so every pre-split import path (tests, notifiers,
// external embedders) keeps resolving unchanged. New code should import from ./views/* directly.
export { esc, href, page, renderMarkdown, toTicket, stateDot, STYLE } from "./views/ui.ts";
export { boardPage } from "./views/board.ts";
export { ticketPage } from "./views/ticket.ts";
export { roadmapPage } from "./views/roadmap.ts";
export { docsIndexPage, docPage, docHistoryPage, docDiffPage, draftsPendingCount, roadmapDocSlug } from "./views/docs.ts";
export { activityPage, eventData } from "./views/activity.ts";
export { reportsRoot, reportsIndexPage, reportPage } from "./views/reports.ts";
export { projectIndexPage } from "./views/projects.ts";
export { VIEW_ROUTES, matchViewRoute, decodeSeg, type ViewRoute, type ViewCtx, type ViewOut } from "./views/registry.ts";
