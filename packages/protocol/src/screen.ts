import { z } from "zod";
import { ScreenAgentScope } from "./screen-ui.ts";
import {
  ScreenCapabilities,
  ScreenError,
  ScreenInput,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
} from "./screen-v2.ts";
export * from "./screen-v2.ts";
// Daemon-to-helper messages: a module of their own, so clients that never talk to a screen
// helper (the client worker) don't carry their schemas.
export * from "./screen-helper.ts";

export {
  ScreenChooserPick,
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
  ScreenStreamSettings,
  ScreenPermissions,
  ScreenTarget,
  ScreenAction,
} from "./screen-base.ts";
export const ScreenMode = z.enum(["background", "foreground"]);
export const ScreenOpenedApp = z.object({
  bundleId: ScreenBundle,
  pid: z.number().int().positive(),
  mode: z.literal("background"),
});
export type ScreenOpenedApp = z.infer<typeof ScreenOpenedApp>;
export const ScreenState = z.object({
  sessionId: ScreenId,
  lifecycle: z.enum(["starting", "live", "stopping", "stopped", "failed"]),
  controller: z.enum(["agent", "human", "none"]),
  mode: ScreenMode.default("background"),
  secureInputAllowed: z.boolean().default(false),
  holder: ScreenAgentScope.optional(),
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
  /**
   * Set where the machine's own sharing dialog picks what is shared (Linux on Wayland): the
   * lists are empty and a `chooser` target starts sharing; says which kinds the dialog offers.
   */
  chooser: z.object({ windows: z.boolean(), displays: z.boolean() }).optional(),
});
export const ScreenAppWindows = z.object({
  windows: z
    .array(
      ScreenInventory.shape.windows.element.extend({
        focused: z.boolean().optional(),
        main: z.boolean().optional(),
        usable: z.boolean().optional(),
      }),
    )
    .max(2048),
  selectedWindowId: z.number().int().positive().optional(),
});
export type ScreenAppWindows = z.infer<typeof ScreenAppWindows>;
export const ScreenStatus = z.object({
  enabled: z.boolean(),
  permissions: ScreenPermissions,
  sessions: z.number().int().min(0).max(8),
});
export type ScreenStatus = z.infer<typeof ScreenStatus>;
export const ScreenOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enable"), enabled: z.boolean() }),
  z.object({ op: z.literal("status") }),
  z.object({ op: z.literal("stop.all") }),
  z.object({ op: z.literal("mode"), sessionId: ScreenId, mode: ScreenMode }),
  z.object({ op: z.literal("secure.input"), sessionId: ScreenId, allowed: z.boolean() }),
  z.object({ op: z.literal("open.app"), bundleId: ScreenBundle }),
  z.object({ op: z.literal("permissions") }),
  z.object({
    op: z.literal("permissions.request"),
    permission: z.enum(["screenRecording", "accessibility"]),
  }),
  z.object({ op: z.literal("targets") }),
  z.object({ op: z.literal("sessions") }),
  z.object({
    op: z.literal("start"),
    threadId: ScreenAgentScope.shape.threadId.optional(),
    target: ScreenTarget,
    fps: z.number().int().min(1).max(60).default(10),
  }),
  z.object({ op: z.literal("stop"), sessionId: ScreenId }),
  z.object({
    op: z.literal("controller"),
    sessionId: ScreenId,
    controller: z.enum(["agent", "human", "none"]),
    agentId: ScreenAgentScope.shape.agentId.optional(),
    threadId: ScreenAgentScope.shape.threadId.optional(),
  }),
  z.object({ op: z.literal("action"), sessionId: ScreenId, action: ScreenAction }),
  z.object({ op: z.literal("subscribe"), sessionId: ScreenId }),
  /**
   * A watching view's live stream: H.264 at the size, rate and bit rate it can show, where the
   * Mac's helper encodes it; JPEG otherwise. The last view leaving returns the session to stills.
   */
  z.object({
    op: z.literal("stream.configure"),
    sessionId: ScreenId,
    settings: ScreenStreamSettings,
  }),
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
/**
 * A viewer showed a screen session's pictures (stream kind `screenFrame`) up to `sequence` of
 * capture `streamId`, cumulatively, as `devices.ack` does for a device. No reply.
 */
export const ScreenAck = z.object({
  type: z.literal("screen.ack"),
  sessionId: ScreenId,
  streamId: ScreenId,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** The viewer's decoder lost its place (a decode error): send it a keyframe. */
  keyframe: z.literal(true).optional(),
});
export type ScreenAck = z.infer<typeof ScreenAck>;
export const ScreenServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screen.enabled"), enabled: z.boolean() }),
  z.object({ type: z.literal("screen.state"), state: ScreenState }),
  z.object({
    type: z.literal("screen.result"),
    requestId: ScreenId,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    errorCode: ScreenError.shape.code.optional(),
    holder: z.object({ sessionId: ScreenId, owner: z.string().max(1024) }).optional(),
  }),
]);
export type ScreenPermissions = z.infer<typeof ScreenPermissions>;
export type ScreenInventory = z.infer<typeof ScreenInventory>;
export type ScreenServerMessage = z.infer<typeof ScreenServerMessage>;
