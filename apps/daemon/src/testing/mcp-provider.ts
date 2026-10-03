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
  const threadId = body.result.structuredContent.thread.id;
  const featureUrl = process.env["ACE_TEST_FEATURE_URL"];
  const deviceId = process.env["ACE_TEST_FEATURE_DEVICE"];
  if (featureUrl && deviceId) {
    const responseSchema = z.object({
      result: z.object({
        content: z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            mimeType: z.string().optional(),
            data: z.string().optional(),
          }),
        ),
        isError: z.boolean().optional(),
      }),
    });
    const call = async (name: string, toolArguments: unknown = {}) => {
      const featureResponse = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name,
            arguments: toolArguments,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "fake-provider", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      if (!featureResponse.ok)
        throw new Error(`Feature MCP HTTP failure: ${featureResponse.status}`);
      return responseSchema.parse(await featureResponse.json()).result;
    };
    const successful = async (name: string, toolArguments: unknown = {}) => {
      const result = await call(name, toolArguments);
      if (result.isError)
        throw new Error(`Feature tool failed: ${name}: ${JSON.stringify(result)}`);
      return result;
    };
    const text = (result: z.infer<typeof responseSchema>["result"]) => {
      const contentText = result.content[0]?.text;
      if (!contentText) throw new Error("Missing feature text response");
      return JSON.parse(contentText);
    };
    const catalogResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "fake-provider", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const tools = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })).max(128) }) })
      .parse(await catalogResponse.json()).result.tools;
    const advertised = new Set(tools.map((tool) => tool.name));
    for (const name of [
      ...[
        "navigate",
        "click",
        "type",
        "press",
        "scroll",
        "snapshot",
        "screenshot",
        "evaluate",
        "wait_for",
        "logs",
        "resize",
        "emulate",
      ].map((action) => `ace_browser_${action}`),
      ...["ui_tree", "ui_find", "ui_act", "screenshot", "click", "type", "key", "scroll"].map(
        (action) => `screen_${action}`,
      ),
      ...[
        "list",
        "boot",
        "open_app",
        "open_url",
        "screenshot",
        "ui_tree",
        "find",
        "act",
        "tap",
        "swipe",
        "type",
        "key",
        "logs",
        "record_start",
        "record_stop",
        "install",
      ].map((action) => `device_${action}`),
    ])
      if (!advertised.has(name)) throw new Error(`Missing scoped feature catalog tool: ${name}`);
    await successful("ace_browser_navigate", { url: featureUrl });
    const snapshot = z
      .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string().optional() })) })
      .parse(text(await successful("ace_browser_snapshot")));
    const input = snapshot.nodes.find((node) => node.name === "Name")?.ref;
    const save = snapshot.nodes.find((node) => node.name === "Save")?.ref;
    if (!input || !save) throw new Error("Real browser snapshot lost semantic controls");
    await successful("ace_browser_type", { ref: input, text: "provider-input" });
    await successful("ace_browser_click", { ref: save });
    const screenshot = (await successful("ace_browser_screenshot")).content[0];
    if (
      screenshot?.type !== "image" ||
      screenshot.mimeType !== "image/jpeg" ||
      !screenshot.data ||
      Buffer.from(screenshot.data, "base64").readUInt16BE(0) !== 0xffd8
    )
      throw new Error("Real browser screenshot was not an inline JPEG");
    const screen = z
      .object({ nodes: z.array(z.object({ name: z.string(), ref: z.string() })) })
      .parse(text(await successful("screen_ui_tree")));
    const screenSave = screen.nodes.find((node) => node.name === "Save")?.ref;
    if (!screenSave) throw new Error("Screen tree lost approved target");
    await successful("screen_ui_act", { ref: screenSave, action: "press" });
    const inventory = z
      .object({ devices: z.array(z.object({ id: z.string() })) })
      .parse(text(await successful("device_list")));
    if (!inventory.devices.some((device) => device.id === deviceId))
      throw new Error("Approved device unavailable");
    await successful("device_tap", { deviceId, x: 3, y: 4 });
    if (!(await call("device_tap", { deviceId, x: 9, y: 9, threadId: "another-thread" })).isError)
      throw new Error("Device MCP accepted forged caller identity");
    if (
      !(await call("ace_browser_type", { ref: input, text: "forged", threadId: "another-thread" }))
        .isError
    )
      throw new Error("Browser MCP accepted forged caller identity");
  }
  return threadId;
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
