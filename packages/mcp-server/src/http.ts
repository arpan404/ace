import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { CredentialRegistry, type Principal } from "./credentials.ts";
import type { ToolRegistry } from "./registry.ts";

export interface McpServerOptions {
  registry: ToolRegistry;
  credentials?: CredentialRegistry;
  port?: number;
  maxRequests?: number;
  maxBodyBytes?: number;
}
export async function startMcpServer(options: McpServerOptions) {
  const credentials =
    options.credentials ?? new CredentialRegistry(() => randomBytes(32).toString("hex"));
  const calls = new WeakMap<Principal, Map<string | number, AbortController>>();
  const handler = createMcpHandler(
    ({ requestInfo }) => {
      const principal = credentials.authenticate(
        bearer(requestInfo?.headers.get("authorization") ?? undefined),
      );
      if (!principal) throw new Error("Unauthorized");
      const server = new Server({ name: "ace", version: "0.1.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", async () => ({
        tools: options.registry.list(principal),
      }));
      server.setRequestHandler("tools/call", async (request, context) => {
        let pending = calls.get(principal);
        if (!pending) {
          pending = new Map();
          calls.set(principal, pending);
        }
        const id = context.mcpReq.id;
        if (pending.has(id))
          return {
            isError: true,
            content: [{ type: "text", text: "Duplicate active request id" }],
          };
        const controller = new AbortController();
        pending.set(id, controller);
        try {
          return await options.registry.call(
            request.params.name,
            request.params.arguments ?? {},
            principal,
            AbortSignal.any([context.mcpReq.signal, controller.signal]),
          );
        } finally {
          pending.delete(id);
          if (!pending.size) calls.delete(principal);
        }
      });
      // Stateless 2025 requests still need cancellation to find the original caller's request.
      server.setNotificationHandler("notifications/cancelled", (notification) => {
        const id = notification.params.requestId;
        if (id !== undefined) calls.get(principal)?.get(id)?.abort();
      });
      return server;
    },
    {
      legacy: "stateless",
      maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024,
      maxSubscriptions: 16,
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024,
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let active = 0;
  let closing = false;
  const http = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      if (!credentials.authenticate(bearer(request.headers.authorization))) {
        response.writeHead(401).end();
        return;
      }
      if (closing || active >= (options.maxRequests ?? 128)) {
        response.writeHead(503).end();
        return;
      }
      active++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          active--;
        }
      };
      response.once("close", release);
      response.once("finish", release);
      void nodeHandler(
        {
          headers: request.headers,
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
          [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
        },
        response,
      ).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    },
  );
  http.maxConnections = 256;
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
  } catch {
    credentials.close();
    await handler.close();
    throw new Error("MCP listener failed");
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing MCP listener address");
  let stopped: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    credentials,
    close(): Promise<void> {
      stopped ??= (async () => {
        closing = true;
        credentials.close();
        await handler.close();
        await new Promise<void>((resolve, reject) => {
          http.close((error) => (error ? reject(error) : resolve()));
          http.closeAllConnections();
        });
      })();
      return stopped;
    },
  };
}
function bearer(header: IncomingMessage["headers"]["authorization"]): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}
