import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, InteractionMeasurement, McpScope } from "@ace/protocol";
import { ScreenManager } from "@ace/screen";
import { startDaemon, readConfig, createDevThread } from "./index.ts";
it("daemon MCP exposes bounded measurement and enforces capability, app and controller grants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-measure-mcp-"));
  let next = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: { FAKE_V2: "1" },
    nextId: () => `measure-${++next}`,
    recordingDirectory: dir,
    publishArtifact: async () => {},
  });
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: dir, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
    screen,
  });
  try {
    const workspace = daemon.store.createWorkspace(dir, "Measurement");
    const thread = createDevThread(daemon.store, workspace);
    const agent = Agent.parse({
      id: "root",
      threadId: thread.id,
      parentId: null,
      origin: "root",
      native: { provider: "codex" },
      fidelity: "full",
      cwd: dir,
      status: { state: "idle" },
      createdAt: 1,
    });
    daemon.store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
    const scope = McpScope.parse({
      sessionId: "provider",
      threadId: thread.id,
      agentId: "root",
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
              "io.modelcontextprotocol/clientInfo": { name: "measurement-test", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(response.status).toBe(200);
      return z.object({ result: z.unknown() }).parse(await response.json()).result;
    }
    const tools = z
      .object({ tools: z.array(z.looseObject({ name: z.string(), inputSchema: z.unknown() })) })
      .parse(await request(lease.bearer, "tools/list"));
    expect(
      tools.tools.find((tool) => tool.name === "screen_measure_interaction")?.inputSchema,
    ).toMatchObject({ properties: { observeMs: { maximum: 10000 }, repeat: { maximum: 5 } } });
    expect(
      await request(lease.bearer, "tools/call", "screen_measure_interaction", {}),
    ).toMatchObject({ isError: true });
    for (const args of [{ observeMs: 10001 }, { repeat: 6 }, { observeMs: 5000, repeat: 5 }])
      expect(
        await request(lease.bearer, "tools/call", "screen_measure_interaction", args),
      ).toMatchObject({ isError: true });
    await screen.enable(true);
    await screen.approve("dev.ace.test", true);
    const session = await screen.start({ kind: "window", bundleId: "dev.ace.test", windowId: 1 });
    screen.configureAccess({
      enabled: () => true,
      enable() {},
      list: () => [{ bundleId: "dev.ace.test", scope: "always", grantedAt: 0 }],
      allows: (bundle) => bundle === "dev.ace.test",
      approve() {},
      async request() {
        throw new Error("No app approvals in fixture");
      },
      async foreground() {},
      audit() {},
    });
    screen.controller(session.sessionId, "human", "person");
    const response = z
      .object({
        content: z.array(
          z.looseObject({
            type: z.string(),
            text: z.string().optional(),
            data: z.string().optional(),
          }),
        ),
      })
      .parse(
        await request(lease.bearer, "tools/call", "screen_measure_interaction", {
          sessionId: session.sessionId,
        }),
      );
    const metrics = InteractionMeasurement.parse(
      JSON.parse(response.content.find((part) => part.type === "text")?.text ?? "null"),
    );
    expect(metrics.verdict).toBe("smooth");
    expect(response.content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(
      await request(lease.bearer, "tools/call", "screen_measure_interaction", {
        sessionId: session.sessionId,
        action: { kind: "text.type", text: "unsafe" },
      }),
    ).toMatchObject({ isError: true });
    const denied = daemon.mcp.openSession(
      { ...scope, capabilities: [] },
      new AbortController().signal,
    );
    expect(
      await request(denied.bearer, "tools/call", "screen_measure_interaction", {
        sessionId: session.sessionId,
      }),
    ).toMatchObject({ isError: true });
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});
