import { z } from "zod";
import {
  BrowserTabList,
  BrowserDownload,
  BrowserDialog,
  BrowserTabActor,
} from "./browser-features.ts";
import { BrowserInteractionAction, BrowserMeasurementOptions } from "./interaction-measurement.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";
import { BlobHash } from "./context.ts";
import {
  BrowserAnnotationCaptureTarget,
  BrowserAnnotationConfig,
  BrowserAnnotationMessage,
  BrowserAnnotationPageCommand,
} from "./browser-annotation.ts";
import { BrowserPageMessage } from "./browser-page.ts";

const short = z.string().min(1).max(256);
const dimension = z.number().int().min(100).max(4096);
const coordinate = z.number().finite().min(-100_000).max(100_000);
/** Longest a navigate or wait_for may run; slow dev servers and cold builds need minutes. */
export const browserWaitLimitMs = 120_000;
/**
 * The widths a multi-size screenshot lays the page out at: phone 390×844, tablet 768×1024 and
 * desktop 1440×900 CSS pixels, phone and tablet as mobile devices.
 */
export const BrowserScreenshotSize = z.enum(["phone", "tablet", "desktop"]);
export type BrowserScreenshotSize = z.infer<typeof BrowserScreenshotSize>;
const timeout = z.number().int().min(1).max(browserWaitLimitMs).default(10_000);
export const BrowserOpen = z.object({
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  /**
   * `persistent` keeps the thread's own cookies and storage across opens; `ephemeral` is a
   * private, in-memory profile removed on close. Omitted: the `browser.profile` setting.
   */
  profile: z.enum(["ephemeral", "persistent"]).optional(),
  headed: z.boolean().default(false),
  /**
   * Opened for agent work. It never changes which backend is chosen: an agent drives the
   * desktop's native view when one is available. After that view is lost, agent work
   * continues headlessly at the last URL unless a person holds the page.
   */
  background: z.boolean().default(false),
});
export type BrowserOpen = z.infer<typeof BrowserOpen>;
/**
 * `tabId` routes a command to one tab. Omitted: an agent's own current tab (the last it opened or
 * selected), otherwise the tab the person is viewing. Commands on different tabs run concurrently.
 */
