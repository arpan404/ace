import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Agent, Capabilities, type ProviderKind } from "@ace/protocol";
import { BrowserService, type BrowserBackend, type BackendOpen } from "@ace/browser";
import type { ProviderAdapter, SessionContext } from "@ace/engine-api";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";
import { withDaemonMcp } from "./services/provider-mcp.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const Result = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })),
    isError: z.boolean().optional(),
  }),
});
async function invoke(connection: { url: string; bearer: string }, name: string, args: unknown) {
  return fetch(connection.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}
async function setup(provider: ProviderKind) {
  const home = await mkdtemp(join(tmpdir(), "ace-browser-mcp-"));
  const store = new Store(join(home, "store.sqlite"));
  const workspace = store.createWorkspace(home, "Test"),
    thread = createDevThread(store, workspace);
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider },
    fidelity: "full",
    cwd: home,
    status: { state: "idle" },
    createdAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "agent.created", agent }], 1);
  let url = "about:blank";
  const events = new EventEmitter();
  const backend: BrowserBackend = {
    kind: "headless",
    async open(request: BackendOpen) {
      return {
        cdp: {
          send: async (method) => (method === "Page.captureScreenshot" ? { data: "AA==" } : {}),
          on: (method, listener) => events.on(method, listener),
          off: (method, listener) => events.off(method, listener),
        },
        url: () => url,
        navigate: async (destination) => {
          url = destination;
          request.navigation();
        },
        click: async () => {},
        insertText: async () => {},
        press: async () => {},
        wheel: async () => {},
        screenshot: async () => Buffer.from([0]),
        resize: async () => {},
        viewport: () => ({ width: 1280, height: 720 }),
        media: async () => {},
        controller: async () => {},
        close: async () => {},
      };
    },
  };
  const browser = new BrowserService({ dataDir: home, headlessBackend: backend });
  const mcp = await startDaemonMcp(store, [browserToolkit(browser, store)]);
  cleanups.push(async () => {
    await mcp.close();
    await browser.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, thread, browser, mcp, store };
}
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
