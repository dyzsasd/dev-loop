#!/usr/bin/env node
// `dev-loop notify` — the team's OUTWARD channel (design §6.1). Orthogonal to the report SINK: comms is a
// PUSH (daily digest, escalation), the sink is an archive. team.comms = { provider: slack|lark, webhookEnv }.
// The webhook URL is read from process.env[webhookEnv] at call time — it NEVER lives in dev-loop.json (I5),
// so "copy the workspace folder" carries no secret. DEVLOOP_COMMS_DRYRUN=1 prints the payload (env NAME +
// shape) without a network call and without ever printing the URL.
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "./workspace.ts";
import type { Workspace } from "./team-config.ts";

function die(msg: string, code = 2): never { console.error(`dev-loop notify: ${msg}`); process.exit(code); }

export type Level = "info" | "warn" | "error";
export interface NotifyInput { title?: string; level: Level; text: string }

// Build the provider-specific webhook payload. v1 is text-level; a card upgrade can come later.
export function buildPayload(provider: "slack" | "lark", n: NotifyInput): unknown {
  const head = `[${n.level}]${n.title ? " " + n.title : ""}`;
  const body = `${head}\n${n.text}`;
  if (provider === "slack") return { text: `*${head}*\n${n.text}` };
  return { msg_type: "text", content: { text: body } }; // lark
}

export interface CommsResolved { provider: "slack" | "lark"; webhookEnv: string; url: string | undefined }
export function resolveComms(ws: Workspace): CommsResolved {
  const c = ws.file.team.comms;
  if (!c) die("team.comms is not configured (set provider + webhookEnv in dev-loop.json)", 3);
  return { provider: c.provider, webhookEnv: c.webhookEnv, url: process.env[c.webhookEnv] };
}

export async function notify(ws: Workspace, n: NotifyInput): Promise<number> {
  const { provider, webhookEnv, url } = resolveComms(ws);
  const payload = buildPayload(provider, n);
  if (process.env.DEVLOOP_COMMS_DRYRUN === "1") {
    // Print the shape + the env NAME — never the URL (I5).
    console.log(JSON.stringify({ dryRun: true, provider, env: webhookEnv, payload }));
    return 0;
  }
  if (!url) { console.error(`dev-loop notify: comms env ${webhookEnv} is not set — cannot send`); return 3; }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ac.signal }).finally(() => clearTimeout(t));
    if (r.status >= 200 && r.status < 300) return 0;
    const bodyText = (await r.text().catch(() => "")).slice(0, 200);
    console.error(`dev-loop notify: ${provider} webhook returned ${r.status}: ${bodyText}`);
    return 1;
  } catch (e) { console.error(`dev-loop notify: send failed: ${(e as Error).message}`); return 1; }
}

function parseArgs(argv: string[]): NotifyInput {
  let title: string | undefined; let level: Level = "info"; const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log("usage: dev-loop notify [--title <t>] [--level info|warn|error] <text...>"); process.exit(0); }
    else if (a === "--title") title = argv[++i];
    else if (a === "--level") { const v = argv[++i]; if (v !== "info" && v !== "warn" && v !== "error") die("--level must be info|warn|error"); level = v; }
    else rest.push(a);
  }
  const text = rest.join(" ").trim();
  if (!text) die("a message text is required");
  return { title, level, text };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = parseArgs(process.argv.slice(2));
  const ws = resolveWorkspace();
  notify(ws, input).then((c) => process.exit(c));
}
