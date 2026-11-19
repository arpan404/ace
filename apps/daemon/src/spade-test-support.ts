import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  DeviceId,
  OutsideGrantEntry,
  OutsideResult,
  type ClientMessage,
  type ServerMessage,
} from "@ace/protocol";
import { Client } from "./socket-test-support.ts";
import type { SpadeLink } from "./spade/link.ts";
import { spadeRequest } from "./spade/forward.ts";

/**
 * An app from before Spade's grant existed: its schema for `outside.result` knew only these
 * client kinds, and one grant of another kind fails the whole list.
 */
export const OlderOutsideResult = OutsideResult.extend({
  result: z.object({
    kind: z.literal("grants"),
    grants: z.array(OutsideGrantEntry.extend({ clientKind: z.enum(["cli", "cimd", "dcr"]) })),
  }),
});

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

const ReachedAce = z.object({
  mcpUrl: z.string(),
  ping: z.number(),
  stream: z.object({ status: z.number(), method: z.string().nullable() }),
});
/**
 * ace as the fake Spade finds it: from `daemon-endpoint`, calling `<endpoint>/mcp` with its
 * grant, a ping and then the list-changed stream. The stream answers only with its first event,
 * so `changeTools` is called until one arrives.
 */
export async function spadeReachesAce(
  daemon: { spade?: SpadeLink | undefined },
  changeTools: () => void,
) {
  const ready = daemon.spade?.ready();
  if (!ready) throw new Error("Spade isn't ready");
  const call = (method: "GET" | "POST") =>
    spadeRequest(
      ready.connection,
      { method, path: "/v1/test/ace" },
      { signal: AbortSignal.timeout(10_000), maxBytes: 65536 },
    );
  await call("POST");
  const text = await until(async () => {
    changeTools();
    const answer = await call("GET");
    if (answer.kind !== "response" || answer.status === 202) return undefined;
    return answer.body.toString("utf8");
  }, "Spade to reach ace");
  return ReachedAce.parse(JSON.parse(text));
}

/** Where Spade calls ace's tools: `<daemon-endpoint>/mcp`, on the daemon's own port. */
export const aceMcpUrl = (daemon: { url: string }) => `${daemon.url.replace(/^ws:/, "http:")}/mcp`;

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

/**
 * A desktop's socket to the daemon with the host's own token (an administrator): `ask` sends a
 * request and waits for the first message with its request id.
 */
export async function adminSocket(daemon: { url: string; tokenPath: string }) {
  const token = await readFile(daemon.tokenPath, "utf8");
  const client = new Client(daemon.url);
  await once(client.socket, "open");
  client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("desktop"), token });
  return {
    async ask(message: ClientMessage & { requestId: string }): Promise<ServerMessage> {
      client.send(message);
      for (;;) {
        const reply = await client.next();
        if ("requestId" in reply && reply.requestId === message.requestId) return reply;
      }
    },
    close: () => client.close(),
  };
}
