import { z } from "zod";
import { Agent } from "./agent.ts";
import { BackgroundTask } from "./background.ts";
import { Command } from "./commands.ts";
import { ContextMeter } from "./context-meter.ts";
import { DiagnosticsHealth } from "./diagnostics.ts";
import { Event, UsageUpdated } from "./events.ts";
import { ForgePrRef, ForgePrStatus } from "./forge.ts";
import { CommandId, DeviceId, HostId, ThreadId } from "./ids.ts";
import { Interaction } from "./interactions.ts";
import { Item } from "./items.ts";
import { QueueState } from "./queue.ts";
import { ReviewData } from "./review.ts";
import { Run, Thread } from "./thread.ts";
import { EditorLaunch } from "./workspace-actions.ts";

/*
 * The stream every client needs from its first frame (ADR 0042): hello and welcome,
 * subscriptions with their snapshots, events and progress, commands and their results, item
 * pages and output reads. `wire.ts` adds the service families to make the full `ClientMessage`
 * and `ServerMessage`; a client can decode this core alone and load the rest when it needs them.
 */

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
    .transform((entries) => Object.fromEntries<T>(entries))
    .meta({
      "x-ace-json-input": z.record(z.string(), schema),
      "x-ace-constraint":
        "Plain JSON object with every own opaque ID, including __proto__, validated and retained.",
    });
export const ThreadView = z.object({
  queue: QueueState.optional(),
  contextMeters: records(ContextMeter).optional(),
  kind: z.literal("thread"),
  seq,
  thread: Thread,
  agents: records(Agent),
  agentChildren: records(z.array(z.string())),
  runs: records(Run),
  items: records(Item),
  itemOrder: z.array(z.string()),
  /** Creation cursors for the bounded item window, independent of live update sequence. */
  itemSeqs: records(seq.positive()).optional(),
  /** Exclusive item creation-sequence cursor for older history. */
  itemsBefore: seq.positive().nullable().default(null),
  interactions: records(Interaction),
  backgroundTasks: records(BackgroundTask),
  usage: records(UsageUpdated),
  /** Inclusive snapshots are independent of per-agent activity. */
  usageSnapshots: records(UsageUpdated).default({}),
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
export const ItemsPage = z.object({
  seq,
  threadId: ThreadId,
  items: z.array(Item).max(200),
  itemSeqs: records(seq.positive()).optional(),
  itemsBefore: seq.positive().nullable(),
});
export type ItemsPage = z.infer<typeof ItemsPage>;
export const CommandResult = z.object({
  threadId: ThreadId.optional(),
  commandId: CommandId,
  ok: z.boolean(),
  forkThreadId: ThreadId.optional(),
  health: DiagnosticsHealth.optional(),
  error: z.string().optional(),
  review: ReviewData.optional(),
  pr: ForgePrRef.optional(),
  prStatus: ForgePrStatus.optional(),
  editor: EditorLaunch.optional(),
  terminalId: z.string().min(1).max(128).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
/** The core client messages, in the order the full `ClientMessage` lists them. */
export const CoreClientMessage = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      channel: z.enum(["files", "devices", "browser", "screen"]).optional(),
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
export type CoreClientMessage = z.infer<typeof CoreClientMessage>;
/** The core server messages, in the order the full `ServerMessage` lists them. */
export const CoreServerMessage = z.discriminatedUnion("type", [
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
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    subscriptionId: z.string().optional(),
  }),
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
export type CoreServerMessage = z.infer<typeof CoreServerMessage>;
/** `type` of every core client message. */
export const coreClientTypes: ReadonlySet<string> = new Set([
  "hello",
  "subscribe",
  "unsubscribe",
  "command",
  "output.read",
  "items.page",
  "ping",
]);
/** `type` of every core server message. */
export const coreServerTypes: ReadonlySet<string> = new Set([
  "welcome",
  "snapshot",
  "events",
  "progress",
  "commandResult",
  "error",
  "output.data",
  "items.page",
  "pong",
]);
