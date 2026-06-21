import type { OrchestrationMessage } from "@ace/contracts";

function compareMessages(a: OrchestrationMessage, b: OrchestrationMessage): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt.localeCompare(b.updatedAt);
  }
  return a.id.localeCompare(b.id);
}

export function upsertThreadMessage(
  messages: readonly OrchestrationMessage[],
  incomingMessage: OrchestrationMessage,
): OrchestrationMessage[] {
  const existingIndex = messages.findIndex((message) => message.id === incomingMessage.id);
  const nextMessages = [...messages];

  if (existingIndex === -1) {
    nextMessages.push(incomingMessage);
  } else {
    const existing = nextMessages[existingIndex];
    if (!existing) {
      nextMessages.push(incomingMessage);
      nextMessages.sort(compareMessages);
      return nextMessages;
    }
    nextMessages[existingIndex] = {
      ...existing,
      ...incomingMessage,
      attachments: incomingMessage.attachments ?? existing.attachments,
    };
  }

  nextMessages.sort(compareMessages);
  return nextMessages;
}
