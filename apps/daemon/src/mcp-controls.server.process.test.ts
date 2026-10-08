import { expect, test } from "vitest";
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
    {
      async status() {
        return [
          { name: "project", status: projectStatus, source: "project", extension: 42 },
          ...Object.keys(dynamic).map((name) => ({ name, source: "dynamic" })),
        ];
      },
      async replace(servers) {
        if ("broken" in servers) throw new Error("Native connection refused");
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
    message: "Native connection refused",
  });
  lifetime.abort();
  host.send({ type: "mcp.status", threadId: f.thread.id, requestId: "expired" });
  expect(await host.next()).toMatchObject({
    type: "error",
    code: "mcp_failed",
    requestId: "expired",
  });
});
