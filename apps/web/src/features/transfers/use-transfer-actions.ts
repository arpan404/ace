import { TransferError, transferCancellable } from "@ace/client";
import { useClient } from "@ace/client-react";
import { HostId, ThreadId, WorkspaceId, type CommandResult, type Transfer } from "@ace/protocol";
import { useCallback } from "react";
import type { Placement, Refusal } from "@ace/ui-core/transfers";
import type { TransferRequest } from "@/lib/transfer-opener.ts";

export { placementOf, type Placement, type Refusal } from "@ace/ui-core/transfers";

/** A refusal before anything started, never thrown. */
export type Started = { ok: true; commandId: string } | ({ ok: false } & Refusal);

/** Only the daemon's transfer refusals carry words meant for a person; others, their code. */
const refusalOf = (error: unknown): Refusal => {
  if (error instanceof TransferError) return { code: error.code, detail: error.message };
  if (typeof error !== "object" || error === null || !("code" in error)) return { code: undefined };
  return { code: String(error.code) };
};

/** Start "Continue on" or "Open on", and cancel a running transfer. */
export function useTransferActions() {
  const client = useClient();
  const start = useCallback(
    async (request: TransferRequest, placement: Placement): Promise<Started> => {
      const place = {
        hostId: HostId.parse(placement.hostId),
        ...(placement.parent ? { parent: placement.parent } : {}),
        includeChanges: placement.includeChanges,
        ...(placement.includeIgnored === undefined
          ? {}
          : { includeIgnored: placement.includeIgnored }),
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
        return { ok: false, ...refusalOf(error) };
      }
      return result.ok
        ? { ok: true, commandId: result.commandId }
        : {
            ok: false,
            code: result.code ?? result.error,
            ...(result.detail ? { detail: result.detail } : {}),
          };
    },
    [client],
  );
  /** Undefined once it's cancelled (or had already moved on); else why it couldn't be. */
  const cancel = useCallback(
    async (transfer: Transfer): Promise<Refusal | undefined> => {
      if (!transferCancellable(transfer)) return undefined;
      try {
        await client.transfers.cancel(transfer.transferId);
        return undefined;
      } catch (error) {
        return refusalOf(error);
      }
    },
    [client],
  );
  return { start, cancel };
}
