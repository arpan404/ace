import { z } from "zod";
import { CommandId, HostId, ThreadId, Timestamp, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { ProjectIdentityId } from "./project-identity.ts";

/**
 * Carrying a project, or a thread with its project, to another of the person's machines
 * (ADR 0101). The client asks the machine that has the work; that daemon sends it straight to
 * the other machine over its fleet link. Nothing here carries a credential.
 */

const id = z.string().min(1).max(128);
const path = z.string().min(1).max(4096);

/** Where the target puts a project it doesn't have yet. Omitted: its default clone folder. */
const TransferPlacement = {
  /** The other machine's host id, as its fleet link names it. */
  hostId: HostId,
  /** A folder on the other machine to create the project in. */
  parent: path.optional(),
  /** Send uncommitted changes too, as uncommitted changes there. Default true. */
  includeChanges: z.boolean().default(true),
  /**
   * Send files Git ignores too, such as `.env` and local config, without dependency or cache
   * folders. Omitted: the sending machine's `remote.transferIgnoredFiles`.
   */
  includeIgnored: z.boolean().optional(),
};

export const TransferCommands = [
  /** "Open on <machine>": the project there, on the same branch, without a thread. */
  z.object({
    type: z.literal("workspace.transfer"),
    workspaceId: WorkspaceId,
    ...TransferPlacement,
  }),
  /**
   * "Continue on <machine>": the thread's project and branch there, then a new thread there that
   * starts from this thread's history. Refused while this thread's tree is still working.
   */
  z.object({
    type: z.literal("thread.continueOn"),
    threadId: ThreadId,
    ...TransferPlacement,
    /** The provider and model there; omitted keeps this thread's when installed there. */
    provider: ProviderKind.optional(),
    model: z.string().min(1).max(256).optional(),
  }),
] as const;

/** How the code travels, chosen by the sending machine. */
export const TransferMethod = z.enum([
  /** The target cloned the origin remote itself; a bundle carries only what origin lacks. */
  "remote",
  /** A Git repository with no usable remote: a bundle of its history. */
  "bundle",
  /** A folder that isn't a Git repository: a full copy. */
  "archive",
]);
export type TransferMethod = z.infer<typeof TransferMethod>;

export const TransferPhase = z.enum([
  "preparing",
  "cloning",
  "sending",
  "importing",
  "starting",
  "completed",
  "failed",
  "cancelled",
]);
export type TransferPhase = z.infer<typeof TransferPhase>;

/**
 * Ignored files a transfer carries or placed: only counts and bytes, never names, so nothing
 * about them reaches rows, pushes or logs.
 */
export const TransferIgnoredFiles = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type TransferIgnoredFiles = z.infer<typeof TransferIgnoredFiles>;

/**
 * Where a live switch-over stands (ADR 0191): the bulk uploading while the agent works, stopping
 * at a safe point, handed over and waiting for the other machine's answer, moved there, or back
 * to running here because the move didn't happen.
 */
export const TransferLiveStage = z.enum(["readying", "stopping", "handing", "moved", "resumed"]);
export type TransferLiveStage = z.infer<typeof TransferLiveStage>;

/**
 * How a moved agent's history went: its provider's own session, or the handoff summary.
 * Declared, not inferred, as `Speaker` is: transfer results ride the wire unions, and an inferred
 * shape here took `ServerMessage` past what TypeScript will write out.
 */
export interface TransferSessionOutcome {
  kind: "native" | "summary";
  reason?: string | undefined;
  sessionIds?: { from: string; to: string } | undefined;
}
export const TransferSessionOutcome: z.ZodType<TransferSessionOutcome> = z.object({
  kind: z.enum(["native", "summary"]),
  /** Why the summary was used, in words a person reads. */
  reason: z.string().max(256).optional(),
  /**
   * The provider's own session: its id on the sending machine, and the fresh id its copy took
   * here, which the thread continues.
   */
  sessionIds: z
    .object({ from: z.string().min(1).max(256), to: z.string().min(1).max(256) })
    .optional(),
});

/** One transfer as the sending machine sees it. */
export const Transfer = z.object({
  transferId: id,
  /** The command that started it. */
  commandId: CommandId,
  kind: z.enum(["project", "thread"]),
  workspaceId: WorkspaceId,
  threadId: ThreadId.optional(),
  target: z.object({ hostId: HostId, name: z.string().min(1).max(256) }),
  phase: TransferPhase,
  /**
   * Its machine isn't linked to this one now. The transfer waits for a link to that same
   * machine again and never goes on to another; a moving thread may be carried on here by the
   * person's own choice (`carryOnHere`).
   */
  unlinked: z.literal(true).optional(),
  method: TransferMethod.optional(),
  /**
   * What the person (or agent) asked for, as the command said it, so "Try again" repeats the
   * same choice. Absent on transfers from daemons older than this field.
   */
  options: z
    .object({
      includeChanges: z.boolean(),
      includeIgnored: z.boolean(),
      parent: path.optional(),
    })
    .optional(),
  /** Bytes sent and to send, counting both the code and the ignored files. */
  sentBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().optional(),
  /** Set when ignored files travel with it. */
  ignoredFiles: TransferIgnoredFiles.optional(),
  /**
   * Set once completed: what now exists on the other machine.
   *
   * - `workspaceId` is always the project there: a project it already had (same origin, or the
   *   copy an earlier transfer of this project made) or a new one.
   * - Without `branchOnly`, the work is checked out in that project's own folder (`path`), on
   *   `branch` for Git projects: a local thread there starts on it.
   * - With `branchOnly`, the project's checkout there was busy (its own changes, another branch,
   *   or an agent working in it) and was left alone: the work is only on the new local `branch`
   *   (`<branch>-from-<machine>`), and `path` is the project's folder. Uncommitted changes that
   *   travelled are that branch's top commit ("Uncommitted changes carried to another
   *   machine"). A client starts a worktree thread in `workspaceId` from `branch`; never a
   *   local thread, which would run in the person's checkout without the work.
   * - With `threadId` (Continue on), the thread there already starts where the work is: in the
   *   project's checkout, or in a worktree of its own on `branch` when the checkout was busy.
   */
  result: z
    .object({
      workspaceId: WorkspaceId,
      path,
      branch: z.string().max(1024).optional(),
      threadId: ThreadId.optional(),
      /** Ignored files that were kept back because the project there already had them. */
      ignoredSkipped: z.number().int().nonnegative().optional(),
      /**
       * A folder sent again to the copy an earlier transfer made: files that copy already had,
       * kept as they are there instead of being replaced by the sent ones. Only files it lacked
       * were added; nothing there is ever overwritten.
       */
      keptFiles: z.number().int().nonnegative().optional(),
      /** The work landed only on `branch`, not in the project's checkout; see above. */
      branchOnly: z.boolean().optional(),
      /**
       * The project there already belongs to another logical project (ADR 0180): its identity
       * is kept, never overwritten, and the person may link the two.
       */
      identityConflict: z.object({ identityId: ProjectIdentityId }).optional(),
    })
    .optional(),
  /** Set once failed, in words a person acts on. */
  error: z.object({ code: z.string().min(1).max(64), message: z.string().max(512) }).optional(),
  /** A thread moved while it was working (ADR 0191): where the switch-over stands. */
  live: z
    .object({
      stage: TransferLiveStage,
      /** How the agent's history went: its provider's own session, or the handoff summary. */
      session: TransferSessionOutcome.optional(),
    })
    .optional(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
});
export type Transfer = z.infer<typeof Transfer>;

/** Pushed on every phase change and at most every 500 ms while bytes move. */
export const TransferProgress = z.object({
  type: z.literal("transfer.progress"),
  transfer: Transfer,
});
export type TransferProgress = z.infer<typeof TransferProgress>;

export const TransfersRequest = z.object({
  type: z.literal("transfers.request"),
  requestId: id,
  operation: z.discriminatedUnion("op", [
    /** Transfers still running and those finished in the last 24 hours, newest first. */
    z.object({ op: z.literal("list") }),
    z.object({ op: z.literal("cancel"), transferId: id }),
    /**
     * A moving thread whose machine isn't linked now (`unlinked`) runs here again, as the person
     * chose, warned that both may run if that machine already took it. Recorded on the transfer.
     */
    z.object({ op: z.literal("carryOnHere"), transferId: id }),
  ]),
});
export type TransfersRequest = z.infer<typeof TransfersRequest>;

export const TransfersResult = z.object({
  type: z.literal("transfers.result"),
  requestId: id,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("list"), transfers: z.array(Transfer).max(100) }),
    z.object({ kind: z.literal("cancelled"), transfer: Transfer }),
    z.object({ kind: z.literal("carriedOnHere"), transfer: Transfer }),
    z.object({
      kind: z.literal("error"),
      code: z.string().min(1).max(64),
      message: z.string().max(512),
    }),
  ]),
});
export type TransfersResult = z.infer<typeof TransfersResult>;

/** On a thread that was continued elsewhere: where the work went. */
export const ThreadContinuedOn = z.object({
  hostId: HostId,
  name: z.string().min(1).max(256),
  threadId: ThreadId,
  at: Timestamp,
});
export type ThreadContinuedOn = z.infer<typeof ThreadContinuedOn>;
