import { DiagnosticsHealth } from "./diagnostics.ts";
import { z } from "zod";
import {
  ModelsListRequest,
  ModelsRefreshRequest,
  ModelsResolveRequest,
  ModelsResult,
} from "./models.ts";
import {
  PresenceUpdate,
  NotificationRegister,
  NotificationSettings,
  NotificationSnooze,
  NotificationMessage,
} from "./notifications.ts";
import { Agent } from "./agent.ts";
import { BackgroundTask } from "./background.ts";
import { Command } from "./commands.ts";
import { Event, UsageUpdated } from "./events.ts";
import { CommandId, DeviceId, HostId, ThreadId } from "./ids.ts";
import { Interaction } from "./interactions.ts";
import { Item } from "./items.ts";
import { Run, Thread } from "./thread.ts";

import {
  SettingsGet,
  SettingsSet,
  SettingsSubscribe,
  SettingsResult,
  SettingsChanged,
  SettingsDiagnosticMessage,
} from "./settings.ts";

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Zod records intentionally strip __proto__. Validate entries before rebuilding
// with own data properties so every supported opaque ID survives decoding.
const records = <T>(schema: z.ZodType<T>) =>
  z
    .custom<Record<string, unknown>>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (Object.getPrototypeOf(value) === null ||
          Object.getPrototypeOf(value) === Object.prototype),
    )
    .transform((value): unknown => Object.entries(value))
    .pipe(z.array(z.tuple([z.string(), schema])))
    .transform((entries) => Object.fromEntries<T>(entries));
export const ThreadView = z.object({
  kind: z.literal("thread"),
  seq,
  thread: Thread,
  agents: records(Agent),
  agentChildren: records(z.array(z.string())),
  runs: records(Run),
  items: records(Item),
  itemOrder: z.array(z.string()),
  /** Exclusive item creation-sequence cursor for older history. */
  itemsBefore: seq.positive().nullable().default(null),
  interactions: records(Interaction),
  backgroundTasks: records(BackgroundTask),
  usage: records(UsageUpdated),
});
export type ThreadView = z.infer<typeof ThreadView>;
export const ThreadListEntry = Thread.omit({ rootAgentId: true });
export type ThreadListEntry = z.infer<typeof ThreadListEntry>;
export const ThreadListView = z.object({
  kind: z.literal("threads"),
  seq,
  threads: records(ThreadListEntry),
});
export type ThreadListView = z.infer<typeof ThreadListView>;
export const SnapshotView = z.discriminatedUnion("kind", [ThreadView, ThreadListView]);
export const SubscriptionScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("threads") }),
  z.object({ kind: z.literal("thread"), threadId: ThreadId }),
]);
export type SubscriptionScope = z.infer<typeof SubscriptionScope>;

/** First covered sequence when consecutive deltas have been concatenated in transit. */
export const DeliveryEvent = Event.extend({ seq, firstSeq: seq.positive().optional() }).refine(
  (event) =>
    event.firstSeq === undefined ||
    (event.payload.type === "item.delta" && event.firstSeq <= event.seq),
);
export type DeliveryEvent = z.infer<typeof DeliveryEvent>;
export const ItemsPage = z.object({
  threadId: ThreadId,
  items: z.array(Item),
  itemsBefore: seq.positive().nullable(),
});
export type ItemsPage = z.infer<typeof ItemsPage>;
export const ClientMessage = z.discriminatedUnion("type", [
  SettingsGet,
  SettingsSet,
  SettingsSubscribe,
  ModelsListRequest,
  ModelsRefreshRequest,
  ModelsResolveRequest,
  PresenceUpdate,
  NotificationRegister,
  NotificationSettings,
  NotificationSnooze,
  z
    .object({
      type: z.literal("hello"),
      protocolVersion: z.literal(1),
      deviceId: DeviceId,
      token: z.string().optional(),
      ticket: z.string().optional(),
    })
    .refine((hello) => (hello.token !== undefined) !== (hello.ticket !== undefined), {
      message: "Exactly one credential is required",
    }),
  z.object({
    type: z.literal("subscribe"),
    subscriptionId: z.string().min(1),
    scope: SubscriptionScope,
    afterSeq: seq.optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), subscriptionId: z.string().min(1) }),
  z.object({ type: z.literal("command"), command: Command }),
  z.object({
    type: z.literal("output.read"),
    requestId: z.string().min(1),
    streamId: z.string().min(1),
    offset: seq,
    limit: seq.positive().max(256 * 1024),
  }),
  z.object({
    type: z.literal("items.page"),
    requestId: z.string().min(1),
    threadId: ThreadId,
    before: seq.positive(),
    limit: seq.positive().max(200),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const CommandResult = z.object({
  commandId: CommandId,
  ok: z.boolean(),
  health: DiagnosticsHealth.optional(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
export const ServerMessage = z.discriminatedUnion("type", [
  SettingsResult,
  SettingsChanged,
  SettingsDiagnosticMessage,
  ModelsResult,
  NotificationMessage,
  z.object({
    type: z.literal("welcome"),
    hostId: HostId,
    protocolVersion: z.literal(1),
    headSeq: seq,
  }),
  z
    .object({ type: z.literal("snapshot"), subscriptionId: z.string(), seq, view: SnapshotView })
    .refine((message) => message.seq === message.view.seq, {
      message: "Snapshot cursor must match view cursor",
    }),
  z
    .object({
      type: z.literal("events"),
      subscriptionId: z.string(),
      afterSeq: seq,
      throughSeq: seq,
      events: z.array(DeliveryEvent),
    })
    .refine(
      (message) => {
        let previous = message.afterSeq;
        if (message.throughSeq < previous) return false;
        for (const event of message.events) {
          if ((event.firstSeq ?? event.seq) <= previous || event.seq > message.throughSeq)
            return false;
          previous = event.seq;
        }
        return true;
      },
      { message: "Events must be ordered inside the declared coverage interval" },
    ),
  z
    .object({
      type: z.literal("progress"),
      subscriptionId: z.string(),
      afterSeq: seq,
      throughSeq: seq,
    })
    .refine((message) => message.throughSeq >= message.afterSeq, {
      message: "Progress must not move backwards",
    }),
  CommandResult.extend({ type: z.literal("commandResult") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({
    type: z.literal("output.data"),
    requestId: z.string(),
    streamId: z.string(),
    offset: seq,
    nextOffset: seq,
    bytes: z.string(),
    eof: z.boolean(),
  }),
  ItemsPage.extend({ type: z.literal("items.page"), requestId: z.string() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type EventBatch = Extract<ServerMessage, { type: "events" }>;
export type Progress = Extract<ServerMessage, { type: "progress" }>;
