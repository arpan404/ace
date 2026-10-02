import { z } from "zod";
import { ScreenId, ScreenTarget, ScreenAction, ScreenFrameHeader } from "./screen.ts";

export const ScreenError = z.object({
  code: z.enum([
    "permission_denied",
    "target_gone",
    "not_supported",
    "bounds",
    "busy",
    "timeout",
    "internal",
  ]),
  message: z.string().max(1024),
});
const Permission = z.enum(["granted", "denied", "prompt", "n/a"]);
export const ScreenSemanticAction = z.enum([
  "press",
  "focus",
  "setValue",
  "scroll",
  "expand",
  "select",
]);
export const ScreenCapabilities = z
  .object({
    version: z.literal(2),
    platform: z.enum(["macos", "windows", "linux-x11", "linux-wayland"]),
    capture: z.object({ windows: z.boolean(), displays: z.boolean(), changeDriven: z.boolean() }),
    input: z.object({
      pointer: z.boolean(),
      keyboard: z.boolean(),
      scroll: z.boolean(),
      text: z.boolean(),
    }),
    uiTree: z.boolean(),
    semanticActions: z.array(ScreenSemanticAction).max(6),
    codecs: z.array(z.string().min(1).max(32)).min(1).max(8),
    permissions: z.object({ screen: Permission, input: Permission }),
  })
  .passthrough();
export type ScreenCapabilities = z.infer<typeof ScreenCapabilities>;
export const ScreenUIQuery = z.object({
  role: z.string().max(256).optional(),
  name: z.string().max(1024).optional(),
  text: z.string().max(1024).optional(),
});
export const ScreenUITreeInput = z.object({
  maxDepth: z.number().int().min(0).max(32).default(8),
  maxNodes: z.number().int().min(1).max(512).default(128),
});
export const ScreenUIFindInput = z.object({
  query: ScreenUIQuery,
  limit: z.number().int().min(1).max(128).default(32),
});
export const ScreenUIActInput = z.object({
  ref: z.string().min(1).max(512),
  action: ScreenSemanticAction,
  value: z.string().max(4096).optional(),
});
const Bounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
});
export interface ScreenUINode {
  ref: string;
  role: string;
  name: string;
  value?: string | undefined;
  description?: string | undefined;
  bounds: z.infer<typeof Bounds>;
  states: string[];
  actions: z.infer<typeof ScreenSemanticAction>[];
  children: ScreenUINode[];
}
export const ScreenUINode: z.ZodType<ScreenUINode> = z.lazy(() =>
  z.object({
    ref: z.string().min(1).max(512),
    role: z.string().max(256),
    name: z.string().max(4096),
    value: z.string().max(4096).optional(),
    description: z.string().max(4096).optional(),
    bounds: Bounds,
    states: z
      .array(z.enum(["focused", "selected", "checked", "disabled", "expanded", "offscreen"]))
      .max(6),
    actions: z.array(ScreenSemanticAction).max(6),
    children: z.array(ScreenUINode).max(512),
  }),
);
export const ScreenUITreeResult = z.object({ tree: ScreenUINode, truncated: z.boolean() });
export const ScreenUIFindResult = z.object({
  nodes: z.array(ScreenUINode).max(128),
  truncated: z.boolean(),
});
export const ScreenUIActResult = z.object({ fallback: z.boolean(), method: z.string().max(64) });
const Envelope = z.object({ version: z.literal(2), id: ScreenId });
const Point = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
});
export const ScreenNamedKey = z.object({
  key: z.string().min(1).max(64),
  modifiers: z
    .array(z.enum(["shift", "control", "alt", "super", "command", "option"]))
    .max(4)
    .default([]),
});
export const ScreenHelperRequestV2 = z.discriminatedUnion("op", [
  Envelope.extend({ op: z.literal("hello") }),
  Envelope.extend({ op: z.literal("permissions") }),
  Envelope.extend({ op: z.literal("targets") }),
  Envelope.extend({ op: z.literal("stop") }),
  Envelope.extend({
    op: z.literal("start"),
    sessionId: ScreenId,
    target: ScreenTarget,
    allowlist: z.array(z.string().min(1).max(256)).max(64),
    fps: z.number().int().min(1).max(30),
  }),
  Envelope.extend({ op: z.literal("action"), action: ScreenAction }),
  Envelope.extend({
    op: z.literal("ui.tree"),
    ...ScreenUITreeInput.shape,
    target: ScreenTarget.optional(),
  }),
  Envelope.extend({ op: z.literal("ui.find"), ...ScreenUIFindInput.shape }),
  Envelope.extend({ op: z.literal("ui.act"), ...ScreenUIActInput.shape }),
  Envelope.extend({ op: z.literal("pointer.move"), ...Point.shape }),
  Envelope.extend({
    op: z.literal("pointer.click"),
    ...Point.shape,
    button: z.enum(["left", "middle", "right"]).default("left"),
  }),
  Envelope.extend({
    op: z.literal("pointer.drag"),
    ...Point.shape,
    toX: z.number().finite().nonnegative(),
    toY: z.number().finite().nonnegative(),
  }),
  Envelope.extend({ op: z.literal("key.press"), ...ScreenNamedKey.shape }),
  Envelope.extend({ op: z.literal("text.type"), text: z.string().max(4096) }),
  Envelope.extend({
    op: z.literal("scroll"),
    dx: z.number().finite().min(-1000).max(1000),
    dy: z.number().finite().min(-1000).max(1000),
  }),
]);
export type ScreenHelperRequestV2 = z.infer<typeof ScreenHelperRequestV2>;
export const ScreenHelperReplyV2 = z
  .object({
    version: z.literal(2),
    id: ScreenId,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: ScreenError.optional(),
  })
  .passthrough();
export const ScreenFrameHeaderV2 = ScreenFrameHeader.extend({
  version: z.literal(2),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ts: z.number().finite().nonnegative(),
  scale: z.number().finite().positive().max(16),
  dirtyRects: z.array(Bounds).max(256).optional(),
}).refine((h) => h.seq === h.sequence && h.ts === h.timestamp, "Frame aliases disagree");
export const ScreenTransportFrameHeader = z.union([ScreenFrameHeader, ScreenFrameHeaderV2]);
export type ScreenTransportFrameHeader = z.infer<typeof ScreenTransportFrameHeader>;
