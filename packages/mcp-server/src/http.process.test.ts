import { z } from "zod";
import type { Transport as LegacyWire } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { registerBuiltins } from "./index.ts";
import { deferred, harness, scope, thread } from "./test-support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const input = z.strictObject({ value: z.string().max(100) });
const output = z.strictObject({ value: z.string().max(100) });

it("serves current discovery and structured tools through a real MCP client", async () => {
  const h = await harness(cleanups);
  h.registry.register({
    name: "ace_echo",
    description: "Echo",
    input,
    output,
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      return value;
    },
  });
  const { client } = await h.connect();
  expect(client.getServerVersion()).toMatchObject({ name: "ace" });
  const listed = await client.listTools();
  expect(listed.tools.filter((tool) => tool.name === "ace_echo")).toMatchObject([
    {
      name: "ace_echo",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
    },
  ]);
  expect(await client.callTool({ name: "ace_echo", arguments: { value: "hello" } })).toMatchObject({
    structuredContent: { value: "hello" },
  });
});

it("negotiates the legacy handshake with the monolithic SDK client", async () => {
  const h = await harness(cleanups);
  h.registry.register({
    name: "ace_echo",
    description: "Echo",
    input,
    output,
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      return value;
    },
  });
  const lease = h.credentials.issue(scope(), new AbortController().signal);
  const client = new LegacyClient({ name: "legacy", version: "1" });
  cleanups.push(() => client.close());
  const transport = new LegacyTransport(new URL(h.server.url), {
    requestInit: { headers: { Authorization: `Bearer ${lease.bearer}` } },
  });
  // v1's own optional sessionId declaration is incompatible with exactOptionalPropertyTypes.
  const wire: LegacyWire = {
    start: () => transport.start(),
    close: () => transport.close(),
    send: (message, options) => transport.send(message, options),
  };
  // SDK Transport uses callback properties, not DOM events.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onmessage = (message) => wire.onmessage?.(message);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onerror = (error) => wire.onerror?.(error);
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = () => wire.onclose?.();
  await client.connect(wire);
  expect(client.getServerVersion()?.name).toBe("ace");
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "ace_status",
    "ace_echo",
  ]);
  expect(await client.callTool({ name: "ace_echo", arguments: { value: "legacy" } })).toMatchObject(
    { structuredContent: { value: "legacy" } },
  );
});

it("filters unauthorized tools and rejects direct capability bypasses", async () => {
  const h = await harness(cleanups);
  const effects: string[] = [];
  h.registry.register({
    name: "ace_echo",
    description: "Echo",
    input,
    output,
    capability: "browser",
    timeoutMs: 1000,
    async run(value) {
      effects.push(value.value);
      return value;
    },
  });
  const denied = await h.connect();
  expect((await denied.client.listTools()).tools.map((tool) => tool.name)).toEqual(["ace_status"]);
  expect(
    await denied.client.callTool({ name: "ace_echo", arguments: { value: "denied" } }),
  ).toMatchObject({ isError: true });
  expect(effects).toEqual([]);
  const allowed = await h.connect(scope("child", ["browser"]));
  expect(
    await allowed.client.callTool({ name: "ace_echo", arguments: { value: "allowed" } }),
  ).toMatchObject({ structuredContent: { value: "allowed" } });
  expect(effects).toEqual(["allowed"]);
});

it("revokes authority when the provider session ends and rejects every later HTTP method", async () => {
  const h = await harness(cleanups);
  const { lease, lifetime } = await h.connect();
  lifetime.abort();
  for (const method of ["POST", "GET", "DELETE"]) {
    const response = await fetch(h.server.url, {
      method,
      headers: { Authorization: `Bearer ${lease.bearer}` },
    });
    expect(response.status).toBe(401);
  }
});

