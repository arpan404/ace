// Offline CLI double. A real loopback request proves the native configuration works.
import { z } from "zod";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
const provider = z
  .enum(["claude", "codex", "opencode", "cursor", "antigravity", "acp"])
  .parse(process.env["ACE_TEST_PROVIDER"]);
const HttpServer = z.object({ url: z.string(), headers: z.object({ Authorization: z.string() }) });
const AcpServer = z.object({
  name: z.string(),
  url: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
});
const Message = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  request: z.record(z.string(), z.unknown()).optional(),
  request_id: z.string().optional(),
});
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(
    provider === "claude"
      ? "2.1.286 (Claude Code)"
      : provider === "codex"
        ? "codex-cli 0.159.1"
        : provider === "opencode"
          ? "1.18.33"
          : "2026.09.26-test",
  );
  process.exit(0);
}
if (args.includes("status")) {
  console.log("Logged in");
  process.exit(0);
}
if (provider === "opencode" && args[0] !== "serve") {
  console.log("No credentials configured");
  process.exit(0);
}
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function proof(url: string, authorization: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "ace_thread_info",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ace_thread_info",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "fake-provider", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`MCP authentication failed: ${response.status}`);
  const body = z
    .object({
      result: z.object({ structuredContent: z.object({ thread: z.object({ id: z.string() }) }) }),
    })
    .parse(await response.json());
  return body.result.structuredContent.thread.id;
}
if (provider === "opencode") {
  const config = z
    .object({ mcp: z.object({ ace: HttpServer }) })
    .parse(JSON.parse(process.env["OPENCODE_CONFIG_CONTENT"] ?? "null")).mcp.ace;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/global/event")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ payload: { type: "server.connected" } })}\n\n`);
      return;
    }
    let result: unknown;
    if (req.url?.startsWith("/mcp"))
      result = {
        ace: {
          status: "connected",
          mcpProof: await proof(config.url, config.headers.Authorization),
          echoedAuthorization: config.headers.Authorization,
        },
      };
    else if (req.url?.startsWith("/session"))
      result = { id: "native", projectID: "project", directory: "test" };
    else result = {};
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  });
  const port = Number(args[args.indexOf("--port") + 1]);
  server.listen(port, "127.0.0.1", () =>
    console.log(`opencode server listening on http://127.0.0.1:${port}`),
  );
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = Message.parse(JSON.parse(line));
    const request = message.params ?? message.request ?? {};
    if (provider === "claude") {
      if (message.type !== "control_request") continue;
      if (request["subtype"] === "initialize") {
        const config = z
          .object({ mcpServers: z.object({ ace: HttpServer }) })
          .parse(JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "null")).mcpServers.ace;
        write({
          type: "system",
          subtype: "mcp_proof",
          mcpProof: await proof(config.url, config.headers.Authorization),
          echoedAuthorization: config.headers.Authorization,
        });
      }
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { commands: [], agents: [], models: [] },
        },
      });
    } else if (message.method === "initialize") {
      write({
        id: message.id,
        result:
          provider === "codex"
            ? { userAgent: "ace" }
            : {
                protocolVersion: 1,
                agentInfo: { name: "antigravity-acp" },
                agentCapabilities: { mcpCapabilities: { http: !args.includes("--no-mcp") } },
              },
      });
    } else if (
      ["thread/start", "thread/resume", "session/new", "session/load"].includes(
        message.method ?? "",
      )
    ) {
      let url, authorization;
      if (provider === "codex") {
        const setting = args.find((arg) => arg.startsWith("mcp_servers.ace.url="));
        if (!setting) throw new Error("Missing Codex MCP URL");
        url = z.string().parse(JSON.parse(setting.slice(setting.indexOf("=") + 1)));
        authorization = `Bearer ${process.env["ACE_MCP_BEARER_TOKEN"]}`;
      } else {
        const config = z
          .array(AcpServer)
          .parse(request["mcpServers"])
          .find((server) => server.name === "ace");
        if (!config) throw new Error("Missing ACP MCP server");
        url = config.url;
        authorization = config.headers.find((header) => header.name === "Authorization")?.value;
        if (!authorization) throw new Error("Missing ACP MCP authority");
      }
      const mcpProof = await proof(url, authorization);
      write({
        id: message.id,
        result:
          provider === "codex"
            ? { thread: { id: "native" }, mcpProof, echoedAuthorization: authorization }
            : { sessionId: "native", mcpProof, echoedAuthorization: authorization },
      });
    } else if (message.id !== undefined) write({ id: message.id, result: {} });
  }
}
