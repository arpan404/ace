// ace's synthetic provider CLI boundary. Never launches a provider or performs inference.
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { z } from "zod";
import { browserProof } from "./browser-mcp-client.ts";

const mode = z
  .enum(["codex", "opencode", "cursor", "antigravity", "acp"])
  .parse(process.env.ACE_TEST_BROWSER_PROVIDER);
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(
    mode === "cursor" ? "2026.09.26-offline" : mode === "opencode" ? "1.18.33" : "0.159.1",
  );
  process.exit(0);
}
if (args[0] === "status") {
  console.log("synthetic local status");
  process.exit(0);
}
const pair = z.object({ name: z.string(), value: z.string() });
const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});
const write = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);

function codexConnection() {
  const option = args.find((arg) => arg.startsWith("mcp_servers.ace.url="));
  if (!option || !args.includes('mcp_servers.ace.bearer_token_env_var="ACE_MCP_BEARER_TOKEN"'))
    throw new Error("Codex MCP launch options missing");
  return {
    url: z.url().parse(JSON.parse(option.slice(option.indexOf("=") + 1))),
    headers: { Authorization: `Bearer ${z.string().parse(process.env.ACE_MCP_BEARER_TOKEN)}` },
  };
}
async function acpProof(params: Record<string, unknown>) {
  const servers = z
    .array(z.object({ name: z.string() }).passthrough())
    .max(64)
    .parse(params.mcpServers);
  const raw = servers.find((server) => server.name === "ace");
  if (!raw) throw new Error("ACP MCP injection missing");
  const http = process.env.ACE_TEST_ACP_HTTP !== "0";
  const server = http
    ? z.object({ type: z.literal("http"), url: z.url(), headers: z.array(pair) }).parse(raw)
    : z.object({ command: z.string(), args: z.array(z.string()), env: z.array(pair) }).parse(raw);
  const config =
    "url" in server
      ? {
          url: server.url,
          headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
        }
      : {
          command: server.command,
          args: server.args,
          env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        };
  return browserProof(config, http ? "http" : "stdio");
}

if (mode === "opencode") {
  const configuration = z
    .object({
      model: z.string(),
      mcp: z.object({
        ace: z.object({
          type: z.literal("remote"),
          enabled: z.literal(true),
          oauth: z.literal(false),
          url: z.url(),
          headers: z.record(z.string(), z.string()),
        }),
        user: z.object({ type: z.literal("local"), command: z.array(z.string()).min(1) }),
      }),
    })
    .parse(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}"));
  const server = createServer((request, response) => {
    const reply = (value: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));

    void (async () => {
      if (
        request.headers.authorization !==
        `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
      ) {
        response.writeHead(401).end();
        return;
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/global/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ payload: { type: "server.connected", properties: {} } })}\n\n`,
        );
        return;
      }
      if (path === "/session" && request.method === "POST") {
        const mcpProof = await browserProof(configuration.mcp.ace, "http");
        reply({ id: "native", projectID: "test", mcpProof, preservedModel: configuration.model });
      } else if (path === "/mcp") reply({ ace: { status: "connected" } });
      else if (path === "/session/native/abort") reply(true);
      else reply([]);
    })().catch(() => response.writeHead(500).end("Synthetic MCP setup failed"));
  });
  server.listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1", () =>
    console.log("opencode server listening on loopback"),
  );
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = Rpc.parse(JSON.parse(line));
    if (message.id === undefined) continue;
    try {
      let result: unknown = {};
      if (message.method === "initialize")
        result =
          mode === "codex"
            ? {}
            : {
                protocolVersion: 1,
                agentInfo: {
                  name: mode === "antigravity" ? "antigravity-acp" : mode,
                  version: "1",
                },
                agentCapabilities: {
                  loadSession: true,
                  mcpCapabilities: { http: process.env.ACE_TEST_ACP_HTTP !== "0" },
                },
              };
      else if (message.method === "thread/start" || message.method === "thread/resume") {
        const mcpProof = await browserProof(codexConnection(), "http");
        result = { thread: { id: "native", turns: [], mcpProof } };
      } else if (message.method === "session/new" || message.method === "session/load") {
        result = { sessionId: "native", mcpProof: await acpProof(message.params) };
      }
      write({ id: message.id, result });
    } catch {
      write({ id: message.id, error: { code: -32603, message: "Synthetic MCP setup failed" } });
    }
  }
}
