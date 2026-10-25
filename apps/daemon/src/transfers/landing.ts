import type { ProjectGitPolicy } from "@ace/git";
import type { PinnedDirectory } from "@ace/workspace";
import { basename, dirname, join } from "node:path";
import type { IncomingTransfer, ThreadId, TransferCommit, WorkspaceId } from "@ace/protocol";
import type { IncomingRecord } from "./incoming-rows.ts";
import { lstat } from "node:fs/promises";
import { folderIdentity, freeFolder, removeIfOwned, removeQuietly } from "./files.ts";
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
  /**
   * `workspace.clone`, keyed so a retry runs once. `made` hears the new folder's identity as
   * soon as the clone makes it, before anything is written in it.
   */
  clone(input: {
    key: string;
    parent: string;
    name: string;
    url: string;
    signal: AbortSignal;
    made(directory: { dev: number; ino: number }): void;
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
   * cancelled. `made` runs inside the store transaction that makes the thread, so the thread and
   * the transfer's record of it commit together. The same key returns the same thread.
   */
  create(
    input: ContinuedThread & {
      key: string;
      prepare?: ((path: string) => Promise<void>) | undefined;
      cutoff(): void;
      made(threadId: ThreadId): void;
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
  /**
   * Records what this transfer made, durably: a folder's path before it is made, and its
   * identity (`createdId`, `dev:ino`) once it is; cleared once removed.
   */
  made(change: {
    createdPath?: string | undefined;
    createdId?: string | undefined;
    registeredId?: string | undefined;
  }): void;
  /** Distinct per attempt, so a retried import never reuses an earlier attempt's receipt. */
  attempt: string;
  /**
   * Runs in the final checkout once the branch and changes are there (ignored files): the
   * folder this transfer made, held open, or the path of one it didn't make.
   */
  landed?:
    | ((destination: string | PinnedDirectory, signal: AbortSignal) => Promise<void>)
    | undefined;
  /**
   * The point after which the transfer can't be cancelled: right before the thread is made, or,
   * without a thread, once everything has landed. Synchronous; throws when it was cancelled.
   */
  cutoff(): void;
  /**
   * Records the result durably, right after the cutoff is passed; with a thread, in the same
   * store transaction that makes it.
   */
  created(result: Landed): void;
}

/** The remote method needs origin's history there; asking for a full bundle instead. */
export class NeedsFullBundle extends Error {}

export type Landed = NonNullable<IncomingTransfer["result"]>;

/** Where a sender pins a detached HEAD, so its bundle carries that commit. */
export const headRef = (transferId: string) => `refs/ace/transfer-head/${transferId}`;

/** The branch a detached HEAD lands on: it is the only name the commit gets there. */
const detachedBranch = (head: string) => `detached-${head.slice(0, 12)}`;

/**
 * What one landing made, undone when it fails. A reserved name is only a reservation: undo
 * removes a folder only once this landing made it and only while the name still leads to it.
 */
class Made {
  private deps: LandingDeps;
  /** The new project's folder: its held parent, its name there, and once made its handle. */
  private folder:
    | { parent: TransferParent; name: string; handle?: PinnedDirectory; id?: string }
    | undefined;
  /** A branch's worktree beside a project, made by path; its identity once made. */
  private beside: { path: string; id?: string } | undefined;
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
      this.deps.made({ createdPath: path, createdId: undefined });
      this.folder = { parent, name: basename(path) };
      return parent;
    } catch (error) {
      await parent.close();
      throw error;
    }
  }
  private need() {
    if (!this.folder) throw new TransferError("import_failed", "No folder was reserved.");
    return this.folder;
  }
  get path(): string {
    const folder = this.need();
    return join(folder.parent.path, folder.name);
  }
  get name(): string {
    return this.need().name;
  }
  /** The folder this landing made, held open, once it is made. */
  get handle(): PinnedDirectory | undefined {
    return this.folder?.handle;
  }
  /**
   * Makes the reserved folder inside the held parent, without following links. A name someone
   * else took meanwhile fails here and stays theirs: nothing of it is ever removed.
   */
  mkdir(): PinnedDirectory {
    const folder = this.need();
    const handle = folder.parent.handle.mkdir(folder.name);
    // Swapped between making and opening: that folder isn't this landing's.
    if (!handle.empty()) {
      handle.closeSync();
      throw new TransferError(
        "import_failed",
        "The new project's folder changed while it was made.",
      );
    }
    return this.own(folder, handle);
  }
  /** `workspace.clone` made the reserved folder: from here it is this landing's to remove. */
  cloning(directory: { dev: number; ino: number }): void {
    this.record(this.need(), folderIdentity(directory));
  }
  /** The folder `workspace.clone` made and filled, held open from here; never a swapped one. */
  cloned(): PinnedDirectory {
    const folder = this.need();
    const handle = folder.parent.handle.child(folder.name);
    if (folder.id !== folderIdentity(handle.stat())) {
      handle.closeSync();
      throw new TransferError(
        "import_failed",
        "The new project's folder changed while it was made.",
      );
    }
    folder.handle = handle;
    return handle;
  }
  private own(folder: NonNullable<Made["folder"]>, handle: PinnedDirectory): PinnedDirectory {
    folder.handle = handle;
    this.record(folder, folderIdentity(handle.stat()));
    return handle;
  }
  private record(folder: NonNullable<Made["folder"]>, id: string): void {
    folder.id = id;
    this.deps.made({ createdPath: this.path, createdId: id });
  }
  /** Reserves a folder made by path outside a held parent (a branch's worktree beside it). */
  reserveBeside(path: string): void {
    this.deps.held.add(path);
    this.deps.made({ createdPath: path, createdId: undefined });
    this.beside = { path };
  }
  /** The worktree beside it was made: from here it is this landing's to remove. */
  async madeBeside(): Promise<void> {
    if (!this.beside) return;
    this.beside.id = folderIdentity(await lstat(this.beside.path));
    this.deps.made({ createdPath: this.beside.path, createdId: this.beside.id });
  }
  registeredAs(workspaceId: WorkspaceId): void {
    this.registered = workspaceId;
    this.deps.made({ registeredId: workspaceId });
  }
  /** Removes only what this landing made; the record stays when a removal fails. */
  async undo(): Promise<void> {
    if (this.kept) return;
    if (this.registered)
      await this.deps.projects.unregister(this.registered).catch(() => undefined);
    const beside = this.beside;
    if (beside?.id) {
      const there = await lstat(beside.path).catch(() => undefined);
      if (there && folderIdentity(there) === beside.id) await removeQuietly(beside.path);
    }
    const folder = this.folder;
    if (folder?.id) removeIfOwned(folder.parent, folder.name, folder.id);
    this.deps.made({ createdPath: undefined, createdId: undefined, registeredId: undefined });
  }
  async close(): Promise<void> {
    await this.folder?.handle?.close();
    await this.folder?.parent.close();
    this.folder = undefined;
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
    const directory = made.mkdir();
    await deps.git.cloneFromBundle(
      {
        parent: dirname(path),
        path,
        bundle: file,
        origin: begin.remote?.url,
        directoryFd: directory.fd,
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
          made: (directory) => made.cloning(directory),
        });
      } catch {
        signal.throwIfAborted();
        throw new NeedsFullBundle();
      }
      made.registeredAs(workspaceId);
      made.cloned();
    }
    signal.throwIfAborted();
    const held = made.handle ? { directoryFd: made.handle.fd } : undefined;
    try {
      if (file) {
        if (!(await deps.git.verifyBundle(path, file, held))) throw new NeedsFullBundle();
        const pinned = !commit.branch && commit.head ? headRef(record.transferId) : undefined;
        const head = commit.branch ? `refs/heads/${commit.branch}` : pinned;
        const changes = commit.changes ? [`${commit.changes.ref}:${commit.changes.ref}`] : [];
        try {
          await deps.git.fetchBundle(
            path,
            file,
            [...(head ? [`${head}:refs/ace/incoming/${record.transferId}`] : []), ...changes],
            held,
          );
        } catch (error) {
          // A bundle of only what origin lacks leaves out a branch origin already has: its
          // commit is here already, and only the changes travel.
          if (!head || !changes.length) throw error;
          await deps.git.fetchBundle(path, file, changes, held);
        }
      }
    } catch (error) {
      if (error instanceof NeedsFullBundle) throw error;
      throw new NeedsFullBundle();
    }
  }
  signal.throwIfAborted();
  const directory = made.handle;
  return place(deps, made, record, commit, { path, workspaceId, fresh, directory }, signal);
}

