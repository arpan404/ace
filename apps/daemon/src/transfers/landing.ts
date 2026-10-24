import type { ProjectGitPolicy } from "@ace/git";
import type { PinnedDirectory } from "@ace/workspace";
import { basename, dirname, join } from "node:path";
import type { IncomingTransfer, ThreadId, TransferCommit, WorkspaceId } from "@ace/protocol";
import type { IncomingRecord } from "./incoming-rows.ts";
import { freeFolder, removeQuietly, removeUnder } from "./files.ts";
import { TransferError, type TransferArchive, type TransferGit } from "./ports.ts";

/**
 * A folder new projects may be made in, validated against the allowed roots and held open, so
 * the folder a transfer makes there, and everything written into it, stays there (ADR 0063).
 */
export interface TransferParent {
  path: string;
  handle: PinnedDirectory;
  close(): Promise<void>;
}

/** The target's projects, through the owner that registers them (ADR 0063). */
export interface TargetProjects {
  /** Registered projects with their folders. */
  list(): { workspaceId: WorkspaceId; path: string }[];
  /** A folder inside the allowed roots for new projects, held open; omitted: the default. */
  parent(requested: string | undefined): Promise<TransferParent>;
  /** `workspace.clone`, keyed so a retry runs once. */
  clone(input: {
    key: string;
    parent: string;
    name: string;
    url: string;
    signal: AbortSignal;
  }): Promise<WorkspaceId>;
  /** `workspace.add` of a folder this transfer made. */
  register(input: { key: string; path: string; name: string }): Promise<WorkspaceId>;
  /** `workspace.remove`; the folder stays for the caller to remove. */
  unregister(workspaceId: WorkspaceId): Promise<void>;
}

export interface ContinuedThread {
  deviceId: string;
  workspaceId: WorkspaceId;
  /** The checkout for a local thread; for a worktree thread, the branch it starts from. */
  mode: "local" | "worktree";
  base?: string | undefined;
  thread: NonNullable<TransferCommit["thread"]>;
  machine: { hostId: string; name: string };
}

/** The continued thread there, made and then set up as two recoverable steps. */
export interface TargetThreadStarter {
  /**
   * Makes the thread with `thread.prepare`, without a turn. `prepare` runs in a worktree
   * thread's folder first. `cutoff` runs right before the thread is made and throws when the
   * transfer was cancelled, so a thread exists only for a transfer that can no longer be
   * cancelled. The same key returns the same thread.
   */
  create(
    input: ContinuedThread & {
      key: string;
      prepare?: ((path: string) => Promise<void>) | undefined;
      cutoff(): void;
    },
  ): Promise<ThreadId>;
  /**
   * Gives a made thread its handoff and its link to the source thread, and runs `then` in the
   * same store transaction. A thread that already has them is left as it is, so a restart can
   * run this again; a thread that is gone just runs `then`.
   */
  setUp(
    input: {
      threadId: ThreadId;
      thread: NonNullable<TransferCommit["thread"]>;
      machine: { hostId: string; name: string };
    },
    then: () => void,
  ): void;
}

export interface LandingDeps {
  git: TransferGit;
  gitPolicy?: ProjectGitPolicy | undefined;
  archive: TransferArchive;
  projects: TargetProjects;
  threads: TargetThreadStarter;
  /** Folders other transfers are filling right now. */
  held: Set<string>;
  /** Records what this transfer made, durably, before it is made (cleared once removed). */
  made(change: { createdPath?: string | undefined; registeredId?: string | undefined }): void;
  /** Distinct per attempt, so a retried import never reuses an earlier attempt's receipt. */
  attempt: string;
  /** Runs in the final checkout once the branch and changes are there (ignored files). */
  landed?: ((path: string, signal: AbortSignal) => Promise<void>) | undefined;
  /**
   * The point after which the transfer can't be cancelled: right before the thread is made, or,
   * without a thread, once everything has landed. Synchronous; throws when it was cancelled.
   */
  cutoff(): void;
  /** Records the result durably, right after the cutoff (and the thread) are passed. */
  created(result: Landed): void;
}

/** The remote method needs origin's history there; asking for a full bundle instead. */
export class NeedsFullBundle extends Error {}

export type Landed = NonNullable<IncomingTransfer["result"]>;

/** Where a sender pins a detached HEAD, so its bundle carries that commit. */
export const headRef = (transferId: string) => `refs/ace/transfer-head/${transferId}`;

/** The branch a detached HEAD lands on: it is the only name the commit gets there. */
const detachedBranch = (head: string) => `detached-${head.slice(0, 12)}`;

