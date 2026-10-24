import { transferRunning } from "@ace/client";
import { useClient } from "@ace/client-react";
import { HostId, ThreadId, WorkspaceId, type CommandResult, type Transfer } from "@ace/protocol";
import { useCallback } from "react";
import type { TransferRequest } from "@/lib/transfer-opener.ts";

/** Where the work goes on the other machine. */
export interface Placement {
  hostId: string;
  parent?: string | undefined;
  includeChanges: boolean;
}

/** A refusal before anything started: its code (the receipt's error), never thrown. */
export type Started = { ok: true; commandId: string } | { ok: false; code: string | undefined };

/** Start "Continue on" or "Open on", and cancel a running transfer. */
export function useTransferActions() {
  const client = useClient();
  const start = useCallback(
    async (request: TransferRequest, placement: Placement): Promise<Started> => {
      const place = {
        hostId: HostId.parse(placement.hostId),
        ...(placement.parent ? { parent: placement.parent } : {}),
        includeChanges: placement.includeChanges,
      };
      let result: CommandResult;
      try {
        result =
          request.kind === "thread"
            ? await client.transfers.continueOn({
                threadId: ThreadId.parse(request.threadId),
                ...place,
              })
            : await client.transfers.openOn({
                workspaceId: WorkspaceId.parse(request.workspaceId),
                ...place,
              });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined;
        return { ok: false, code };
      }
      return result.ok
        ? { ok: true, commandId: result.commandId }
        : { ok: false, code: result.error };
    },
    [client],
  );
  const cancel = useCallback(
    (transfer: Transfer) =>
      transferRunning(transfer)
        ? client.transfers.cancel(transfer.transferId).then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve(),
    [client],
  );
  return { start, cancel };
}

/** Cancel applies until the new thread is being started (ADR 0099). */
export function cancellable(transfer: Transfer): boolean {
  return ["preparing", "cloning", "sending", "importing"].includes(transfer.phase);
}
