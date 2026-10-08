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
        return response;
      }
      if (request.method !== "POST") return new Response(null, { status: 400 });
      if (sessions.size + pending.size + opening >= 128) return new Response(null, { status: 503 });
      // Only initialize creates a session; malformed or uninitialized calls cannot retain one.
      opening++;
      let product: Awaited<ReturnType<McpServerFactory>>;
      try {
        product = await factory({ requestInfo: request, era: "legacy" });
      } finally {
        opening--;
      }
      if (!("server" in product)) throw new Error("Expected MCP product");
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
      });
      let closing: Promise<void> | undefined;
      const session: Session = {
        principal,
        server: product,
        transport,
        close() {
          if (closing) return closing;
          principal.signal.removeEventListener("abort", abort);
          pending.delete(session);
          if (transport.sessionId) sessions.delete(transport.sessionId);
          closing = product.close();
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
