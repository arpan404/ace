import type { SocketContext, SocketService } from "./socket.ts";
export function createDiagnosticsSession({
  options,
  send,
  authorize,
}: SocketContext): SocketService {
  let pending = false;
  let closed = false;
  return {
    close() {
      closed = true;
    },
    healthPending: () => Number(pending),
    handle(message) {
      if (message.type === "diagnostics.request") {
        const run = message.operation === "doctor" ? options.doctor : options.toolchains;
        const error = !authorize("read")
          ? "forbidden"
          : pending
            ? "diagnostics_busy"
            : !run
              ? "diagnostics_unavailable"
              : undefined;
        if (error) {
          send({ type: "diagnostics.result", requestId: message.requestId, error });
          return true;
        }
        pending = true;
        void Promise.resolve()
          .then(async () => {
            const result =
              message.operation === "doctor"
                ? { report: await options.doctor?.() }
                : { toolchains: await options.toolchains?.() };
            if (!closed && authorize("read"))
              send({ type: "diagnostics.result", requestId: message.requestId, ...result });
          })
          .catch(() => {
            if (!closed)
              send({
                type: "diagnostics.result",
                requestId: message.requestId,
                error: "diagnostics_failed",
              });
          })
          .finally(() => {
            pending = false;
          });
        return true;
      }
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
