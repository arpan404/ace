import { ForgePrWorkspace } from "./forge-worktree.ts";
import { ForgeIssueRef } from "./forge-issues.ts";
import { ProjectIcon, ProjectKind } from "./projects.ts";
import { MachineIcon } from "./host-identity.ts";
import { WorktreeCreationProgress } from "./worktree-creation.ts";
import { ExecutionOptions } from "./thread-transitions.ts";
import { z } from "zod";
import { ProviderKind } from "./provider.ts";
import { BackgroundTaskId, InteractionId, RunId, ThreadId, Timestamp } from "./ids.ts";
import { ForgeRepository, LinkedPullRequest } from "./forge.ts";
import { WorktreeBaseRecord } from "./worktree-base.ts";
import { ThreadContinuedOn } from "./transfers.ts";

export const TurnOptions = ExecutionOptions;
export type TurnOptions = z.infer<typeof TurnOptions>;
/** A pinned thread's place among the pinned ones: higher sorts first. */
const PinOrder = z
  .number()
  .finite()
  .describe(
    "Place among pinned threads, higher first. Set on pin (the daemon's clock when the command names none, so a new pin leads) and cleared on unpin.",
  );
/** A thread's place in the Home list when the person orders it by hand: higher sorts first. */
const ListOrder = z
  .number()
  .finite()
  .describe(
    "Place in the Home list when it is ordered by hand (threads.sortBy manual), higher first. Absent: the thread's creation time stands in, so a new thread leads.",
  );
