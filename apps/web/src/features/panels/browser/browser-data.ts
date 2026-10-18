import * as z from "zod/mini";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";

/*
 * The Browser panel tab's local state. The thread's browser lives on the daemon with any number
 * of tabs, shared by the person and agents on every device; the panel tab is only their
 * container (one per thread). It keeps no page of its own: which page shows is the daemon's
 * `activeTabId`, so nothing here can bring back a page that was closed. Small, so the thread's
 * tab kinds can read it before the browser's code loads.
 */

/** What the Browser panel tab keeps with it across reloads. */
export const BrowserTabData = z.object({
  /** An address to open in a new tab once the panel shows (the launcher, Suggested, a link). */
  open: z.optional(z.string()),
  /** The shown page's address, for the panel tab's title and the composer's page list. */
  url: z.optional(z.string()),
  /** An agent is working in one of the tabs (the panel tab's working dot). */
  agent: z.optional(z.boolean()),
});
export type BrowserTabData = z.infer<typeof BrowserTabData>;

export function browserTabData(tab: WorkspaceTab | undefined): BrowserTabData {
  const parsed = BrowserTabData.safeParse(tab?.data);
  return parsed.success ? parsed.data : {};
}
