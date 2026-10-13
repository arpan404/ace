import type { Item } from "@ace/protocol";
import { aceCallOf } from "./ace-tools.ts";

/** ace's browser tools that put a page in front of the agent (and so in front of the person). */
const pageTools = new Set(["ace_browser_open", "ace_browser_navigate"]);

/**
 * Whether an item is an agent opening or moving a page in the thread's browser: the side panel
 * shows that page as a tab, since the agent's pages are the person's too. Reads MCP calls and
 * the `custom` calls OpenCode and Pi report for ace's tools alike. Pure.
 */
export function opensAgentPage(item: Item | undefined): boolean {
  const call = aceCallOf(item);
  if (!call || ["failed", "declined", "cancelled"].includes(call.status)) return false;
  return pageTools.has(call.tool);
}

/**
 * The newest page an agent opened among a thread's latest items, by item id, so a client can
 * show it once. Reads only the tail, never the thread's history.
 */
export function newestAgentPage(
  order: readonly string[],
  item: (id: string) => Item | undefined,
  tail = 8,
): string | undefined {
  for (let index = order.length - 1; index >= Math.max(0, order.length - tail); index--) {
    const id = order[index];
    if (id !== undefined && opensAgentPage(item(id))) return id;
  }
  return undefined;
}
