// dev-loop hub — P2 (DL-55): a THIN stdio MCP shim that proxies the 5 core ticket tools to the loopback
// daemon's DL-43 agent op-API (POST /api/op/<op>) instead of opening hub.db directly. It is an OPT-IN
// alternative entry to the default `node src/server.ts` (direct-db stdio), documented in config/mcp.example.json.
//
// WHY: the Vision's "daemon owns coordination — agents act through one running service". server.ts stays the
// canonical direct-db transport (DL-43 AC: 100% untouched); this shim is the additive client that routes the
// core ticket tools through the one running daemon. Identity rides env→header (design Decision #2/#5): the
// shim reads its OWN DEVLOOP_ACTOR and forwards it as the X-Devloop-Actor header on the loopback HTTP call IT
// makes — so the CLI never makes an authed HTTP call and the headless `claude -p` Authorization-header drop
// (HUB-ARCHITECTURE §6) never touches identity.
//
// SCOPE: the 5 core ticket tools (list_issues/get_issue/save_issue/save_comment/list_comments) + a LOCAL
// whoami (DL-55), PLUS (DL-62) the doc/event family — list_events + doc.list/get/history/diff/save/publish.
// topic.*/post.add + channel.* + mirror.* + the label ops are the sequenced (4/n) increment, NOT here — so
// the shim is not YET a 100% server.ts drop-in. The shim holds NO SoR / NO ticket-or-doc logic (Decision #3):
// a pure thin client over the op-API (which mirrors server.ts 1:1 via agentops.ts + the shared docstore).
//
// PARITY TRIPWIRE: the tool names + zod inputSchemas below MUST stay byte-identical to server.ts's tools
// (the shim is a drop-in transport for them). A change to a proxied tool's name/schema in server.ts must
// land here too.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveProjectFromCwd, loadProjectsConfig } from "./resolve-project.ts";
import { DOC_KINDS } from "./docstore.ts"; // the doc-kind enum ONLY (the same const server.ts uses) — a shared schema constant, not SoR/doc logic; keeps doc.save's enum from drifting (the shim stays a thin client)

// ─── identity + project (mirror server.ts:18-33) ────────────────────────────────
// Identity rides DEVLOOP_ACTOR (launcher-set per pane); an EXPLICIT DEVLOOP_PROJECT wins, else resolve the
// project from cwd (DL-13), else the "demo" default — exactly as server.ts, so the shim names the same
// per-project daemon runfile the direct-db server would attribute writes to.
const ACTOR = process.env.DEVLOOP_ACTOR ?? "operator";
const explicitProject = process.env.DEVLOOP_PROJECT?.trim();
let PROJECT_KEY: string;
if (explicitProject) {
  PROJECT_KEY = explicitProject;
} else {
  const cfg = loadProjectsConfig();
  PROJECT_KEY = (cfg ? resolveProjectFromCwd(process.cwd(), cfg) : null) ?? "demo";
}

// ─── DL-41 lifecycle runfile path (REPLICATES daemon.ts lcDbPath/lcRunDir/lcRunfile, :959-961) ──────────────
// The shim is a standalone thin client and must NOT import the 92KB daemon (DL-55 affected-area: NOT daemon.ts),
// so it re-derives the stable runfile path convention here — this comment is the drift tripwire against
// daemon.ts. runDir = DEVLOOP_RUN_DIR ?? dirname(DEVLOOP_HUB_DB ?? ~/.dev-loop/hub.db); file = daemon-<key>.json.
const DB_PATH = process.env.DEVLOOP_HUB_DB ?? join(homedir(), ".dev-loop", "hub.db");
const RUN_DIR = process.env.DEVLOOP_RUN_DIR ?? dirname(DB_PATH);
const RUNFILE = join(RUN_DIR, `daemon-${PROJECT_KEY}.json`);

// Resolve the daemon's loopback port WITHOUT hardcoding 8787 (folded critique #89): an explicit
// DEVLOOP_HUB_PORT override wins (a foreground `npm run daemon` writes NO runfile; tests inject the in-process
// port), else the DL-41 lifecycle runfile's recorded port. null ⇒ neither is available (→ a clear MCP error).
// Re-read per call ON PURPOSE (not memoized): the DL-41 daemon can restart on a new port mid-session, and the
// shim must follow the live runfile without itself restarting — a cached port would go stale → false ECONNREFUSED.
function resolvePort(): number | null {
  const envPort = process.env.DEVLOOP_HUB_PORT?.trim();
  if (envPort) { const n = Number(envPort); if (Number.isInteger(n) && n > 0 && n < 65536) return n; }
  try {
    const info = JSON.parse(readFileSync(RUNFILE, "utf8")) as { port?: unknown };
    if (typeof info.port === "number" && Number.isInteger(info.port) && info.port > 0) return info.port;
  } catch { /* no/garbled runfile → the daemon was not lifecycle-started here */ }
  return null;
}

