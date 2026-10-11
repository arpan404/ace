import {
  cloneRepository,
  initRepository,
  initialBranch,
  defaultBranch,
  projectInfo,
  type CloneOptions,
  type ProjectGitPolicy,
} from "./projects.ts";
import { integrateRevision } from "./integration.ts";
import { commitChanges, pushBranch, listBranches, switchBranch } from "./actions.ts";
import { changedFiles, changeSummary } from "./changed-files.ts";
import { deleteBranch, type BranchCleanup } from "./branch-cleanup.ts";
import { GitCli } from "./cli.ts";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createCheckpoint, deleteCheckpoints, listCheckpoints } from "./checkpoints.ts";
import { diff } from "./diff.ts";
import { Repository } from "./repository.ts";
import { restoreCheckpoint } from "./restore.ts";
import { createWorktree, removeWorktree, type CreateWorktreeOptions } from "./worktrees.ts";
import { GitError } from "./types.ts";
import {
  branchHead,
  branchRefs,
  fetchBranch,
  type BranchRefs,
  type FetchBranchOptions,
} from "./remote-branches.ts";
import type { ChangedFile, Checkpoint, DiffSide, GitOptions } from "./types.ts";

export { validateCloneUrl } from "./projects.ts";
export type { CloneOptions, ProjectGitPolicy } from "./projects.ts";
export { GitError, isMutationUnavailable } from "./types.ts";
export { spawnGitProcess } from "./process-runtime.ts";
export type * from "./types.ts";
export type { MutationState } from "./mutation-state.ts";
export type { CreateWorktreeOptions, WorktreeProgress } from "./worktrees.ts";
export type { BranchRefs, FetchBranchOptions } from "./remote-branches.ts";

export class GitService {
  private readonly repository: Repository;
  private readonly maxPatchBytes: number;

  constructor(options: GitOptions = {}) {
    this.repository = new Repository(
      new GitCli(options),
      options.now ?? (() => new Date()),
      options.tempDirectory ?? tmpdir(),
      options.checkpointCounterCacheSize,
    );
    this.maxPatchBytes = options.maxPatchBytes ?? 1024 * 1024;
  }

  /** Bounded shutdown. Unconfirmed cleanup remains durably quarantined. */
  close(): Promise<void> {
    return this.repository.cli.close();
  }

  /** Admission check for host operations that can mutate a workspace. */
  assertMutationAvailable(worktree: string) {
    return this.repository.cli.assertMutationAvailable(worktree);
  }
  /** Does not invoke Git, so quarantine remains inspectable after restart. */
  mutationState(worktree: string) {
    return this.repository.cli.mutationState(worktree);
  }
  /** Reconcile with a trusted supervisor. Unconfirmed receipts never release leases. */
  recoverCleanup(worktree: string) {
    return this.repository.cli.recoverCleanup(worktree);
  }

  async clone(input: CloneOptions, policy: ProjectGitPolicy = {}): Promise<void> {
    if (input.directoryFd === undefined) await mkdir(input.path);
    return this.repository.serial(input.path, () =>
      cloneRepository(this.repository.cli, input, policy),
    );
  }
  init(path: string, branch?: string, directoryFd?: number): Promise<void> {
    return this.repository.serial(path, () =>
      initRepository(this.repository.cli, path, branch, directoryFd, this.repository.now),
    );
  }
  initialBranch(path: string, directoryFd?: number, signal?: AbortSignal): Promise<string> {
    return initialBranch(this.repository.cli, path, directoryFd, signal);
  }
  defaultBranch(path: string, directoryFd?: number, signal?: AbortSignal): Promise<string> {
    return defaultBranch(this.repository.cli, path, directoryFd, signal);
  }
  projectInfo(path: string, directoryFd?: number, signal?: AbortSignal) {
    return projectInfo(this.repository.cli, path, directoryFd, signal);
  }

  resourceUsage(): { checkpointCounters: number; activeCalls: number } {
    return {
      checkpointCounters: this.repository.numbers.size,
      activeCalls: this.repository.cli.activeCalls,
    };
  }

  integrate(input: { worktree: string; revision: string; key: string }) {
    return integrateRevision(this.repository, input);
  }

