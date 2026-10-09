import type { QueuedMessage } from "@ace/protocol";

/** Snapshots and pending sends can overlap. Keep one row per input identity; uncertainty wins. */
export function distinctRetainedInputs(messages: readonly QueuedMessage[]): QueuedMessage[] {
  const byId = new Map<string, QueuedMessage>();
  for (const message of messages)
    if (!byId.has(message.id) || message.state === "uncertain") byId.set(message.id, message);
  return [...byId.values()];
}
