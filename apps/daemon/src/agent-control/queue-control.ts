import {
  type CommandId,
  type AgentControlOperation,
  type AgentControlResult,
  type CommandPayload,
  type CommandResult,
  type McpAttribution,
  type QueuedMessage,
} from "@ace/protocol";
import { controlCommandId } from "./command-id.ts";
import type { DelegationService } from "./delegations.ts";

export type QueueOperation = Extract<
  AgentControlOperation,
  { op: "queue.list" | "queue.edit" | "queue.cancel" | "queue.steer" | "queue.reorder" }
>;

/** The longest preview of a queued message an agent reads; the full text stays in the queue. */
const previewChars = 2000;

/** A queued message as an agent reads it: its id, a text preview and how it will be delivered. */
function entry(message: QueuedMessage) {
  const text = message.input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  const attachments = message.input.length - message.input.filter((p) => p.type === "text").length;
  return {
    entryId: message.id,
    text: text.length > previewChars ? `${text.slice(0, previewChars)}…` : text,
    ...(text.length > previewChars ? { truncated: true } : {}),
    ...(attachments ? { attachments } : {}),
    delivery: message.delivery,
    ...(message.state === "uncertain" ? { uncertain: true } : {}),
  };
}

/**
 * Agent queue edits run the person's own queue commands, against the revision just read, so
 * an entry already delivered or changed by someone else is refused, never overwritten.
 */
export function queueControl(
  service: DelegationService,
  caller: McpAttribution,
  operation: QueueOperation,
): AgentControlResult {
  const { threadId } = operation;
  const queue = service.queue(threadId);
  if (operation.op === "queue.list")
    return {
      ok: true,
      data: {
        paused: queue.paused,
        ...(queue.reason ? { reason: queue.reason } : {}),
        entries: queue.messages.map(entry),
      },
    };
  const run = (step: string, payload: CommandPayload) =>
    answer(service.command(controlCommandId(caller.threadId, operation.requestId, step), payload));
  if (operation.op === "queue.reorder") return reorder(service, caller, operation);
  const message = queue.messages.find((candidate) => candidate.id === operation.entryId);
  if (!message) return gone;
  const target = { threadId, expectedRevision: queue.revision, messageId: message.id };
  switch (operation.op) {
    case "queue.cancel":
      return run("queue.cancel", { type: "queue.remove", ...target });
    case "queue.edit":
      return run("queue.edit", {
        type: "queue.edit",
        ...target,
        input: [
          { type: "text", text: operation.text },
          ...message.input.filter((part) => part.type !== "text"),
        ],
        ...(message.context ? { context: message.context } : {}),
      });
    case "queue.steer":
      return run("queue.steer", {
        type: "queue.edit",
        ...target,
        input: message.input,
        ...(message.context ? { context: message.context } : {}),
        delivery: "steer",
      });
  }
}

/** Moves each named entry after the one before it, so they lead the queue in the given order. */
function reorder(
  service: DelegationService,
  caller: McpAttribution,
  operation: Extract<QueueOperation, { op: "queue.reorder" }>,
): AgentControlResult {
  const queued = new Map(
    service.queue(operation.threadId).messages.map((message) => [String(message.id), message.id]),
  );
  const order = operation.entryIds.flatMap((id) => queued.get(id) ?? []);
  if (order.length !== operation.entryIds.length) return gone;
  let after: CommandId | null = null;
  for (const [index, messageId] of order.entries()) {
    const result = service.command(
      controlCommandId(caller.threadId, operation.requestId, `queue.reorder.${index}`),
      {
        type: "queue.move",
        threadId: operation.threadId,
        expectedRevision: service.queue(operation.threadId).revision,
        messageId,
        after,
      },
    );
    if (!result.ok) return answer(result);
    after = messageId;
  }
  return { ok: true };
}

const gone: AgentControlResult = {
  ok: false,
  code: "not_found",
  hint: "That entry is no longer queued; it was delivered or removed. Read the queue again with thread_read.",
};

function answer(result: CommandResult): AgentControlResult {
  if (result.ok) return { ok: true };
  if (result.error === "message_already_claimed") return gone;
  if (result.error === "queue_conflict")
    return {
      ok: false,
      code: "not_ready",
      hint: "The queue changed while you edited it; read it again and retry with a new requestId.",
    };
  return { ok: false, code: "not_ready", hint: `The queue refused the change (${result.error}).` };
}
