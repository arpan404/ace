import { z } from "zod";
import {
  Notification,
  NotificationDevice,
  NotificationAddress,
  NotificationPreferences,
  PresenceUpdate,
} from "@ace/protocol/notifications";
import { DeviceId, ThreadId } from "@ace/protocol/ids";

import { MetadataEvent } from "./metadata.ts";

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkerCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("cursor") }),
  z.object({ method: z.literal("drain") }),
  z.object({ method: z.literal("close") }),
  z.object({
    method: z.literal("ingest"),
    events: z.array(MetadataEvent).max(256),
    afterSeq: seq,
    throughSeq: seq,
  }),
  z.object({
    method: z.literal("register"),
    device: DeviceId.and(z.string().max(200)),
    address: NotificationAddress,
  }),
  z.object({ method: z.literal("connectDevice"), device: DeviceId.and(z.string().max(200)) }),
  z.object({
    method: z.literal("preferences"),
    device: DeviceId.and(z.string().max(200)),
    preferences: NotificationPreferences,
  }),
  z.object({ method: z.literal("revoke"), device: DeviceId.and(z.string().max(200)) }),
  z.object({ method: z.literal("snooze"), thread: ThreadId.and(z.string().max(200)), until: seq }),
  z.object({
    method: z.literal("presence"),
    session: z.string().max(200),
    device: DeviceId.and(z.string().max(200)),
    update: PresenceUpdate,
  }),
  z.object({ method: z.literal("disconnect"), session: z.string().max(200) }),
]);
export type WorkerCall = z.infer<typeof WorkerCall>;
export const ToWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call"), id: seq, call: WorkerCall }),
  z.object({
    type: z.literal("deliveryResult"),
    id: seq,
    result: z.enum(["accepted", "retry", "gone", "failed"]),
  }),
]);
export const FromWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("result"), id: seq, ok: z.boolean(), value: seq.optional() }),
  z.object({
    type: z.literal("delivery"),
    id: seq,
    device: NotificationDevice,
    notification: Notification,
  }),
  z.object({ type: z.literal("cancel"), id: seq }),
]);
export const WorkerConfig = z.object({ path: z.string().max(4096), windowMs: seq.default(5000) });