/** What one landing made, undone through the descriptors it was made with when it fails. */
class Made {
  private deps: LandingDeps;
  /** The new project's folder: its held parent, its name there, and its own handle once made. */
  private folder: { parent: TransferParent; name: string; handle?: PinnedDirectory } | undefined;
  private paths: string[] = [];
  private registered: WorkspaceId | undefined;
  /** Past the cutoff: what was made is the result and stays. */
  kept = false;
  constructor(deps: LandingDeps) {
    this.deps = deps;
  }
  /** A free name for the new project in the held parent, recorded before anything is made. */
  async reserve(requested: string | undefined, name: string): Promise<TransferParent> {
    const parent = await this.deps.projects.parent(requested);
    try {
      const path = await freeFolder(parent.path, name, this.deps.held);
      this.deps.held.add(path);
      this.deps.made({ createdPath: path });
      this.folder = { parent, name: basename(path) };
      return parent;
    } catch (error) {
      await parent.close();
      throw error;
    }
  }
  get path(): string {
    if (!this.folder) throw new TransferError("import_failed", "No folder was reserved.");
    return join(this.folder.parent.path, this.folder.name);
  }
  get name(): string {
    if (!this.folder) throw new TransferError("import_failed", "No folder was reserved.");
    return this.folder.name;
  }
  /** Makes the reserved folder inside the held parent, without following links. */
  mkdir(): PinnedDirectory {
    if (!this.folder) throw new TransferError("import_failed", "No folder was reserved.");
    this.folder.handle = this.folder.parent.handle.mkdir(this.folder.name);
    return this.folder.handle;
  }
  /** A folder made by path outside a held parent (a branch's worktree beside the project). */
  beside(path: string): void {
    this.deps.held.add(path);
    this.deps.made({ createdPath: path });
    this.paths.push(path);
  }
  registeredAs(workspaceId: WorkspaceId): void {
    this.registered = workspaceId;
    this.deps.made({ registeredId: workspaceId });
  }
  async undo(): Promise<void> {
    if (this.kept) return;
    if (this.registered)
      await this.deps.projects.unregister(this.registered).catch(() => undefined);
    for (const path of this.paths) await removeQuietly(path);
    if (this.folder) {
      const { parent, name, handle } = this.folder;
      // Only the folder this landing made: the name must still lead to the same inode.
      const there = statIn(parent.handle, name);
      const made = handle?.stat();
      if (there && (!made || (there.dev === made.dev && there.ino === made.ino)))
        await removeUnder(parent, name);
    }
    this.deps.made({ createdPath: undefined, registeredId: undefined });
  }
  async close(): Promise<void> {
    await this.folder?.handle?.close();
    await this.folder?.parent.close();
    this.folder = undefined;
  }
}

function statIn(directory: PinnedDirectory, name: string) {
  try {
    return directory.metadata(name);
  } catch {
    return undefined;
  }
}

/**
 * Where one transfer's code lands on this machine (ADR 0099 "Where it lands"). A project this
 * machine already had keeps its checkout untouched unless it is clean on the same branch; a new
 * project is made from the bundle, the archive or a clone of origin. Every step checks for
 * cancellation; until the cutoff a failure or a cancel undoes what this landing made.
 */
export async function landTransfer(
  deps: LandingDeps,
  record: IncomingRecord,
  file: string | undefined,
  signal: AbortSignal,
): Promise<Landed> {
  const made = new Made(deps);
  try {
    return await land(deps, made, record, file, signal);
  } catch (error) {
    await made.undo().catch(() => undefined);
    throw error;
  } finally {
    await made.close();
  }
}

