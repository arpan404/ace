import { ExecutionOptions } from "./thread-transitions.ts";
import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { ThreadId, Timestamp } from "./ids.ts";

export const TurnOptions = ExecutionOptions;
export type TurnOptions = z.infer<typeof TurnOptions>;
export const ThreadOrganization = z.object({
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  readAt: Timestamp.optional(),
  settledAt: Timestamp.optional(),
  settledReason: z.enum(["manual", "inactivity", "pr_merged", "pr_closed"]).optional(),
  snoozedUntil: Timestamp.optional(),
  deletedAt: Timestamp.optional(),
  /** Last execution activity; organization and metadata refresh do not reset it. */
  activityAt: Timestamp.optional(),
  autoSettleAt: Timestamp.optional(),
});
export type ThreadOrganization = z.infer<typeof ThreadOrganization>;
export const ThreadDetails = z.object({
  workspace: z
    .object({ id: z.string().min(1), name: z.string().max(256), path: z.string().max(4096) })
    .optional(),
  mode: z.enum(["local", "worktree"]).optional(),
  worktree: z.string().max(4096).optional(),
  branch: z.string().max(1024).nullable().optional(),
  head: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable()
    .optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  baseBranch: z.string().max(1024).optional(),
  linkedPr: z
    .object({
      number: z.number().int().positive(),
      state: z.enum(["open", "closed", "merged"]),
      url: z.string().url().max(4096).optional(),
    })
    .nullable()
    .optional(),
  machine: z.object({ host: z.string().min(1).max(256), name: z.string().max(256) }).optional(),
  diff: z
    .object({
      files: z.number().int().nonnegative(),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ThreadDetails = z.infer<typeof ThreadDetails>;
export const ThreadRunMetadata = z.object({
  provider: ProviderKind.optional(),
  model: z.string().max(256).optional(),
  account: z.string().max(256).optional(),
  options: TurnOptions.optional(),
  subagentCount: z.number().int().nonnegative().optional(),
  backgroundTaskCount: z.number().int().nonnegative().optional(),
  /** Providers/queue recovery can publish authoritative context usage here. */
  contextMeter: z
    .object({
      used: z.number().int().nonnegative(),
      limit: z.number().int().positive().nullable(),
      at: Timestamp,
    })
    .optional(),
});
export type ThreadRunMetadata = z.infer<typeof ThreadRunMetadata>;
export const ThreadClientFields = ThreadOrganization.extend({
  details: ThreadDetails.optional(),
  live: ThreadRunMetadata.optional(),
});
export type ThreadClientFields = z.infer<typeof ThreadClientFields>;
export const ThreadClientUpdated = z.object({
  type: z.literal("thread.client.updated"),
  changes: ThreadClientFields.partial().extend({
    settledAt: Timestamp.nullable().optional(),
    settledReason: ThreadOrganization.shape.settledReason.unwrap().nullable().optional(),
    snoozedUntil: Timestamp.nullable().optional(),
    autoSettleAt: Timestamp.nullable().optional(),
  }),
});
export type ThreadClientUpdated = z.infer<typeof ThreadClientUpdated>;
export const ThreadOrganizationCommands = [
  z.object({
    type: z.literal("thread.rename"),
    threadId: ThreadId,
    title: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0)
      .meta({
        "x-ace-constraint":
          "Must contain a non-whitespace title. The daemon trims surrounding whitespace.",
      }),
  }),
  z.object({ type: z.literal("thread.unarchive"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.delete"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.pin"), threadId: ThreadId, pinned: z.boolean() }),
  z.object({ type: z.literal("thread.read"), threadId: ThreadId, unread: z.boolean() }),
  z.object({ type: z.literal("thread.settle"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.unsettle"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.snooze"), threadId: ThreadId, until: Timestamp.nullable() }),
] as const;
