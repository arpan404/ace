import { PublicToolError } from "@ace/mcp-server/errors";
import { ThreadId } from "@ace/protocol";
import {
  browserToolkit as scopedBrowserToolkit,
  type BrowserCaller,
  type BrowserMachineRoute,
  type BrowserService,
  type BrowserToolPort,
} from "@ace/browser";
import type { Toolkit } from "@ace/mcp-server";
import type { Store } from "./store.ts";

/**
 * The person's own Chrome (ADR 0084): a thread's browser there, over the tabs agents open in
 * its ace window and the tabs the person shared. `available` is whether a browser is connected.
 */
export interface UserBrowserTools {
  sessions: BrowserService;
  available(): boolean;
}

const agentOf = (caller: BrowserCaller) => ({
  kind: "agent" as const,
  ...(caller.agentId ? { agentId: caller.agentId } : {}),
});

/**
 * One browser as the tools see it. Every call opens the thread's browser first, as an agent's
 * first call would; `connected` refuses calls while that browser cannot be reached.
 */
function port(service: BrowserService, store: Store, connected: () => void): BrowserToolPort {
  const ensure = async (caller: BrowserCaller, signal: AbortSignal) => {
    signal.throwIfAborted();
    connected();
    const threadId = ThreadId.parse(caller.threadId);
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("Browser thread unavailable");
    await service.open({ threadId, workspaceId: thread.workspaceId, background: true });
    signal.throwIfAborted();
    return threadId;
  };
  return {
    async open(caller, signal) {
      const threadId = await ensure(caller, signal);
      return service.claimTab(threadId, agentOf(caller));
    },
    async tab(caller, tabId, signal) {
      const threadId = await ensure(caller, signal);
      if (tabId === undefined) return service.currentTab(threadId, agentOf(caller));
      const listed = service.state(threadId).tabs?.find((tab) => tab.tabId === tabId);
      // An unknown tab fails on the command itself with tab_not_found.
      return { tabId, url: listed?.url ?? "", title: listed?.title ?? "" };
    },
    state: (caller) => service.state(caller.threadId),
    async execute(caller, command, signal) {
      const threadId = await ensure(caller, signal);
      return service.execute(threadId, command, agentOf(caller), signal);
    },
    async screenshot(caller, options, signal) {
      const threadId = await ensure(caller, signal);
      return service.screenshot(threadId, signal, options.tabId, options, agentOf(caller));
    },
    async close(caller, signal) {
      signal.throwIfAborted();
      await service.closeThread(caller.threadId, agentOf(caller), signal);
    },
  };
}

/**
 * Trusted MCP attribution chooses the thread; agents cannot supply another thread id. With a
 * route, every tool also takes `machine` to act in another paired machine's browser instead;
 * with `user`, `browser: "user"` to act in the person's own Chrome.
 */
export function browserToolkit(
  browser: BrowserService,
  store: Store,
  route?: BrowserMachineRoute,
  user?: UserBrowserTools,
): Toolkit {
  const ace = port(browser, store, () => {});
  const mine = user
    ? port(user.sessions, store, () => {
        if (!user.available()) throw new PublicToolError("user_browser_unavailable");
      })
    : undefined;
  // Closing only ends what is open: the person's browser need not be connected.
  const userPort =
    mine && user
      ? {
          ...mine,
          close: async (caller: BrowserCaller, signal: AbortSignal) => {
            signal.throwIfAborted();
            await user.sessions.closeThread(caller.threadId, agentOf(caller), signal);
          },
        }
      : undefined;
  return scopedBrowserToolkit(ace, route, userPort);
}
