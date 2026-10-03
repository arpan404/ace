import { z } from "zod";
import { ThreadId, WorkspaceId } from "./ids.ts";

const short = z.string().min(1).max(256);
const dimension = z.number().int().min(100).max(4096);
const coordinate = z.number().finite().min(-100_000).max(100_000);
const timeout = z.number().int().min(1).max(30_000).default(10_000);
export const BrowserOpen = z.object({
  threadId: ThreadId,
  workspaceId: WorkspaceId,
  profile: z.enum(["ephemeral", "persistent"]).default("ephemeral"),
  headed: z.boolean().default(false),
});
export type BrowserOpen = z.infer<typeof BrowserOpen>;
export const BrowserCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().max(8192), timeout }),
  z.object({ action: z.literal("click"), ref: short }),
  z.object({ action: z.literal("type"), ref: short, text: z.string().max(65_536) }),
  z.object({ action: z.literal("press"), key: short, ref: short.optional() }),
  z.object({ action: z.literal("scroll"), x: coordinate, y: coordinate }),
  z.object({ action: z.literal("snapshot") }),
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("evaluate"), expression: z.string().max(65_536) }),
  z.object({
    action: z.literal("wait_for"),
    ref: short,
    state: z.enum(["visible", "hidden"]),
    timeout,
  }),
  z.object({ action: z.literal("logs") }),
  z.object({ action: z.literal("resize"), width: dimension, height: dimension }),
  z.object({
    action: z.literal("emulate"),
    width: dimension,
    height: dimension,
    deviceScaleFactor: z.number().min(0.5).max(4).default(1),
    mobile: z.boolean().default(false),
    touch: z.boolean().default(false),
    colorScheme: z.enum(["light", "dark", "no-preference"]).default("light"),
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
});
export type BrowserArtifact = z.infer<typeof BrowserArtifact>;
const base = z.object({ requestId: short, threadId: ThreadId });
export const BrowserClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("browser.open"), requestId: short, options: BrowserOpen }),
  base.extend({ type: z.literal("browser.close") }),
  base.extend({ type: z.literal("browser.execute"), command: BrowserCommand }),
  base.extend({ type: z.literal("browser.subscribe") }),
  base.extend({ type: z.literal("browser.unsubscribe") }),
  base.extend({ type: z.literal("browser.ack"), sequence: z.number().int().nonnegative() }),
  base.extend({ type: z.literal("browser.takeover") }),
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
    type: z.literal("browser.result"),
    requestId: short,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(2048).optional(),
  }),
  z.object({ type: z.literal("browser.state"), state: BrowserState }),
  z.object({ type: z.literal("browser.frame"), threadId: ThreadId, frame: BrowserFrame }),
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessage>;
