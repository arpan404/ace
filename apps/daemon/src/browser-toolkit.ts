import { PublicToolError } from "@ace/mcp-server/errors";
import { ThreadId } from "@ace/protocol";
import {
  browserToolkit as scopedBrowserToolkit,
  type BrowserMachineRoute,
  type BrowserService,
} from "@ace/browser";
import type { Toolkit } from "@ace/mcp-server";
import type { Store } from "./store.ts";

/**
 * Trusted MCP attribution chooses the thread; agents cannot supply another thread id. With a
 * route, every tool also takes `machine` to act in another paired machine's browser instead.
 */
export function browserToolkit(
  browser: BrowserService,
  store: Store,
  route?: BrowserMachineRoute,
): Toolkit {
  const open = async (threadId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const id = ThreadId.parse(threadId);
    const thread = store.getThread(id);
    if (!thread) throw new Error("Browser thread unavailable");
    await browser.open({ threadId: id, workspaceId: thread.workspaceId, background: true });
    signal.throwIfAborted();
    const state = browser.state(id);
    if (state.takeoverMode === "private") throw new PublicToolError("human_private");
    return state;
  };
  return scopedBrowserToolkit(
    {
      open,
      async execute(threadId, command, signal) {
        await open(threadId, signal);
        return browser.execute(threadId, command, { kind: "agent" }, signal);
      },
      async screenshot(threadId, signal) {
        await open(threadId, signal);
        return browser.screenshot(threadId, signal);
      },
      async close(threadId, signal) {
        signal.throwIfAborted();
        await browser.closeThread(threadId, { kind: "agent" }, signal);
      },
    },
    route,
  );
}
