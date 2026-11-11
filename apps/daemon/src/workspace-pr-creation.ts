import { hostedCreationBackend } from "./hosted-create.ts";
import { repositoryKey } from "@ace/forge";
import {
  ForgeCreatePrInput,
  type ForgePrStatus,
  type ForgeRepository,
  type ThreadId,
} from "@ace/protocol";
import { forgeBranchName, prCreateTarget, recordedPrBase } from "./pr-create-target.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";

/** Opening a thread's PR on the right repository and base, and where its PRs may land. */
export class WorkspacePrCreation {
  private ctx: WorkspaceForgeContext;
  constructor(ctx: WorkspaceForgeContext) {
    this.ctx = ctx;
  }
  /** Every repository a PR created from this checkout may land in: its head's, and its parent. */
  async prRepositories(cwd: string): Promise<ForgeRepository[]> {
    const { head, project, metadata } = await this.ctx.backends.prHead(cwd);
    const pushed = head.pushed.repository;
    const primary = project.resolved.primary?.repository;
    const own = primary && repositoryKey(primary) !== repositoryKey(pushed) ? [primary] : [];
    try {
      const parent = (await metadata()).parent;
      return parent ? [pushed, parent.repository, ...own] : [pushed, ...own];
    } catch {
      this.ctx.signal.throwIfAborted();
      return [pushed, ...own];
    }
  }
  /** Host-owned unique branches make remote lookup a durable create receipt. */
  async ensurePr(
    id: ThreadId,
    cwd: string,
    input: ForgeCreatePrInput,
    permitted: () => boolean,
    guard?: { fingerprint: string; baseRef?: string | undefined },
  ): Promise<{ status: ForgePrStatus; existing: boolean }> {
    const check = await this.ctx.sourceControl?.guard();
    const allowed = () => {
      check?.();
      return permitted();
    };
    const parsed = ForgeCreatePrInput.parse(input);
    // The branch was pushed to the PR head's repository: the primary, or its fork (ADR 0120).
    const { head, project, metadata } = await this.ctx.backends.prHead(cwd);
    const checkout = { repository: head.pushed.repository, remotes: project.remotes };
    const pushed = await hostedCreationBackend(
      this.ctx.backends,
      cwd,
      checkout.repository,
      this.ctx.signal,
    );
    if (!allowed()) throw new Error("forbidden");
    // The daemon owns the base: a reviewed draft's base, else the thread's recorded base, else
    // the forge's default branch. A fork's PR opens on its parent, from `fork-owner:branch`.
    const reviewed =
      guard && parsed.base ? forgeBranchName(parsed.base, checkout.remotes) : undefined;
    const target = prCreateTarget(checkout.repository, await metadata(), {
      reviewed,
      recorded: recordedPrBase(
        this.ctx.store.getThread(id)?.details,
        parsed.branch,
        checkout.remotes,
      ),
    });
    const value = { ...parsed, base: target.base };
    const backend =
      repositoryKey(target.repository) === repositoryKey(checkout.repository)
        ? pushed
        : await hostedCreationBackend(
            this.ctx.backends,
            cwd,
            target.repository,
            this.ctx.signal,
            target.head,
          );
    if (!allowed()) throw new Error("forbidden");
    const verifyHead = async () => {
      if (value.expectedHead === undefined) return;
      const info = await this.ctx.git.repositoryInfo(cwd);
      if (!allowed()) throw new Error("forbidden");
      if (info.branch !== value.branch || info.head !== value.expectedHead)
        throw new Error("git_head_moved");
    };
    await verifyHead();
    const found = await backend.findPr(value.branch, value.base, this.ctx.signal, target.head);
    await verifyHead();
    if (!allowed()) throw new Error("forbidden");
    const publish = async () => {
      this.ctx.signal.throwIfAborted();
      if (!allowed()) throw new Error("forbidden");
      return backend.createPr(id, value, this.ctx.signal, target.head);
    };
    let pr = found;
    if (!pr) {
      if (guard) {
        if (!this.ctx.git.withWritingGuard) throw new Error("draft_guard_unavailable");
        pr = await this.ctx.git.withWritingGuard(
          cwd,
          {
            kind: "pr",
            branch: value.branch,
            base: value.base,
            ...(guard.baseRef ? { baseRef: guard.baseRef } : {}),
          },
          guard.fingerprint,
          publish,
        );
      } else pr = await publish();
    }
    // Persist the receipt even if the subsequent status read fails.
    const generation = await this.ctx.store.write(() => {
      if (!allowed()) throw new Error("forbidden");
      this.ctx.links.link({ threadId: id, pr });
      this.ctx.projection.publish(id);
      return this.ctx.links.getLinkState(id, pr)?.generation;
    });
    const status = await backend.status(pr.number, this.ctx.signal);
    await this.ctx.store.write(() => {
      if (!allowed()) throw new Error("forbidden");
      this.ctx.projection.update(id, status, generation);
    });
    // `existing`: the branch already had this pull request, which is linked, not opened.
    return { status, existing: !!found };
  }
  /** The forge repository's default branch, or undefined when the forge can't say. */
  async defaultBranch(cwd: string): Promise<string | undefined> {
    try {
      const repository = await this.ctx.backends.repository(cwd);
      return (
        await (
          await hostedCreationBackend(this.ctx.backends, cwd, repository, this.ctx.signal)
        ).repositoryMetadata(this.ctx.signal)
      ).defaultBranch;
    } catch {
      this.ctx.signal.throwIfAborted();
      return undefined;
    }
  }
}
