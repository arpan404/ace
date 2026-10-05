import { z } from "zod";
export const ScreenId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const ScreenBundle = z.string().min(1).max(256);
export const ScreenPermissions = z.object({
  screenRecording: z.boolean(),
  accessibility: z.boolean(),
});
export const ScreenTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("app"),
    bundleId: ScreenBundle,
    displayId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("window"),
    bundleId: ScreenBundle,
    windowId: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("display"),
    displayId: z.number().int().positive(),
    bundleIds: z.array(ScreenBundle).min(1).max(64),
  }),
]);
export type ScreenTarget = z.infer<typeof ScreenTarget>;
export const ScreenAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("click"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z.enum(["left", "right"]).default("left"),
  }),
  z.object({ kind: z.literal("type"), text: z.string().max(4096) }),
  z.object({
    kind: z.literal("key"),
    keyCode: z.number().int().min(0).max(127),
    modifiers: z
      .array(z.enum(["command", "shift", "option", "control"]))
      .max(4)
      .default([]),
  }),
  z.object({
    kind: z.literal("scroll"),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    deltaX: z.number().int().min(-1000).max(1000),
    deltaY: z.number().int().min(-1000).max(1000),
  }),
]);
export type ScreenAction = z.infer<typeof ScreenAction>;
/** Negotiated live preview. JPEG remains the default for screenshots and older clients. */
export const ScreenStreamSettings = z.object({
  codec: z.enum(["jpeg", "h264"]),
  maxWidth: z.number().int().min(64).max(3840),
  maxHeight: z.number().int().min(64).max(2160),
  fps: z.number().int().min(1).max(60),
  bitrate: z.number().int().min(128000).max(20000000),
});
export type ScreenStreamSettings = z.infer<typeof ScreenStreamSettings>;
