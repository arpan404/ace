import type { FleetLink } from "@ace/protocol";

/** A machine work can go to, or why it can't right now. */
export interface TransferMachine {
  hostId: string;
  name: string;
  /** Shown beside it, dimmed, instead of hiding it. */
  reason?: "Offline" | "Projects not allowed";
}

/**
 * The machines this one has fleet links to (ADR 0099): each linked machine, offline or
 * not-allowed ones kept with the reason. A link that doesn't name its machine yet can't be
 * sent to and is left out. A link `refused` for agents still takes the person's transfers.
 * Pure.
 */
export function transferMachines(links: readonly FleetLink[]): TransferMachine[] {
  return links.flatMap((link): TransferMachine[] => {
    if (!link.hostId) return [];
    const reason =
      link.status === "offline"
        ? "Offline"
        : link.access !== "operate" || link.projects === false
          ? "Projects not allowed"
          : undefined;
    return [{ hostId: link.hostId, name: link.name, ...(reason ? { reason } : {}) }];
  });
}
