import { ReviewWorker, type ReviewExecutor } from "@ace/review";
import { createHash } from "node:crypto";
import { Command } from "@ace/protocol";
import { join } from "node:path";
import type { CommandResult, ReviewSource, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

export interface ReviewPort {
  handle(command: Command): Promise<CommandResult>;
  recover?(command: Command): Promise<CommandResult>;
}
export interface DaemonReviewOptions {
  executor?: ReviewExecutor;
  threadWorktree?: (threadId: ThreadId) => string | undefined;
}
export function createDaemonReview(
  directory: string,
  store: Store,
  options: DaemonReviewOptions = {},
) {
  const worker = new ReviewWorker(join(directory, "reviews.sqlite"), options.executor);
  const threadRoot = (id: ThreadId) => {
    const thread = store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return undefined;
    if (!options.threadWorktree)
      return thread.details?.mode === "worktree"
        ? undefined
        : store.getWorkspacePath(thread.workspaceId);
    try {
      return options.threadWorktree(id);
    } catch {
      return undefined;
    }
  };
  const worktree = (source: ReviewSource) => {
    const root = store.getWorkspacePath(source.workspaceId);
    if (!root) return undefined;
    if (!source.threadId) return root;
    const thread = store.getThread(source.threadId);
    if (thread?.workspaceId !== source.workspaceId) return undefined;
    return threadRoot(source.threadId);
  };
  return {
    async handle(command: Command): Promise<CommandResult> {
      if (command.payload.type === "review.applySuggestion") {
        const listed = await worker.handle(
          Command.parse({
            id: `review-source:${createHash("sha256").update(command.id).digest("hex")}`,
            deviceId: "review-host",
            payload: { type: "review.list", sessionId: command.payload.sessionId, limit: 1 },
          }),
        );
        const source = listed.review?.session?.source;
        if (!listed.ok || !source) return { ...listed, commandId: command.id };
        const root = worktree(source);
        if (!root) return { commandId: command.id, ok: false, error: "review_target_unavailable" };
        return worker.handle(command, root);
      }
      if (command.payload.type === "review.open") {
        const root = worktree(command.payload.source);
        if (!root)
          return Promise.resolve({
            commandId: command.id,
            ok: false,
            error: "review_workspace_not_found",
          });
        return worker.handle(command, root);
      }
      if (
        command.payload.type === "review.sendToAgent" ||
        command.payload.type === "review.askReviewer"
      ) {
        const thread = store.getThread(command.payload.threadId);
        if (!thread)
          return Promise.resolve({ commandId: command.id, ok: false, error: "thread_not_found" });
        const root = threadRoot(thread.id);
        if (!root)
          return Promise.resolve({
            commandId: command.id,
            ok: false,
            error: "review_target_unavailable",
          });
        return worker.handle(command, undefined, {
          threadId: thread.id,
          workspaceId: thread.workspaceId,
          worktree: root,
        });
      }
      return worker.handle(command);
    },
    recover: (command: Command) => worker.recover(command),
    afterFix: (sessionId: string, requestId: string) => worker.afterFix(sessionId, requestId),
    close: () => worker.close(),
  };
}

/** Reserve one host-wide command id before leaving the synchronous receipt boundary. */
export async function dispatchReviewCommand(
  port: ReviewPort,
  store: Store,
  command: Command,
): Promise<CommandResult> {
  let reserved = false;
  const previous = store.recordCommand(command.id, command.deviceId, () => {
    reserved = true;
    return { commandId: command.id, ok: false, error: "review_pending" };
  });
  if (!reserved && previous.error !== "review_pending") return previous;
  const result = reserved
    ? await port.handle(command)
    : port.recover
      ? await port.recover(command)
      : previous;
  if (result.error === "review_busy" || result.error === "review_closed") {
    // No worker effect was admitted on a new request. A retry must keep an
    // existing pending effect's reservation intact until its durable result arrives.
    if (reserved) store.releaseReviewCommand(command.id, command.deviceId);
    return result;
  }
  if (result.error === "review_recovery_required") return result;
  return store.completeReviewCommand(command.id, command.deviceId, result);
}
