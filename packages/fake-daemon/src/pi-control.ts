import type { ClientMessage, ServerMessage } from "@ace/protocol";
import { busy } from "./thread-commands.ts";
import type { ThreadHost } from "./thread-host.ts";

/**
 * A Pi thread's rollback, as the daemon answers it: only to a history point the thread holds,
 * and never while it works.
 */
export function piControlResult(
  message: Extract<ClientMessage, { type: "pi.control" }>,
  host: ThreadHost | undefined,
): ServerMessage {
  const { operation } = message;
  const valid =
    host?.view.thread.provider === "pi" &&
    !busy(host) &&
    operation.kind === "rollback" &&
    Object.values(host.view.items).some((item) => item.nativeId === operation.entryId);
  return {
    type: "pi.result",
    requestId: message.requestId,
    result: valid ? { ok: true } : { ok: false, error: "Pi history point unavailable" },
  };
}
