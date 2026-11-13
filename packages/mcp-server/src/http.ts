import { legacySessions } from "./legacy-sessions.ts";
import { mcpStatusGroups, type StatusReader, aceGuidance } from "./status.ts";
import { SessionAwareness, type AwarenessPort } from "./awareness.ts";
import { resultReader, withChanges } from "./changes.ts";
import { progressHeartbeat } from "./progress-heartbeat.ts";
import { contextResources, createContextRegistry } from "./context-tool.ts";
import type { KnowledgePort } from "./knowledge-tools.ts";
import {
  OpenToolsets,
  holdsOnDemandTools,
  listedOnDemand,
  onDemandToolset,
  aceClient,
  callBudgetHeader,
  callBudgetSeconds,
  codexClientHeader,
  coreToolsHeader,
  dispatches,
  namesDestructiveTools,
  toolListing,
} from "./toolsets.ts";
import { aceToolDispatch, aceToolSearch, bareToolName, dispatchedAceCall } from "./tool-names.ts";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createMetaRegistry, foundFamilies } from "./meta-tools.ts";
import { PrincipalEventBus, listenStreamsPerLease } from "./principal-bus.ts";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CredentialRegistry, type Authenticator, type Principal } from "./credentials.ts";
import { bearerChallenge, scopeRefusal, type ScopeChallenge } from "./scope-challenge.ts";
import {
  nodeScheduler,
  type CatalogTool,
  type Scheduler,
  type SessionTools,
  type ToolRegistry,
} from "./registry.ts";

export type { ScopeChallenge } from "./scope-challenge.ts";
/**
 * Serves one MCP request that arrived at `resource`, the MCP URL the client used (ADR 0122):
 * the bearer must be valid there, a tool call outside its scope gets 403, and challenges name
 * that resource. The caller has already checked how the request arrived (Host, Origin).
 */
export type ResourceFetch = (request: Request, resource: string) => Promise<Response>;
/**
 * The resource a request was authenticated at, from `serve` to the MCP handler inside. Always
 * overwritten on the way in, so a client's own copy of the header never counts.
 */
