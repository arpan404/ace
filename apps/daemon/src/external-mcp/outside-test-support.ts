import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { DeviceId, type OutsideOperation, type OutsideOutcome } from "@ace/protocol";
import type { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { invoke } from "../cli-test-support.ts";
import { Client } from "../socket-test-support.ts";

export type Fixture = Awaited<ReturnType<typeof daemonFixture>>;
const Enrolled = z.object({ id: z.string(), url: z.url(), bearer: z.string() });

export async function enroll(f: Fixture, args: string[]) {
  const output = await invoke(join(f.h.home, "daemon"), [
    "mcp",
    "enroll",
    "--ttl",
    "1h",
    ...args,
    "--json",
  ]);
  expect(output.code, output.stderr).toBe(0);
  return Enrolled.parse(JSON.parse(output.stdout));
}
/** One MCP 2026-07-28 request over plain HTTP, as an outside client sends it. */
export async function rpc(
  lease: { url: string; bearer: string },
  method: "tools/list" | "tools/call",
  params: Record<string, unknown> = {},
) {
  const response = await fetch(lease.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lease.bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params["name"] === "string" ? { "mcp-name": params["name"] } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "outside", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text };
}
export const call = (lease: { url: string; bearer: string }, name: string, args: unknown) =>
  rpc(lease, "tools/call", { name, arguments: args });
export async function listed(lease: { url: string; bearer: string }) {
  const response = await rpc(lease, "tools/list");
  expect(response.status, response.body).toBe(200);
  return z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
    .parse(JSON.parse(response.body))
    .result.tools.map((tool) => tool.name);
}
export function toolResult(response: { status: number; body: string }) {
  expect(response.status, response.body).toBe(200);
  const content = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        structuredContent: z.unknown().optional(),
      }),
    })
    .parse(JSON.parse(response.body)).result;
  return content;
}
/** The person in the app window, signed in with the host token, managing outside grants. */
export async function adminWindow(f: Fixture, closers: (() => unknown)[]) {
  const client = new Client(f.daemon.url);
  closers.push(() => client.socket.close());
  await once(client.socket, "open");
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: DeviceId.parse("window"),
    token: (await readFile(f.daemon.tokenPath, "utf8")).trim(),
  });
  if ((await client.next()).type !== "welcome") throw new Error("Not welcomed");
  let sequence = 0;
  return async (operation: OutsideOperation): Promise<OutsideOutcome> => {
    const requestId = `outside-${++sequence}`;
    client.send({ type: "outside.request", requestId, operation });
    for (;;) {
      const message = await client.next();
      if (message.type === "error" && message.requestId === requestId)
        throw new Error(message.message);
      if (message.type === "outside.result" && message.requestId === requestId)
        return message.result;
    }
  };
}
