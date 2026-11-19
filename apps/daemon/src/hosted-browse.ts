import { ForgeError, GitLabApi, GitLabLifecycle } from "@ace/forge";
import type {
  ForgeBrowserOperation,
  ForgeBrowserResult,
  ForgeLifecycleSnapshot,
  ForgePrStatus,
  ForgeRepository,
} from "@ace/protocol";
import { HostedChecks } from "./hosted-checks.ts";
import { readHostedConversation } from "./hosted-review-conversation.ts";
import { mergeStateReader } from "./host-routes.ts";
import type { WorkspaceForgeActions } from "./workspace-forge-actions.ts";
import type { WorkspaceForgeContext } from "./workspace-forge-context.ts";
import type { WorkspaceForgeLifecycle } from "./workspace-forge-lifecycle.ts";
import type { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";

export type HostedBrowseScope = {
  ctx: Pick<WorkspaceForgeContext, "backends" | "owner">;
  parts: {
    actions: WorkspaceForgeActions;
    lifecycle: WorkspaceForgeLifecycle;
    reviews: WorkspaceForgeReviews;
  };
  publishStatus(status: ForgePrStatus): void;
  publishLifecycle(snapshot: ForgeLifecycleSnapshot): void;
};

/**
 * A pull request read on a host other than GitHub (GitLab, Gitea, Forgejo, Cursor Origin),
 * through that host's read-only identity. Issue reads go through hosted-issues. What a host
 * can't answer is `unsupported`; clients only ask for what its capabilities declare.
 */
export async function hostedBrowse(
  scope: HostedBrowseScope,
  cwd: string,
  repository: ForgeRepository,
  operation: ForgeBrowserOperation,
  signal: AbortSignal,
): Promise<ForgeBrowserResult> {
  const { ctx, parts } = scope;
  const { backends } = ctx;
  if (repository.forge === "gitlab" && operation.op === "forge.repo.pr-options")
    return {
      resource: "repoPrOptions",
      value: { labels: [], assignable: [], milestones: [], truncated: true },
    };
  if (repository.forge === "gitlab" && operation.op === "forge.pr.lifecycle") {
    const runner = await backends.hostRunner(cwd, repository, [], signal);
    const backend = { lifecycle: new GitLabLifecycle(new GitLabApi({ repository, runner })) };
    const ref = { repository, number: operation.number };
    const revision = ctx.owner.capture(ref);
    const value = await parts.lifecycle.state(ref, backend, signal);
    if (ctx.owner.current(ref, revision)) scope.publishLifecycle(value.snapshot);
    return { resource: "prLifecycle", value };
  }
  if (operation.op === "forge.pr.merge-state") {
    const backend = await mergeStateReader(backends, cwd, repository, signal);
    const { value, writeState } = await parts.actions.readMergeState(
      { repository, number: operation.number },
      () => backend.prMergeState(operation.number, signal),
    );
    return { resource: "prMergeState", value: { ...value, writeState } };
  }
  if (operation.op === "forge.pr.check")
    return {
      resource: "prCheck",
      value: await new HostedChecks(ctx).read(
        cwd,
        repository,
        operation.checkRunId,
        operation.jobId,
        signal,
      ),
    };
  if ("number" in operation) {
    const ref = { repository, number: operation.number };
    const conversation = await readHostedConversation(
      backends,
      parts.reviews,
      cwd,
      ref,
      operation,
      signal,
    );
    if (conversation) return conversation;
  }
  const reader = await backends.reader(cwd, repository, signal);
  if (operation.op === "forge.pr.list")
    return { resource: "prList", value: await reader.listPrs(operation.query, signal) };
  if (operation.op === "forge.pr.files")
    return { resource: "prFiles", value: await reader.prFiles(operation, signal) };
  if (operation.op === "forge.pr.detail") {
    const ref = { repository, number: operation.number };
    const revision = ctx.owner.capture(ref);
    const { value, writeState } = await parts.actions.readDetail(ref, () =>
      reader.prDetail(operation.number, signal),
    );
    if (ctx.owner.current(ref, revision)) scope.publishStatus(value.status);
    return { resource: "prDetail", value: { ...value, writeState } };
  }
  throw new ForgeError("unsupported");
}
