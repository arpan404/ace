import { ThreadId } from "@ace/protocol";
import { GitLabReader, GitLabReviews, gitLabReviewWrites, ForgeError } from "@ace/forge";
import type { ForgePrRef, ForgeBrowserOperation, ForgeBrowserResult } from "@ace/protocol";
import type { ForgeBackends } from "./forge-backends.ts";
import type { WorkspaceForgeReviews } from "./workspace-forge-reviews.ts";

/** Routing only. Identity/visibility live in backends; durable writes live in the shared journal. */
export async function gitLabReviewBackend(
  backends: ForgeBackends,
  cwd: string,
  pr: ForgePrRef,
  signal: AbortSignal,
) {
  const identity = await backends.admittedWriter(
    cwd,
    pr.repository,
    gitLabReviewWrites(pr.repository, pr.number),
    signal,
  );
  return { reviews: new GitLabReviews({ repository: pr.repository, runner: identity.runner }) };
}

export async function readGitLabConversation(
  backends: ForgeBackends,
  reviews: WorkspaceForgeReviews,
  cwd: string,
  pr: ForgePrRef,
  operation: ForgeBrowserOperation,
  signal: AbortSignal,
): Promise<ForgeBrowserResult | undefined> {
  if (pr.repository.forge !== "gitlab") return;
  if (operation.op === "forge.pr.review-state") {
    const reader = await backends.reader(cwd, pr.repository, signal);
    if (!(reader instanceof GitLabReader)) throw new ForgeError("unsupported");
    return { resource: "prReviewState", value: await reviews.state(pr, reader, signal) };
  }
  if (!["forge.pr.activity", "forge.pr.reviewers", "forge.pr.commits"].includes(operation.op))
    return;
  const reader = await backends.reader(cwd, pr.repository, signal);
  if (!(reader instanceof GitLabReader)) throw new ForgeError("unsupported");
  if (operation.op === "forge.pr.activity")
    return {
      resource: "prActivity",
      ...(await reader.prActivity(pr.number, operation.page, signal)),
    };
  if (operation.op === "forge.pr.reviewers")
    return { resource: "prReviewers", value: await reader.prReviewers(pr.number, signal) };
  if (operation.op === "forge.pr.commits")
    return {
      resource: "prCommits",
      ...(await reader.prCommits(pr.number, operation.before, operation.headSha, signal)),
    };
  return;
}

/** Thread commands share hosted review persistence instead of growing a second write journal. */
export async function executeGitLabThreadConversation(options: {
  backends: ForgeBackends;
  reviews: WorkspaceForgeReviews;
  store: import("./store.ts").Store;
  cwd: string;
  commandId: string | undefined;
  action: Extract<
    import("@ace/protocol").Command["payload"],
    { type: "forge.comment.reply" | "forge.review.request" }
  >;
  signal: AbortSignal;
  allowed: () => boolean;
}) {
  const { action, store, reviews, backends, cwd, commandId, signal, allowed } = options;
  if (!commandId) throw new ForgeError("invalid_data");
  const thread = store.getThread(ThreadId.parse(action.link.threadId));
  if (!thread) throw new ForgeError("not_found");
  await reviews.execute(
    {
      type: "forge.hosted.review",
      workspaceId: thread.workspaceId,
      pr: action.link.pr,
      action:
        action.type === "forge.comment.reply"
          ? { kind: "reply", commentId: action.commentId, body: action.body }
          : { kind: "reviewers.request", reviewers: action.reviewers },
    },
    commandId,
    await gitLabReviewBackend(backends, cwd, action.link.pr, signal),
    signal,
    allowed,
  );
  return { ok: true, pr: action.link.pr };
}
