import { randomUUID } from "node:crypto";
import type {
  WebStandardStreamableHTTPServerTransport,
  McpServer,
  McpServerFactory,
} from "@modelcontextprotocol/server";
import type { Principal } from "./credentials.ts";

type Session = {
  principal: Principal;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  close(): Promise<void>;
  watch(signal: AbortSignal): void;
};

/** Opted-in legacy clients keep a bounded stream for list changes, owned by their lease.
 * Other legacy clients retain stateless serving. There is no history replay buffer. */
export async function legacySessions(
  factory: McpServerFactory,
  authenticate: (request: Request) => Principal | undefined,
) {
  const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/server");
  const sessions = new Map<string, Session>();
  const pending = new Set<Session>();
  const stopping = new Set<Promise<void>>();
  let opening = 0;
  const openingPrincipals = new Map<Principal, number>();
  return {
    async fetch(request: Request): Promise<Response> {
      const principal = authenticate(request);
      if (!principal) return new Response(null, { status: 401 });
      const id = request.headers.get("Mcp-Session-Id");
      if (id) {
        const session = sessions.get(id);
        if (!session || session.principal !== principal) return new Response(null, { status: 404 });
        const response = await session.transport.handleRequest(request);
        if (request.method === "DELETE") await session.close();
        if (request.method !== "GET" || !response.ok || !response.body) return response;
        // No replay store exists: a disconnected notification stream owns no
        // usable transport state and must release its admission slot.
        session.watch(request.signal);
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                controller.close();
                await session.close();
              } else controller.enqueue(part.value);
            } catch (error) {
              controller.error(error);
              await session.close();
            }
          },
          async cancel(reason) {
            await reader.cancel(reason).catch(() => {});
            await session.close();
          },
        });
        return new Response(body, { status: response.status, headers: response.headers });
      }
      if (request.method !== "POST") return new Response(null, { status: 400 });
      const owned = [...sessions.values()].filter((session) => session.principal === principal);
      // Reinitializing a native client supersedes its oldest transport, without
      // revoking the provider's lease or interrupting the agent turn.
      const initializing =
        [...pending].filter((session) => session.principal === principal).length +
        (openingPrincipals.get(principal) ?? 0);
      if (initializing >= 4) return new Response(null, { status: 503 });
      while (owned.length + initializing >= 4)
        void owned
          .shift()
          ?.close()
          .catch(() => {});
      if (sessions.size + pending.size + opening >= 128) return new Response(null, { status: 503 });
      // Only initialize creates a session; malformed or uninitialized calls cannot retain one.
      opening++;
      openingPrincipals.set(principal, (openingPrincipals.get(principal) ?? 0) + 1);
      let product: Awaited<ReturnType<McpServerFactory>>;
      try {
        product = await factory({ requestInfo: request, era: "legacy" });
      } finally {
        opening--;
        const remaining = (openingPrincipals.get(principal) ?? 1) - 1;
        if (remaining) openingPrincipals.set(principal, remaining);
        else openingPrincipals.delete(principal);
      }
      if (!("server" in product)) throw new Error("Expected MCP product");
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
      });
      let closing: Promise<void> | undefined;
      const streamStops = new Set<() => void>();
      const session: Session = {
        principal,
        server: product,
        transport,
        watch(signal) {
          const stop = () => signal.removeEventListener("abort", abort);
          streamStops.add(stop);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
        close() {
          if (closing) return closing;
          principal.signal.removeEventListener("abort", abort);
          for (const stop of streamStops) stop();
          streamStops.clear();
          pending.delete(session);
          if (transport.sessionId) sessions.delete(transport.sessionId);
          closing = Promise.resolve().then(() => product.close());
          stopping.add(closing);
          const stop = closing;
          void stop.finally(() => stopping.delete(stop)).catch(() => {});
          return closing;
        },
      };
      const abort = () => {
        void session.close().catch(() => {});
      };
      principal.signal.addEventListener("abort", abort, { once: true });
      pending.add(session);
      try {
        await product.connect(transport);
        const closed = transport.onclose;
        // The SDK transport exposes a callback property, not an EventTarget.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        transport.onclose = () => {
          closed?.();
          abort();
        };
        const response = await transport.handleRequest(request);
        pending.delete(session);
        if (transport.sessionId && !principal.signal.aborted)
          sessions.set(transport.sessionId, session);
        else await session.close();
        return response;
      } catch (error) {
        await session.close();
        throw error;
      }
    },
    toolsChanged(): void {
      for (const session of sessions.values())
        void session.server.server.sendToolListChanged().catch(() => {});
    },
    async close(): Promise<void> {
      const stops = [...sessions.values(), ...pending].map((session) => session.close());
      await Promise.all([...stops, ...stopping]);
    },
  };
}
