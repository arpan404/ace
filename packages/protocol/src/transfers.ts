import { z } from "zod";
import { CommandId, HostId, ThreadId, Timestamp, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

/**
 * Carrying a project, or a thread with its project, to another of the person's machines
 * (ADR 0099). The client asks the machine that has the work; that daemon sends it straight to
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
  /** Set once completed: what now exists on the other machine. */
  result: z
    .object({
      workspaceId: WorkspaceId,
      path,
      branch: z.string().max(1024).optional(),
      threadId: ThreadId.optional(),
      /** Ignored files that were kept back because the project there already had them. */
      ignoredSkipped: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** Set once failed, in words a person acts on. */
  error: z.object({ code: z.string().min(1).max(64), message: z.string().max(512) }).optional(),
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
  ]),
});
export type TransfersRequest = z.infer<typeof TransfersRequest>;

export const TransfersResult = z.object({
  type: z.literal("transfers.result"),
  requestId: id,
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("list"), transfers: z.array(Transfer).max(100) }),
    z.object({ kind: z.literal("cancelled"), transfer: Transfer }),
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
