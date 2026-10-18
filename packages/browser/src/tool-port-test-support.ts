import type { BrowserService } from "./service.ts";
import type { BrowserCaller, BrowserToolPort } from "./mcp.ts";

const agentOf = (caller: BrowserCaller) => ({
  kind: "agent" as const,
  ...(caller.agentId ? { agentId: caller.agentId } : {}),
});

/** The daemon's port, minus the thread store: every fixture thread lives in one workspace. */
export function toolPort(service: BrowserService): BrowserToolPort {
  const ensure = async (caller: BrowserCaller) => {
    await service.open({ threadId: caller.threadId, workspaceId: "workspace", background: true });
    return caller.threadId;
  };
  return {
    async open(caller) {
      return service.claimTab(await ensure(caller), agentOf(caller));
    },
    async tab(caller, tabId) {
      const threadId = await ensure(caller);
      if (tabId === undefined) return service.currentTab(threadId, agentOf(caller));
      const listed = service.state(threadId).tabs?.find((tab) => tab.tabId === tabId);
      return { tabId, url: listed?.url ?? "", title: listed?.title ?? "" };
    },
    state: (caller) => service.state(caller.threadId),
    async execute(caller, command, signal) {
      return service.execute(await ensure(caller), command, agentOf(caller), signal);
    },
    async screenshot(caller, options, signal) {
      const threadId = await ensure(caller);
      return service.screenshot(threadId, signal, options.tabId, options, agentOf(caller));
    },
    close: (caller, signal) => service.closeThread(caller.threadId, agentOf(caller), signal),
  };
}
