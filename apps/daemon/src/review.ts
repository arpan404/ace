import { ReviewWorker, type ReviewExecutor } from "@ace/review";
import { join } from "node:path";
import type { Command, CommandResult, ReviewSource, ThreadId } from "@ace/protocol";
import type { Store } from "./store.ts";

export interface ReviewPort {
  handle(command: Command): Promise<CommandResult>;
}
export function createDaemonReview(
  directory: string,
  store: Store,
  executor?: ReviewExecutor,
  threadWorktree?: (threadId: ThreadId) => string | undefined,
) {
  const worker = new ReviewWorker(join(directory, "reviews.sqlite"), executor);
  const worktree = (source: ReviewSource) => {
    const root = store.getWorkspacePath(source.workspaceId);
    if (!root) return undefined;
    if (!source.threadId) return root;
    const thread = store.getThread(source.threadId);
    if (thread?.workspaceId !== source.workspaceId) return undefined;
    return threadWorktree ? threadWorktree(source.threadId) : root;
  };
  return {
    handle(command: Command) {
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
    afterFix: (sessionId: string, requestId: string) => worker.afterFix(sessionId, requestId),
    close: () => worker.close(),
  };
}
