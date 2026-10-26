import { transferRunning } from "@ace/client";
import type { FleetLink, ThreadContinuedOn, ThreadDetails, Transfer } from "@ace/protocol";

/*
 * Work on another machine (ADR 0101) as every client shows it: which linked machines can take
 * work, what Try again repeats, and what a thread's line says about where its work went. Pure;
 * the web and the phones draw it.
 */

export { doneWords, refusalWords, runningWords, type Refusal } from "./transfer-words.ts";

/** A machine work can go to, or why it can't right now. */
export interface TransferMachine {
  hostId: string;
  name: string;
  /** Shown beside it, dimmed, instead of hiding it. */
  reason?: "Offline" | "Projects not allowed";
}

/**
 * The machines this one has fleet links to: each linked machine, offline or not-allowed ones
 * kept with the reason. A link that doesn't name its machine yet can't be sent to and is left
 * out. A link `refused` for agents still takes the person's transfers.
 */
export function transferMachines(links: readonly FleetLink[]): TransferMachine[] {
  return links.flatMap((link): TransferMachine[] => {
    if (!link.hostId) return [];
    const reason =
      link.status === "offline"
        ? "Offline"
        : // Older daemons don't say; then `operate` access is the best sign there is.
          (link.projects ?? link.access === "operate") === false
          ? "Projects not allowed"
          : undefined;
    return [{ hostId: link.hostId, name: link.name, ...(reason ? { reason } : {}) }];
  });
}

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

/** What a thread's line says about where its work went or came from. */
export type ThreadTransferState =
  | { kind: "transfer"; transfer: Transfer }
  | { kind: "on"; on: ThreadContinuedOn }
  | { kind: "from"; from: ThreadContinuedOn };

/**
 * A running transfer first, then one that failed after the last continuation (until it's
 * dismissed), then where the thread was continued, a finished transfer whose record hasn't
 * reached the thread yet, then where it came from. Cancelled transfers say nothing.
 */
export function threadTransferState(
  transfer: Transfer | undefined,
  details: Pick<ThreadDetails, "continuedOn" | "continuedFrom"> | undefined,
  dismissed: boolean,
): ThreadTransferState | undefined {
  const on = details?.continuedOn;
  if (transfer && transferRunning(transfer)) return { kind: "transfer", transfer };
  if (transfer?.phase === "failed" && !dismissed && (!on || transfer.updatedAt > on.at))
    return { kind: "transfer", transfer };
  if (on) return { kind: "on", on };
  if (transfer?.phase === "completed") return { kind: "transfer", transfer };
  if (details?.continuedFrom) return { kind: "from", from: details.continuedFrom };
  return undefined;
}
