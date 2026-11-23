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
function port(current: () => BrowserService, store: Store, connected: () => void): BrowserToolPort {
  /**
   * Opens the thread's browser in the browser service of this moment and returns both: one call
   * stays on that instance. Replaced while it opened (a restart), the call refuses rather than
   * carrying on in a different browser.
   */
  const ensure = async (caller: BrowserCaller, signal: AbortSignal) => {
    signal.throwIfAborted();
    connected();
    const service = current();
    const threadId = ThreadId.parse(caller.threadId);
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("Browser thread unavailable");
    await service.open({ threadId, workspaceId: thread.workspaceId, background: true });
    signal.throwIfAborted();
    if (current() !== service) throw new PublicToolError("browser_restarted");
    return { threadId, service };
  };
  return {
    async open(caller, signal) {
      const { threadId, service } = await ensure(caller, signal);
      const claimed = await service.claimTab(threadId, agentOf(caller));
      // Stopped while the tab opened: the caller does nothing with it.
      signal.throwIfAborted();
      return claimed;
    },
    async tab(caller, tabId, signal) {
      const { threadId, service } = await ensure(caller, signal);
      if (tabId === undefined) return service.currentTab(threadId, agentOf(caller));
      const listed = service.state(threadId).tabs?.find((tab) => tab.tabId === tabId);
      if (listed) return { tabId, url: listed.url, title: listed.title };
      // A one-page backend lists no tabs: its page is the agent's current tab.
      const page = service.currentTab(threadId, agentOf(caller));
      if (page.tabId === tabId) return page;
      // An unknown tab fails on the command itself with tab_not_found.
      return { tabId, url: "", title: "" };
    },
    state: (caller) => current().state(caller.threadId),
    async execute(caller, command, signal) {
      const { threadId, service } = await ensure(caller, signal);
      return service.execute(threadId, command, agentOf(caller), signal);
    },
    async screenshot(caller, options, signal) {
      const { threadId, service } = await ensure(caller, signal);
      return service.capture(threadId, signal, options.tabId, options, agentOf(caller));
    },
    async close(caller, signal) {
      signal.throwIfAborted();
      await current().closeThread(caller.threadId, agentOf(caller), signal);
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
  return liveBrowserToolkit(
    () => browser,
    store,
    route,
    user ? { sessions: () => user.sessions, available: user.available } : undefined,
  );
}

/**
 * The same tools over browsers looked up on every call, for a daemon whose browser may start,
 * or start again, after the tools registered: while there is none, a call says so.
 */
export function liveBrowserToolkit(
  browser: () => BrowserService | undefined,
  store: Store,
  route?: BrowserMachineRoute,
  user?: { sessions: () => BrowserService | undefined; available(): boolean },
): Toolkit {
  const ace = port(
    () => browser() ?? unavailable("browser_unavailable"),
    store,
    () => {},
  );
  const sessions = () => user?.sessions() ?? unavailable("user_browser_unavailable");
  const mine = user
    ? port(sessions, store, () => {
        if (!user.available()) throw new PublicToolError("user_browser_unavailable");
      })
    : undefined;
  // Closing only ends what is open: the person's browser need not be connected.
  const userPort = mine
    ? {
        ...mine,
        close: async (caller: BrowserCaller, signal: AbortSignal) => {
          signal.throwIfAborted();
          await sessions().closeThread(caller.threadId, agentOf(caller), signal);
        },
      }
    : undefined;
  return scopedBrowserToolkit(ace, route, userPort);
}

function unavailable(code: "browser_unavailable" | "user_browser_unavailable"): never {
  throw new PublicToolError(code);
}
