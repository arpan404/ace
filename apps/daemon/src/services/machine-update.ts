import { requiredScope } from "../machine-update/rules.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * This machine's update for clients (`machineUpdate.request`, ADR 0113). Anyone with read scope
 * sees it and hears its changes; only an administrator (a paired admin device, or an account
 * device past the machine code) checks, starts or cancels it. Linked machines' agents have no
 * machine-call op for it, so no agent elsewhere can update this machine.
 */
export function createMachineUpdateSession({
  machineUpdates: updates,
  authorize,
  connected,
  send,
  tasks,
}: SocketContext): SocketService {
  let stopWatching: (() => void) | undefined;
  return {
    close() {
      stopWatching?.();
      stopWatching = undefined;
    },
    handle(message) {
      if (message.type !== "machineUpdate.request") return false;
      const { requestId } = message;
      if (!authorize(requiredScope(message.operation))) {
        send({ type: "machineUpdate.result", requestId, ok: false, error: "forbidden" });
        return true;
      }
      if (!updates) {
        send({ type: "machineUpdate.result", requestId, ok: false, error: "unavailable" });
        return true;
      }
      stopWatching ??= updates.onChange((update) => {
        if (connected() && authorize("read")) send({ type: "machineUpdate.changed", update });
      });
      const task = updates
        .handle(message)
        .then((answer) => send({ type: "machineUpdate.result", requestId, ...answer }))
        .catch(() =>
          send({ type: "machineUpdate.result", requestId, ok: false, error: "unavailable" }),
        )
        .finally(() => tasks.delete(task));
      tasks.add(task);
      return true;
    },
  };
}
