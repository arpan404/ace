import { repositoryKey, prUrl } from "@ace/forge";
import { ThreadId, type ForgePrStatus } from "@ace/protocol";
import type { IssueActions } from "./issue-actions.ts";
import type { WorkspaceForgeActions } from "./workspace-forge-actions.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";
import type { WorkspaceForgeLifecycle } from "./workspace-forge-lifecycle.ts";
import type { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";
import type { WorkspaceForgeStacks } from "./workspace-forge-stacks.ts";
import type { WorkspaceIssueLinks } from "./workspace-issue-links.ts";
import type { WorkspaceNewPr } from "./workspace-pr-new.ts";

/** Hosted PR and issue reads, and publishing what they show to every linked thread. */
export class WorkspaceForgeBrowse {
  private ctx: WorkspaceForgeContext;
  private parts: {
    actions: WorkspaceForgeActions;
    issueActions: IssueActions;
    issueLinks: WorkspaceIssueLinks;
    lifecycle: WorkspaceForgeLifecycle;
    reviews: WorkspaceForgeReviews;
    stacks: WorkspaceForgeStacks;
    newPr: WorkspaceNewPr;
  };
  constructor(ctx: WorkspaceForgeContext, parts: WorkspaceForgeBrowse["parts"]) {
    this.ctx = ctx;
    this.parts = parts;
  }
  async browse(
    cwd: string,
    operation: import("@ace/protocol").ForgeBrowserOperation,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol").ForgeBrowserResult> {
    if (operation.op === "forge.inbox.list") return this.inbox(cwd, operation, signal);
    // A new pull request reads where it would open, which may be a fork's parent.
    if (operation.op === "forge.pr.new-context")
      return { resource: "newPrContext", value: await this.parts.newPr.context(cwd, signal) };
    if (
      (operation.op === "forge.repo.pr-options" || operation.op === "forge.compare") &&
      operation.repository === undefined
    ) {
      if (operation.op === "forge.compare")
        return {
          resource: "compare",
          value: await this.parts.newPr.compare(cwd, operation, signal),
        };
      const target = await this.parts.newPr.targetBackend(cwd);
      return { resource: "repoPrOptions", value: await target.prOptions(signal) };
    }
    const repository = operation.repository ?? (await this.ctx.backends.repository(cwd));
    signal.throwIfAborted();
    const backend = await this.ctx.backends.backend(cwd, repository);
    if (operation.op === "forge.pr.lifecycle") {
      const ref = { repository, number: operation.number };
      const revision = this.ctx.owner.capture(ref);
      const value = await this.parts.lifecycle.state(
        { repository, number: operation.number },
        backend,
        signal,
      );
      if (this.ctx.owner.current(ref, revision)) this.publishLifecycle(value.snapshot);
      return { resource: "prLifecycle", value };
    }
    if (operation.op === "forge.repo.pr-options")
      return { resource: "repoPrOptions", value: await backend.prOptions(signal) };
    if (operation.op === "forge.repo.milestones")
      return { resource: "repoMilestones", value: await backend.milestones(signal) };
    if (operation.op === "forge.compare") {
      // Named by repository, a comparison is of two of its own branches: a fork's go through
      // the project's create target above, as a create would.
      const head = operation.head;
      if (
        head.owner.toLowerCase() !== repository.owner.toLowerCase() ||
        head.name.toLowerCase() !== repository.name.toLowerCase()
      )
        throw new Error("repository_mismatch");
      return {
        resource: "compare",
        value: await backend.compare(
          operation.base,
          head,
          operation.page,
          signal,
          operation.headSha,
        ),
      };
    }
    if (operation.op === "forge.issue.list")
      return { resource: "issueList", value: await backend.listIssues(operation.query, signal) };
    if (operation.op === "forge.issue.timeline")
      return {
        resource: "issueTimeline",
        ...(await backend.issueTimeline(operation.number, operation.page, signal)),
      };
    if (operation.op === "forge.issue.actions")
      return {
        resource: "issueActions",
        actions: this.parts.issueActions.list(repository, operation.number),
      };
    if (operation.op === "forge.issue.detail") {
      const value = await backend.issueDetail(operation.number, signal);
      return {
        resource: "issueDetail",
        value: { ...value, ...this.parts.issueLinks.related(value.ref) },
      };
    }
    if (operation.op === "forge.pr.merge-state") {
      const { value, writeState } = await this.parts.actions.readMergeState(
        { repository, number: operation.number },
        () => backend.prMergeState(operation.number, signal),
      );
      return { resource: "prMergeState", value: { ...value, writeState } };
    }
    if (operation.op === "forge.pr.stack")
      return {
        resource: "prStack",
        value: await this.parts.stacks.read(cwd, backend, operation.number, signal),
      };
    if (operation.op === "forge.pr.stack-memberships")
      return {
        resource: "prStackMemberships",
        value: await backend.stackMemberships(operation.numbers, signal),
      };
    if (operation.op === "forge.pr.review-state")
      return {
        resource: "prReviewState",
        value: await this.parts.reviews.state(
          { repository, number: operation.number },
          backend,
          signal,
        ),
      };
    if (operation.op === "forge.pr.activity")
      return {
        resource: "prActivity",
        ...(await backend.prActivity(operation.number, operation.page, signal)),
      };
    if (operation.op === "forge.group-counts")
      return {
        resource: "groupCounts",
        counts: await backend.groupCounts(operation.grouping, signal),
      };
    if (operation.op === "forge.open-work")
      return { resource: "openWork", value: await backend.openWork(signal) };
    if (operation.op === "forge.pr.list")
      return { resource: "prList", value: await backend.listPrs(operation.query, signal) };
    if (operation.op === "forge.pr.commits")
      return {
        resource: "prCommits",
        ...(await backend.prCommits(operation.number, operation.before, operation.headSha, signal)),
      };
    if (operation.op === "forge.pr.files")
      return { resource: "prFiles", value: await backend.prFiles(operation, signal) };
    if (operation.op === "forge.pr.check")
      return {
        resource: "prCheck",
        value: await backend.checks.run(operation.checkRunId, operation.jobId, signal),
      };
    if (operation.op === "forge.file.content")
      return { resource: "fileContent", value: await backend.fileContent(operation, signal) };
    if (operation.op === "forge.people")
      return { resource: "people", people: await backend.people(operation.query, signal) };
    if (operation.op === "forge.references")
      return {
        resource: "references",
        references: await backend.references(operation.query, signal),
      };
    if (operation.op === "forge.pr.reviewers")
      return {
        resource: "prReviewers",
        value: await backend.prReviewers(operation.number, signal),
      };
    const ref = { repository, number: operation.number };
    const revision = this.ctx.owner.capture(ref);
    const { value, writeState } = await this.parts.actions.readDetail(
      { repository, number: operation.number },
      () => backend.prDetail(operation.number, signal),
    );
    if (this.ctx.owner.current(ref, revision)) this.publishStatus(value.status);
    const threads = this.ctx.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT threads.id FROM forge_links JOIN threads ON threads.id=forge_links.thread_id WHERE repo=? AND number=? AND json_extract(client,'$.deletedAt') IS NULL ORDER BY threads.updated_at DESC LIMIT 101",
          )
          .all(repositoryKey(value.status.ref.repository), value.status.ref.number),
      )
      .flatMap((row) => {
        const thread = this.ctx.store.getThread(ThreadId.parse(row.id));
        return thread ? [thread] : [];
      });
    return {
      resource: "prDetail",
      value: {
        ...value,
        writeState,
        relatedThreads: threads.slice(0, 100).map((thread) => ({
          id: thread.id,
          title: thread.title,
          archived: thread.archivedAt !== undefined,
        })),
        relatedThreadsTruncated: threads.length > 100,
      },
    };
  }
  /**
   * The account's notifications on the project's host (or the one asked for), with the project's
   * own repository so its rows open without naming it.
   */
  private async inbox(
    cwd: string,
    operation: Extract<import("@ace/protocol").ForgeBrowserOperation, { op: "forge.inbox.list" }>,
    signal: AbortSignal,
  ): Promise<import("@ace/protocol").ForgeBrowserResult> {
    const own = await this.ctx.backends.repository(cwd).catch((error: unknown) => {
      // Without a GitHub remote the project still reads a host it was told.
      if (operation.host) return undefined;
      throw error;
    });
    const host = operation.host ?? own?.host ?? "";
    const value = await (await this.ctx.backends.inbox(cwd, host)).list(operation.query, signal);
    return {
      resource: "inboxList",
      value: own?.host === value.host ? { ...value, projectRepository: own } : value,
    };
  }
  publishStatus(status: ForgePrStatus): void {
    const ids = this.ctx.store.atomic((db) =>
      db
        .prepare("SELECT thread_id FROM forge_links WHERE repo=? AND number=?")
        .all(repositoryKey(status.ref.repository), status.ref.number),
    );
    for (const row of ids) {
      const id = ThreadId.parse(row.thread_id);
      this.ctx.projection.update(
        id,
        status,
        this.ctx.links.getLinkState(id, status.ref)?.generation,
      );
    }
  }
  publishLifecycle(snapshot: import("@ace/protocol").ForgeLifecycleSnapshot): void {
    this.publishStatus({
      ref: snapshot.pr,
      title: snapshot.metadata.title,
      url: prUrl(snapshot.pr),
      state: snapshot.state,
      headSha: snapshot.headSha,
      mergeability: "unknown",
      ci: "unknown",
      checks: [],
      comments: [],
      reviewThreads: [],
      raw: {},
    });
  }
}
