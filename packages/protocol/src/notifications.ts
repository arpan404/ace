import { z } from "zod";
import { DeviceId, InteractionId, ThreadId, Timestamp } from "./ids.ts";

const boundedId = z.string().min(1).max(200);
export const NotificationStatus = z.enum([
  "needs_you",
  "done",
  "failed",
  "unresponsive",
  "background_done",
  "agent_says",
]);
export const Notification = z.object({
  id: boundedId,
  threadId: ThreadId.and(boundedId),
  title: z.string().max(200),
  status: NotificationStatus,
  interactionId: InteractionId.and(boundedId).optional(),
  backgroundCount: z.number().int().nonnegative().max(1_000_000),
  actions: z.array(z.object({ action: z.enum(["approve", "deny"]), optionId: boundedId })).max(2),
  preview: z.string().max(300).optional(),
  message: z.string().max(300).optional(),
});
export type Notification = z.infer<typeof Notification>;
export const WebPushSubscription = z.object({
  endpoint: z.url().max(2048),
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;
export const NotificationAddress = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("websocket"), platform: z.enum(["desktop", "web", "phone"]) }),
  z.object({
    channel: z.literal("webpush"),
    platform: z.enum(["web", "phone"]),
    subscription: WebPushSubscription,
  }),
  z.object({
    channel: z.literal("apns"),
    platform: z.literal("phone"),
    token: z.string().regex(/^[a-fA-F0-9]{64}$/),
  }),
  z.object({
    channel: z.literal("fcm"),
    platform: z.literal("phone"),
    token: z.string().min(1).max(4096),
  }),
]);
export type NotificationAddress = z.infer<typeof NotificationAddress>;
export const QuietHours = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => {
      try {
        const formatter = new Intl.DateTimeFormat("en", { timeZone: value });
        formatter.resolvedOptions();
        return true;
      } catch {
        return false;
      }
    })
    .meta({ "x-ace-constraint": "Must be an IANA time zone accepted by Intl.DateTimeFormat." }),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(0).max(1439),
});
export type QuietHours = z.infer<typeof QuietHours>;
export const NotificationPreferences = z.object({
  quietHours: QuietHours.nullable().default(null),
  includePreview: z.boolean().default(false),
  agentSays: z.boolean().optional(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
export const PresenceUpdate = z.object({
  type: z.literal("presence.update"),
  threadId: ThreadId.and(boundedId).nullable(),
  inputAgeMs: z.number().int().nonnegative().max(86_400_000),
});
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;
export const NotificationConfigRequest = z.object({
  type: z.literal("notification.config"),
  requestId: boundedId,
});
export const NotificationConfigResult = z.object({
  type: z.literal("notification.config.result"),
  requestId: boundedId,
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{87}$/)
    .nullable(),
  preferences: NotificationPreferences,
});
export const NotificationRegister = z.object({
  type: z.literal("notification.register"),
  requestId: boundedId.optional(),
  device: NotificationAddress,
});
export const NotificationRegisterResult = z.object({
  type: z.literal("notification.register.result"),
  requestId: boundedId,
});
export const NotificationSettings = z.object({
  type: z.literal("notification.preferences"),
  preferences: NotificationPreferences,
});
export const NotificationSnooze = z.object({
  type: z.literal("notification.snooze"),
  threadId: ThreadId.and(boundedId),
  until: Timestamp,
});
export const NotificationMessage = z.object({
  type: z.literal("notification"),
  notification: Notification,
});
export const NotificationDevice = z.object({
  id: DeviceId.and(boundedId),
  address: NotificationAddress,
  preferences: NotificationPreferences,
});
export type NotificationDevice = z.infer<typeof NotificationDevice>;
