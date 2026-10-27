import type { SocketContext, SocketService } from "./socket.ts";

/**
 * The desktop app's update status for any read-scope client (`appUpdate.request`). Read-only:
 * the app reports it over its loopback host-token route, and installing stays on the computer.
 */
export function createAppUpdateSession({
  appUpdate,
  authorize,
  connected,
  send,
}: SocketContext): SocketService {
  let stopWatching: (() => void) | undefined;
  return {
    close() {
      stopWatching?.();
      stopWatching = undefined;
    },
    handle(message) {
      if (message.type !== "appUpdate.request") return false;
      if (!authorize("read")) {
        send({
          type: "appUpdate.result",
          requestId: message.requestId,
          ok: false,
          error: "forbidden",
        });
        return true;
      }
      stopWatching ??= appUpdate.onChange((update) => {
        if (connected() && authorize("read")) send({ type: "appUpdate.changed", update });
      });
      send({
        type: "appUpdate.result",
        requestId: message.requestId,
        ok: true,
        update: appUpdate.current(),
      });
      return true;
    },
  };
}
