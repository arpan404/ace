import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, Capabilities } from "@ace/protocol";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { withDaemonMcp } from "./services/provider-mcp.ts";
import { setup, invoke, Result } from "./browser-mcp-test-support.ts";
it.each(["codex", "opencode", "cursor", "antigravity", "acp"] as const)(
  "%s sessions receive browser tools bound to their own thread and lose authority on close",
  async (provider) => {
    const f = await setup(provider);
    let captured: SessionContext | undefined;
    const source: ProviderAdapter = {
      provider,
      capabilities: () =>
        Capabilities.parse({
          steer: false,
          interruptCascades: false,
          resume: false,
          fork: false,
          subagentTranscripts: false,
          backgroundTaskControl: false,
          backgroundVisibility: "none",
          planMode: false,
        }),
      createTranslator: () => ({ translate: () => [], tick: () => [] }),
      async openSession(ctx) {
        captured = ctx;
        return {
          nativeSessionId: "fake",
          send: async () => {},
          interrupt: async () => {},
          resolve: async () => {},
          stopTask: async () => {},
          close: async () => {},
        };
      },
    };
    const adapter = withDaemonMcp(
      { store: f.store, services: { mcp: f.mcp }, id: () => "session" },
      source,
    );
    const session = await adapter.openSession({
      threadId: f.thread.id,
      cwd: f.home,
      signal: new AbortController().signal,
      onFrame() {},
      onExit() {},
    });
    const connection = captured?.aceMcp;
    if (!connection) throw new Error("Missing MCP connection");
    const result = Result.parse(
      await (
        await invoke(connection, "ace_browser_open", { url: "http://localhost:3000/agent" })
      ).json(),
    );
    expect(result.result.isError).not.toBe(true);
    expect(f.browser.state(f.thread.id)).toMatchObject({
      url: "http://localhost:3000/agent",
      backend: "headless",
    });
    f.browser.takeover(f.thread.id, "human");
    const rejected = Result.parse(
      await (await invoke(connection, "ace_browser_scroll", { x: 0, y: 1 })).json(),
    );
    expect(rejected.result.isError).toBe(true);
    await session.close("shutdown");
    expect((await invoke(connection, "ace_browser_open", {})).status).toBe(401);
  },
);
it("browser MCP capability filtering denies ungranted callers", async () => {
  const f = await setup("claude");
  const lease = f.mcp.openSession(
    {
      sessionId: "sdk",
      threadId: f.thread.id,
      agentId: Agent.parse(f.store.getMcpAgent(f.thread.id, "root")).id,
      capabilities: [],
    },
    new AbortController().signal,
  );
  const result = Result.parse(
    await (await invoke({ url: f.mcp.url, bearer: lease.bearer }, "ace_browser_open", {})).json(),
  );
  expect(result.result.isError).toBe(true);
  expect(() => f.browser.state(f.thread.id)).toThrow("not open");
  lease.end();
});

it("browser MCP lazily opens a selected backend and returns its screenshot inline", async () => {
  const f = await setup("codex");
  const lease = f.mcp.openSession(
    {
      sessionId: "screenshot",
      threadId: f.thread.id,
      agentId: Agent.parse(f.store.getMcpAgent(f.thread.id, "root")).id,
      capabilities: ["browser"],
    },
    new AbortController().signal,
  );
  try {
    const response = await invoke(
      { url: f.mcp.url, bearer: lease.bearer },
      "ace_browser_screenshot",
      {},
    );
    const result = z
      .object({
        result: z.object({
          content: z.array(z.object({ type: z.string(), mimeType: z.string(), data: z.string() })),
        }),
      })
      .parse(await response.json());
    expect(result.result.content).toEqual([
      { type: "image", mimeType: "image/jpeg", data: "AA==" },
    ]);
    expect(f.browser.state(f.thread.id)).toMatchObject({ backend: "headless", status: "ready" });
  } finally {
    lease.end();
  }
});
