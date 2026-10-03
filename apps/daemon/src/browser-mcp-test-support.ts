import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { z } from "zod";
import { Agent, type ProviderKind } from "@ace/protocol";
import { BrowserService, type BrowserBackend, type BackendOpen } from "@ace/browser";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { startDaemonMcp } from "./mcp.ts";
import { browserToolkit } from "./browser-toolkit.ts";
export const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
export const Result = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })),
    isError: z.boolean().optional(),
  }),
});
export async function invoke(
  connection: { url: string; bearer: string },
  name: string,
  args: unknown,
) {
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
export async function setup(provider: ProviderKind) {
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
