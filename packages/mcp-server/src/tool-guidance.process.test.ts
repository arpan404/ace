import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, test, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "./index.ts";
import { scope } from "./test-support.ts";

// The server never reads which client it serves; one legacy and one modern client suffice.
test.each(["codex", "opencode"])(
  "%s cannot discover or execute disabled screen and simulator tools",
  async (provider) => {
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    let effects = 0;
    for (const [name, capability] of [
      ["screen_state", "screen"],
      ["sim_list", "devices"],
    ] as const)
      registry.register({
        name,
        capability,
        description: name,
        input: z.object({}),
        output: z.object({}),
        timeoutMs: 1000,
        async run() {
          effects++;
          return {};
        },
      });
    const credentials = new CredentialRegistry(() => "a".repeat(64));
    const server = await startMcpServer({
      registry,
      credentials,
      status: () => ({
        access: "full-access",
        disabled: { screen: "Computer use is disabled.", devices: "Devices are disabled." },
      }),
    });
    onTestFinished(() => server.close());
    const lease = credentials.issue(
      scope("root", ["screen", "devices"]),
      new AbortController().signal,
    );
    const client = new Client(
      { name: provider, version: "test" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    onTestFinished(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${lease.bearer}` } },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "context",
      "tools_find",
    ]);
    expect(await client.callTool({ name: "screen_state", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(await client.callTool({ name: "sim_list", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(effects).toBe(0);
    expect(await client.callTool({ name: "context", arguments: {} })).toMatchObject({
      structuredContent: {
        status: {
          groups: expect.arrayContaining([
            { name: "screen", enabled: false, reason: "Computer use is disabled." },
          ]),
        },
      },
    });
  },
);

// Cursor and ACP connect like Claude (legacy), Pi like OpenCode (modern).
test.each([
  { provider: "codex", mode: "legacy", nativeInstructions: true },
  { provider: "claude", mode: "legacy", nativeInstructions: false },
  { provider: "opencode", mode: "modern", nativeInstructions: false },
] as const)(
  "$provider offers every computer use tool once it is on, read-only mode included, and hides them when it is off",
  async ({ provider, mode, nativeInstructions }) => {
    let enabled = false,
      readOnly = false,
      effects = 0;
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    for (const name of ["screen_state", "sim_list"])
      registry.register({
        name,
        capability: name === "sim_list" ? "devices" : "screen",
        description: "Operate a native app",
        input: z.object({}),
        output: z.object({}),
        timeoutMs: 1000,
        async run() {
          effects++;
          return {};
        },
      });
    const credentials = new CredentialRegistry(() => "c".repeat(64));
    const server = await startMcpServer({
      registry,
      credentials,
      status: () => ({
        access: readOnly ? ("read-only" as const) : ("full-access" as const),
        disabled: enabled
          ? {}
          : { screen: "Computer use is disabled.", devices: "Devices are disabled." },
      }),
    });
    onTestFinished(() => server.close());
    const lease = credentials.issue(
      scope("root", ["screen", "devices"]),
      new AbortController().signal,
    );
    const client = new Client(
      { name: provider, version: "test" },
      { versionNegotiation: { mode: mode === "legacy" ? "legacy" : { pin: "2026-07-28" } } },
    );
    onTestFinished(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${lease.bearer}`,
            "X-Ace-Notifications": "stream",
            ...(nativeInstructions ? { "X-Ace-Instructions": "native" } : {}),
          },
        },
      }),
    );
    const notifications: (() => void)[] = [];
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notifications.shift()?.();
    });
    if (mode === "modern") await client.listen({ toolsListChanged: true });
    if (nativeInstructions) expect(client.getInstructions()).toBeUndefined();
    else expect(client.getInstructions()).toContain("browser_open");
    const listed = async () => (await client.listTools()).tools;
    expect((await listed()).map((tool) => tool.name)).toEqual(["context", "tools_find"]);
    const change = async (mutate: () => void) => {
      const changed = Promise.withResolvers<void>();
      notifications.push(changed.resolve);
      mutate();
      // A legacy GET stream's headers only arrive with its first event, so the client can't
      // tell when the stream is attached; announce until the change reaches the client.
      server.toolsChanged();
      const again = setInterval(() => server.toolsChanged(), 50);
      await changed.promise.finally(() => clearInterval(again));
      return (await listed()).map((tool) => tool.name);
    };
    expect(
      await change(() => {
        enabled = true;
      }),
    ).toEqual(["context", "tools_find", "screen_state", "sim_list"]);
    for (const tool of await listed())
      expect(tool.description).not.toContain("ace tools add ace-specific actions");
    expect(await client.callTool({ name: "screen_state", arguments: {} })).not.toMatchObject({
      isError: true,
    });
    // Read-only is the provider's own mode: its permission system decides each call.
    expect(
      await change(() => {
        readOnly = true;
      }),
    ).toEqual(["context", "tools_find", "screen_state", "sim_list"]);
    expect(await client.callTool({ name: "sim_list", arguments: {} })).not.toMatchObject({
      isError: true,
    });
    expect(effects).toBe(2);
    expect(
      await change(() => {
        enabled = false;
      }),
    ).toEqual(["context", "tools_find"]);
    expect(await client.callTool({ name: "screen_state", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(effects).toBe(2);
    lease.end();
  },
);

test("legacy notification streams cannot be reused with another lease and end on revocation", async () => {
  let next = 0;
  const credentials = new CredentialRegistry(() => (++next).toString(16).padStart(64, "0"));
  const server = await startMcpServer({
    registry: new ToolRegistry({ scheduler: nodeScheduler }),
    credentials,
  });
  onTestFinished(() => server.close());
  const lease = credentials.issue(scope("root", []), new AbortController().signal);
  const other = credentials.issue(scope("other", []), new AbortController().signal);
  const client = new Client(
    { name: "legacy", version: "test" },
    { versionNegotiation: { mode: "legacy" } },
  );
  onTestFinished(() => client.close());
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${lease.bearer}`, "X-Ace-Notifications": "stream" },
    },
  });
  await client.connect(transport);
  expect(transport.sessionId).toBeTruthy();
  const request = (bearer: string) =>
    fetch(server.url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Ace-Notifications": "stream",
        "Mcp-Session-Id": transport.sessionId ?? "",
        "MCP-Protocol-Version": "2025-11-25",
        Accept: "text/event-stream",
      },
    });
  expect((await request(other.bearer)).status).toBe(404);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    "context",
    "tools_find",
  ]);
  lease.end();
  expect((await request(lease.bearer)).status).toBe(401);
  expect((await request(other.bearer)).status).toBe(404);
});
