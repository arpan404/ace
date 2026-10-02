import { ReviewWorker, type ReviewExecutor } from "@ace/review";
import { join } from "node:path";
import type { Command, CommandResult, ReviewSource, ThreadId } from "@ace/protocol";
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
  const worktree = (source: ReviewSource) => {
    const root = store.getWorkspacePath(source.workspaceId);
    if (!root) return undefined;
    if (!source.threadId) return root;
    const thread = store.getThread(source.threadId);
    if (thread?.workspaceId !== source.workspaceId) return undefined;
    return options.threadWorktree ? options.threadWorktree(source.threadId) : root;
  };
  return {
    handle(command: Command): Promise<CommandResult> {
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
        (command.payload.type === "review.sendToAgent" ||
          command.payload.type === "review.askReviewer") &&
        !store.getThread(command.payload.threadId)
      )
        return Promise.resolve({ commandId: command.id, ok: false, error: "thread_not_found" });
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
  return store.completeReviewCommand(command.id, command.deviceId, result);
}
