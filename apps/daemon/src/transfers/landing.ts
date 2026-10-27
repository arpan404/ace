import { dirname } from "node:path";
import type { TransferCommit, WorkspaceId } from "@ace/protocol";
import type { IncomingRecord } from "./incoming-rows.ts";
import { Made } from "./landing-made.ts";
import { place } from "./landing-place.ts";
import {
  NeedsFullBundle,
  headRef,
  incomingRef,
  type Landed,
  type LandingDeps,
} from "./landing-types.ts";
import { TransferError } from "./ports.ts";

export {
  NeedsFullBundle,
  headRef,
  type ContinuedThread,
  type Landed,
  type LandingDeps,
  type TargetProjects,
  type TargetThreadStarter,
  type TransferParent,
} from "./landing-types.ts";

/**
 * Where one transfer's code lands on this machine (ADR 0101 "Where it lands"). A project this
 * machine already had (the same origin, or the copy an earlier transfer of the same project
 * made) keeps its checkout untouched unless it is clean, idle and on the same branch; a new
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

/**
 * Fetches the branch's commit (to `incomingRef`) and the changes from a bundle into a
 * repository. A bundle of only what origin lacks leaves out a branch origin already has: its
 * commit is there already, and only the changes travel.
 */
async function fetchInto(
  deps: LandingDeps,
  record: IncomingRecord,
  commit: TransferCommit,
  path: string,
  file: string,
  held: { directoryFd: number } | undefined,
): Promise<void> {
  const pinned = !commit.branch && commit.head ? headRef(record.transferId) : undefined;
  const head = commit.branch ? `refs/heads/${commit.branch}` : pinned;
  const changes = commit.changes ? [`${commit.changes.ref}:${commit.changes.ref}`] : [];
  const refspecs = [...(head ? [`${head}:${incomingRef(record.transferId)}`] : []), ...changes];
  if (!refspecs.length) return;
  try {
    await deps.git.fetchBundle(path, file, refspecs, held);
  } catch (error) {
    if (!head || !changes.length) throw error;
    await deps.git.fetchBundle(path, file, changes, held);
  }
}

/**
 * Whether the repository has what the transfer builds on: every commit the bundle needs, or,
 * with no bundle, the branch's commit itself.
 */
async function hasBase(
  deps: LandingDeps,
  path: string,
  file: string | undefined,
  commit: TransferCommit,
  held: { directoryFd: number } | undefined,
): Promise<boolean> {
  if (file) return deps.git.verifyBundle(path, file, held);
  return !commit.head || deps.git.hasCommit(path, commit.head, held);
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
  // Chosen when the transfer began; used only while it is still registered here.
  const reused = record.workspaceId
    ? deps.projects.list().find((project) => project.workspaceId === record.workspaceId)
    : undefined;
  if (record.method === "archive") {
    if (!file) throw new TransferError("transfer_invalid", "The folder's copy is missing.");
    if (reused) {
      // Sent again: only files the copy here lacks are added; everything it has stays its own.
      const merged = await deps.archive.mergeArchive(file, reused.path, { signal });
      signal.throwIfAborted();
      return place(
        deps,
        made,
        record,
        commit,
        { ...reused, fresh: false, kept: merged.skipped },
        signal,
      );
    }
    await made.reserve(begin.parent, begin.name);
    const path = made.path;
    await deps.archive.unpackArchive(file, made.mkdir(), { signal });
    signal.throwIfAborted();
    const workspaceId = await deps.projects.register({ key, path, name: begin.name });
    made.registeredAs(workspaceId);
    return place(
      deps,
      made,
      record,
      commit,
      { path, workspaceId, fresh: true, directory: made.handle },
      signal,
    );
  }
  if (record.method === "bundle") {
    if (!file) throw new TransferError("transfer_invalid", "The repository's bundle is missing.");
    if (reused) {
      // The whole repository again, into the project that has it: only its refs are fetched.
      await fetchInto(deps, record, commit, reused.path, file, undefined);
      signal.throwIfAborted();
      return place(deps, made, record, commit, { ...reused, fresh: false }, signal);
    }
    await made.reserve(begin.parent, begin.name);
    const path = made.path;
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
    const workspaceId = await deps.projects.register({ key, path, name: begin.name });
    made.registeredAs(workspaceId);
    return place(deps, made, record, commit, { path, workspaceId, fresh: true, directory }, signal);
  }
  let path: string;
  let workspaceId: WorkspaceId;
  const fresh = !reused;
  if (reused) {
    ({ path, workspaceId } = reused);
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
    if (!(await hasBase(deps, path, file, commit, held))) {
      // A clone here that fell behind origin: catching up is enough, when origin answers.
      if (!fresh)
        await deps.git.fetchOrigin(path, { signal }, deps.gitPolicy).catch(() => undefined);
      signal.throwIfAborted();
      if (!(await hasBase(deps, path, file, commit, held))) throw new NeedsFullBundle();
    }
    if (file) await fetchInto(deps, record, commit, path, file, held);
    // The branch's commit must be here now, from origin or the bundle.
    if (commit.head && !(await deps.git.hasCommit(path, commit.head, held)))
      throw new NeedsFullBundle();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof NeedsFullBundle) throw error;
    throw new NeedsFullBundle();
  }
  signal.throwIfAborted();
  return place(
    deps,
    made,
    record,
    commit,
    { path, workspaceId, fresh, directory: made.handle },
    signal,
  );
}
