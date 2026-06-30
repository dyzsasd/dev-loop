// One-shot hub MCP client. Spawns the hub server as a chosen actor and calls one tool.
// Usage: DEVLOOP_ACTOR=pm node hubcall.mjs <tool> '<json-args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const env = {
  ...process.env,
  DEVLOOP_ACTOR: process.env.DEVLOOP_ACTOR || "pm",
  DEVLOOP_PROJECT: process.env.DEVLOOP_PROJECT || "dev-loop",
  DEVLOOP_HUB_DB: process.env.DEVLOOP_HUB_DB || join(process.env.HOME, ".dev-loop", "hub.db"),
};

const transport = new StdioClientTransport({
  command: "node",
  args: [join(here, "src", "server.ts")],
  env,
});
const client = new Client({ name: "pm-agent-cli", version: "1.0.0" });
await client.connect(transport);

if (tool === "__list") {
  const tools = await client.listTools();
  console.log(JSON.stringify(tools.tools.map((t) => t.name), null, 2));
} else {
  const res = await client.callTool({ name: tool, arguments: args });
  const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(text);
  if (res.isError) process.exitCode = 2;
}
await client.close();
