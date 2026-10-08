import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, McpScope, McpStatus } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, it } from "vitest";
import { createDevThread, readConfig, startDaemon } from "./index.ts";

it("agents discover ace through initialize, resources and status even when computer use is disabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-mcp-discovery-"));
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper-v2.ts", import.meta.url).pathname,
    ],
    platform: "win32",
    endpoint: `unix:${join(home, "pipe")}`,
    nextId: () => "unused",
    recordingDirectory: home,
    publishArtifact: async () => {},
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
    modelInstances: [],
    history: { instances: [] },
  });
  try {
    const workspace = daemon.store.createWorkspace(home, "Discovery");
    const thread = createDevThread(daemon.store, workspace);
    const agent = Agent.parse({
      id: "root",
      threadId: thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "opencode" },
      fidelity: "full",
      cwd: home,
      status: { state: "idle" },
      createdAt: 1,
    });
    daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
    const lease = daemon.mcp.openSession(
      McpScope.parse({
        sessionId: "discovery",
        threadId: thread.id,
        agentId: agent.id,
        capabilities: ["screen", "browser", "agents", "notify"],
      }),
      new AbortController().signal,
    );
    let id = 0;
    async function request(method: string, params: Record<string, unknown> = {}) {
      const response = await fetch(daemon.mcp.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lease.bearer}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
        ? (body
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? "")
        : body;
      return z.object({ result: z.record(z.string(), z.unknown()) }).parse(JSON.parse(payload))
        .result;
    }
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "discovery-test", version: "1" },
      capabilities: {},
    });
    expect(initialized.instructions).toEqual(expect.stringContaining("ace_"));
    expect(initialized.instructions).toEqual(expect.stringContaining("Call ace_status"));
    expect(initialized.capabilities).toMatchObject({ resources: {}, tools: {} });
    expect((await request("resources/list")).resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "ace://status", mimeType: "application/json" }),
      ]),
    );
    const status = async () =>
      McpStatus.parse(
        (await request("tools/call", { name: "ace_status", arguments: {} })).structuredContent,
      );
    const disabled = await status();
    expect(disabled).toMatchObject({
      threadId: thread.id,
      agentId: agent.id,
      permissionMode: "auto-review",
    });
    expect(disabled.groups).toContainEqual({
      name: "screen",
      enabled: false,
      reason: "Computer use is disabled.",
    });
    expect(disabled.groups).toContainEqual({ name: "browser", enabled: true });
    const resource = z
      .array(z.object({ text: z.string() }))
      .parse((await request("resources/read", { uri: "ace://status" })).contents);
    expect(McpStatus.parse(JSON.parse(resource[0]?.text ?? ""))).toEqual(disabled);
    const tools = z
      .array(z.object({ name: z.string(), description: z.string() }))
      .parse((await request("tools/list")).tools);
    expect(tools.some((tool) => tool.name.startsWith("screen_"))).toBe(false);
    expect(JSON.stringify(disabled)).not.toContain(lease.bearer);
    expect(JSON.stringify(disabled)).not.toContain(home);
    const client = new Client(
      { name: "changes-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(daemon.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${lease.bearer}` } },
        }),
      );
      let changed = Promise.withResolvers<void>();
      client.setNotificationHandler("notifications/tools/list_changed", () => changed.resolve());
      await client.listen({ toolsListChanged: true });
      await screen.enable(true);
      await changed.promise;
      expect((await status()).groups).toContainEqual({ name: "screen", enabled: true });
      const enabledTools = z
        .array(z.object({ name: z.string(), description: z.string() }))
        .parse((await request("tools/list")).tools);
      expect(
        enabledTools.filter((tool) => tool.name.startsWith("screen_")).map((tool) => tool.name),
      ).toEqual(["screen_request_app"]);
      changed = Promise.withResolvers<void>();
      await screen.approve("com.apple.TextEdit", true, "thread", thread.id);
      await changed.promise;
      expect((await client.listTools()).tools.some((tool) => tool.name === "screen_ui_tree")).toBe(
        true,
      );
      changed = Promise.withResolvers<void>();
      await screen.approve("com.apple.TextEdit", false, "thread", thread.id);
      await changed.promise;
      expect(
        (await client.listTools()).tools
          .filter((tool) => tool.name.startsWith("screen_"))
          .map((tool) => tool.name),
      ).toEqual(["screen_request_app"]);
    } finally {
      await client.close();
    }
    await screen.enable(false);
    expect((await status()).groups).toContainEqual({
      name: "screen",
      enabled: false,
      reason: "Computer use is disabled.",
    });
    // Current providers use per-request metadata, without the legacy handshake.
    const current = await fetch(daemon.mcp.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.bearer}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "ace_status",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: {
          name: "ace_status",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "current-test", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(current.status).toBe(200);
    expect(
      z.object({ result: z.object({ structuredContent: McpStatus }) }).parse(await current.json())
        .result.structuredContent,
    ).toEqual(disabled);
    const revoked = await fetch(daemon.mcp.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "ace://status" },
      }),
    });
    expect(revoked.status).toBe(401);
  } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
