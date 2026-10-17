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
/**
 * Who opened or is driving a tab. `page` is a popup the page itself opened. Unknown kinds decode
 * to undefined on the field that carries them, so a newer daemon never breaks an older client.
 */
export const BrowserTabActor = z.object({
  kind: z.enum(["human", "agent", "page"]),
  agentId: id.optional(),
});
export type BrowserTabActor = z.infer<typeof BrowserTabActor>;
/**
 * Where an agent last pointed in a tab (a click, hover or drag), in CSS pixels of the tab's
 * viewport. `sequence` rises with every new point, so a repeat at the same spot still shows.
 */
export const BrowserAgentPointer = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  sequence: z.number().int().nonnegative(),
});
export type BrowserAgentPointer = z.infer<typeof BrowserAgentPointer>;
/**
 * `frozen` keeps the page but stops its scripts; `discarded` dropped it and reopens on use;
 * `crashed` lost its renderer and stays down until a reload or navigation brings it back.
 */
export const BrowserTabLifecycle = z.enum(["live", "frozen", "discarded", "crashed"]);
export type BrowserTabLifecycle = z.infer<typeof BrowserTabLifecycle>;
export const BrowserTab = z.object({
  tabId: id,
  url: z.string().max(8192),
  title: z.string().max(1024),
  pending_dialog: BrowserDialog.optional(),
  openedBy: BrowserTabActor.optional(),
  /** The actor whose command ran on this tab most recently. */
  drivenBy: BrowserTabActor.optional(),
  /** A short name an agent gave the tab when it opened it, such as "checkout". */
  label: z.string().max(64).optional(),
  /**
   * The person kept agents out of this tab: agents can neither read nor drive it. People and
   * agents otherwise share every tab (ADR 0067, collaboration).
   */
  private: z.boolean().optional(),
  /** The agent using this tab now: one of its commands runs, or ran in the last few seconds. */
  inUse: BrowserTabActor.optional(),
  /** Where the agent using this tab last pointed. */
  pointer: BrowserAgentPointer.optional(),
  lifecycle: BrowserTabLifecycle.optional(),
  loading: z.boolean().optional(),
  favicon: z.string().max(8192).optional(),
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
  /** `tabId` is the tab the operation opened or selected; `activeTabId` is the one shown. */
  z.object({ activeTabId: id, tabs: BrowserTabList, tabId: id.optional() }),
  z.object({ pending_dialog: BrowserDialog }),
]);
export type BrowserTabsResult = z.infer<typeof BrowserTabsResult>;
