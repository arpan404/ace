import type { OrchestrationLatestTurn } from "@ace/contracts";

import type { ChatMessage } from "../../types";

export function isPagedThreadTimelineUsable(input: {
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "completedAt" | "state" | "turnId"
  > | null;
  readonly snapshotMessages: ReadonlyArray<Pick<ChatMessage, "role" | "turnId">>;
  readonly pagedMessages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "turnId">>;
}): boolean {
  void input;
  return true;
}
