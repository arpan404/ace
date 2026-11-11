import { HtmlVisualization } from "./html.ts";
import { SharedImage } from "./image-share.ts";
import { CatalogMention } from "./extension-catalog.ts";
import { StepMeasurement } from "./interaction-measurement.ts";
import { ProviderErrorDetails } from "./provider-error-details.ts";
import { ThreadStatus } from "./thread-status.ts";
import { DelegationOutcome } from "./agent-control.ts";
import { AgentMachine } from "./agent.ts";
import {
  MergedForkContext,
  ExecutionSource,
  HandoffModel,
  InheritedItem,
} from "./thread-transitions.ts";
import { Attachment } from "./context.ts";
import { z } from "zod";
import { AgentId, CommandId, InteractionId, ItemId, RunId, ThreadId, Timestamp } from "./ids.ts";
import { ProviderKind, RawPayload } from "./provider.ts";
import { ToolCall } from "./tools.ts";

/**
 * Where a text's whole value lives when the text carried beside it may be a preview. `bytes` is
 * the whole stream's length. `offset` is where the carried text starts in it (both UTF-16LE
 * bytes): absent, the text is the stream's head. A text that ends at `bytes` holds the stream's
 * tail, so deltas extend it; any other text is left as sent while `bytes` counts on.
 */
export const TextSource = z.object({
  streamId: z.string().min(1),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  encoding: z.literal("utf-16le"),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type TextSource = z.infer<typeof TextSource>;

export const ContentPart = z.discriminatedUnion("type", [
  CatalogMention,
  z.object({ type: z.literal("text"), text: z.string(), source: TextSource.optional() }),
  z.object({ type: z.literal("image"), mimeType: z.string(), url: z.string() }),
  z.object({
    type: z.literal("file"),
    path: z.string(),
    mimeType: z.string().optional(),
    name: z.string().max(255).optional(),
    /** Bounded native document/resource data prepared by the daemon. */
    content: z
      .discriminatedUnion("encoding", [
        z.object({ encoding: z.literal("base64"), data: z.string().max(44 * 1024 * 1024) }),
        z.object({ encoding: z.literal("text"), data: z.string().max(128 * 1024) }),
      ])
      .optional(),
  }),
]);
export type ContentPart = z.infer<typeof ContentPart>;

/** Provenance of provider input, retained on its canonical transcript item. */
export const MessageOrigin = z.object({
  kind: z.enum([
    "person",
    "interaction_answer",
    "subagent_result",
    "handoff",
    "spawn",
    "parent_agent",
    "restart",
    "limit_resume",
    "queue",
    "steer",
    "automation",
    "schedule",
    "background_completion",
  ]),
  /**
   * A `person` message an outside MCP client sent for the person (ADR 0122). Older clients
   * ignore it and read the message as the person's own.
   */
  client: z
    .object({ grantId: z.string().min(1).max(128), name: z.string().min(1).max(256) })
    .optional(),
  commandId: CommandId.optional(),
  interactionId: InteractionId.optional(),
  threadIds: z.array(ThreadId).optional(),
  /** `spawn`, `parent_agent`: the thread whose agent sent this message, on this machine. */
  parentThreadId: ThreadId.optional(),
  role: z.string().optional(),
  /**
   * A switch or handoff: the model it came from. `spawn`, `parent_agent`: the sending agent's
   * provider (and model), so the transcript can name who sent it.
   */
  from: z.object({ provider: ProviderKind, model: z.string().optional() }).optional(),
  to: z.object({ provider: ProviderKind, model: z.string().optional() }).optional(),
  /** A context handoff: every model whose work the new agent received, oldest first. */
  sources: z.array(HandoffModel).max(8).optional(),
  lossy: z.boolean().optional(),
  /** A `restart` continuation resuming a turn its provider dropped on its own, not a restart. */
  afterExit: z.boolean().optional(),
});
export type MessageOrigin = z.infer<typeof MessageOrigin>;

const ItemBase = z.object({
  id: ItemId,
  agentId: AgentId,
  runId: RunId.optional(),
  createdAt: Timestamp,
  /** Exact inclusive native fork boundary, only when the adapter can establish it. */
  nativeId: z.string().max(256).optional(),
  executionSource: ExecutionSource.optional(),
  /** False while the provider is still streaming into this item. Omitted on the wire when true. */
  complete: z.boolean().default(true),
  /** The source thread's, in a fork: ace's copy of its message, or a turn its provider brought. */
  inherited: InheritedItem.optional(),
});

/** Agent-owned transcript entries always identify their owner. */
export const AgentItem = z.discriminatedUnion("type", [
  ItemBase.extend({
    type: z.literal("html"),
    visualization: HtmlVisualization,
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({
    type: z.literal("image"),
    image: SharedImage,
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({
    type: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    parts: z.array(ContentPart),
    /** Thread-scoped content ids, resolved by this item's daemon connection. */
    attachments: z.array(Attachment).max(64).optional(),
    /** Message ace did not send itself: task notifications, injected results. */
    synthetic: z.boolean().default(false),
    origin: MessageOrigin.optional(),
    notAnswered: z.literal("stopped").optional(),
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
    /** Set when the child runs on another paired machine; its thread lives there (ADR 0078). */
    machine: AgentMachine.optional(),
    raw: z.array(RawPayload).default([]),
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
  ItemBase.extend({
    type: z.literal("tool_call"),
    call: ToolCall,
    measurement: StepMeasurement.optional(),
  }),
  ItemBase.extend({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    commandId: CommandId.optional(),
    interactionId: InteractionId.optional(),
    code: z.string().optional(),
    /** Adapter evidence; visible only when its code has reviewed user copy. */
    diagnostic: z.boolean().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    details: ProviderErrorDetails.optional(),
    /** Native history output linked to its canonical call. */
    toolCallId: ItemId.optional(),
    /** Uncorrelated daemon measurement, retained rather than discarded. */
    measurement: StepMeasurement.optional(),
    text: z.string(),
    source: TextSource.optional(),
    raw: z.array(RawPayload).default([]),
  }),
  ItemBase.extend({
    type: z.literal("compaction"),
    tokensBefore: z.number().int().optional(),
    tokensAfter: z.number().int().optional(),
    /**
     * The summary the provider wrote for the model to continue from. Provider-internal text:
     * shown only inside the compaction's own row, never as a message.
     */
    summary: z.string().optional(),
    /** The provider's own compaction frames, kept as they came. */
    raw: z.array(RawPayload).default([]),
  }),
]);
export type AgentItem = z.infer<typeof AgentItem>;

/** Thread entries also include browser artifacts created before an agent starts. */
export const Item = z.discriminatedUnion("type", [
  ...AgentItem.options,
  ItemBase.extend({
    type: z.literal("unknown"),
    raw: z.array(RawPayload).default([]),
    data: z.unknown(),
  }),
  ItemBase.extend({
    type: z.literal("artifact"),
    filename: z.string().max(256).optional(),
    flags: z.array(z.enum(["executable", "archive"])).optional(),
    /** Thread artifacts can exist before the first agent starts. */
    agentId: AgentId.optional(),
    source: z.enum(["browser", "device"]),
    artifactId: z.string().min(1).max(256).optional(),
    path: z.string(),
    mimeType: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
]);
export type Item = z.infer<typeof Item>;
