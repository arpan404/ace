import { z } from "zod";
import {
  BrowserTab,
  BrowserDownload,
  BrowserDialog,
  BrowserEvaluateGrant,
} from "./browser-features.ts";
import { BrowserInteractionAction, BrowserMeasurementOptions } from "./interaction-measurement.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";

const short = z.string().min(1).max(256);
const dimension = z.number().int().min(100).max(4096);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const timeout = z.number().int().min(1).max(30_000).default(10_000);
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
const commandBase = z.object({ tabId: short.optional() });
const [click, type, press, scroll, drag] = BrowserInteractionAction.options;
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
  commandBase.extend({ action: z.literal("navigate"), url: z.string().max(8192), timeout }),
  commandBase.extend(click.shape),
  commandBase.extend(type.shape),
  commandBase.extend(press.shape),
  commandBase.extend(scroll.shape),
  commandBase.extend(drag.shape),
  commandBase.extend({
    action: z.literal("measure_interaction"),
    ...BrowserMeasurementOptions.shape,
  }),
  commandBase.extend({ action: z.literal("snapshot") }),
  commandBase.extend({ action: z.literal("screenshot") }),
  commandBase.extend({
    action: z.literal("evaluate"),
    expression: z.string().max(65_536),
    mode: z.enum(["read-only", "unrestricted"]).default("unrestricted"),
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
        "Exact destination URL. Also waits for DOMContentLoaded. Works before or after navigation commits.",
      ),
    text: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Visible page text to wait for, matched as a substring."),
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
  commandBase.extend({ action: z.literal("resize"), width: dimension, height: dimension }),
  commandBase.extend({
    action: z.literal("emulate"),
    width: dimension,
    height: dimension,
    deviceScaleFactor: z.number().min(0.5).max(4).default(1),
    mobile: z.boolean().default(false),
    touch: z.boolean().default(false),
    colorScheme: z.enum(["light", "dark", "no-preference"]).default("light"),
  }),
  commandBase.extend({
    action: z.literal("tabs"),
    operation: z.enum(["list", "open", "switch", "close"]).default("list"),
    url: z.string().max(8192).optional(),
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
    role: short,
    name: z.string().max(1024),
    exact: z.boolean().default(true),
  }),
  commandBase.extend({ action: z.literal("network_body"), requestId: short }),
  commandBase.extend({ action: z.literal("record_start") }),
  commandBase.extend({ action: z.literal("record_stop") }),
]);
export type BrowserCommand = z.infer<typeof BrowserCommand>;
export const BrowserInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    event: z.enum(["mouseMoved", "mousePressed", "mouseReleased"]),
    x: coordinate,
    y: coordinate,
    button: z.enum(["none", "left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(0).max(3).default(1),
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
  }),
  z.object({
    kind: z.literal("touch"),
    event: z.enum(["touchStart", "touchMove", "touchEnd", "touchCancel"]),
    points: z
      .array(z.object({ x: coordinate, y: coordinate, id: z.number().int().min(0).max(9) }))
      .max(10),
  }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;
/** Canonical HTTP origin. WebSocket policy maps ws/wss to http/https. */
export const BrowserOrigin = z
  .string()
  .min(1)
  .max(8192)
  .refine((raw) => {
    try {
      const url = new URL(raw);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        raw === url.origin
      );
    } catch {
      return false;
    }
  }, "Expected an exact HTTP(S) origin")
  .meta({
    "x-ace-constraint":
      "An exact canonical HTTP(S) origin, including scheme and optional port, with no path, query, fragment or URL credentials.",
    examples: ["https://youtube.com"],
  });
export const BrowserOriginGrant = z.object({
  origin: BrowserOrigin,
  grantedAt: z.number().finite(),
  scope: z.enum(["thread", "page"]).optional(),
});
export type BrowserOriginGrant = z.infer<typeof BrowserOriginGrant>;
export const BrowserOriginBlock = z.object({
  origin: z.string().max(8192),
  reason: z.enum(["approval_required", "denied", "read_only", "timeout", "invalid_origin"]),
});
export type BrowserOriginBlock = z.infer<typeof BrowserOriginBlock>;
export const BrowserState = z.object({
  threadId: ThreadId,
  controller: z.enum(["agent", "human", "none"]),
  owner: short.optional(),
  url: z.string().max(8192),
  closed: z.boolean(),
  backend: z.enum(["embedded", "headless"]).optional(),
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
  tabs: z.array(BrowserTab).max(8).optional(),
  downloads: z.array(BrowserDownload).max(128).optional(),
  pending_dialog: BrowserDialog.optional(),
  takeoverMode: z.enum(["shared", "private"]).optional(),
});
export type BrowserState = z.infer<typeof BrowserState>;
export const BrowserFrame = z.object({
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().finite(),
  data: z.string().max(4 * 1024 * 1024),
  width: dimension,
  height: dimension,
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
export const BrowserCaptureViewport = z.object({
  nativeShown: z.boolean().optional(),
  width: dimension,
  height: dimension,
  devicePixelRatio: z.number().finite().min(1).max(4),
});
export type BrowserCaptureViewport = z.infer<typeof BrowserCaptureViewport>;
const base = z.object({ requestId: short, threadId: ThreadId });
export const BrowserClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser.open"), requestId: short, options: BrowserOpen }),
  base.extend({ type: z.literal("browser.origins.list") }),
  base.extend({ type: z.literal("browser.origins.grant"), origin: BrowserOrigin }),
  base.extend({ type: z.literal("browser.origins.revoke"), origin: BrowserOrigin }),
  base.extend({ type: z.literal("browser.close") }),
  base.extend({ type: z.literal("browser.tabs.list") }),
  base.extend({ type: z.literal("browser.tabs.open"), url: z.string().max(8192).optional() }),
  base.extend({ type: z.literal("browser.tabs.switch"), tabId: short }),
  base.extend({ type: z.literal("browser.tabs.close"), tabId: short }),
  base.extend({ type: z.literal("browser.downloads.list") }),
  base.extend({
    type: z.literal("browser.dialog.answer"),
    tabId: short,
    dialogId: short,
    accept: z.boolean(),
    promptText: z.string().max(4096).optional(),
  }),
  base.extend({ type: z.literal("browser.evaluate.grants.list") }),
  base.extend({ type: z.literal("browser.evaluate.grants.revoke"), origin: BrowserOrigin }),
  base.extend({ type: z.literal("browser.execute"), command: BrowserCommand }),
  base.extend({ type: z.literal("browser.subscribe"), subscriberId: short.optional() }),
  base.extend({ type: z.literal("browser.capture"), viewport: BrowserCaptureViewport }),
  base.extend({ type: z.literal("browser.unsubscribe"), subscriberId: short.optional() }),
  base.extend({ type: z.literal("browser.ack"), sequence: z.number().int().nonnegative() }),
  base.extend({
    type: z.literal("browser.takeover"),
    mode: z.enum(["shared", "private"]).default("shared"),
  }),
  base.extend({ type: z.literal("browser.handback") }),
  base.extend({ type: z.literal("browser.input"), input: BrowserInput }),
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
    type: z.literal("browser.evaluate.grants"),
    threadId: ThreadId,
    grants: z.array(BrowserEvaluateGrant).max(256),
  }),
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
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessage>;
