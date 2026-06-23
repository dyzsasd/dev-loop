// dev-loop hub daemon — a persistent localhost HTTP read surface over the hub SoR (DL-1).
//
// READ-ONLY by construction: it opens the SAME node:sqlite DB the MCP server uses, sets
// `PRAGMA query_only=ON` (a structural guarantee it can never write the system of record),
// serves ONLY GET endpoints (any other method → 405), and never mutates tickets/docs/events.
// Binds 127.0.0.1 ONLY (§16) — never 0.0.0.0, no external exposure.
//
// The agents are UNCHANGED: they keep coordinating through the MCP server (`server.ts`); this is
// an additive human-facing read surface, NOT a new coordinator (strategyDoc Decisions log,
// 2026-06-23). Write paths (roadmap edit) build on this later (DL-3); the web UI is DL-2 — which
// will serve HTML at `/`, replacing this module's JSON API index there.
//
// Zero native deps, zero build step (Node ≥23.6 type-stripping + built-in node:http/node:sqlite),
// reusing the existing `db.ts` schema with NO schema fork (hub doctrine).
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.ts";
import { findProject } from "./seed.ts";

export interface DaemonOpts {
  db: DatabaseSync;
  projectId: string;
  projectKey: string;
}

// ticket row → API shape (mirrors the MCP server's toTicket; labels/related_to are JSON columns).
function toTicket(r: Record<string, any>) {
  return {
    id: r.id, title: r.title, description: r.description, type: r.type, state: r.state,
    assignee: r.assignee, priority: r.priority,
    labels: JSON.parse(r.labels), duplicateOf: r.duplicate_of, relatedTo: JSON.parse(r.related_to),
    created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
}

// Build the HTTP server over an already-opened, project-resolved db. Exported so tests (and a later
// in-process embed) can start it without the CLI bootstrap below. The handler issues ONLY SELECTs.
export function createDaemon({ db, projectId, projectKey }: DaemonOpts): Server {
  return createServer((req, res) => {
    // READ-ONLY: anything but GET/HEAD is refused — the daemon never mutates the SoR (DL-1 AC).
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "read-only daemon: only GET is allowed" });
    }
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { return json(res, 400, { error: "bad request url" }); }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean); // [] for "/"

    try {
      // GET / — JSON API index. (DL-2 replaces this root with the web UI.)
      if (path === "/") {
        return json(res, 200, {
          name: "dev-loop-hub daemon", project: projectKey, readOnly: true,
          endpoints: ["/api/health", "/api/tickets", "/api/tickets/:id", "/api/docs", "/api/docs/:kind"],
        });
      }

      // GET /api/health — liveness.
      if (path === "/api/health") return json(res, 200, { ok: true, project: projectKey });

      // GET /api/tickets — board, project-scoped (§2), filter by state/type/label (+ optional limit).
      if (path === "/api/tickets") {
        let out = (db.prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY updated_at DESC").all(projectId) as Record<string, any>[]).map(toTicket);
        const state = url.searchParams.get("state"); if (state) out = out.filter((t) => t.state === state);
        const type = url.searchParams.get("type"); if (type) out = out.filter((t) => t.type === type);
        const label = url.searchParams.get("label"); if (label) out = out.filter((t) => t.labels.includes(label));
        const limit = Number(url.searchParams.get("limit")); if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
        return json(res, 200, out);
      }

      // GET /api/tickets/:id — one ticket with its comments.
      if (seg[0] === "api" && seg[1] === "tickets" && seg.length === 3) {
        const id = decodeURIComponent(seg[2]);
        const r = db.prepare("SELECT * FROM tickets WHERE id=? AND project_id=?").get(id, projectId) as Record<string, any> | undefined;
        if (!r) return json(res, 404, { error: `no such ticket ${id} in ${projectKey}` });
        const comments = db.prepare("SELECT id,author,body,created_at FROM comments WHERE ticket_id=? ORDER BY created_at").all(id);
        return json(res, 200, { ...toTicket(r), comments });
      }

      // GET /api/docs — list this project's documents (no bodies).
      if (path === "/api/docs") {
        return json(res, 200, db.prepare("SELECT kind,slug,title,status,current_version,updated_at FROM documents WHERE project_id=? ORDER BY kind").all(projectId));
      }

      // GET /api/docs/:kind — the current roadmap/strategy doc (published version, else latest draft).
      if (seg[0] === "api" && seg[1] === "docs" && seg.length === 3) {
        const key = decodeURIComponent(seg[2]);
        const d = (db.prepare("SELECT * FROM documents WHERE project_id=? AND kind=?").get(projectId, key)
          ?? db.prepare("SELECT * FROM documents WHERE project_id=? AND slug=?").get(projectId, key)) as Record<string, any> | undefined;
        if (!d) return json(res, 404, { error: `no document '${key}' in ${projectKey}` });
        const ver = d.current_version > 0
          ? d.current_version
          : ((db.prepare("SELECT max(version) v FROM document_versions WHERE doc_id=?").get(d.id) as { v: number | null }).v ?? 0);
        if (ver === 0) return json(res, 200, { kind: d.kind, slug: d.slug, title: d.title, status: d.status, version: 0, body: "", unpublished: true, empty: true });
        const v = db.prepare("SELECT version,body,status,summary,base_version,author,created_at FROM document_versions WHERE doc_id=? AND version=?").get(d.id, ver) as Record<string, any>;
        return json(res, 200, { kind: d.kind, slug: d.slug, title: d.title, status: d.status, current_version: d.current_version, ...v, ...(d.current_version === 0 ? { unpublished: true } : {}) });
      }

      return json(res, 404, { error: `not found: ${path}` });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
}

// ─── CLI entry: `npm run daemon` — open db, resolve project (same guard as the MCP server), listen ──
// Only runs when executed directly (not on import — the test imports createDaemon and starts it itself).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const DB_PATH = process.env.DEVLOOP_HUB_DB ?? `${homedir()}/.dev-loop/hub.db`;
  const PROJECT_KEY = process.env.DEVLOOP_PROJECT ?? "demo";
  const HOST = "127.0.0.1"; // §16 localhost-only; NEVER 0.0.0.0
  const PORT = Number(process.env.DEVLOOP_DAEMON_PORT ?? 8787);

  const db = openDb(DB_PATH);
  db.exec("PRAGMA query_only=ON"); // structural read-only: this connection can never write the SoR
  // No ensureActors/auto-create here: like the MCP server's G2 guard, refuse to serve a phantom board.
  const projectId = findProject(db, PROJECT_KEY);
  if (!projectId) {
    console.error(`[daemon] unknown project '${PROJECT_KEY}'. Seed it first (e.g. start the hub, or \`node src/seed.ts ${PROJECT_KEY} "<name>" <PREFIX>\`). Refusing to serve a phantom board.`);
    process.exit(1);
  }
  const server = createDaemon({ db, projectId, projectKey: PROJECT_KEY });
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    console.log(`[daemon] dev-loop-hub read API for '${PROJECT_KEY}' → http://${HOST}:${port}/  (read-only, localhost-only)`);
  });
}
