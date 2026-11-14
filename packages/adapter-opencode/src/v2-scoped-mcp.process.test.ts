import { expect, test } from "vitest";
import { z } from "zod";
import { ThreadId, AgentId } from "@ace/protocol";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "@ace/mcp-server";
import { createOpenCodeAdapter } from "./index.ts";
import { setup, Clock } from "./testing/v2-session.ts";

test("OpenCode v2 native processes preserve user MCP servers and isolate thread authority within an account", async () => {
  let id = 0;
  const credentials = new CredentialRegistry(() => (++id).toString(16).padStart(64, "0"));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  registry.register({
    name: "scope",
    description: "Observe authority",
    capability: "thread_control",
    timeoutMs: 1000,
    input: z.object({}),
    output: z.object({ threadId: ThreadId }),
    async run(_input, context) {
      return { threadId: context.caller.threadId };
    },
  });
  const mcp = await startMcpServer({ registry, credentials });
  const h = await setup();
  const adapter = createOpenCodeAdapter(h.options);
  const controllers = [new AbortController(), new AbortController()];
  const leases = controllers.map((controller, index) =>
    credentials.issue(
      {
        sessionId: `scope-${index}`,
        threadId: ThreadId.parse(`thread-${index}`),
        agentId: AgentId.parse(`agent-${index}`),
        capabilities: ["thread_control"],
      },
      controller.signal,
    ),
  );
  const transports: ReturnType<typeof h.transport>[] = [];
  try {
    for (const [index, lease] of leases.entries()) {
      const session = await adapter.openSession({
        threadId: ThreadId.parse(`thread-${index}`),
        cwd: "/account",
        instanceId: "same-account",
        env: {
          OPENCODE_CONFIG_CONTENT: `{ // user configuration
            "mcp": { "servers": { "user": { "type": "remote", "url": "https://example.invalid" }, } },
          }`,
        },
        signal: new AbortController().signal,
        aceMcp: {
          url: mcp.url,
          bearer: lease.bearer,
          signal: lease.principal.signal,
          end: lease.end,
        },
        onFrame() {},
        onExit() {},
      });
      transports.push(h.transport());
      const response = await h.control(`/api/session/${session.nativeSessionId}`);
      expect(response).toMatchObject({
        data: {
          instructions: {
            "ace.tool-guidance": expect.stringContaining("OpenCode names ace tools ace_<tool>"),
          },
        },
      });
      expect(await h.control("/test/mcp")).toMatchObject({
        names: ["user", "ace"],
        status: 200,
        response: { result: { structuredContent: { threadId: `thread-${index}` } } },
      });
    }
    controllers[0]?.abort();
    for (const [index, transport] of transports.entries()) {
      const response = await fetch(new URL("/test/mcp", transport.url), {
        headers: { authorization: transport.authorization },
      });
      expect(await response.json()).toMatchObject(
        index === 0
          ? { status: 401 }
          : {
              status: 200,
              response: { result: { structuredContent: { threadId: "thread-1" } } },
            },
      );
    }
  } finally {
    await adapter.close();
    for (const lease of leases) lease.end();
    await mcp.close();
  }
});

test("OpenCode refuses a session when its native MCP catalog cannot connect", async () => {
  const h = await setup({ discovery: { env: { ACE_TEST_MCP_FAILED: "1" } } });
  const adapter = createOpenCodeAdapter(h.options);
  try {
    await expect(
      adapter.openSession({
        threadId: ThreadId.parse("failed"),
        cwd: "/sandbox",
        aceMcp: { url: "http://127.0.0.1:12345/mcp", bearer: "a".repeat(64) },
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
      }),
    ).rejects.toThrow("OpenCode could not connect its native ace MCP client");
  } finally {
    await adapter.close();
  }
});

test("OpenCode preserves a user's ace server by rejecting an authority name collision", async () => {
  const h = await setup();
  const adapter = createOpenCodeAdapter(h.options);
  try {
    await expect(
      adapter.openSession({
        threadId: ThreadId.parse("collision"),
        cwd: "/sandbox",
        env: {
          OPENCODE_CONFIG_CONTENT:
            '{"mcp":{"servers":{"ace":{"type":"remote","url":"https://example.invalid"}}}}',
        },
        aceMcp: { url: "http://127.0.0.1:12345/mcp", bearer: "a".repeat(64) },
        signal: new AbortController().signal,
        onFrame() {},
        onExit() {},
      }),
    ).rejects.toThrow("OpenCode MCP server name collision: ace");
  } finally {
    await adapter.close();
  }
});

