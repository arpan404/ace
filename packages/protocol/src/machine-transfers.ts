import { z } from "zod";
import { HostId, ThreadId, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";
import { PortableHandoff } from "./thread-transitions.ts";
import { TransferMethod } from "./transfers.ts";

/**
 * Daemon-to-daemon calls that carry a project or thread to another of the person's machines
 * (ADR 0101). The sending daemon calls `POST /v1/transfers` on the target's paired-device TLS
 * listener with its own device token, and uploads the bundle or archive to
 * `PUT /v1/transfers/chunk` in pieces acknowledged by offset (`part=ignored` for the archive of
 * files Git ignores). Nothing here carries a credential.
 */

/** The largest piece one chunk upload carries. */
export const transferChunkBytes = 4 * 1024 * 1024;
/** The largest file a transfer may send. */
export const maxTransferBytes = 20 * 1024 ** 3;

export const TransferKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const refName = z.string().min(1).max(1024);

/** The sending machine, for attribution and the `-from-<machine>` branch suffix. */
export const TransferOrigin = z.object({
  hostId: HostId,
  hostName: z.string().min(1).max(256),
});
export type TransferOrigin = z.infer<typeof TransferOrigin>;

/** What the target is asked to take, before any byte moves. */
export const TransferBegin = z.strictObject({
  op: z.literal("begin"),
  transferId: TransferKey,
  origin: TransferOrigin,
  method: TransferMethod,
  /** The source project's name, for a new folder there. */
  name: z.string().min(1).max(256),
  /** A folder on the target for a new project; omitted: its default. */
  parent: z.string().min(1).max(4096).optional(),
  /** Source origin: reused or cloned for remote transfers, restored after bundle imports. */
  remote: z
    .object({ url: z.string().min(1).max(2048), normalized: z.string().max(2048) })
    .optional(),
});
export type TransferBegin = z.infer<typeof TransferBegin>;

/** The thread the target starts after the import, with the source thread's history. */
export const TransferThread = z.object({
  sourceThreadId: ThreadId,
  title: z.string().max(256),
  mode: z.enum(["local", "worktree"]),
  provider: ProviderKind,
  model: z.string().min(1).max(256).optional(),
  handoff: PortableHandoff,
});
export type TransferThread = z.infer<typeof TransferThread>;

/** Everything uploaded; the target checks the file and imports it. */
export const TransferCommit = z.strictObject({
  op: z.literal("commit"),
  transferId: TransferKey,
  /** The uploaded file, or none when a remote transfer has nothing origin lacks. */
  file: z.object({ bytes: z.number().int().positive().max(maxTransferBytes), sha256 }).optional(),
  /** Git methods: the branch to land and the commit it points at. */
  branch: refName.optional(),
  head: commit.optional(),
  /** Uncommitted changes, as a commit in the bundle under this ref. */
  changes: z.object({ ref: refName, commit }).optional(),
  thread: TransferThread.optional(),
  /**
   * Files Git ignores, uploaded as their own folder archive (`part=ignored`), placed after the
   * checkout lands. Sent only to a target that answers with `ignoredOffset`.
   */
  ignored: z
    .object({
      bytes: z.number().int().positive().max(maxTransferBytes),
      sha256,
      files: z.number().int().nonnegative(),
    })
    .optional(),
});
export type TransferCommit = z.infer<typeof TransferCommit>;

export const MachineTransferCall = z.discriminatedUnion("op", [
  /** Whether this device may send transfers here; needs only a paired device. */
  z.strictObject({ op: z.literal("probe") }),
  TransferBegin,
  z.strictObject({ op: z.literal("status"), transferId: TransferKey }),
  TransferCommit,
  z.strictObject({ op: z.literal("cancel"), transferId: TransferKey }),
]);
export type MachineTransferCall = z.infer<typeof MachineTransferCall>;

export const TransferProbe = z.object({
  hostId: HostId,
  name: z.string().min(1).max(256),
  /** The device holds both `operate` and `projects` there. */
  accepts: z.boolean(),
});
export type TransferProbe = z.infer<typeof TransferProbe>;

/** The target's side of one transfer. */
export const IncomingTransferState = z.enum([
  /** method remote: cloning origin, or looking for a project that has it. */
  "cloning",
  /** Ready for bytes. */
  "receiving",
  "importing",
  "completed",
  "failed",
  "cancelled",
]);
export type IncomingTransferState = z.infer<typeof IncomingTransferState>;

export const IncomingTransfer = z.object({
  transferId: TransferKey,
  state: IncomingTransferState,
  method: TransferMethod,
  /** Bytes of the upload the target holds. */
  offset: z.number().int().nonnegative(),
  /**
   * Bytes of the ignored files' upload the target holds. Present when the target takes ignored
   * files at all; a sender never sends them to a target that leaves it out.
   */
  ignoredOffset: z.number().int().nonnegative().optional(),
  /**
   * method remote, once ready: the target has origin's history, so the bundle only needs what
   * origin lacks. False: it couldn't clone origin; send a full bundle instead.
   */
  hasOrigin: z.boolean().optional(),
  result: z
    .object({
      workspaceId: WorkspaceId,
      path: z.string().min(1).max(4096),
      branch: z.string().max(1024).optional(),
      threadId: ThreadId.optional(),
      ignoredSkipped: z.number().int().nonnegative().optional(),
    })
    .optional(),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().max(512) }).optional(),
});
export type IncomingTransfer = z.infer<typeof IncomingTransfer>;

/** The answer to a chunk upload: what the target holds now. */
export const TransferChunkAck = z.object({ offset: z.number().int().nonnegative() });
export type TransferChunkAck = z.infer<typeof TransferChunkAck>;
