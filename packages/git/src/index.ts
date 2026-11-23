export { WorktreeRemovalRefused } from "./worktree-cleanup.ts";
import { excludeAcePrivate } from "./ace-private.ts";
import { backupWorktree } from "./worktree-backup.ts";
import {
  inspectWorktreeCleanup,
  worktreeMetadata,
  cleanupWorktree,
  type WorktreeCleanupInput,
} from "./worktree-cleanup.ts";
export type { WorktreeCleanupInput, WorktreeCleanupState } from "./worktree-cleanup.ts";
import { writingContext } from "./writing-context.ts";
import { SourceControlContext, type SourceControlSelection } from "@ace/protocol";
import {
  publicationInfo,
  attachPublicationOrigin,
  pushPublication,
  type PublicationGitInput,
} from "./publication.ts";
import {
  cloneRepository,
  initRepository,
  initialBranch,
  defaultBranch,
  projectInfo,
  type CloneOptions,
  type ProjectGitPolicy,
} from "./projects.ts";
import { forgetIntegrations, integrateRevision } from "./integration.ts";
import { commitChanges, pushBranch, probeRemote, listBranches, switchBranch } from "./actions.ts";
import { pushLeasedRefs, type LeasedPushOptions } from "./leased-push.ts";
import {
  continueStackReplay,
  replayStackLayers,
  restoreStackBranches,
  type LayerReplay,
  type StackReplayOptions,
} from "./stack-sync.ts";
import {
  changedFiles,
  changeSummary,
  checkoutSummary,
  sourceControlState,
  sourceControlStatus,
} from "./changed-files.ts";
import { fetchRemote, stagePaths, unstagePaths } from "./source-control-ops.ts";
import {
  abortMerge,
  commitMerge,
  readConflicts,
  startMerge,
  takeSide,
  writeResolution,
} from "./merge-conflicts.ts";
import { deleteBranch, type BranchCleanup } from "./branch-cleanup.ts";
import { GitCli, textOutput } from "./cli.ts";
import { gitParts, type GitPart } from "@ace/provider-kit/native-switches";
import { appendDigest, digestLogOn, ensureGitAddon, gitFallbackCounts } from "./native-common.ts";
import { runNativeCore, runNativeCoreSync } from "./native-core.ts";
import { runNativeReads } from "./native-reads.ts";
import { runNativeWrites } from "./native-writes.ts";
import { runNativeCheckpoints } from "./native-checkpoints.ts";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { snapshot, createCheckpoint, deleteCheckpoints, listCheckpoints } from "./checkpoints.ts";
import { diff } from "./diff.ts";
import {
  diffCommit,
  fileLog,
  type CommitDiffOptions,
  type FileLogOptions,
  type FileLogResult,
} from "./history.ts";
import { ReadGate } from "./read-gate.ts";
import { readRevisionLines, type RevisionLineOptions } from "./revision-lines.ts";
import { Repository } from "./repository.ts";
import { restoreCheckpoint } from "./restore.ts";
import { createWorktree, removeWorktree, type CreateWorktreeOptions } from "./worktrees.ts";
import { GitError } from "./types.ts";
import { GitTransfer } from "./transfer-service.ts";
import {
  branchHead,
  branchRefs,
  fetchBranch,
  fetchPrHead,
  type FetchPrHeadOptions,
  type BranchRefs,
  type FetchBranchOptions,
} from "./remote-branches.ts";
import type {
  ChangedFile,
  Checkpoint,
  DiffResult,
  DiffSide,
  GitOptions,
  PushOptions,
} from "./types.ts";

export { publicationOriginMatches } from "./publication.ts";
export { executionKeyQuery, nonExecutingEnv } from "./non-executing.ts";
export { validateCloneUrl } from "./projects.ts";
export { validateRepoPaths } from "./source-control-ops.ts";
import { remoteDefaultBranch, type RemoteDefaultBranchOptions } from "./remote-default-branch.ts";
export type { RemoteDefaultBranchOptions } from "./remote-default-branch.ts";
export { publicationRemote } from "./publication-remote.ts";
export type { CloneOptions, ProjectGitPolicy } from "./projects.ts";
export { GitError, gitFailureCodes, isMutationUnavailable } from "./types.ts";
export { spawnGitProcess } from "./process-runtime.ts";
export type * from "./types.ts";
export type { MutationState } from "./mutation-state.ts";
export type {
  LeasedPushOptions,
  LeasedPushRef,
  LeasedPushResult,
  LeasedRefUpdate,
} from "./leased-push.ts";
export type { CreateWorktreeOptions, WorktreeProgress } from "./worktrees.ts";
export type { LayerReplay, StackReplayResult } from "./stack-sync.ts";
export type { MergeStart } from "./merge-conflicts.ts";
export type { RevisionLineOptions } from "./revision-lines.ts";
export type { CommitDiffOptions, FileLogOptions, FileLogResult } from "./history.ts";
export type { BranchRefs, FetchBranchOptions, FetchPrHeadOptions } from "./remote-branches.ts";