test("OpenCode waits for ace status to reach its native tool catalog before accepting a session", async () => {
  const credentials = new CredentialRegistry(() => "b".repeat(64));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const mcp = await startMcpServer({ registry, credentials });
  const h = await setup();
  const requested = Promise.withResolvers<void>();
  const network = h.options.runtime?.fetch ?? fetch;
  const adapter = createOpenCodeAdapter({
    ...h.options,
    runtime: {
      ...h.options.runtime,
      fetch(input, init) {
        if (String(input).includes("/rpc/ace.mcp.readiness/ready")) requested.resolve();
        return network(input, init);
      },
    },
  });
  const controller = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "status",
      threadId: ThreadId.parse("status-thread"),
      agentId: AgentId.parse("status-agent"),
      capabilities: [],
    },
    controller.signal,
  );
  try {
    const opened = adapter.openSession({
      threadId: ThreadId.parse("status-thread"),
      cwd: "/sandbox",
      env: {
        ACE_TEST_HOLD_MCP_TOOLS: "1",
        OPENCODE_CONFIG_CONTENT:
          '{ // preserve comments and user plugins\n"plugins": ["user-plugin"], "custom": {"retained": true}, }',
      },
      signal: controller.signal,
      aceMcp: { url: mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame() {},
      onExit() {},
    });
    expect(
      await Promise.race([requested.promise.then(() => "waiting"), opened.then(() => "opened")]),
    ).toBe("waiting");
    await h.control("/test/mcp-tools/settle");
    const session = await opened;
    expect(await h.control("/test/mcp-tools")).toMatchObject({
      readinessRequested: true,
      tools: [
        {
          name: "ace_context",
          description: expect.stringContaining("Project and session context"),
        },
        { name: "ace_tools_find", description: expect.stringContaining("Find ace tools") },
        { name: "ace_tools_call", description: expect.stringContaining("Run any ace tool") },
      ],
      plugins: ["user-plugin", expect.any(String)],
    });
    await session.close("shutdown");
  } finally {
    controller.abort();
    await adapter.close();
    await mcp.close();
  }
});

test("a native catalog that never registers ace status is cancelled and loses its authority", async () => {
  const credentials = new CredentialRegistry(() => "c".repeat(64));
  const mcp = await startMcpServer({
    registry: new ToolRegistry({ scheduler: nodeScheduler }),
    credentials,
  });
  const clock = new Clock();
  const h = await setup({ runtime: { schedule: clock.schedule } });
  const requested = Promise.withResolvers<void>();
  const network = h.options.runtime?.fetch ?? fetch;
  const adapter = createOpenCodeAdapter({
    ...h.options,
    runtime: {
      ...h.options.runtime,
      fetch(input, init) {
        if (String(input).includes("/rpc/ace.mcp.readiness/ready")) requested.resolve();
        return network(input, init);
      },
    },
  });
  const controller = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "cancelled",
      threadId: ThreadId.parse("cancelled-thread"),
      agentId: AgentId.parse("root"),
      capabilities: [],
    },
    controller.signal,
  );
  try {
    const opened = adapter.openSession({
      threadId: ThreadId.parse("cancelled-thread"),
      cwd: "/sandbox",
      env: { ACE_TEST_HOLD_MCP_TOOLS: "1" },
      signal: controller.signal,
      aceMcp: { url: mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame() {},
      onExit() {},
    });
    const rejected = expect(opened).rejects.toThrow("OpenCode session opening failed");
    await requested.promise;
    clock.advance(10_000);
    await rejected;
    const response = await fetch(mcp.url, { headers: { Authorization: `Bearer ${lease.bearer}` } });
    expect(response.status).toBe(401);
  } finally {
    controller.abort();
    await adapter.close();
    await mcp.close();
  }
});

