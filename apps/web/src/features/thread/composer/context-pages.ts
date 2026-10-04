import { displayAddress } from "@ace/ui-core";
import type { ScopeWorkspace } from "@/lib/workspace/index.ts";

export interface ContextPage {
  url: string;
  /** "docs.example.com/guide", or the dev server's tab title. */
  label: string;
}

const urlOf = (data: unknown): string | undefined =>
  typeof data === "object" && data !== null && "url" in data && typeof data.url === "string"
    ? data.url
    : undefined;

/**
 * Pages open in a thread's workspace that a message can point the agent at: browser tabs with a
 * web address and dev servers in their own tabs, each once, in tab order.
 */
export function contextPages(workspace: ScopeWorkspace): ContextPage[] {
  const pages = new Map<string, ContextPage>();
  for (const tab of [...workspace.right.tabs, ...workspace.bottom.tabs]) {
    if (tab.kind === "browser") {
      const url = urlOf(tab.data);
      if (url && /^https?:\/\//i.test(url)) pages.set(url, { url, label: displayAddress(url) });
    } else if (tab.kind === "port" && /^\d+$/.test(tab.id)) {
      const url = `http://localhost:${tab.id}`;
      pages.set(url, { url, label: tab.title ?? `:${tab.id}` });
    }
  }
  return [...pages.values()];
}
