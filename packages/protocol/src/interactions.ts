import { ApprovalTarget, PermissionReview } from "./permissions.ts";
import { z } from "zod";
import { AgentId, DeviceId, InteractionId, ItemId, ThreadId, Timestamp } from "./ids.ts";
import { RawPayload } from "./provider.ts";
import { TodoEntry } from "./tools.ts";

export const ApprovalOption = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["allow_once", "allow_session", "allow_always", "deny", "deny_always", "cancel"]),
});
export type ApprovalOption = z.infer<typeof ApprovalOption>;

export const Question = z.object({
  id: z.string(),
  header: z.string().optional(),
  text: z.string(),
  options: z.array(
    z.object({ id: z.string(), label: z.string(), description: z.string().optional() }),
  ),
  multiSelect: z.boolean().default(false),
  /** Free-text answers are accepted. */
  allowOther: z.boolean().default(false),
});
export type Question = z.infer<typeof Question>;

export const InteractionRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    target: ApprovalTarget.optional(),
    title: z.string(),
    description: z.string().optional(),
    options: z.array(ApprovalOption),
    defaultToNo: z.boolean().optional(),
    suppressAlwaysAllowRule: z.boolean().optional(),
    mcpServer: z.object({ name: z.string(), source: z.string() }).passthrough().optional(),
    permissionUpdates: z.array(z.unknown()).optional(),
  }),
  z.object({ kind: z.literal("question"), questions: z.array(Question) }),
  z.object({
    kind: z.literal("plan_review"),
    title: z.string().optional(),
    summary: z.string().optional(),
    markdown: z.string(),
    planPath: z.string().optional(),
    todos: z.array(TodoEntry).optional(),
  }),
  z.object({
    kind: z.literal("elicitation"),
    server: z.string(),
    message: z.string(),
    url: z.string().optional(),
    schema: z.unknown().optional(),
    mode: z.enum(["form", "url"]).optional(),
    nativeId: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  }),
]);
export type InteractionRequest = z.infer<typeof InteractionRequest>;

export const InteractionResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approval"), optionId: z.string(), message: z.string().optional() }),
  z.object({
    kind: z.literal("question"),
    /** Question id → selected option ids, or free text for `allowOther`. */
    answers: z.record(z.string(), z.array(z.string())),
    /** The user declined to answer; the agent continues without answers. */
    dismissed: z.boolean().optional(),
    /** Optional explanation returned to the agent when declining a question. */
    feedback: z.string().max(8192).optional(),
  }),
  z.object({
    kind: z.literal("plan_review"),
    decision: z.enum(["approve", "reject", "cancel"]),
    feedback: z.string().optional(),
  }),
  z.object({
    kind: z.literal("elicitation"),
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.unknown().optional(),
  }),
]);
export type InteractionResolution = z.infer<typeof InteractionResolution>;

export const InteractionState = z.enum([
  "pending",
  "resolved",
  /** The provider withdrew it (turn ended, interrupted). */
  "cancelled",
  /** The provider process that asked is gone; answering is no longer possible. */
  "expired",
]);
export type InteractionState = z.infer<typeof InteractionState>;

export const Interaction = z.object({
  id: InteractionId,
  threadId: ThreadId,
  agentId: AgentId,
  /**
   * Item that prompted this interaction. Adapters create a tool-call item
   * when the provider sends an interaction with no backing item.
   */
  toolCallId: ItemId.optional(),
  /**
   * False for questions the agent asks without a protocol-level request
   * (e.g. Codex async questions, answered with steering input). Pending
   * non-blocking interactions still make the thread `needs_you`.
   */
  blocking: z.boolean(),
  request: InteractionRequest,
  review: PermissionReview.optional(),
  state: InteractionState,
  resolution: InteractionResolution.optional(),
  /** Device that answered first. Later answers are rejected. */
  resolvedBy: DeviceId.optional(),
  /** Explicit canonical automatic review fact; absence means unknown. */
  autoReviewed: z.boolean().optional(),
  createdAt: Timestamp,
  closedAt: Timestamp.optional(),
  raw: z.array(RawPayload).default([]),
});
export type Interaction = z.infer<typeof Interaction>;
