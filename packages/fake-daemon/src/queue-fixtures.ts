import { QueuedMessage } from "@ace/protocol";
import { inputText } from "./thread-commands.ts";
import type { ThreadHost } from "./thread-host.ts";

export function markUncertainInput(host: ThreadHost, messageId: string): void {
  const message = host.queued.find((entry) => entry.key === messageId);
  if (!message) throw new Error("No queued message to make uncertain");
  message.state = "uncertain";
  host.queue.paused = true;
  host.queue.reason = "uncertain";
  host.queueDirty = true;
}

export function restoreInput(host: ThreadHost, value: unknown): void {
  const message = QueuedMessage.parse(value);
  host.queued.unshift({
    key: message.id,
    input: message.input,
    text: inputText(message.input, message.context),
    delivery: message.delivery,
    state: "uncertain",
    ...(message.context ? { context: message.context } : {}),
  });
  host.queue.paused = true;
  host.queue.reason = "uncertain";
  host.queueDirty = true;
}

export function repeatInput(host: ThreadHost, messageId: string): void {
  const message = host.queued.find((entry) => entry.key === messageId);
  if (!message) throw new Error("No queued input to repeat");
  host.queued.push({ ...message, state: "queued" });
  host.queueDirty = true;
}

/**
 * A message waiting as the real daemon keeps it: a steer held until the provider can take it
 * (`steer`), or a steer the provider refused that fell back to the queue (`fell_back`).
 */
export function waitingSteer(
  host: ThreadHost,
  messageId: string,
  text: string,
  kind: "steer" | "fell_back",
): void {
  const input = [{ type: "text" as const, text }];
  host.queued.push({
    key: messageId,
    input,
    text: inputText(input, undefined),
    delivery: kind === "steer" ? "steer" : "queue",
    state: "queued",
    ...(kind === "fell_back" ? { fellBack: true as const } : {}),
  });
  host.queueDirty = true;
}
