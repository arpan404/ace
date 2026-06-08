import type { MessageId, OrchestrationLatestTurn } from "@ace/contracts";

import type { ChatMessage } from "../../types";

export function isPagedThreadTimelineUsable(input: {
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "completedAt" | "state" | "turnId"
  > | null;
  readonly leanMessages: ReadonlyArray<Pick<ChatMessage, "role" | "turnId">>;
  readonly pagedMessages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "turnId">>;
}): boolean {
  const latestTurn = input.latestTurn;
  if (!latestTurn || latestTurn.state === "running" || !latestTurn.completedAt) {
    return true;
  }

  const assistantMessageId = latestTurn.assistantMessageId;
  if (!assistantMessageId) {
    if (latestTurn.state !== "completed") {
      return true;
    }
    const hasLeanLatestTurnUserMessage = input.leanMessages.some(
      (message) => message.role === "user" && message.turnId === latestTurn.turnId,
    );
    if (!hasLeanLatestTurnUserMessage) {
      return true;
    }
    return input.pagedMessages.some(
      (message) => message.role === "assistant" && message.turnId === latestTurn.turnId,
    );
  }

  return input.pagedMessages.some(
    (message) => message.role === "assistant" && messageIdsEqual(message.id, assistantMessageId),
  );
}

function messageIdsEqual(left: MessageId, right: MessageId): boolean {
  return String(left) === String(right);
}
