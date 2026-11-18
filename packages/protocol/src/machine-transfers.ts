import { z } from "zod";
import { HostId, ThreadId, WorkspaceId } from "./ids.ts";
import { ProjectIdentityId, maxIdentityAliases } from "./project-identity.ts";
import { ProviderKind } from "./provider.ts";
import { PortableHandoff } from "./thread-transitions.ts";
import { TransferMethod, TransferSessionOutcome } from "./transfers.ts";

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

/**
 * The work landed in a registration there that belongs to another logical project: its
 * identity was kept, and the client may offer to link the two.
 */
export const TransferIdentityConflict = z.object({ identityId: ProjectIdentityId });

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
  /**
   * The source project's id on the sending machine. The target remembers which project a
   * transfer from that machine and project landed in, so sending it again (a folder or a
   * repository without a remote) lands in that same copy instead of making a new one.
   */
  sourceWorkspaceId: WorkspaceId.optional(),
  /**
   * The thread is still working on the sender (ADR 0190): a small final payload follows the
   * bulk, and the target starts the thread's turn itself. Sent only for a working thread; a
   * target that doesn't answer `live` can't take one.
   */
  live: z.literal(true).optional(),
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

/** The provider's own session, carried in the final payload's `session/` folder (ADR 0190). */
export const CarriedSession = z.object({
  provider: ProviderKind,
  nativeSessionId: z.string().min(1).max(256),
  /** The folder the session ran in on the sender; rewritten to the landed checkout there. */
  sourceCwd: z.string().min(1).max(4096),
  /** Files under `session/`, relative to the provider's home. */
  files: z.array(z.string().min(1).max(1024)).max(512),
});
export type CarriedSession = z.infer<typeof CarriedSession>;

/** What a live switch-over adds to the commit (ADR 0190). */
export const TransferLive = z.object({
  /** Grows with every handover of the thread; the target's ownership record keeps it. */
  epoch: z.number().int().positive(),
  /** The thread on the sending machine, which it owns until the target answers. */
  sourceThreadId: ThreadId,
  /** What the source left behind, for the continue message there. */
  left: z.object({
    shells: z.array(z.string().max(256)).max(32),
    children: z.array(z.string().max(256)).max(32),
    remoteChildren: z.array(z.string().max(256)).max(32),
    queued: z.number().int().nonnegative(),
  }),
  /**
   * Git methods: what the bulk bundle holds. `branch`, `head` and `changes` on the commit are
   * the checkout as it was at the stop; `delta.bundle` in the final payload carries the commits
   * between the two.
   */
  bulk: z
    .object({
      branch: refName.optional(),
      head: commit.optional(),
      changes: z.object({ ref: refName, commit }).optional(),
    })
    .optional(),
  /** The provider's session, when it could be carried; otherwise why not. */
  session: CarriedSession.optional(),
  unsupported: z.string().max(256).optional(),
});
export type TransferLive = z.infer<typeof TransferLive>;

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
  /**
   * A live switch-over's final payload (`part=final`): a folder archive with `delta.bundle`
   * (what changed since the bulk) and `session/` (the provider's session). Sent only to a target
   * that answers with `live`.
   */
  final: z.object({ bytes: z.number().int().positive().max(maxTransferBytes), sha256 }).optional(),
  live: TransferLive.optional(),
  /**
   * The source registration's logical project (ADR 0180) and its aliases there. Sent only to a
   * target that answers with `identity: true`: an older target refuses fields it doesn't know.
   */
  identity: z
    .object({
      id: ProjectIdentityId,
      aliases: z.array(ProjectIdentityId).max(maxIdentityAliases),
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
  /** The target keeps logical project identities: `commit` may carry the source's. */
  identity: z.literal(true).optional(),
  /**
   * The target takes live switch-overs (ADR 0190): bytes of the final payload it holds, and once
   * completed, whether the moved thread's turn started there (it owns the thread from its cutoff).
   */
  live: z
    .object({
      finalOffset: z.number().int().nonnegative(),
      running: z.boolean().optional(),
      session: TransferSessionOutcome.optional(),
    })
    .optional(),
  result: z
    .object({
      workspaceId: WorkspaceId,
      path: z.string().min(1).max(4096),
      branch: z.string().max(1024).optional(),
      threadId: ThreadId.optional(),
      ignoredSkipped: z.number().int().nonnegative().optional(),
      /** See `Transfer.result.keptFiles`. */
      keptFiles: z.number().int().nonnegative().optional(),
      /** See `Transfer.result.branchOnly`. */
      branchOnly: z.boolean().optional(),
      /** See `Transfer.result.identityConflict`. */
      identityConflict: TransferIdentityConflict.optional(),
    })
    .optional(),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().max(512) }).optional(),
});
export type IncomingTransfer = z.infer<typeof IncomingTransfer>;

/** The answer to a chunk upload: what the target holds now. */
export const TransferChunkAck = z.object({ offset: z.number().int().nonnegative() });
export type TransferChunkAck = z.infer<typeof TransferChunkAck>;
