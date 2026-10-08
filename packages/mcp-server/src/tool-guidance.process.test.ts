import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, test, onTestFinished } from "vitest";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "./index.ts";
import { scope } from "./test-support.ts";

test.each(["codex", "claude", "opencode", "cursor", "pi", "acp"])(
  "%s cannot discover or execute disabled screen and device tools",
  async (provider) => {
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    let effects = 0;
    for (const [name, capability] of [
      ["screen_request_app", "screen"],
      ["device_list", "devices"],
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
        permissionMode: "full-access",
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
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ace_status"]);
    expect(await client.callTool({ name: "screen_request_app", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(await client.callTool({ name: "device_list", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(effects).toBe(0);
    expect(await client.callTool({ name: "ace_status", arguments: {} })).toMatchObject({
      structuredContent: {
        groups: expect.arrayContaining([
          { name: "screen", enabled: false, reason: "Computer use is disabled." },
        ]),
      },
    });
  },
);

test.each([
  { provider: "codex", mode: "legacy", nativeInstructions: true },
  { provider: "claude", mode: "legacy", nativeInstructions: false },
  { provider: "opencode", mode: "modern", nativeInstructions: false },
  { provider: "cursor", mode: "legacy", nativeInstructions: false },
  { provider: "pi", mode: "modern", nativeInstructions: false },
  { provider: "acp", mode: "legacy", nativeInstructions: false },
] as const)(
  "$provider refreshes staged computer use on enable, grant, revocation and read-only changes",
  async ({ provider, mode, nativeInstructions }) => {
    let enabled = false,
      approved = false,
      readOnly = false,
      effects = 0;
    const registry = new ToolRegistry({ scheduler: nodeScheduler });
    for (const name of ["screen_request_app", "screen_open_app", "device_list"])
      registry.register({
        name,
        capability: name === "device_list" ? "devices" : "screen",
        description: "Operate the approved native app",
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
        permissionMode: readOnly ? "read-only" : "full-access",
        disabled: enabled
          ? {}
          : { screen: "Computer use is disabled.", devices: "Devices are disabled." },
        screenApproved: approved,
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
    const stream = Promise.withResolvers<void>();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${lease.bearer}`,
            "X-Ace-Notifications": "stream",
            ...(nativeInstructions ? { "X-Ace-Instructions": "native" } : {}),
          },
        },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if ((init?.method ?? (input instanceof Request ? input.method : "GET")) === "GET")
            stream.resolve();
          return response;
        },
      }),
    );
    const notifications: (() => void)[] = [];
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notifications.shift()?.();
    });
    if (mode === "modern") await client.listen({ toolsListChanged: true });
    else await stream.promise;
    if (nativeInstructions) expect(client.getInstructions()).toBeUndefined();
    else expect(client.getInstructions()).toContain("Websites and web apps, including localhost");
    const listed = async () => (await client.listTools()).tools;
    expect((await listed()).map((tool) => tool.name)).toEqual(["ace_status"]);
    const change = async (mutate: () => void) => {
      const changed = Promise.withResolvers<void>();
      notifications.push(changed.resolve);
      mutate();
      server.toolsChanged();
      await changed.promise;
      return (await listed()).map((tool) => tool.name);
    };
    expect(
      await change(() => {
        enabled = true;
      }),
    ).toEqual(["ace_status", "screen_request_app", "device_list"]);
    expect(await client.callTool({ name: "screen_open_app", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(
      await change(() => {
        approved = true;
      }),
    ).toEqual(["ace_status", "screen_request_app", "screen_open_app", "device_list"]);
    for (const tool of await listed())
      expect(tool.description).not.toContain("ace tools for this thread.");
    expect(await client.callTool({ name: "screen_open_app", arguments: {} })).not.toMatchObject({
      isError: true,
    });
    expect(effects).toBe(1);
    expect(
      await change(() => {
        approved = false;
      }),
    ).toEqual(["ace_status", "screen_request_app", "device_list"]);
    expect(
      await change(() => {
        readOnly = true;
      }),
    ).toEqual(["ace_status"]);
    expect(await client.callTool({ name: "screen_request_app", arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(effects).toBe(1);
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
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["ace_status"]);
  lease.end();
  expect((await request(lease.bearer)).status).toBe(401);
  expect((await request(other.bearer)).status).toBe(404);
});
