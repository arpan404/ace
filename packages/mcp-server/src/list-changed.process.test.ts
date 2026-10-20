import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, onTestFinished, test } from "vitest";
import {
  CredentialRegistry,
  ToolRegistry,
  coreToolsHeader,
  guideToolkit,
  nodeScheduler,
  startMcpServer,
} from "./index.ts";
import { scope } from "./test-support.ts";

/**
 * A core session that opens a family reloads its own list; every other session keeps its list,
 * and so its provider's prompt cache. Real MCP clients, in both protocol eras.
 */
test.each(["modern", "legacy"] as const)(
  "only the %s session that opened a family is told its tool list changed",
  async (mode) => {
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    guideToolkit([
      { name: "ace-threads", description: "Threads", body: "How threads work." },
    ]).register(registry);
    registry.register({
      name: "threads_find",
      toolset: "ace-threads",
      description: "Find threads.",
      capability: null,
      timeoutMs: 1000,
      input: z.object({}),
      output: z.object({}),
      async run() {
        return {};
      },
    });
    let next = 0;
    const credentials = new CredentialRegistry(() => (++next).toString(16).padStart(64, "0"));
    const server = await startMcpServer({ registry, credentials });
    onTestFinished(() => server.close());
    const connect = async (name: string) => {
      const lifetime = new AbortController();
      const lease = credentials.issue(scope(name, []), lifetime.signal);
      const client = new Client(
        { name, version: "test" },
        { versionNegotiation: { mode: mode === "legacy" ? "legacy" : { pin: "2026-07-28" } } },
      );
      onTestFinished(() => client.close());
      const stream = Promise.withResolvers<void>();
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: {
              Authorization: `Bearer ${lease.bearer}`,
              "X-Ace-Notifications": "stream",
              [coreToolsHeader.name]: coreToolsHeader.value,
            },
          },
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            if ((init?.method ?? "GET") === "GET") stream.resolve();
            return response;
          },
        }),
      );
      const heard: (() => void)[] = [];
      let count = 0;
      client.setNotificationHandler("notifications/tools/list_changed", () => {
        count++;
        heard.shift()?.();
      });
      if (mode === "modern") await client.listen({ toolsListChanged: true });
      else await stream.promise;
      const nextChange = () => {
        const changed = Promise.withResolvers<void>();
        heard.push(changed.resolve);
        return changed.promise;
      };
      return { client, nextChange, count: () => count, end: () => lifetime.abort() };
    };
    // A legacy notification stream's response starts with the server's first keepalive, so both
    // sessions connect at once rather than waiting it out one after the other.
    const [opener, other] = await Promise.all([connect("opener"), connect("other")]);
    const opened = opener.nextChange();
    await opener.client.callTool({ name: "guide", arguments: { topic: "ace-threads" } });
    await opened;
    expect((await opener.client.listTools()).tools.map((tool) => tool.name)).toContain(
      "threads_find",
    );
    // A change for every session arrives after the opener's own, on the same ordered stream: had
    // the other session heard the opener's change, it would have counted two by now.
    const everyone = other.nextChange();
    server.toolsChanged();
    await everyone;
    expect(other.count()).toBe(1);
    expect((await other.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "threads_find",
    );
    // Ending the leases closes their streams, so the clients close without waiting them out.
    opener.end();
    other.end();
  },
);
