import { expect, test, vi } from "vitest";
import { McpProviderSessions } from "./mcp-provider-sessions.ts";
import { setup } from "./remote-test-support.ts";

test("native MCP controls require thread authority and stop working after the provider exits", async () => {
  const providers = new McpProviderSessions();
  const f = await setup({ mcp: { providers } });
  const lifetime = new AbortController();
  let dynamic: Record<string, unknown> = {};
  let projectStatus = "failed";
  providers.bind(
    f.thread.id,
    f.thread.provider,
    {
      async status() {
        return [
          { name: "project", status: projectStatus, source: "project", extension: 42 },
          ...Object.keys(dynamic).map((name) => ({ name, source: "dynamic" })),
        ];
      },
      async replace(servers) {
        if ("broken" in servers) throw new Error("synthetic native stderr sentinel");
        dynamic = servers;
        return { added: Object.keys(servers), removed: [], errors: {} };
      },
      async reconnect() {
        projectStatus = "connected";
      },
      async enable() {
        projectStatus = "connected";
      },
      async disable() {
        projectStatus = "disabled";
      },
    },
    lifetime.signal,
  );
  const device = await f.pair(["read"]);
  const ticket = await f.ticket(device.token);
  const reader = await f.connectTicket(device.device.id, ticket.ticket);
  await reader.next();
  reader.send({ type: "mcp.status", threadId: f.thread.id, requestId: "status" });
  expect(await reader.next()).toMatchObject({
    type: "mcp.result",
    result: [{ name: "project", extension: 42 }],
  });
  reader.send({
    type: "mcp.replace",
    threadId: f.thread.id,
    requestId: "denied",
    servers: { rejected: {} },
  });
  expect(await reader.next()).toMatchObject({ type: "error", code: "forbidden" });
  reader.send({
    type: "mcp.provider.sources",
    provider: f.thread.provider,
    requestId: "provider-read",
  });
  expect(await reader.next()).toMatchObject({
    type: "mcp.result",
    provider: f.thread.provider,
    requestId: "provider-read",
    result: { live: true },
  });
  reader.send({
    type: "mcp.provider.disable",
    provider: f.thread.provider,
    name: "project",
    requestId: "provider-denied",
  });
  expect(await reader.next()).toMatchObject({
    type: "error",
    code: "forbidden",
    requestId: "provider-denied",
  });
  const host = await f.connect();
  await host.next();
  host.send({
    type: "mcp.replace",
    threadId: f.thread.id,
    requestId: "replace",
    servers: { tools: { command: "synthetic" } },
  });
  expect(await host.next()).toMatchObject({ type: "mcp.result", result: { added: ["tools"] } });
  host.send({ type: "mcp.status", threadId: f.thread.id, requestId: "updated" });
  expect(await host.next()).toMatchObject({
    type: "mcp.result",
    result: [{ source: "project" }, { name: "tools" }],
  });
  for (const [type, status] of [
    ["mcp.reconnect", "connected"],
    ["mcp.disable", "disabled"],
    ["mcp.enable", "connected"],
  ] as const) {
    host.send({ type, threadId: f.thread.id, requestId: type, name: "project" });
    expect(await host.next()).toMatchObject({ type: "mcp.result", requestId: type });
    host.send({ type: "mcp.sources", threadId: f.thread.id, requestId: "sources" });
    expect(await host.next()).toMatchObject({
      type: "mcp.result",
      result: {
        servers: [
          { name: "project", status },
          { name: "tools", status: "unknown" },
        ],
      },
    });
  }
  host.send({
    type: "mcp.replace",
    threadId: f.thread.id,
    requestId: "broken",
    servers: { broken: {} },
  });
  expect(await host.next()).toMatchObject({
    type: "error",
    code: "mcp_failed",
    requestId: "broken",
    message: "Provider MCP control failed",
  });
  lifetime.abort();
  host.send({ type: "mcp.status", threadId: f.thread.id, requestId: "expired" });
  expect(await host.next()).toMatchObject({
    type: "error",
    code: "mcp_failed",
    requestId: "expired",
  });
});

