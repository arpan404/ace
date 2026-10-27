import type { Admission, AdmissionRequest } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * Pause and resume new work on this machine over the socket (`admission.request`). Pause and
 * resume add and remove only the person's `user` hold on the maintenance gate (ADR 0041), so an
 * update's drain, kill-all or a stop keeps admission closed whatever a client asks. Reading needs
 * read scope and keeps this socket told of every later change, including, while admission is
 * closed, how much work is still finishing; pausing or resuming needs operate scope.
 */
export function createAdmissionSession({
  maintenance,
  options,
  authorize,
  connected,
  send,
}: SocketContext): SocketService {
  let stopWatching: (() => void) | undefined;
  let last = "";
  /** One recount waits at most, however many events arrive before it runs. */
  let recounting = false;
  const admission = (): Admission => {
    const status = maintenance.status();
    return { holds: status.holds, busy: status.blockers, waiting: status.waiting };
  };
  /** Sends the state when it differs from what this socket last heard. */
  const tell = () => {
    if (!connected() || !authorize("read")) return;
    const now = admission();
    const key = JSON.stringify(now);
    if (key === last) return;
    last = key;
    send({ type: "admission.changed", admission: now });
  };
  const watch = () => {
    if (stopWatching) return;
    const stopGate = maintenance.onChange(tell);
    // While admission is closed, the count of threads still finishing moves as they settle. Only
    // a thread's status changes it, so deltas and other events never recount, and a burst of
    // status changes recounts once.
    const stopStore = options.store.subscribe((events) => {
      if (recounting || maintenance.admit()) return;
      if (!events.some((event) => event.payload.type === "thread.updated" && event.payload.status))
        return;
      recounting = true;
      queueMicrotask(() => {
        recounting = false;
        tell();
      });
    });
    stopWatching = () => {
      stopGate();
      stopStore();
    };
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
    const now = admission();
    last = JSON.stringify(now);
    send({ type: "admission.result", requestId: request.requestId, ok: true, admission: now });
  };
  return {
    close() {
      stopWatching?.();
      stopWatching = undefined;
    },
    handle(message) {
      if (message.type !== "admission.request") return false;
      if (message.operation === "status") reply(message, "read");
      else if (message.operation === "pause")
        reply(message, "operate", () => maintenance.enter("user"));
      else reply(message, "operate", () => maintenance.leave("user"));
      return true;
    },
  };
}
