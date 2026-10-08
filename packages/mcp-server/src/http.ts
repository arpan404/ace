import { legacySessions } from "./legacy-sessions.ts";
import { createStatusRegistry, type StatusReader, aceInstructions } from "./status.ts";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { nodeScheduler } from "./registry.ts";
import { CredentialRegistry, type Principal } from "./credentials.ts";
import type { ToolRegistry } from "./registry.ts";

export interface McpServerOptions {
  registry: ToolRegistry;
  status?: StatusReader;
  credentials?: CredentialRegistry;
  port?: number;
  maxRequests?: number;
  maxBodyBytes?: number;
}
export async function startMcpServer(options: McpServerOptions) {
  options.registry.setAvailability((caller) => {
    const state = options.status?.(caller);
    let screenApproved: boolean | undefined;
    return (name, capability) => {
      if (capability && state?.disabled?.[capability] !== undefined) return false;
      if (capability === "screen" || capability === "devices") {
        if (state?.permissionMode === "read-only") return false;
        if (capability === "screen" && name !== "screen_request_app") {
          screenApproved ??= state?.screenApproved ?? true;
          if (!screenApproved) return false;
        }
      }
      return true;
    };
  });
  const status = createStatusRegistry(options.registry, options.status);
  const credentials =
    options.credentials ??
    new CredentialRegistry(() => randomBytes(32).toString("hex"), 1024, {
      scheduler: nodeScheduler,
      maxAgeMs: 60 * 60 * 1000,
    });
  let runtime: Promise<Awaited<ReturnType<typeof createHandler>>> | undefined;
  const load = () => (runtime ??= createHandler(options, credentials, status));
  let active = 0;
  let closing = false;
  const http = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
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
      void load()
        .then(({ nodeHandler, validateHost, validateOrigin }) => {
          if (closing || response.destroyed) return;
          if (!validateHost(request, response) || !validateOrigin(request, response)) return;
          if (request.url !== "/mcp") {
            response.writeHead(404).end();
            return;
          }
          if (!credentials.authenticate(bearer(request.headers.authorization))) {
            response.writeHead(401).end();
            return;
          }
          return nodeHandler(
            {
              headers: request.headers,
              ...(request.method === undefined ? {} : { method: request.method }),
              ...(request.url === undefined ? {} : { url: request.url }),
              [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
            },
            response,
          );
        })
        .catch(() => {
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
    const current = await runtime;
    await current?.legacy.close();
    await current?.handler.close();
    throw new Error("MCP listener failed");
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing MCP listener address");
  let stopped: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    credentials,
    toolsChanged(): void {
      if (!closing && runtime)
        void runtime
          .then(({ handler, legacy }) => {
            handler.notify.toolsChanged();
            legacy.toolsChanged();
          })
          .catch(() => {});
    },
    close(): Promise<void> {
      stopped ??= (async () => {
        closing = true;
        credentials.close();
        try {
          const current = await runtime;
          await current?.legacy.close();
          await current?.handler.close();
        } finally {
          await new Promise<void>((resolve, reject) => {
            http.close((error) => (error ? reject(error) : resolve()));
            http.closeAllConnections();
          });
        }
      })();
      return stopped;
    },
  };
}
function bearer(header: IncomingMessage["headers"]["authorization"]): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

async function createHandler(
  options: McpServerOptions,
  credentials: CredentialRegistry,
  status: ToolRegistry,
) {
  const { McpServer, createMcpHandler, isLegacyRequest } =
    await import("@modelcontextprotocol/server");
  const { localhostHostValidation, localhostOriginValidation, toNodeHandler } =
    await import("@modelcontextprotocol/node");
  const calls = new WeakMap<Principal, Map<string | number, AbortController>>();
  const factory: import("@modelcontextprotocol/server").McpServerFactory = ({ requestInfo }) => {
    const principal = credentials.authenticate(
      bearer(requestInfo?.headers.get("authorization") ?? undefined),
    );
    if (!principal) throw new Error("Unauthorized");
    const caller = principal;
    // The HTTP SDK validates mirrored parameters only for McpServer products. Reuse
    // our prepared schema by name instead of registering/scanning every tool per call.
    class RegistryServer extends McpServer {
      override toolInputSchemaJson(name: string) {
        return (name === "ace_status" ? status : options.registry).inputSchema(name, caller);
      }
    }
    const product = new RegistryServer(
      { name: "ace", version: "0.1.0" },
      {
        ...(requestInfo?.headers.get("X-Ace-Instructions") === "native"
          ? {}
          : { instructions: aceInstructions }),
        capabilities: { tools: { listChanged: true }, resources: {} },
      },
    );
    const server = product.server;
    server.setRequestHandler("resources/list", async () => ({
      resources: [
        {
          uri: "ace://status",
          name: "ace status",
          description:
            "Current connection, tool availability and permission mode. Also call ace_status.",
          mimeType: "application/json",
        },
      ],
    }));
    server.setRequestHandler("resources/read", async (request, context) => {
      if (request.params.uri !== "ace://status") throw new Error("Unknown resource");
      const result = await status.call("ace_status", {}, principal, context.mcpReq.signal);
      if (result.isError || !result.structuredContent) throw new Error("Status unavailable");
      return {
        contents: [
          {
            uri: "ace://status",
            mimeType: "application/json",
            text: JSON.stringify(result.structuredContent),
          },
        ],
      };
    });
    server.setRequestHandler("tools/list", async () => ({
      tools: [...status.list(principal), ...options.registry.list(principal)],
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
        const registry = request.params.name === "ace_status" ? status : options.registry;
        return await registry.call(
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
    return product;
  };
  const handler = createMcpHandler(factory, {
    legacy: "stateless",
    maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024,
    maxSubscriptions: 16,
  });
  const legacy = await legacySessions(factory, (request) =>
    credentials.authenticate(bearer(request.headers.get("authorization") ?? undefined)),
  );
  const nodeHandler = toNodeHandler(
    {
      fetch: async (request: Request) => {
        if (
          request.headers.get("X-Ace-Notifications") === "stream" &&
          (await isLegacyRequest(request))
        )
          return legacy.fetch(request);
        return handler.fetch(request);
      },
    },
    {
      maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024,
    },
  );
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return { handler, legacy, nodeHandler, validateHost, validateOrigin };
}
