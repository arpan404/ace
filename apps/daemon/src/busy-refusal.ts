import type { ServerMessage } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";

/**
 * A command the daemon turned away at capacity admitted nothing and saved no receipt. Sent as a
 * retryable refusal, it keeps the client's intent pending under its own id, which the client
 * sends again: one idempotency key stays one command, dispatched at most once. Receipts that
 * carry a forge action record stay receipts, as that record is their outcome.
 */
export function busyRefusal(
  message: ServerMessage | PluginServerMessage,
): ServerMessage | PluginServerMessage {
  if (
    message.type !== "commandResult" ||
    message.code !== "action_not_dispatched" ||
    message.error !== "action_busy" ||
    message.issueAction ||
    message.inboxAction
  )
    return message;
  return {
    type: "error",
    code: "action_busy",
    message: "ace is busy with other work; the command will be sent again",
    commandId: message.commandId,
    retryable: true,
  };
}
