import { legacySessions } from "./legacy-sessions.ts";
import { mcpStatusGroups, type StatusReader, aceInstructions } from "./status.ts";
import { SessionAwareness, type AwarenessPort } from "./awareness.ts";
import { resultReader, withChanges } from "./changes.ts";
import { progressHeartbeat } from "./progress-heartbeat.ts";
import { contextResources, createContextRegistry } from "./context-tool.ts";
import type { KnowledgePort } from "./knowledge-tools.ts";
import {
  OpenToolsets,
  aceClient,
  callBudgetHeader,
  callBudgetSeconds,
  codexClientHeader,
  coreToolsHeader,
  dispatches,
  toolListing,
} from "./toolsets.ts";
import { aceToolDispatch, aceToolSearch, bareToolName, dispatchedAceCall } from "./tool-names.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMetaRegistry, foundFamilies } from "./meta-tools.ts";
import { PrincipalEventBus, listenStreamsPerLease } from "./principal-bus.ts";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { CredentialRegistry, type Principal } from "./credentials.ts";
import {
  nodeScheduler,
  type CatalogTool,
  type Scheduler,
  type SessionTools,
  type ToolRegistry,
} from "./registry.ts";

export interface McpServerOptions {
  registry: ToolRegistry;
  status?: StatusReader;
  /** What the project already knows, for `context`. Absent: `context` reports status only. */
  knowledge?: Pick<KnowledgePort, "context">;
  /** Session brief and change digest facts (proposal P1). Absent: plain results. */
  awareness?: AwarenessPort;
  credentials?: CredentialRegistry;
  port?: number;
  maxRequests?: number;
  maxBodyBytes?: number;
  /** Timers for progress beats on long calls (`progress-heartbeat.ts`); tests pass their own. */
  scheduler?: Scheduler;
  /** Bounds on list-change notification streams; tests pass small ones. */
  notificationStreams?: Partial<NotificationStreamLimits>;
}
/**
 * Notification streams are bounded per lease, so every concurrent session can hold one; `total`
 * is only a server-wide guard, applied separately to modern listen streams and to legacy
 * transport sessions.
 */
