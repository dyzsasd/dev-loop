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
// whoami (DL-55), PLUS (DL-62) the doc/event family — list_events + doc.list/get/history/diff/save/publish,
// PLUS (DL-67) the IM channel family — channel.register/send/poll/ack/status, PLUS (DL-68) P7 mirror +
// label/project — mirror.push/mirror.status + list_issue_labels/create_issue_label/get_project. That is the
// FINAL slice: the shim now proxies ALL server.ts tools — a 100% server.ts drop-in.
// The shim holds NO SoR / NO ticket/doc/channel/mirror logic (Decision #3): a pure thin client over the
// op-API (which mirrors server.ts 1:1 via agentops.ts + the shared docstore/channelstore/mirrorstore/labelstore).
//
// DL-85: the tool { name, description, inputSchema } registry is now SHARED from tooldefs.ts (registerTools),
// so the names/schemas can no longer drift between this shim and server.ts by hand — the old "PARITY TRIPWIRE:
// keep the copy byte-identical" convention is retired (the single source IS the guarantee). Each entrypoint
// supplies only its handler factory (server.ts → dispatch; this shim → proxy below).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveIdentity } from "./resolve-project.ts";
import { ok, err, registerTools, type McpResult } from "./tooldefs.ts"; // DL-85: the ONE {name,description,inputSchema} registry + the shared ok()/err() + the McpResult type
import { opRunfilePath, resolveOpPort, postOp } from "./op-client.ts"; // A1: the ONE loopback op-API HTTP client (runfile/port + POST + outcome classification), shared with cli-agentops.ts

// ─── identity + project ──────────────────────────────────────────────────────
// DL-85: the DEVLOOP_ACTOR + DEVLOOP_PROJECT/cwd resolution lives ONCE in resolve-project.ts (was re-derived
// here AND in server.ts) — same rule, so the shim names the same per-project daemon runfile the direct-db
// server would attribute writes to. (The shim ignores projectFromCwd — only server.ts's not-seeded error uses it.)
const { actor: ACTOR, projectKey: PROJECT_KEY, projectResolved } = resolveIdentity();

// The DL-41 runfile path + per-call port resolution + the POST /api/op transport all live in op-client.ts
// (A1 extraction — shared with the CLI write layer, byte-identical behavior); the shim keeps only its
// MCP-shaped rendering of the three outcomes below.
const RUNFILE = opRunfilePath(PROJECT_KEY);

// ─── MCP result helpers + the McpResult type are imported from tooldefs.ts (DL-85 — one definition; a 2xx body ──
// produces an IDENTICAL tool result to server.ts's stdio path because both use the SAME ok()/err()). ───────────

// The two "can't reach a working op-API" failure modes get a CLEAR, actionable MCP error (DL-55 AC), never a
// silent hang or an opaque 500. Loopback only (§16) — the shim only ever talks to 127.0.0.1.
const daemonDown = (detail: string): McpResult => err(
  `dev-loop daemon for project '${PROJECT_KEY}' is not reachable on 127.0.0.1${detail}. Start it ` +
  `(\`DEVLOOP_PROJECT=${PROJECT_KEY} dev-loop daemon up\`, or \`dev-loop daemon up-all\` from an autostart/process manager), ` +
  `or set DEVLOOP_HUB_PORT. This daemon-transport shim proxies to the loopback ` +
  `op-API and needs the daemon running; the default \`node hub/src/server.ts\` entry needs no daemon.`);
const opApiDormant = (): McpResult => err(
  `dev-loop daemon is running but its agent op-API is dormant for project '${PROJECT_KEY}'. Opt in by setting ` +
  `settings_json.hub.transport="daemon" (DL-43), or use the default direct-db entry \`node hub/src/server.ts\`.`);
const noProject = (): McpResult => err(
  "no project resolved. Set DEVLOOP_PROJECT=<key>, or launch from inside a repo configured in ~/.dev-loop/projects.json.");

// ─── proxy one core op → POST http://127.0.0.1:<port>/api/op/<op> (X-Devloop-Actor: ACTOR), as the MCP shape ──
// The HTTP transport (per-call port resolution / request / timeout / dormant-vs-down classification) is
// op-client.ts's resolveOpPort/postOp (A1 extraction — behavior byte-identical to the pre-extraction inline
// client, shared with the CLI write layer). This wrapper renders the three outcomes as MCP results: a 2xx →
// ok(body) (identical to server.ts's ok()); a DORMANT mount → the dormant hint; any other non-2xx →
// err(body.error) plus the body's extra fields (e.g. doc.save's CONFLICT latestVersion/latestAuthor/hint) —
// a genuine op result, 400/403/404-not-found/500 forwarded verbatim, parity with the stdio path's toMcp();
// a dead/absent daemon (no runfile / ECONNREFUSED / timeout) → the daemon-down hint.
async function proxy(op: string, args: Record<string, unknown>): Promise<McpResult> {
  if (!projectResolved) return noProject();
  const port = resolveOpPort(PROJECT_KEY);
  if (port === null) return daemonDown(` (no lifecycle runfile at ${RUNFILE}, and DEVLOOP_HUB_PORT is unset)`);
  const out = await postOp(port, op, args ?? {}, ACTOR); // identity env→header (Decision #2/#5) — the only attribution the daemon trusts
  if (out.kind === "down") return daemonDown(out.detail);
  if (out.kind === "dormant") return opApiDormant();
  const { status, body: parsed } = out;
  if (status >= 200 && status < 300) return ok(parsed);
  const emsg = typeof (parsed as { error?: unknown })?.error === "string" ? (parsed as { error: string }).error : "";
  // forward the body's fields BESIDE `error` (destructured off so it can't clobber the message) —
  // e.g. doc.save's CONFLICT retry data — byte-identical to server.ts's toMcp() spread.
  const { error: _error, ...extra } = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  return err(emsg || `op '${op}' failed: HTTP ${status}`, extra);
}

// ─── the MCP server — the SAME TOOL_NAMES tools/schemas as server.ts (a 100% drop-in transport, DL-85) ───────
const server = new McpServer({ name: "dev-loop-hub", version: "0.1.0" });

// tooldefs.ts owns every tool's { name, description, inputSchema } (shared with server.ts); the shim supplies
// ONLY the handler. whoami is answered LOCALLY from env + cwd-resolution (so it works even when the daemon is
// down) and reports the daemon transport + resolved URL; every other tool proxies to the loopback op-API.
registerTools(server, (name) => {
  if (name === "whoami") {
    return () => {
      const port = projectResolved ? resolveOpPort(PROJECT_KEY) : null;
      return ok({ actor: ACTOR, project: projectResolved ? PROJECT_KEY : null, transport: "daemon", url: port ? `http://127.0.0.1:${port}` : null });
    };
  }
  return (a) => proxy(name, a);
});

await server.connect(new StdioServerTransport());
console.error(`[shim] dev-loop-hub daemon-transport shim ready: actor=${ACTOR} project=${PROJECT_KEY || "(unresolved)"} runfile=${RUNFILE}`);
