import { expect, test } from "vitest";
import { z } from "zod";
import { ThreadId, AgentId } from "@ace/protocol";
import { CredentialRegistry, ToolRegistry, nodeScheduler, startMcpServer } from "@ace/mcp-server";
import { createOpenCodeAdapter } from "./index.ts";
import { setup } from "./testing/v2-session.ts";

test("OpenCode v2 native processes preserve user MCP servers and isolate thread authority within an account", async () => {
  let id = 0;
  const credentials = new CredentialRegistry(() => (++id).toString(16).padStart(64, "0"));
  const registry = new ToolRegistry({ scheduler: nodeScheduler });
  registry.register({
    name: "ace_scope",
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
      await adapter.openSession({
        threadId: ThreadId.parse(`thread-${index}`),
        cwd: "/account",
        instanceId: "same-account",
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            mcp: { user: { type: "remote", url: "https://example.invalid" } },
          }),
        },
        signal: new AbortController().signal,
        aceMcp: { url: mcp.url, bearer: lease.bearer },
        onFrame() {},
        onExit() {},
      });
      transports.push(h.transport());
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
