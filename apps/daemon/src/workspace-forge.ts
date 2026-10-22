import { commandNotDispatched } from "./command-not-dispatched.ts";
import { WorkspaceIssueLinks } from "./workspace-issue-links.ts";
import { actionErrorCode } from "./action-errors.ts";
import { IssueActions } from "./issue-actions.ts";
import type { Command } from "@ace/protocol";
import { ForgeResourceOwner } from "./forge-resource-owner.ts";
import { WorkspaceForgeLifecycle } from "./workspace-forge-lifecycle.ts";
import { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";
import { WorkspaceForgeChecks } from "./workspace-forge-checks.ts";
import { ForgeReplyReceipts } from "./forge-reply-receipts.ts";
import { ForgeError, repositoryKey, type GitHubForge, type CommandRunner } from "@ace/forge";
import {
  ForgeCommand,
  type ForgePrRef,
  type ForgePrStatus,
  type CommandResult,
  ThreadId,
  type ForgeCreatePrInput,
  type ForgeRepository,
  type AgentControlResult,
} from "@ace/protocol";
import type { Store } from "./store.ts";
import { WorkspaceForgeStacks } from "./workspace-forge-stacks.ts";
import type { StackSyncGit } from "./forge-stack-sync.ts";
import { WorkspacePrLinks } from "./workspace-pr-links.ts";
import { WorkspaceForgeActions } from "./workspace-forge-actions.ts";
import type { PrOwnerOperation } from "./agent-control/tools.ts";
import { ForgeBackends } from "./forge-backends.ts";
import { WorkspaceForgeBrowse } from "./workspace-forge-browse.ts";
import { WorkspacePrAssociations } from "./workspace-pr-associations.ts";
import { WorkspacePrCreation } from "./workspace-pr-creation.ts";
import { WorkspaceNewPr } from "./workspace-pr-new.ts";
import type { WorkspaceForgeContext, WorkspaceForgeGit } from "./workspace-forge-context.ts";

/** The daemon's forge surface: routes commands and reads to the parts that own them. */
export class WorkspaceForge {
  private store: Store;
  private owner = new ForgeResourceOwner();
  private lifecycle: WorkspaceForgeLifecycle;
  private issueLinks: WorkspaceIssueLinks;
  private issueActions: IssueActions;
  private reviews: WorkspaceForgeReviews;
  private checks = new WorkspaceForgeChecks();
  private now: () => number;
  private projection: WorkspacePrLinks;
  private links: WorkspacePrLinks["links"];
  private actions: WorkspaceForgeActions;
  private stacks: WorkspaceForgeStacks;
  private backends: ForgeBackends;
  private browser: WorkspaceForgeBrowse;
  private associations: WorkspacePrAssociations;
  private creation: WorkspacePrCreation;
  private newPr: WorkspaceNewPr;
  private lifetime = new AbortController();
  private stopPreferences: (() => void) | undefined;
  private sourceControl: import("./source-control.ts").SourceControl | undefined;
  constructor(
    store: Store,
    git: WorkspaceForgeGit,
    now: () => number,
    runner: (cwd: string) => CommandRunner,
    sourceControl?: import("./source-control.ts").SourceControl,
  ) {
    const owner = this.owner;
    this.store = store;
    this.now = now;
    this.sourceControl = sourceControl;
    this.lifecycle = new WorkspaceForgeLifecycle(store, owner);
    this.issueLinks = new WorkspaceIssueLinks(store);
    this.issueActions = new IssueActions(store, now);
    this.stacks = new WorkspaceForgeStacks(store, now, stackSyncGit(git));
    this.reviews = new WorkspaceForgeReviews(store, owner);
    this.projection = new WorkspacePrLinks(store, now);
    this.links = this.projection.links;
    this.actions = new WorkspaceForgeActions(store, owner, now);
    this.backends = new ForgeBackends({
      git,
      now,
      runner,
      sourceControl,
      replyReceipts: new ForgeReplyReceipts(store),
      signal: this.lifetime.signal,
    });
    this.stopPreferences = sourceControl?.listen(() => {
      this.backends.clear();
      this.newPr.clear();
    });
    const context: WorkspaceForgeContext = {
      store,
      owner,
      now,
      signal: this.lifetime.signal,
      git,
      sourceControl,
      backends: this.backends,
      projection: this.projection,
      links: this.links,
    };
    this.newPr = new WorkspaceNewPr(context);
    this.browser = new WorkspaceForgeBrowse(context, {
      newPr: this.newPr,
      actions: this.actions,
      issueActions: this.issueActions,
      issueLinks: this.issueLinks,
      lifecycle: this.lifecycle,
      reviews: this.reviews,
      stacks: this.stacks,
    });
    this.associations = new WorkspacePrAssociations(context);
    this.creation = new WorkspacePrCreation(context);
  }
  repository(cwd: string): Promise<ForgeRepository> {
    return this.backends.repository(cwd);
  }
  prRepositories(cwd: string): Promise<ForgeRepository[]> {
    return this.creation.prRepositories(cwd);
  }
  defaultBranch(cwd: string): Promise<string | undefined> {
    return this.creation.defaultBranch(cwd);
  }
  browse(
    cwd: string,
    operation: import("@ace/protocol").ForgeBrowserOperation,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol").ForgeBrowserResult> {
    return this.browser.browse(cwd, operation, signal);
  }
  link(
    id: ThreadId,
    cwd: string,
    input: ForgePrRef,
    permitted: () => boolean = () => true,
    signal: AbortSignal = this.lifetime.signal,
  ): Promise<ForgePrStatus> {
    return this.associations.link(id, cwd, input, permitted, signal);
  }
  unlink(id: ThreadId, pr?: ForgePrRef): void {
    this.associations.unlink(id, pr);
  }
  agent(
    id: ThreadId,
    cwd: string,
    operation: PrOwnerOperation,
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    return this.associations.agent(id, cwd, operation, signal);
  }
  status(id: ThreadId, cwd: string): Promise<ForgePrStatus | null> {
    return this.associations.status(id, cwd);
  }
  refresh(threads: readonly { id: ThreadId; cwd: string }[]): Promise<void> {
    return this.associations.refresh(threads);
  }
  ensurePr(
    id: ThreadId,
    cwd: string,
    input: ForgeCreatePrInput,
    permitted: () => boolean,
    guard?: { fingerprint: string; baseRef?: string | undefined },
  ): Promise<{ status: ForgePrStatus; existing: boolean }> {
    return this.creation.ensurePr(id, cwd, input, permitted, guard);
  }
  async checkoutDetail(
    cwd: string,
    selection: import("@ace/protocol").ForgePrWorktree,
    signal: AbortSignal,
  ) {
    const detail = await (
      await this.backends.backend(cwd, selection.ref.repository)
    ).prDetail(selection.ref.number, signal);
    // GitHub keeps a PR whose fork was deleted, but its head can no longer be fetched.
    if (!detail.headRepository) throw new ForgeError("fork_deleted");
    if (detail.status.headSha !== selection.headSha) throw new ForgeError("head_moved");
    return detail;
  }
  async checkout(
    cwd: string,
    selection: import("@ace/protocol").ForgePrWorktree,
    signal: AbortSignal,
  ) {
    const value = await (
      await this.backends.backend(cwd, selection.ref.repository)
    ).prCheckout(selection.ref.number, signal);
    if (!value.headRepository) throw new ForgeError("fork_deleted");
    if (value.headSha !== selection.headSha) throw new ForgeError("head_moved");
    return value;
  }
  /** GitHub's state for each of `numbers`; null for a PR GitHub no longer has. */
  async prStates(
    cwd: string,
    repository: ForgeRepository,
    numbers: readonly number[],
    signal: AbortSignal,
  ) {
    return (await this.backends.backend(cwd, repository)).states(numbers, signal);
  }
  admitCheckout(id: ThreadId, status: ForgePrStatus): void {
    this.store.atomic(() => {
      this.links.link({ threadId: id, pr: status.ref });
      this.projection.update(id, status, this.links.getLinkState(id, status.ref)?.generation);
      this.projection.publish(id);
    });
  }
  async issueCommand(command: Command, cwd: string, allowed: () => boolean) {
    const p = command.payload;
    if (p.type === "forge.issue.link") {
      await (
        await this.backends.backend(cwd, p.issue.repository)
      ).issueDetail(p.issue.number, this.lifetime.signal);
      if (!allowed()) throw new Error("forbidden");
      this.issueLinks.link(p.threadId, p.issue, this.now());
      return { ok: true, threadId: p.threadId, issue: p.issue };
    }
    if (p.type !== "forge.issue.write" && p.type !== "forge.issue.reconcile")
      throw new Error("invalid_command");
    let backend: GitHubForge;
    try {
      backend = await this.backends.backend(cwd, p.repository);
    } catch (error) {
      return commandNotDispatched(command, actionErrorCode(error));
    }
    return this.issueActions.execute(command, backend, allowed, this.lifetime.signal);
  }

  async execute(
    input: unknown,
    cwd: string,
    permitted: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    const check = await this.sourceControl?.guard();
    const allowed = () => {
      check?.();
      return permitted();
    };
    const p = ForgeCommand.parse(input);
    const id = ThreadId.parse("threadId" in p ? p.threadId : p.link.threadId);
    if (!allowed()) return { ok: false, error: "forbidden" };
    if (p.type === "forge.pr.unlink") {
      const thread = this.store.getThread(id);
      if (!thread || thread.deletedAt !== undefined)
        return { ok: false, error: "thread_not_found" };
      const repo = p.repo ?? (p.number ? await this.repository(cwd) : undefined);
      if (!allowed()) return { ok: false, error: "forbidden" };
      this.unlink(id, p.number && repo ? { number: p.number, repository: repo } : undefined);
      return { ok: true };
    }
    if (p.type === "forge.pr.create") {
      if (repositoryKey(p.repository) !== repositoryKey(await this.repository(cwd)))
        throw new Error("repository_mismatch");
      const { status, existing } = await this.creation.ensurePr(
        id,
        cwd,
        p.input,
        allowed,
        p.draftFingerprint
          ? { fingerprint: p.draftFingerprint, baseRef: p.draftBaseRef }
          : undefined,
      );
      return {
        ok: true,
        pr: status.ref,
        prStatus: status,
        ...(existing ? { prExisting: true } : {}),
      };
    }
    if (p.type === "forge.pr.link") {
      const status = await this.associations.link(id, cwd, p.link.pr, allowed);
      return { ok: true, pr: p.link.pr, prStatus: status };
    }
    this.lifetime.signal.throwIfAborted();
    if (!allowed()) throw new Error("forbidden");
    const generation = this.links.getLinkState(id, p.link.pr)?.generation;
    const backend = await this.backends.backend(cwd, p.link.pr.repository);
    if (
      (p.type === "forge.pr.merge-state.change" || p.type === "forge.pr.auto-merge") &&
      generation === undefined
    )
      return { ok: false, error: "forge_not_found" };
    if (p.type === "forge.pr.stack.change") {
      if (generation === undefined) return { ok: false, error: "forge_not_found" };
      if (
        p.action !== "merge" &&
        repositoryKey(p.link.pr.repository) !== repositoryKey(await this.repository(cwd))
      )
        throw new ForgeError("conflict");
      const operation = await this.stacks.change(
        cwd,
        backend,
        p.link.pr.number,
        p.expected,
        p.action,
        p.method,
        this.lifetime.signal,
        () => allowed() && this.links.getLinkState(id, p.link.pr)?.generation === generation,
      );
      return {
        ok: operation.state !== "failed",
        ...(operation.state === "failed" ? { error: "forge_conflict" } : {}),
        pr: p.link.pr,
        stackOperation: operation,
      };
    }
    if (p.type !== "forge.pr.status")
      return this.actions.execute(
        p,
        backend,
        this.lifetime.signal,
        () => allowed() && this.links.getLinkState(id, p.link.pr)?.generation === generation,
        (status) => this.projection.update(id, status, generation),
      );
    const { value } = await this.actions.readDetail(p.link.pr, async () => ({
      status: await backend.status(p.link.pr.number, this.lifetime.signal),
    }));
    const status = value.status;
    this.projection.update(id, status, generation);
    return { ok: true, pr: status.ref, prStatus: status };
  }
  async hostedReview(
    input: import("@ace/protocol").Command & {
      payload: import("zod").z.infer<typeof import("@ace/protocol").ForgeHostedReviewCommand>;
    },
    cwd: string,
    allowed: () => boolean,
  ) {
    const p = input.payload;
    await this.reviews.execute(
      p,
      input.id,
      await this.backends.backend(cwd, p.pr.repository),
      this.lifetime.signal,
      allowed,
    );
    return { ok: true };
  }
  async hostedChecks(
    command: Command & { payload: import("@ace/protocol").ForgeHostedChecksCommand },
    cwd: string,
    allowed: () => boolean,
  ) {
    const p = command.payload;
    const backend = await this.backends.backend(cwd, p.pr.repository);
    await this.checks.execute(p, backend, this.lifetime.signal, allowed);
    return { ok: true };
  }
  /**
   * A merge, or auto-merge on or off, from the project's Pull requests page, linked to a thread or not. It goes through
   * the same journal and fence as a thread's merge; every thread linked to the PR sees the result.
   */
  async hostedMerge(
    command: Command & {
      payload:
        | import("@ace/protocol").ForgeHostedMergeCommand
        | import("@ace/protocol").ForgeHostedMergeStateCommand;
    },
    cwd: string,
    allowed: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    const p = command.payload;
    this.lifetime.signal.throwIfAborted();
    if (!allowed()) return commandNotDispatched(command, "forbidden");
    let backend: GitHubForge;
    try {
      backend = await this.backends.backend(cwd, p.pr.repository);
    } catch (error) {
      return commandNotDispatched(command, actionErrorCode(error));
    }
    return this.actions.execute(p, backend, this.lifetime.signal, allowed, (status) =>
      this.browser.publishStatus(status),
    );
  }

  /** A pull request from any branch, opened from the project's Pull requests page. */
  async hostedPrCreate(
    command: Command & { payload: import("@ace/protocol").ForgeHostedPrCreateCommand },
    cwd: string,
    allowed: () => boolean,
  ): Promise<Omit<CommandResult, "commandId">> {
    this.lifetime.signal.throwIfAborted();
    if (!allowed()) return commandNotDispatched(command, "forbidden");
    return this.newPr.create(command.payload, cwd, allowed);
  }

  async hostedLifecycle(
    command: import("@ace/protocol").Command & {
      payload: import("zod").z.infer<typeof import("@ace/protocol").ForgeHostedLifecycleCommand>;
    },
    cwd: string,
    allowed: () => boolean,
  ) {
    const p = command.payload;
    const backend = await this.backends.backend(cwd, p.pr.repository);
    const receipt = await this.lifecycle.execute(
      p,
      command.id,
      backend,
      this.lifetime.signal,
      allowed,
    );
    const revision = this.owner.capture(p.pr);
    try {
      const snapshot = await backend.lifecycle.snapshot(p.pr.number, this.lifetime.signal);
      if (this.owner.current(p.pr, revision)) this.browser.publishLifecycle(snapshot);
    } catch {
      /* The write receipt is durable even when the follow-up projection read is unavailable. */
    }
    return { ok: true, forgeLifecycle: receipt };
  }
  close(): void {
    this.stopPreferences?.();
    this.lifetime.abort();
    this.backends.clear();
  }
}

/** Syncing collaborator commits needs every one of these Git operations, or none is offered. */
function stackSyncGit(git: Partial<StackSyncGit>): StackSyncGit | undefined {
  const {
    fetchBranch,
    branchHead,
    switchBranch,
    replayStackLayers,
    continueStackReplay,
    restoreStackBranches,
  } = git;
  if (
    !fetchBranch ||
    !branchHead ||
    !switchBranch ||
    !replayStackLayers ||
    !continueStackReplay ||
    !restoreStackBranches
  )
    return undefined;
  return {
    fetchBranch: fetchBranch.bind(git),
    branchHead: branchHead.bind(git),
    switchBranch: switchBranch.bind(git),
    replayStackLayers: replayStackLayers.bind(git),
    continueStackReplay: continueStackReplay.bind(git),
    restoreStackBranches: restoreStackBranches.bind(git),
  };
}
