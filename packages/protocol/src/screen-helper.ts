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