async function land(
  deps: LandingDeps,
  made: Made,
  record: IncomingRecord,
  file: string | undefined,
  signal: AbortSignal,
): Promise<Landed> {
  const commit = record.commit;
  if (!commit) throw new TransferError("transfer_invalid", "Nothing was sent to import.");
  const { begin } = record;
  const key = `transfer:${record.transferId}:${deps.attempt}`;
  const reusedId = record.method === "remote" ? record.workspaceId : undefined;
  let path: string;
  let workspaceId: WorkspaceId;
  let fresh = true;
  if (record.method === "archive") {
    if (!file) throw new TransferError("transfer_invalid", "The folder's copy is missing.");
    await made.reserve(begin.parent, begin.name);
    path = made.path;
    await deps.archive.unpackArchive(file, made.mkdir(), { signal });
    signal.throwIfAborted();
    workspaceId = await deps.projects.register({ key, path, name: begin.name });
    made.registeredAs(workspaceId);
  } else if (record.method === "bundle") {
    if (!file) throw new TransferError("transfer_invalid", "The repository's bundle is missing.");
    await made.reserve(begin.parent, begin.name);
    path = made.path;
    await deps.git.cloneFromBundle(
      {
        parent: dirname(path),
        path,
        bundle: file,
        origin: begin.remote?.url,
        directoryFd: made.mkdir().fd,
        ...(commit.branch ? { branch: commit.branch } : {}),
      },
      deps.gitPolicy,
    );
    signal.throwIfAborted();
    workspaceId = await deps.projects.register({ key, path, name: begin.name });
    made.registeredAs(workspaceId);
  } else {
    const reused = reusedId
      ? deps.projects.list().find((project) => project.workspaceId === reusedId)
      : undefined;
    if (reused) {
      ({ path, workspaceId } = reused);
      fresh = false;
    } else {
      if (!begin.remote) throw new TransferError("transfer_invalid", "No origin to clone.");
      // workspace.clone makes and fills the folder through its own descriptors.
      const parent = await made.reserve(begin.parent, begin.name);
      path = made.path;
      try {
        workspaceId = await deps.projects.clone({
          key,
          parent: parent.path,
          name: made.name,
          url: begin.remote.url,
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new NeedsFullBundle();
      }
      made.registeredAs(workspaceId);
    }
    signal.throwIfAborted();
    try {
      if (file) {
        if (!(await deps.git.verifyBundle(path, file))) throw new NeedsFullBundle();
        const pinned = !commit.branch && commit.head ? headRef(record.transferId) : undefined;
        const head = commit.branch ? `refs/heads/${commit.branch}` : pinned;
        const changes = commit.changes ? [`${commit.changes.ref}:${commit.changes.ref}`] : [];
        try {
          await deps.git.fetchBundle(path, file, [
            ...(head ? [`${head}:refs/ace/incoming/${record.transferId}`] : []),
            ...changes,
          ]);
        } catch (error) {
          // A bundle of only what origin lacks leaves out a branch origin already has: its
          // commit is here already, and only the changes travel.
          if (!head || !changes.length) throw error;
          await deps.git.fetchBundle(path, file, changes);
        }
      }
    } catch (error) {
      if (error instanceof NeedsFullBundle) throw error;
      throw new NeedsFullBundle();
    }
  }
  signal.throwIfAborted();
  return place(deps, made, record, commit, { path, workspaceId, fresh }, signal);
}

/** Puts the branch and the uncommitted changes in a checkout, and starts the thread. */
async function place(
  deps: LandingDeps,
  made: Made,
  record: IncomingRecord,
  commit: TransferCommit,
  project: { path: string; workspaceId: WorkspaceId; fresh: boolean },
  signal: AbortSignal,
): Promise<Landed> {
  const { git } = deps;
  const isGit = record.method !== "archive";
  const machine = record.begin.origin.hostName;
  const wantsWorktree = commit.thread?.mode === "worktree";
  // A detached HEAD lands on a branch of its own at that exact commit.
  let branch = commit.branch ?? (commit.head ? detachedBranch(commit.head) : undefined);
  let inCheckout = true;
  if (isGit && branch && commit.head) {
    if (project.fresh) {
      await git.checkoutBranch(project.path, { name: branch, commit: commit.head });
    } else {
      const state = await git.checkoutState(project.path);
      if (!wantsWorktree && state.clean && state.branch === branch) {
        if (state.head !== commit.head) await git.fastForward(project.path, commit.head);
      } else {
        const landing = await git.landingBranch(project.path, {
          branch,
          commit: commit.head,
          machine,
        });
        if (!landing.existing) await git.createBranch(project.path, landing.branch, commit.head);
        branch = landing.branch;
        inCheckout = false;
      }
    }
  }
  signal.throwIfAborted();
  const changes = commit.changes;
  const apply = async (path: string) => {
    if (changes) await git.applyChanges(path, changes.commit);
    signal.throwIfAborted();
    await deps.landed?.(path, signal);
    signal.throwIfAborted();
  };
  let path = project.path;
  const result = (threadId?: ThreadId): Landed => ({
    workspaceId: project.workspaceId,
    path,
    ...(branch && isGit ? { branch } : {}),
    ...(threadId ? { threadId } : {}),
  });
  let landed: Landed;
  if (commit.thread) {
    const worktree = isGit && (wantsWorktree || !inCheckout);
    if (!worktree) await apply(path);
    const threadId = await deps.threads.create({
      key: `transfer:${record.transferId}:${deps.attempt}`,
      deviceId: record.deviceId,
      workspaceId: project.workspaceId,
      mode: worktree ? "worktree" : "local",
      base: branch,
      thread: commit.thread,
      machine: { hostId: record.begin.origin.hostId, name: machine },
      ...(worktree ? { prepare: apply } : {}),
      cutoff: () => {
        signal.throwIfAborted();
        deps.cutoff();
      },
    });
    made.kept = true;
    landed = result(threadId);
    deps.created(landed);
  } else {
    if (inCheckout) {
      await apply(path);
    } else if (branch) {
      // The person's checkout there is busy: the branch gets its own folder beside it.
      path = await freeFolder(dirname(project.path), `${record.begin.name}-${branch}`, deps.held);
      made.beside(path);
      await git.addBranchWorktree(project.path, { path, branch });
      await apply(path);
    }
    signal.throwIfAborted();
    deps.cutoff();
    made.kept = true;
    landed = result();
    deps.created(landed);
  }
  if (isGit) {
    const refs = [
      ...(changes ? [changes.ref] : []),
      headRef(record.transferId),
      `refs/ace/incoming/${record.transferId}`,
    ];
    for (const ref of refs) await git.deleteRef(project.path, ref).catch(() => undefined);
  }
  return landed;
}
