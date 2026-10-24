import { TransferCommands as TransferCommandSchemas, type TransfersResult } from "@ace/protocol";
import { TransferError } from "../transfers/ports.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * `workspace.transfer`, `thread.continueOn`, `transfers.request` and `transfer.progress`
 * (ADR 0099). Moving work needs `projects` on this machine, as adding a project does; continuing
 * a thread needs `operate` on it too.
 */
export function createTransfersSession(context: SocketContext): SocketService {
  const { options, authorize, connected, send, tasks } = context;
  let stop: (() => void) | undefined;
  const allowed = () => connected() && authorize("projects");
  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
  };
  return {
    authenticated(kind) {
      if (kind !== undefined || !options.transfers) return;
      stop = options.transfers.outgoing.onProgress((transfer) => {
        if (allowed()) send({ type: "transfer.progress", transfer });
      });
    },
    close() {
      stop?.();
    },
    command: {
      types: TransferCommandSchemas.map((schema) => schema.shape.type.value),
      scope: () => "projects",
      accept(command) {
        const transfers = options.transfers;
        const refuse = (error: string, detail: string) =>
          send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error,
            code: error,
            detail,
          });
        if (!transfers)
          return refuse(
            "transfers_unavailable",
            "Transfers aren't ready on this machine yet. Try again in a moment.",
          );
        if (command.payload.type === "thread.continueOn") {
          if (!authorize("operate"))
            return refuse(
              "forbidden",
              "This device can't run threads on this machine. Link it again with Operate allowed.",
            );
          if (!context.canReadThread(command.payload.threadId))
            return refuse("thread_not_found", "That thread doesn't exist on this machine.");
        }
        track(
          transfers.commands
            .execute(command)
            .catch(() => ({
              commandId: command.id,
              ok: false,
              error: "transfer_failed",
              code: "transfer_failed",
              detail: "The transfer couldn't start. Try again.",
            }))
            .then((result) => {
              if (connected()) send({ type: "commandResult", ...result });
            }),
        );
      },
    },
    handle(message) {
      if (message.type !== "transfers.request") return false;
      const reply = (result: TransfersResult["result"]) =>
        send({ type: "transfers.result", requestId: message.requestId, result });
      const transfers = options.transfers;
      if (!allowed() || !transfers) {
        reply({
          kind: "error",
          code: !allowed() ? "forbidden" : "unavailable",
          message: !allowed()
            ? "This device can't manage projects here."
            : "Transfers aren't ready on this machine yet.",
        });
        return true;
      }
      const operation = message.operation;
      if (operation.op === "list") {
        reply({ kind: "list", transfers: transfers.outgoing.list() });
        return true;
      }
      track(
        transfers.outgoing
          .cancel(operation.transferId)
          .then((transfer) =>
            // Past the point of no return: the thread there (or the project) is the result.
            transfer.phase === "completed"
              ? reply({
                  kind: "error",
                  code: "too_late",
                  message: `It already reached ${transfer.target.name}; the work is there now.`,
                })
              : reply({ kind: "cancelled", transfer }),
          )
          .catch((error: unknown) =>
            reply({
              kind: "error",
              code: error instanceof TransferError ? error.code : "transfer_failed",
              message:
                error instanceof TransferError
                  ? error.message
                  : "The transfer couldn't be cancelled.",
            }),
          ),
      );
      return true;
    },
  };
}
