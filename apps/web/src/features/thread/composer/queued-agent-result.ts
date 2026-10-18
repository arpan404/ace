import { tokensFromInput } from "@ace/ui-core";
import type { ContentPart, QueuedMessage } from "@ace/protocol";
import type { QueueControls } from "./use-queue.ts";
import type { PendingQueued } from "./queued-pending.ts";

/**
 * A queued entry the daemon sent on an agent's behalf (origin kind `subagent_result`),
 * recognised by the `[ace-origin:delegation.settled:…]` prefix the daemon keeps for the
 * provider. The queue's entries carry no `origin` client-side, so the marker is the proxy.
 * Never shown in the composer's strip: these results go straight into the conversation.
 * Pure.
 */
export function isQueuedAgentResult(input: readonly ContentPart[]): boolean {
  const text = tokensFromInput(input).text.trimStart();
  return text.startsWith("[ace-origin:delegation.settled:");
}

const keepPersonMessage = (message: Pick<QueuedMessage, "input">) =>
  !isQueuedAgentResult(message.input);

/** The queue as the strip lists it: without the agent results that go to the conversation. */
export function withoutAgentResults(queue: QueueControls): QueueControls {
  const retained = queue.retained.filter(keepPersonMessage);
  const removed = queue.retained.length - retained.length;
  if (!removed) return queue;
  const page = queue.page && {
    ...queue.page,
    messages: queue.page.messages.filter(keepPersonMessage),
    total: Math.max(0, queue.page.total - removed),
  };
  return {
    ...queue,
    page,
    messages: queue.messages.filter(keepPersonMessage),
    retained,
    allMessages: queue.allMessages.filter(keepPersonMessage),
  };
}

/** Pending sends the strip lists: without any agent result, which is never the person's. */
export function withoutAgentPending(pending: readonly PendingQueued[]): readonly PendingQueued[] {
  return pending.filter((message) => !isQueuedAgentResult(message.input));
}
