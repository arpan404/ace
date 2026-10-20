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
 * A site's HTTP sign-in prompt (basic or digest auth) holding a tab's page load. Only the person
 * answers it: their credentials go straight to the browser engine and are never stored.
 */
export const BrowserAuthChallenge = z.object({
  authId: id,
  tabId: id,
  origin: z.string().max(8192),
  realm: z.string().max(1024).optional(),
  scheme: z.string().max(64).optional(),
});
export type BrowserAuthChallenge = z.infer<typeof BrowserAuthChallenge>;
/**
 * The page in this tab was not opened because its certificate is not trusted. The person may
 * proceed past it for this origin and certificate, for the browser's session; agents never may.
 */
export const BrowserCertificateError = z.object({
  url: z.string().max(8192),
  error: z.string().max(256),
});
export type BrowserCertificateError = z.infer<typeof BrowserCertificateError>;
/**
 * The page opened a file picker (a file input). The person picks files on their own device;
 * agents use `upload` with the input's ref instead.
 */
export const BrowserFileChooser = z.object({ chooserId: id, tabId: id, multiple: z.boolean() });
export type BrowserFileChooser = z.infer<typeof BrowserFileChooser>;
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
/**
 * The device a tab emulates (BrowserCommand `emulate`, or an agent's `resize`), and who set it.
 * Absent: the page follows the size of the pane showing it.
 */
export const BrowserTabEmulation = z.object({
  width: z.number().int().min(100).max(4096),
  height: z.number().int().min(100).max(4096),
  deviceScaleFactor: z.number().min(0.5).max(4),
  mobile: z.boolean(),
  touch: z.boolean(),
  userAgent: z.string().max(1024).optional(),
  by: z.enum(["human", "agent"]),
});
export type BrowserTabEmulation = z.infer<typeof BrowserTabEmulation>;
export const BrowserTab = z.object({
  tabId: id,
  url: z.string().max(8192),
  title: z.string().max(1024),
  pending_dialog: BrowserDialog.optional(),
  pending_auth: BrowserAuthChallenge.optional(),
  certificate_error: BrowserCertificateError.optional(),
  file_chooser: BrowserFileChooser.optional(),
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
  /**
   * An agent kept this tab as a deliverable or handoff. Other tabs an agent opened are
   * temporary: they close when that agent's turn ends, unless the person views or used them.
   */
  kept: z.boolean().optional(),
  /** The tab was discarded while idle and reopened at its address: its page state is gone. */
  pageStateLost: z.boolean().optional(),
  loading: z.boolean().optional(),
  /**
   * Whether Back and Forward lead anywhere, kept current through every navigation, in-page ones
   * (`pushState`, a hash change) included. The blank page a new tab starts on doesn't count.
   * Absent until the daemon has read the tab's history.
   */
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  favicon: z.string().max(8192).optional(),
  /** Page zoom as a factor (1 is 100%); absent at 100%. Set by the person, per tab. */
  zoom: z.number().min(0.25).max(5).optional(),
  emulation: BrowserTabEmulation.optional(),
  /** The tab's page plays sound (it may be muted). */
  audible: z.boolean().optional(),
  /**
   * The tab's sound is off. Background tabs and agents' tabs start muted; the tab the person
   * watches plays. The person can turn it either way (`browser.tabs.mute`).
   */
  muted: z.boolean().optional(),
  /** Audio or video with sound plays in this tab now. */
  playing: z.boolean().optional(),
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
