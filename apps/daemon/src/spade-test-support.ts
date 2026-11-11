import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { SpadeLink } from "./spade/link.ts";
import { spadeRequest } from "./spade/forward.ts";

/** Polls `check` until it returns something truthy, and returns that. */
export async function until<T>(
  check: () => T | Promise<T>,
  what: string | (() => string),
): Promise<NonNullable<T>> {
  for (let turn = 0; turn < 500; turn++) {
    const value = await check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`Timed out waiting for ${typeof what === "string" ? what : what()}`);
}

const Env = z.object({
  pid: z.number(),
  grant: z.string().nullable(),
  handed: z.number(),
  aceKeys: z.array(z.string()),
});
/** What the fake Spade reports of itself: its pid and the grant for ace it holds. */
export async function spadeEnv(daemon: { spade?: SpadeLink | undefined }) {
  const ready = daemon.spade?.ready();
  if (!ready) throw new Error("Spade isn't ready");
  const answer = await spadeRequest(
    ready.connection,
    { method: "GET", path: "/v1/env" },
    { signal: AbortSignal.timeout(5000), maxBytes: 65536 },
  );
  if (answer.kind !== "response") throw new Error("Spade's env is too large");
  return Env.parse(JSON.parse(answer.body.toString("utf8")));
}

/** The HTTP status of an MCP ping with `bearer`. */
export async function mcpStatus(url: string, bearer: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  await response.body?.cancel();
  return response.status;
}

/** An MCP client as Spade connects: its grant as the bearer, with list-change notifications. */
export async function connectSpadeMcp(url: string, bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${bearer}`, "X-Ace-Notifications": "stream" },
    },
  });
  // v1's optional sessionId uses a different exact-optional convention.
  const wire: Transport = {
    start: () => transport.start(),
    close: () => transport.close(),
    send: (message, options) => transport.send(message, options),
  };
  // SDK transports expose callback properties.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => wire.onmessage?.(message);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onerror = (error) => wire.onerror?.(error);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => wire.onclose?.();
  const client = new McpClient({ name: "spade", version: "0.1.0" });
  await client.connect(wire);
  return client;
}
