import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, onTestFinished, test } from "vitest";
import {
  CredentialRegistry,
  ToolRegistry,
  aceToolDispatch,
  coreToolsHeader,
  guideToolkit,
  nodeScheduler,
  startMcpServer,
  type NotificationStreamLimits,
} from "./index.ts";
import { scope } from "./test-support.ts";

/**
 * Many agent sessions share one ace MCP server, each holding a `subscriptions/listen` stream to
 * hear its own tool list grow. Streams are bounded per lease, so concurrent sessions are never
 * starved by a server-wide count, reconnects are never refused, and an ended lease frees its
 * slots. Real HTTP server, real MCP clients.
 */
async function fixture(limits?: Partial<NotificationStreamLimits>) {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  guideToolkit([
    { name: "ace-threads", description: "Threads", body: "How threads work." },
  ]).register(registry);
  registry.register({
    name: "threads_find",
    toolset: "ace-threads",
    description: "Find threads.",
    capability: null,
    timeoutMs: 1000,
    input: z.object({}),
    output: z.object({}),
    async run() {
      return {};
    },
  });
  let next = 0;
  const credentials = new CredentialRegistry(() => (++next).toString(16).padStart(64, "0"));
  const server = await startMcpServer({
    registry,
    credentials,
    ...(limits ? { notificationStreams: limits } : {}),
  });
  onTestFinished(() => server.close());
  const lease = (name: string) => {
    const lifetime = new AbortController();
    return {
      ...credentials.issue(scope(name, []), lifetime.signal),
      end: () => lifetime.abort(),
    };
  };
  /** A core-mode client of `bearer`'s lease, as OpenCode and Pi connect. */
  const connect = async (bearer: string) => {
    const client = new Client(
      { name: "agent", version: "test" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
      },
    );
    onTestFinished(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${bearer}`,
            [coreToolsHeader.name]: coreToolsHeader.value,
          },
        },
      }),
    );
    let heard = 0;
    const waiting: (() => void)[] = [];
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      heard++;
      waiting.shift()?.();
    });
    const nextChange = () => {
      const changed = Promise.withResolvers<void>();
      waiting.push(changed.resolve);
      return changed.promise;
    };
    return { client, nextChange, heard: () => heard };
  };
  const openFamily = (client: Client) =>
    client.callTool({ name: "guide", arguments: { topic: "ace-threads" } });
  return { server, lease, connect, openFamily };
}

test("twenty concurrent sessions each hold a stream and hear only their own list change", async () => {
  const f = await fixture();
  const sessions = await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      const session = await f.connect(f.lease(`agent-${index}`).bearer);
      await session.client.listen({ toolsListChanged: true });
      return session;
    }),
  );
  await Promise.all(
    sessions.map(async (session) => {
      const changed = session.nextChange();
      await f.openFamily(session.client);
      await changed;
    }),
  );
  // Each session heard the change it caused and none of the nineteen others.
  expect(sessions.map((session) => session.heard())).toEqual(sessions.map(() => 1));
  const listed = await sessions[19]?.client.listTools();
  expect(listed?.tools.map((tool) => tool.name)).toContain("threads_find");
});

test("a session reconnecting five times without closing is never refused and keeps two streams", async () => {
  // Room for three streams: five held by one lease would refuse its own reconnects.
  const f = await fixture({ total: 3 });
  const lease = f.lease("reconnecting");
  const attempts = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const session = await f.connect(lease.bearer);
    attempts.push({
      ...session,
      subscription: await session.client.listen({ toolsListChanged: true }),
    });
  }
  // The three oldest streams were closed by the server to make room for newer ones.
  expect(await Promise.all(attempts.slice(0, 3).map((entry) => entry.subscription.closed))).toEqual(
    ["remote", "remote", "remote"],
  );
  const latest = attempts.slice(3);
  const heard = latest.map((entry) => entry.nextChange());
  f.server.toolsChanged();
  await Promise.all(heard);
  expect(attempts.map((entry) => entry.heard())).toEqual([0, 0, 0, 1, 1]);
  // The lease holds two of the three slots, so another session still subscribes.
  const other = await f.connect(f.lease("other").bearer);
  await expect(other.client.listen({ toolsListChanged: true })).resolves.toBeDefined();
});

test("at the server-wide cap a session is refused a stream but still calls tools, and an ended lease frees its slot", async () => {
  const f = await fixture({ total: 2 });
  const first = f.lease("first");
  const holder = await f.connect(first.bearer);
  const held = await holder.client.listen({ toolsListChanged: true });
  const second = await f.connect(f.lease("second").bearer);
  await second.client.listen({ toolsListChanged: true });

  const late = await f.connect(f.lease("late").bearer);
  await expect(late.client.listen({ toolsListChanged: true })).rejects.toThrow(
    "Subscription limit reached",
  );
  // Without a stream the session reaches any tool through tools_call.
  const dispatched = await late.client.callTool({
    name: aceToolDispatch,
    arguments: { name: "threads_find", arguments: {} },
  });
  expect(dispatched.isError).not.toBe(true);

  first.end();
  expect(await held.closed).toBe("remote");
  await late.client.listen({ toolsListChanged: true });
  const changed = late.nextChange();
  await f.openFamily(late.client);
  await changed;
  expect(late.heard()).toBe(1);
});

test("a legacy client past the server-wide cap still works statelessly, and an ended lease frees its session", async () => {
  const f = await fixture({ total: 1 });
  const initialize = (bearer: string) =>
    fetch(f.server.url, {
      method: "POST",
      headers: legacyHeaders(bearer),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy", version: "1" },
        },
      }),
    });
  const holder = f.lease("holder");
  const held = await initialize(holder.bearer);
  await held.arrayBuffer();
  expect(held.headers.get("mcp-session-id")).toBeTruthy();

  const late = f.lease("late");
  const stateless = await initialize(late.bearer);
  await stateless.arrayBuffer();
  expect(stateless.status).toBe(200);
  expect(stateless.headers.get("mcp-session-id")).toBeNull();
  const listed = await fetch(f.server.url, {
    method: "POST",
    headers: legacyHeaders(late.bearer),
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  expect(listed.status).toBe(200);
  expect(await listed.text()).toContain('"guide"');

  holder.end();
  const reopened = await initialize(late.bearer);
  await reopened.arrayBuffer();
  expect(reopened.headers.get("mcp-session-id")).toBeTruthy();
});

function legacyHeaders(bearer: string) {
  return {
    Authorization: `Bearer ${bearer}`,
    "X-Ace-Notifications": "stream",
    "MCP-Protocol-Version": "2025-11-25",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
}
