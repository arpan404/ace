import { NativeSessionId } from "./ids.ts";
import { z } from "zod";
import { AgentId, ItemId, RunId, ThreadId, Timestamp } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { MessageContext } from "./context.ts";
import { MessageText } from "./message-limits.ts";
import { AcpIdentity } from "./agent-registry.ts";

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
/** Switches stored before the rename still carry "delegate_task"; they read as "delegate". */
const SwitchRecommendation = z
  .enum(["delegate", "delegate_task"])
  .transform((): "delegate" => "delegate")
  .meta({
    "x-ace-json-input": z.enum(["delegate", "delegate_task"]),
    "x-ace-constraint": 'The stored legacy value "delegate_task" decodes as "delegate".',
  });
export const ThreadSwitch = z.object({
  selection: ExecutionSelection,
  state: z.enum(["queued", "applied", "failed"]),
  lossy: z.boolean(),
  recommendation: SwitchRecommendation.optional(),
  error: z.string().max(2048).optional(),
  at: Timestamp,
});
export type ThreadSwitch = z.infer<typeof ThreadSwitch>;
export const HandoffCitation = z.object({ threadId: ThreadId, itemId: ItemId });
export type HandoffCitation = z.infer<typeof HandoffCitation>;
/** A provider and model whose work a context handoff carries, or the one it hands to. */
export const HandoffModel = z.object({
  provider: ProviderKind,
  model: z.string().min(1).max(256).optional(),
});
export type HandoffModel = z.infer<typeof HandoffModel>;
/**
 * A message a fork opens on that belongs to the thread it was forked from: ace's copy of the
 * source `itemId` as it read at the fork point, or (without `itemId`) a turn the provider's own
 * fork brought along. `at` is when it was said in the source.
 */
export const InheritedItem = z.object({
  threadId: ThreadId,
  itemId: ItemId.optional(),
  at: Timestamp.optional(),
});
export type InheritedItem = z.infer<typeof InheritedItem>;
export const MergedForkContext = z.object({
  sourceThreadId: ThreadId,
  summary: MessageText,
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
  /**
   * `conversation-first` keeps the latest ask and answer and the thread's opening ask before
   * older items, and leaves out reasoning and earlier handoffs. Older manifests read as stored.
   */
  policy: z.enum(["recent-complete-items", "conversation-first"]),
  /** The distinct models whose work the carried history holds, oldest first. */
  sources: z.array(HandoffModel).max(8).optional(),
  /**
   * A return to a provider that resumes its own earlier session: the excerpts cover only what
   * happened after this event cutoff, which that session already holds everything before.
   */
  since: z.number().int().nonnegative().optional(),
  excerpts: z.array(z.object({ citation: HandoffCitation, text: z.string().max(8192) })).max(200),
  omittedItems: z.number().int().nonnegative(),
  history: z.object({
    type: z.literal("items.page"),
    tool: z.literal("handoff_read").default("handoff_read"),
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
    input: MessageText,
    /**
     * What goes with the first message, as `thread.send` carries it. Attachments name files the
     * source thread holds; the fork gets its own reference to them before delivery.
     */
    context: MessageContext.optional(),
    budgetBytes: z.number().int().min(2048).max(65536).default(16384),
  }),
  z.object({
    type: z.literal("thread.merge"),
    threadId: ThreadId,
    summary: MessageText,
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
      /**
       * The ACP agent a switch moves to, with `instanceId` its account. Required to enter an
       * ACP agent or change to another one; a model change within the agent may omit it.
       */
      acpAgentId: AcpIdentity.shape.acpAgentId.optional(),
      installationId: AcpIdentity.shape.installationId.optional(),
    }),
  }),
] as const;

/**
 * The thread whose agent delegated this one through ace. Fields carrying it are optional: threads
 * stored before it existed, and threads a person started, have none.
 */
export const DelegatedBy = ThreadId.meta({
  description: "The thread whose agent delegated this one through ace.",
});
/**
 * A delegated child admitted while its parent's run slots were full: what it was asked, kept on
 * the thread so it reads as queued with its task until a slot frees and it starts.
 */
export const QueuedLaunch = z.object({ text: z.string() });
export type QueuedLaunch = z.infer<typeof QueuedLaunch>;
export const ThreadTransitionView = z.object({
  lineage: ThreadLineage.optional(),
  delegatedBy: DelegatedBy.optional(),
  queuedLaunch: QueuedLaunch.optional(),
  execution: ExecutionSelection.optional(),
  switch: ThreadSwitch.optional(),
});
