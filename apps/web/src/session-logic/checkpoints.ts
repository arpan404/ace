import type { MessageId, TurnId } from "@ace/contracts";

import type { ChatMessage, TurnDiffSummary } from "./types";

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function deriveVisibleTurnDiffSummaryByAssistantMessageId(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role">>,
  summaries: ReadonlyArray<TurnDiffSummary>,
): Map<MessageId, TurnDiffSummary> {
  const summaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of summaries) {
    if (!summary.assistantMessageId) continue;
    summaryByAssistantMessageId.set(summary.assistantMessageId, summary);
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role !== "assistant") {
      return new Map();
    }

    const summary = summaryByAssistantMessageId.get(message.id);
    if (!summary || summary.files.length === 0) {
      return new Map();
    }

    return new Map([[message.id, summary]]);
  }

  return new Map();
}
