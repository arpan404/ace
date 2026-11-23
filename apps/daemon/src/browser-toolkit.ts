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
 * One browser as the tools see it, fixed to `service` for one call: once `live` says the
 * service was replaced, each step refuses with `browser_restarted`. Every call opens the
 * thread's browser first, as an agent's first call would; `connected` refuses calls while that
 * browser cannot be reached.
 */
function fixedPort(
  service: BrowserService,
  live: () => boolean,
  store: Store,
  connected: () => void,
): BrowserToolPort {
  const check = () => {
    if (!live()) throw new PublicToolError("browser_restarted");
  };
  const ensure = async (caller: BrowserCaller, signal: AbortSignal) => {
    signal.throwIfAborted();
    connected();
    check();
    const threadId = ThreadId.parse(caller.threadId);
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("Browser thread unavailable");
    await service.open({ threadId, workspaceId: thread.workspaceId, background: true });
    signal.throwIfAborted();
    check();
    return threadId;
  };
  return {
    async open(caller, signal) {
      const threadId = await ensure(caller, signal);
      const claimed = await service.claimTab(threadId, agentOf(caller));
      // Stopped while the tab opened: the caller does nothing with it.
      signal.throwIfAborted();
      return claimed;
    },
    async tab(caller, tabId, signal) {
      const threadId = await ensure(caller, signal);
      if (tabId === undefined) return service.currentTab(threadId, agentOf(caller));
      const listed = service.state(threadId).tabs?.find((tab) => tab.tabId === tabId);
      if (listed) return { tabId, url: listed.url, title: listed.title };
      // A one-page backend lists no tabs: its page is the agent's current tab.
      const page = service.currentTab(threadId, agentOf(caller));
      if (page.tabId === tabId) return page;
      // An unknown tab fails on the command itself with tab_not_found.
      return { tabId, url: "", title: "" };
    },
    state(caller) {
      check();
      return service.state(caller.threadId);
    },
    async execute(caller, command, signal) {
      const threadId = await ensure(caller, signal);
      return service.execute(threadId, command, agentOf(caller), signal);
    },
    async screenshot(caller, options, signal) {
      const threadId = await ensure(caller, signal);
      return service.capture(threadId, signal, options.tabId, options, agentOf(caller));
    },
    // Closing only ends what is open: the browser need not be connected.
    async close(caller, signal) {
      signal.throwIfAborted();
      check();
      await service.closeThread(caller.threadId, agentOf(caller), signal);
    },
  };
}

/**
 * The browser of the moment, `current()`: each tool call binds it once and keeps it for all its
 * steps (`bind`); a step called unbound binds for itself.
 */
function port(current: () => BrowserService, store: Store, connected: () => void): BrowserToolPort {
  const bind = () => {
    const service = current();
    return fixedPort(service, () => current() === service, store, connected);
  };
  return {
    bind,
    open: (caller, signal) => bind().open(caller, signal),
    tab: (caller, tabId, signal) => bind().tab(caller, tabId, signal),
    state: (caller) => bind().state(caller),
    execute: (caller, command, signal) => bind().execute(caller, command, signal),
    screenshot: (caller, options, signal) => bind().screenshot(caller, options, signal),
    close: (caller, signal) => bind().close(caller, signal),
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
  // The person's own Chrome: calls need it connected; closing only ends what is open.
  const userPort = user
    ? port(sessions, store, () => {
        if (!user.available()) throw new PublicToolError("user_browser_unavailable");
      })
    : undefined;
  return scopedBrowserToolkit(ace, route, userPort);
}

function unavailable(code: "browser_unavailable" | "user_browser_unavailable"): never {
  throw new PublicToolError(code);
}