export interface NotificationStreamLimits {
  perLease: number;
  total: number;
}
const defaultStreamLimits: NotificationStreamLimits = {
  perLease: listenStreamsPerLease,
  total: 512,
};
export async function startMcpServer(options: McpServerOptions) {
  // A provider's own permission mode, read-only included, decides each call; ace only hides a
  // group that is off or that this daemon is not running.
  options.registry.setAvailability((caller) => {
    const state = options.status?.(caller);
    return (name, capability) => {
      if (capability && state?.disabled?.[capability] !== undefined) return false;
      if (bareToolName(name) === "ask" && state?.askAvailable === false) return false;
      return true;
    };
  });
  const status = createContextRegistry(options.registry, options.status, options.knowledge);
  const awareness = options.awareness
    ? new SessionAwareness(
        options.awareness,
        (principal) => {
          const state = options.status?.(principal.scope);
          return mcpStatusGroups(
            options.registry.capabilities(),
            principal.scope.capabilities,
            state?.disabled,
          )
            .filter((group) => group.enabled && group.name !== "thread")
            .map((group) => group.name);
        },
        // What a session listing every tool can call; tools_call is offered only to the others.
        (principal) =>
          [
            ...status.list(principal).map((tool) => tool.name),
            aceToolSearch,
            ...options.registry.list(principal).map((tool) => tool.name),
          ].map(bareToolName),
      )
    : undefined;
  const credentials =
    options.credentials ?? new CredentialRegistry(() => randomBytes(32).toString("hex"));
  let runtime: Promise<Awaited<ReturnType<typeof createHandler>>> | undefined;
  const streams = { ...defaultStreamLimits, ...options.notificationStreams };
  const load = () => (runtime ??= createHandler(options, streams, credentials, status, awareness));
  let active = 0;
  let closing = false;
  const http = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      if (closing || active >= (options.maxRequests ?? 2048)) {
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
  // Every open notification stream holds a socket; calls keep their own headroom beside them.
  http.maxConnections = 2 * streams.total + 256;
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
    awareness,
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
  streams: NotificationStreamLimits,
  credentials: CredentialRegistry,
  status: ToolRegistry,
  awareness: SessionAwareness | undefined,
) {
  const { McpServer, createMcpHandler, isLegacyRequest } =
    await import("@modelcontextprotocol/server");
  const { localhostHostValidation, localhostOriginValidation, toNodeHandler } =
    await import("@modelcontextprotocol/node");
  const calls = new WeakMap<Principal, Map<string | number, AbortController>>();
  const toolsets = new OpenToolsets();
  const meta = createMetaRegistry();
  const registryFor = (name: string) => {
    const bare = bareToolName(name);
    if (bare === "context") return status;
    return bare === aceToolSearch || bare === aceToolDispatch ? meta : options.registry;
  };
  // Set once the handlers exist: a call that opens a toolset re-announces that session's list.
  let announce: (principal: Principal) => void = noop;
  const factory: import("@modelcontextprotocol/server").McpServerFactory = ({ requestInfo }) => {
    const principal = credentials.authenticate(
      bearer(requestInfo?.headers.get("authorization") ?? undefined),
    );
    if (!principal) throw new Error("Unauthorized");
    const caller = principal;
    const listing = toolListing(requestInfo?.headers.get(coreToolsHeader.name));
    const client = aceClient(requestInfo?.headers.get(codexClientHeader.name));
    const callBudget = callBudgetSeconds(requestInfo?.headers.get(callBudgetHeader.name));
    const reader = resultReader(client);
    const catalog = (): CatalogTool[] =>
      [...status.list(principal), ...options.registry.list(principal)].map((tool) => ({
        tool,
        family: options.registry.toolset(tool.name),
      }));
    /** One call exactly as the client made it: the path `tools_call` dispatches through too. */
    const direct = (name: string, args: unknown, signal: AbortSignal) => {
      const registry = registryFor(name);
      return registry.call(name, args, principal, signal, {
        listing,
        ...(client ? { client } : {}),
        ...(callBudget ? { callBudgetSeconds: callBudget } : {}),
        ...(registry === meta ? { session } : {}),
      });
    };
    const session: SessionTools = {
      listing,
      catalog,
      ...(dispatches(listing) ? { dispatch: direct } : {}),
    };
    // The HTTP SDK validates mirrored parameters only for McpServer products. Reuse
    // our prepared schema by name instead of registering/scanning every tool per call.
    class RegistryServer extends McpServer {
      override toolInputSchemaJson(name: string) {
        return registryFor(name).inputSchema(name, caller);
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
        ...(awareness
          ? [
              {
                uri: "ace://session",
                name: "ace session",
                description:
                  "This session's brief: project, branch, access mode, groups, delegation targets, live threads and pending requests, and its roles line.",
                mimeType: "application/json",
              },
            ]
          : []),
        ...contextResources
          .filter((resource) => resource.topic === "status" || options.knowledge)
          .map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: `The context tool's ${resource.topic} topic.`,
            mimeType: "application/json",
          })),
      ],
    }));
    server.setRequestHandler("resources/read", async (request, context) => {
      if (request.params.uri === "ace://session" && awareness) {
        const facts = awareness.facts(principal);
        if (!facts) throw new Error("Session unavailable");
        return {
          contents: [
            {
              uri: "ace://session",
              mimeType: "application/json",
              text: JSON.stringify({
                brief: awareness.brief(principal),
                roles: awareness.rolesLine(principal) ?? null,
                facts,
              }),
            },
          ],
        };
      }
      const resource = contextResources.find((entry) => entry.uri === request.params.uri);
      if (!resource || (resource.topic !== "status" && !options.knowledge))
        throw new Error("Unknown resource");
      const result = await status.call(
        "context",
        { topics: [resource.topic] },
        principal,
        context.mcpReq.signal,
      );
      if (result.isError || !result.structuredContent) throw new Error("Context unavailable");
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: "application/json",
            text: JSON.stringify(
              resource.topic === "status"
                ? Reflect.get(result.structuredContent, "status")
                : result.structuredContent,
            ),
          },
        ],
      };
    });
    /**
     * Whether a successful call adds families to a core-mode session's list. A dispatched call
     * opens what calling its tool directly would.
     */
    const opens = (name: string, args: unknown, result: CallToolResult): boolean => {
      const call = dispatchedAceCall(name, args);
      return bareToolName(call.name) === aceToolSearch
        ? listing === "core" && toolsets.add(principal, foundFamilies(result.structuredContent))
        : toolsets.opened(principal, call.name, call.input);
    };
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        ...status.list(principal),
        ...meta.list(principal),
        ...options.registry.list(principal),
      ].filter((tool) =>
        toolsets.lists(principal, listing, tool.name, options.registry.toolset(tool.name)),
      ),
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
        const { name } = request.params;
        const args = request.params.arguments ?? {};
        const stopBeats = progressHeartbeat(
          context.mcpReq["_meta"]?.progressToken,
          (notification) => context.mcpReq.notify(notification),
          options.scheduler ?? nodeScheduler,
        );
        const result = await direct(
          name,
          args,
          AbortSignal.any([context.mcpReq.signal, controller.signal]),
        ).finally(stopBeats);
        // Only a core session's list grows, and only that session needs to reload it.
        if (!result.isError && listing === "core" && opens(name, args, result)) announce(principal);
        // A dispatched call is remembered as the tool it ran.
        const tool = dispatchedAceCall(name, args).name;
        return awareness ? withChanges(awareness, principal, tool, result, reader) : result;
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
  const bus = new PrincipalEventBus({ perLease: streams.perLease });
  // The SDK cap is server-wide; per-lease replacement happens in `bus.listening` first, so only
  // a lease with no stream of its own meets this refusal (-32603 "Subscription limit reached").
  const handler = createMcpHandler(factory, {
    legacy: "stateless",
    maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024,
    maxSubscriptions: streams.total,
    bus,
  });
  const authenticate = (request: Request) =>
    credentials.authenticate(bearer(request.headers.get("authorization") ?? undefined));
  const legacy = await legacySessions(factory, authenticate, {
    total: streams.total,
    overflow: (request) => handler.fetch(request),
  });
  const nodeHandler = toNodeHandler(
    {
      fetch: async (request: Request) => {
        if (
          request.headers.get("X-Ace-Notifications") === "stream" &&
          (await isLegacyRequest(request))
        )
          return legacy.fetch(request);
        // A listen stream opened by this request belongs to its lease (`principal-bus.ts`).
        const principal = authenticate(request);
        // The SDK refuses a listen whose Mcp-Method header disagrees with its body.
        if (principal && request.headers.get("mcp-method") === "subscriptions/listen")
          return bus.listening(principal, (signal) =>
            handler.fetch(
              new Request(request, { signal: AbortSignal.any([request.signal, signal]) }),
            ),
          );
        return bus.serving(principal, () => handler.fetch(request));
      },
    },
    {
      maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024,
    },
  );
  announce = (principal) => {
    bus.publishTo(principal, { kind: "tools_list_changed" });
    legacy.toolsChangedFor(principal);
  };
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return { handler, legacy, nodeHandler, validateHost, validateOrigin };
}
function noop(): void {}
