import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, McpScope } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
import { startDaemon, readConfig, createDevThread } from "./index.ts";

it("a configured daemon exposes scoped screen tools and returns screenshot images over MCP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-mcp-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper-v2.ts", import.meta.url).pathname,
    ],
    platform: "win32",
    endpoint: `unix:${join(directory, "pipe")}`,
    nextId: () => `screen-${++id}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
    env: { PAYLOAD_VALUE: "1", PAYLOAD_PADDING: "300000" },
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: directory, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
  });
  try {
    const workspace = daemon.store.createWorkspace(directory, "Screen");
    const thread = createDevThread(daemon.store, workspace);
    const agent = Agent.parse({
      id: "root",
      threadId: thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: directory,
      status: { state: "idle" },
      createdAt: 1,
    });
    daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
    const scope = McpScope.parse({
      sessionId: "provider-session",
      threadId: thread.id,
      agentId: agent.id,
      capabilities: ["screen"],
    });
    const lease = daemon.mcp.openSession(scope, new AbortController().signal);
    let requestId = 0;
    async function request(
      bearer: string,
      method: "tools/list" | "tools/call",
      name?: string,
      args: unknown = {},
    ) {
      const response = await fetch(daemon.mcp.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(name ? { "Mcp-Name": name } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++requestId,
          method,
          params: {
            ...(name ? { name, arguments: args } : {}),
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "screen-test", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      const result: unknown = await response.json();
      return result;
    }
    const disabled = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(await request(lease.bearer, "tools/list"));
    expect(
      disabled.result.tools.map((tool) => tool.name).filter((name) => name.startsWith("screen_")),
    ).toEqual([]);
    const denied = daemon.mcp.openSession(
      { ...scope, capabilities: [] },
      new AbortController().signal,
    );
    const deniedTools = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(await request(denied.bearer, "tools/list"));
    expect(deniedTools.result.tools.map((tool) => tool.name)).not.toContain("screen_ui_tree");
    await screen.enable(true);
    await screen.approve("dev.ace.test", true);
    const listed = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(await request(lease.bearer, "tools/list"));
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "screen_ui_tree",
        "screen_ui_find",
        "screen_ui_act",
        "screen_screenshot",
        "screen_click",
        "screen_type",
        "screen_key",
        "screen_scroll",
      ]),
    );
    const session = await screen.start({ kind: "window", windowId: 1, bundleId: "dev.ace.test" });
    screen.delegateAgent(session.sessionId, scope);
    screen.configureAccess({
      enabled: () => true,
      enable() {},
      list: () => [{ bundleId: "dev.ace.test", scope: "always", grantedAt: 0 }],
      allows: (bundle) => bundle === "dev.ace.test",
      approve() {},
      async request() {
        throw new Error("No app request in this fixture");
      },
      async foreground() {},
      audit() {},
    });
    await screen.mode(session.sessionId, "foreground");
    const other = createDevThread(daemon.store, workspace);
    const otherAgent = Agent.parse({ ...agent, id: "other-root", threadId: other.id });
    daemon.store.appendEvents(other.id, [{ type: "agent.created", agent: otherAgent }], 2);
    const otherLease = daemon.mcp.openSession(
      { ...scope, threadId: other.id, agentId: otherAgent.id },
      new AbortController().signal,
    );
    expect(await request(otherLease.bearer, "tools/call", "screen_ui_tree", {})).toMatchObject({
      result: { isError: true },
    });
    expect(await request(lease.bearer, "tools/call", "screen_ui_tree", {})).toMatchObject({
      result: { content: [{ type: "text", text: expect.stringContaining('"name":"Save"') }] },
    });
    expect(
      await request(lease.bearer, "tools/call", "screen_ui_act", {
        ref: "save",
        action: "setValue",
        value: "你好 😀",
      }),
    ).toMatchObject({
      result: { content: [{ type: "text", text: expect.stringContaining('"fallback":false') }] },
    });
    await screen.targets();
    const image = z
      .object({
        result: z.object({
          content: z.array(
            z.object({
              type: z.string(),
              data: z.string().optional(),
              text: z.string().optional(),
              mimeType: z.string().optional(),
            }),
          ),
        }),
      })
      .parse(await request(lease.bearer, "tools/call", "screen_screenshot", {})).result.content[0];
    expect(image?.type).toBe("image");
    expect(image?.mimeType).toBe("image/jpeg");
    if (!image?.data) throw new Error("Missing screenshot bytes");
    expect(Buffer.from(image.data, "base64").toString()).toBe(
      "pixels:你好 😀" + "x".repeat(300000),
    );
    screen.controller(session.sessionId, "human", "person");
    expect(
      await request(lease.bearer, "tools/call", "screen_ui_act", { ref: "save", action: "press" }),
    ).toMatchObject({ result: { isError: true } });
    expect(await request(denied.bearer, "tools/call", "screen_screenshot", {})).toMatchObject({
      result: { isError: true },
    });
  } finally {
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
});
