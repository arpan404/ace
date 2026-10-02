import { z } from "zod";
import { AgentId, ItemId, RunId, Timestamp } from "./ids.ts";
import { RawPayload } from "./provider.ts";
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
  /** False while the provider is still streaming into this item. */
  complete: z.boolean(),
});

/** One entry in an agent's transcript. */
export const Item = z.discriminatedUnion("type", [
  ItemBase.extend({
    type: z.literal("message"),
    role: z.enum(["user", "assistant"]),
    parts: z.array(ContentPart),
    /** Message ace did not send itself: task notifications, injected results. */
    synthetic: z.boolean().default(false),
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
export type Item = z.infer<typeof Item>;
