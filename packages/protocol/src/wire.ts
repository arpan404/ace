import { RegistryRequest, RegistryResult } from "./agent-registry.ts";
import { FilesClientMessage, FilesServerMessage } from "./files.ts";
import {
  CommandsList,
  CommandsResolve,
  CommandsListResult,
  CommandsResolveResult,
} from "./command-library.ts";
import { DiagnosticsHealth } from "./diagnostics.ts";
import { ReviewData } from "./review.ts";
import { z } from "zod";
import { ContextRequest, ContextResult } from "./context.ts";
import {
  HistoryListRequest,
  HistoryListResponse,
  HistoryImportRequest,
  HistoryImportResponse,
  HistoryScanRequest,
  HistoryScanResponse,
  HistoryScanUpdated,
  HistoryContinueRequest,
  HistoryContinueResponse,
} from "./history.ts";
import { McpProviderRequest, McpProviderResult } from "./mcp.ts";
import {
  UsageSummary,
  UsageSeries,
  UsageMessage,
  UsageSessionTotals,
  UsageSessionTotalsMessage,
} from "./usage.ts";
import { AccountsRequest, AccountsResponse } from "./accounts.ts";
import { ScreenClientMessage, ScreenServerMessage } from "./screen.ts";
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
import {
  SearchQueryRequest,
  SearchStatusRequest,
  SearchQueryResponse,
  SearchStatusResponse,
  SearchErrorResponse,
} from "./search.ts";

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
export const ClientMessage = z.discriminatedUnion("type", [
  RegistryRequest,
  ContextRequest,
  SettingsGet,
  SettingsSet,
  SettingsSubscribe,
  HistoryListRequest,
  HistoryImportRequest,
  HistoryScanRequest,
  HistoryContinueRequest,
  McpProviderRequest,
  UsageSummary,
  UsageSeries,
  UsageSessionTotals,
  ...FilesClientMessage.options,
  CommandsList,
  CommandsResolve,
  ...AccountsRequest.options,
  SearchQueryRequest,
  SearchStatusRequest,
  ScreenClientMessage,
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
export type ClientMessage = z.infer<typeof ClientMessage>;
export const CommandResult = z.object({
  commandId: CommandId,
  ok: z.boolean(),
  health: DiagnosticsHealth.optional(),
  error: z.string().optional(),
  review: ReviewData.optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
export const ServerMessage = z.discriminatedUnion("type", [
  RegistryResult,
  ContextResult,
  SettingsResult,
  SettingsChanged,
  SettingsDiagnosticMessage,
  HistoryListResponse,
  HistoryImportResponse,
  HistoryScanResponse,
  HistoryScanUpdated,
  HistoryContinueResponse,
  McpProviderResult,
  UsageMessage,
  UsageSessionTotalsMessage,
  ...FilesServerMessage.options,
  CommandsListResult,
  CommandsResolveResult,
  ...AccountsResponse.options,
  SearchQueryResponse,
  SearchStatusResponse,
  SearchErrorResponse,
  ...ScreenServerMessage.options,
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
export type ServerMessage = z.infer<typeof ServerMessage>;

export type EventBatch = Extract<ServerMessage, { type: "events" }>;
export type Progress = Extract<ServerMessage, { type: "progress" }>;
