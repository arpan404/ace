import type { SocketContext, SocketService } from "./socket.ts";
export function createDiagnosticsSession({
  options,
  send,
  authorize,
  sessionId,
}: SocketContext): SocketService {
  let pending = false;
  let closed = false;
  const terminals = new Set<string>();
  return {
    close() {
      closed = true;
      for (const id of terminals)
        void options.accountManagement?.stop(id, sessionId).catch(() => {});
      terminals.clear();
    },
    healthPending: () => Number(pending),
    handle(message) {
      if (message.type === "diagnostics.request") {
        const scope =
          message.operation === "fix" || message.operation === "launch" ? "admin" : "read";
        const run =
          message.operation === "doctor"
            ? options.doctor
            : message.operation === "fix"
              ? options.doctorFix
              : message.operation === "launch"
                ? options.triageLaunch
                : options.toolchains;
        const error = !authorize(scope)
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
            if (closed || !authorize(scope)) return;
            const assertAuthorized = () => {
              if (closed || !authorize(scope)) throw new Error("forbidden");
            };
            for (const id of terminals)
              if (!options.accountManagement?.owns(id, sessionId)) terminals.delete(id);
            if (message.operation === "launch" && terminals.size >= 8)
              throw new Error("terminal limit");
            const result =
              message.operation === "doctor"
                ? { report: await options.doctor?.() }
                : message.operation === "fix"
                  ? await options.doctorFix?.(assertAuthorized)
                  : message.operation === "launch"
                    ? {
                        terminalId: await options.triageLaunch?.(
                          message.provider,
                          message.prompt,
                          sessionId,
                          assertAuthorized,
                        ),
                      }
                    : { toolchains: await options.toolchains?.() };
            if (result && "terminalId" in result && result.terminalId) {
              if (closed || !authorize(scope)) {
                await options.accountManagement?.stop(result.terminalId, sessionId);
                return;
              }
              terminals.add(result.terminalId);
            }
            if (!closed && authorize(scope))
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
