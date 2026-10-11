import { expect, test, onTestFinished } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";
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
test("stdio MCP forwards a six-minute tool result without ending the provider connection", async () => {
  const tools = new ToolRegistry({ scheduler: nodeScheduler });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  tools.register({
    name: "device_install",
    description: "Synthetic installation",
    capability: "devices",
    timeoutMs: 630000,
    input: z.object({}),
    output: z.object({ completed: z.boolean() }),
    async run() {
      entered.resolve();
      await release.promise;
      return { completed: true };
    },
  });
  const credentials = new CredentialRegistry(() => "c".repeat(64));
  const lifetime = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "install",
      threadId: ThreadId.parse("thread"),
      agentId: AgentId.parse("agent"),
      capabilities: ["devices"],
    },
    lifetime.signal,
  );
  const server = await startMcpServer({ registry: tools, credentials });
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = createInterface({ input: output });
  const reply = Promise.withResolvers<unknown>();
  lines.once("line", (line) => {
    reply.resolve(JSON.parse(line));
  });
  const timers = new Set<{ at: number; run(): void }>();
  await import("@modelcontextprotocol/client");
  const closing = runStdioBridge({
    connection: { url: server.url, bearer: lease.bearer },
    input,
    output,
    signal: lifetime.signal,
    scheduler: {
      after(ms, run) {
        const timer = { at: ms, run };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  });
  void closing.catch(() => {});
  onTestFinished(async () => {
    release.resolve();
    lifetime.abort();
    await closing.catch(() => {});
    lines.close();
    output.destroy();
    lease.end();
    await server.close();
  });
  await setImmediate();
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "device_install", arguments: {} },
    }) + "\n",
  );
  await entered.promise;
  for (const timer of timers) if (timer.at <= 360000) timer.run();
  expect(input.destroyed).toBe(false);
  release.resolve();
  expect(await reply.promise).toMatchObject({
    id: 1,
    result: { structuredContent: { completed: true } },
  });
  input.end();
  await closing;
});
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