const resourceHeader = "x-ace-mcp-resource";
export interface McpServerOptions<A extends Authenticator = CredentialRegistry> {
  registry: ToolRegistry;
  status?: StatusReader;
  /** What the project already knows, for `context`. Absent: `context` reports status only. */
  knowledge?: Pick<KnowledgePort, "context">;
  /** Session brief and change digest facts (proposal P1). Absent: plain results. */
  awareness?: AwarenessPort;
  credentials?: A;
  /**
   * OAuth-style answers for an endpoint whose principals hold scopes (ADR 0122): a tool call the
   * principal's scope doesn't cover is refused with 403 `insufficient_scope` before it runs.
   */
  challenge?: ScopeChallenge;
  /**
   * Set: the host serves every loopback request itself (ADR 0122). It checks Host and Origin,
   * decides the resource URL the request arrived at, answers its own paths (OAuth) and hands
   * MCP requests to `serve`. Unset: only `/mcp` on localhost Host and Origin is served.
   */
  loopback?: (request: Request, serve: ResourceFetch) => Promise<Response>;
  port?: number;
  /**
   * Set: when `port` is taken, listen on a free one instead and report the taken port.
   * Unset: a taken port fails the start.
   */
  onPortTaken?: (port: number) => void;
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
export async function startMcpServer<A extends Authenticator = CredentialRegistry>(
  options: McpServerOptions<A>,
) {
  // A provider's own permission mode, read-only included, decides each call; ace only hides a
  // group that is off or that this daemon is not running.
  const availability: Parameters<ToolRegistry["setAvailability"]>[0] = (caller) => {
    const state = options.status?.(caller);
    return (name, capability) => {
      if (state?.onlyTools && !state.onlyTools.includes(bareToolName(name))) return false;
      if (state?.unavailableTools?.includes(bareToolName(name))) return false;
      if (capability && state?.disabled?.[capability] !== undefined) return false;
      if (bareToolName(name) === "ask" && state?.askAvailable === false) return false;
      return true;
    };
  };
  options.registry.setAvailability(availability);
  const status = createContextRegistry(options.registry, options.status, options.knowledge);
  // `context` (and its resources) answers to the same rules as every other tool.
  status.setAvailability(availability);
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
  const credentials: A | CredentialRegistry =
    options.credentials ?? new CredentialRegistry(() => randomBytes(32).toString("hex"));
  let runtime: Promise<Awaited<ReturnType<typeof createHandler>>> | undefined;
  const streams = { ...defaultStreamLimits, ...options.notificationStreams };
  const load = () => (runtime ??= createHandler(options, streams, credentials, status, awareness));
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const serve: ResourceFetch = async (request, resource) => {
    if (closing) return new Response(null, { status: 503 });
    const { fetch } = await load();
    const principal = credentials.authenticate(
      bearer(request.headers.get("authorization") ?? undefined),
      resource,
    );
    if (!principal)
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": bearerChallenge(options.challenge?.parameters?.(resource) ?? {}),
        },
      });
    const headers = new Headers(request.headers);
    headers.set(resourceHeader, resource);
    const method = request.method;
    let body: ReadableStream<Uint8Array> | string | null = request.body;
    if (options.challenge && method === "POST") {
      const checked = await scopeRefusal(
        streamChunks(request.body),
        principal,
        options.challenge,
        maxBody,
        resource,
      );
      if (checked.kind === "refuse")
        return new Response(checked.body, { status: checked.status, headers: checked.headers });
      // A JSON-RPC body that passed the check: text, as the handler reads it.
      body = checked.body.toString("utf8");
    }
    return fetch(
      new Request(request.url, {
        method,
        headers,
        signal: request.signal,
        ...(method === "GET" || method === "HEAD" ? {} : { body, duplex: "half" }),
      }),
    );
  };
  let loopback: ReturnType<typeof import("@modelcontextprotocol/node").toNodeHandler> | undefined;
  const loopbackHandler = async () => {
    const host = options.loopback;
    if (!host) return undefined;
    const { toNodeHandler } = await import("@modelcontextprotocol/node");
    return (loopback ??= toNodeHandler(
      { fetch: (request: Request) => host(request, serve) },
      { maxRequestBodySize: maxBody },
    ));
  };
  let active = 0;
  let closing = false;
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
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
    void Promise.all([load(), loopbackHandler()])
      .then(([{ nodeHandler, validateHost, validateOrigin }, hosted]) => {
        if (closing || response.destroyed) return;
        if (hosted) return hosted(nodeRequest(request), response);
        if (!validateHost(request, response) || !validateOrigin(request, response)) return;
        if (request.url !== "/mcp") {
          response.writeHead(404).end();
          return;
        }
        const principal = credentials.authenticate(bearer(request.headers.authorization));
        if (!principal) {
          response
            .writeHead(401, {
              "www-authenticate": bearerChallenge(options.challenge?.parameters?.(undefined) ?? {}),
            })
            .end();
          return;
        }
        // Only `serve` says which resource a request arrived at.
        const { [resourceHeader]: _ignored, ...headers } = request.headers;
        const forward = (body?: Buffer) =>
          nodeHandler(
            {
              headers,
              ...(request.method === undefined ? {} : { method: request.method }),
              ...(request.url === undefined ? {} : { url: request.url }),
              [Symbol.asyncIterator]: body
                ? async function* () {
                    yield body;
                  }
                : () => request[Symbol.asyncIterator](),
            },
            response,
          );
        if (!options.challenge || request.method !== "POST") return forward();
        return scopeRefusal(request, principal, options.challenge, maxBody).then((checked) => {
          if (closing || response.destroyed) return;
          if (checked.kind === "forward") return forward(checked.body);
          response.writeHead(checked.status, checked.headers).end(checked.body);
        });
      })
      .catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
  };
  const http = createServer(
    { maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 },
    handle,
  );
  // Every open notification stream holds a socket; calls keep their own headroom beside them.
  http.maxConnections = 2 * streams.total + 256;
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        http.off("listening", listening);
        reject(error);
      };
      const listening = () => {
        http.off("error", failed);
        resolve();
      };
      http.once("error", failed);
      http.once("listening", listening);
      http.listen(port, "127.0.0.1");
    });
  try {
    try {
      await listen(options.port ?? 0);
    } catch (error) {
      // A remembered port another program took: listen anywhere, and say so.
      if (!options.onPortTaken || !options.port || !isAddressInUse(error)) throw error;
      options.onPortTaken(options.port);
      await listen(0);
    }
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
    /**
     * Serves a loopback request that arrived on another local listener (the daemon's own port),
     * exactly as this listener would: same Host and Origin checks, bearer, leases and streams.
     */
    handleHttp: handle,
    /** Serves an MCP request that arrived elsewhere (Tailscale, a relay) at `resource`. */
    serve,
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
/**
 * A Node request listener over a web handler, for hosts serving outside requests on listeners of
 * their own (the Tailscale listener). Bodies are capped like the MCP listener's.
 */
export async function nodeListener(
  fetch: (request: Request) => Promise<Response>,
  maxBodyBytes = 64 * 1024,
) {
  const { toNodeHandler } = await import("@modelcontextprotocol/node");
  const handle = toNodeHandler({ fetch }, { maxRequestBodySize: maxBodyBytes });
  return (request: IncomingMessage, response: ServerResponse) =>
    handle(nodeRequest(request), response);
}
/** The parts of a Node request the SDK's adapter reads, with no optional fields left unset. */
function nodeRequest(request: IncomingMessage) {
  return {
    headers: request.headers,
    method: request.method ?? "GET",
    url: request.url ?? "/",
    [Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
  };
}
function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
/** A web body as chunks, for the bounded scope check. */
async function* streamChunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
function bearer(header: IncomingMessage["headers"]["authorization"]): string {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

async function createHandler(
  options: McpServerOptions<Authenticator>,
  streams: NotificationStreamLimits,
  credentials: Authenticator,
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
      requestInfo?.headers.get(resourceHeader) ?? undefined,
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
    const direct = (name: string, args: unknown, signal: AbortSignal, actingFor?: string) => {
      const registry = registryFor(name);
      return registry.call(name, args, principal, signal, {
        listing,
        ...(client ? { client } : {}),
        ...(callBudget ? { callBudgetSeconds: callBudget } : {}),
        ...(registry === meta ? { session } : {}),
        ...(actingFor ? { actingFor } : {}),
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
          : // Every group; the native-app tool follows the screen tools this daemon registered.
            { instructions: aceGuidance(undefined, options.registry.names()) }),
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
        ? toolsets.add(principal, foundFamilies(result.structuredContent))
        : toolsets.opened(principal, call.name, call.input);
    };
    // A session listing every tool still holds the simulator tools back until devices are
    // first used, where its client reloads (`holdsOnDemandTools`).
    const holds = holdsOnDemandTools(listing, client);
    const held = (tool: string) =>
      holds && listedOnDemand(tool) && !toolsets.isOpen(principal, onDemandToolset);
    /** Whether a successful call changed what this session lists, so its client must reload. */
    const grows = (name: string, args: unknown, result: CallToolResult): boolean => {
      if (listing === "core") return opens(name, args, result);
      if (!holds || toolsets.isOpen(principal, onDemandToolset)) return false;
      opens(name, args, result);
      return toolsets.isOpen(principal, onDemandToolset);
    };
    const namesDestructive = namesDestructiveTools(listing, client);
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        ...status.list(principal),
        ...meta.list(principal),
        ...options.registry.list(principal),
      ]
        .filter(
          (tool) =>
            (toolsets.lists(principal, listing, tool.name, options.registry.toolset(tool.name)) &&
              !held(tool.name)) ||
            (namesDestructive && tool.annotations?.destructiveHint === true),
        )
        // There tools_call never reaches a destructive tool, and its annotations say so.
        .map((tool) =>
          namesDestructive && bareToolName(tool.name) === aceToolDispatch
            ? notDestructive(tool)
            : tool,
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
          actingForOf(request.params["_meta"]),
        ).finally(stopBeats);
        // Only this session's list grows, and only it needs to reload.
        if (!result.isError && grows(name, args, result)) announce(principal);
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
    credentials.authenticate(
      bearer(request.headers.get("authorization") ?? undefined),
      request.headers.get(resourceHeader) ?? undefined,
    );
  const legacy = await legacySessions(factory, authenticate, {
    total: streams.total,
    overflow: (request) => handler.fetch(request),
  });
  const fetch = async (request: Request): Promise<Response> => {
    if (request.headers.get("X-Ace-Notifications") === "stream" && (await isLegacyRequest(request)))
      return legacy.fetch(request);
    // A listen stream opened by this request belongs to its lease (`principal-bus.ts`).
    const principal = authenticate(request);
    // The SDK refuses a listen whose Mcp-Method header disagrees with its body.
    if (principal && request.headers.get("mcp-method") === "subscriptions/listen")
      return bus.listening(principal, (signal) =>
        handler.fetch(new Request(request, { signal: AbortSignal.any([request.signal, signal]) })),
      );
    return bus.serving(principal, () => handler.fetch(request));
  };
  const nodeHandler = toNodeHandler(
    { fetch },
    { maxRequestBodySize: options.maxBodyBytes ?? 64 * 1024 },
  );
  announce = (principal) => {
    bus.publishTo(principal, { kind: "tools_list_changed" });
    legacy.toolsChangedFor(principal);
  };
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return { handler, legacy, fetch, nodeHandler, validateHost, validateOrigin };
}
function noop(): void {}

/** `_meta` key a client names whom one call is for (`ToolContext.actingFor`). */
export const actingForMetaKey = "ace/acting-for";

/** The client's `ace/acting-for`, when it is a short id; anything else is ignored. */
export function actingForOf(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const value: unknown = Reflect.get(meta, actingForMetaKey);
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

/** A listed tool whose annotations say it never reaches a destructive tool. */
function notDestructive<T extends { annotations?: Record<string, unknown> | undefined }>(
  tool: T,
): T {
  return { ...tool, annotations: { ...tool.annotations, destructiveHint: false } };
}
