import type { BrowserService } from "./service.ts";
import type { BrowserToolPort } from "./mcp.ts";

/** The daemon's port, minus the thread store: every fixture thread lives in one workspace. */
export function toolPort(service: BrowserService): BrowserToolPort {
  const open = async (threadId: string) => {
    await service.open({ threadId, workspaceId: "workspace", background: true });
    return service.state(threadId);
  };
  return {
    open,
    async execute(threadId, command, signal) {
      await open(threadId);
      return service.execute(threadId, command, { kind: "agent" }, signal);
    },
    async screenshot(threadId, signal) {
      await open(threadId);
      return service.screenshot(threadId, signal);
    },
    close: (threadId, signal) => service.closeThread(threadId, { kind: "agent" }, signal),
  };
}
