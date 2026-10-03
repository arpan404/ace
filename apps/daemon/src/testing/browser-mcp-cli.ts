// ace's synthetic provider CLI boundary. Never launches a provider or performs inference.
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { z } from "zod";
import { registerAcePiExtension, type PiExtensionApi } from "@ace/adapter-pi";
import { join } from "node:path";
import { browserProof } from "./browser-mcp-client.ts";

const mode = z
  .enum(["codex", "opencode", "cursor", "antigravity", "acp", "pi"])
  .parse(process.env.ACE_TEST_BROWSER_PROVIDER);
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(
    mode === "cursor" ? "2026.09.26-offline" : mode === "opencode" ? "2.0.22" : "0.159.1",
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
        `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
      ) {
        response.writeHead(401).end();
        return;
      }
      let text = "";
      for await (const chunk of request) {
        text += chunk.toString();
        if (text.length > 1024 * 1024) throw new Error("Synthetic request too large");
      }
      const body = z.record(z.string(), z.unknown()).parse(text ? JSON.parse(text) : {});
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/api/info") {
        reply({ version: "2.0.22", pid: process.pid });
        return;
      }
      if (path === "/openapi.json") {
        const operations = [
          "server.info",
          "event.subscribe",
          "session.create",
          "session.get",
          "session.list",
          "session.active",
          "session.prompt",
          "session.interrupt",
          "session.message.list",
          "session.permission.list",
          "session.permission.reply",
          "session.form.list",
          "session.form.reply",
          "session.form.cancel",
          "session.inbox.list",
          "shell.list",
          "shell.get",
          "shell.remove",
          "model.list",
        ];
        reply({
          openapi: "3.1.0",
          paths: Object.fromEntries(
            operations.map((operationId, index) => [`/api/${index}`, { get: { operationId } }]),
          ),
        });
        return;
      }
      if (path === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: "connected", type: "server.connected", data: {} })}\n\n`,
        );
        return;
      }
      if (path === "/api/session" && request.method === "POST") {
        const mcpProof = await browserProof(configuration.mcp.ace, "http");
        reply({
          data: {
            id: "native",
            projectID: "test",
            location: body.location,
            mcpProof,
            preservedModel: configuration.model,
            echoedSecret: configuration.mcp.ace.headers.Authorization?.slice(7),
            transportDebug: process.env.OPENCODE_PASSWORD,
          },
        });
      } else if (path === "/api/session/native/prompt") {
        reply({ data: { id: body.id, sessionID: "native" } });
      } else if (path === "/api/session/native/interrupt") reply({ interrupted: true });
      else reply({ data: [] });
    })().catch(() => response.writeHead(500).end("Synthetic MCP setup failed"));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic address missing");
    console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }));
  });
} else if (mode === "pi") {
  const tools = new Map<string, Parameters<PiExtensionApi["registerTool"]>[0]>();
  await registerAcePiExtension({
    registerCommand() {},
    appendEntry() {},
    on() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  const browser = tools.get("ace_browser_open");
  const mcpProof = browser
    ? {
        tools: [...tools.keys()],
        opened: await browser.execute(
          "synthetic-proof",
          { url: process.env.ACE_TEST_BROWSER_URL },
          undefined,
        ),
      }
    : undefined;
  for await (const line of createInterface({ input: process.stdin })) {
    const command = z.object({ type: z.string(), id: z.string() }).parse(JSON.parse(line));
    const extension = args[args.indexOf("-e") + 1];
    const data =
      command.type === "get_commands"
        ? {
            commands: [
              {
                name: "ace-rollback",
                source: "extension",
                sourceInfo: { path: extension },
              },
            ],
          }
        : {
            sessionId: "native",
            sessionFile: join(process.cwd(), "synthetic-pi.jsonl"),
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
            mcpProof,
            tools: [...tools.keys()],
          };
    write({ type: "response", command: command.type, id: command.id, success: true, data });
  }
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