it("attributes concurrent builtin intents to each credential's own node", async () => {
  const h = await harness(cleanups);
  const notices: unknown[] = [];
  const spawns: unknown[] = [];
  registerBuiltins(
    h.registry,
    {
      async thread() {
        return thread;
      },
      async agents() {
        return { agents: [], nextCursor: null };
      },
    },
    {
      async notify(intent) {
        notices.push(intent);
        return { intentId: `notice-${intent.agentId}` };
      },
      async spawn(intent) {
        spawns.push(intent);
        return { intentId: `spawn-${intent.agentId}` };
      },
    },
  );
  const [root, child] = await Promise.all([
    h.connect(scope("root", ["notify", "agents"])),
    h.connect(scope("child", ["notify", "agents"])),
  ]);
  const responses = await Promise.all([
    root.client.callTool({ name: "ace_notify_user", arguments: { text: "Help" } }),
    child.client.callTool({
      name: "ace_spawn_agent",
      arguments: { task: "Review", provider: "claude" },
    }),
  ]);
  expect(responses).toMatchObject([
    { structuredContent: { accepted: true, intentId: "notice-root" } },
    { structuredContent: { accepted: true, intentId: "spawn-child" } },
  ]);
  expect(notices).toEqual([
    {
      type: "mcp.notify",
      threadId: "thread",
      agentId: "root",
      sessionId: "session-root",
      notice: { text: "Help", level: "info" },
    },
  ]);
  expect(spawns).toEqual([
    {
      type: "mcp.spawn",
      threadId: "thread",
      agentId: "child",
      sessionId: "session-child",
      input: { task: "Review", provider: "claude" },
    },
  ]);
  expect(await root.client.callTool({ name: "ace_thread_info" })).toMatchObject({
    structuredContent: { thread: { status: { state: "waiting", on: "background_task" } } },
  });
  expect(
    await child.client.callTool({
      name: "ace_spawn_agent",
      arguments: { task: "Spoof", agentId: "root" },
    }),
  ).toMatchObject({ isError: true });
  expect(spawns).toHaveLength(1);
});

it("starts independent tool calls while another call is still waiting", async () => {
  const h = await harness(cleanups, { after: () => () => {} });
  const started = deferred<void>();
  const release = deferred<void>();
  h.registry.register({
    name: "ace_echo",
    description: "Echo",
    input,
    output,
    capability: null,
    timeoutMs: 1000,
    async run(value) {
      if (value.value === "first") {
        started.resolve();
        await release.promise;
      }
      return value;
    },
  });
  const { client } = await h.connect();
  const first = client.callTool({ name: "ace_echo", arguments: { value: "first" } });
  await started.promise;
  try {
    expect(
      await client.callTool({ name: "ace_echo", arguments: { value: "second" } }),
    ).toMatchObject({ structuredContent: { value: "second" } });
  } finally {
    release.resolve();
  }
  expect(await first).toMatchObject({ structuredContent: { value: "first" } });
});

it("rejects hostile origins, malformed requests and oversized bodies", async () => {
  const h = await harness(cleanups);
  const { lease } = await h.connect();
  const headers = {
    Authorization: `Bearer ${lease.bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  expect(
    (
      await fetch(h.server.url, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
  ).toBe(403);
  expect((await fetch(h.server.url, { method: "POST", headers, body: "{" })).status).toBe(400);
  expect(
    (await fetch(h.server.url, { method: "POST", headers, body: "x".repeat(65537) })).status,
  ).toBe(413);
  expect((await fetch(h.server.url + "/wrong", { headers })).status).toBe(404);
});

it("routes a browser workstream adapter through schema checks, attribution and capability scope", async () => {
  const h = await harness(cleanups);
  const effects: string[] = [];
  const { registerAutomationTool } = await import("./index.ts");
  registerAutomationTool(
    h.registry,
    {
      name: "ace_browser_open",
      description: "Open browser",
      input: z.strictObject({ url: z.url() }),
      output: z.strictObject({ tabId: z.string(), agent: z.string() }),
      capability: "browser",
      timeoutMs: 1000,
    },
    {
      async execute(value, context) {
        context.signal.throwIfAborted();
        effects.push(value.url);
        return { tabId: new URL(value.url).hostname, agent: context.caller.agentId };
      },
    },
  );
  const denied = await h.connect();
  expect((await denied.client.listTools()).tools.map((tool) => tool.name)).toEqual(["ace_status"]);
  expect(
    await denied.client.callTool({
      name: "ace_browser_open",
      arguments: { url: "https://denied.example" },
    }),
  ).toMatchObject({ isError: true });
  expect(effects).toEqual([]);
  const { client } = await h.connect(scope("browser-child", ["browser"]));
  expect(
    await client.callTool({ name: "ace_browser_open", arguments: { url: "https://example.com" } }),
  ).toMatchObject({ structuredContent: { tabId: "example.com", agent: "browser-child" } });
  expect(
    await client.callTool({ name: "ace_browser_open", arguments: { url: "invalid" } }),
  ).toMatchObject({ isError: true });
  expect(effects).toEqual(["https://example.com"]);
});