/**
 * Puts the branch and the uncommitted changes in a checkout, and starts the thread. In a folder
 * this transfer made, every write goes through its held descriptor, never its path.
 */
async function place(
  deps: LandingDeps,
  made: Made,
  record: IncomingRecord,
  commit: TransferCommit,
  project: {
    path: string;
    workspaceId: WorkspaceId;
    fresh: boolean;
    directory?: PinnedDirectory | undefined;
  },
  signal: AbortSignal,
): Promise<Landed> {
  const { git } = deps;
  const isGit = record.method !== "archive";
  const machine = record.begin.origin.hostName;
  const wantsWorktree = commit.thread?.mode === "worktree";
  // A detached HEAD lands on a branch of its own at that exact commit.
  let branch = commit.branch ?? (commit.head ? detachedBranch(commit.head) : undefined);
  let inCheckout = true;
  const held = project.directory ? { directoryFd: project.directory.fd } : undefined;
  if (isGit && branch && commit.head) {
    if (project.fresh) {
      await git.checkoutBranch(project.path, { name: branch, commit: commit.head }, held);
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
  const apply = async (path: string, directory?: PinnedDirectory) => {
    const pin = directory ? { directoryFd: directory.fd } : undefined;
    if (changes) await git.applyChanges(path, changes.commit, pin);
    signal.throwIfAborted();
    await deps.landed?.(directory ?? path, signal);
    signal.throwIfAborted();
  };
  // The project's own checkout: the folder this transfer made, held, or one it reused.
  const inProject = () => apply(project.path, project.directory);
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
    if (!worktree) await inProject();
    const keep = (threadId: ThreadId) => {
      made.kept = true;
      deps.created(result(threadId));
    };
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
      // In the thread's own transaction: a crash right after can't roll the thread back.
      made: keep,
    });
    // A thread this attempt had already made, returned again.
    if (!made.kept) keep(threadId);
    landed = result(threadId);
  } else {
    if (inCheckout) {
      await inProject();
    } else if (branch) {
      // The person's checkout there is busy: the branch gets its own folder beside it.
      path = await freeFolder(dirname(project.path), `${record.begin.name}-${branch}`, deps.held);
      made.reserveBeside(path);
      await git.addBranchWorktree(project.path, { path, branch });
      await made.madeBeside();
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
    for (const ref of refs) await git.deleteRef(project.path, ref, held).catch(() => undefined);
  }
  return landed;
}
