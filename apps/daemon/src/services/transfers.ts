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
        const refuse = (error: string) =>
          send({ type: "commandResult", commandId: command.id, ok: false, error });
        if (!transfers) return refuse("transfers_unavailable");
        if (command.payload.type === "thread.continueOn") {
          if (!authorize("operate")) return refuse("forbidden");
          if (!context.canReadThread(command.payload.threadId)) return refuse("thread_not_found");
        }
        track(
          transfers.commands
            .execute(command)
            .catch(() => ({ commandId: command.id, ok: false, error: "transfer_failed" }))
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
          .then((transfer) => reply({ kind: "cancelled", transfer }))
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
