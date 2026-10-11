import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ScreenManager, screenToolkit } from "@ace/screen";
import { McpScope } from "@ace/protocol";
import {
  CredentialRegistry,
  ToolRegistry,
  startMcpServer,
  acpStdioInjection,
  nodeScheduler,
} from "@ace/mcp-server";
import { spawnSupervised } from "@ace/provider-kit/process";
import { JsonRpcPeer } from "@ace/provider-kit/jsonrpc";

const decode = (value: unknown) =>
  z
    .object({
      content: z.array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("image"), data: z.string() }),
          z.object({ type: z.literal("text"), text: z.string() }),
        ]),
      ),
    })
    .parse(value)
    .content.find((block) => block.type === "image")?.data;

test("the ACP stdio child delivers exact production screenshot bytes above 256 KiB", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-acp-screen-bridge-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper-v2.ts", import.meta.url).pathname,
    ],
    platform: "win32",
    endpoint: `unix:${join(home, "pipe")}`,
    nextId: () => `screen-${++id}`,
    recordingDirectory: home,
    publishArtifact: async () => {},
    env: { PAYLOAD_VALUE: "1", PAYLOAD_PADDING: "300000" },
  });
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  screenToolkit(screen).register(registry);
  const credentials = new CredentialRegistry(() => "a".repeat(64));
  const lifetime = new AbortController();
  const lease = credentials.issue(
    McpScope.parse({
      sessionId: "bridge",
      threadId: "thread",
      agentId: "root",
      capabilities: ["screen"],
    }),
    lifetime.signal,
  );
  const server = await startMcpServer({ registry, credentials });
  const definition = acpStdioInjection({ url: server.url, bearer: lease.bearer }).mcpServers[0];
  if (!definition) throw new Error("Missing stdio injection");
  const proc = spawnSupervised({
    command: definition.command,
    args: definition.args,
    env: Object.fromEntries(definition.env.map((value) => [value.name, value.value])),
    name: "screen-stdio-bridge",
  });
  const rpc = new JsonRpcPeer(proc);
  try {
    await screen.enable(true);
    await screen.approve("dev.ace.test", true);
    const session = await screen.start({ kind: "window", windowId: 1, bundleId: "dev.ace.test" });
    screen.delegateAgent(session.sessionId, lease.principal.scope);
    const direct = decode(
      await registry.call("screen_screenshot", {}, lease.principal, lifetime.signal),
    );
    await rpc.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "screen-test", version: "1" },
    });
    const forwarded = decode(
      await rpc.request("tools/call", { name: "screen_screenshot", arguments: {} }),
    );
    expect(Buffer.from(direct ?? "", "base64").length).toBeGreaterThan(300_000);
    expect(forwarded).toBe(direct);
  } finally {
    lifetime.abort();
    await proc.stop();
    rpc.close();
    await server.close();
    await screen.close();
    await rm(home, { recursive: true, force: true });
  }
});
