// Offline CLI double. A real loopback request proves the native configuration works.
import { readPrivateMcpConfig } from "@ace/mcp-server";
import { validateNativeMcpConfig, shellExposesBearer } from "./provider-mcp-config.ts";
import { z } from "zod";
import { proof } from "./provider-mcp-proof.ts";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
const provider = z
  .enum(["claude", "codex", "opencode", "cursor", "antigravity", "acp", "pi"])
  .parse(process.env["ACE_TEST_PROVIDER"]);
const HttpServer = z.object({ url: z.string(), headers: z.object({ Authorization: z.string() }) });
const AcpServer = z.object({
  type: z.literal("http"),
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
          ? "opencode v2.0.22"
          : provider === "pi"
            ? "0.85.1"
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

if (provider === "opencode") {
  let config: z.infer<typeof HttpServer> | undefined;
  let mcpProof: string | undefined;
  const operations = [
    "server.info",
    "event.subscribe",
    "session.create",
    "session.get",
    "session.switchModel",
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
  if (!args.includes("--stdio") || !process.env["OPENCODE_PASSWORD"])
    throw new Error("Missing v2 owned server options");
  const streams = new Set<import("node:http").ServerResponse>();
  const server = createServer(async (req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from(`opencode:${process.env["OPENCODE_PASSWORD"]}`).toString("base64")}`
    ) {
      res.writeHead(401).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "connected", type: "server.connected", data: {} })}\n\n`,
      );
      streams.add(res);
      res.on("close", () => streams.delete(res));
      return;
    }
    let result: unknown;
    if (path === "/api/mcp") {
      result = {
        data: config
          ? [{ name: "ace", status: { status: mcpProof ? "connected" : "pending" } }]
          : [],
        ...(mcpProof && config
          ? {
              mcpProof,
              shellExposesBearer: shellExposesBearer(config.headers.Authorization),
              echoedAuthorization: config.headers.Authorization,
              echoedBearerRaw: config.headers.Authorization.slice(7),
            }
          : {}),
      };
    } else if (path === "/api/experimental/mcp/ace" && req.method === "PUT") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const value = z
        .object({ config: z.record(z.string(), z.unknown()) })
        .parse(JSON.parse(body)).config;
      validateNativeMcpConfig("opencode", { mcp: { servers: { ace: value } } });
      if (value["codemode"] !== false || value["disabled"] !== false)
        throw new Error("ace tools must appear directly in the native harness");
      config = HttpServer.parse(value);
      res.writeHead(204).end();
      return;
    } else if (path === "/api/experimental/mcp/ace/connect") {
      if (!config) throw new Error("ace server was not registered");
      mcpProof = await proof(config.url, config.headers.Authorization);
      res.writeHead(204).end();
      return;
    } else if (path === "/api/info") result = { version: "2.0.22", pid: process.pid };
    else if (path === "/openapi.json")
      result = {
        openapi: "3.1.0",
        paths: Object.fromEntries(
          operations.map((operationId, i) => [`/api/${i}`, { get: { operationId } }]),
        ),
      };
    else if (path === "/api/session" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 65536) throw new Error("Fake request exceeds bound");
      }
      const input = z
        .object({ location: z.object({ directory: z.string() }) })
        .parse(JSON.parse(body));
      result = {
        data: {
          id: "native",
          projectID: "project",
          location: input.location,
        },
      };
    } else if (path.endsWith("/interrupt")) result = { interrupted: true };
    else {
      // Older providers may not offer optional metadata APIs such as command.list.
      res
        .writeHead(404, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "not_found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fake address");
    console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}` }));
  });
  process.stdin.resume();
  process.stdin.on("end", () => {
    for (const stream of streams) stream.end();
    server.close();
  });
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const message = Message.parse(JSON.parse(line));
    const request = message.params ?? message.request ?? {};
    if (provider === "pi") {
      if (message.type === "get_commands") {
        const native = z
          .object({ mcp: z.object({ url: z.url(), bearer: z.string() }) })
          .parse(
            JSON.parse(readPrivateMcpConfig(z.string().parse(process.env["ACE_PI_SESSION_FILE"]))),
          );
        const url = native.mcp.url;
        const authorization = `Bearer ${native.mcp.bearer}`;
        write({
          type: "response",
          id: message.id,
          command: message.type,
          success: true,
          data: {
            commands: [
              {
                name: "ace-rollback",
                source: "extension",
                sourceInfo: { path: args[args.indexOf("-e") + 1] },
              },
            ],
            mcpProof: await proof(url, authorization),
            shellExposesBearer: shellExposesBearer(authorization),
            echoedAuthorization: authorization,
          },
        });
      } else if (message.type === "get_state")
        write({
          type: "response",
          id: message.id,
          command: message.type,
          success: true,
          data: {
            sessionFile: `${process.cwd()}/pi-session.jsonl`,
            sessionId: "native",
            isStreaming: false,
            isCompacting: false,
            pendingMessageCount: 0,
          },
        });
      else if (message.id !== undefined)
        write({ type: "response", id: message.id, command: message.type, success: true, data: {} });
    } else if (provider === "claude") {
      if (message.type !== "control_request") continue;
      if (request["subtype"] === "initialize") {
        if (process.env["MCP_TOOL_TIMEOUT"] !== "300000")
          throw new Error("Claude tool deadline cannot accommodate origin approval");
        const config = z
          .object({ mcpServers: z.object({ ace: HttpServer.extend({ type: z.literal("http") }) }) })
          .parse(JSON.parse(readPrivateMcpConfig(args[args.indexOf("--mcp-config") + 1] ?? "")))
          .mcpServers.ace;
        write({
          type: "system",
          subtype: "mcp_proof",
          mcpProof: await proof(config.url, config.headers.Authorization),
          shellExposesBearer: shellExposesBearer(config.headers.Authorization),
          privateConfigPath: args[args.indexOf("--mcp-config") + 1],
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
        const config = z.record(z.string(), z.unknown()).parse(request["config"])[
          "mcp_servers.ace"
        ];
        validateNativeMcpConfig("codex", config);
        const server = z
          .object({
            url: z.url(),
            http_headers: z.object({ Authorization: z.string() }),
            tool_timeout_sec: z.literal(300),
          })
          .parse(config);
        url = server.url;
        authorization = server.http_headers.Authorization;
      } else {
        for (const server of z.array(z.unknown()).parse(request["mcpServers"]))
          validateNativeMcpConfig("acp", server);
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
            ? {
                thread: { id: "native" },
                mcpProof,
                shellExposesBearer: shellExposesBearer(authorization),
                echoedAuthorization: authorization,
              }
            : {
                sessionId: "native",
                mcpProof,
                shellExposesBearer: shellExposesBearer(authorization),
                echoedAuthorization: authorization,
              },
      });
    } else if (message.id !== undefined) write({ id: message.id, result: {} });
  }
}
