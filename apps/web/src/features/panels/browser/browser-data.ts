import * as z from "zod/mini";
import type { WorkspaceTab } from "@/lib/workspace/index.ts";

/*
 * A browser panel tab's local state. Each of the thread's daemon browser tabs is one panel tab
 * (kind `browser`, id: the daemon's tab id), shared by the person and agents on every device;
 * the panel mirrors the daemon's list. A panel tab whose id is still `browser` is a new tab no
 * daemon tab backs yet: the start page, until an address opens one. Small, so the thread's tab
 * kinds can read it before the browser's code loads.
 */

export const BrowserTabData = z.object({
  /** An address to open in a new daemon tab once the panel shows (the launcher, a link). */
  open: z.optional(z.string()),
  /** The page's address and title as the daemon last reported them (strip, composer). */
  url: z.optional(z.string()),
  title: z.optional(z.string()),
  /** The console drawer is open on this tab, at this section. */
  drawer: z.optional(z.enum(["console", "network"])),
  /** The console drawer's height in CSS pixels. */
  drawerHeight: z.optional(z.number().check(z.gte(80), z.lte(2000))),
});
export type BrowserTabData = z.infer<typeof BrowserTabData>;

export function browserTabData(tab: WorkspaceTab | undefined): BrowserTabData {
  const parsed = BrowserTabData.safeParse(tab?.data);
  return parsed.success ? parsed.data : {};
}

/** The new tab's id: no daemon tab backs it yet. */
export const newBrowserTab = "browser";

/** The daemon tab a panel tab shows, or undefined for a new tab not opened yet. */
export function daemonTabId(tab: WorkspaceTab): string | undefined {
  return tab.kind === "browser" && tab.id !== newBrowserTab ? tab.id : undefined;
}
