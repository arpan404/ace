import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import { z } from "zod";
import { ThreadId, AgentId } from "@ace/protocol";
import { spawnSupervised } from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";
import {
  acpStdioInjection,
  appendAcpMcp,
  CredentialRegistry,
  nodeScheduler,
  startMcpServer,
  ToolRegistry,
  runStdioBridge,
} from "./index.ts";
test("stdio MCP forwards scoped tools over loopback and an ended lease cannot call them again", async () => {
  const tools = new ToolRegistry({ scheduler: nodeScheduler });
  tools.register({
    name: "ace_echo",
    description: "Synthetic scoped echo",
    capability: "notify",
    timeoutMs: 1000,
    input: z.object({ echo: z.string() }),
    output: z.object({ echo: z.string(), caller: z.string() }),
    async run(args, ctx) {
      return { echo: args.echo, caller: ctx.caller.agentId };
    },
  });
  const credentials = new CredentialRegistry(() => "c".repeat(64));
  const lifetime = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "scoped-session",
      threadId: ThreadId.parse("scoped-thread"),
      agentId: AgentId.parse("scoped-agent"),
      capabilities: ["notify"],
    },
    lifetime.signal,
  );
  const server = await startMcpServer({ registry: tools, credentials });
  const definition = acpStdioInjection({ url: server.url, bearer: lease.bearer }).mcpServers[0];
  if (!definition) throw new Error("No bridge definition");
  expect(definition.args.join(" ")).not.toContain(lease.bearer);
  const proc = spawnSupervised({
    command: definition.command,
    args: definition.args,
    env: Object.fromEntries(definition.env.map((value) => [value.name, value.value])),
    name: "synthetic-stdio-mcp",
  });
  const rpc = new JsonRpcPeer(proc);
  const changed = Promise.withResolvers<void>();
  rpc.onNotification = (message) => {
    if (message.method === "notifications/tools/list_changed") changed.resolve();
  };
  try {
    await rpc.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "synthetic", version: "1" },
    });
    await rpc.notify("notifications/initialized");
    await rpc.request("tools/list", {});
    server.toolsChanged();
    await changed.promise;
    const result = await rpc.request("tools/call", {
      name: "ace_echo",
      arguments: { echo: "from stdio" },
    });
    expect(JSON.stringify(result)).toContain("from stdio");
    expect(JSON.stringify(result)).toContain("scoped-agent");
    lease.end();
    await expect(
      rpc.request("tools/call", { name: "ace_echo", arguments: { echo: "denied" } }),
    ).rejects.toThrow("bridge request failed");
  } finally {
    lifetime.abort();
    await proc.stop();
    rpc.close();
    await server.close();
  }
});
test("MCP merging preserves user definitions and rejects an ace name collision", () => {
  const user = { name: "configured", command: "/user/cli", args: ["kept"], env: [] };
  expect(appendAcpMcp([user], [{ name: "ace", command: "/ace/bridge" }])).toEqual([
    user,
    { name: "ace", command: "/ace/bridge" },
  ]);
  expect(() =>
    appendAcpMcp(
      [{ name: "ace", command: "/user/ace" }],
      [{ name: "ace", command: "/ace/bridge" }],
    ),
  ).toThrow("collision");
});

test("stdio requests can finish after two minutes and a timed-out request leaves subsequent tools usable", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lifetime = new AbortController();
  const lines = createInterface({ input: output });
  const replies: string[] = [];
  let changed = Promise.withResolvers<void>();
  lines.on("line", (line) => {
    replies.push(line);
    changed.resolve();
  });
  const timers = new Set<{ at: number; run(): void }>();
  let now = 0;
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const bridge = runStdioBridge({
    connection: { url: "http://127.0.0.1:1/mcp", bearer: "a".repeat(64) },
    input,
    output,
    signal: lifetime.signal,
    scheduler: {
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.add(timer);
        return () => timers.delete(timer);
      },
    },
    async fetch(_url, options) {
      const request = z.object({ id: z.number() }).parse(JSON.parse(String(options?.body)));
      if (request.id === 1) {
        started.resolve();
        await released.promise;
      }
      if (request.id === 2) {
        secondStarted.resolve();
        await new Promise<never>((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: "usable" }] },
      });
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers])
      if (timer.at <= now) {
        timers.delete(timer);
        timer.run();
      }
  };
  try {
    await import("@modelcontextprotocol/client");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }) + "\n");
    await started.promise;
    advance(250_000);
    released.resolve();
    await changed.promise;
    expect(JSON.parse(replies[0] ?? "null")).toMatchObject({
      id: 1,
      result: { content: [{ text: "usable" }] },
    });
    changed = Promise.withResolvers<void>();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" }) + "\n");
    await secondStarted.promise;
    advance(330_000);
    await changed.promise;
    expect(JSON.parse(replies[1] ?? "null")).toMatchObject({
      id: 2,
      error: { message: "ace MCP bridge request timed out" },
    });
    changed = Promise.withResolvers<void>();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }) + "\n");
    await changed.promise;
    expect(JSON.parse(replies[2] ?? "null")).toMatchObject({
      id: 3,
      result: { content: [{ text: "usable" }] },
    });
  } finally {
    lifetime.abort();
    await bridge;
    lines.close();
    output.destroy();
  }
});