// ─── MCP result helpers (byte-identical to server.ts:117-118 so a 2xx body produces an IDENTICAL tool result) ──
type McpResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): McpResult => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (message: string): McpResult => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] });

// The two "can't reach a working op-API" failure modes get a CLEAR, actionable MCP error (DL-55 AC), never a
// silent hang or an opaque 500. Loopback only (§16) — the shim only ever talks to 127.0.0.1.
const daemonDown = (detail: string): McpResult => err(
  `dev-loop daemon for project '${PROJECT_KEY}' is not reachable on 127.0.0.1${detail}. Start it ` +
  `(\`cd hub && DEVLOOP_PROJECT=${PROJECT_KEY} npm run daemon\`, or the DL-42 SessionStart hook runs ` +
  `\`dev-loop-hub daemon up\`), or set DEVLOOP_HUB_PORT. This daemon-transport shim proxies to the loopback ` +
  `op-API and needs the daemon running; the default \`node hub/src/server.ts\` entry needs no daemon.`);
const opApiDormant = (): McpResult => err(
  `dev-loop daemon is running but its agent op-API is dormant for project '${PROJECT_KEY}'. Opt in by setting ` +
  `settings_json.hub.transport="daemon" (DL-43), or use the default direct-db entry \`node hub/src/server.ts\`.`);

