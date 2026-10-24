import type { ProjectGitPolicy } from "@ace/git";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ThreadId,
  type IncomingTransfer,
  type TransferCommit,
  type WorkspaceId,
} from "@ace/protocol";
import type { IncomingRecord } from "./incoming-rows.ts";
import { freeFolder } from "./files.ts";
import { TransferError, type TransferArchive, type TransferGit } from "./ports.ts";

/** The target's projects, through the owner that registers them (ADR 0063). */
export interface TargetProjects {
  /** Registered projects with their folders. */
  list(): { workspaceId: WorkspaceId; path: string }[];
  /** A canonical folder inside the allowed roots for new projects; omitted: the default. */
  parent(requested: string | undefined): Promise<string>;
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

/** Starts the continued thread there; a retry with the same key returns the same thread. */
export interface TargetThreadStarter {
  start(input: {
    key: string;
    deviceId: string;
    workspaceId: WorkspaceId;
    /** The checkout for a local thread; for a worktree thread, the branch it starts from. */
    mode: "local" | "worktree";
    base?: string | undefined;
    thread: NonNullable<TransferCommit["thread"]>;
    machine: { hostId: string; name: string };
    /** Runs in the new thread's worktree before it is created. */
    prepare?: (path: string) => Promise<void>;
  }): Promise<string>;
}

export interface LandingDeps {
  git: TransferGit;
  gitPolicy?: ProjectGitPolicy | undefined;
  archive: TransferArchive;
  projects: TargetProjects;
  threads: TargetThreadStarter;
  /** Folders other transfers are filling right now. */
  held: Set<string>;
  /** Records what this transfer made, durably, before it is made. */
  made(change: { createdPath?: string; registeredId?: string }): void;
  /** Distinct per attempt, so a retried import never reuses an earlier attempt's receipt. */
  attempt: string;
}

/** The remote method needs origin's history there; asking for a full bundle instead. */
export class NeedsFullBundle extends Error {}

type Landed = NonNullable<IncomingTransfer["result"]>;

/**
 * Where one transfer's code lands on this machine (ADR 0099 "Where it lands"). A project this
 * machine already had keeps its checkout untouched unless it is clean on the same branch; a new
 * project is made from the bundle, the archive or a clone of origin.
 */
export async function landTransfer(
  deps: LandingDeps,
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
    path = await newFolder(deps, begin.parent, begin.name);
    await mkdir(path, { mode: 0o755 });
    await deps.archive.unpackArchive(file, path, { signal });
    workspaceId = await deps.projects.register({ key, path, name: begin.name });
    deps.made({ registeredId: workspaceId });
    return { workspaceId, path };
  }
  if (record.method === "bundle") {
    if (!file) throw new TransferError("transfer_invalid", "The repository's bundle is missing.");
    path = await newFolder(deps, begin.parent, begin.name);
    await deps.git.cloneFromBundle(
      {
        parent: dirname(path),
        path,
        bundle: file,
        origin: begin.remote?.url,
        ...(commit.branch ? { branch: commit.branch } : {}),
      },
      deps.gitPolicy,
    );
    workspaceId = await deps.projects.register({ key, path, name: begin.name });
    deps.made({ registeredId: workspaceId });
  } else {
    const reused = reusedId
      ? deps.projects.list().find((project) => project.workspaceId === reusedId)
      : undefined;
    if (reused) {
      ({ path, workspaceId } = reused);
      fresh = false;
    } else {
      if (!begin.remote) throw new TransferError("transfer_invalid", "No origin to clone.");
      const parent = await deps.projects.parent(begin.parent);
      path = await freeFolder(parent, begin.name, deps.held);
      deps.held.add(path);
      deps.made({ createdPath: path });
      try {
        workspaceId = await deps.projects.clone({
          key,
          parent,
          name: path.slice(parent.length + 1),
          url: begin.remote.url,
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new NeedsFullBundle();
      }
      deps.made({ registeredId: workspaceId });
    }
    try {
      if (file) {
        if (!(await deps.git.verifyBundle(path, file))) throw new NeedsFullBundle();
        await deps.git.fetchBundle(path, file, [
          ...(commit.branch
            ? [`refs/heads/${commit.branch}:refs/ace/incoming/${record.transferId}`]
            : []),
          ...(commit.changes ? [`${commit.changes.ref}:${commit.changes.ref}`] : []),
        ]);
      }
    } catch (error) {
      if (error instanceof NeedsFullBundle) throw error;
      throw new NeedsFullBundle();
    }
  }
  signal.throwIfAborted();
  return place(deps, record, commit, { path, workspaceId, fresh }, signal);
}

async function newFolder(deps: LandingDeps, requested: string | undefined, name: string) {
  const parent = await deps.projects.parent(requested);
  const path = await freeFolder(parent, name, deps.held);
  deps.held.add(path);
  deps.made({ createdPath: path });
  return path;
}

/** Puts the branch and the uncommitted changes in a checkout, and starts the thread. */
async function place(
  deps: LandingDeps,
  record: IncomingRecord,
  commit: TransferCommit,
  project: { path: string; workspaceId: WorkspaceId; fresh: boolean },
  signal: AbortSignal,
): Promise<Landed> {
  const { git } = deps;
  const machine = record.begin.origin.hostName;
  const wantsWorktree = commit.thread?.mode === "worktree";
  let branch = commit.branch;
  let inCheckout = true;
  if (branch && commit.head) {
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
  };
  let path = project.path;
  let threadId: string | undefined;
  if (commit.thread) {
    const worktree = wantsWorktree || !inCheckout;
    if (!worktree) await apply(path);
    threadId = await deps.threads.start({
      key: `transfer:${record.transferId}`,
      deviceId: record.deviceId,
      workspaceId: project.workspaceId,
      mode: worktree ? "worktree" : "local",
      base: branch,
      thread: commit.thread,
      machine: { hostId: record.begin.origin.hostId, name: machine },
      ...(worktree ? { prepare: apply } : {}),
    });
  } else if (inCheckout) {
    await apply(path);
  } else if (branch) {
    // The person's checkout there is busy: the branch gets its own folder beside it.
    path = await freeFolder(dirname(project.path), `${record.begin.name}-${branch}`, deps.held);
    deps.held.add(path);
    deps.made({ createdPath: path });
    await git.addBranchWorktree(project.path, { path, branch });
    await apply(path);
  }
  if (changes) await git.deleteRef(project.path, changes.ref).catch(() => undefined);
  await git
    .deleteRef(project.path, `refs/ace/incoming/${record.transferId}`)
    .catch(() => undefined);
  return {
    workspaceId: project.workspaceId,
    path,
    ...(branch ? { branch } : {}),
    ...(threadId ? { threadId: ThreadId.parse(threadId) } : {}),
  };
}
