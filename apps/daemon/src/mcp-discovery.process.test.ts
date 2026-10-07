import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, McpScope, McpStatus } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
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
    expect(initialized.instructions).toEqual(expect.stringContaining("disabled"));
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
      reason: expect.stringContaining("Settings → Computer use"),
    });
    expect(disabled.groups).toContainEqual({ name: "browser", enabled: true });
    const resource = z
      .array(z.object({ text: z.string() }))
      .parse((await request("resources/read", { uri: "ace://status" })).contents);
    expect(McpStatus.parse(JSON.parse(resource[0]?.text ?? ""))).toEqual(disabled);
    const tools = z
      .array(z.object({ name: z.string(), description: z.string() }))
      .parse((await request("tools/list")).tools);
    expect(tools.find((tool) => tool.name === "screen_request_app")?.description).toContain(
      "Settings → Computer use",
    );
    expect(JSON.stringify(disabled)).not.toContain(lease.bearer);
    expect(JSON.stringify(disabled)).not.toContain(home);
    await screen.enable(true);
    expect((await status()).groups).toContainEqual({ name: "screen", enabled: true });
    await screen.enable(false);
    expect((await status()).groups).toContainEqual({
      name: "screen",
      enabled: false,
      reason: expect.stringContaining("Settings → Computer use"),
    });
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
