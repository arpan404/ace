import { mkdir } from "node:fs/promises";
import type { Repository } from "./repository.ts";
import { applyChanges } from "./transfer-apply.ts";
import { createBundle, fetchBundle, verifyBundle } from "./transfer-bundle.ts";
import { captureChanges } from "./transfer-capture.ts";
import {
  addBranchWorktree,
  checkoutBranch,
  checkoutState,
  fastForward,
  landingBranch,
} from "./transfer-checkout.ts";
import { cloneFromBundle, type BundleCloneOptions } from "./transfer-clone.ts";
import { ignoredPaths } from "./transfer-ignored.ts";
import { bundleRefs, createBranch, deleteRef, transferOrigin } from "./transfer-refs.ts";

/**
 * Git steps for moving a checkout to another machine (ADR 0099): the sender captures changes
 * and writes bundles; the receiver clones or fetches them and lands branches and changes.
 * Each call runs under the checkout's mutation lease, like every other Git writer.
 */
export class GitTransfer {
  private readonly repository: Repository;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  private async within<T>(path: string, operation: (root: string) => Promise<T>): Promise<T> {
    const root = await this.repository.root(path);
    return this.repository.serial(root, () => operation(root));
  }

  /** `origin`'s fetch URL and its `normalizeRemoteUrl` key; undefined without an origin. */
  transferOrigin(path: string) {
    return this.within(path, (root) => transferOrigin(this.repository, root));
  }
  /** Uncommitted changes as a commit on HEAD at `ref`; checkout and index untouched. */
  captureChanges(path: string, options: { ref: string; message?: string | undefined }) {
    return this.within(path, (root) => captureChanges(this.repository, root, options));
  }
  /** Paths Git ignores; a whole ignored folder once, ending in `/`. See `ignoredPaths`. */
  ignoredPaths(path: string): Promise<string[]> {
    return this.within(path, (root) => ignoredPaths(this.repository, root));
  }
  bundleRefs(path: string) {
    return this.within(path, (root) => bundleRefs(this.repository, root));
  }
  createBundle(
    path: string,
    options: { file: string; refs: readonly string[]; exclude?: readonly string[] | undefined },
  ) {
    return this.within(path, (root) => createBundle(this.repository, root, options));
  }
  deleteRef(path: string, ref: string): Promise<void> {
    return this.within(path, (root) => deleteRef(this.repository, root, ref));
  }
  createBranch(path: string, name: string, commit: string): Promise<void> {
    return this.within(path, (root) => createBranch(this.repository, root, name, commit));
  }

  /** A new repository at `path` from a bundle, with no remote; see `cloneFromBundle`. */
  async cloneFromBundle(input: BundleCloneOptions): Promise<{ branch: string | undefined }> {
    if (input.directoryFd === undefined) await mkdir(input.path);
    return this.repository.serial(input.path, () => cloneFromBundle(this.repository, input));
  }
  verifyBundle(path: string, bundle: string): Promise<boolean> {
    return this.within(path, (root) => verifyBundle(this.repository, root, bundle));
  }
  fetchBundle(path: string, bundle: string, refspecs: readonly string[]): Promise<void> {
    return this.within(path, (root) => fetchBundle(this.repository, root, bundle, refspecs));
  }
  applyChanges(path: string, commit: string): Promise<void> {
    return this.within(path, (root) => applyChanges(this.repository, root, commit));
  }
  landingBranch(path: string, options: { branch: string; commit: string; machine: string }) {
    return this.within(path, (root) => landingBranch(this.repository, root, options));
  }
  checkoutState(path: string) {
    return this.within(path, (root) => checkoutState(this.repository, root));
  }
  checkoutBranch(path: string, options: { name: string; commit: string }): Promise<void> {
    return this.within(path, (root) => checkoutBranch(this.repository, root, options));
  }
  fastForward(path: string, commit: string): Promise<void> {
    return this.within(path, (root) => fastForward(this.repository, root, commit));
  }
  /** Serialises inside `createWorktree`. */
  addBranchWorktree(repo: string, options: { path: string; branch: string }) {
    return addBranchWorktree(this.repository, repo, options);
  }
}
