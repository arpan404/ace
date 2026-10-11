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
