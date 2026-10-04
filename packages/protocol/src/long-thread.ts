import { z } from "zod";
import { AgentId, ItemId, ThreadId, Timestamp } from "./ids.ts";
import { Item } from "./items.ts";
import { ThreadStatus } from "./thread.ts";
import { ToolKind } from "./tools.ts";
import { SearchSnippet } from "./search.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ordinal = count.positive();
const requestId = z.string().min(1).max(256);
const preview = z.string().max(1024);

export const TurnDigest = z.object({
  toolCounts: z.partialRecord(ToolKind, count),
  files: z
    .array(
      z.object({ path: z.string().max(4096), added: count.nullable(), removed: count.nullable() }),
    )
    .max(64),
  commands: z
    .array(
      z.object({
        itemId: ItemId,
        command: preview,
        failed: z.boolean(),
        exitCode: z.number().int().nullable().optional(),
      }),
    )
    .max(64),
  commandsRun: count,
  commandsFailed: count,
  approvalsAsked: count,
  approvalsAnswered: count,
  approvalsAutoReviewed: count,
  approvalsPending: count,
  subagentsStarted: count,
  subagentsFinished: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  errors: count,
  truncated: z.boolean(),
});
export type TurnDigest = z.infer<typeof TurnDigest>;
export const TurnSubagentSummary = z.object({
  agentId: AgentId,
  threadId: ThreadId.optional(),
  name: preview.optional(),
  status: ThreadStatus,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  digest: TurnDigest,
});
export type TurnSubagentSummary = z.infer<typeof TurnSubagentSummary>;
export const TurnSummary = z.object({
  threadId: ThreadId,
  ordinal,
  startSeq: count,
  endSeq: count,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  status: ThreadStatus,
  outcome: z.enum(["active", "completed", "interrupted", "failed"]),
  initiatingMessagePreview: preview,
  latestAgentMessagePreview: preview,
  digest: TurnDigest,
  subagents: z.array(TurnSubagentSummary).max(32),
  subagentsTruncated: z.boolean(),
});
export type TurnSummary = z.infer<typeof TurnSummary>;
export const TurnsPageRequest = z
  .object({
    type: z.literal("turns.page"),
    requestId,
    threadId: ThreadId,
    before: ordinal.optional(),
    after: ordinal.optional(),
    limit: count.min(1).max(100).default(50),
  })
  .refine((input) => input.before === undefined || input.after === undefined)
  .meta({ "x-ace-constraint": "At most one exclusive ordinal cursor, before or after." });
export type TurnsPageRequest = z.infer<typeof TurnsPageRequest>;
export const TurnsPageResponse = z.object({
  type: z.literal("turns.page"),
  requestId,
  threadId: ThreadId,
  seq: count,
  indexedSeq: count,
  ready: z.boolean(),
  turns: z.array(TurnSummary).max(100),
  before: ordinal.nullable(),
  after: ordinal.nullable(),
});
export type TurnsPageResponse = z.infer<typeof TurnsPageResponse>;

export const ItemsWindowRequest = z
  .object({
    type: z.literal("items.window"),
    requestId,
    threadId: ThreadId,
    aroundSeq: count.optional(),
    turnOrdinal: ordinal.optional(),
    before: count.max(199).default(50),
    after: count.max(199).default(50),
  })
  .refine((input) => (input.aroundSeq === undefined) !== (input.turnOrdinal === undefined))
  .refine((input) => input.before + input.after < 200)
  .meta({
    "x-ace-constraint": "Exactly one target; before + after + target is at most 200 items.",
  });
export type ItemsWindowRequest = z.infer<typeof ItemsWindowRequest>;
export const ItemsWindowResponse = z.object({
  type: z.literal("items.window"),
  requestId,
  threadId: ThreadId,
  seq: count,
  targetSeq: count.nullable(),
  items: z.array(Item).max(200),
  itemSeqs: z.record(z.string(), count.positive()),
  itemsBefore: count.positive().nullable(),
  itemsAfter: count.positive().nullable(),
});
export type ItemsWindowResponse = z.infer<typeof ItemsWindowResponse>;

export const ThreadSearchRequest = z.object({
  type: z.literal("thread.search"),
  requestId,
  threadId: ThreadId,
  text: z.string().min(1).max(512),
  scope: z.enum(["thread", "tree"]).default("thread"),
  filter: z.enum(["messages", "tool_output", "commands", "files", "errors"]).optional(),
  limit: count.min(1).max(100).default(30),
  cursor: z.string().min(1).max(2048).optional(),
});
export type ThreadSearchRequest = z.infer<typeof ThreadSearchRequest>;
export const ThreadSearchResponse = z.object({
  type: z.literal("thread.search"),
  requestId,
  threadId: ThreadId,
  hits: z
    .array(
      z.object({
        threadId: ThreadId,
        itemId: ItemId,
        seq: count,
        turnOrdinal: ordinal.nullable(),
        snippet: SearchSnippet,
      }),
    )
    .max(100),
  cursor: z.string().max(2048).nullable(),
  indexedSeq: count,
  headSeq: count,
  pending: count,
  ready: z.boolean(),
});
export type ThreadSearchResponse = z.infer<typeof ThreadSearchResponse>;

export const ThreadCatchUpRequest = z
  .object({
    type: z.literal("thread.catchUp"),
    requestId,
    threadId: ThreadId,
    sinceSeq: count.optional(),
    sinceTime: Timestamp.optional(),
  })
  .refine((input) => (input.sinceSeq === undefined) !== (input.sinceTime === undefined))
  .meta({ "x-ace-constraint": "Exactly one of sinceSeq or sinceTime is required." });
export type ThreadCatchUpRequest = z.infer<typeof ThreadCatchUpRequest>;
export const ThreadCatchUpResponse = z.object({
  type: z.literal("thread.catchUp"),
  requestId,
  threadId: ThreadId,
  seq: count,
  indexedSeq: count,
  ready: z.boolean(),
  turnsCompleted: count,
  status: ThreadStatus,
  digest: TurnDigest,
  latestAgentMessagePreview: preview,
});
export type ThreadCatchUpResponse = z.infer<typeof ThreadCatchUpResponse>;
export const ThreadReadStateRequest = z.object({
  type: z.literal("thread.readState"),
  requestId,
  threadId: ThreadId,
});
export type ThreadReadStateRequest = z.infer<typeof ThreadReadStateRequest>;
export const ThreadReadStateResponse = z.object({
  type: z.literal("thread.readState"),
  requestId,
  threadId: ThreadId,
  lastSeenSeq: count,
  updatedAt: Timestamp.nullable(),
});
export type ThreadReadStateResponse = z.infer<typeof ThreadReadStateResponse>;
/** The core stream carries this command; it lives apart so the core skips the long-thread reads. */
export { ThreadMarkReadCommand } from "./thread-mark-read.ts";
