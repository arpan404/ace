import { z } from "zod";
import { wireShape } from "@ace/provider-kit/wire-shape";
import {
  Notification,
  NotificationDevice,
  NotificationAddress,
  NotificationPreferences,
  NotificationFeed,
  PresenceUpdate,
} from "@ace/protocol/notifications";
import { DeviceId, ThreadId } from "@ace/protocol/ids";

import { MetadataEvent } from "./metadata.ts";

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const WorkerCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("cursor") }),
  z.object({ method: z.literal("getPreferences"), device: DeviceId.and(z.string().max(200)) }),
  z.object({ method: z.literal("notify"), notification: Notification }),
  z.object({ method: z.literal("drain") }),
  z.object({ method: z.literal("close") }),
  z.object({ method: z.literal("sleep") }),
  z.object({ method: z.literal("closeSleep") }),
  z.object({ method: z.literal("forgetSleep") }),
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
  z.object({ method: z.literal("unregister"), device: DeviceId.and(z.string().max(200)) }),
  z.object({ method: z.literal("connectDevice"), device: DeviceId.and(z.string().max(200)) }),
  z.object({
    method: z.literal("pushAddresses"),
    devices: z.array(DeviceId.and(z.string().max(200))).max(128),
  }),
  z.object({
    method: z.literal("preferences"),
    device: DeviceId.and(z.string().max(200)),
    preferences: NotificationPreferences,
  }),
  z.object({ method: z.literal("revoke"), device: DeviceId.and(z.string().max(200)) }),
  z.object({
    method: z.literal("markRemote"),
    threads: z.array(ThreadId.and(z.string().max(200))).max(256),
  }),
  z.object({ method: z.literal("snooze"), thread: ThreadId.and(z.string().max(200)), until: seq }),
  z.object({
    method: z.literal("presence"),
    session: z.string().max(200),
    device: DeviceId.and(z.string().max(200)),
    update: PresenceUpdate,
  }),
  z.object({ method: z.literal("disconnect"), session: z.string().max(200) }),
  z.object({
    method: z.literal("feed"),
    device: DeviceId.and(z.string().max(200)),
    afterCursor: seq,
  }),
]);
export type WorkerCall = z.infer<typeof WorkerCall>;
const ToWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call"), id: seq, call: WorkerCall }),
  z.object({
    type: z.literal("deliveryResult"),
    id: seq,
    result: z.enum(["accepted", "retry", "gone", "revoked", "failed"]),
  }),
]);
const refusalPathChars = 4096;
const refusalMessageChars = 8192;
/**
 * The frame a worker sends when it refuses its store, cut to the wire's limits: a frame over
 * them would fail to parse, and the daemon would degrade instead of stopping on the refusal.
 */
export function incompatibleFrame(refusal: { path: string; message: string }) {
  return {
    type: "incompatible" as const,
    path: refusal.path.slice(0, refusalPathChars),
    message: refusal.message.slice(0, refusalMessageChars),
  };
}
const FromWorker = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("result"),
    id: seq,
    ok: z.boolean(),
    value: z
      .union([
        seq,
        NotificationFeed,
        NotificationPreferences,
        /** `pushAddresses`: devices with a push address that may be alerted now. */
        z.array(NotificationDevice).max(128),
        /** `closeSleep`: the spans in which queued agent notices are too old to send. */
        z.array(z.object({ after: seq, before: seq }).strict()).max(64),
      ])
      .optional(),
    /** Why a call failed, so the daemon's log names the cause. */
    error: z.string().max(256).optional(),
  }),
  z.object({
    type: z.literal("delivery"),
    id: seq,
    device: NotificationDevice,
    notification: Notification,
  }),
  z.object({ type: z.literal("cancel"), id: seq }),
  /** The store is in a format this build cannot read; the worker waits to be stopped. */
  z.object({
    type: z.literal("incompatible"),
    path: z.string().max(refusalPathChars),
    message: z.string().max(refusalMessageChars),
  }),
  /** Sent after a call changes when delivery next has work or whether the worker is idle. */
  z.object({ type: z.literal("state"), deadline: seq.nullable(), idle: z.boolean() }),
]);
/** What a successful call may return. */
export type WorkerValue = Extract<z.infer<typeof FromWorker>, { type: "result" }>["value"];
/**
 * Messages between the daemon and its notification worker. Both ends are this build (the
 * worker checks `notifyWireShape` when it starts), so they are typed, not parsed on receipt.
 * Calls carrying arguments the daemon was handed are checked against `WorkerCall` before they
 * are sent (`NotificationWorker`); the worker's replies come from its store, which decodes
 * its rows as it reads them.
 */
export type ToWorker = z.output<typeof ToWorker>;
export type FromWorker = z.output<typeof FromWorker>;
export const notifyWireShape = wireShape([ToWorker, FromWorker]);
export const WorkerConfig = z.object({
  path: z.string().max(4096),
  windowMs: seq.default(5000),
  alertsFrom: seq.default(0),
  sleptAfter: z.object({ seq, at: seq }).optional(),
});