export const ThreadOrganization = z.object({
  pinned: z.boolean().optional(),
  pinOrder: PinOrder.optional(),
  listOrder: ListOrder.optional(),
  unread: z.boolean().optional(),
  readAt: Timestamp.optional(),
  settledAt: Timestamp.optional(),
  settledReason: z.enum(["manual", "inactivity", "pr_merged", "pr_closed"]).optional(),
  snoozedUntil: Timestamp.optional(),
  deletedAt: Timestamp.optional(),
  /** Last execution activity; organization and metadata refresh do not reset it. */
  activityAt: Timestamp.optional(),
  autoSettleAt: Timestamp.optional(),
  /**
   * False when this thread never settles by itself (inactivity, merged or closed PR); absent
   * means the settings decide. Unsettling a thread by hand turns it off.
   */
  autoSettle: z.literal(false).optional(),
  /**
   * An agent asked to settle this thread while it was still working. It settles once the
   * thread is done; any other outcome (failed, a question for the person) drops the request.
   */
  settleWhenDone: z.literal(true).optional(),
  /**
   * The linked pull request whose merge or close already settled this thread by itself. It
   * never settles it again: a thread the person reopens after that stays open.
   */
  prSettled: z.number().int().positive().optional(),
});
export type ThreadOrganization = z.infer<typeof ThreadOrganization>;
export const ThreadDetails = z.object({
  pullRequestWorkspace: ForgePrWorkspace.optional(),
  linkedIssues: z.array(ForgeIssueRef).max(100).optional(),
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
      /** The requested selection, so a failed change can be retried as it was asked. */
      mode: z.enum(["local", "worktree"]).optional(),
      branch: z.string().max(1024).optional(),
    })
    .optional(),
  /** The thread's checkout folder no longer exists (deleted, or removed by storage cleanup). */
  worktreeMissing: z.boolean().optional(),
  /**
   * The setup script of a worktree made when the thread first ran: `failed` holds the thread's
   * queue until Retry or Continue (`thread.workspace.setup`); `skipped` says it didn't run
   * because the thread's access is Read-only. Absent once setup ran or was continued past.
   */
  worktreeSetup: z
    .object({
      state: z.enum(["failed", "skipped"]),
      reason: z.literal("read_only").optional(),
      /** Redacted whole lines of the script's output, newest last. */
      details: z.array(z.string().max(1024)).max(200),
      at: Timestamp,
    })
    .optional(),
  workspace: z
    .object({
      id: z.string().min(1),
      name: z.string().max(256),
      path: z.string().max(4096),
      icon: ProjectIcon.nullable().optional(),
      defaultIcon: ProjectIcon.nullable().optional(),
      /** `chat` when the thread is a chat started with no project (ADR 0099). */
      kind: ProjectKind.optional(),
    })
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
  linkedPrs: z.array(LinkedPullRequest).max(100).optional(),
  linkedPr: z
    .object({
      number: z.number().int().positive(),
      state: z.enum(["open", "closed", "merged"]),
      draft: z.boolean().optional(),
      url: z.string().url().max(4096).optional(),
    })
    .nullable()
    .optional(),
  /** This thread was continued on another machine (ADR 0101). */
  continuedOn: ThreadContinuedOn.optional(),
  /** This thread continues one from another machine (ADR 0101). */
  continuedFrom: ThreadContinuedOn.optional(),
  machine: z
    .object({
      host: z.string().min(1).max(256),
      name: z.string().max(256),
      icon: MachineIcon.optional(),
    })
    .optional(),
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
  /** Active root run, independent of retained transcript items; null after it ends. */
  rootRunId: RunId.nullable().optional(),
  /** Start of the current working stretch; streaming activity does not reset it. */
  workingSince: Timestamp.optional(),
  provider: ProviderKind.optional(),
  model: z.string().max(256).optional(),
  account: z.string().max(256).optional(),
  options: TurnOptions.optional(),
  subagentCount: z.number().int().nonnegative().optional(),
  /** Subagents currently starting, working or waiting on their own subagents. */
  runningSubagentCount: z.number().int().nonnegative().optional(),
  /** Background work running of its own: ace's bookkeeping and stand-ins for subagents left out. */
  backgroundTaskCount: z.number().int().nonnegative().optional(),
  /**
   * Background shells still running that hold the thread open (ambient helpers and ace's own
   * bookkeeping left out), oldest first, at most the newest 8: what "Running in background
   * bun run dev:relay" names. Other background work is only counted, in `backgroundTaskCount`.
   */
  watching: z
    .array(z.object({ id: BackgroundTaskId, title: z.string().max(256) }))
    .max(8)
    .optional(),
  /**
   * Requests still waiting on the person, oldest first, at most the newest 8, with what each
   * asks for: "Waiting for your answer" rather than "Needs you".
   */
  asking: z
    .array(z.object({ id: InteractionId, kind: z.string().max(64) }))
    .max(8)
    .optional(),
  /**
   * Delegated child threads whose own request, or a request further down their tree, waits on
   * the person, oldest first, at most the newest 8, with the name this thread gives each: what
   * "general assistant needs you" names, and where its request is answered.
   */
  askingThreads: z
    .array(z.object({ id: ThreadId, name: z.string().max(256).optional() }))
    .max(8)
    .optional(),
  /** How many subagents the root agent waits on, while it waits on them. */
  waitingOn: z.number().int().positive().optional(),
  /** What the root agent's step in flight does, when ace recognises it: `tests` runs tests. */
  step: z.enum(["tests"]).optional(),
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
  /** Sequence of the latest execution status, compared with this device's read cursor. */
  activitySeq: z.number().int().nonnegative().optional(),
  /** Sticky after the first admitted user message, independent of title and status. */
  hasSentMessage: z.boolean().optional(),
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
    autoSettle: z.literal(false).nullable().optional(),
    settleWhenDone: z.literal(true).nullable().optional(),
    prSettled: z.number().int().positive().nullable().optional(),
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
  /**
   * Name the thread again from its opening request, as a new thread is named: its first words at
   * once, then the utility model's title when one is set up. A title set by hand is replaced.
   */
  z.object({ type: z.literal("thread.title.regenerate"), threadId: ThreadId }),
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
  /** Let this thread settle by itself again (`enabled`), or keep it in the list until settled by hand. */
  z.object({ type: z.literal("thread.autoSettle"), threadId: ThreadId, enabled: z.boolean() }),
  z.object({ type: z.literal("thread.snooze"), threadId: ThreadId, until: Timestamp.nullable() }),
  /** Put a thread at a place in the hand-ordered Home list. */
  z.object({ type: z.literal("thread.place"), threadId: ThreadId, order: ListOrder }),
] as const;