export { GitTransfer } from "./transfer-service.ts";
export { normalizeRemoteUrl } from "./remote-url.ts";
export { landingBranchName, machineSlug } from "./transfer-branch-name.ts";
export type { LandingBranch } from "./transfer-branch-name.ts";
export type { BundleCloneOptions } from "./transfer-clone.ts";
export type { BundleRefs } from "./transfer-refs.ts";
export { gitAbove } from "./transfer-source.ts";
export type { SourceCheckout } from "./transfer-source.ts";
export type { CheckoutFacts } from "./checkout-facts.ts";
export type { CheckoutState } from "./transfer-checkout.ts";

export class GitService {
  private readonly repository: Repository;
  private readonly maxPatchBytes: number;
  /** History reads (a file's log, a commit's patch) that may run at once (`ReadGate`). */
  private readonly historyReads = new ReadGate(2);
  /** Moving work to another machine (ADR 0101). */
  readonly transfer: GitTransfer;
  /** The git parts served natively by this instance, read once from `ACE_GIT`. */
  private readonly gitNative: ReadonlySet<GitPart>;

  constructor(options: GitOptions = {}) {
    this.gitNative = gitParts();
    // With the switch on and the addon missing, fail at startup; never fall back for that.
    ensureGitAddon(this.gitNative);
    this.repository = new Repository(
      new GitCli(options),
      options.now ?? (() => new Date()),
      options.tempDirectory ?? tmpdir(),
      {
        checkpointCounterCacheSize: options.checkpointCounterCacheSize,
        nativeRefsAllowed:
          options.gitBinary === undefined && options.processRuntime?.spawn === undefined,
      },
    );
    this.maxPatchBytes = options.maxPatchBytes ?? 1024 * 1024;
    this.transfer = new GitTransfer(this.repository, this.gitNative);
  }

  /** Protect a PR-controlled tree for every subsequent call, including nested paths. */
  protectWorktree(path: string): void {
    if (this.gitNative.has("core"))
      return runNativeCoreSync("protectWorktree", () => this.repository.cli.protectWorktree(path));
    this.repository.cli.protectWorktree(path);
  }
  /** Call only after the protected physical checkout has been removed. */
  forgetWorktree(path: string): void {
    if (this.gitNative.has("core"))
      return runNativeCoreSync("forgetWorktree", () => this.repository.cli.forgetWorktree(path));
    this.repository.cli.forgetWorktree(path);
  }

  /** Nested local Git calls suppress hooks, fsmonitor, filters and all transports.
   * Explicit user-authorized push/fetch separately restore the user's trusted helpers. */
  nonExecuting<T>(operation: () => Promise<T>): Promise<T> {
    if (this.gitNative.has("core"))
      return runNativeCore("nonExecuting", () => this.repository.cli.nonExecuting(operation));
    return this.repository.cli.nonExecuting(operation);
  }
  /** A commit or push the person asked for runs their hooks and signing, as their Git would. */
  asPerson<T>(operation: () => Promise<T>): Promise<T> {
    if (this.gitNative.has("core"))
      return runNativeCore("asPerson", () => this.repository.cli.asPerson(operation));
    return this.repository.cli.asPerson(operation);
  }
  /** `asPerson` in a checkout of someone else's code: hooks inside that checkout never run. */
  asReviewer<T>(operation: () => Promise<T>): Promise<T> {
    if (this.gitNative.has("core"))
      return runNativeCore("asReviewer", () => this.repository.cli.asReviewer(operation));
    return this.repository.cli.asReviewer(operation);
  }
  /** Whether the reviewer's own commit in this checkout runs hooks (see `asReviewer`). */
  async reviewerHooks(worktree: string): Promise<"run" | "skipped"> {
    const run = async (): Promise<"run" | "skipped"> => {
      const root = await this.repository.root(worktree);
      return (await this.repository.cli.hooksInsideCheckout(root)) ? "skipped" : "run";
    };
    if (this.gitNative.has("core")) return runNativeCore("reviewerHooks", run);
    return run();
  }
  /** Read the remote's branches through the transport a push would use; throws Git's category. */
  probeRemote(options: { worktree: string; remote: string; signal?: AbortSignal }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("probeRemote", () => probeRemote(this.repository, options));
    return probeRemote(this.repository, options);
  }

