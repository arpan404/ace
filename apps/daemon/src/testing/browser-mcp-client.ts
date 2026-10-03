import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

const HttpServer = z.object({ url: z.url(), headers: z.record(z.string(), z.string()) });
const StdioServer = z.object({
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});

/** Boundary double consumes the adapter's wire config, then uses a real MCP client. */
export async function browserProof(raw: unknown, kind: "http" | "stdio") {
  const native =
    kind === "http"
      ? (() => {
          const server = HttpServer.parse(raw);
          return new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: { headers: server.headers },
          });
        })()
      : new StdioClientTransport(StdioServer.parse(raw));
  // v1's optional sessionId uses a different exact-optional convention.
  const wire: Transport = {
    start: () => native.start(),
    close: () => native.close(),
    send: (message, options) =>
      native instanceof StdioClientTransport ? native.send(message) : native.send(message, options),
  };
  // SDK transports expose callback properties.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  native.onmessage = (message) => wire.onmessage?.(message);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  native.onerror = (error) => wire.onerror?.(error);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  native.onclose = () => wire.onclose?.();
  const client = new Client({ name: "ace-fake-provider", version: "1" });
  try {
    await client.connect(wire);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const result = await client.callTool({
      name: "ace_browser_open",
      arguments: { url: process.env.ACE_TEST_BROWSER_URL },
    });
    if (result.isError) throw new Error("Injected browser tool failed");
    return { tools, opened: result };
  } finally {
    await client.close();
  }
}
