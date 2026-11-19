import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { expect, onTestFinished, test } from "vitest";
import {
  CredentialRegistry,
  ToolRegistry,
  codexClientHeader,
  cursorClientHeader,
  guideToolkit,
  nodeScheduler,
  startMcpServer,
} from "./index.ts";
import { scope } from "./test-support.ts";

/**
 * Devices are on by default, so a session listing every tool holds the simulator tools back
 * until it first uses devices; its client reloads the list it is told changed. Clients that
 * never reload (Codex, Cursor) list them from the start. Real MCP clients over HTTP.
 */
async function serve() {
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  guideToolkit([
    { name: "ace-computer-use", description: "Drive apps and simulators", body: "How to." },
  ]).register(registry);
  const tool = (name: string, capability: "screen" | "devices", description: string) =>
    registry.register({
      name,
      description,
      capability,
      timeoutMs: 1000,
      input: z.object({}),
      output: z.object({ ran: z.string() }),
      async run() {
        return { ran: name };
      },
    });
  tool("screen_state", "screen", "Read a native app's state.");
  tool("sim_list", "devices", "List the iOS simulators and Android emulators.");
  tool("sim_start", "devices", "Boot a simulator or emulator.");
  let next = 0;
  const credentials = new CredentialRegistry(() => (++next).toString(16).padStart(64, "0"));
  const server = await startMcpServer({ registry, credentials });
  onTestFinished(() => server.close());
  return { server, credentials };
}

async function connect(
  { server, credentials }: Awaited<ReturnType<typeof serve>>,
  headers: Record<string, string> = {},
) {
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  const lease = credentials.issue(scope("root", ["screen", "devices"]), lifetime.signal);
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
          Authorization: `Bearer ${lease.bearer}`,
          "X-Ace-Notifications": "stream",
          ...headers,
        },
      },
    }),
  );
  let changes = 0;
  const heard: (() => void)[] = [];
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    changes++;
    heard.shift()?.();
  });
  await client.listen({ toolsListChanged: true });
  const nextChange = () => {
    const changed = Promise.withResolvers<void>();
    heard.push(changed.resolve);
    return changed.promise;
  };
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
  return { client, names, nextChange, changes: () => changes };
}

const sims = (names: string[]) => names.filter((name) => name.startsWith("sim_"));

test.each([
  ["finding them", "tools_find", { query: "simulators emulators" }],
  ["reading the guide", "guide", { topic: "ace-computer-use" }],
  ["opening a native app", "screen_state", {}],
] as const)(
  "a fresh session lists the simulator tools after %s, then calls one",
  async (_, opener, args) => {
    const agent = await connect(await serve());
    const before = await agent.names();
    expect(before).toEqual(expect.arrayContaining(["tools_find", "guide", "screen_state"]));
    expect(sims(before)).toEqual([]);
    const changed = agent.nextChange();
    expect((await agent.client.callTool({ name: opener, arguments: args })).isError).not.toBe(true);
    await changed;
    expect(sims(await agent.names()).toSorted()).toEqual(["sim_list", "sim_start"]);
    expect(
      (await agent.client.callTool({ name: "sim_list", arguments: {} })).structuredContent,
    ).toMatchObject({ ran: "sim_list" });
    // Later devices use changes nothing more, so the client's prompt cache holds.
    await agent.client.callTool({ name: "screen_state", arguments: {} });
    await agent.client.callTool({ name: "guide", arguments: { topic: "ace-computer-use" } });
    expect(agent.changes()).toBe(1);
  },
);

test("clients that never reload list the simulator tools from the start", async () => {
  const served = await serve();
  for (const header of [codexClientHeader, cursorClientHeader]) {
    const agent = await connect(served, { [header.name]: header.value });
    expect(sims(await agent.names()).toSorted(), header.value).toEqual(["sim_list", "sim_start"]);
  }
});