// ─── proxy one core op → POST http://127.0.0.1:<port>/api/op/<op> (X-Devloop-Actor: ACTOR), as the MCP shape ──
// daemon {status,body}: a 2xx → ok(body) (identical to server.ts's ok()); a DORMANT-mount 404 (body
// {error:"not found: …"}) → the dormant hint; any other non-2xx → err(body.error) (a genuine op result —
// 400/403/404-not-found/500 forwarded verbatim, parity with the stdio path); a dead/absent daemon (no
// runfile / ECONNREFUSED / timeout) → the daemon-down hint.
function proxy(op: string, args: Record<string, unknown>): Promise<McpResult> {
  const port = resolvePort();
  if (port === null) {
    return Promise.resolve(daemonDown(` (no lifecycle runfile at ${RUNFILE}, and DEVLOOP_HUB_PORT is unset)`));
  }
  const body = JSON.stringify(args ?? {});
  return new Promise<McpResult>((resolve) => {
    let settled = false;
    const finish = (r: McpResult) => { if (!settled) { settled = true; resolve(r); } };
    const req = httpRequest(
      {
        hostname: "127.0.0.1", port, method: "POST", path: `/api/op/${op}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-devloop-actor": ACTOR, // identity env→header (Decision #2/#5) — the only attribution the daemon trusts
        },
      },
      (res) => {
        let d = ""; res.setEncoding("utf8");
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let parsed: unknown = null;
          try { parsed = d ? JSON.parse(d) : null; } catch { /* non-JSON body (a bare daemon error) */ }
          if (status >= 200 && status < 300) { finish(ok(parsed)); return; }
          const emsg = typeof (parsed as { error?: unknown })?.error === "string" ? (parsed as { error: string }).error : "";
          // A dormant mount answers EVERY /api/op/* with 404 {error:"not found: <path>"} (daemon.ts:759),
          // distinct from a genuine op-level 404 ({error:"no such ticket …"}) which is a real result to forward.
          if (status === 404 && (parsed === null || /^not found:/.test(emsg))) { finish(opApiDormant()); return; }
          finish(err(emsg || `op '${op}' failed: HTTP ${status}`));
        });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      const why = e.code === "ECONNREFUSED" ? " (connection refused — a stale runfile / a daemon that died?)"
        : e.message === "timeout" ? " (no response within 30s — the daemon hung?)"
        : ` (${e.code ?? e.message})`;
      finish(daemonDown(why));
    });
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); }); // never a silent hang
    req.end(body);
  });
}

// ─── the MCP server — SAME name/version + the SAME 5 core tool names/schemas as server.ts (a drop-in transport) ──
const server = new McpServer({ name: "dev-loop-hub", version: "0.1.0" });

// whoami — answered LOCALLY from env + cwd-resolution (no daemon op required, so it works even when the daemon
// is down). Reports the resolved actor + project (the P8 identity gate) + the daemon transport it proxies over
// and the resolved base URL (null when no daemon is discoverable yet).
server.registerTool("whoami",
  { description: "The identity this session is acting as, and the active project.", inputSchema: {} },
  async () => { const port = resolvePort(); return ok({ actor: ACTOR, project: PROJECT_KEY, transport: "daemon", url: port ? `http://127.0.0.1:${port}` : null }); });

// ─── list_issues ────────────────────────────────────────────────────────────────
server.registerTool("list_issues", {
  description: "List tickets in the active project. Filter by state, assignee, type, label(s), or a title query.",
  inputSchema: {
    state: z.string().optional(), assignee: z.string().optional(), type: z.string().optional(),
    label: z.string().optional(), labels: z.array(z.string()).optional(), query: z.string().optional(),
    limit: z.number().int().positive().max(250).optional(),
  },
}, async (a) => proxy("list_issues", a));

// ─── get_issue ──────────────────────────────────────────────────────────────────
server.registerTool("get_issue",
  { description: "Get one ticket with its comments.", inputSchema: { id: z.string() } },
  async (a) => proxy("get_issue", a));

// ─── save_issue ─────────────────────────────────────────────────────────────────
server.registerTool("save_issue", {
  description: "Create (omit id) or update (with id) a ticket. labels REPLACE the full set (re-pass all). assignee 'me' = you, null clears.",
  inputSchema: {
    id: z.string().optional(), title: z.string().optional(), description: z.string().optional(),
    type: z.string().optional(), state: z.string().optional(),
    assignee: z.string().nullable().optional(), priority: z.number().int().min(0).max(4).optional(),
    labels: z.array(z.string()).optional(),
    duplicateOf: z.string().nullable().optional(),
    relatedTo: z.array(z.string()).optional(),
  },
}, async (a) => proxy("save_issue", a));

// ─── comments ─────────────────────────────────────────────────────────────────
server.registerTool("save_comment",
  { description: "Add a comment to a ticket (authored as you).", inputSchema: { issueId: z.string(), body: z.string() } },
  async (a) => proxy("save_comment", a));
server.registerTool("list_comments",
  { description: "List a ticket's comments (chronological; the tail is the latest).", inputSchema: { issueId: z.string() } },
  async (a) => proxy("list_comments", a));

// ─── events (Reflect's activity window) ─────────────────────────────────────────
server.registerTool("list_events",
  { description: "Recent attribution/audit events (who did what).", inputSchema: { limit: z.number().int().positive().max(500).optional() } },
  async (a) => proxy("list_events", a));

// ─── P4 documents — read + draft (CAS), operator-published; proxied to the op-API (names/schemas ≡ server.ts) ──
server.registerTool("doc.list", { description: "List this project's documents (no bodies).", inputSchema: { kind: z.string().optional() } },
  async (a) => proxy("doc.list", a));
server.registerTool("doc.get", {
  description: "Get a document by slug or kind. Omit version → the published (current) version; if never published, the latest DRAFT with unpublished:true. version=N → that historical version.",
  inputSchema: { slug: z.string().optional(), kind: z.string().optional(), version: z.number().int().positive().optional() },
}, async (a) => proxy("doc.get", a));
server.registerTool("doc.save", {
  description: "Create (baseVersion 0) or append a new DRAFT version. Optimistic CAS: baseVersion MUST equal the doc's latest version, else CONFLICT (never last-write-wins). NEVER publishes — only the operator can (doc.publish).",
  inputSchema: { slug: z.string(), kind: z.enum(DOC_KINDS), title: z.string().optional(), body: z.string(), baseVersion: z.number().int().min(0), summary: z.string().optional() },
}, async (a) => proxy("doc.save", a));
server.registerTool("doc.history", { description: "A document's version ledger (no bodies; newest first).", inputSchema: { slug: z.string().optional(), kind: z.string().optional() } },
  async (a) => proxy("doc.history", a));
server.registerTool("doc.diff", { description: "Line diff between two versions of a document.", inputSchema: { slug: z.string().optional(), kind: z.string().optional(), from: z.number().int().positive(), to: z.number().int().positive() } },
  async (a) => proxy("doc.diff", a));
server.registerTool("doc.publish", {
  description: "OPERATOR-ONLY: publish a draft version → current (the live doc). Cooperative role-gate (DEVLOOP_ACTOR=operator), not anti-spoof — see §18/HUB-ARCHITECTURE §16.",
  inputSchema: { slug: z.string().optional(), kind: z.string().optional(), version: z.number().int().positive() },
}, async (a) => proxy("doc.publish", a));

await server.connect(new StdioServerTransport());
console.error(`[shim] dev-loop-hub daemon-transport shim ready: actor=${ACTOR} project=${PROJECT_KEY} runfile=${RUNFILE}`);
