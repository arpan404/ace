import type { MachineCodeResult } from "@ace/protocol";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * Machine code administration over a connection (ADR 0111), with the rules of `PUT` and
 * `DELETE /v1/machine-code`: admin only, one change at a time per connection. The code is
 * never logged or echoed; an account device that sets it keeps its own access.
 */
export function createMachineCodeSession({
  options,
  authorize,
  accountDevice,
  device,
  connected,
  send,
}: SocketContext): SocketService {
  let pending = false;
  return {
    handle(message) {
      if (
        message.type !== "machine.code.status" &&
        message.type !== "machine.code.set" &&
        message.type !== "machine.code.clear"
      )
        return false;
      const { requestId } = message;
      const answer = (result: MachineCodeResult["result"]) => {
        if (connected()) send({ type: "machine.code.result", requestId, result });
      };
      const account = options.machineAccount;
      if (!authorize("admin"))
        answer({ ok: false, error: "forbidden", message: "Admin access required." });
      else if (!account)
        answer({ ok: false, error: "unavailable", message: "ace account is unavailable." });
      else if (message.type === "machine.code.status")
        answer({ ok: true, status: account.status() });
      else if (pending)
        answer({ ok: false, error: "busy", message: "The machine code is still changing." });
      else if (message.type === "machine.code.clear")
        answer({ ok: true, status: account.clearMachineCode() });
      else {
        pending = true;
        const owner = accountDevice?.();
        const id = device();
        void account
          .setMachineCode(
            message.code,
            owner !== undefined && id !== undefined ? { deviceId: id, account: owner } : undefined,
          )
          .then(
            (status) => answer({ ok: true, status }),
            () => answer({ ok: false, error: "unavailable", message: "Couldn't set the code." }),
          )
          .finally(() => {
            pending = false;
          });
      }
      return true;
    },
  };
}
