/*
 * The daemon's requests to its native screen helper and the helper's replies, over the
 * helper's stdin/stdout. Only the daemon and helper fakes use them.
 */
import { z } from "zod";
import {
  ScreenAction,
  ScreenBundle,
  ScreenId,
  ScreenStreamSettings,
  ScreenTarget,
} from "./screen-base.ts";
import {
  ScreenError,
  ScreenAppURL,
  ScreenRect,
  ScreenInput,
  ScreenUIActOptions,
  ScreenUIFindOptions,
  ScreenUITreeOptions,
} from "./screen-v2.ts";

import { ScreenMeasurementOptions } from "./interaction-measurement.ts";

const HelperEnvelope = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  id: ScreenId,
  sessionId: ScreenId.optional(),
  mode: z.enum(["background", "foreground"]).optional(),
  secureInputAllowed: z.boolean().optional(),
  humanDeviceInput: z.boolean().optional(),
  /** The person at a live view sent this input, not an agent. */
  person: z.boolean().optional(),
});
export const ScreenHelperRequest = z.discriminatedUnion("op", [
  HelperEnvelope.extend({ op: z.literal("hello") }),
  HelperEnvelope.extend({ op: z.literal("metrics") }),
  HelperEnvelope.extend({
    op: z.literal("measure_interaction"),
    ...ScreenMeasurementOptions.omit({ repeat: true }).shape,
    // Daemon remaining repeat budget includes native input preparation.
    maxWindowMs: z.number().int().min(1).max(10_000).optional(),
  }),
  HelperEnvelope.extend({
    op: z.literal("open.app"),
    bundleId: ScreenBundle,
    allowlist: z.array(ScreenBundle).max(64),
  }),
  HelperEnvelope.extend({ op: z.literal("stream.configure"), settings: ScreenStreamSettings }),
  HelperEnvelope.extend({ op: z.literal("stream.keyframe") }),
  HelperEnvelope.extend({ op: z.literal("stream.image") }),
  HelperEnvelope.extend({ op: z.literal("capture"), enabled: z.boolean() }),
  HelperEnvelope.extend({ op: z.literal("input"), input: ScreenInput }),
  HelperEnvelope.extend({
    ...ScreenUITreeOptions.shape,
    op: z.literal("ui.tree"),
    target: ScreenTarget,
    allowlist: z.array(ScreenBundle).max(64),
  }),
  HelperEnvelope.extend({
    ...ScreenUIFindOptions.shape,
    op: z.literal("ui.find"),
    target: ScreenTarget,
    allowlist: z.array(ScreenBundle).max(64),
  }),
  HelperEnvelope.extend({
    ...ScreenUIActOptions.shape,
    op: z.literal("ui.act"),
    target: ScreenTarget,
    allowlist: z.array(ScreenBundle).max(64),
  }),
  HelperEnvelope.extend({ op: z.literal("permissions") }),
  /** macOS: prompt once, then open the permission's System Settings pane. */
  HelperEnvelope.extend({
    op: z.literal("permissions.request"),
    permission: z.enum(["screenRecording", "accessibility"]),
  }),
  /** macOS: press a button of the captured window by accessible name (Simulator's Home). */
  HelperEnvelope.extend({ op: z.literal("button.press"), name: z.string().min(1).max(64) }),
  HelperEnvelope.extend({ op: z.literal("targets") }),
  HelperEnvelope.extend({
    op: z.literal("windows.list"),
    bundleId: ScreenBundle,
    allowlist: z.array(ScreenBundle).max(64),
  }),
  HelperEnvelope.extend({ op: z.literal("window.select"), windowId: z.number().int().positive() }),
  HelperEnvelope.extend({
    op: z.literal("open.url"),
    bundleId: ScreenBundle,
    url: ScreenAppURL,
    allowlist: z.array(ScreenBundle).max(64),
  }),
  HelperEnvelope.extend({
    op: z.literal("menu.press"),
    path: z.array(z.string().min(1).max(256)).min(1).max(8),
  }),
  HelperEnvelope.extend({ op: z.literal("stop") }),
  HelperEnvelope.extend({ op: z.literal("action"), action: ScreenAction }),
  HelperEnvelope.extend({
    op: z.literal("start"),
    sessionId: ScreenId,
    target: ScreenTarget,
    allowlist: z.array(ScreenBundle).max(64),
    fps: z.number().int().min(1).max(60),
    capture: z.boolean().optional(),
  }),
]);
export type ScreenHelperRequest = z.infer<typeof ScreenHelperRequest>;
export const ScreenHelperReply = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    id: ScreenId,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.union([z.string().max(1024), ScreenError]).optional(),
  })
  .passthrough();

/*
 * A captured frame's header on the helper's pipe: `u32 header length | JSON header | payload`.
 * Recording files are the same frames back to back. Clients never see either: their pictures
 * come on the shared media stream (stream kinds `deviceFrame` and `screenFrame`).
 */
export const ScreenLegacyFrameHeader = z.object({
  version: z.literal(1),
  sessionId: ScreenId,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().finite().nonnegative(),
  width: z.number().int().positive().max(3840),
  height: z.number().int().positive().max(3840),
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
  height: z.number().int().positive().max(3840),
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
