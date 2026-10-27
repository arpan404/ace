import type { Admission, AdmissionRequest } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * Pause and resume new work on this machine over the socket (`admission.request`): the same
 * maintenance gate the desktop tray flips over HTTP (ADR 0041). Reading it needs read scope and
 * keeps this socket told of every later change; pausing or resuming needs operate scope.
 */
export function createAdmissionSession({
  maintenance,
  authorize,
  connected,
  send,
}: SocketContext): SocketService {
  let stopWatching: (() => void) | undefined;
  const admission = (): Admission => {
    const status = maintenance.status();
    return { paused: status.draining, busy: status.blockers };
  };
  const watch = () => {
    stopWatching ??= maintenance.onChange(() => {
      if (connected() && authorize("read"))
        send({ type: "admission.changed", admission: admission() });
    });
  };
  const reply = (request: AdmissionRequest, scope: "read" | "operate", change?: () => void) => {
    if (!authorize(scope)) {
      send({
        type: "admission.result",
        requestId: request.requestId,
        ok: false,
        error: "forbidden",
      });
      return;
    }
    watch();
    change?.();
    send({
      type: "admission.result",
      requestId: request.requestId,
      ok: true,
      admission: admission(),
    });
  };
  return {
    close() {
      stopWatching?.();
      stopWatching = undefined;
    },
    handle(message) {
      if (message.type !== "admission.request") return false;
      if (message.operation === "status") reply(message, "read");
      else if (message.operation === "pause") reply(message, "operate", () => maintenance.enter());
      else reply(message, "operate", () => maintenance.leave());
      return true;
    },
  };
}
