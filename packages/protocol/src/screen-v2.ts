import { z } from "zod";
import { ScreenId, ScreenTarget, ScreenAction } from "./screen.ts";
import {
  ScreenUIBounds,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
} from "./screen-ui.ts";
export const ScreenPermissionStatus = z.enum(["granted", "denied", "prompt", "n/a"]);
export const ScreenPermissionsV2 = z.object({
  screen: ScreenPermissionStatus,
  input: ScreenPermissionStatus,
});
export const ScreenHelperError = z.object({
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
    semanticActions: z.array(z.string().max(64)).max(32),
    codecs: z.array(z.string().max(32)).min(1).max(16),
    permissions: ScreenPermissionsV2,
  })
  .passthrough();
export type ScreenCapabilities = z.infer<typeof ScreenCapabilities>;
export const ScreenFrameHeaderV2 = z.object({
  version: z.literal(2),
  sessionId: ScreenId,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ts: z.number().finite().nonnegative(),
  width: z.number().int().min(1).max(3840),
  height: z.number().int().min(1).max(2160),
  scale: z.number().finite().positive(),
  codec: z.literal("jpeg"),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
  dirtyRects: z.array(ScreenUIBounds).max(32).optional(),
});
const Envelope = z.object({ version: z.literal(2), id: ScreenId });
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
  Envelope.extend({ op: z.literal("watch"), active: z.boolean() }),
  Envelope.extend({ op: z.literal("ui.tree"), target: ScreenTarget, ...ScreenUITreeOptions.shape }),
  Envelope.extend({ op: z.literal("ui.find"), ...ScreenUIFindOptions.shape }),
  Envelope.extend({ op: z.literal("ui.act"), ...ScreenUIActOptions.shape }),
  Envelope.extend({
    op: z.literal("pointer.move"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
  }),
  Envelope.extend({
    op: z.literal("pointer.click"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  Envelope.extend({
    op: z.literal("pointer.drag"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    toX: z.number().finite().nonnegative(),
    toY: z.number().finite().nonnegative(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  Envelope.extend({
    op: z.literal("key.press"),
    key: z.string().min(1).max(64),
    modifiers: z
      .array(z.enum(["control", "shift", "alt", "meta"]))
      .max(4)
      .default([]),
  }),
  Envelope.extend({ op: z.literal("text.type"), text: z.string().max(4096) }),
  Envelope.extend({
    op: z.literal("scroll"),
    dx: z.number().int().min(-1000).max(1000),
    dy: z.number().int().min(-1000).max(1000),
  }),
]);
export type ScreenHelperRequestV2 = z.infer<typeof ScreenHelperRequestV2>;
export const ScreenHelperReplyV2 = Envelope.extend({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: ScreenHelperError.optional(),
}).passthrough();