const commandBase = z.object({
  tabId: short
    .optional()
    .describe("The tab to act in, from browser_tabs. Omitted: your current tab."),
});
const [click, type, press, scroll, drag] = BrowserInteractionAction.options;
const annotate = commandBase.extend({ action: z.literal("annotate") });
/** Annotate mode belongs to the person's connection that started it (ADR 0082). */
const BrowserAnnotateCommand = z.discriminatedUnion("operation", [
  annotate.extend({
    operation: z.literal("start"),
    // Not `.prefault({})`: browser builds leave it out (apps/web/zod-methods.ts). Parsing `{}`
    // on each use fills the config's own defaults the same way.
    config: BrowserAnnotationConfig.default(() => BrowserAnnotationConfig.parse({})),
  }),
  annotate.extend({ operation: z.literal("stop") }),
  annotate.extend({ operation: z.literal("command"), command: BrowserAnnotationPageCommand }),
]);
export const BrowserCommand = z.discriminatedUnion("action", [
  commandBase.extend({ action: z.literal("navigation_history") }),
  commandBase.extend({ action: z.literal("selection") }),
  commandBase.extend({
    action: z.literal("history"),
    direction: z.enum(["back", "forward", "reload", "stop"]),
  }),
  commandBase.extend({
    action: z.literal("find_text"),
    text: z.string().max(4096),
    forward: z.boolean().default(true),
  }),
  commandBase.extend({
    action: z.literal("navigate"),
    url: z.string().max(8192),
    timeout,
    waitUntil: z
      .enum(["domcontentloaded", "load", "networkidle"])
      .default("domcontentloaded")
      .describe(
        "When navigate returns: domcontentloaded (the HTML is parsed), load (images, styles and scripts too) or networkidle (load, then no request in flight for 500 ms).",
      ),
  }),
  commandBase.extend({
    action: click.shape.action,
    ref: short.optional().describe("Ref from the latest snapshot. Omit it to click at x, y."),
    x: coordinate.optional().describe("CSS pixels from the viewport's left edge; needs y."),
    y: coordinate.optional().describe("CSS pixels from the viewport's top edge; needs x."),
    button: z.enum(["left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z
      .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
      .max(4)
      .default([]),
  }),
  commandBase.extend(type.shape),
  commandBase.extend(press.shape),
  commandBase.extend(scroll.shape),
  commandBase.extend(drag.shape),
  commandBase.extend({
    action: z.literal("measure_interaction"),
    ...BrowserMeasurementOptions.shape,
  }),
  commandBase.extend({
    action: z.literal("snapshot"),
    ref: short
      .optional()
      .describe("Ref of a container from the latest snapshot: return only its subtree."),
    interactiveOnly: z
      .boolean()
      .default(false)
      .describe("Only actionable elements (buttons, links, fields), as a flat list."),
    maxNodes: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(120)
      .describe("Most lines to return; the result says when more exist."),
    depth: z
      .number()
      .int()
      .min(1)
      .max(64)
      .optional()
      .describe("How many levels below the page (or ref) to read. Omitted: every level."),
  }),
  commandBase.extend({
    action: z.literal("screenshot"),
    fullPage: z.boolean().default(false).describe("The whole scrollable page, not the viewport."),
    ref: short.optional().describe("Only this element from the latest snapshot."),
    sizes: z
      .array(BrowserScreenshotSize)
      .min(1)
      .max(3)
      .optional()
      .describe(
        "Responsive check: lay the page out at each size (phone 390, tablet 768, desktop 1440 CSS px wide), capture it there, then restore the tab's own size. One image per size. Not with ref.",
      ),
  }),
  commandBase.extend({
    action: z.literal("evaluate"),
    expression: z.string().max(65_536),
    mode: z
      .enum(["read-only", "unrestricted"])
      .default("unrestricted")
      .describe(
        "unrestricted: runs in the page like a script of its own and may change it (awaits promises). read-only: an isolated world where anything with a side effect (writes, calls into page code, promises) is refused; use it to read values.",
      ),
  }),
  commandBase.extend({
    action: z.literal("wait_for"),
    ref: short
      .optional()
      .describe("Ref from the latest snapshot. Use only for element visibility waits."),
    state: z.enum(["visible", "hidden"]).optional().describe("Required with ref."),
    url: z
      .string()
      .min(1)
      .max(8192)
      .optional()
      .describe(
        "Destination URL: exact, or a glob where * matches any characters (http://localhost:3000/orders/*). Also waits for DOMContentLoaded. Works before or after navigation commits.",
      ),
    text: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Visible page text to wait for, matched as a substring."),
    networkIdle: z
      .literal(true)
      .optional()
      .describe("Wait until no request is in flight for 500 ms, such as after a save."),
    timeMs: z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional()
      .describe("Just wait this many ms. Prefer a condition; use this for animations."),
    timeout,
  }),
  commandBase.extend({
    action: z.literal("logs"),
    kind: z.enum(["console", "network"]).optional(),
    level: short.optional(),
    url: z.string().max(8192).optional(),
    status: z.number().int().min(100).max(599).optional(),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  commandBase.extend({
    action: z.literal("resize"),
    width: dimension,
    height: dimension,
    /**
     * Person-only: the pane is on a touch screen. The page lays out as a phone's or tablet's
     * (the mobile flag) and gets touch events; agents' resizes ignore it.
     */
    touch: z.boolean().optional(),
    /**
     * The resizing viewer's device pixel ratio: ace's Chrome renders the page that sharp, up to
     * 3, so a high-density screen gets pixels instead of an upscaled picture.
     */
    devicePixelRatio: z.number().finite().min(1).max(4).optional(),
  }),
  commandBase.extend({
    action: z.literal("emulate"),
    width: dimension,
    height: dimension,
    deviceScaleFactor: z.number().min(0.5).max(4).default(1),
    mobile: z.boolean().default(false),
    touch: z.boolean().default(false),
    colorScheme: z.enum(["light", "dark", "no-preference"]).default("light"),
    userAgent: z
      .string()
      .max(1024)
      .optional()
      .describe("A user agent string to send and report. Omitted: the browser's own."),
  }),
  commandBase.extend({
    action: z.literal("tabs"),
    operation: z.enum(["list", "open", "select", "close", "keep"]).default("list"),
    url: z.string().max(8192).optional(),
    label: z.string().min(1).max(64).optional(),
    /**
     * With `open`: the new tab is a deliverable or handoff that stays after your turn. With
     * `keep`: `false` makes a kept tab temporary again. Omitted on `keep`: true.
     */
    keep: z.boolean().optional(),
  }),
  commandBase.extend({
    action: z.literal("fill_form"),
    fields: z
      .array(z.object({ ref: short, value: z.string().max(65_536) }))
      .min(1)
      .max(64),
  }),
  commandBase.extend({
    action: z.literal("downloads"),
    operation: z.enum(["list", "wait"]).default("list"),
    timeout,
  }),
  commandBase.extend({
    action: z.literal("pdf"),
    landscape: z.boolean().default(false),
    printBackground: z.boolean().default(true),
  }),
  commandBase.extend({
    action: z.literal("extensions"),
    operation: z.enum(["list"]).default("list"),
  }),
  commandBase.extend({
    action: z.literal("upload"),
    ref: short,
    files: z.array(z.string().min(1).max(8192)).min(1).max(16),
  }),
  commandBase.extend({
    action: z.literal("dialog"),
    dialogId: short,
    accept: z.boolean(),
    promptText: z.string().max(4096).optional(),
  }),
  commandBase.extend({ action: z.literal("hover"), ref: short }),
  commandBase.extend({
    action: z.literal("select"),
    ref: short,
    values: z.array(z.string().max(4096)).min(1).max(100),
  }),
  commandBase.extend({ action: z.literal("check"), ref: short }),
  commandBase.extend({ action: z.literal("uncheck"), ref: short }),
  commandBase.extend({ action: z.literal("focus"), ref: short }),
  commandBase.extend({
    action: z.literal("find"),
    role: short.optional().describe("Accessible role, e.g. button, link, textbox, heading."),
    name: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("Accessible name; a case-insensitive substring unless exact is true."),
    exact: z.boolean().default(false).describe("Match the whole name exactly."),
  }),
  commandBase.extend({ action: z.literal("network_body"), requestId: short }),
  commandBase.extend({ action: z.literal("record_start") }),
  commandBase.extend({ action: z.literal("record_stop") }),
  BrowserAnnotateCommand,
  /** Person-only: page zoom for the tab, as a factor of 1 (100%). Agents get no tool for it. */
  commandBase.extend({ action: z.literal("zoom"), factor: z.number().min(0.25).max(5) }),
  /** Person-only: clear cookies, cache and site storage of the tab's browser profile. */
  commandBase.extend({ action: z.literal("clear_data") }),
  /** Person-only: the tab's document source as the server sent it (bounded). */
  commandBase.extend({ action: z.literal("page_source") }),
  /**
   * Person-only: what is under a point of the page (viewport CSS pixels) for ace's own
   * right-click menu: the link it is in and the image it is, when they are web addresses.
   */
  commandBase.extend({
    action: z.literal("context_target"),
    x: z.number().min(0).max(100_000),
    y: z.number().min(0).max(100_000),
  }),
  /** Person-only: the bytes of an image the page already loaded (base64), to copy or save. */
  commandBase.extend({ action: z.literal("image_data"), url: z.string().min(1).max(8192) }),
  commandBase.extend({
    action: z.literal("annotate_capture"),
    target: BrowserAnnotationCaptureTarget,
  }),
]);
export type BrowserCommand = z.infer<typeof BrowserCommand>;
export const BrowserInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    event: z.enum(["mouseMoved", "mousePressed", "mouseReleased"]),
    x: coordinate,
    y: coordinate,
    button: z.enum(["none", "left", "middle", "right"]).default("left"),
    /**
     * The buttons held during the event, as a bit mask (left 1, right 2, middle 4); absent: the
     * one `button` names, none on release.
     */
    buttons: z.number().int().min(0).max(7).optional(),
    clickCount: z.number().int().min(0).max(3).default(1),
    /** Keys held during the event: Alt 1, Ctrl 2, Meta 4, Shift 8. */
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  z.object({
    kind: z.literal("key"),
    event: z.enum(["keyDown", "keyUp", "char"]),
    key: short,
    code: short.optional(),
    text: z.string().max(256).optional(),
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  z.object({
    kind: z.literal("scroll"),
    x: coordinate,
    y: coordinate,
    deltaX: coordinate,
    deltaY: coordinate,
    /** Keys held during the event: Alt 1, Ctrl 2, Meta 4, Shift 8. */
    modifiers: z.number().int().min(0).max(15).default(0),
  }),
  z.object({
    kind: z.literal("touch"),
    event: z.enum(["touchStart", "touchMove", "touchEnd", "touchCancel"]),
    points: z
      .array(z.object({ x: coordinate, y: coordinate, id: z.number().int().min(0).max(9) }))
      .max(10),
  }),
  /**
   * IME text being composed, shown marked in the focused field (`Input.imeSetComposition`);
   * an empty `text` cancels it. A `char` key event commits it.
   */
  z.object({
    kind: z.literal("ime"),
    text: z.string().max(4096),
    selectionStart: z.number().int().min(0).max(4096),
    selectionEnd: z.number().int().min(0).max(4096),
  }),
  /**
   * The person's choice in the page's open picker (`BrowserPagePicker`): the value is set on the
   * element and its `input` and `change` events fire. Without `values` the picker is dismissed.
   */
  z.object({
    kind: z.literal("pick"),
    pickerId: short,
    values: z.array(z.string().max(4096)).max(1000).optional(),
  }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;
export const BrowserOriginBlock = z.object({
  origin: z.string().max(8192),
  reason: z.enum(["approval_required", "timeout", "invalid_origin"]),
});
export type BrowserOriginBlock = z.infer<typeof BrowserOriginBlock>;
export const BrowserState = z.object({
  threadId: ThreadId,
  url: z.string().max(8192),
  closed: z.boolean(),
  /** `user`: the person's own browser through the ace extension (ADR 0084). */
  backend: z.enum(["embedded", "headless", "user"]).optional(),
  status: z.enum(["ready", "paused", "recovering"]).optional(),
  reason: z.string().max(2048).optional(),
  pageStateLost: z.boolean().optional(),
  loading: z.boolean().optional(),
  loadError: z.string().max(2048).optional(),
  permissionDenied: z
    .object({ permission: z.string().max(256), origin: z.string().max(8192) })
    .optional(),
  blocked: BrowserOriginBlock.optional(),
  activeTabId: short.optional(),
  tabs: BrowserTabList.optional(),
  downloads: z.array(BrowserDownload).max(128).optional(),
  pending_dialog: BrowserDialog.optional(),
  /** Set while a connection has annotate mode open on this page. */
  annotation: z.object({ owner: short }).optional(),
  /**
   * A recording of the person's view runs, started by `by`. People see it and can stop it with
   * `browser.recording.stop`; its frames hide agent cursors and mask secret fields.
   */
  recording: z.object({ by: BrowserTabActor }).optional(),
  /**
   * Optional page features this daemon supports, such as `annotate`; `page-cursor`: agents'
   * cursors are drawn in the page itself, so clients draw none over frames. Unknown names are kept.
   */
  features: z.array(z.string().max(64)).max(32).optional(),
});
export type BrowserState = z.infer<typeof BrowserState>;
export const BrowserFrame = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().finite(),
  data: z.string().max(4 * 1024 * 1024),
  width: dimension,
  height: dimension,
  /** The tab this frame shows; the person's viewed tab. */
  tabId: short.optional(),
});
export type BrowserFrame = z.infer<typeof BrowserFrame>;
export const BrowserArtifact = z.object({
  path: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
  filename: z.string().max(256).optional(),
  flags: z.array(z.enum(["executable", "archive"])).optional(),
});
export type BrowserArtifact = z.infer<typeof BrowserArtifact>;
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** One capture of a multi-size screenshot (`screenshot` with `sizes`). */
export const BrowserSizedScreenshot = z.object({
  size: BrowserScreenshotSize,
  /** The captured area in CSS pixels (the page's whole height with `fullPage`). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** A JPEG within the model image limits, base64. */
  mimeType: z.literal("image/jpeg"),
  data: z.string().max(4 * 1024 * 1024),
  /** A person's capture is also kept at full resolution as a thread artifact (PNG). */
  path: z.string().optional(),
});
export type BrowserSizedScreenshot = z.infer<typeof BrowserSizedScreenshot>;
export const BrowserScreenshotSet = z.object({
  images: z.array(BrowserSizedScreenshot).min(1).max(3),
});
export type BrowserScreenshotSet = z.infer<typeof BrowserScreenshotSet>;
export const BrowserCaptureViewport = z.object({
  nativeShown: z.boolean().optional(),
  /**
   * The person's accent on this viewer, for agents' cursors drawn in the page: `fill` is the
   * accent, `outline` the colour that reads on it. The last viewer to report one sets it.
   */
  cursor: z.object({ fill: hexColour, outline: hexColour }).optional(),
  width: dimension,
  height: dimension,
  devicePixelRatio: z.number().finite().min(1).max(4),
});
export type BrowserCaptureViewport = z.infer<typeof BrowserCaptureViewport>;
/** A WebCodecs codec string (`avc1.42E033`, `vp8`, `vp09.00.10.08`). */
export const BrowserVideoCodec = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9.]+$/);
/**
 * A viewer that plays video (ADR 0088): the codecs its decoder supports, best first. The daemon
 * encodes the first one its encoder supports and sends JPEG frames otherwise.
 */
export const BrowserVideoRequest = z.object({ codecs: z.array(BrowserVideoCodec).min(1).max(8) });
export type BrowserVideoRequest = z.infer<typeof BrowserVideoRequest>;
const base = z.object({ requestId: short, threadId: ThreadId });
export const BrowserClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser.open"), requestId: short, options: BrowserOpen }),
  base.extend({ type: z.literal("browser.close") }),
  base.extend({ type: z.literal("browser.tabs.list") }),
  base.extend({ type: z.literal("browser.tabs.open"), url: z.string().max(8192).optional() }),
  base.extend({ type: z.literal("browser.tabs.switch"), tabId: short }),
  /** Show this tab to the person; it stays shown until they pick another. */
  base.extend({ type: z.literal("browser.tabs.select"), tabId: short }),
  base.extend({ type: z.literal("browser.tabs.close"), tabId: short }),
  base.extend({ type: z.literal("browser.downloads.list") }),
  base.extend({
    type: z.literal("browser.dialog.answer"),
    tabId: short,
    dialogId: short,
    accept: z.boolean(),
    promptText: z.string().max(4096).optional(),
  }),
  /**
   * The person answers a site's sign-in prompt. Without `credentials` the sign-in is cancelled.
   * The credentials go to the browser engine for that request only; ace never stores them.
   */
  base.extend({
    type: z.literal("browser.auth.answer"),
    tabId: short,
    authId: short,
    credentials: z
      .object({ username: z.string().max(4096), password: z.string().max(4096) })
      .optional(),
  }),
  /**
   * The person proceeds past a certificate error to `url` (the tab's `certificate_error`), for
   * that origin and certificate until the browser restarts. Agents have no way to send this.
   */
  base.extend({
    type: z.literal("browser.certificate.proceed"),
    tabId: short,
    url: z.string().max(8192),
  }),
  base.extend({ type: z.literal("browser.execute"), command: BrowserCommand }),
  base.extend({
    type: z.literal("browser.subscribe"),
    subscriberId: short.optional(),
    /**
     * Send this connection's frames as binary stream messages (an `ACES` envelope with the raw
     * JPEG) instead of `browser.frame` JSON with base64. Ignored where the transport has no
     * binary messages.
     */
    binaryFrames: z.boolean().optional(),
    /** What this viewer shows, as `browser.capture` reports it, so its first frame fits it. */
    viewport: BrowserCaptureViewport.optional(),
    /**
     * Send this connection's view as encoded video (stream kind `browserVideo`) in one of these
     * codecs, with JPEG frames until its first keyframe. Needs `binaryFrames`.
     */
    video: BrowserVideoRequest.optional(),
  }),
  base.extend({ type: z.literal("browser.capture"), viewport: BrowserCaptureViewport }),
  base.extend({ type: z.literal("browser.unsubscribe"), subscriberId: short.optional() }),
  base.extend({
    type: z.literal("browser.ack"),
    sequence: z.number().int().nonnegative(),
    /** `sequence` is a video chunk's (acked cumulatively), not a JPEG frame's. */
    video: z.literal(true).optional(),
    /** The viewer's decoder lost its place (a decode error): send it a keyframe. */
    keyframe: z.literal(true).optional(),
  }),
  /**
   * The person's files for the tab's `file_chooser`, uploaded first as thread attachments
   * (`upload.begin` … `upload.commit`). No files cancels the picker.
   */
  base.extend({
    type: z.literal("browser.files.choose"),
    tabId: short,
    chooserId: short,
    files: z.array(z.object({ sha256: BlobHash, name: z.string().min(1).max(255) })).max(16),
  }),
  /** The person turns a tab's sound off or on; it stays that way until they change it. */
  base.extend({ type: z.literal("browser.tabs.mute"), tabId: short, muted: z.boolean() }),
  /** "Keep agents out of this tab": agents can neither read nor drive a private tab. */
  base.extend({ type: z.literal("browser.tabs.private"), tabId: short, private: z.boolean() }),
  base.extend({ type: z.literal("browser.input"), input: BrowserInput, tabId: short.optional() }),
  base.extend({ type: z.literal("browser.recording.start") }),
  base.extend({ type: z.literal("browser.recording.stop") }),
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessage>;
export const BrowserBackendLost = z.object({
  type: z.literal("browser.backend.lost"),
  threadId: ThreadId,
  backend: z.literal("embedded"),
  recovery: z.enum(["pause", "headless"]),
  url: z.string().max(8192),
  pageStateLost: z.literal(true),
  reason: z.string().max(2048),
});
export type BrowserBackendLost = z.infer<typeof BrowserBackendLost>;
export const BrowserDownloadProgress = z.object({
  type: z.literal("browser.download.progress"),
  version: short,
  phase: z.enum(["downloading", "verifying", "extracting", "ready"]),
  received: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
});
export type BrowserDownloadProgress = z.infer<typeof BrowserDownloadProgress>;

export const BrowserServerMessage = z.discriminatedUnion("type", [
  BrowserBackendLost,
  BrowserDownloadProgress,
  z.object({
    type: z.literal("browser.result"),
    requestId: short,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(2048).optional(),
    blocked: BrowserOriginBlock.optional(),
  }),
  z.object({ type: z.literal("browser.state"), state: BrowserState }),
  z.object({ type: z.literal("browser.frame"), threadId: ThreadId, frame: BrowserFrame }),
  BrowserAnnotationMessage,
  BrowserPageMessage,
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessage>;
