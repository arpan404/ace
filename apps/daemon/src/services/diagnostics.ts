import type { SocketContext, SocketService } from "./socket.ts";
export function createDiagnosticsSession({ options, send }: SocketContext): SocketService {
  let pending = false;
  return {
    close() {
      pending = false;
    },
    healthPending: () => Number(pending),
    command: {
      types: ["diagnostics.health"],
      scope: () => "read",
      accept(command) {
        if (!options.health || pending) {
          send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error: pending ? "diagnostics_busy" : "diagnostics_unavailable",
          });
          return;
        }
        pending = true;
        const task = Promise.resolve()
          .then(options.health)
          .then(
            (health) => send({ type: "commandResult", commandId: command.id, ok: true, health }),
            () =>
              send({
                type: "commandResult",
                commandId: command.id,
                ok: false,
                error: "diagnostics_failed",
              }),
          )
          .finally(() => {
            pending = false;
          });
        void task;
      },
    },
  };
}