test("Settings reaches the provider's live MCP servers without a thread, and a server waiting for sign-in says so", async () => {
  const providers = new McpProviderSessions();
  const f = await setup({ mcp: { providers } });
  const provider = f.thread.provider;
  const other = provider === "codex" ? "claude" : "codex";
  const lifetime = new AbortController();
  let vercel = "needs-auth";
  providers.bind(
    f.thread.id,
    provider,
    {
      async status() {
        return [
          { name: "vercel", status: vercel },
          { name: "ace", status: "connected" },
        ];
      },
      async replace() {
        return {};
      },
      async reconnect(name) {
        if (name === "vercel") vercel = "connected";
      },
      async enable() {},
      async disable() {},
    },
    lifetime.signal,
  );
  const host = await f.connect();
  await host.next();
  const sources = async (scope: typeof provider, requestId: string) => {
    host.send({ type: "mcp.provider.sources", provider: scope, requestId });
    return host.next();
  };
  expect(await sources(provider, "before")).toEqual({
    type: "mcp.result",
    provider,
    requestId: "before",
    result: {
      groups: [],
      servers: [{ name: "vercel", status: "needs_auth" }],
      live: true,
      canAdd: false,
      appliesNextTurn: false,
    },
  });
  host.send({ type: "mcp.provider.reconnect", provider, name: "vercel", requestId: "reconnect" });
  expect(await host.next()).toMatchObject({ type: "mcp.result", requestId: "reconnect" });
  expect(await sources(provider, "after")).toMatchObject({
    result: { servers: [{ name: "vercel", status: "connected" }] },
  });
  expect(await sources(other, "other")).toMatchObject({ result: { live: false, servers: [] } });
  host.send({ type: "mcp.provider.reconnect", provider: other, name: "vercel", requestId: "idle" });
  expect(await host.next()).toMatchObject({ type: "error", code: "mcp_failed", requestId: "idle" });
  lifetime.abort();
  expect(await sources(provider, "ended")).toMatchObject({ result: { live: false, servers: [] } });
});

test("a slow native MCP control leaves pings and other requests responsive", async () => {
  const providers = new McpProviderSessions();
  const f = await setup({ mcp: { providers } });
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const lifetime = new AbortController();
  providers.bind(
    f.thread.id,
    f.thread.provider,
    {
      async status() {
        started.resolve();
        await released.promise;
        return [{ name: "slow", status: "connected" }];
      },
      async replace() {
        return {};
      },
      async reconnect() {},
      async enable() {},
      async disable() {},
    },
    lifetime.signal,
  );
  const client = await f.connect();
  await client.next();
  try {
    client.send({ type: "mcp.status", threadId: f.thread.id, requestId: "slow" });
    await started.promise;
    client.send({ type: "ping" });
    expect(await client.next()).toMatchObject({ type: "pong" });
    released.resolve();
    expect(await client.next()).toMatchObject({
      type: "mcp.result",
      requestId: "slow",
      result: [{ name: "slow" }],
    });
  } finally {
    released.resolve();
    lifetime.abort();
  }
});

test("a native MCP control deadline reports one request error and keeps later requests usable", async () => {
  const providers = new McpProviderSessions();
  const f = await setup({ mcp: { providers } });
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const lifetime = new AbortController();
  const deadline = new AbortController();
  providers.bind(
    f.thread.id,
    f.thread.provider,
    {
      async status() {
        started.resolve();
        await released.promise;
        return [];
      },
      async replace() {
        return {};
      },
      async reconnect() {},
      async enable() {},
      async disable() {},
    },
    lifetime.signal,
  );
  const client = await f.connect();
  await client.next();
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const clock = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => (ms === 120_000 ? deadline.signal : timeout(ms)));
  try {
    client.send({ type: "mcp.status", threadId: f.thread.id, requestId: "expired" });
    await started.promise;
    deadline.abort();
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "mcp_failed",
      requestId: "expired",
    });
    clock.mockRestore();
    released.resolve();
    client.send({ type: "mcp.status", threadId: f.thread.id, requestId: "recovered" });
    expect(await client.next()).toMatchObject({
      type: "mcp.result",
      requestId: "recovered",
      result: [],
    });
  } finally {
    clock.mockRestore();
    released.resolve();
    lifetime.abort();
  }
});

test("closing a socket detaches a stalled MCP control before draining server tasks", async () => {
  const providers = new McpProviderSessions();
  const f = await setup({ mcp: { providers } });
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const lifetime = new AbortController();
  providers.bind(
    f.thread.id,
    f.thread.provider,
    {
      async status() {
        started.resolve();
        await released.promise;
        return [];
      },
      async replace() {
        return {};
      },
      async reconnect() {},
      async enable() {},
      async disable() {},
    },
    lifetime.signal,
  );
  const client = await f.connect();
  await client.next();
  try {
    client.send({ type: "mcp.status", threadId: f.thread.id, requestId: "closing" });
    await started.promise;
    await client.close();
    await f.server.close();
  } finally {
    released.resolve();
    lifetime.abort();
  }
});
