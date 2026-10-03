import { z } from "zod";
import { ThreadId, AgentId } from "./ids.ts";
import { ScreenId } from "./screen-base.ts";
import { ScreenUITreeOptions, ScreenUIFindOptions, ScreenUIActOptions } from "./screen-v2.ts";

export const AppDeviceId = z
  .string()
  .max(256)
  .regex(/^(?:ios:[a-fA-F0-9-]{36}|android:[a-zA-Z0-9_.-]{1,200})$/);
export const AppDevice = z.object({
  id: AppDeviceId,
  platform: z.enum(["ios", "android"]),
  name: z.string().min(1).max(256),
  state: z.enum(["booted", "shutdown", "offline", "unauthorized"]),
  runtime: z.string().max(256).optional(),
  serial: z.string().max(256).optional(),
});
export type AppDevice = z.infer<typeof AppDevice>;
const point = { x: z.number().int().min(0).max(16384), y: z.number().int().min(0).max(16384) };
const durationMs = z.number().int().min(1).max(10000).default(500);
export const DeviceInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), ...point }),
  z.object({ kind: z.literal("longPress"), ...point, durationMs }),
  z.object({ kind: z.literal("swipe"), ...point, toX: point.x, toY: point.y, durationMs }),
  z.object({ kind: z.literal("type"), text: z.string().max(4096) }),
  z.object({ kind: z.literal("key"), key: z.enum(["home", "back", "rotate", "enter", "power"]) }),
]);
export type DeviceInput = z.infer<typeof DeviceInput>;
export const DeviceSettings = z.object({
  appearance: z.enum(["light", "dark"]).optional(),
  location: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .optional(),
  locale: z
    .string()
    .regex(/^[a-zA-Z]{2,8}(?:[-_][a-zA-Z0-9]{2,8}){0,2}$/)
    .optional(),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;
export const DeviceFailure = z.object({
  code: z.enum([
    "sdk_missing",
    "tool_missing",
    "not_supported",
    "not_found",
    "not_booted",
    "permission_denied",
    "busy",
    "timeout",
    "command_failed",
    "invalid_data",
    "lease_required",
    "stale_ref",
    "limit",
  ]),
  message: z.string().max(2048),
  hint: z.string().max(2048),
});
export type DeviceFailure = z.infer<typeof DeviceFailure>;
export const DeviceInventory = z.object({
  devices: z.array(AppDevice).max(1024),
  issues: z.array(DeviceFailure).max(2).default([]),
});
export type DeviceInventory = z.infer<typeof DeviceInventory>;
export const DeviceState = z.object({
  device: AppDevice,
  enabled: z.boolean(),
  approved: z.boolean(),
  threadId: ThreadId.optional(),
  lifecycle: z.enum(["idle", "starting", "live", "stopping", "failed"]),
  streamId: ScreenId.optional(),
  controller: z.enum(["none", "human", "agent"]),
  leaseExpiresAt: z.number().nonnegative().optional(),
  error: DeviceFailure.optional(),
});
export type DeviceState = z.infer<typeof DeviceState>;
const target = { deviceId: AppDeviceId };
export const DeviceOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("enable"), enabled: z.boolean() }),
  z.object({ op: z.literal("list") }),
  z.object({ op: z.literal("states") }),
  z.object({ op: z.literal("approve"), ...target, threadId: ThreadId, allowed: z.boolean() }),
  z.object({ op: z.literal("boot"), ...target }),
  z.object({ op: z.literal("shutdown"), ...target }),
  z.object({ op: z.literal("install"), ...target, path: z.string().min(1).max(4096) }),
  z.object({ op: z.literal("open_app"), ...target, appId: z.string().min(1).max(256) }),
  z.object({ op: z.literal("open_url"), ...target, url: z.string().min(1).max(4096) }),
  z.object({ op: z.literal("configure"), ...target, settings: DeviceSettings }),
  z.object({ op: z.literal("start"), ...target, fps: z.number().int().min(1).max(30).default(10) }),
  z.object({ op: z.literal("stop"), ...target }),
  z.object({ op: z.literal("subscribe"), ...target }),
  z.object({ op: z.literal("unsubscribe"), ...target }),
  z.object({
    op: z.literal("controller"),
    ...target,
    controller: z.enum(["none", "human", "agent"]),
    threadId: ThreadId.optional(),
    agentId: AgentId.optional(),
  }),
  z.object({ op: z.literal("input"), ...target, input: DeviceInput }),
  z.object({ op: z.literal("screenshot"), ...target }),
  ScreenUITreeOptions.extend({ op: z.literal("ui.tree"), ...target }),
  ScreenUIFindOptions.extend({ op: z.literal("ui.find"), ...target }),
  ScreenUIActOptions.extend({ op: z.literal("ui.act"), ...target }),
  z.object({ op: z.literal("logs.start"), ...target }),
  z.object({ op: z.literal("logs.stop"), ...target }),
  z.object({
    op: z.literal("logs"),
    ...target,
    limit: z.number().int().min(1).max(256).default(100),
  }),
  z.object({ op: z.literal("record.start"), ...target }),
  z.object({ op: z.literal("record.stop"), ...target }),
]);
export type DeviceOperation = z.infer<typeof DeviceOperation>;
export const DeviceClientMessage = z.object({
  type: z.literal("devices.request"),
  requestId: ScreenId,
  operation: DeviceOperation,
});
export type DeviceClientMessage = z.infer<typeof DeviceClientMessage>;
export const DeviceServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("devices.result"),
    requestId: ScreenId,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: DeviceFailure.optional(),
  }),
  z.object({ type: z.literal("devices.state"), state: DeviceState }),
  z.object({
    type: z.literal("devices.logs"),
    deviceId: AppDeviceId,
    sequence: z.number().int().nonnegative(),
    lines: z.array(z.string().max(4096)).max(64),
    dropped: z.number().int().nonnegative(),
  }),
]);
export type DeviceServerMessage = z.infer<typeof DeviceServerMessage>;
