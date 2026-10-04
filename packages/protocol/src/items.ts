import { ThreadStatus } from "./thread-status.ts";
import { ThreadId } from "./ids.ts";
import { DelegationOutcome } from "./agent-control.ts";
import { MergedForkContext, ExecutionSource } from "./thread-transitions.ts";
import { z } from "zod";
import { AgentId, ItemId, RunId, Timestamp } from "./ids.ts";
import { ProviderKind, RawPayload } from "./provider.ts";
import { ToolCall } from "./tools.ts";

export const TextSource = z.object({
  streamId: z.string().min(1),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  encoding: z.literal("utf-16le"),
});
export type TextSource = z.infer<typeof TextSource>;

export const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), source: TextSource.optional() }),
  z.object({ type: z.literal("image"), mimeType: z.string(), url: z.string() }),
  z.object({ type: z.literal("file"), path: z.string(), mimeType: z.string().optional() }),
]);
export type ContentPart = z.infer<typeof ContentPart>;

const ItemBase = z.object({
  id: ItemId,
  agentId: AgentId,
  runId: RunId.optional(),
  createdAt: Timestamp,
  /** Exact inclusive native fork boundary, only when the adapter can establish it. */
  nativeId: z.string().max(256).optional(),
  executionSource: ExecutionSource.optional(),
  /** False while the provider is still streaming into this item. */
  complete: z.boolean(),
});

/** Agent-owned transcript entries always identify their owner. */
export const AgentItem = z.discriminatedUnion("type", [
  ItemBase.extend({
    type: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    parts: z.array(ContentPart),
    /** Message ace did not send itself: task notifications, injected results. */
    synthetic: z.boolean().default(false),
    mergedContext: MergedForkContext.optional(),
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({
    type: z.literal("delegation.started"),
    origin: z.literal("ace"),
    childThreadId: ThreadId,
    provider: ProviderKind,
    model: z.string().min(1).max(256).optional(),
    accountId: z.string().min(1).max(256).optional(),
    title: z.string().max(256),
    role: z.string().max(1024),
    phase: z.enum(["created", "running", "cancelling", "settled"]),
    status: ThreadStatus,
    updatedAt: Timestamp,
    generation: z.number().int().nonnegative(),
    outcome: DelegationOutcome.nullable().default(null),
  }),
  ItemBase.extend({
    type: z.literal("delegation.settled"),
    origin: z.literal("ace"),
    results: z.array(DelegationOutcome).min(1).max(64),
    delivery: z.enum(["tool", "ace-input"]),
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    source: TextSource.optional(),
    /** Provider only exposes a summary of the reasoning. */
    summary: z.boolean().default(false),
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({ type: z.literal("tool_call"), call: ToolCall }),
  ItemBase.extend({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    /** Native history output linked to its canonical call. */
    toolCallId: ItemId.optional(),
    text: z.string(),
    source: TextSource.optional(),
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({
    type: z.literal("compaction"),
    tokensBefore: z.number().int().optional(),
    tokensAfter: z.number().int().optional(),
  }),
]);
export type AgentItem = z.infer<typeof AgentItem>;

/** Thread entries also include browser artifacts created before an agent starts. */
export const Item = z.discriminatedUnion("type", [
  ...AgentItem.options,
  ItemBase.extend({
    type: z.literal("artifact"),
    /** Thread artifacts can exist before the first agent starts. */
    agentId: AgentId.optional(),
    source: z.literal("browser"),
    path: z.string(),
    mimeType: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
]);
export type Item = z.infer<typeof Item>;
