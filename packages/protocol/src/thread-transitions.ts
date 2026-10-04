import { NativeSessionId } from "./ids.ts";
import { z } from "zod";
import { AgentId, ItemId, RunId, ThreadId, Timestamp } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

export const ForkPoint = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn"), runId: RunId }),
  z.object({ type: z.literal("item"), itemId: ItemId }),
]);
export type ForkPoint = z.infer<typeof ForkPoint>;
export const ThreadLineage = z.object({
  parentThreadId: ThreadId,
  parentAgentId: AgentId,
  point: ForkPoint,
  mode: z.enum(["native", "portable"]),
  lossy: z.boolean(),
});
export type ThreadLineage = z.infer<typeof ThreadLineage>;
export const ExecutionOptions = z
  .record(
    z.string().max(128),
    z.union([z.string().max(1024), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 32)
  .meta({ "x-ace-constraint": "At most 32 provider option entries." });
export type ExecutionOptions = z.infer<typeof ExecutionOptions>;
export const ExecutionSelection = z.object({
  provider: ProviderKind,
  model: z.string().min(1).max(256).optional(),
  instanceId: z.string().min(1).max(256).optional(),
  options: ExecutionOptions.default({}),
});
export type ExecutionSelection = z.infer<typeof ExecutionSelection>;
export const ExecutionSource = z.object({
  nativeSessionId: NativeSessionId,
  selection: ExecutionSelection,
});
export type ExecutionSource = z.infer<typeof ExecutionSource>;
export const ThreadSwitch = z.object({
  selection: ExecutionSelection,
  state: z.enum(["queued", "applied", "failed"]),
  lossy: z.boolean(),
  recommendation: z.literal("delegate_task").optional(),
  error: z.string().max(2048).optional(),
  at: Timestamp,
});
export type ThreadSwitch = z.infer<typeof ThreadSwitch>;
export const HandoffCitation = z.object({ threadId: ThreadId, itemId: ItemId });
export type HandoffCitation = z.infer<typeof HandoffCitation>;
export const MergedForkContext = z.object({
  sourceThreadId: ThreadId,
  summary: z.string().min(1).max(16384),
  citations: z.array(HandoffCitation).min(1).max(100),
  patchApplied: z.boolean(),
});
export type MergedForkContext = z.infer<typeof MergedForkContext>;
export const PortableHandoff = z.object({
  version: z.literal(1),
  sourceThreadId: ThreadId,
  origin: z
    .object({ provider: ProviderKind, backend: z.string().min(1).max(256).optional() })
    .optional(),
  throughSeq: z.number().int().nonnegative(),
  lossy: z.literal(true),
  policy: z.literal("recent-complete-items"),
  excerpts: z.array(z.object({ citation: HandoffCitation, text: z.string().max(8192) })).max(200),
  omittedItems: z.number().int().nonnegative(),
  history: z.object({
    type: z.literal("items.page"),
    tool: z.literal("ace_read_handoff").default("ace_read_handoff"),
    chunkTool: z.literal("ace_read_handoff_chunk").default("ace_read_handoff_chunk"),
    threadId: ThreadId,
    before: z.number().int().positive(),
    limit: z.literal(50),
  }),
  limitations: z.literal(
    "Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments.",
  ),
});
export type PortableHandoff = z.infer<typeof PortableHandoff>;
export const TransitionCommands = [
  z.object({
    type: z.literal("thread.fork"),
    threadId: ThreadId,
    point: ForkPoint,
    title: z.string().max(256).optional(),
    selection: ExecutionSelection.optional(),
    input: z.string().min(1).max(16384),
    budgetBytes: z.number().int().min(2048).max(65536).default(16384),
  }),
  z.object({
    type: z.literal("thread.merge"),
    threadId: ThreadId,
    summary: z.string().min(1).max(16384),
    citations: z.array(HandoffCitation).min(1).max(100),
    patch: z
      .string()
      .min(1)
      .max(65536)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 65536)
      .meta({ "x-ace-constraint": "Patch is at most 65536 encoded UTF-8 bytes." })
      .optional(),
  }),
  z.object({
    type: z.literal("thread.switch"),
    threadId: ThreadId,
    selection: ExecutionSelection.omit({ options: true }).extend({
      options: ExecutionOptions.optional(),
    }),
  }),
] as const;

export const ThreadTransitionView = z.object({
  lineage: ThreadLineage.optional(),
  execution: ExecutionSelection.optional(),
  switch: ThreadSwitch.optional(),
});
