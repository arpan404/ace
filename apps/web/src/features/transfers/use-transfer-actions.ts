import { TransferError, transferCancellable } from "@ace/client";
import { useClient } from "@ace/client-react";
import { HostId, ThreadId, WorkspaceId, type CommandResult, type Transfer } from "@ace/protocol";
import { useCallback } from "react";
import type { TransferRequest } from "@/lib/transfer-opener.ts";

/** Where the work goes on the other machine. */
export interface Placement {
  hostId: string;
  parent?: string | undefined;
  includeChanges: boolean;
  /** Omitted: the sending machine's "Bring ignored files" setting. */
  includeIgnored?: boolean | undefined;
}

/** What "Try again" repeats: the transfer's own options, as its record echoes them. */
export function placementOf(transfer: Transfer): Placement | undefined {
  const options = transfer.options;
  if (!options) return undefined;
  return {
    hostId: transfer.target.hostId,
    ...(options.parent ? { parent: options.parent } : {}),
    includeChanges: options.includeChanges,
    includeIgnored: options.includeIgnored,
  };
}

/** Why the daemon refused: the receipt's code, and its own words when it gave them. */
export interface Refusal {
  code: string | undefined;
  detail?: string | undefined;
}

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
