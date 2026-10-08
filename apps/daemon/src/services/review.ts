import { engineReviewExecutor } from "../review-executor.ts";
import { createDaemonReview } from "../review.ts";
import type { ServiceContext } from "./types.ts";
export async function startReview(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services } = context;

  const workspace = services.workspaceActions;
  const engine = services.engine;
  const review = createDaemonReview(config.dataDir, store, {
    ...(workspace ? { threadWorktree: (id) => workspace.root(id) } : {}),
    ...(workspace && engine
      ? { executor: engineReviewExecutor(store, engine, (id) => workspace.root(id)) }
      : {}),
    ...options.review,
  });
  resources.own(() => review.close());
  services.review = review;
}

import { dispatchReviewCommand } from "../review.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export function createReviewSession({
  options,
  connected,
  send,
  fail,
}: SocketContext): SocketService {
  return {
    command: {
      types: [
        "review.open",
        "review.comment",
        "review.reply",
        "review.resolve",
        "review.applySuggestion",
        "review.sendToAgent",
        "review.askReviewer",
        "review.refresh",
        "review.status",
        "review.list",
      ],
      scope: (command) => (command.payload.type === "review.list" ? "read" : "operate"),
      async accept(command) {
        if (!options.review) {
          fail("reviews_unavailable", "Reviews unavailable");
          return;
        }
        const result = await dispatchReviewCommand(options.review, options.store, command);
        if (connected()) send({ type: "commandResult", ...result });
      },
    },
  };
}
