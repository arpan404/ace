import { z } from "zod";
const id = z.string().min(1).max(256);
export const BrowserDialog = z.object({
  dialogId: id,
  tabId: id,
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().max(4096),
  defaultPrompt: z.string().max(4096).optional(),
});
export type BrowserDialog = z.infer<typeof BrowserDialog>;
export const BrowserTab = z.object({
  tabId: id,
  url: z.string().max(8192),
  title: z.string().max(1024),
  pending_dialog: BrowserDialog.optional(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;
/** Wire bound on one browser's tab list: far above what a person keeps open, still bounded. */
export const browserTabLimit = 512;
export const BrowserTabList = z.array(BrowserTab).max(browserTabLimit);
export type BrowserTabList = z.infer<typeof BrowserTabList>;
export const BrowserDownload = z.object({
  downloadId: id,
  tabId: id,
  filename: z.string().max(256),
  bytes: z.number().int().nonnegative(),
  mimeType: z.string().max(256),
  flags: z.array(z.enum(["executable", "archive"])),
  state: z.enum(["pending", "complete", "denied", "failed", "too_large"]),
  path: z.string().optional(),
});
export type BrowserDownload = z.infer<typeof BrowserDownload>;
/** Tab mutations can surface a renderer dialog instead of changing selection. */
export const BrowserTabsResult = z.union([
  z.object({ activeTabId: id, tabs: BrowserTabList }),
  z.object({ pending_dialog: BrowserDialog }),
]);
export type BrowserTabsResult = z.infer<typeof BrowserTabsResult>;
