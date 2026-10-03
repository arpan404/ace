import type { SocketContext, SocketService } from "./socket.ts";
export function createDiagnosticsSession({
  options,
  send,
  authorize,
}: SocketContext): SocketService {
  let pending = false;
  return {
    close() {
      pending = false;
    },
    healthPending: () => Number(pending),
    handle(message) {
      if (message.type !== "diagnostics.health") return false;
      if (!authorize("read") || !options.health || pending) {
        send({
          type: "diagnostics.health.result",
          requestId: message.requestId,
          ok: false,
          error: !authorize("read")
            ? "forbidden"
            : pending
              ? "diagnostics_busy"
              : "diagnostics_unavailable",
        });
        return true;
      }
      pending = true;
      void Promise.resolve()
        .then(options.health)
        .then(
          (health) => {
            if (authorize("read"))
              send({
                type: "diagnostics.health.result",
                requestId: message.requestId,
                ok: true,
                health,
              });
          },
          () =>
            send({
              type: "diagnostics.health.result",
              requestId: message.requestId,
              ok: false,
              error: "diagnostics_failed",
            }),
        )
        .finally(() => {
          pending = false;
        });
      return true;
    },
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
