import { ThreadId } from "@ace/protocol";
import {
  GitLabReader,
  GitLabReviews,
  TeaReader,
  BitbucketReader,
  gitLabReviewWrites,
  ForgeError,
  isTeaHost,
} from "@ace/forge";
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

/**
 * A merge request or pull request's conversation on GitLab, Gitea, Forgejo or Bitbucket: its review state
 * (with ace's journal), activity, reviewers and commits. Undefined for any other read.
 */
export async function readHostedConversation(
  backends: ForgeBackends,
  reviews: WorkspaceForgeReviews,
  cwd: string,
  pr: ForgePrRef,
  operation: ForgeBrowserOperation,
  signal: AbortSignal,
): Promise<ForgeBrowserResult | undefined> {
  const forge = pr.repository.forge;
  if (forge !== "gitlab" && forge !== "bitbucket" && !isTeaHost(forge)) return;
  if (!conversationReads.has(operation.op)) return;
  const reader = await backends.reader(cwd, pr.repository, signal);
  if (
    !(reader instanceof GitLabReader) &&
    !(reader instanceof TeaReader) &&
    !(reader instanceof BitbucketReader)
  )
    throw new ForgeError("unsupported");
  if (operation.op === "forge.pr.review-state")
    return { resource: "prReviewState", value: await reviews.state(pr, reader, signal) };
  if (operation.op === "forge.pr.reviewers")
    return {
      resource: "prReviewers",
      value:
        reader instanceof GitLabReader
          ? await reader.prReviewers(pr.number, signal)
          : await reader.reviews.reviewers(pr.number, signal),
    };
  if (operation.op === "forge.pr.commits")
    return {
      resource: "prCommits",
      ...(await reader.prCommits(pr.number, operation.before, operation.headSha, signal)),
    };
  if (operation.op === "forge.pr.activity" && reader instanceof GitLabReader)
    return {
      resource: "prActivity",
      ...(await reader.prActivity(pr.number, operation.page, signal)),
    };
  throw new ForgeError("unsupported");
}

const conversationReads = new Set([
  "forge.pr.review-state",
  "forge.pr.activity",
  "forge.pr.reviewers",
  "forge.pr.commits",
]);

/** Thread commands share hosted review persistence instead of growing a second write journal. */
export async function executeHostedThreadConversation(options: {
  /** The PR's review writer, admitting exactly its host's review writes. */
  backend: Parameters<WorkspaceForgeReviews["execute"]>[2];
  reviews: WorkspaceForgeReviews;
  store: import("./store.ts").Store;
  commandId: string | undefined;
  action: Extract<
    import("@ace/protocol").Command["payload"],
    { type: "forge.comment.reply" | "forge.review.request" }
  >;
  signal: AbortSignal;
  allowed: () => boolean;
}) {
  const { action, store, reviews, backend, commandId, signal, allowed } = options;
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
    backend,
    signal,
    allowed,
  );
  return { ok: true, pr: action.link.pr };
}
