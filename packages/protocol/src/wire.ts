import { z } from "zod";
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

const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const records = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema);
export const ThreadView = z.object({
  kind: z.literal("thread"),
  seq,
  thread: Thread,
  agents: records(Agent),
  agentChildren: records(z.array(z.string())),
  runs: records(Run),
  items: records(Item),
  itemOrder: z.array(z.string()),
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
export const DeliveryEvent = Event.extend({ seq, firstSeq: seq.positive().optional() })
  .refine(
    (event) =>
      event.firstSeq === undefined ||
      (event.payload.type === "item.delta" && event.firstSeq <= event.seq),
  )
  .meta({ "x-ace-constraint": "firstSeq is allowed only on item.delta and must be <= seq." });
export type DeliveryEvent = z.infer<typeof DeliveryEvent>;
export const ClientMessage = z.discriminatedUnion("type", [
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
    })
    .meta({ "x-ace-constraint": "Exactly one of token and ticket is required." }),
  z.object({
    type: z.literal("subscribe"),
    subscriptionId: z.string().min(1),
    scope: SubscriptionScope,
    afterSeq: seq.optional(),
  }),
  z.object({ type: z.literal("unsubscribe"), subscriptionId: z.string().min(1) }),
  z.object({ type: z.literal("command"), command: Command }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export const CommandResult = z.object({
  commandId: CommandId,
  ok: z.boolean(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
export const ServerMessage = z.discriminatedUnion("type", [
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
    })
    .meta({ "x-ace-constraint": "seq must equal view.seq." }),
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
    )
    .meta({
      "x-ace-constraint":
        "throughSeq >= afterSeq; events are ordered with (firstSeq ?? seq) > previous seq and seq <= throughSeq.",
    }),
  z
    .object({
      type: z.literal("progress"),
      subscriptionId: z.string(),
      afterSeq: seq,
      throughSeq: seq,
    })
    .refine((message) => message.throughSeq >= message.afterSeq, {
      message: "Progress must not move backwards",
    })
    .meta({ "x-ace-constraint": "throughSeq must be >= afterSeq." }),
  CommandResult.extend({ type: z.literal("commandResult") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export type EventBatch = Extract<ServerMessage, { type: "events" }>;
export type Progress = Extract<ServerMessage, { type: "progress" }>;
