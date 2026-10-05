import { z } from "zod";
import {
  ScreenCapabilities,
  ScreenInput,
  ScreenRect,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
} from "./screen-v2.ts";
export * from "./screen-v2.ts";
// Daemon-to-helper messages: a module of their own, so clients that never talk to a screen
// helper (the client worker) don't carry their schemas.
export * from "./screen-helper.ts";

export {
  ScreenStreamSettings,
  ScreenId,
  ScreenBundle,
  ScreenPermissions,
  ScreenTarget,
  ScreenAction,
} from "./screen-base.ts";
import {
  ScreenId,
  ScreenBundle,
  ScreenPermissions,
  ScreenTarget,
  ScreenAction,
} from "./screen-base.ts";
export const ScreenLegacyFrameHeader = z.object({
  version: z.literal(1),
  sessionId: ScreenId,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().finite().nonnegative(),
  width: z.number().int().positive().max(3840),
  height: z.number().int().positive().max(2160),
  codec: z.enum(["jpeg", "h264"]),
  keyframe: z.boolean().optional(),
  videoCodec: z
    .string()
    .regex(/^avc1\.[0-9a-fA-F]{6}$/)
    .optional(),
  scale: z.number().finite().positive().optional(),
  captureGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  bytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
});
export const ScreenV2FrameHeader = z.object({
  version: z.literal(2),
  sessionId: ScreenId,
  captureGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ts: z.number().finite().nonnegative(),
  width: z.number().int().positive().max(3840),
  height: z.number().int().positive().max(2160),
  scale: z.number().finite().positive().max(8),
  codec: z.enum(["jpeg", "h264"]),
  keyframe: z.boolean().optional(),
  videoCodec: z
    .string()
    .regex(/^avc1\.[0-9a-fA-F]{6}$/)
    .optional(),
  dirtyRects: z.array(ScreenRect).max(64).optional(),
  bytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
});
export const ScreenFrameHeader = z.union([ScreenLegacyFrameHeader, ScreenV2FrameHeader]);
export type ScreenFrameHeader = z.infer<typeof ScreenFrameHeader>;
export type ScreenLegacyFrameHeader = z.infer<typeof ScreenLegacyFrameHeader>;
export const ScreenState = z.object({
  sessionId: ScreenId,
  lifecycle: z.enum(["starting", "live", "stopping", "stopped", "failed"]),
  controller: z.enum(["agent", "human", "none"]),
  indicator: z.boolean(),
  target: ScreenTarget,
  permissions: ScreenPermissions,
  error: z.string().max(1024).optional(),
  capabilities: ScreenCapabilities.optional(),
});
export type ScreenState = z.infer<typeof ScreenState>;
const ScreenBounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export const ScreenInventory = z.object({
  displays: z
    .array(
      z.object({
        displayId: z.number().int().positive(),
        width: z.number(),
        height: z.number(),
        bounds: ScreenBounds.optional(),
      }),
    )
    .max(64),
  windows: z
    .array(
      z.object({
        windowId: z.number().int().positive(),
        bundleId: ScreenBundle,
        title: z.string().max(1024),
        bounds: ScreenBounds.optional(),
      }),
    )
    .max(2048),
});
export const ScreenOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enable"), enabled: z.boolean() }),
  z.object({ op: z.literal("approve"), bundleId: ScreenBundle, allowed: z.boolean() }),
  z.object({ op: z.literal("permissions") }),
  z.object({ op: z.literal("targets") }),
  z.object({ op: z.literal("sessions") }),
  z.object({
    op: z.literal("start"),
    target: ScreenTarget,
    fps: z.number().int().min(1).max(60).default(10),
  }),
  z.object({ op: z.literal("stop"), sessionId: ScreenId }),
  z.object({
    op: z.literal("controller"),
    sessionId: ScreenId,
    controller: z.enum(["agent", "human", "none"]),
    agentId: ScreenId.optional(),
    threadId: ScreenId.optional(),
  }),
  z.object({ op: z.literal("action"), sessionId: ScreenId, action: ScreenAction }),
  z.object({ op: z.literal("subscribe"), sessionId: ScreenId }),
  z.object({ op: z.literal("unsubscribe"), sessionId: ScreenId }),
  z.object({ op: z.literal("record.start"), sessionId: ScreenId }),
  z.object({ op: z.literal("record.stop"), sessionId: ScreenId }),
  z.object({ op: z.literal("capabilities") }),
  ScreenUITreeOptions.extend({ op: z.literal("ui.tree"), sessionId: ScreenId }),
  ScreenUIFindOptions.extend({ op: z.literal("ui.find"), sessionId: ScreenId }),
  ScreenUIActOptions.extend({ op: z.literal("ui.act"), sessionId: ScreenId }),
  z.object({ op: z.literal("input"), sessionId: ScreenId, input: ScreenInput }),
  z.object({ op: z.literal("simulators") }),
  z.object({ op: z.literal("simulator.boot"), udid: z.string().uuid() }),
]);
export type ScreenOperation = z.infer<typeof ScreenOperation>;
export const ScreenClientMessage = z.object({
  type: z.literal("screen.request"),
  requestId: ScreenId,
  operation: ScreenOperation,
});
export const ScreenServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screen.state"), state: ScreenState }),
  z.object({
    type: z.literal("screen.result"),
    requestId: ScreenId,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
]);
export type ScreenPermissions = z.infer<typeof ScreenPermissions>;
export type ScreenInventory = z.infer<typeof ScreenInventory>;
export type ScreenServerMessage = z.infer<typeof ScreenServerMessage>;