  /** Bounded shutdown. Unconfirmed cleanup remains durably quarantined. */
  close(): Promise<void> {
    if (this.gitNative.has("core"))
      return runNativeCore("close", () => this.repository.cli.close());
    return this.repository.cli.close();
  }

  /** Admission check for host operations that can mutate a workspace. */
  assertMutationAvailable(worktree: string) {
    if (this.gitNative.has("core"))
      return runNativeCoreSync("assertMutationAvailable", () =>
        this.repository.cli.assertMutationAvailable(worktree),
      );
    return this.repository.cli.assertMutationAvailable(worktree);
  }
  /** Does not invoke Git, so quarantine remains inspectable after restart. */
  mutationState(worktree: string) {
    if (this.gitNative.has("core"))
      return runNativeCoreSync("mutationState", () => this.repository.cli.mutationState(worktree));
    return this.repository.cli.mutationState(worktree);
  }
  /** Reconcile with a trusted supervisor. Unconfirmed receipts never release leases. */
  recoverCleanup(worktree: string) {
    if (this.gitNative.has("core"))
      return runNativeCore("recoverCleanup", () => this.repository.cli.recoverCleanup(worktree));
    return this.repository.cli.recoverCleanup(worktree);
  }
  /**
   * "Clear stale lock", after a person confirms: retires each lease fencing `worktree` whose
   * owning daemon is definitively gone. Leases whose owner may be alive stay and keep fencing.
   */
  clearStaleLeases(worktree: string) {
    if (this.gitNative.has("core"))
      return runNativeCore("clearStaleLeases", () =>
        this.repository.cli.clearStaleLeases(worktree),
      );
    return this.repository.cli.clearStaleLeases(worktree);
  }
  /**
   * Self-healing, for startup and periodic sweeps: retire every lease whose work provably ended
   * and remove Git lock files that no live Git process holds. Returns the removed lock files.
   */
  heal(worktree: string) {
    if (this.gitNative.has("core"))
      return runNativeCore("heal", () => this.repository.cli.heal(worktree));
    return this.repository.cli.heal(worktree);
  }
  /**
   * `heal` for every checkout of a periodic sweep: one process listing for the whole sweep,
   * taken only when some lock is old enough to remove, and each repository's locks cleared once
   * however many of its worktrees are listed. A checkout that can't be healed goes to `failed`.
   */
  healAll(worktrees: readonly string[], failed: (worktree: string, error: unknown) => void) {
    if (this.gitNative.has("core"))
      return runNativeCore("healAll", () => this.repository.cli.healAll(worktrees, failed));
    return this.repository.cli.healAll(worktrees, failed);
  }

  async clone(input: CloneOptions, policy: ProjectGitPolicy = {}): Promise<void> {
    const run = async (): Promise<void> => {
      if (input.directoryFd === undefined) await mkdir(input.path);
      return this.repository.serial(input.path, () =>
        cloneRepository(this.repository.cli, input, policy),
      );
    };
    if (this.gitNative.has("writes")) return runNativeWrites("clone", run);
    return run();
  }
  init(path: string, branch?: string, directoryFd?: number): Promise<void> {
    const run = (): Promise<void> =>
      this.repository.serial(path, () =>
        initRepository(this.repository.cli, path, branch, directoryFd, this.repository.now),
      );
    if (this.gitNative.has("writes")) return runNativeWrites("init", run);
    return run();
  }
  initialBranch(path: string, directoryFd?: number, signal?: AbortSignal): Promise<string> {
    if (this.gitNative.has("reads"))
      return runNativeReads("initialBranch", () =>
        initialBranch(this.repository.cli, path, directoryFd, signal),
      );
    return initialBranch(this.repository.cli, path, directoryFd, signal);
  }
  defaultBranch(path: string, directoryFd?: number, signal?: AbortSignal): Promise<string> {
    if (this.gitNative.has("reads"))
      return runNativeReads("defaultBranch", () =>
        defaultBranch(this.repository.cli, path, directoryFd, signal),
      );
    return defaultBranch(this.repository.cli, path, directoryFd, signal);
  }
  projectInfo(path: string, directoryFd?: number, signal?: AbortSignal) {
    if (this.gitNative.has("reads"))
      return runNativeReads("projectInfo", () =>
        projectInfo(this.repository.cli, path, directoryFd, signal),
      );
    return projectInfo(this.repository.cli, path, directoryFd, signal);
  }