  /** Commit every change, or only `paths`; other changes stay as they were. */
  commit(options: {
    worktree: string;
    message: string;
    expectedHead: string | null;
    paths?: readonly string[] | undefined;
  }): Promise<string> {
    return commitChanges(this.repository, options);
  }
  /** The files `git status` reports, with lines changed against HEAD (first `limit`). */
  changedFiles(
    worktree: string,
    limit = 500,
  ): Promise<{ files: ChangedFile[]; truncated: boolean }> {
    return changedFiles(this.repository, worktree, limit);
  }
  changeSummary(worktree: string) {
    return changeSummary(this.repository, worktree);
  }
  push(options: { worktree: string; remote: string }): Promise<void> {
    return pushBranch(this.repository, options);
  }
  switchBranch(options: {
    worktree: string;
    branch: string;
    allowUncommitted: boolean;
  }): Promise<void> {
    return switchBranch(this.repository, options);
  }
  branches(worktree: string): Promise<{ branches: string[]; truncated: boolean }> {
    return listBranches(this.repository, worktree);
  }
  /** Local branches with their upstreams, and remotes' branches; no network. */
  branchRefs(worktree: string): Promise<BranchRefs> {
    return branchRefs(this.repository, worktree);
  }
  /** A local (or, with `remote`, remote-tracking) branch's commit; undefined when missing. */
  branchHead(options: {
    repo: string;
    branch: string;
    remote?: string | undefined;
  }): Promise<string | undefined> {
    return branchHead(this.repository, options);
  }
  /** Fetch one branch into its remote-tracking ref only, bounded by `timeoutMs`. */
  fetchBranch(options: FetchBranchOptions): Promise<void> {
    return fetchBranch(this.repository, options);
  }
  async repositoryInfo(repo: string) {
    const root = await this.repository.root(repo);
    return this.repository.serial(root, () => this.repository.info(root));
  }

  async status(worktree: string) {
    const root = await this.repository.root(worktree);
    return this.repository.serial(root, () => this.repository.status(root));
  }

  /** Project setup remains under the same supervised mutation boundary as Git writers. */
  async setupWorktree(options: {
    worktree: string;
    command: string;
    stderr?: (chunk: Buffer) => void;
    signal?: AbortSignal;
  }) {
    const root = await this.repository.root(options.worktree);
    await this.repository.serial(root, () =>
      this.repository.cli.call(
        root,
        ["-c", `alias.ace-worktree-setup=!${options.command}`, "ace-worktree-setup"],
        {
          write: true,
          timeoutMs: 600_000,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.stderr ? { stderr: options.stderr, consume: options.stderr } : {}),
        },
      ),
    );
  }

  createWorktree(options: CreateWorktreeOptions) {
    return createWorktree(this.repository, options);
  }

  async listWorktrees(repo: string) {
    const root = await this.repository.root(repo);
    return this.repository.serial(root, () => this.repository.worktrees(root));
  }

  removeWorktree(options: { repo: string; path: string; force?: boolean }) {
    return removeWorktree(this.repository, options);
  }

  /** Remove only an unchanged branch created by a host-owned worktree operation. */
  deleteBranch(options: BranchCleanup): Promise<void> {
    return deleteBranch(this.repository, options);
  }

  async pruneWorktrees(repo: string): Promise<void> {
    const root = await this.repository.root(repo);
    await this.repository.serial(root, () =>
      this.repository.cli.call(root, ["worktree", "prune", "--expire=now"], { write: true }),
    );
  }

  async createCheckpoint(options: {
    worktree: string;
    threadId: string;
    label: string;
  }): Promise<Checkpoint> {
    const root = await this.repository.root(options.worktree);
    return this.repository.serial(root, () =>
      createCheckpoint(this.repository, root, options.threadId, options.label),
    );
  }

  async listCheckpoints(options: { repo: string; threadId: string }): Promise<Checkpoint[]> {
    const root = await this.repository.root(options.repo);
    return this.repository.serial(root, () =>
      listCheckpoints(this.repository, root, options.threadId),
    );
  }

  async deleteCheckpoints(options: { repo: string; threadId: string }) {
    const root = await this.repository.root(options.repo);
    return this.repository.serial(root, () =>
      deleteCheckpoints(this.repository, root, options.threadId),
    );
  }

  async diff(options: { worktree: string; from: DiffSide; to: DiffSide; maxPatchBytes?: number }) {
    const root = await this.repository.root(options.worktree);
    return this.repository.serial(root, () =>
      diff(
        this.repository,
        root,
        options.from,
        options.to,
        options.maxPatchBytes ?? this.maxPatchBytes,
      ),
    );
  }

  async resolveCommit(options: { worktree: string; ref: string }): Promise<string> {
    const root = await this.repository.root(options.worktree);
    return this.repository.serial(root, () => this.repository.commit(root, options.ref));
  }

  async applyPatch(options: { worktree: string; patch: string }): Promise<void> {
    if (!options.patch || Buffer.byteLength(options.patch) > 65_536)
      throw new GitError("invalid_argument", "Patch must be between 1 and 65536 bytes");
    const root = await this.repository.root(options.worktree);
    await this.repository.serial(root, async () => {
      const args = ["apply", "--whitespace=nowarn"];
      await this.repository.cli.call(root, [...args, "--check", "-"], { input: options.patch });
      await this.repository.cli.call(root, [...args, "-"], { input: options.patch, write: true });
    });
  }

  async restoreCheckpoint(options: { worktree: string; checkpoint: string }) {
    const root = await this.repository.root(options.worktree);
    return this.repository.serial(root, () =>
      restoreCheckpoint(this.repository, root, options.checkpoint),
    );
  }
}
