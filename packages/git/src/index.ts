import { GitCli } from "./cli.ts";
import { tmpdir } from "node:os";
import { createCheckpoint, deleteCheckpoints, listCheckpoints } from "./checkpoints.ts";
import { diff } from "./diff.ts";
import { serial } from "./lock.ts";
import { Repository } from "./repository.ts";
import { restoreCheckpoint } from "./restore.ts";
import { createWorktree, removeWorktree, type CreateWorktreeOptions } from "./worktrees.ts";
import { GitError } from "./types.ts";
import type { Checkpoint, DiffSide, GitOptions } from "./types.ts";

export { GitError } from "./types.ts";
export type * from "./types.ts";
export type { CreateWorktreeOptions } from "./worktrees.ts";

export class GitService {
  private readonly repository: Repository;
  private readonly maxPatchBytes: number;

  constructor(options: GitOptions = {}) {
    this.repository = new Repository(
      new GitCli(options),
      options.now ?? (() => new Date()),
      options.tempDirectory ?? tmpdir(),
    );
    this.maxPatchBytes = options.maxPatchBytes ?? 1024 * 1024;
  }

  async repositoryInfo(repo: string) {
    const root = await this.repository.root(repo);
    return serial(root, () => this.repository.info(root));
  }

  async status(worktree: string) {
    const root = await this.repository.root(worktree);
    return serial(root, () => this.repository.status(root));
  }

  createWorktree(options: CreateWorktreeOptions) {
    return createWorktree(this.repository, options);
  }

  async listWorktrees(repo: string) {
    const root = await this.repository.root(repo);
    return serial(root, () => this.repository.worktrees(root));
  }

  removeWorktree(options: { repo: string; path: string; force?: boolean }) {
    return removeWorktree(this.repository, options);
  }

  async pruneWorktrees(repo: string): Promise<void> {
    const root = await this.repository.root(repo);
    await serial(root, () =>
      this.repository.cli.call(root, ["worktree", "prune", "--expire=now"], { write: true }),
    );
  }

  async createCheckpoint(options: {
    worktree: string;
    threadId: string;
    label: string;
  }): Promise<Checkpoint> {
    const root = await this.repository.root(options.worktree);
    return serial(root, () =>
      createCheckpoint(this.repository, root, options.threadId, options.label),
    );
  }

  async listCheckpoints(options: { repo: string; threadId: string }): Promise<Checkpoint[]> {
    const root = await this.repository.root(options.repo);
    return serial(root, () => listCheckpoints(this.repository, root, options.threadId));
  }

  async deleteCheckpoints(options: { repo: string; threadId: string }) {
    const root = await this.repository.root(options.repo);
    return serial(root, () => deleteCheckpoints(this.repository, root, options.threadId));
  }

  async diff(options: { worktree: string; from: DiffSide; to: DiffSide; maxPatchBytes?: number }) {
    const root = await this.repository.root(options.worktree);
    return serial(root, () =>
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
    return serial(root, () => this.repository.commit(root, options.ref));
  }

  async applyPatch(options: { worktree: string; patch: string }): Promise<void> {
    if (!options.patch || Buffer.byteLength(options.patch) > 65_536)
      throw new GitError("invalid_argument", "Patch must be between 1 and 65536 bytes");
    const root = await this.repository.root(options.worktree);
    await serial(root, async () => {
      const args = ["apply", "--whitespace=nowarn"];
      await this.repository.cli.call(root, [...args, "--check", "-"], { input: options.patch });
      await this.repository.cli.call(root, [...args, "-"], { input: options.patch, write: true });
    });
  }

  async restoreCheckpoint(options: { worktree: string; checkpoint: string }) {
    const root = await this.repository.root(options.worktree);
    return serial(root, () => restoreCheckpoint(this.repository, root, options.checkpoint));
  }
}