  publicationInfo(input: PublicationGitInput) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("publicationInfo", () => publicationInfo(this.repository, input));
    return publicationInfo(this.repository, input);
  }
  attachPublicationOrigin(input: PublicationGitInput & { url: string }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("attachPublicationOrigin", () =>
        attachPublicationOrigin(this.repository, input),
      );
    return attachPublicationOrigin(this.repository, input);
  }
  pushPublication(input: PublicationGitInput & { url: string }, policy?: ProjectGitPolicy) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("pushPublication", () =>
        pushPublication(this.repository, input, policy),
      );
    return pushPublication(this.repository, input, policy);
  }
  resourceUsage(): {
    checkpointCounters: number;
    activeCalls: number;
    nativeFallbacks: Record<string, number>;
  } {
    return {
      checkpointCounters: this.repository.numbers.size,
      activeCalls: this.repository.cli.activeCalls,
      nativeFallbacks: gitFallbackCounts(),
    };
  }

  integrate(input: { worktree: string; revision: string; key: string }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("integrate", () => integrateRevision(this.repository, input));
    return integrateRevision(this.repository, input);
  }
  /** Drop the receipts `integrate` kept under keys starting with `prefix`. */
  forgetIntegrations(input: { repo: string; prefix: string }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("forgetIntegrations", () =>
        forgetIntegrations(this.repository, input),
      );
    return forgetIntegrations(this.repository, input);
  }

  async writingContext(worktree: string, selection: SourceControlSelection) {
    const run = async () => {
      const root = await this.repository.root(worktree);
      return this.repository.serial(root, () => writingContext(this.repository, root, selection));
    };
    if (this.gitNative.has("writes")) return runNativeWrites("writingContext", run);
    return run();
  }

  /** Validate and publish under the checkout's mutation lease. The callback must not reenter Git. */
  async withWritingGuard<T>(
    worktree: string,
    selection: SourceControlSelection,
    fingerprint: string,
    publish: () => Promise<T>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const expected = SourceControlContext.shape.fingerprint.parse(fingerprint);
      const root = await this.repository.root(worktree);
      const outcome = await this.repository.serial(
        root,
        async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
          const context = await writingContext(this.repository, root, selection);
          if (context.fingerprint !== expected)
            throw new GitError(
              "head_moved",
              "Draft changes moved; regenerate or discard the draft",
            );
          // The Git lease translates Git failures. Preserve the publisher's own error categories.
          try {
            return { ok: true, value: await publish() };
          } catch (error) {
            return { ok: false, error };
          }
        },
      );
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    };
    if (this.gitNative.has("writes")) return runNativeWrites("withWritingGuard", run);
    return run();
  }

  /** Commit every change, only `paths`, or only what is already staged. */
  commit(options: {
    worktree: string;
    message: string;
    expectedHead: string | null;
    draftFingerprint?: string | undefined;
    paths?: readonly string[] | undefined;
    stagedOnly?: boolean | undefined;
    stageListed?: readonly string[] | undefined;
  }): Promise<string> {
    const run = async (): Promise<string> => {
      const sha = await commitChanges(this.repository, options);
      // HEAD's tree after the commit is the content identity the digest gate
      // compares; the commit sha embeds the clock and never matches. Read
      // only in gate runs: proof and benchmark runs spawn nothing extra.
      if (digestLogOn()) {
        const root = await this.repository.root(options.worktree);
        const tree = textOutput(
          await this.repository.cli.call(root, ["rev-parse", "HEAD^{tree}"]),
        ).trim();
        appendDigest("commit", `commit:${tree}`);
      } else {
        appendDigest("commit", "commit");
      }
      return sha;
    };
    if (this.gitNative.has("writes")) return runNativeWrites("commit", run);
    return run();
  }
  /** The files `git status` reports, with lines changed against HEAD (first `limit`). */
  changedFiles(
    worktree: string,
    limit = 500,
  ): Promise<{ files: ChangedFile[]; truncated: boolean }> {
    if (this.gitNative.has("reads"))
      return runNativeReads("changedFiles", () => changedFiles(this.repository, worktree, limit));
    return changedFiles(this.repository, worktree, limit);
  }
  /** Staged/unstaged/untracked/conflicted sections + branch/ahead/behind from one status call. */
  sourceControlState(worktree: string, limit = 500) {
    if (this.gitNative.has("reads"))
      return runNativeReads("sourceControlState", () =>
        sourceControlState(this.repository, worktree, limit),
      );
    return sourceControlState(this.repository, worktree, limit);
  }
  /** Full source control status (staged/unstaged/untracked/conflicted + branch ahead/behind). */
  sourceControlStatus(worktree: string, limit = 500) {
    if (this.gitNative.has("reads"))
      return runNativeReads("sourceControlStatus", () =>
        sourceControlStatus(this.repository, worktree, limit),
      );
    return sourceControlStatus(this.repository, worktree, limit);
  }
  /** Stage specific paths, or all changes when `paths` is omitted. */
  stage(options: { worktree: string; paths?: readonly string[] | undefined }): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("stage", () => stagePaths(this.repository, options));
    return stagePaths(this.repository, options);
  }
  /** Unstage specific paths, or all staged changes when `paths` is omitted. */
  unstage(options: { worktree: string; paths?: readonly string[] | undefined }): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("unstage", () => unstagePaths(this.repository, options));
    return unstagePaths(this.repository, options);
  }
  changeSummary(worktree: string) {
    if (this.gitNative.has("reads"))
      return runNativeReads("changeSummary", () => changeSummary(this.repository, worktree));
    return changeSummary(this.repository, worktree);
  }
  /** `repositoryInfo` and `changeSummary` of one checkout, from a single status read. */
  checkoutSummary(worktree: string) {
    if (this.gitNative.has("reads"))
      return runNativeReads("checkoutSummary", () => checkoutSummary(this.repository, worktree));
    return checkoutSummary(this.repository, worktree);
  }
  push(options: PushOptions): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("push", () => pushBranch(this.repository, options));
    return pushBranch(this.repository, options);
  }
  /** Fetch a remote's branches into remote-tracking refs only; never a local branch. */
  fetch(options: {
    worktree: string;
    remote?: string | undefined;
    timeoutMs?: number | undefined;
  }): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("fetch", () => fetchRemote(this.repository, options));
    return fetchRemote(this.repository, options);
  }
  /** Move several branches in one atomic push, each leased to a caller-reviewed revision. */
  pushLeased(options: LeasedPushOptions) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("pushLeased", () => pushLeasedRefs(this.repository, options));
    return pushLeasedRefs(this.repository, options);
  }
  /** Replay collaborator commits onto locally rebased stack layers (see `stack-sync.ts`). */
  replayStackLayers(options: StackReplayOptions) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("replayStackLayers", () =>
        replayStackLayers(this.repository, options),
      );
    return replayStackLayers(this.repository, options);
  }
  continueStackReplay(options: {
    worktree: string;
    remaining: readonly LayerReplay[];
    signal?: AbortSignal;
  }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("continueStackReplay", () =>
        continueStackReplay(this.repository, options),
      );
    return continueStackReplay(this.repository, options);
  }
  restoreStackBranches(options: {
    worktree: string;
    heads: readonly { branch: string; head: string }[];
    current: string;
    signal?: AbortSignal;
  }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("restoreStackBranches", () =>
        restoreStackBranches(this.repository, options),
      );
    return restoreStackBranches(this.repository, options);
  }
  /** Merge `revision` into the checkout, stopping before the commit (see `merge-conflicts.ts`). */
  startMerge(options: {
    worktree: string;
    revision: string;
    expectedHead: string;
    message: string;
  }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("startMerge", () => startMerge(this.repository, options));
    return startMerge(this.repository, options);
  }
  abortMerge(worktree: string) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("abortMerge", () => abortMerge(this.repository, worktree));
    return abortMerge(this.repository, worktree);
  }
  /** The merge in progress and each unmerged file's hunks (ours / base / theirs). */
  conflicts(worktree: string) {
    if (this.gitNative.has("reads"))
      return runNativeReads("conflicts", () => readConflicts(this.repository, worktree));
    return readConflicts(this.repository, worktree);
  }
  /** Write a conflicted file's resolved text; staged once no hunk is left in it. */
  writeResolution(options: { worktree: string; path: string; content: string; revision: string }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("writeResolution", () => writeResolution(this.repository, options));
    return writeResolution(this.repository, options);
  }
  takeSide(options: { worktree: string; path: string; side: "ours" | "theirs" }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("takeSide", () => takeSide(this.repository, options));
    return takeSide(this.repository, options);
  }
  /** Commit the merge in progress with what is staged; the person's commit (hooks, signing). */
  commitMerge(options: { worktree: string; expectedHead: string }) {
    const run = async (): Promise<string> => {
      const sha = await commitMerge(this.repository, options);
      if (digestLogOn()) {
        const root = await this.repository.root(options.worktree);
        const tree = textOutput(
          await this.repository.cli.call(root, ["rev-parse", "HEAD^{tree}"]),
        ).trim();
        appendDigest("commitMerge", `merge-commit:${tree}`);
      } else {
        appendDigest("commitMerge", "merge-commit");
      }
      return sha;
    };
    if (this.gitNative.has("writes")) return runNativeWrites("commitMerge", run);
    return run();
  }
  switchBranch(options: {
    worktree: string;
    branch: string;
    allowUncommitted: boolean;
  }): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("switchBranch", () => switchBranch(this.repository, options));
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
    signal?: AbortSignal | undefined;
  }): Promise<string | undefined> {
    return branchHead(this.repository, options);
  }
  /** Fetch one branch into its remote-tracking ref only, bounded by `timeoutMs`. */
  fetchBranch(options: FetchBranchOptions): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("fetchBranch", () => fetchBranch(this.repository, options));
    return fetchBranch(this.repository, options);
  }
  /** The branch the remote's `HEAD` names, read locally or by one bounded `ls-remote`. */
  remoteDefaultBranch(options: RemoteDefaultBranchOptions): Promise<string | undefined> {
    if (this.gitNative.has("reads"))
      return runNativeReads("remoteDefaultBranch", () =>
        remoteDefaultBranch(this.repository, options),
      );
    return remoteDefaultBranch(this.repository, options);
  }
  fetchPrHead(options: FetchPrHeadOptions): Promise<string> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("fetchPrHead", () => fetchPrHead(this.repository, options));
    return fetchPrHead(this.repository, options);
  }
  /** Source identity for evidence: HEAD plus all tracked/nonignored working-tree contents.
   * Uses the checkpoint snapshot owner without creating a checkpoint or touching the user's index.
   * Explicit calls only; never run on provider deltas.
   */
  async workspaceRevision(worktree: string): Promise<string> {
    const run = async (): Promise<string> => {
      const root = await this.repository.root(worktree);
      return this.repository.serial(root, () =>
        this.nonExecuting(async () => {
          const { branch } = await this.repository.state(root);
          const tree = await snapshot(this.repository, root);
          return `${branch.head ?? "unborn"}:${tree}`;
        }),
      );
    };
    if (this.gitNative.has("checkpoints")) return runNativeCheckpoints("workspaceRevision", run);
    return run();
  }

  /**
   * Name ace's private `.ace-upload-*` entries (uploads, Recently deleted) in the local exclude
   * of the repository holding `path`, before any of them can appear there.
   */
  async excludeAcePrivate(path: string): Promise<void> {
    const run = async (): Promise<void> => {
      const root = await this.repository.root(path);
      await this.repository.serial(root, () => excludeAcePrivate(this.repository, root));
    };
    if (this.gitNative.has("writes")) return runNativeWrites("excludeAcePrivate", run);
    return run();
  }

  async repositoryInfo(repo: string) {
    const run = async () => {
      const root = await this.repository.root(repo);
      return this.repository.serial(root, () => this.repository.info(root));
    };
    if (this.gitNative.has("reads")) return runNativeReads("repositoryInfo", run);
    return run();
  }

  async status(worktree: string) {
    const run = async () => {
      const root = await this.repository.root(worktree);
      return this.repository.serial(root, () => this.repository.status(root));
    };
    if (this.gitNative.has("reads")) return runNativeReads("status", run);
    return run();
  }

  /** Project setup remains under the same supervised mutation boundary as Git writers. */
  async setupWorktree(options: {
    worktree: string;
    command: string;
    stderr?: (chunk: Buffer) => void;
    signal?: AbortSignal;
  }) {
    const run = async (): Promise<void> => {
      const root = await this.repository.root(options.worktree);
      if (this.repository.cli.executionDisabledAt(root))
        throw new GitError("invalid_argument", "Setup execution is disabled for this checkout");
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
    };
    if (this.gitNative.has("writes")) return runNativeWrites("setupWorktree", run);
    return run();
  }

  createWorktree(options: CreateWorktreeOptions) {
    const run = async () => {
      const worktree = await createWorktree(this.repository, options);
      appendDigest("createWorktree", `worktree:${options.branch}`);
      return worktree;
    };
    if (this.gitNative.has("writes")) return runNativeWrites("createWorktree", run);
    return run();
  }

  /** `signal` stops a stalled or queued read; the listing writes nothing. */
  async listWorktrees(repo: string, options: { signal?: AbortSignal | undefined } = {}) {
    const run = async () => {
      const { signal } = options;
      const root = await this.repository.root(repo, signal);
      return this.repository.serial(root, () => this.repository.worktrees(root, signal), signal);
    };
    return run();
  }

  worktreeMetadata(repo: string, path: string) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("worktreeMetadata", () =>
        worktreeMetadata(this.repository, repo, path),
      );
    return worktreeMetadata(this.repository, repo, path);
  }
  inspectWorktreeCleanup(repo: string, path: string) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("inspectWorktreeCleanup", () =>
        inspectWorktreeCleanup(this.repository, repo, path),
      );
    return inspectWorktreeCleanup(this.repository, repo, path);
  }
  backupWorktree(repo: string, path: string, check: () => void = () => {}) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("backupWorktree", () =>
        backupWorktree(this.repository, repo, path, check),
      );
    return backupWorktree(this.repository, repo, path, check);
  }
  cleanupWorktree(input: WorktreeCleanupInput, beforeRemove?: () => void) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("cleanupWorktree", () =>
        cleanupWorktree(this.repository, input, beforeRemove),
      );
    return cleanupWorktree(this.repository, input, beforeRemove);
  }

  removeWorktree(options: { repo: string; path: string; force?: boolean }) {
    if (this.gitNative.has("writes"))
      return runNativeWrites("removeWorktree", () => removeWorktree(this.repository, options));
    return removeWorktree(this.repository, options);
  }

  /** Remove only an unchanged branch created by a host-owned worktree operation. */
  deleteBranch(options: BranchCleanup): Promise<void> {
    if (this.gitNative.has("writes"))
      return runNativeWrites("deleteBranch", () => deleteBranch(this.repository, options));
    return deleteBranch(this.repository, options);
  }

  async pruneWorktrees(repo: string): Promise<void> {
    const run = async (): Promise<void> => {
      const root = await this.repository.root(repo);
      await this.repository.serial(root, () =>
        this.repository.cli.call(root, ["worktree", "prune", "--expire=now"], { write: true }),
      );
    };
    if (this.gitNative.has("writes")) return runNativeWrites("pruneWorktrees", run);
    return run();
  }

  async createCheckpoint(options: {
    worktree: string;
    threadId: string;
    label: string;
  }): Promise<Checkpoint> {
    const run = async (): Promise<Checkpoint> => {
      const root = await this.repository.root(options.worktree);
      const checkpoint = await this.repository.serial(root, () =>
        createCheckpoint(this.repository, root, options.threadId, options.label),
      );
      appendDigest("createCheckpoint", `checkpoint:${checkpoint.id}:${checkpoint.tree}`);
      return checkpoint;
    };
    if (this.gitNative.has("checkpoints")) return runNativeCheckpoints("createCheckpoint", run);
    return run();
  }

  async listCheckpoints(options: { repo: string; threadId: string }): Promise<Checkpoint[]> {
    const run = async (): Promise<Checkpoint[]> => {
      const root = await this.repository.root(options.repo);
      return this.repository.serial(root, () =>
        listCheckpoints(this.repository, root, options.threadId),
      );
    };
    if (this.gitNative.has("checkpoints")) return runNativeCheckpoints("listCheckpoints", run);
    return run();
  }

  async deleteCheckpoints(options: { repo: string; threadId: string }) {
    const run = async () => {
      const root = await this.repository.root(options.repo);
      return this.repository.serial(root, () =>
        deleteCheckpoints(this.repository, root, options.threadId),
      );
    };
    if (this.gitNative.has("checkpoints")) return runNativeCheckpoints("deleteCheckpoints", run);
    return run();
  }

  /** `paths` limits the diff to those repository-relative paths (both sides of a rename). */
  async diff(options: {
    worktree: string;
    from: DiffSide;
    to: DiffSide;
    maxPatchBytes?: number;
    paths?: readonly string[];
  }) {
    const run = async () => {
      const root = await this.repository.root(options.worktree);
      return this.repository.serial(root, () =>
        diff(
          this.repository,
          root,
          options.from,
          options.to,
          options.maxPatchBytes ?? this.maxPatchBytes,
          options.paths,
        ),
      );
    };
    if (this.gitNative.has("checkpoints")) return runNativeCheckpoints("diff", run);
    return run();
  }

  /** One commit's patch for `paths` against its first parent (or the empty tree). */
  async diffCommit(
    options: Omit<CommitDiffOptions, "maxPatchBytes"> & { maxPatchBytes?: number },
  ): Promise<DiffResult> {
    // The checkout's root is found inside the gate too: a cold checkout's discovery is Git work.
    const run = (): Promise<DiffResult> =>
      this.historyReads.run(
        () =>
          this.repository.cli.bounded(async () => {
            const root = await this.repository.root(options.worktree, options.signal);
            return diffCommit(this.repository, root, {
              ...options,
              maxPatchBytes: options.maxPatchBytes ?? this.maxPatchBytes,
            });
          }),
        options.signal,
      );
    if (this.gitNative.has("reads")) return runNativeReads("diffCommit", run);
    return run();
  }

  /** A file's newest commits following renames, in one bounded walk. */
  async fileLog(options: FileLogOptions): Promise<FileLogResult> {
    const run = (): Promise<FileLogResult> =>
      this.historyReads.run(
        () =>
          this.repository.cli.bounded(async () => {
            const root = await this.repository.root(options.worktree, options.signal);
            return fileLog(this.repository, root, options);
          }),
        options.signal,
      );
    if (this.gitNative.has("reads")) return runNativeReads("fileLog", run);
    return run();
  }

  /** At most 106 lines and 8192 characters from an immutable commit or checkpoint. */
  async readRevisionLines(options: RevisionLineOptions) {
    const run = async () => {
      const root = await this.repository.root(options.worktree);
      return this.repository.serial(root, () => readRevisionLines(this.repository, root, options));
    };
    if (this.gitNative.has("reads")) return runNativeReads("readRevisionLines", run);
    return run();
  }

  /** `signal` stops a stalled or queued read; resolving writes nothing. */
  async resolveCommit(options: {
    worktree: string;
    ref: string;
    signal?: AbortSignal | undefined;
  }): Promise<string> {
    const run = async (): Promise<string> => {
      const { signal } = options;
      const root = await this.repository.root(options.worktree, signal);
      return this.repository.serial(
        root,
        () => this.repository.commit(root, options.ref, signal),
        signal,
      );
    };
    return run();
  }

  async applyPatch(options: { worktree: string; patch: string }): Promise<void> {
    const run = async (): Promise<void> => {
      if (!options.patch || Buffer.byteLength(options.patch) > 65_536)
        throw new GitError("invalid_argument", "Patch must be between 1 and 65536 bytes");
      const root = await this.repository.root(options.worktree);
      await this.repository.serial(root, async () => {
        const args = ["apply", "--whitespace=nowarn"];
        await this.repository.cli.call(root, [...args, "--check", "-"], { input: options.patch });
        await this.repository.cli.call(root, [...args, "-"], { input: options.patch, write: true });
      });
    };
    if (this.gitNative.has("writes")) return runNativeWrites("applyPatch", run);
    return run();
  }

  async restoreCheckpoint(options: { worktree: string; checkpoint: string }) {
    const run = async () => {
      const root = await this.repository.root(options.worktree);
      const restored = await this.repository.serial(root, () =>
        restoreCheckpoint(this.repository, root, options.checkpoint),
      );
      appendDigest("restoreCheckpoint", `restore:${options.checkpoint}`);
      return restored;
    };
    if (this.gitNative.has("checkpoints")) return runNativeCheckpoints("restoreCheckpoint", run);
    return run();
  }
}
