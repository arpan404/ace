import { WorktreeCreationProgress } from "./worktree-creation.ts";
import { DeckOwnership } from "./deck-ownership.ts";
import { ExecutionOptions } from "./thread-transitions.ts";
import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { ThreadId, Timestamp } from "./ids.ts";
import { ForgeRepository } from "./forge.ts";
import { WorktreeBaseRecord } from "./worktree-base.ts";

export const TurnOptions = ExecutionOptions;
export type TurnOptions = z.infer<typeof TurnOptions>;
/** A pinned thread's place among the pinned ones: higher sorts first. */
const PinOrder = z
  .number()
  .finite()
  .describe(
    "Place among pinned threads, higher first. Set on pin (the daemon's clock when the command names none, so a new pin leads) and cleared on unpin.",
  );
export const ThreadOrganization = z.object({
  pinned: z.boolean().optional(),
  pinOrder: PinOrder.optional(),
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
  /** Completed creation timings and redacted log survive reloads on the admitted thread. */
  worktreeCreation: WorktreeCreationProgress.optional(),
  workspaceChange: z
    .object({
      commandId: z.string().min(1).max(256),
      state: z.enum(["preparing", "applied", "failed"]),
      at: Timestamp,
      error: z.string().max(128).optional(),
      lossy: z.boolean().default(true),
      uncertain: z.boolean().optional(),
    })
    .optional(),
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
  /** The base the worktree was made from, with whether a remote base was fetched first. */
  base: WorktreeBaseRecord.optional(),
  /** The forge repository behind the checkout's origin remote, for `forge.pr.create`. */
  repository: ForgeRepository.optional(),
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
  deck: DeckOwnership.optional(),
  details: ThreadDetails.optional(),
  live: ThreadRunMetadata.optional(),
});
export type ThreadClientFields = z.infer<typeof ThreadClientFields>;
export const ThreadClientUpdated = z.object({
  type: z.literal("thread.client.updated"),
  changes: ThreadClientFields.partial().extend({
    pinOrder: PinOrder.nullable().optional(),
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
  z.object({ type: z.literal("thread.delete"), threadId: ThreadId, force: z.boolean().optional() }),
  z.object({
    type: z.literal("thread.pin"),
    threadId: ThreadId,
    pinned: z.boolean(),
    /**
     * Where a pinned thread sits among the pinned ones (higher first), so a client can reorder
     * them. Absent: a new pin leads, and an already pinned thread keeps its place.
     */
    order: PinOrder.optional(),
  }),
  z.object({ type: z.literal("thread.read"), threadId: ThreadId, unread: z.boolean() }),
  z.object({ type: z.literal("thread.settle"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.unsettle"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.snooze"), threadId: ThreadId, until: Timestamp.nullable() }),
] as const;