test("a readiness plugin OpenCode never registers still opens the session, warns once, and later sends don't register ace again", async () => {
  const credentials = new CredentialRegistry(() => "d".repeat(64));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const mcp = await startMcpServer({ registry, credentials });
  // Short pauses run at once and move the clock, so the bounded wait elapses without real time.
  const clock = new Clock();
  const h = await setup({
    runtime: {
      monotonic: () => clock.now,
      schedule(callback, delay) {
        if (delay > 500) return clock.schedule(callback, delay);
        clock.now += delay;
        const timer = setTimeout(callback, 0);
        return () => clearTimeout(timer);
      },
    },
  });
  const adapter = createOpenCodeAdapter(h.options);
  const controller = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "unconfirmed",
      threadId: ThreadId.parse("unconfirmed-thread"),
      agentId: AgentId.parse("root"),
      capabilities: [],
    },
    controller.signal,
  );
  const notes: unknown[] = [];
  try {
    const session = await adapter.openSession({
      threadId: ThreadId.parse("unconfirmed-thread"),
      cwd: "/sandbox",
      env: { ACE_TEST_READINESS_UNAVAILABLE: "always" },
      signal: controller.signal,
      aceMcp: { url: mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame(frame) {
        if (frame.channel === "mcp.readiness") notes.push(frame.data);
      },
      onExit() {},
    });
    expect(notes).toEqual([{ type: "unconfirmed" }]);
    const refusals = z
      .object({ readinessRefusals: z.number() })
      .parse(await h.control("/test/mcp-tools")).readinessRefusals;
    expect(refusals).toBeGreaterThan(1);
    // Stop never waits on readiness: it reaches OpenCode without another readiness call.
    await session.interrupt({ cascade: true });
    expect(await h.control("/test/mcp-tools")).toMatchObject({ readinessRefusals: refusals });
    // Registering ace again would fail on the name collision the fake reports, as OpenCode does.
    await session.configure?.({
      provider: "opencode",
      model: "opencode-go/muse-spark-1.3-contributor",
      options: {},
    });
    expect(await h.control("/test/mcp-tools")).toMatchObject({ readinessRefusals: refusals + 1 });
    expect(notes).toHaveLength(1);
    await session.close("shutdown");
  } finally {
    controller.abort();
    await adapter.close();
    await mcp.close();
  }
});

test("after OpenCode rebuilds the session's location, Stop goes through without ace's tools and the next send registers them again", async () => {
  const credentials = new CredentialRegistry(() => "e".repeat(64));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  const mcp = await startMcpServer({ registry, credentials });
  const h = await setup();
  const adapter = createOpenCodeAdapter(h.options);
  const controller = new AbortController();
  const lease = credentials.issue(
    {
      sessionId: "rebuilt",
      threadId: ThreadId.parse("rebuilt-thread"),
      agentId: AgentId.parse("root"),
      capabilities: [],
    },
    controller.signal,
  );
  const resynced = Promise.withResolvers<void>();
  try {
    const session = await adapter.openSession({
      threadId: ThreadId.parse("rebuilt-thread"),
      cwd: "/sandbox",
      signal: controller.signal,
      aceMcp: { url: mcp.url, bearer: lease.bearer, end: lease.end },
      onFrame(frame) {
        if (
          frame.channel === "lifecycle" &&
          z.object({ type: z.string() }).parse(frame.data).type === "resynced"
        )
          resynced.resolve();
      },
      onExit() {},
    });
    expect(await h.control("/test/mcp")).toMatchObject({ names: ["ace"] });
    // OpenCode drops runtime MCP servers when it rebuilds a location.
    await h.control("/test/events", [
      { type: "location.shutdown", directory: "/sandbox", data: {} },
    ]);
    await resynced.promise;
    expect(await h.control("/test/mcp")).toMatchObject({ missing: true });
    // Stop needs none of ace's tools, so it goes through without setting them up again.
    await session.interrupt({ cascade: true });
    expect(await h.control("/test/mcp")).toMatchObject({ missing: true });
    await session.configure?.({
      provider: "opencode",
      model: "opencode-go/muse-spark-1.3-contributor",
      options: {},
    });
    expect(await h.control("/test/mcp")).toMatchObject({ names: ["ace"], status: 200 });
    await session.close("shutdown");
  } finally {
    controller.abort();
    await adapter.close();
    await mcp.close();
  }
});
