import { expect, it, onTestFinished } from "vitest";
import { Agent } from "@ace/protocol";
import { backendFixture } from "@ace/browser/testing";
import { join } from "node:path";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";
import { invoke, Result } from "./browser-mcp-test-support.ts";

it("MCP cannot close a suspended browser holding a private tab", async () => {
  const lost = Promise.withResolvers<void>();
  const f = await backendFixture({
    backendPreference: () => "embedded",
    backendLoss: () => "pause",
    onBackendLost: () => lost.resolve(),
  });
  const store = new Store(join(f.home, "store.sqlite"));
  const thread = createDevThread(store, store.createWorkspace(f.home, "Paused owner"));
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: f.home,
    status: { state: "idle" },
    createdAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "agent.created", agent }]);
  const mcp = await startDaemonMcp(store, [browserToolkit(f.service, store)]);
  onTestFinished(async () => {
    await mcp.close();
    store.close();
  });
  const lease = mcp.openSession(
    { sessionId: "paused", threadId: thread.id, agentId: agent.id, capabilities: ["browser"] },
    new AbortController().signal,
  );
  const connection = { url: mcp.url, bearer: lease.bearer };
  await f.open(thread.id);
  f.service.setPrivate(thread.id, f.service.state(thread.id).activeTabId ?? "page", true);
  await f.disconnect();
  await lost.promise;
  const result = Result.parse(
    await (await invoke(connection, "browser_settings", { action: "close" })).json(),
  ).result;
  expect(result).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining("human_private") }],
  });
  expect(f.service.state(thread.id)).toMatchObject({
    status: "paused",
    closed: false,
  });
  f.service.setPrivate(thread.id, f.service.state(thread.id).activeTabId ?? "page", false);
  expect(
    Result.parse(await (await invoke(connection, "browser_settings", { action: "close" })).json())
      .result.isError,
  ).not.toBe(true);
  expect(() => f.service.state(thread.id)).toThrow("not open");
  lease.end();
});
