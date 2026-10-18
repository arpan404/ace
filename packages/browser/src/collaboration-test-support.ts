import type { BrowserService } from "./service.ts";

/** "Keep agents out" of the tab the person views, as a person would from the tab's menu. */
export function keepAgentsOut(service: BrowserService, threadId = "thread", value = true) {
  return service.setPrivate(threadId, service.state(threadId).activeTabId ?? "page", value);
}
